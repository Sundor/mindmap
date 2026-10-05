// Things the user can switch while trying the map out: adjustable level-of-detail thresholds,
// closed groups drawn shrunk, and parallel edges showing all their labels.

import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import {
  DEFAULT_DISPLAY_SETTINGS,
  DISPLAY_SETTINGS_KEY,
  parseDisplaySettings,
  type DisplaySettings,
  readDisplaySettings,
  serializeDisplaySettings,
  writeDisplaySettings,
} from './displaySettings';
import {
  buildFlow,
  COMPACT_GROUP,
  compactGroupBox,
  compactGroupRect,
  compactGroupText,
  fitsCompact,
  flowEdgeLabel,
  type ArchFlowNode,
  type FlowGraph,
} from './flow';
import { computeLayoutUncached, type LayoutResult, type Rect } from './layout';
import { parseOk } from './layout/test-helpers';
import { estimateLineCount, estimateTextWidth } from './text';
import {
  LOD_CONFIG,
  LOD_THRESHOLD_KEYS,
  LOD_THRESHOLD_RANGE,
  lodConfigFromStored,
  lodForZoom,
  withLodThreshold,
} from './lod';
import type { ArchitectureModel } from './model';
import { parseArchitecture } from './parse';
import { groupIds } from './visibility';

function archNodes(flow: FlowGraph): ArchFlowNode[] {
  return flow.nodes.filter((n): n is ArchFlowNode => n.type !== 'band');
}

describe('withLodThreshold', () => {
  const rising = (config: typeof LOD_CONFIG) => {
    const h = config.hysteresis;
    const [a, b, c] = LOD_THRESHOLD_KEYS.map((key) => config[key]);
    if (a === undefined || b === undefined || c === undefined) throw new Error('thresholds');
    expect(a * (1 + h)).toBeLessThan(b * (1 - h));
    expect(b * (1 + h)).toBeLessThan(c * (1 - h));
    expect(a).toBeGreaterThanOrEqual(LOD_THRESHOLD_RANGE.min);
    expect(c).toBeLessThanOrEqual(LOD_THRESHOLD_RANGE.max);
  };

  it('sets one threshold and leaves the others alone when there is room', () => {
    const config = withLodThreshold(LOD_CONFIG, 'componentsZoom', 0.25);
    expect(config).toEqual({ ...LOD_CONFIG, componentsZoom: 0.25 });
    expect(lodForZoom(0.3, undefined, config)).toBe('components');
    expect(lodForZoom(0.3)).toBe('domains');
  });

  it('pushes the neighbours along to keep the order', () => {
    const up = withLodThreshold(LOD_CONFIG, 'componentsZoom', 2);
    expect(up.componentsZoom).toBe(2);
    expect(up.subcomponentsZoom).toBeGreaterThan(2);
    expect(up.detailZoom).toBeGreaterThan(up.subcomponentsZoom);
    rising(up);

    const down = withLodThreshold(LOD_CONFIG, 'detailZoom', 0.3);
    expect(down.detailZoom).toBe(0.3);
    expect(down.subcomponentsZoom).toBeLessThan(0.3);
    expect(down.componentsZoom).toBeLessThan(down.subcomponentsZoom);
    rising(down);
  });

  it('stays valid for any slider position of any threshold', () => {
    const { min, max, step } = LOD_THRESHOLD_RANGE;
    for (const key of LOD_THRESHOLD_KEYS) {
      let config = LOD_CONFIG;
      for (let value = min; value <= max + 1e-9; value += step * 3) {
        config = withLodThreshold(config, key, value);
        rising(config);
      }
      for (const value of [-1, 0, 100]) rising(withLodThreshold(LOD_CONFIG, key, value));
      expect(withLodThreshold(LOD_CONFIG, key, Number.NaN)).toBe(LOD_CONFIG);
    }
  });
});

describe('display settings', () => {
  it('round-trips through the stored text', () => {
    const settings: DisplaySettings = {
      lod: withLodThreshold(LOD_CONFIG, 'detailZoom', 2.5),
      compactCollapsed: true,
      showRows: false,
      showCompleted: false,
      storyMode: 'tasks',
      hiddenStates: ['Closed', 'Removed'],
      iteration: 'Shop\\Sprint 13',
      heat: true,
      progress: true,
      edgesOnDemand: true,
      colorBy: 'metric:churn',
    };
    expect(parseDisplaySettings(serializeDisplaySettings(settings))).toEqual(settings);
    expect(parseDisplaySettings(serializeDisplaySettings(DEFAULT_DISPLAY_SETTINGS))).toEqual(
      DEFAULT_DISPLAY_SETTINGS,
    );
  });

  it('keeps every setting of the thresholds that the sliders can produce', () => {
    // A threshold pushed along by its neighbour is `value * ratio`; pushed again on reading it
    // may differ in the last bit, which must not count as "out of order".
    const { min, max, step } = LOD_THRESHOLD_RANGE;
    for (const key of LOD_THRESHOLD_KEYS) {
      for (let value = min; value <= max + step / 2; value += step) {
        const set = withLodThreshold(LOD_CONFIG, key, Math.round(value * 100) / 100);
        const stored: unknown = JSON.parse(
          JSON.stringify(Object.fromEntries(LOD_THRESHOLD_KEYS.map((k) => [k, set[k]]))),
        );
        const read = lodConfigFromStored(stored);
        expect(LOD_THRESHOLD_KEYS.map((k) => read[k])).toEqual(
          LOD_THRESHOLD_KEYS.map((k) => set[k]),
        );
      }
    }
  });

  it('falls back to the defaults on anything invalid', () => {
    for (const text of [null, undefined, '', 'nope', '[]', '3', '{"lod":{"componentsZoom":1}}']) {
      expect(parseDisplaySettings(text)).toEqual(DEFAULT_DISPLAY_SETTINGS);
    }
    const disordered = { componentsZoom: 2, subcomponentsZoom: 1, detailZoom: 3 };
    expect(lodConfigFromStored(disordered)).toBe(LOD_CONFIG);
    expect(lodConfigFromStored({ ...disordered, componentsZoom: -1 })).toBe(LOD_CONFIG);
    expect(parseDisplaySettings('{"compactCollapsed":"yes"}').compactCollapsed).toBe(false);
  });

  it('shows stories by default and reads the work-item settings defensively', () => {
    expect(DEFAULT_DISPLAY_SETTINGS).toMatchObject({ storyMode: 'stories', hiddenStates: [] });
    expect(DEFAULT_DISPLAY_SETTINGS.iteration).toBeUndefined();
    const stored = parseDisplaySettings(
      '{"storyMode":"everything","hiddenStates":[" Closed ","Closed",3,"","Active"],"iteration":7}',
    );
    expect(stored.storyMode).toBe('stories');
    expect(stored.hiddenStates).toEqual(['Active', 'Closed']);
    expect('iteration' in stored).toBe(false);
    expect(parseDisplaySettings('{"storyMode":"off","hiddenStates":"Closed"}')).toMatchObject({
      storyMode: 'off',
      hiddenStates: [],
    });
    expect(parseDisplaySettings('{"iteration":"  "}').iteration).toBeUndefined();
    expect(parseDisplaySettings('{"iteration":" Sprint 1 "}').iteration).toBe('Sprint 1');
  });

  it('reads and writes through a storage, and survives one that throws or is missing', () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    const settings: DisplaySettings = { ...DEFAULT_DISPLAY_SETTINGS, compactCollapsed: true };
    writeDisplaySettings(storage, settings);
    expect(items.has(DISPLAY_SETTINGS_KEY)).toBe(true);
    expect(readDisplaySettings(storage)).toEqual(settings);

    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(readDisplaySettings(broken)).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(() => writeDisplaySettings(broken, settings)).not.toThrow();
    expect(readDisplaySettings(undefined)).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(() => writeDisplaySettings(undefined, settings)).not.toThrow();
  });
});

describe('compactGroupBox', () => {
  const c = COMPACT_GROUP;
  /** Height of a box with `nameLines` lines of name and `textLines` lines of child names. */
  const heightOf = (nameLines: number, textLines: number): number =>
    2 * c.border +
    c.headerTop +
    nameLines * c.nameLine +
    c.headerBottom +
    c.bodyTop +
    textLines * c.textLine +
    c.bodyBottom;
  const centredOn = (rect: Rect, full: Rect): void => {
    expect(rect.x + rect.width / 2).toBeCloseTo(full.x + full.width / 2, 0);
    expect(rect.y + rect.height / 2).toBeCloseTo(full.y + full.height / 2, 0);
  };
  const full = { x: 100, y: 50, width: 800, height: 600 };

  it('is centred on the full box and grows with the list of names, without a line cap', () => {
    const few = compactGroupBox(full, 'Group', ['One', 'Two']);
    const names = Array.from({ length: 30 }, (_, i) => `Component number ${i}`);
    const many = compactGroupBox(full, 'Group', names);
    for (const box of [few, many]) {
      expect(box.hidden).toBe(0);
      expect(box.rect.width).toBe(c.width);
      centredOn(box.rect, full);
    }
    expect(few.rect.height).toBe(heightOf(1, 1));
    // As many lines as the text needs in the room the list has, however many that is.
    const lines = estimateLineCount(
      compactGroupText(names),
      c.textSize,
      c.width - 2 * c.border - 2 * c.paddingX,
    );
    expect(lines).toBeGreaterThan(8);
    expect(many.rect.height).toBe(heightOf(1, lines));
    expect(compactGroupRect(full, 'Group', names)).toEqual(many.rect);
  });

  it('is wide enough for the name to stay on one line', () => {
    const name = 'Manufacturing Operations Warehouse';
    const box = compactGroupBox(full, name, ['One']);
    const room = box.rect.width - 2 * c.border - 2 * c.paddingX - c.chevron;
    expect(box.rect.width).toBeGreaterThan(c.width);
    expect(box.rect.width).toBeLessThanOrEqual(full.width);
    expect(estimateTextWidth(name, c.nameSize)).toBeLessThanOrEqual(room);
    expect(box.rect.height).toBe(heightOf(1, 1));
    centredOn(box.rect, full);
  });

  it('gets wider when the list is too tall for the full box at the preferred width', () => {
    const low = { x: 0, y: 0, width: 900, height: heightOf(1, 2) };
    const names = Array.from({ length: 8 }, (_, i) => `Component ${i}`);
    // Too tall at the preferred width...
    const lines = estimateLineCount(
      compactGroupText(names),
      c.textSize,
      c.width - 2 * c.border - 2 * c.paddingX,
    );
    expect(lines).toBeGreaterThan(2);
    // ...so the box is widened just far enough, and everything is listed.
    const box = compactGroupBox(low, 'Group', names);
    expect(box.hidden).toBe(0);
    expect(box.rect.width).toBeGreaterThan(c.width);
    expect(box.rect.width).toBeLessThan(low.width);
    expect(box.rect.height).toBeLessThanOrEqual(low.height);
    centredOn(box.rect, low);
  });

  it('falls back to the full box, ending the list with "+k more", when that is too small', () => {
    const small = { x: 10, y: 20, width: 260, height: heightOf(1, 2) };
    const names = Array.from({ length: 12 }, (_, i) => `Component ${i}`);
    const box = compactGroupBox(small, 'Group', names);
    expect(box.rect).toEqual(small);
    expect(box.hidden).toBeGreaterThan(0);
    expect(box.hidden).toBeLessThan(names.length);
    const text = compactGroupText(names, box.hidden);
    expect(text.endsWith(`+${box.hidden} more`)).toBe(true);
    expect(text.startsWith('Component 0')).toBe(true);
    const room = small.width - 2 * c.border - 2 * c.paddingX;
    expect(estimateLineCount(text, c.textSize, room)).toBeLessThanOrEqual(2);
    // One name more would not fit.
    expect(
      estimateLineCount(compactGroupText(names, box.hidden - 1), c.textSize, room),
    ).toBeGreaterThan(2);

    expect(fitsCompact(box, names)).toBe(true);
  });

  it('is not worth drawing shrunk when the full box cannot list even one name', () => {
    const tiny = { x: 0, y: 0, width: 120, height: 40 };
    const pair = ['A long list of names', 'and more'];
    expect(compactGroupBox(tiny, 'Group', pair)).toEqual({ rect: tiny, hidden: 2 });
    expect(fitsCompact(compactGroupBox(tiny, 'Group', pair), pair)).toBe(false);

    // A layout-sized box with a two-line name: one list line is left, too short for
    // "Coupon Editor · +2 more".
    const snug = { x: 0, y: 0, width: 224, height: 124 };
    const three = ['Coupon Editor', 'Version Store', 'Release Notes'];
    const all = compactGroupBox(snug, 'Configuration Manager', three);
    expect(all).toEqual({ rect: snug, hidden: 3 });
    expect(fitsCompact(all, three)).toBe(false);

    // A single child is never replaced by "+1 more".
    const one = ['Coupon Editor With A Long Name'];
    const single = compactGroupBox(snug, 'Configuration Manager', one);
    expect(single).toEqual({ rect: snug, hidden: 1 });
    expect(fitsCompact(single, one)).toBe(false);
    expect(fitsCompact(compactGroupBox(full, 'Group', one), one)).toBe(true);
  });

  it('lists the names with the dot kept on the line of the name before it', () => {
    expect(compactGroupText(['One', 'Two', 'Three'])).toBe('One\u00a0· Two\u00a0· Three');
    expect(compactGroupText(['One', 'Two', 'Three'], 2)).toBe('One\u00a0· +2 more');
    expect(compactGroupText(['One', 'Two'], 2)).toBe('+2 more');
    expect(compactGroupText([])).toBe('');
  });
});

describe('buildFlow with closed groups drawn shrunk (examples/architecture.yaml)', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  beforeAll(async () => {
    model = parseOk(exampleYaml);
    layout = await computeLayoutUncached(model);
  });

  it('changes nothing while no group is closed', () => {
    expect(buildFlow(model, layout, { compactCollapsed: true })).toEqual(
      buildFlow(model, layout, {}),
    );
  });

  it('shrinks exactly the closed groups, around the middle of their box', () => {
    const collapsedIds = new Set(groupIds(model).filter((id) => !id.includes('.')));
    const full = buildFlow(model, layout, { collapsedIds });
    const compact = buildFlow(model, layout, { collapsedIds, compactCollapsed: true });
    const fullById = new Map(archNodes(full).map((n) => [n.id, n]));
    expect(archNodes(compact).map((n) => n.id)).toEqual(archNodes(full).map((n) => n.id));
    let shrunk = 0;
    for (const node of archNodes(compact)) {
      const before = fullById.get(node.id);
      if (!before) throw new Error(node.id);
      expect(node.data.compact).toBe(node.data.collapsed);
      if (!node.data.compact) {
        expect(node.position).toEqual(before.position);
        expect(node.width).toBe(before.width);
        continue;
      }
      shrunk += 1;
      expect(node.width).toBeLessThanOrEqual(before.width);
      expect(node.height).toBeLessThanOrEqual(before.height);
      expect(node.style).toEqual({ width: node.width, height: node.height });
      expect(node.position.x + node.width / 2).toBeCloseTo(before.position.x + before.width / 2, 0);
      expect(node.position.y + node.height / 2).toBeCloseTo(
        before.position.y + before.height / 2,
        0,
      );
      expect(node.data.childNames).toEqual(
        model.nodes.get(node.id)?.childIds.map((id) => model.nodes.get(id)?.name),
      );
    }
    expect(shrunk).toBeGreaterThan(0);
    expect(archNodes(full).every((n) => !n.data.compact)).toBe(true);
    // Every group of the example has room for all its children's names.
    expect(archNodes(compact).every((n) => n.data.compactHidden === 0)).toBe(true);
  });

  it('keeps a closed group whose box cannot list a single child an ordinary collapsed one', () => {
    const [id] = model.rootIds;
    const whole = id === undefined ? undefined : layout.rects.get(id);
    if (id === undefined || !whole) throw new Error('no root');
    // The same layout, with the first domain squeezed to less than its name and one child need.
    const tiny = { ...whole, width: 120, height: 40 };
    const squeezed: LayoutResult = {
      ...layout,
      rects: new Map(layout.rects).set(id, tiny),
      absolute: new Map(layout.absolute).set(id, tiny),
    };
    const collapsedIds = new Set(model.rootIds);
    const flow = buildFlow(model, squeezed, { collapsedIds, compactCollapsed: true });
    const node = archNodes(flow).find((n) => n.id === id);
    if (!node) throw new Error(id);
    expect(node.data.collapsed).toBe(true);
    expect(node.data.compact).toBe(false);
    expect(node.data.compactHidden).toBe(0);
    expect({ ...node.position, width: node.width, height: node.height }).toEqual(tiny);
    // The other domains are shrunk as before.
    expect(archNodes(flow).filter((n) => n.data.compact).length).toBe(model.rootIds.length - 1);
  });

  it('attaches the edges to the shrunk boxes', () => {
    const collapsedIds = new Set(model.rootIds);
    const compact = buildFlow(model, layout, { collapsedIds, compactCollapsed: true });
    const boxes = new Map(
      archNodes(compact).map((n) => [
        n.id,
        { x: n.position.x, y: n.position.y, width: n.width, height: n.height },
      ]),
    );
    expect(compact.edges.length).toBeGreaterThan(0);
    for (const edge of compact.edges) {
      for (const [id, point] of [
        [edge.source, edge.data.curve.p0],
        [edge.target, edge.data.curve.p3],
      ] as const) {
        // Domains are top-level, so their flow position is the absolute one.
        const box = boxes.get(id);
        if (!box) throw new Error(id);
        expect(point.x).toBeGreaterThanOrEqual(box.x - 1);
        expect(point.x).toBeLessThanOrEqual(box.x + box.width + 1);
        expect(point.y).toBeGreaterThanOrEqual(box.y - 1);
        expect(point.y).toBeLessThanOrEqual(box.y + box.height + 1);
      }
    }
  });
});

describe('parallel edges', () => {
  const yaml = `
version: 1
domains:
  - id: a
    name: A
    components:
      - id: a.x
        name: X
      - id: a.y
        name: Y
  - id: b
    name: B
edges:
  - { id: e1, from: a.x, to: b, kind: dataflow, label: orders, protocol: AMQP }
  - { id: e2, from: a.x, to: b, kind: dataflow, label: invoices }
  - { id: e3, from: a.x, to: b, kind: dataflow }
  - { id: e4, from: a.y, to: b, kind: dataflow, label: other }
`;
  let model: ArchitectureModel;
  let layout: LayoutResult;
  beforeAll(async () => {
    const result = parseArchitecture(yaml);
    if (!result.model) throw new Error('model did not parse');
    model = result.model;
    layout = await computeLayoutUncached(model);
  });

  it('merge into one line that shows every label, one per line', () => {
    const flow = buildFlow(model, layout, {});
    const merged = flow.edges.find((e) => e.id === 'a.x>b:dataflow');
    expect(merged?.data.count).toBe(3);
    expect(merged?.data.labels).toEqual(['orders [AMQP]', 'invoices']);
    expect(merged && flowEdgeLabel(merged.data)).toBe('orders [AMQP]\ninvoices');
    const single = flow.edges.find((e) => e.id === 'a.y>b:dataflow');
    expect(single && flowEdgeLabel(single.data)).toBe('other');
  });

  it('show the count where edge labels are hidden, and when rolled up', () => {
    const components = buildFlow(model, layout, { lodLevel: 'components' });
    const merged = components.edges.find((e) => e.id === 'a.x>b:dataflow');
    expect(merged && flowEdgeLabel(merged.data)).toBe('×3');

    const rolled = buildFlow(model, layout, { collapsedIds: new Set(['a']) });
    const aggregate = rolled.edges.find((e) => e.id === 'a>b:dataflow');
    expect(aggregate?.data.count).toBe(4);
    expect(aggregate?.data.labels).toBeUndefined();
    expect(aggregate && flowEdgeLabel(aggregate.data)).toBe('×4');
  });

  it('without any label still show the count', () => {
    expect(flowEdgeLabel({ count: 2, labels: [], labelShown: true })).toBe('×2');
    expect(flowEdgeLabel({ count: 2, labelShown: true })).toBe('×2');
  });
});
