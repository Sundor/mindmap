// Closing up the gaps: the fully expanded layout arranged around what is drawn.

import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import {
  arrangedLayout,
  arrangedSourceNodes,
  arrangeLayout,
  arrangementKey,
  arrangementSignature,
  closeUp,
  compact2D,
  visibleRects,
  type ArrangeView,
} from './arrange';
import { buildFlow, closedGroupSize, type ArchFlowNode, type FlowWorkItems } from './flow';
import { focusSet } from './focus';
import { filterToFocus, withPlacedRows } from './focusFilter';
import { computeLayoutUncached, type LayoutResult } from './layout';
import {
  HEADER_HEIGHT,
  ITEM_GAP,
  LAYER_SPACING,
  MIN_BAND_HEIGHT,
  NODE_SPACING,
  UNASSIGNED_HEADER,
  UNASSIGNED_PADDING,
} from './layout/constants';
import { overlaps, parseOk } from './layout/test-helpers';
import { rowPlacement } from './layout/tiered';
import type { Rect, Size } from './layout/types';
import { miniMapNodes } from './minimap';
import type { ArchitectureModel, ArchNode } from './model';
import { applyPositionOverrides, movedByHand, NO_HAND_OVERRIDES, withoutRows } from './positions';
import { groupIds, LOD_LEVELS, visibleNodes, type LodLevel } from './visibility';
import { workItemContent } from './workItemContent';
import { buildWorkItemOverlay } from './workItemOverlay';
import { parseWorkItems } from './workitems';

const example = parseOk(exampleYaml);
const overlay = buildWorkItemOverlay(example, parseWorkItems(fixtureJson).items);
const stories: FlowWorkItems = { overlay, mode: 'stories' };
const storyContent = workItemContent(overlay, 'stories');

/** A small model with rows: a spanning group, an attracted node and an Unassigned domain. */
const tiered = parseOk(`
version: 1
rows:
  - { id: top, name: Top }
  - { id: mid, name: Middle }
  - { id: bot, name: Bottom }
domains:
  - id: s
    name: Span
    components:
      - { id: s.up, name: Up, row: top }
      - id: s.inner
        name: Inner span
        subcomponents:
          - { id: s.inner.mid, name: Mid, row: mid }
          - { id: s.inner.low, name: Low, row: bot }
      - { id: s.free, name: Attracted }
  - id: r
    name: Row domain
    row: mid
    components:
      - { id: r.one, name: One }
      - { id: r.two, name: Two with a longer name }
  - id: u
    name: Unassigned
    components:
      - { id: u.one, name: One }
      - { id: u.two, name: Two }
edges:
  - { id: e1, from: s.free, to: s.inner.low, kind: dataflow }
  - { id: e2, from: s.up, to: r.one, kind: dataflow }
  - { id: e3, from: u.one, to: r.one, kind: dataflow }
  - { id: e4, from: u.two, to: s.inner.low, kind: dataflow }
`);

/** `count` leaves `${prefix}0` … as YAML list items at `indent`. */
function parts(prefix: string, count: number, indent: string): string {
  return Array.from(
    { length: count },
    (_, i) => `${indent}- { id: ${prefix}${i}, name: Part ${i} }`,
  ).join('\n');
}

/** A chain of edges through the `count` leaves `${prefix}0` …, which lays them out in a line. */
function chain(prefix: string, count: number): string {
  return Array.from(
    { length: count - 1 },
    (_, i) =>
      `  - { id: ${prefix}${i}-next, from: ${prefix}${i}, to: ${prefix}${i + 1}, kind: dataflow }`,
  ).join('\n');
}

/**
 * Two rows whose boxes interleave: `beside` (upper row) ends left of where `after` (lower row)
 * starts, because the wide group before `after` reaches further right than the upper row does.
 */
const interleaved = parseOk(`
version: 1
rows:
  - { id: upper, name: Upper }
  - { id: lower, name: Lower }
domains:
  - id: lead
    name: Lead
    row: upper
    components:
${parts('lead.c', 3, '      ')}
  - id: beside
    name: Beside
    row: upper
    components:
      - { id: beside.one, name: One }
  - id: wide
    name: Wide
    row: lower
    components:
${parts('wide.c', 6, '      ')}
  - id: after
    name: After
    row: lower
    components:
      - { id: after.one, name: One }
edges:
  - { id: e1, from: lead.c2, to: beside.one, kind: dataflow }
  - { id: e2, from: wide.c5, to: after.one, kind: dataflow }
${chain('lead.c', 3)}
${chain('wide.c', 6)}
`);

/** Two groups that span two rows each and share the middle one; the lower one comes first. */
const overlapping = parseOk(`
version: 1
rows:
  - { id: r0, name: Zero }
  - { id: r1, name: One }
  - { id: r2, name: Two }
domains:
  - id: low
    name: Low
    components:
      - { id: low.one, name: One, row: r1 }
      - { id: low.two, name: Two, row: r2 }
  - id: high
    name: High
    components:
      - { id: high.one, name: One, row: r0 }
      - { id: high.two, name: Two, row: r1 }
`);

/**
 * An Unassigned area that ends below the bands: `side` is tall and hangs on a connection into
 * the lower row, `near` on one into the tall group of the upper row, which holds it below
 * `small`.
 */
const sided = parseOk(`
version: 1
rows:
  - { id: upper, name: Upper }
  - { id: lower, name: Lower }
domains:
  - id: tall
    name: Tall
    row: upper
    components:
${parts('tall.c', 6, '      ')}
  - id: small
    name: Small
    row: upper
  - id: deep
    name: Deep
    row: lower
    components:
      - id: deep.list
        name: List
        subcomponents:
${parts('deep.list.s', 6, '          ')}
  - id: side
    name: Side
    components:
${parts('side.c', 10, '      ')}
  - id: near
    name: Near
    components:
      - { id: near.one, name: One }
edges:
  - { id: e1, from: side.c0, to: deep.list.s0, kind: dataflow }
  - { id: e2, from: near.one, to: tall.c5, kind: dataflow }
`);

/** Random numbers in [0, 1) from `seed`, the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * A model with two to four rows, made from `seed`. A domain has its rows set on itself (a box
 * in one row), on its components (the domain spans rows), on their subcomponents (its
 * components span rows too) or nowhere (the Unassigned area) — the first four domains one of
 * each; a node may be left without a row among siblings that have one. The children of a group
 * are chained by edges, which lays them out in a wide line, or not, which stacks them.
 */
function generated(seed: number): ArchitectureModel {
  const random = seeded(seed);
  const below = (count: number): number => Math.floor(random() * count);
  const rows = Array.from({ length: 2 + below(3) }, (_, i) => `r${i}`);
  const row = (): string => rows[below(rows.length)] ?? 'r0';
  const name = (): string =>
    ['Hub', 'Order intake', 'Reporting and analytics service'][below(3)] ?? 'Hub';
  const lines = ['version: 1', 'rows:', ...rows.map((id) => `  - { id: ${id}, name: ${id} }`)];
  const ids: string[] = [];
  const edges: string[] = [];
  const edge = (from: string, to: string): void => {
    edges.push(`  - { id: e${edges.length}, from: ${from}, to: ${to}, kind: dataflow }`);
  };
  lines.push('domains:');
  const domains = 5 + below(4);
  for (let d = 0; d < domains; d++) {
    const domain = `d${d}`;
    // Where the rows are set: 0 the domain, 1 its components, 2 their subcomponents, 3 nowhere.
    const depth = d < 4 ? d : ([0, 0, 1][below(3)] ?? 0);
    ids.push(domain);
    lines.push(`  - id: ${domain}`, `    name: ${name()}`);
    if (depth === 0) lines.push(`    row: ${row()}`);
    const components = 1 + below(5);
    const line = random() < 0.5;
    lines.push('    components:');
    for (let c = 0; c < components; c++) {
      const component = `${domain}.c${c}`;
      ids.push(component);
      lines.push(`      - id: ${component}`, `        name: ${name()}`);
      if (depth === 1 && random() < 0.8) lines.push(`        row: ${row()}`);
      if (c > 0 && line) edge(`${domain}.c${c - 1}`, component);
      const subcomponents = below(5);
      const subLine = random() < 0.5;
      if (subcomponents > 0) lines.push('        subcomponents:');
      for (let s = 0; s < subcomponents; s++) {
        const subcomponent = `${component}.s${s}`;
        ids.push(subcomponent);
        lines.push(`          - id: ${subcomponent}`, `            name: ${name()}`);
        if (depth === 2 && random() < 0.8) lines.push(`            row: ${row()}`);
        if (s > 0 && subLine) edge(`${component}.s${s - 1}`, subcomponent);
      }
    }
  }
  for (let e = below(ids.length); e > 0; e--) {
    const from = ids[below(ids.length)] ?? '';
    const to = ids[below(ids.length)] ?? '';
    if (from !== to && !from.startsWith(`${to}.`) && !to.startsWith(`${from}.`)) edge(from, to);
  }
  return parseOk([...lines, ...(edges.length > 0 ? ['edges:', ...edges] : [])].join('\n'));
}

/** The sizes closed groups are drawn at with Shrink collapsed groups on. */
function shrunk(model: ArchitectureModel, workItems?: FlowWorkItems): ArrangeView['closedSize'] {
  const view = { compactCollapsed: true, ...(workItems ? { workItems } : {}) };
  return (node, full) => closedGroupSize(model, node, full, view);
}

function viewOf(
  model: ArchitectureModel,
  visible: ReadonlySet<string>,
  workItems?: FlowWorkItems,
  content?: ReadonlyMap<string, Size>,
): ArrangeView {
  return { visible, closedSize: shrunk(model, workItems), ...(content ? { content } : {}) };
}

function nodeOf(model: ArchitectureModel, id: string): ArchNode {
  const node = model.nodes.get(id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

function rectIn(rects: ReadonlyMap<string, Rect>, id: string): Rect {
  const rect = rects.get(id);
  if (!rect) throw new Error(`no rect for ${id}`);
  return rect;
}

const isClosed = (node: ArchNode, visible: ReadonlySet<string>): boolean =>
  node.childIds.length > 0 && !node.childIds.some((child) => visible.has(child));
const spansRows = (layout: LayoutResult, node: ArchNode): boolean =>
  layout.rows.length > 0 && node.effectiveRow === undefined && node.rowRange !== undefined;
const area = (size: Size): number => size.width * size.height;

const EPS = 1e-6;
/** Positions are whole pixels: what a gap or a size may be off by. */
const PIXEL = 1;

/** Whether `inner` lies inside `outer`, `top` below its top edge. */
function inside(inner: Rect, outer: Rect, top = 0): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y + top - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}

function rootOf(model: ArchitectureModel, id: string): ArchNode {
  let node = nodeOf(model, id);
  while (node.parentId !== undefined) node = nodeOf(model, node.parentId);
  return node;
}

/** Everything an arrangement of `reference` for `view` must satisfy; returns what it does not. */
function violations(
  model: ArchitectureModel,
  reference: LayoutResult,
  layout: LayoutResult,
  view: ArrangeView,
): string[] {
  const { visible } = view;
  const problems: string[] = [];
  const at = (id: string): Rect => rectIn(layout.absolute, id);
  const ids = [...model.nodes.keys()];
  if ([...layout.rects.keys()].join() !== ids.join()) problems.push('rects not in model order');
  if ([...layout.absolute.keys()].join() !== ids.join()) {
    problems.push('absolute not in model order');
  }
  for (const node of model.nodes.values()) {
    const rel = rectIn(layout.rects, node.id);
    const abs = at(node.id);
    const parent = node.parentId === undefined ? undefined : at(node.parentId);
    if (
      Math.abs(abs.x - (parent?.x ?? 0) - rel.x) > EPS ||
      Math.abs(abs.y - (parent?.y ?? 0) - rel.y) > EPS ||
      abs.width !== rel.width ||
      abs.height !== rel.height
    ) {
      problems.push(`${node.id}: rects and absolute disagree`);
    }
    if (!visible.has(node.id)) {
      // Inside the nearest visible ancestor, which stands for it.
      let holder = node.parentId;
      while (holder !== undefined && !visible.has(holder)) holder = nodeOf(model, holder).parentId;
      if (holder !== undefined && !inside(abs, at(holder))) {
        problems.push(`${node.id}: hidden outside ${holder}`);
      }
      continue;
    }
    if (parent && !inside(abs, parent, HEADER_HEIGHT)) problems.push(`${node.id}: outside parent`);
    if (!inside(abs, { x: 0, y: 0, ...layout.bounds })) problems.push(`${node.id}: outside bounds`);
  }

  // Visible siblings: apart, in the order of the reference, and no closer than there or than
  // the gap of their container.
  const siblings = new Map<string, string[]>();
  for (const id of visible) {
    const parent = nodeOf(model, id).parentId ?? '';
    siblings.set(parent, [...(siblings.get(parent) ?? []), id]);
  }
  const rows = layout.rows.length > 0;
  /** A top-level node of the Unassigned area. */
  const isUnassigned = (id: string): boolean => {
    const node = nodeOf(model, id);
    return (
      rows &&
      node.parentId === undefined &&
      node.effectiveRow === undefined &&
      node.rowRange === undefined
    );
  };
  /** `first` before `second` in the reference along an axis: still so, and far enough. */
  const ordered = (first: string, second: string, axis: 'x' | 'y', least: number): void => {
    const extent = axis === 'x' ? 'width' : 'height';
    const gapIn = (rects: ReadonlyMap<string, Rect>): number => {
      const from = rectIn(rects, first);
      return rectIn(rects, second)[axis] - (from[axis] + from[extent]);
    };
    const gap = gapIn(reference.absolute);
    if (gap < 0) return;
    const centre = (id: string): number => at(id)[axis] + at(id)[extent] / 2;
    const side = axis === 'x' ? 'left of' : 'above';
    if (!(centre(first) < centre(second))) problems.push(`${first} no longer ${side} ${second}`);
    else if (gapIn(layout.absolute) < Math.min(gap, least) - PIXEL) {
      problems.push(`${first} too close ${side} ${second}`);
    }
  };
  for (const [parent, group] of siblings) {
    // The items of the bands are ITEM_GAP apart, the boxes inside a box LAYER_SPACING.
    const inBands = rows && (parent === '' || spansRows(layout, nodeOf(model, parent)));
    group.forEach((a, i) => {
      for (const b of group.slice(i + 1)) {
        if (overlaps(at(a), at(b))) problems.push(`${a} overlaps ${b}`);
        for (const [first, second] of [
          [a, b],
          [b, a],
        ] as const) {
          ordered(first, second, 'x', inBands ? ITEM_GAP : LAYER_SPACING);
          // A box of the Unassigned area follows its connections past the boxes in the bands.
          if (isUnassigned(a) === isUnassigned(b)) ordered(first, second, 'y', NODE_SPACING);
        }
      }
    });
  }

  // Bands contiguous from 0, single-row nodes inside their band, the rest in the Unassigned area.
  let y = 0;
  for (const band of layout.rows) {
    if (band.x !== 0 || Math.abs(band.y - y) > EPS) problems.push(`band ${band.id} not contiguous`);
    y = band.y + band.height;
  }
  for (const id of visible) {
    const rowId = layout.rowOf.get(id);
    const band = layout.rows.find((row) => row.id === rowId);
    if (band && !inside(at(id), band)) problems.push(`${id}: outside its band`);
    const unassigned = isUnassigned(rootOf(model, id).id);
    if (unassigned && !(layout.unassignedArea && inside(at(id), layout.unassignedArea))) {
      problems.push(`${id}: outside the Unassigned area`);
    }
  }

  // Closed groups take the room of the box they are drawn at; one that spans rows, its column.
  for (const id of visible) {
    const node = nodeOf(model, id);
    if (!isClosed(node, visible)) continue;
    const want = view.closedSize(node, rectIn(reference.absolute, id));
    const rect = at(id);
    if (spansRows(layout, node)) {
      if (rect.width !== want.width || rect.height < want.height) {
        problems.push(`${id}: column too small`);
      }
    } else if (rect.width !== want.width || rect.height !== want.height) {
      problems.push(`${id}: not at its closed size`);
    }
  }
  if (
    layout.bounds.width > reference.bounds.width + PIXEL ||
    layout.bounds.height > reference.bounds.height + PIXEL
  ) {
    problems.push('larger than the reference');
  }
  return problems;
}

/** Arranges one case and checks it; returns the arrangement. */
function check(
  model: ArchitectureModel,
  reference: LayoutResult,
  view: ArrangeView,
  label: string,
): LayoutResult {
  const layout = arrangeLayout(model, reference, view);
  expect(violations(model, reference, layout, view), label).toEqual([]);
  return layout;
}

/** A level and the groups collapsed by hand. */
interface Case {
  readonly level: LodLevel;
  readonly collapsed: ReadonlySet<string>;
}

function namedCases(model: ArchitectureModel, reference: LayoutResult): Case[] {
  const groups = groupIds(model);
  const largestDomains = [...model.rootIds]
    .sort((a, b) => area(rectIn(reference.absolute, b)) - area(rectIn(reference.absolute, a)))
    .slice(0, 2);
  const components = groups.filter((id) => nodeOf(model, id).level === 1).slice(0, 4);
  const sets = [new Set<string>(), new Set(largestDomains), new Set(components), new Set(groups)];
  return LOD_LEVELS.flatMap((level) => sets.map((collapsed) => ({ level, collapsed })));
}

/** `count` random collapsed sets and levels, the same on every run. */
function randomCases(model: ArchitectureModel, count: number, seed: number): Case[] {
  const random = seeded(seed);
  const groups = groupIds(model);
  return Array.from({ length: count }, (_, i) => {
    const share = [0.1, 0.3, 0.6][i % 3] ?? 0.3;
    const collapsed = new Set(groups.filter(() => random() < share));
    const level = LOD_LEVELS[Math.floor(random() * LOD_LEVELS.length)] ?? 'detail';
    return { level, collapsed };
  });
}

/** The example with its rows, or without, and its fully expanded layout. */
interface Mode {
  readonly name: string;
  readonly model: ArchitectureModel;
  readonly reference: LayoutResult;
}

let modes: Mode[] = [];
let withRows: Mode;

beforeAll(async () => {
  const mode = async (name: string, model: ArchitectureModel): Promise<Mode> => ({
    name,
    model,
    reference: await computeLayoutUncached(model),
  });
  withRows = await mode('rows', example);
  modes = [withRows, await mode('no rows', withoutRows(example))];
});

describe('compact2D', () => {
  const r = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });
  const s = (width: number, height: number): Size => ({ width, height });

  it('closes the gap left of a box that got narrower', () => {
    expect(
      compact2D([r(0, 0, 100, 50), r(148, 0, 100, 50)], [s(40, 50), s(100, 50)], 48, 24),
    ).toEqual({
      positions: [
        { x: 0, y: 0 },
        { x: 88, y: 0 },
      ],
      width: 188,
      height: 50,
    });
  });

  it('caps a wide gap and keeps a narrow one', () => {
    const wide = compact2D([r(0, 0, 100, 50), r(300, 0, 100, 50)], [s(40, 50), s(100, 50)], 48, 24);
    expect(wide.positions[1]).toEqual({ x: 88, y: 0 });
    const narrow = compact2D(
      [r(0, 0, 100, 50), r(110, 0, 100, 50)],
      [s(40, 50), s(100, 50)],
      48,
      24,
    );
    expect(narrow.positions[1]).toEqual({ x: 50, y: 0 });
  });

  it('closes the gap above a box that got lower', () => {
    const packed = compact2D(
      [r(0, 0, 100, 50), r(0, 74, 100, 50)],
      [s(100, 20), s(100, 50)],
      48,
      24,
    );
    expect(packed.positions[1]).toEqual({ x: 0, y: 44 });
  });

  it('keeps a box diagonal to another right of it and below it', () => {
    const packed = compact2D(
      [r(0, 0, 100, 50), r(150, 100, 100, 50)],
      [s(40, 20), s(100, 50)],
      48,
      24,
    );
    expect(packed.positions[1]).toEqual({ x: 88, y: 44 });
  });

  it('changes nothing when no size changed and the gaps are within the caps', () => {
    const ref = [r(0, 0, 100, 50), r(130, 0, 100, 50), r(0, 65, 100, 50)];
    expect(
      compact2D(
        ref,
        ref.map((x) => s(x.width, x.height)),
        48,
        24,
      ),
    ).toEqual({
      positions: ref.map(({ x, y }) => ({ x, y })),
      width: 230,
      height: 115,
    });
  });

  it('keeps a box centred in its room centred', () => {
    // C sits in the middle below A and B; A shrinks, so the room under the row shrinks too.
    const ref = [r(0, 0, 100, 50), r(148, 0, 100, 50), r(74, 74, 100, 50)];
    const packed = compact2D(ref, [s(40, 50), s(100, 50), s(100, 50)], 48, 24);
    expect(packed.width).toBe(188);
    const c = packed.positions[2];
    expect(c && c.x + 50).toBe(94);
  });
});

describe('arrangeLayout of the example', () => {
  it('is the reference itself while no closed group is drawn smaller', () => {
    for (const { model, reference } of modes) {
      for (const level of ['subcomponents', 'detail'] as const) {
        const view = viewOf(model, visibleNodes(model, new Set(), level));
        expect(arrangementSignature(model, reference, view)).toBe('');
        expect(arrangementKey(reference, '')).toBe(reference.key);
        expect(arrangeLayout(model, reference, view)).toBe(reference);
        expect(arrangedLayout(model, reference, view)).toBe(reference);
      }
      for (const level of LOD_LEVELS) {
        const visible = visibleNodes(model, new Set(groupIds(model)), level);
        const full: ArrangeView = { visible, closedSize: (_node, rect) => rect };
        expect(arrangeLayout(model, reference, full)).toBe(reference);
      }
    }
  });

  it('reproduces the reference with nothing closed', async () => {
    const cases = [
      ...modes.map(({ model, reference }) => ({ model, reference, content: undefined })),
      { model: tiered, reference: await computeLayoutUncached(tiered), content: undefined },
      {
        model: example,
        reference: await computeLayoutUncached(example, undefined, storyContent),
        content: storyContent,
      },
    ];
    for (const { model, reference, content } of cases) {
      const visible = visibleNodes(model, new Set(), 'subcomponents');
      const same = closeUp(model, reference, viewOf(model, visible, undefined, content));
      expect(same.key).toBe(reference.key);
      expect([...same.absolute]).toEqual([...reference.absolute]);
      expect([...same.rects]).toEqual([...reference.rects]);
      expect(same.rows).toEqual(reference.rows);
      expect(same.bounds).toEqual(reference.bounds);
      expect(same.unassignedArea).toEqual(reference.unassignedArea);
      expect([...same.content]).toEqual([...reference.content]);
    }
  });

  it('takes the expected room at the coarser levels', () => {
    const expected: Record<string, Record<string, [number, number]>> = {
      rows: { plain: [2484, 1120], domains: [1608, 378], components: [2352, 778] },
      'no rows': { plain: [4020, 1092], domains: [1923, 290], components: [3377, 656] },
    };
    const badged: Record<string, Record<string, [number, number]>> = {
      rows: { domains: [1608, 430], components: [2352, 860] },
      'no rows': { domains: [1923, 342], components: [3572, 734] },
    };
    for (const { name, model, reference } of modes) {
      const size = (layout: LayoutResult): [number, number] => [
        layout.bounds.width,
        layout.bounds.height,
      ];
      expect(size(reference)).toEqual(expected[name]?.plain);
      for (const level of ['domains', 'components'] as const) {
        const visible = visibleNodes(model, new Set(), level);
        const plain = check(model, reference, viewOf(model, visible), `${name} ${level}`);
        expect(size(plain), `${name} ${level}`).toEqual(expected[name]?.[level]);
        const withBadges = check(model, reference, viewOf(model, visible, stories), name);
        expect(size(withBadges), `${name} ${level} with badges`).toEqual(badged[name]?.[level]);
        if (level === 'domains') {
          expect(area(plain.bounds)).toBeLessThanOrEqual(0.3 * area(reference.bounds));
          expect(area(withBadges.bounds)).toBeLessThanOrEqual(0.3 * area(reference.bounds));
        }
      }
    }
  });

  it('keeps every rule for each level and set of collapsed groups', () => {
    for (const { name, model, reference } of modes) {
      for (const { level, collapsed } of namedCases(model, reference)) {
        const view = viewOf(model, visibleNodes(model, collapsed, level));
        const layout = check(model, reference, view, `${name} ${level} ${[...collapsed].join()}`);
        expect(() =>
          buildFlow(model, layout, {
            collapsedIds: collapsed,
            lodLevel: level,
            compactCollapsed: true,
          }),
        ).not.toThrow();
      }
    }
  });

  it('keeps every rule for random sets of collapsed groups, and comes back to the same arrangement', () => {
    for (const [index, { name, model, reference }] of modes.entries()) {
      let arranged = 0;
      for (const { level, collapsed } of randomCases(model, 200, 12345 + index)) {
        const view = viewOf(model, visibleNodes(model, collapsed, level));
        const label = `${name} ${level} ${[...collapsed].join()}`;
        const layout = check(model, reference, view, label);
        if (layout === reference) {
          expect(arrangementSignature(model, reference, view)).toBe('');
          continue;
        }
        arranged += 1;
        // The same inputs give the same arrangement, and the cache the very same object.
        const again = arrangeLayout(model, reference, viewOf(model, new Set(view.visible)));
        expect(again).not.toBe(layout);
        expect(again).toEqual(layout);
        const cached = arrangedLayout(model, reference, view);
        arrangedLayout(model, reference, viewOf(model, visibleNodes(model, new Set(), 'domains')));
        expect(arrangedLayout(model, reference, view)).toBe(cached);
        expect(cached).toEqual(layout);
      }
      expect(arranged).toBeGreaterThan(150);
    }
  });

  it('draws every closed group exactly at its arranged box', () => {
    for (const { name, model, reference } of modes) {
      for (const { level, collapsed } of [
        ...namedCases(model, reference),
        ...randomCases(model, 30, 777),
      ]) {
        const visible = visibleNodes(model, collapsed, level);
        const view = viewOf(model, visible);
        const layout = arrangeLayout(model, reference, view);
        const flow = buildFlow(model, layout, {
          collapsedIds: collapsed,
          lodLevel: level,
          compactCollapsed: true,
        });
        for (const node of flow.nodes) {
          if (node.type === 'band' || !node.data.collapsed) continue;
          const arch = nodeOf(model, node.id);
          const rect = rectIn(layout.rects, node.id);
          const drawn = { ...node.position, width: node.width, height: node.height };
          const label = `${name} ${level} ${node.id}`;
          if (spansRows(layout, arch)) {
            // Shrunk in the middle of its column.
            expect(inside(drawn, rect), label).toBe(true);
            continue;
          }
          expect(closedGroupSize(model, arch, rect, { compactCollapsed: true }), label).toEqual({
            width: rect.width,
            height: rect.height,
          });
          expect(drawn, label).toEqual(rect);
        }
      }
    }
  });

  it('keeps every rule for the map reduced to a flow', async () => {
    const set = focusSet(example, { type: 'flow', id: 'telemetry-to-dashboards' });
    const reduced = set && filterToFocus(example, set, rowPlacement(example));
    if (!reduced) throw new Error('nothing to filter');
    for (const rows of [true, false]) {
      const model = rows ? reduced.model : withoutRows(reduced.model);
      const computed = await computeLayoutUncached(model);
      const reference = rows ? withPlacedRows(computed, reduced.placedRow) : computed;
      for (const { level, collapsed } of namedCases(model, reference)) {
        const view = viewOf(model, visibleNodes(model, collapsed, level));
        check(model, reference, view, `flow ${rows} ${level} ${[...collapsed].join()}`);
      }
    }
  });

  it('keeps every rule with an Unassigned area, and pulls its boxes toward their connections', async () => {
    for (const content of [undefined, everywhere(tiered)]) {
      const reference = await computeLayoutUncached(tiered, undefined, content);
      expect(reference.unassignedArea).toBeDefined();
      const cases = [...namedCases(tiered, reference), ...randomCases(tiered, 50, 99)];
      for (const { level, collapsed } of cases) {
        const view = viewOf(tiered, visibleNodes(tiered, collapsed, level), undefined, content);
        const layout = check(tiered, reference, view, `${level} ${[...collapsed].join()}`);
        expect(layout.unassignedArea).toBeDefined();
      }
    }
  });

  it('closes up a map with work items listed in the boxes', async () => {
    for (const { name, model } of modes) {
      const reference = await computeLayoutUncached(model, undefined, storyContent);
      const collapsed = new Set(groupIds(model).filter((id) => nodeOf(model, id).level === 1));
      const visible = visibleNodes(model, collapsed, 'detail');
      const view = viewOf(model, visible, stories, storyContent);
      const layout = check(model, reference, view, name);
      expect(layout).not.toBe(reference);
      for (const id of visible) {
        const node = nodeOf(model, id);
        if (node.childIds.length > 0) continue;
        const rect = rectIn(layout.absolute, id);
        const full = rectIn(reference.absolute, id);
        expect([rect.width, rect.height]).toEqual([full.width, full.height]);
      }
      expect([...layout.content.keys()]).toEqual([...reference.content.keys()]);
      for (const [id, block] of layout.content) {
        expect(block.width).toBe(rectIn(layout.rects, id).width);
        expect(block.height).toBe(rectIn(reference.content, id).height);
      }
      expect(() =>
        buildFlow(model, layout, {
          collapsedIds: collapsed,
          lodLevel: 'detail',
          compactCollapsed: true,
          workItems: stories,
        }),
      ).not.toThrow();
      // The badge line makes a closed group with stories taller, and another arrangement.
      const plain = viewOf(model, visible, undefined, storyContent);
      expect(arrangementSignature(model, reference, plain)).not.toBe(
        arrangementSignature(model, reference, view),
      );
      expect(arrangeLayout(model, reference, plain).key).not.toBe(layout.key);
    }
  });
});

/** A content block in every node of `model`. */
function everywhere(model: ArchitectureModel): ReadonlyMap<string, Size> {
  return new Map([...model.nodes.keys()].map((id) => [id, { width: 240, height: 52 }]));
}

describe('arrangeLayout with rows', () => {
  it('keeps a box right of a box in another row that it was right of', async () => {
    const reference = await computeLayoutUncached(interleaved);
    const before = (id: string): Rect => rectIn(reference.absolute, id);
    expect(before('beside').x + before('beside').width).toBeLessThan(before('after').x);

    const view = viewOf(interleaved, visibleNodes(interleaved, new Set(['wide']), 'subcomponents'));
    const layout = check(interleaved, reference, view, 'wide closed');
    const now = (id: string): Rect => rectIn(layout.absolute, id);
    // The closed group leaves room in its row that reaches left of `beside`; `after` takes it
    // only as far as `beside` in the row above lets it.
    expect(now('wide').x + now('wide').width + ITEM_GAP).toBeLessThan(now('beside').x);
    expect(now('beside')).toEqual(before('beside'));
    expect(now('after').x).toBe(now('beside').x + now('beside').width + ITEM_GAP);

    // Right after the closed group it would have changed sides with `beside`.
    const passed = { ...now('after'), x: now('wide').x + now('wide').width + ITEM_GAP };
    const broken: LayoutResult = {
      ...layout,
      rects: new Map(layout.rects).set('after', passed),
      absolute: new Map(layout.absolute).set('after', passed),
    };
    expect(violations(interleaved, reference, broken, view)).toContain(
      'beside no longer left of after',
    );
  });

  it('grows the bands for closed groups that span rows by no more than they need', async () => {
    const reference = await computeLayoutUncached(overlapping);
    // Closed groups as high as their columns in the reference, but narrower.
    const view: ArrangeView = {
      visible: visibleNodes(overlapping, new Set(), 'domains'),
      closedSize: (_node, full) => ({ width: 120, height: full.height }),
    };
    const layout = check(overlapping, reference, view, 'narrow columns');
    expect(layout).not.toBe(reference);
    // The middle band, which both groups share, holds what their columns lack.
    const heights = layout.rows.map((row) => row.height);
    expect(heights[0]).toBe(MIN_BAND_HEIGHT);
    expect(heights[2]).toBe(MIN_BAND_HEIGHT);
    expect(layout.bounds.height).toBeLessThanOrEqual(reference.bounds.height);
  });

  it('lets a box of the Unassigned area follow its connections past the boxes in the bands', async () => {
    const reference = await computeLayoutUncached(sided);
    const before = (id: string): Rect => rectIn(reference.absolute, id);
    // Beside the end of its connection inside the tall group: below the small box.
    expect(before('near').y).toBeGreaterThan(before('small').y + before('small').height);

    const view = viewOf(sided, visibleNodes(sided, new Set(['tall']), 'subcomponents'));
    const layout = check(sided, reference, view, 'tall closed');
    const now = (id: string): Rect => rectIn(layout.absolute, id);
    // The connection now ends at the closed group at the top of its band: the box goes there,
    // as high as the title of the area lets it, beside the small box and right of the bands.
    expect(now('near').y).toBe(UNASSIGNED_HEADER + UNASSIGNED_PADDING);
    expect(now('near').y).toBeLessThan(now('small').y + now('small').height);
    expect(now('near').x).toBeGreaterThan(layout.rows[0]?.width ?? Infinity);
    expect(now('near').y + now('near').height).toBeLessThan(now('side').y);
  });

  it('ends the Unassigned area no lower than the reference does', async () => {
    const reference = await computeLayoutUncached(sided);
    // The closed group stays so high that its middle, where the connection of `side` ends
    // now, lies below where it ended in the reference.
    const view: ArrangeView = {
      visible: visibleNodes(sided, new Set(['deep.list']), 'subcomponents'),
      closedSize: (_node, full) => ({ width: full.width, height: Math.min(full.height, 300) }),
    };
    const end = rectIn(reference.absolute, 'deep.list.s0');
    const layout = check(sided, reference, view, 'deep.list closed');
    const closed = rectIn(layout.absolute, 'deep.list');
    expect(closed.y + closed.height / 2).toBeGreaterThan(end.y + end.height / 2);
    // `side` reached down to the end of the area: it stays, and the area with it.
    expect(rectIn(layout.absolute, 'side')).toEqual(rectIn(reference.absolute, 'side'));
    expect(layout.unassignedArea).toEqual(reference.unassignedArea);
    expect(layout.bounds).toEqual(reference.bounds);
    expect(layout.rows.at(-1)?.y).toBe(reference.rows.at(-1)?.y);
  });

  // Boxes in several rows, groups that span rows, row-less boxes among them, Unassigned areas.
  it('keeps every rule on generated models', async () => {
    let spanning = 0;
    let unassigned = 0;
    let arranged = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const model = generated(seed);
      const content = seed % 3 === 0 ? everywhere(model) : undefined;
      const reference = await computeLayoutUncached(model, undefined, content);
      if (reference.unassignedArea) unassigned += 1;
      if ([...model.nodes.values()].some((node) => spansRows(reference, node))) spanning += 1;

      const open = viewOf(
        model,
        visibleNodes(model, new Set(), 'subcomponents'),
        undefined,
        content,
      );
      const same = closeUp(model, reference, open);
      expect([...same.absolute], `seed ${seed}`).toEqual([...reference.absolute]);
      expect(same.rows, `seed ${seed}`).toEqual(reference.rows);
      expect(same.unassignedArea, `seed ${seed}`).toEqual(reference.unassignedArea);
      expect(same.bounds, `seed ${seed}`).toEqual(reference.bounds);

      const cases: Case[] = [
        ...namedCases(model, reference),
        // One group closed by hand.
        ...groupIds(model).map((id) => ({
          level: 'subcomponents' as const,
          collapsed: new Set([id]),
        })),
        ...randomCases(model, 20, seed),
      ];
      for (const { level, collapsed } of cases) {
        const view = viewOf(model, visibleNodes(model, collapsed, level), undefined, content);
        const label = `seed ${seed} ${level} ${[...collapsed].join()}`;
        const layout = check(model, reference, view, label);
        if (layout === reference) continue;
        arranged += 1;
        expect(arrangeLayout(model, reference, view), label).toEqual(layout);
      }
    }
    expect([spanning, unassigned]).toEqual([12, 12]);
    expect(arranged).toBeGreaterThan(500);
  }, 60_000);
});

describe('the checks of an arrangement', () => {
  it('find boxes that overlap or changed sides', () => {
    for (const { model, reference } of modes) {
      const view = viewOf(model, visibleNodes(model, new Set(), 'domains'));
      const layout = arrangeLayout(model, reference, view);
      const [a, b] = model.rootIds;
      if (a === undefined || b === undefined) throw new Error('roots');
      const onto = { ...rectIn(layout.absolute, b), ...rectIn(layout.absolute, a) };
      const broken: LayoutResult = {
        ...layout,
        rects: new Map(layout.rects).set(b, onto),
        absolute: new Map(layout.absolute).set(b, onto),
      };
      expect(violations(model, reference, layout, view)).toEqual([]);
      expect(violations(model, reference, broken, view)).toContain(`${a} overlaps ${b}`);
    }
  });
});

describe('arrangement keys and the cache', () => {
  it('names an arrangement by its closed groups and their sizes, per reference', () => {
    const [rows, flat] = modes;
    if (!rows || !flat) throw new Error('modes');
    const keyOf = (mode: Mode, collapsed: ReadonlySet<string>, level: LodLevel): string =>
      arrangeLayout(
        mode.model,
        mode.reference,
        viewOf(mode.model, visibleNodes(mode.model, collapsed, level)),
      ).key;
    const domains = keyOf(rows, new Set(), 'domains');
    const components = keyOf(rows, new Set(), 'components');
    expect(domains.startsWith(`${rows.reference.key}~`)).toBe(true);
    expect(domains).toMatch(/~[0-9a-f]{16}$/);
    expect(components).not.toBe(domains);
    // Every group collapsed at Everything draws what Domains draws.
    expect(keyOf(rows, new Set(groupIds(example)), 'detail')).toBe(domains);
    expect(keyOf(flat, new Set(), 'domains')).not.toBe(domains);

    const view = viewOf(example, visibleNodes(example, new Set(), 'domains'));
    const signature = arrangementSignature(example, rows.reference, view);
    expect(signature.split(' ')).toHaveLength(example.rootIds.length);
    for (const part of signature.split(' ')) expect(part).toMatch(/^[\w.-]+:\d+x\d+$/);
    expect(arrangementKey(rows.reference, signature)).toBe(domains);
  });

  it('keeps the arrangements of one reference, the least recently used going first', () => {
    const { model, reference } = withRows;
    const views = randomCases(model, 40, 4242)
      .map(({ level, collapsed }) => viewOf(model, visibleNodes(model, collapsed, level)))
      .filter((view) => arrangementSignature(model, reference, view) !== '');
    const distinct = [
      ...new Map(
        views.map((view) => [arrangementSignature(model, reference, view), view]),
      ).values(),
    ];
    const [view, ...others] = distinct;
    if (!view || others.length < 13) throw new Error('too few arrangements');
    const first = arrangedLayout(model, reference, view);
    // Eleven others in between: still remembered, and now the most recently used.
    for (const other of others.slice(0, 11)) arrangedLayout(model, reference, other);
    expect(arrangedLayout(model, reference, view)).toBe(first);
    // Twelve others in between: forgotten, and computed again.
    for (const other of others.slice(0, 12)) arrangedLayout(model, reference, other);
    const again = arrangedLayout(model, reference, view);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
    // Another reference object has arrangements of its own.
    expect(arrangedLayout(model, { ...reference }, view)).not.toBe(again);
  });

  it('does not change the reference', () => {
    const { model, reference } = withRows;
    const before = JSON.stringify([...reference.absolute, ...reference.rows]);
    arrangeLayout(model, reference, viewOf(model, visibleNodes(model, new Set(), 'domains')));
    expect(JSON.stringify([...reference.absolute, ...reference.rows])).toBe(before);
  });
});

describe('an arrangement as a layout', () => {
  it('takes moved positions like any layout', () => {
    for (const { model, reference } of modes) {
      const layout = arrangeLayout(
        model,
        reference,
        viewOf(model, visibleNodes(model, new Set(), 'components')),
      );
      const id = model.rootIds[0] ?? '';
      const moved = movedByHand(NO_HAND_OVERRIDES, model, layout, id, { x: 40, y: 30 }).positions;
      const was = rectIn(layout.rects, id);
      expect(moved.get(id)).toEqual({ x: was.x + 40, y: was.y + 30 });
      const applied = applyPositionOverrides(model, layout, moved);
      expect(rectIn(applied.absolute, id)).toEqual({
        ...rectIn(layout.absolute, id),
        x: was.x + 40,
        y: was.y + 30,
      });
    }
  });

  it('gives its visible rectangles and what the fit and the minimap take of it', () => {
    for (const { model, reference } of modes) {
      const visible = visibleNodes(model, new Set(), 'components');
      const layout = arrangeLayout(model, reference, viewOf(model, visible));
      const rects = visibleRects(layout, visible);
      expect([...rects.keys()]).toEqual([...model.nodes.keys()].filter((id) => visible.has(id)));
      for (const [id, rect] of rects) expect(rect).toBe(layout.absolute.get(id));

      const source = arrangedSourceNodes(model, layout, visible);
      const bands = layout.rows.length + (layout.unassignedArea ? 1 : 0);
      expect(source.slice(0, bands).every((node) => node.type === 'band')).toBe(true);
      expect(source.slice(bands).map((node) => node.id)).toEqual([...rects.keys()]);
      for (const node of source.slice(bands)) {
        const arch = nodeOf(model, node.id);
        expect(node.type).toBe(arch.childIds.length > 0 ? 'group' : 'leaf');
        expect(node.parentId).toBe(arch.parentId);
        expect(node.position).toEqual({
          x: rectIn(layout.rects, node.id).x,
          y: rectIn(layout.rects, node.id).y,
        });
      }
      const drawn = miniMapNodes(source).slice(bands);
      for (const node of drawn) expect(node.rect).toEqual(rects.get(node.id));
    }
  });

  it('gives the bands and the Unassigned area of a map with rows', async () => {
    const reference = await computeLayoutUncached(tiered);
    const visible = visibleNodes(tiered, new Set(), 'domains');
    const layout = arrangeLayout(tiered, reference, viewOf(tiered, visible));
    const bands = arrangedSourceNodes(tiered, layout, visible).filter((n) => n.type === 'band');
    expect(bands.map((n) => n.id)).toEqual([
      ...layout.rows.map((row) => `band:${row.id}`),
      'band:unassigned',
    ]);
    expect(bands.at(-1)).toMatchObject({ position: { x: layout.unassignedArea?.x, y: 0 } });
  });

  it('is drawn by buildFlow like any layout', () => {
    const { model, reference } = withRows;
    const collapsed = new Set<string>();
    const layout = arrangeLayout(
      model,
      reference,
      viewOf(model, visibleNodes(model, collapsed, 'domains')),
    );
    const flow = buildFlow(model, layout, { lodLevel: 'domains', compactCollapsed: true });
    const domains = flow.nodes.filter((n): n is ArchFlowNode => n.type === 'group');
    expect(domains.map((n) => n.id)).toEqual(model.rootIds);
  });
});
