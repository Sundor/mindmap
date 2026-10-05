import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import { buildFlow } from './flow';
import { computeLayoutUncached, type LayoutResult } from './layout';
import { parseOk } from './layout/test-helpers';
import type { ArchitectureModel } from './model';
import {
  applyPositionOverrides,
  NO_POSITION_OVERRIDES,
  parsePositions,
  positionsStorageKey,
  readPositions,
  serializePositions,
  withNodeMoved,
  withoutRows,
  writePositions,
} from './positions';

let model: ArchitectureModel;
let layout: LayoutResult;
beforeAll(async () => {
  model = parseOk(exampleYaml);
  layout = await computeLayoutUncached(model);
});

describe('withoutRows', () => {
  it('keeps nodes and edges and drops every row', () => {
    const plain = withoutRows(model);
    expect(model.rows.length).toBeGreaterThan(0);
    expect(plain.rows).toEqual([]);
    expect([...plain.nodes.keys()]).toEqual([...model.nodes.keys()]);
    expect(plain.edges).toBe(model.edges);
    expect(plain.rootIds).toBe(model.rootIds);
    for (const node of plain.nodes.values()) {
      const original = model.nodes.get(node.id);
      expect(node.row).toBeUndefined();
      expect(node.effectiveRow).toBeUndefined();
      expect(node.rowRange).toBeUndefined();
      expect(node.name).toBe(original?.name);
      expect(node.parentId).toBe(original?.parentId);
      expect(node.childIds).toBe(original?.childIds);
      expect(node.description).toBe(original?.description);
    }
    expect(withoutRows(plain)).toBe(plain);
  });

  it('lays out as a plain graph: no bands, no side area, another layout key', async () => {
    const plain = await computeLayoutUncached(withoutRows(model));
    expect(layout.rows.length).toBeGreaterThan(0);
    expect(plain.rows).toEqual([]);
    expect(plain.unassignedArea).toBeUndefined();
    expect(plain.placedRow.size).toBe(0);
    expect(plain.key).not.toBe(layout.key);
    expect([...plain.rects.keys()]).toEqual([...layout.rects.keys()]);
    // The flow has no band nodes and every model node.
    const flow = buildFlow(withoutRows(model), plain, {});
    expect(flow.nodes.some((node) => node.type === 'band')).toBe(false);
    expect(flow.nodes).toHaveLength(model.nodes.size);
  });
});

describe('applyPositionOverrides', () => {
  const firstDomain = () => model.rootIds[0] ?? '';
  const firstChild = () => model.nodes.get(firstDomain())?.childIds[0] ?? '';

  it('returns the same layout when nothing moves', () => {
    expect(applyPositionOverrides(model, layout, NO_POSITION_OVERRIDES)).toBe(layout);
    expect(applyPositionOverrides(model, layout, new Map([['nope', { x: 1, y: 2 }]]))).toBe(layout);
    const rect = layout.rects.get(firstDomain());
    if (!rect) throw new Error('rect');
    const same = new Map([[firstDomain(), { x: rect.x, y: rect.y }]]);
    expect(applyPositionOverrides(model, layout, same)).toBe(layout);
  });

  it('moves a domain with everything inside it and nothing else', () => {
    const id = firstDomain();
    const rect = layout.rects.get(id);
    if (!rect) throw new Error('rect');
    const moved = applyPositionOverrides(
      model,
      layout,
      new Map([[id, { x: rect.x + 300, y: rect.y - 120 }]]),
    );
    expect(moved.key).toBe(layout.key);
    expect(moved.rows).toBe(layout.rows);
    for (const node of model.nodes.values()) {
      const before = layout.absolute.get(node.id);
      const after = moved.absolute.get(node.id);
      if (!before || !after) throw new Error(node.id);
      const inside = node.id === id || node.id.startsWith(`${id}.`);
      expect(after.x - before.x, node.id).toBe(inside ? 300 : 0);
      expect(after.y - before.y, node.id).toBe(inside ? -120 : 0);
      expect([after.width, after.height]).toEqual([before.width, before.height]);
      // Relative positions change for the moved node only.
      if (node.id !== id) expect(moved.rects.get(node.id)).toEqual(layout.rects.get(node.id));
    }
  });

  it('keeps a node inside its group and grows the bounds for a domain moved out', () => {
    const child = firstChild();
    const parent = layout.rects.get(firstDomain());
    const rect = layout.rects.get(child);
    if (!parent || !rect) throw new Error('rects');
    // A top-level node may leave the map, but only by the size of the map.
    const lost = applyPositionOverrides(
      model,
      layout,
      new Map([[firstDomain(), { x: 1e308, y: -1e308 }]]),
    );
    expect(lost.rects.get(firstDomain())).toMatchObject({
      x: 2 * layout.bounds.width,
      y: -layout.bounds.height,
    });
    expect(lost.bounds.width).toBeLessThanOrEqual(3 * layout.bounds.width + (parent.width ?? 0));
    const far = applyPositionOverrides(model, layout, new Map([[child, { x: 99999, y: -50 }]]));
    expect(far.rects.get(child)).toEqual({
      ...rect,
      x: Math.max(0, parent.width - rect.width),
      y: 0,
    });

    const out = applyPositionOverrides(
      model,
      layout,
      new Map([[firstDomain(), { x: layout.bounds.width + 500, y: layout.bounds.height + 40 }]]),
    );
    expect(out.bounds.width).toBe(layout.bounds.width + 500 + parent.width);
    expect(out.bounds.height).toBe(layout.bounds.height + 40 + parent.height);
  });

  it('feeds the flow: moved nodes and their edges follow, other nodes stay', () => {
    const id = firstDomain();
    const rect = layout.rects.get(id);
    if (!rect) throw new Error('rect');
    const moved = applyPositionOverrides(
      model,
      layout,
      new Map([[id, { x: rect.x + 400, y: rect.y }]]),
    );
    const before = new Map(buildFlow(model, layout, {}).nodes.map((n) => [n.id, n.position]));
    const flow = buildFlow(model, moved, {});
    for (const node of flow.nodes) {
      const was = before.get(node.id);
      expect(node.position, node.id).toEqual(node.id === id ? { x: rect.x + 400, y: rect.y } : was);
    }
    expect(flow.edges.length).toBeGreaterThan(0);
  });

  it('draggable only when the view says so, and never the bands', () => {
    const locked = buildFlow(model, layout, {});
    expect(locked.nodes.every((node) => !node.draggable)).toBe(true);
    const unlocked = buildFlow(model, layout, { draggable: true });
    for (const node of unlocked.nodes) expect(node.draggable).toBe(node.type !== 'band');
  });
});

describe('withNodeMoved', () => {
  it('adds the drop offset to the place in the layout, rounding, ignoring no-ops', () => {
    const id = model.rootIds[0] ?? '';
    const rect = layout.rects.get(id);
    if (!rect) throw new Error('rect');
    const once = withNodeMoved(NO_POSITION_OVERRIDES, layout, id, { x: 10.4, y: -3.6 });
    expect(once.get(id)).toEqual({ x: Math.round(rect.x + 10.4), y: Math.round(rect.y - 3.6) });
    expect(withNodeMoved(once, layout, id, { x: 0.2, y: -0.3 })).toBe(once);
    expect(withNodeMoved(once, layout, 'nope', { x: 5, y: 5 })).toBe(once);
    expect(withNodeMoved(once, layout, id, { x: Number.NaN, y: 1 })).toBe(once);
    // A second drag starts from the layout with the first one applied.
    const placed = applyPositionOverrides(model, layout, once);
    const twice = withNodeMoved(once, placed, id, { x: 5, y: 5 });
    expect(twice.get(id)).toEqual({
      x: Math.round(rect.x + 10.4) + 5,
      y: Math.round(rect.y - 3.6) + 5,
    });
  });
});

describe('stored positions', () => {
  it('round-trip, and anything invalid is dropped', () => {
    const overrides = new Map([
      ['a', { x: 1, y: 2 }],
      ['a.b', { x: -30, y: 4.5 }],
    ]);
    expect(parsePositions(serializePositions(overrides))).toEqual(overrides);
    for (const text of [null, undefined, '', 'nope', '[]', '3', '{"a":[1]}', '{"a":["1",2]}']) {
      expect(parsePositions(text)).toBe(NO_POSITION_OVERRIDES);
    }
    expect(parsePositions('{"a":[1,2],"b":"x","c":[1,null]}')).toEqual(
      new Map([['a', { x: 1, y: 2 }]]),
    );
  });

  it('are kept per layout key and survive a storage that throws or is missing', () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    const overrides = new Map([['a', { x: 1, y: 2 }]]);
    writePositions(storage, 'k1', overrides);
    expect(items.has(positionsStorageKey('k1'))).toBe(true);
    expect(readPositions(storage, 'k1')).toEqual(overrides);
    expect(readPositions(storage, 'k2')).toBe(NO_POSITION_OVERRIDES);
    writePositions(storage, 'k1', NO_POSITION_OVERRIDES);
    expect(readPositions(storage, 'k1')).toBe(NO_POSITION_OVERRIDES);

    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(readPositions(broken, 'k1')).toBe(NO_POSITION_OVERRIDES);
    expect(() => writePositions(broken, 'k1', overrides)).not.toThrow();
    expect(readPositions(undefined, 'k1')).toBe(NO_POSITION_OVERRIDES);
  });
});
