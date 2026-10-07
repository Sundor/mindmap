import { beforeEach, describe, expect, it } from 'vitest';
import exampleYaml from '../../../examples/architecture.yaml?raw';
import {
  BAND_PADDING_Y,
  GROUP_PADDING,
  LAYOUT_STORAGE_KEY,
  clearLayoutCache,
  computeLayout,
  computeLayoutUncached,
  deserializeLayout,
  rowPlacement,
  serializeLayout,
  type LayoutResult,
  type LayoutStorage,
  type Rect,
} from './index';
import type { ArchitectureModel } from '../model';
import { centreY, layoutViolations, overlaps, parseOk, rectOf } from './test-helpers';

const bottom = (r: Rect): number => r.y + r.height;
const right = (r: Rect): number => r.x + r.width;

function band(layout: LayoutResult, id: string): Rect {
  const found = layout.rows.find((b) => b.id === id);
  if (!found) throw new Error(`no band ${id}`);
  return found;
}

/** Expects `id` to span exactly from the top of band `top` to the bottom of band `bottom`. */
function expectCoversBands(layout: LayoutResult, id: string, top: string, bottomRow: string): void {
  const rect = rectOf(layout, id);
  expect(rect.y).toBe(band(layout, top).y + BAND_PADDING_Y);
  expect(bottom(rect)).toBe(bottom(band(layout, bottomRow)) - BAND_PADDING_Y);
}

function expectInBand(layout: LayoutResult, id: string, row: string): void {
  const rect = rectOf(layout, id);
  const b = band(layout, row);
  expect(rect.y, `${id} top`).toBeGreaterThanOrEqual(b.y + BAND_PADDING_Y);
  expect(bottom(rect), `${id} bottom`).toBeLessThanOrEqual(bottom(b) - BAND_PADDING_Y);
}

/** Expects `rowPlacement` to name the rows the layout put the nodes in, in the same order. */
function expectRowPlacement(model: ArchitectureModel, layout: LayoutResult): void {
  const placement = rowPlacement(model);
  expect([...placement.placedRow]).toEqual([...layout.placedRow]);
  expect([...placement.rowOf]).toEqual([...layout.rowOf]);
}

const THREE_ROWS = `
version: 1
rows:
  - { id: top, name: Top level }
  - { id: mid, name: Middle level }
  - { id: bot, name: Bottom level }
`;

describe('computeLayout on examples/architecture.yaml', () => {
  const model = parseOk(exampleYaml);
  let layout: LayoutResult;
  beforeEach(async () => {
    layout ??= await computeLayoutUncached(model);
  });

  it('gives every node a rect and satisfies all geometric invariants', () => {
    expect(layout.rects.size).toBe(model.nodes.size);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
  });

  it('lays out bands in YAML order with a label gutter', () => {
    expect(layout.rows.map((b) => [b.id, b.name])).toEqual([
      ['backoffice', 'Back-office level'],
      ['middle', 'Middle level'],
      ['channels', 'Customer level'],
    ]);
    expect(layout.gutterWidth).toBeGreaterThanOrEqual(120);
    for (const node of model.nodes.values()) {
      if (layout.rowOf.has(node.id)) {
        expect(rectOf(layout, node.id).x).toBeGreaterThanOrEqual(layout.gutterWidth);
      }
    }
  });

  it('makes row-less groups span exactly their bands, nested ones inside their parent', () => {
    expectCoversBands(layout, 'operations', 'backoffice', 'channels');
    expectCoversBands(layout, 'data', 'backoffice', 'middle');
    const data = rectOf(layout, 'data');
    const analytics = rectOf(layout, 'data.analytics');
    expect(analytics.y).toBe(data.y + GROUP_PADDING.top);
    expect(bottom(analytics)).toBe(bottom(data) - GROUP_PADDING.bottom);
    expectInBand(layout, 'data.analytics.dashboards', 'backoffice');
    expectInBand(layout, 'data.analytics.anomaly', 'middle');
  });

  it('attracts row-less children of spanning groups to the rows of their connections', () => {
    expect([...layout.placedRow]).toEqual([
      ['operations.alerts', 'backoffice'], // 2 backoffice, 1 middle, 1 channels (+1 unassigned)
      ['data.analytics.feature-store', 'middle'], // event store and anomaly
    ]);
    expectInBand(layout, 'operations.alerts', 'backoffice');
    expectInBand(layout, 'data.analytics.feature-store', 'middle');
  });

  it('puts the unassigned platform domain in a side area right of the bands', () => {
    const area = layout.unassignedArea;
    expect(area).toBeDefined();
    if (!area) return;
    const bandsRight = Math.max(...layout.rows.map(right));
    expect(area.x).toBeGreaterThanOrEqual(bandsRight);
    for (const id of model.nodes.keys()) {
      if (!id.startsWith('platform'))
        expect(right(rectOf(layout, id))).toBeLessThanOrEqual(bandsRight);
    }
    expect(layout.rowOf.has('platform')).toBe(false);
    expect(layout.bounds.width).toBe(right(area));
    expect(layout.bounds.height).toBeGreaterThanOrEqual(bottom(area));
  });

  it('is deterministic, also after re-parsing', async () => {
    const again = await computeLayoutUncached(model);
    const reparsed = await computeLayoutUncached(parseOk(exampleYaml));
    expect(serializeLayout(again)).toBe(serializeLayout(layout));
    expect(serializeLayout(reparsed)).toBe(serializeLayout(layout));
  });
});

describe('computeLayout without rows', () => {
  const yaml = `
version: 1
domains:
  - id: a
    name: A
    components:
      - id: a.x
        name: X
        subcomponents:
          - { id: a.x.p, name: P }
          - { id: a.x.q, name: Q }
      - { id: a.y, name: Y }
  - id: b
    name: B
    components:
      - { id: b.z, name: Z }
  - id: c
    name: Lonely leaf domain
edges:
  - { id: e1, from: a.x.p, to: a.x.q, kind: dataflow }
  - { id: e2, from: a.x.q, to: a.y, kind: dataflow }
  - { id: e3, from: a.y, to: b.z, kind: control }
  - { id: e4, from: a, to: a.x.p, kind: config }
`;
  it('falls back to a plain hierarchical layout', async () => {
    const model = parseOk(yaml);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    expect(layout.rows).toEqual([]);
    expect(layout.unassignedArea).toBeUndefined();
    expect(layout.gutterWidth).toBe(0);
    expect(layout.placedRow.size).toBe(0);
    for (const rect of layout.absolute.values()) {
      expect(right(rect)).toBeLessThanOrEqual(layout.bounds.width);
      expect(bottom(rect)).toBeLessThanOrEqual(layout.bounds.height);
    }
    // Direction RIGHT: along the chain p → q → y → z, each starts right of the previous.
    const chain = ['a.x.p', 'a.x.q', 'a.y', 'b.z'].map((id) => rectOf(layout, id));
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]?.x).toBeGreaterThan(right(chain[i - 1] as Rect));
    }
  });
});

describe('computeLayout with rows (handcrafted)', () => {
  it('nests spanning groups and keeps them contiguous across an empty row', async () => {
    const model = parseOk(`${THREE_ROWS}
domains:
  - id: d
    name: D
    components:
      - id: d.c
        name: C
        subcomponents:
          - { id: d.c.t, name: T, row: top }
          - { id: d.c.b, name: B, row: bot }
      - { id: d.m, name: M, row: mid }
  - { id: e, name: E, row: top }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    expectCoversBands(layout, 'd', 'top', 'bot');
    const d = rectOf(layout, 'd');
    const c = rectOf(layout, 'd.c');
    expect(c.y).toBe(d.y + GROUP_PADDING.top);
    expect(bottom(c)).toBe(bottom(d) - GROUP_PADDING.bottom);
    expect(rectOf(layout, 'd.c.t').y).toBe(c.y + GROUP_PADDING.top);
    expectInBand(layout, 'd.c.t', 'top');
    expectInBand(layout, 'd.c.b', 'bot');
    expectInBand(layout, 'd.m', 'mid');
    expectInBand(layout, 'e', 'top');
    // The middle slice of d.c is empty but d.c still covers it; d.m sits beside it.
    expect(overlaps(rectOf(layout, 'd.m'), c)).toBe(false);
    expect(layout.placedRow.size).toBe(0);
    expect(layout.unassignedArea).toBeUndefined();
  });

  it('attracts row-less children to the row most connections point to (tie → top-most tied row)', async () => {
    const model = parseOk(`${THREE_ROWS}
domains:
  - id: g
    name: G
    components:
      - { id: g.t1, name: T1, row: top }
      - { id: g.b1, name: B1, row: bot }
      - { id: g.b2, name: B2, row: bot }
      - id: g.x
        name: X
        subcomponents:
          - { id: g.x.inner, name: Inner }
      - { id: g.y, name: Y }
      - { id: g.z, name: Z }
      - { id: g.w, name: W }
  - { id: h, name: H, row: mid }
  - id: k
    name: K
    components:
      - { id: k.t, name: KT, row: top }
      - { id: k.m, name: KM, row: mid }
      - { id: k.f, name: KF }
edges:
  - { id: e1, from: g.x.inner, to: g.b1, kind: dataflow }
  - { id: e2, from: g.b2, to: g.x, kind: dataflow }
  - { id: e3, from: g.x, to: g.t1, kind: dataflow }
  - { id: e4, from: g.y, to: g.t1, kind: control }
  - { id: e5, from: g.b1, to: g.y, kind: control }
  - { id: e6, from: g.w, to: h, kind: config }
  - { id: e7, from: k.f, to: g.b1, kind: dataflow }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    expect([...layout.placedRow]).toEqual([
      ['g.x', 'bot'], // 2 × bottom (via itself and its child) vs 1 × top
      ['g.y', 'top'], // top and bottom tied → the top-most tied row
      ['g.z', 'top'], // no connections → top row of g
      ['g.w', 'mid'], // h is in the middle row
      ['k.f', 'mid'], // bottom row is outside k's range (top..mid): nearest row inside
    ]);
    expect(layout.rowOf.get('g.x.inner')).toBe('bot');
    for (const [id, row] of layout.placedRow) expectInBand(layout, id, row);
    expectInBand(layout, 'g.x.inner', 'bot');
  });

  it("resolves an attraction tie to the top-most tied row, not the parent's top row", async () => {
    const model = parseOk(`${THREE_ROWS}
domains:
  - id: g
    name: G
    components:
      - { id: g.t, name: T, row: top }
      - { id: g.m, name: M, row: mid }
      - { id: g.b, name: B, row: bot }
      - { id: g.tie, name: Tie }
      - { id: g.all, name: All }
      - { id: g.none, name: None }
edges:
  - { id: e1, from: g.tie, to: g.b, kind: dataflow }
  - { id: e2, from: g.m, to: g.tie, kind: dataflow }
  - { id: e3, from: g.all, to: g.b, kind: dataflow }
  - { id: e4, from: g.all, to: g.m, kind: dataflow }
  - { id: e5, from: g.all, to: g.t, kind: dataflow }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    expect([...layout.placedRow]).toEqual([
      ['g.tie', 'mid'], // mid and bot tied (top has no votes) → mid
      ['g.all', 'top'], // three-way tie → top
      ['g.none', 'top'], // no connections → the parent's top row
    ]);
    for (const [id, row] of layout.placedRow) expectInBand(layout, id, row);
  });

  it('derives attracted rows independently of YAML sibling order', async () => {
    // g.a only connects to g.c, whose row is itself derived (from g.b1/g.b2 in the bottom row).
    const siblings = [
      '      - { id: g.a, name: A }',
      '      - { id: g.c, name: C }',
      '      - { id: g.d, name: D }',
    ];
    const yamlFor = (order: readonly number[]): string => `${THREE_ROWS}
domains:
  - id: g
    name: G
    components:
      - { id: g.t1, name: T1, row: top }
${order.map((i) => siblings[i]).join('\n')}
      - { id: g.b1, name: B1, row: bot }
      - { id: g.b2, name: B2, row: bot }
edges:
  - { id: e1, from: g.a, to: g.c, kind: dataflow }
  - { id: e2, from: g.c, to: g.b1, kind: dataflow }
  - { id: e3, from: g.c, to: g.b2, kind: dataflow }
  - { id: e4, from: g.d, to: g.b1, kind: dataflow }
  - { id: e5, from: g.d, to: g.t1, kind: dataflow }
  - { id: e6, from: g.d, to: g.c, kind: dataflow }
`;
    const expected = new Map([
      ['g.c', 'bot'], // wave 1: two explicit bottom neighbours
      ['g.d', 'top'], // wave 1: g.t1 and g.b1 tie; the later row of g.c doesn't reopen it
      ['g.a', 'bot'], // wave 2: follows g.c, wherever g.c is listed
    ]);
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const model = parseOk(yamlFor(order));
      const layout = await computeLayoutUncached(model);
      expect(layoutViolations(model, layout)).toEqual([]);
      expectRowPlacement(model, layout);
      expect(new Map(layout.placedRow)).toEqual(expected);
      for (const [id, row] of layout.placedRow) expectInBand(layout, id, row);
    }
  });

  it('follows a chain of attracted nodes and terminates on a cycle of row-less nodes', async () => {
    const model = parseOk(`${THREE_ROWS}
domains:
  - id: g
    name: G
    components:
      - { id: g.t, name: T, row: top }
      - { id: g.c3, name: C3 }
      - { id: g.c2, name: C2 }
      - { id: g.c1, name: C1 }
      - { id: g.p, name: P }
      - { id: g.q, name: Q }
      - { id: g.b, name: B, row: bot }
edges:
  - { id: e1, from: g.c3, to: g.c2, kind: dataflow }
  - { id: e2, from: g.c2, to: g.c1, kind: dataflow }
  - { id: e3, from: g.c1, to: g.b, kind: dataflow }
  - { id: e4, from: g.p, to: g.q, kind: dataflow }
  - { id: e5, from: g.q, to: g.p, kind: dataflow }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    expect([...layout.placedRow]).toEqual([
      ['g.c3', 'bot'],
      ['g.c2', 'bot'],
      ['g.c1', 'bot'],
      ['g.p', 'top'], // only connected to each other: no votes → top row
      ['g.q', 'top'],
    ]);
  });

  it('grows a band for every column when one item in it is tall', async () => {
    const model = parseOk(`
version: 1
rows:
  - { id: a, name: A }
  - { id: b, name: B }
domains:
  - id: p
    name: P
    components:
      - id: p.tall
        name: Tall
        row: a
        subcomponents:
          - { id: p.tall.s1, name: S1 }
          - { id: p.tall.s2, name: S2 }
          - { id: p.tall.s3, name: S3 }
          - { id: p.tall.s4, name: S4 }
          - { id: p.tall.s5, name: S5 }
      - { id: p.low, name: Low, row: b }
  - id: q
    name: Q
    components:
      - { id: q.top, name: Top, row: a }
      - { id: q.low, name: Low, row: b }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    const tall = rectOf(layout, 'p.tall');
    const bandA = band(layout, 'a');
    expect(tall.height).toBeGreaterThan(300);
    expect(bandA.height).toBe(GROUP_PADDING.top + tall.height + 2 * BAND_PADDING_Y);
    expect(rectOf(layout, 'q.top').height).toBeLessThan(tall.height / 2);
    // Band b starts below the tall item for both columns, so both row-b children align.
    expect(rectOf(layout, 'q.low').y).toBe(rectOf(layout, 'p.low').y);
    expect(rectOf(layout, 'q.low').y).toBeGreaterThan(bottom(tall));
    expectCoversBands(layout, 'p', 'a', 'b');
    expectCoversBands(layout, 'q', 'a', 'b');
  });

  it('pulls an unassigned node toward the band of its connections', async () => {
    const model = parseOk(`${THREE_ROWS}
domains:
  - id: eng
    name: Eng
    row: top
    components:
      - { id: eng.a, name: EA }
  - id: hw
    name: HW
    row: bot
    components:
      - { id: hw.a, name: HA }
      - { id: hw.b, name: HB }
  - { id: u, name: U }
edges:
  - { id: e1, from: u, to: hw.a, kind: dataflow }
  - { id: e2, from: hw.b, to: u, kind: control }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    const bot = band(layout, 'bot');
    const centre = centreY(rectOf(layout, 'u'));
    expect(centre).toBeGreaterThanOrEqual(bot.y);
    expect(centre).toBeLessThanOrEqual(bottom(bot));
    const target = (centreY(rectOf(layout, 'hw.a')) + centreY(rectOf(layout, 'hw.b'))) / 2;
    expect(Math.abs(centre - target)).toBeLessThanOrEqual(1);
    expect(layout.unassignedArea?.x).toBeGreaterThanOrEqual(Math.max(...layout.rows.map(right)));
  });

  it('keeps several unassigned nodes apart, in target order, unconnected ones last', async () => {
    const model = parseOk(`${THREE_ROWS}
domains:
  - id: eng
    name: Eng
    row: top
    components:
      - { id: eng.a, name: EA }
  - { id: hw, name: HW, row: bot }
  - { id: u1, name: U1 }
  - { id: u2, name: U2 }
  - id: u3
    name: U3
    components:
      - { id: u3.a, name: U3A }
      - { id: u3.b, name: U3B }
  - { id: u4, name: U4 }
  - { id: u5, name: U5 }
edges:
  - { id: e1, from: u1, to: hw, kind: dataflow }
  - { id: e2, from: u2, to: eng.a, kind: dataflow }
  - { id: e3, from: u3.a, to: hw, kind: dataflow }
  - { id: e4, from: u3.a, to: u3.b, kind: dataflow }
  - { id: e5, from: u5, to: hw, kind: dataflow }
  - { id: e6, from: u4, to: u1, kind: dataflow }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    const ids = ['u1', 'u2', 'u3', 'u4', 'u5'];
    const byY = [...ids].sort((a, b) => rectOf(layout, a).y - rectOf(layout, b).y);
    // u2 → top band first; u1, u3, u5 all → bottom band (ties in YAML order); u4 has no
    // assigned connection.
    expect(byY).toEqual(['u2', 'u1', 'u3', 'u5', 'u4']);
    for (let i = 1; i < byY.length; i++) {
      expect(rectOf(layout, byY[i] ?? '').y).toBeGreaterThan(
        bottom(rectOf(layout, byY[i - 1] ?? '')),
      );
    }
    expect(centreY(rectOf(layout, 'u2'))).toBeLessThan(bottom(band(layout, 'top')));
    // The area grows downward when the pulled items don't fit.
    const area = layout.unassignedArea;
    expect(area && bottom(area)).toBeGreaterThanOrEqual(bottom(rectOf(layout, 'u4')));
  });

  it('lays out the inside of an unassigned group like a plain layout of that group', async () => {
    const group = `
  - id: u
    name: U
    components:
      - { id: u.a, name: A }
      - { id: u.b, name: B }
      - { id: u.c, name: C }`;
    const inner = `
  - { id: e1, from: u.a, to: u.b, kind: dataflow }
  - { id: e2, from: u.a, to: u.c, kind: dataflow }`;
    const withRows = parseOk(`${THREE_ROWS}
domains:
  - { id: t, name: T, row: top }${group}
edges:${inner}
  - { id: e3, from: u.b, to: t, kind: dataflow }
`);
    const plain = parseOk(`
version: 1
domains:${group}
edges:${inner}
`);
    const rowLayout = await computeLayoutUncached(withRows);
    const plainLayout = await computeLayoutUncached(plain);
    for (const id of ['u.a', 'u.b', 'u.c']) {
      expect(rowLayout.rects.get(id)).toEqual(plainLayout.rects.get(id));
    }
    const u = rowLayout.rects.get('u');
    expect([u?.width, u?.height]).toEqual([
      plainLayout.rects.get('u')?.width,
      plainLayout.rects.get('u')?.height,
    ]);
  });

  it('keeps empty bands at a minimum height and contiguous', async () => {
    const model = parseOk(`${THREE_ROWS}
domains:
  - { id: only, name: Only, row: mid }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    expect(layout.rows.map((b) => b.height > 0)).toEqual([true, true, true]);
    expectInBand(layout, 'only', 'mid');
    expect(layout.bounds.height).toBe(bottom(band(layout, 'bot')));
  });
});

describe('rowPlacement', () => {
  it('names the rows of the example as its layout does, without a layout', async () => {
    const model = parseOk(exampleYaml);
    const placement = rowPlacement(model);
    expect([...placement.placedRow]).toEqual([
      ['operations.alerts', 'backoffice'],
      ['data.analytics.feature-store', 'middle'],
    ]);
    expect(placement.rowOf.get('operations.alerts')).toBe('backoffice');
    expect(placement.rowOf.get('operations.oms')).toBe('middle');
    // Spanning groups and unassigned nodes sit in no single row.
    expect(placement.rowOf.has('operations')).toBe(false);
    expect(placement.rowOf.has('platform')).toBe(false);
    expect([...placement.rowOf.keys()]).toEqual(
      [...model.nodes.keys()].filter((id) => placement.rowOf.has(id)),
    );
    expectRowPlacement(model, await computeLayoutUncached(model));
  });

  it('gives the nodes below a node placed by its connections that row', () => {
    const model = parseOk(`${THREE_ROWS}
domains:
  - id: g
    name: G
    components:
      - { id: g.t, name: T, row: top }
      - { id: g.b, name: B, row: bot }
      - id: g.x
        name: X
        subcomponents:
          - { id: g.x.inner, name: Inner }
edges:
  - { id: e1, from: g.x.inner, to: g.b, kind: dataflow }
`);
    const placement = rowPlacement(model);
    expect([...placement.placedRow]).toEqual([['g.x', 'bot']]);
    expect([...placement.rowOf]).toEqual([
      ['g.t', 'top'],
      ['g.b', 'bot'],
      ['g.x', 'bot'],
      ['g.x.inner', 'bot'],
    ]);
  });

  it('is empty for a model without rows', () => {
    const placement = rowPlacement(
      parseOk(`
version: 1
domains:
  - id: a
    name: A
    components:
      - { id: a.x, name: X }
`),
    );
    expect(placement.placedRow.size).toBe(0);
    expect(placement.rowOf.size).toBe(0);
  });
});

describe('layout cache', () => {
  beforeEach(() => clearLayoutCache());

  it('returns the cached result for the same structure, recomputes when it changes', async () => {
    const model = parseOk(exampleYaml);
    const first = await computeLayout(model);
    expect(await computeLayout(model)).toBe(first);
    expect(await computeLayout(parseOk(exampleYaml))).toBe(first);
    // Edge label text does not affect the layout …
    const relabelled = parseOk(exampleYaml.replace('label: app events', 'label: other'));
    expect(await computeLayout(relabelled)).toBe(first);
    // … but a node name does (it changes the box width).
    const renamed = parseOk(exampleYaml.replace('name: Web Shop', 'name: Main Web Shop'));
    const second = await computeLayout(renamed);
    expect(second).not.toBe(first);
    expect(second.key).not.toBe(first.key);
  });

  it('uses an optional persistent storage and survives broken storage', async () => {
    const model = parseOk(exampleYaml);
    const store = new Map<string, string>();
    const storage: LayoutStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    };
    const computed = await computeLayout(model, { storage });
    const saved = store.get(LAYOUT_STORAGE_KEY);
    expect(saved).toBe(serializeLayout(computed));
    expect(serializeLayout(deserializeLayout(saved ?? '') as LayoutResult)).toBe(saved);

    // A stored entry with the same key is used instead of recomputing.
    clearLayoutCache();
    const tampered = JSON.parse(saved ?? '{}') as { bounds: { width: number } };
    tampered.bounds.width = 12345;
    store.set(LAYOUT_STORAGE_KEY, JSON.stringify(tampered));
    expect((await computeLayout(model, { storage })).bounds.width).toBe(12345);

    // Corrupt or throwing storage falls back to computing.
    clearLayoutCache();
    store.set(LAYOUT_STORAGE_KEY, '{not json');
    expect(serializeLayout(await computeLayout(model, { storage }))).toBe(saved);
    clearLayoutCache();
    const broken: LayoutStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(serializeLayout(await computeLayout(model, { storage: broken }))).toBe(saved);
  });
});

describe('row bands next to a taller Unassigned area', () => {
  const bandsBottom = (layout: LayoutResult): number =>
    Math.max(...layout.rows.map((row) => row.y + row.height));

  it('stretches the last band down to the bottom of the area when nothing is assigned', async () => {
    const model = parseOk(`
version: 1
rows:
  - { id: r1, name: One }
  - { id: r2, name: Two }
domains:
  - id: aa
    name: AA
    components:
      - { id: aa.x, name: X }
      - { id: aa.y, name: Y }
  - { id: bb, name: BB }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    const area = layout.unassignedArea;
    if (!area) throw new Error('no Unassigned area');
    const [first, last] = layout.rows;
    if (!first || !last) throw new Error('no bands');
    // The area is the taller one here; the bands end where it ends.
    expect(area.height).toBeGreaterThan(2 * first.height);
    expect(bandsBottom(layout)).toBe(area.y + area.height);
    expect(layout.bounds.height).toBe(area.height);
    // Only the last band grows, and the bands stay stacked without a gap.
    expect(last.y).toBe(first.y + first.height);
    expect(last.height).toBeGreaterThan(first.height);
  });

  it('does the same for a single row with one unassigned domain', async () => {
    const model = parseOk(`
version: 1
rows:
  - { id: r1, name: One }
domains:
  - id: aa
    name: AA
    components:
      - { id: aa.x, name: X }
`);
    const layout = await computeLayoutUncached(model);
    expect(layoutViolations(model, layout)).toEqual([]);
    expectRowPlacement(model, layout);
    const area = layout.unassignedArea;
    if (!area) throw new Error('no Unassigned area');
    expect(bandsBottom(layout)).toBe(area.y + area.height);
  });

  it('leaves the bands alone when they are the taller side (the example)', async () => {
    const model = parseOk(exampleYaml);
    const layout = await computeLayoutUncached(model);
    const area = layout.unassignedArea;
    if (!area) throw new Error('no Unassigned area');
    expect(area.height).toBe(bandsBottom(layout));
  });
});
