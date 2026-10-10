import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import { arrangedLayout, type ArrangeView } from './arrange';
import { buildFlow, closedGroupSize, type FlowView } from './flow';
import { computeLayoutUncached, type LayoutResult } from './layout';
import {
  GROUP_PADDING,
  HEADER_HEIGHT,
  groupMinHeight,
  groupMinWidth,
  groupPadding,
} from './layout/constants';
import { parseOk, rectOf } from './layout/test-helpers';
import type { Rect, Size } from './layout/types';
import type { ArchitectureModel, ArchNode } from './model';
import {
  allResizeLimits,
  appliedGrowth,
  applyHandOverrides,
  applyPositionOverrides,
  controlBounds,
  EDGES,
  growthBetween,
  handCountText,
  keyGrowth,
  movedByHand,
  NO_GROWTH,
  NO_HAND_OVERRIDES,
  NO_POSITION_OVERRIDES,
  NO_SIZE_OVERRIDES,
  parsePositions,
  parseSizes,
  positionsStorageKey,
  readHandOverrides,
  readPositions,
  RESIZE_CONTROLS,
  RESIZE_KEY_STEP,
  resizedByHand,
  resizeLimits,
  serializePositions,
  serializeSizes,
  sizeResetByHand,
  sizesStorageKey,
  withoutRows,
  writeHandOverrides,
  writePositions,
  type EdgeGrowth,
  type EdgeName,
  type HandOverrides,
  type Position,
  type PositionOverrides,
  type ResizeLimits,
} from './positions';
import { LOD_LEVELS, visibleNodes } from './visibility';
import { workItemContent } from './workItemContent';
import { buildWorkItemOverlay } from './workItemOverlay';
import { parseWorkItems } from './workitems';

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

// --- By hand: positions and sizes together ------------------------------------------------------

/** An arrangement before anything by hand, and the model it draws. */
interface Arrangement {
  readonly name: string;
  readonly model: ArchitectureModel;
  readonly base: LayoutResult;
  /** The content blocks `base` was computed with. */
  readonly content?: ReadonlyMap<string, Size>;
}

/** A closed-up arrangement with what it was made of. */
interface ClosedUp {
  readonly model: ArchitectureModel;
  readonly reference: LayoutResult;
  readonly view: ArrangeView;
  readonly arranged: LayoutResult;
}

/**
 * The example with rows, without rows, with work-item blocks on two groups and a leaf, and closed
 * up around its components drawn shrunk, with and without rows.
 */
const arrangements: Arrangement[] = [];
const closedUp: ClosedUp[] = [];

beforeAll(async () => {
  const plainModel = withoutRows(model);
  const plain = await computeLayoutUncached(plainModel);
  arrangements.push({ name: 'rows', model, base: layout });
  arrangements.push({ name: 'no rows', model: plainModel, base: plain });

  const domain = groupsOf(model).find((node) => node.parentId === undefined);
  const component = groupsOf(model).find((node) => node.parentId === domain?.id);
  const leaf = [...model.nodes.values()].find((node) => node.childIds.length === 0);
  if (!domain || !component || !leaf) throw new Error('the example has no group in a group');
  const content = new Map<string, Size>([
    [domain.id, { width: 320, height: 64 }],
    [component.id, { width: 280, height: 44 }],
    [leaf.id, { width: 200, height: 44 }],
  ]);
  arrangements.push({
    name: 'work-item blocks',
    model,
    base: await computeLayoutUncached(model, undefined, content),
    content,
  });

  const references = [
    { name: 'closed up, rows', drawn: model, reference: layout },
    { name: 'closed up, no rows', drawn: plainModel, reference: plain },
  ];
  for (const { name, drawn, reference } of references) {
    const view: ArrangeView = {
      visible: visibleNodes(drawn, new Set(), 'components'),
      closedSize: (node, full) => closedGroupSize(drawn, node, full, { compactCollapsed: true }),
    };
    const arranged = arrangedLayout(drawn, reference, view);
    if (arranged.key === reference.key) throw new Error(`${name}: nothing was closed up`);
    arrangements.push({ name, model: drawn, base: arranged });
    closedUp.push({ model: drawn, reference, view, arranged });
  }
});

/**
 * Arrangements with boxes that are not on whole pixels: the example with the stories and tasks
 * of the work-item file in the blocks, with and without rows. Arranged around those blocks,
 * some groups and the map itself come out a fraction of a pixel high.
 */
const offPixel: Arrangement[] = [];

beforeAll(async () => {
  const items = parseWorkItems(fixtureJson).items;
  for (const [name, drawn] of [
    ['tasks, rows', model],
    ['tasks, no rows', withoutRows(model)],
  ] as const) {
    const content = workItemContent(buildWorkItemOverlay(drawn, items), 'tasks');
    const a = { name, model: drawn, base: await computeLayoutUncached(drawn, undefined, content) };
    if (groupsOffPixel(a).length === 0) throw new Error(`${name}: every group is on whole pixels`);
    if (Number.isInteger(a.base.bounds.height)) throw new Error(`${name}: a map on whole pixels`);
    offPixel.push({ ...a, content });
  }
});

/** Takes the last bit off a length: what a sum of fractions can leave of a whole number. */
const A_HAIR_LESS = 1 - Number.EPSILON;

/** `of` with the box of `id` as wide as `width`. */
function withWidth(of: LayoutResult, id: string, width: number): LayoutResult {
  return {
    ...of,
    rects: new Map(of.rects).set(id, { ...relative(of, id), width }),
    absolute: new Map(of.absolute).set(id, { ...rectOf(of, id), width }),
  };
}

/** The groups of `a` whose children would still fit if the group had its smallest width. */
function groupsWithNarrowChildren(a: Arrangement): ArchNode[] {
  return groupsOf(a.model).filter((node) => {
    const inside = Math.max(
      ...node.childIds.map((id) => relative(a.base, id).x + relative(a.base, id).width),
    );
    return inside + GROUP_PADDING.right <= groupMinWidth(node);
  });
}

/** The groups of `a` whose box is not a whole number of pixels wide and high. */
function groupsOffPixel(a: Arrangement): ArchNode[] {
  return groupsOf(a.model).filter((node) => {
    const rect = relative(a.base, node.id);
    return !Number.isInteger(rect.width) || !Number.isInteger(rect.height);
  });
}

/** Random numbers in [0, 1) from `seed`, the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(random: () => number, from: readonly T[]): T {
  const item = from[Math.floor(random() * from.length)];
  if (item === undefined) throw new Error('nothing to pick from');
  return item;
}

function groupsOf(of: ArchitectureModel): ArchNode[] {
  return [...of.nodes.values()].filter((node) => node.childIds.length > 0);
}

function arrangementNamed(name: string): Arrangement {
  const found = arrangements.find((a) => a.name === name);
  if (!found) throw new Error(`no arrangement ${name}`);
  return found;
}

/** The box of `id` relative to its parent. */
function relative(of: LayoutResult, id: string): Rect {
  const rect = of.rects.get(id);
  if (!rect) throw new Error(`no rect for ${id}`);
  return rect;
}

function limitsFor(a: Arrangement, by: HandOverrides, id: string): ResizeLimits {
  const limits = resizeLimits(a.model, a.base, by, id, a.content);
  if (!limits) throw new Error(`no limits for ${id}`);
  return limits;
}

/**
 * The size no gesture takes the group `node` below: what its header and its work-item block
 * need, or the less the arrangement itself gave it.
 */
function smallestOf(a: Arrangement, node: ArchNode): Size {
  const was = relative(a.base, node.id);
  const reserved = a.base.content.get(node.id);
  const block = reserved && {
    width: a.content?.get(node.id)?.width ?? 0,
    height: reserved.height,
  };
  return {
    width: Math.min(was.width, groupMinWidth(node, block)),
    height: Math.min(was.height, groupMinHeight(block)),
  };
}

function drawnBy(a: Arrangement, by: HandOverrides): LayoutResult {
  return applyHandOverrides(a.model, a.base, by);
}

function resizedIn(
  a: Arrangement,
  by: HandOverrides,
  id: string,
  delta: Partial<EdgeGrowth>,
): HandOverrides {
  return resizedByHand(by, a.model, a.base, id, delta, a.content);
}

const EPS = 1e-6;
const EVERY_EDGE = (value: number): EdgeGrowth => ({
  left: value,
  top: value,
  right: value,
  bottom: value,
});

/** What is wrong with a layout: a box that is not finite, is empty, or is not inside its parent. */
function violations(of: ArchitectureModel, drawn: LayoutResult): string[] {
  const problems: string[] = [];
  for (const node of of.nodes.values()) {
    const rect = drawn.rects.get(node.id);
    const absolute = drawn.absolute.get(node.id);
    if (!rect && !absolute) continue;
    if (!rect || !absolute) {
      problems.push(`${node.id}: one of its two boxes is missing`);
      continue;
    }
    const numbers = [rect.x, rect.y, rect.width, rect.height, absolute.x, absolute.y];
    if (!numbers.every(Number.isFinite)) problems.push(`${node.id}: not finite`);
    if (!(rect.width > 0 && rect.height > 0)) problems.push(`${node.id}: empty`);
    if (absolute.width !== rect.width || absolute.height !== rect.height) {
      problems.push(`${node.id}: two sizes`);
    }
    const parent = node.parentId === undefined ? undefined : drawn.rects.get(node.parentId);
    const origin = (node.parentId === undefined
      ? undefined
      : drawn.absolute.get(node.parentId)) ?? { x: 0, y: 0 };
    if (
      Math.abs(absolute.x - origin.x - rect.x) > EPS ||
      Math.abs(absolute.y - origin.y - rect.y) > EPS
    ) {
      problems.push(`${node.id}: not where its parent and its offset put it`);
    }
    if (
      parent &&
      (rect.x < -EPS ||
        rect.y < -EPS ||
        rect.x + rect.width > parent.width + EPS ||
        rect.y + rect.height > parent.height + EPS)
    ) {
      problems.push(`${node.id}: ${JSON.stringify(rect)} outside ${parent.width}x${parent.height}`);
    }
  }
  return problems;
}

/**
 * The nodes whose box on the canvas is not the same in both layouts (another size, or more than
 * `tolerance` away), leaving out `except`.
 */
function movedNodes(
  of: ArchitectureModel,
  from: LayoutResult,
  to: LayoutResult,
  except: (id: string) => boolean,
  tolerance = EPS,
): string[] {
  const moved: string[] = [];
  for (const node of of.nodes.values()) {
    if (except(node.id)) continue;
    const a = from.absolute.get(node.id);
    const b = to.absolute.get(node.id);
    if (!a && !b) continue;
    if (
      !a ||
      !b ||
      Math.abs(a.x - b.x) > tolerance ||
      Math.abs(a.y - b.y) > tolerance ||
      a.width !== b.width ||
      a.height !== b.height
    ) {
      moved.push(`${node.id}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
  }
  return moved;
}

/**
 * The children of the group `node` that `drawn` has nearer to an edge of the group than the
 * padding, or than the arrangement already had them where that is less.
 */
function childrenTooNear(a: Arrangement, node: ArchNode, drawn: LayoutResult): string[] {
  const rect = relative(drawn, node.id);
  const was = relative(a.base, node.id);
  const pad = groupPadding(a.base.content.get(node.id));
  const problems: string[] = [];
  for (const child of node.childIds) {
    const now = drawn.rects.get(child);
    const before = a.base.rects.get(child);
    if (!now || !before) continue;
    const gaps = {
      left: [now.x, before.x],
      top: [now.y, before.y],
      right: [rect.width - now.x - now.width, was.width - before.x - before.width],
      bottom: [rect.height - now.y - now.height, was.height - before.y - before.height],
    };
    for (const edge of EDGES) {
      const [gap = 0, arranged = 0] = gaps[edge];
      if (gap < Math.min(pad[edge], arranged) - EPS) problems.push(`${child} at the ${edge}`);
    }
  }
  return problems;
}

/**
 * The rule for moved nodes written out on its own: what `applyHandOverrides` has to give, number
 * for number, when no size is stored.
 */
function movedOnly(
  of: ArchitectureModel,
  base: LayoutResult,
  overrides: PositionOverrides,
): LayoutResult {
  const within = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), Math.max(min, max));
  if (overrides.size === 0) return base;
  const rects = new Map<string, Rect>();
  const absolute = new Map<string, Rect>();
  let moved = false;
  let { width, height } = base.bounds;
  for (const node of of.nodes.values()) {
    const rect = base.rects.get(node.id);
    if (!rect) continue;
    const parentRect = node.parentId === undefined ? undefined : rects.get(node.parentId);
    const parentAbsolute = node.parentId === undefined ? undefined : absolute.get(node.parentId);
    const override = overrides.get(node.id);
    let { x, y } = rect;
    if (override && Number.isFinite(override.x) && Number.isFinite(override.y)) {
      x = Math.round(override.x);
      y = Math.round(override.y);
      if (parentRect) {
        x = within(x, 0, parentRect.width - rect.width);
        y = within(y, 0, parentRect.height - rect.height);
      } else {
        x = within(x, -base.bounds.width, 2 * base.bounds.width);
        y = within(y, -base.bounds.height, 2 * base.bounds.height);
      }
      if (x !== rect.x || y !== rect.y) moved = true;
    }
    const placed = { x, y, width: rect.width, height: rect.height };
    rects.set(node.id, placed);
    const origin = parentAbsolute ?? { x: 0, y: 0 };
    const placedAbsolute = { ...placed, x: origin.x + x, y: origin.y + y };
    absolute.set(node.id, placedAbsolute);
    width = Math.max(width, placedAbsolute.x + placedAbsolute.width);
    height = Math.max(height, placedAbsolute.y + placedAbsolute.height);
  }
  if (!moved) return base;
  return { ...base, rects, absolute, bounds: { width, height } };
}

describe('applyHandOverrides', () => {
  it('with positions alone gives what the rule for moved nodes gives, number for number', () => {
    for (const a of arrangements) {
      const random = seeded(11);
      const ids = [...a.base.rects.keys()];
      let changed = 0;
      let unchanged = 0;
      for (let run = 0; run < 300; run++) {
        const positions = new Map<string, Position>();
        const count = Math.floor(random() * 6);
        for (let i = 0; i < count; i++) {
          const id = pick(random, ids);
          const rect = relative(a.base, id);
          // In reach, far out, or not a number; a fraction now and then.
          const reach = (): number => {
            const kind = random();
            return kind < 0.2 ? 1e5 : kind < 0.3 ? Number.NaN : 300;
          };
          positions.set(id, {
            x: rect.x + (random() - 0.5) * reach() + (random() < 0.3 ? 0.4 : 0),
            y: rect.y + (random() - 0.5) * reach(),
          });
        }
        if (random() < 0.1) positions.set('nope', { x: 1, y: 2 });
        const expected = movedOnly(a.model, a.base, positions);
        if (expected === a.base) unchanged += 1;
        else changed += 1;
        for (const got of [
          applyHandOverrides(a.model, a.base, { positions, sizes: NO_SIZE_OVERRIDES }),
          applyPositionOverrides(a.model, a.base, positions),
        ]) {
          if (expected === a.base) {
            expect(got, a.name).toBe(a.base);
            continue;
          }
          expect([...got.rects], a.name).toEqual([...expected.rects]);
          expect([...got.absolute], a.name).toEqual([...expected.absolute]);
          expect(got.bounds, a.name).toEqual(expected.bounds);
          expect(got.content).toBe(a.base.content);
          expect(got.rows).toBe(a.base.rows);
          expect(got.key).toBe(a.base.key);
        }
      }
      expect(changed, a.name).toBeGreaterThan(100);
      expect(unchanged, a.name).toBeGreaterThan(10);
    }
  });

  it('whatever is stored: every node inside its parent, no box empty or not finite, leaves at their size', () => {
    for (const a of arrangements) {
      const random = seeded(23);
      const ids = [...a.base.rects.keys()];
      const leaves = new Set(
        [...a.model.nodes.values()].filter((n) => n.childIds.length === 0).map((n) => n.id),
      );
      /** A number as a stored entry may hold it: near, far out, the largest there is, or none. */
      const stored = (): number => {
        const kind = random();
        if (kind < 0.05) return Number.NaN;
        if (kind < 0.08) return random() < 0.5 ? Infinity : -Infinity;
        if (kind < 0.12) return random() < 0.5 ? Number.MAX_VALUE : -Number.MAX_VALUE;
        return (random() - 0.5) * (kind < 0.4 ? 1e6 : 400);
      };
      const views: FlowView[] = LOD_LEVELS.flatMap((lodLevel) =>
        [false, true].map((compactCollapsed) => ({ lodLevel, compactCollapsed })),
      );
      let resized = 0;
      for (let run = 0; run < 400; run++) {
        const positions = new Map<string, Position>();
        const sizes = new Map<string, EdgeGrowth>();
        const count = Math.floor(random() * 8);
        for (let i = 0; i < count; i++) {
          const id = random() < 0.05 ? 'nope' : pick(random, ids);
          if (random() < 0.5) {
            const rect = a.base.rects.get(id) ?? { x: 0, y: 0 };
            positions.set(id, { x: rect.x + stored(), y: rect.y + stored() });
          }
          if (random() < 0.7) {
            sizes.set(id, { left: stored(), top: stored(), right: stored(), bottom: stored() });
          }
        }
        const by = { positions, sizes };
        const out = applyHandOverrides(a.model, a.base, by);
        const problems = violations(a.model, out);
        for (const [id, was] of a.base.rects) {
          const rect = relative(out, id);
          if (leaves.has(id) && (rect.width !== was.width || rect.height !== was.height)) {
            problems.push(`${id}: a leaf of another size`);
          }
          const block = out.content.get(id);
          if (block && block.width !== rect.width) problems.push(`${id}: block of another width`);
          if (rect.width !== was.width || rect.height !== was.height) resized += 1;
          // A group keeps its header, unless the arrangement itself gave it less.
          const node = a.model.nodes.get(id);
          if (!node || leaves.has(id)) continue;
          const reserved = a.base.content.get(id);
          if (
            rect.width < Math.min(was.width, groupMinWidth(node)) ||
            rect.height < Math.min(was.height, groupMinHeight(reserved))
          ) {
            problems.push(`${id}: ${rect.width}x${rect.height} is less than its header needs`);
          }
        }
        expect(problems, `${a.name}, run ${run}`).toEqual([]);
        expect([...out.rects.keys()]).toEqual([...a.base.rects.keys()]);
        expect([...out.content.keys()]).toEqual([...a.base.content.keys()]);
        // The bounds grow, never shrink, and never beyond what the limits of a top-level box allow.
        expect(out.bounds.width).toBeGreaterThanOrEqual(a.base.bounds.width);
        expect(out.bounds.height).toBeGreaterThanOrEqual(a.base.bounds.height);
        expect(out.bounds.width).toBeLessThanOrEqual(5 * a.base.bounds.width);
        expect(out.bounds.height).toBeLessThanOrEqual(5 * a.base.bounds.height);
        // Nothing else is another object.
        expect(out.key).toBe(a.base.key);
        expect(out.rows).toBe(a.base.rows);
        expect(out.unassignedArea).toBe(a.base.unassignedArea);
        expect(out.placedRow).toBe(a.base.placedRow);
        expect(out.rowOf).toBe(a.base.rowOf);
        expect(out.gutterWidth).toBe(a.base.gutterWidth);
        // The same input gives the same output, also after a round trip through the stored text.
        const again = applyHandOverrides(a.model, a.base, by);
        const reread = applyHandOverrides(a.model, a.base, {
          positions: parsePositions(serializePositions(positions)),
          sizes: parseSizes(serializeSizes(sizes)),
        });
        for (const other of [again, reread]) {
          expect([...other.rects]).toEqual([...out.rects]);
          expect([...other.absolute]).toEqual([...out.absolute]);
          expect([...other.content]).toEqual([...out.content]);
          expect(other.bounds).toEqual(out.bounds);
        }
        // It can be drawn: at each level, closed groups at their full box and shrunk, in turn.
        const view = views[run % views.length];
        expect(() => buildFlow(a.model, out, view), `${a.name}, run ${run}`).not.toThrow();
      }
      expect(resized, a.name).toBeGreaterThan(100);
    }
  }, 60_000);

  it('gives the layout itself when nothing by hand takes effect', () => {
    for (const a of arrangements) {
      const [group] = groupsOf(a.model);
      const leaf = [...a.model.nodes.values()].find((node) => node.childIds.length === 0);
      if (!group || !leaf) throw new Error('no group, no leaf');
      const rect = relative(a.base, group.id);
      const nothing: HandOverrides = {
        positions: new Map([
          ['nope', { x: 1, y: 2 }],
          [group.id, { x: rect.x, y: rect.y }],
        ]),
        sizes: new Map([
          ['nope', EVERY_EDGE(40)],
          // A leaf has no size of its own; an entry that is not finite or all zero counts as none.
          [leaf.id, EVERY_EDGE(40)],
          [group.id, { ...NO_GROWTH, right: Number.NaN }],
        ]),
      };
      expect(applyHandOverrides(a.model, a.base, NO_HAND_OVERRIDES)).toBe(a.base);
      expect(applyHandOverrides(a.model, a.base, nothing)).toBe(a.base);
      expect(appliedGrowth(a.model, a.base, nothing).size).toBe(0);
      const zero = { positions: NO_POSITION_OVERRIDES, sizes: new Map([[group.id, NO_GROWTH]]) };
      expect(applyHandOverrides(a.model, a.base, zero)).toBe(a.base);
    }
  });

  it('widens the work-item block of a resized group and of no other node', () => {
    const a = arrangementNamed('work-item blocks');
    const withBlock = groupsOf(a.model).filter((node) => a.base.content.has(node.id));
    expect(withBlock.length).toBe(2);
    for (const node of withBlock) {
      const limits = limitsFor(a, NO_HAND_OVERRIDES, node.id);
      const edge = limits.outward.right > 0 ? 'right' : 'left';
      expect(limits.outward[edge]).toBeGreaterThan(0);
      const by = resizedIn(a, NO_HAND_OVERRIDES, node.id, { [edge]: 1e9 });
      const out = drawnBy(a, by);
      const block = out.content.get(node.id);
      const was = a.base.content.get(node.id);
      if (!block || !was) throw new Error('block');
      expect(block).toEqual({ ...was, width: was.width + limits.outward[edge] });
      expect(block.width).toBe(relative(out, node.id).width);
      for (const [id, other] of a.base.content) {
        if (id !== node.id) expect(out.content.get(id)).toBe(other);
      }
      // A group that only moves keeps the blocks of the layout as they are.
      const moved = movedByHand(NO_HAND_OVERRIDES, a.model, a.base, node.id, { x: 0, y: 3 });
      expect(drawnBy(a, moved).content).toBe(a.base.content);
    }
  });

  it('draws a size stored larger than the parent as large as the parent: what the right / bottom edge grew gives way first', () => {
    for (const a of arrangements) {
      const group = groupsOf(a.model).find((node) => node.parentId !== undefined);
      if (!group || group.parentId === undefined) throw new Error('no group in a group');
      const was = relative(a.base, group.id);
      const parent = relative(a.base, group.parentId);
      const across = parent.width - was.width;
      const down = parent.height - was.height;
      expect(Math.min(across, down), a.name).toBeGreaterThan(0);
      const cases: [stored: EdgeGrowth, drawn: EdgeGrowth][] = [
        [EVERY_EDGE(1e6), { left: across, top: down, right: 0, bottom: 0 }],
        [
          { left: 0, top: 0, right: 1e6, bottom: 1e6 },
          { left: 0, top: 0, right: across, bottom: down },
        ],
        // An edge that was pulled in stays pulled in: the other one takes the whole parent.
        [
          { left: 1e6, top: 1e6, right: -8, bottom: -8 },
          { left: across + 8, top: down + 8, right: -8, bottom: -8 },
        ],
        [
          { left: -8, top: -8, right: 1e6, bottom: 1e6 },
          { left: -8, top: -8, right: across + 8, bottom: down + 8 },
        ],
      ];
      for (const [stored, drawn] of cases) {
        const where = `${a.name}: ${JSON.stringify(stored)}`;
        const by = { positions: NO_POSITION_OVERRIDES, sizes: new Map([[group.id, stored]]) };
        const out = drawnBy(a, by);
        expect(relative(out, group.id), where).toEqual({
          x: 0,
          y: 0,
          width: parent.width,
          height: parent.height,
        });
        expect(relative(out, group.parentId), where).toEqual(parent);
        expect(violations(a.model, out), where).toEqual([]);
        const applied = appliedGrowth(a.model, a.base, by).get(group.id);
        if (!applied) throw new Error(`${where}: not resized`);
        for (const edge of EDGES)
          expect(applied[edge], `${where}, ${edge}`).toBeCloseTo(drawn[edge], 6);
      }
    }
  });
});

describe('resizing a group by hand', () => {
  it('growing any edge of any group as far as it goes: everything else stays where it is', () => {
    let grownEdges = 0;
    for (const a of [...arrangements, ...offPixel]) {
      for (const node of groupsOf(a.model)) {
        for (const edge of EDGES) {
          const grown = limitsFor(a, NO_HAND_OVERRIDES, node.id).outward[edge];
          const by = resizedIn(a, NO_HAND_OVERRIDES, node.id, { [edge]: 1e9 });
          if (grown === 0) {
            expect(by).toBe(NO_HAND_OVERRIDES);
            continue;
          }
          grownEdges += 1;
          const only = { ...NO_GROWTH, [edge]: grown };
          expect(by.sizes.get(node.id)).toEqual(only);
          expect(by.sizes.size).toBe(1);
          expect(by.positions).toBe(NO_POSITION_OVERRIDES);
          const out = drawnBy(a, by);
          expect(violations(a.model, out)).toEqual([]);
          const moved = growthBetween(rectOf(a.base, node.id), rectOf(out, node.id));
          for (const name of EDGES) expect(moved[name]).toBeCloseTo(only[name], 6);
          expect(
            movedNodes(a.model, a.base, out, (id) => id === node.id),
            `${a.name}: ${node.id} ${edge}`,
          ).toEqual([]);
          expect(out.rows).toBe(a.base.rows);
          expect(out.key).toBe(a.base.key);
          expect(appliedGrowth(a.model, a.base, by)).toEqual(new Map([[node.id, only]]));
          // And back: the entry is gone and the layout is the very same object.
          const back = sizeResetByHand(by, a.model, a.base, node.id, a.content);
          expect(back.sizes).toBe(NO_SIZE_OVERRIDES);
          expect(back.positions).toBe(by.positions);
          expect(drawnBy(a, back)).toBe(a.base);
        }
      }
    }
    expect(grownEdges).toBeGreaterThan(100);
  });

  it('a box that is not on whole pixels: any edge moved any distance is stored and drawn in whole pixels, and goes back in one step', () => {
    for (const a of offPixel) {
      let tried = 0;
      for (const node of groupsOffPixel(a)) {
        const limits = limitsFor(a, NO_HAND_OVERRIDES, node.id);
        const problems: string[] = [];
        for (const edge of EDGES) {
          const furthest = Math.min(600, limits.outward[edge]);
          for (let amount = -limits.inward[edge]; amount <= furthest; amount++) {
            if (amount === 0) continue;
            tried += 1;
            const by = resizedIn(a, NO_HAND_OVERRIDES, node.id, { [edge]: amount });
            const stored = by.sizes.get(node.id);
            const drawn = appliedGrowth(a.model, a.base, by).get(node.id);
            const asAsked =
              stored !== undefined &&
              drawn !== undefined &&
              EDGES.every(
                (name) =>
                  stored[name] === (name === edge ? amount : 0) && drawn[name] === stored[name],
              );
            if (!asAsked) {
              problems.push(
                `${edge} ${amount}: ${JSON.stringify(stored)} is drawn ${JSON.stringify(drawn)}`,
              );
            }
            // A change that moves no edge is none: nothing to store, nothing to draw again.
            if (resizedIn(a, by, node.id, {}) !== by) {
              problems.push(`${edge} ${amount}: not settled`);
            }
            const back = sizeResetByHand(by, a.model, a.base, node.id, a.content);
            if (back.sizes !== NO_SIZE_OVERRIDES || drawnBy(a, back) !== a.base) {
              problems.push(`${edge} ${amount}: back leaves ${serializeSizes(back.sizes)}`);
            }
          }
        }
        expect(problems, `${a.name}: ${node.id}`).toEqual([]);
      }
      expect(tried, a.name).toBeGreaterThan(1000);
    }
  });

  it('a size stored beyond what fits is drawn cut, at a fraction of a pixel too, and a change by hand stores whole pixels', () => {
    const selections: (readonly EdgeName[])[] = [EDGES, ['left'], ['top'], ['right'], ['bottom']];
    // An edge that is not moved is at 0, not at the -0 a rounded fraction can be.
    const whole = (value: number): boolean => Number.isInteger(value) && !Object.is(value, -0);
    for (const a of offPixel) {
      let cutToFraction = 0;
      for (const node of groupsOf(a.model)) {
        const problems: string[] = [];
        for (const far of [1e7, -1e7]) {
          for (const edges of selections) {
            const size = { ...NO_GROWTH, ...Object.fromEntries(edges.map((edge) => [edge, far])) };
            const stored: HandOverrides = {
              positions: NO_POSITION_OVERRIDES,
              sizes: new Map([[node.id, size]]),
            };
            const drawn = appliedGrowth(a.model, a.base, stored).get(node.id);
            if (drawn && !EDGES.every((edge) => Number.isInteger(drawn[edge]))) cutToFraction += 1;
            const changes = {
              'no edge moved': resizedIn(a, stored, node.id, {}),
              'a step': resizedIn(a, stored, node.id, { right: RESIZE_KEY_STEP }),
              'taken back': sizeResetByHand(stored, a.model, a.base, node.id, a.content),
            };
            for (const [change, by] of Object.entries(changes)) {
              const next = by.sizes.get(node.id);
              if (next && !EDGES.every((edge) => whole(next[edge]))) {
                problems.push(`${JSON.stringify(size)}, ${change}: ${JSON.stringify(next)}`);
              }
              // What a change left, a change that moves no edge leaves as it is.
              if (resizedIn(a, by, node.id, {}) !== by) {
                problems.push(`${JSON.stringify(size)}, ${change}: not settled`);
              }
            }
          }
        }
        expect(problems, `${a.name}: ${node.id}`).toEqual([]);
      }
      expect(cutToFraction, a.name).toBeGreaterThan(0);
    }
  });

  it('pulled in without end it stops at the padding around its children, or at what the arrangement left', () => {
    for (const a of arrangements) {
      for (const node of groupsOf(a.model)) {
        // Room first, so that there is something to take back.
        const roomy = resizedIn(a, NO_HAND_OVERRIDES, node.id, EVERY_EDGE(40));
        const by = resizedIn(a, roomy, node.id, EVERY_EDGE(-1e9));
        const out = drawnBy(a, by);
        const rect = relative(out, node.id);
        const was = relative(a.base, node.id);
        expect(childrenTooNear(a, node, out), `${a.name}: ${node.id}`).toEqual([]);
        expect(rect.width).toBeLessThanOrEqual(was.width + EPS);
        expect(rect.height).toBeLessThanOrEqual(was.height + EPS);
        const smallest = smallestOf(a, node);
        expect(rect.width).toBeGreaterThanOrEqual(smallest.width - EPS);
        expect(rect.height).toBeGreaterThanOrEqual(smallest.height - EPS);
        expect(limitsFor(a, by, node.id).inward, `${a.name}: ${node.id}`).toEqual(NO_GROWTH);
        expect(resizedIn(a, by, node.id, EVERY_EDGE(-1e9))).toBe(by);
        expect(movedNodes(a.model, a.base, out, (id) => id === node.id)).toEqual([]);
        expect(violations(a.model, out)).toEqual([]);
      }
    }
  });

  it('an edge moved outward lets the opposite one in by as much, and the size goes back in one step', () => {
    const opposite = [
      ['left', 'right'],
      ['right', 'left'],
      ['top', 'bottom'],
      ['bottom', 'top'],
    ] as const;
    let shifted = 0;
    let beyond = 0;
    let tight = 0;
    for (const a of arrangements) {
      for (const node of groupsOf(a.model)) {
        for (const [grow, pull] of opposite) {
          const where = `${a.name}: ${node.id}, ${grow} out and ${pull} in`;
          const fresh = limitsFor(a, NO_HAND_OVERRIDES, node.id);
          const room = Math.min(40, fresh.outward[grow]);
          if (room === 0) continue;
          const grown = resizedIn(a, NO_HAND_OVERRIDES, node.id, { [grow]: room });
          const by = resizedIn(a, grown, node.id, { [pull]: -room });
          const pulled = -(by.sizes.get(node.id)?.[pull] ?? 0);
          // Children at the padding of that edge: it cannot come in at all.
          if (pulled === 0) continue;
          shifted += 1;
          expect(by.sizes.get(node.id), where).toEqual({
            ...NO_GROWTH,
            [grow]: room,
            [pull]: -pulled,
          });
          // Both edges in one change give the same box as one after the other.
          const atOnce = resizedIn(a, NO_HAND_OVERRIDES, node.id, { [grow]: room, [pull]: -room });
          expect(atOnce.sizes, where).toEqual(by.sizes);
          const out = drawnBy(a, by);
          expect(violations(a.model, out), where).toEqual([]);
          expect(childrenTooNear(a, node, out), where).toEqual([]);
          expect(
            movedNodes(a.model, a.base, out, (id) => id === node.id),
            where,
          ).toEqual([]);
          // Further in than the edge goes alone: only where the box alone had less to give.
          const length = grow === 'left' || grow === 'right' ? 'width' : 'height';
          const smallest = smallestOf(a, node);
          expect(relative(out, node.id)[length], where).toBeGreaterThanOrEqual(smallest[length]);
          if (pulled > fresh.inward[pull]) {
            beyond += 1;
            expect(relative(a.base, node.id)[length] - smallest[length], where).toBeLessThan(
              pulled,
            );
          }
          // Back takes the two edges opposite ways at once, also where the box has nothing to
          // give: the entry is gone and the layout is the very same object.
          if (relative(out, node.id)[length] - smallest[length] < room) tight += 1;
          const back = sizeResetByHand(by, a.model, a.base, node.id, a.content);
          expect(back.sizes, where).toBe(NO_SIZE_OVERRIDES);
          expect(drawnBy(a, back), where).toBe(a.base);
        }
      }
    }
    expect(shifted).toBeGreaterThan(15);
    expect(beyond).toBeGreaterThan(0);
    expect(tight).toBeGreaterThan(0);
  });

  it('a top-level group grows by the size of the map on each side and no further', () => {
    // Also where the map is a fraction of a pixel high: the whole pixels of it.
    for (const a of [...arrangements, ...offPixel]) {
      const whole = (value: number): number => Math.floor(value + EPS);
      const most = {
        left: whole(a.base.bounds.width),
        top: whole(a.base.bounds.height),
        right: whole(a.base.bounds.width),
        bottom: whole(a.base.bounds.height),
      };
      for (const node of groupsOf(a.model).filter((n) => n.parentId === undefined)) {
        let by: HandOverrides = NO_HAND_OVERRIDES;
        let steps = 0;
        // It stops by itself, long before this many rounds.
        while (steps < 100) {
          const next = resizedIn(a, by, node.id, EVERY_EDGE(1000));
          if (next === by) break;
          by = next;
          steps += 1;
        }
        expect(steps).toBe(Math.ceil(Math.max(most.left, most.top) / 1000));
        expect(by.sizes.get(node.id)).toEqual(most);
        expect(limitsFor(a, by, node.id).outward).toEqual(NO_GROWTH);
        const out = drawnBy(a, by);
        const grown = growthBetween(rectOf(a.base, node.id), rectOf(out, node.id));
        for (const edge of EDGES) expect(grown[edge]).toBeCloseTo(most[edge], 6);
        expect(movedNodes(a.model, a.base, out, (id) => id === node.id)).toEqual([]);
        // A stored size beyond that is drawn at that, and goes back like it.
        const beyond = { positions: by.positions, sizes: new Map([[node.id, EVERY_EDGE(1e7)]]) };
        expect([...drawnBy(a, beyond).rects]).toEqual([...out.rects]);
        expect(appliedGrowth(a.model, a.base, beyond)).toEqual(by.sizes);
        const back = sizeResetByHand(beyond, a.model, a.base, node.id, a.content);
        expect(back.sizes, `${a.name}: ${node.id}`).toBe(NO_SIZE_OVERRIDES);
      }
    }
  });

  it('a group in a group stops at the border of its parent and below the title bar of its parent', () => {
    let nested = 0;
    for (const a of arrangements) {
      for (const node of groupsOf(a.model)) {
        if (node.parentId === undefined) continue;
        nested += 1;
        const by = resizedIn(a, NO_HAND_OVERRIDES, node.id, EVERY_EDGE(1e9));
        const out = drawnBy(a, by);
        const rect = relative(out, node.id);
        const parent = relative(out, node.parentId);
        const was = relative(a.base, node.id);
        // The title bar of the parent and its own work items stay free; a box that the
        // arrangement put higher stays where it was.
        const top = Math.min(
          was.y,
          HEADER_HEIGHT + (a.base.content.get(node.parentId)?.height ?? 0),
        );
        expect(parent).toEqual(relative(a.base, node.parentId));
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x).toBeLessThan(1);
        expect(rect.y).toBeGreaterThanOrEqual(top - EPS);
        expect(rect.y).toBeLessThan(top + 1);
        expect(parent.width - rect.x - rect.width).toBeGreaterThanOrEqual(-EPS);
        expect(parent.width - rect.x - rect.width).toBeLessThan(1);
        expect(parent.height - rect.y - rect.height).toBeGreaterThanOrEqual(-EPS);
        expect(parent.height - rect.y - rect.height).toBeLessThan(1);
        expect(limitsFor(a, by, node.id).outward).toEqual(NO_GROWTH);
        expect(movedNodes(a.model, a.base, out, (id) => id === node.id)).toEqual([]);
      }
    }
    expect(nested).toBeGreaterThan(20);
  });

  it('a group grown to both borders of a parent that a sum of fractions left a hair narrower is drawn as stored', () => {
    const a = arrangementNamed('rows');
    let filled = 0;
    for (const node of groupsOf(a.model)) {
      if (node.parentId === undefined) continue;
      const base = withWidth(
        a.base,
        node.parentId,
        relative(a.base, node.parentId).width * A_HAIR_LESS,
      );
      const parent = relative(base, node.parentId);
      const was = relative(base, node.id);
      // The whole pixels to both borders are a hair more than there is.
      const room = { left: was.x, right: Math.round(parent.width - was.x - was.width) };
      if (room.left === 0 || room.right === 0) continue;
      expect(was.width + room.left + room.right).toBeGreaterThan(parent.width);
      filled += 1;
      const by = resizedByHand(NO_HAND_OVERRIDES, a.model, base, node.id, {
        left: 1e9,
        right: 1e9,
      });
      expect(by.sizes.get(node.id), node.id).toEqual({ ...NO_GROWTH, ...room });
      expect(appliedGrowth(a.model, base, by), node.id).toEqual(by.sizes);
      const drawn = applyHandOverrides(a.model, base, by);
      expect(relative(drawn, node.id), node.id).toEqual({ ...was, x: 0, width: parent.width });
      expect(resizedByHand(by, a.model, base, node.id, {}), node.id).toBe(by);
      const back = sizeResetByHand(by, a.model, base, node.id);
      expect(back.sizes, node.id).toBe(NO_SIZE_OVERRIDES);
      expect(applyHandOverrides(a.model, base, back), node.id).toBe(base);
    }
    expect(filled).toBeGreaterThan(5);
  });

  it('a group that a sum of fractions left a hair narrower than whole pixels is drawn as stored when it is pulled in to its smallest width', () => {
    const a = arrangementNamed('rows');
    const groups = groupsWithNarrowChildren(a);
    expect(groups.length).toBeGreaterThan(0);
    for (const node of groups) {
      const smallest = groupMinWidth(node);
      // 100 px to give, less a hair.
      const base = withWidth(a.base, node.id, (smallest + 100) * A_HAIR_LESS);
      expect(relative(base, node.id).width - 100).toBeLessThan(smallest);
      const by = resizedByHand(NO_HAND_OVERRIDES, a.model, base, node.id, { right: -1e9 });
      expect(by.sizes.get(node.id), node.id).toEqual({ ...NO_GROWTH, right: -100 });
      expect(appliedGrowth(a.model, base, by), node.id).toEqual(by.sizes);
      expect(relative(applyHandOverrides(a.model, base, by), node.id).width, node.id).toBe(
        smallest,
      );
      expect(resizedByHand(by, a.model, base, node.id, {}), node.id).toBe(by);
    }
  });

  it('an edge that a stored size leaves less than half a pixel inside its place is stored as not moved by the next change', () => {
    const a = arrangementNamed('rows');
    const groups = groupsWithNarrowChildren(a);
    expect(groups.length).toBeGreaterThan(0);
    for (const node of groups) {
      // A third of a pixel wider than the group can get narrow.
      const base = withWidth(a.base, node.id, groupMinWidth(node) + 0.3);
      const stored: HandOverrides = {
        positions: NO_POSITION_OVERRIDES,
        sizes: new Map([[node.id, { ...NO_GROWTH, right: -1e7, bottom: 16 }]]),
      };
      const drawn = appliedGrowth(a.model, base, stored).get(node.id);
      expect(drawn?.right, node.id).toBeCloseTo(-0.3, 6);
      expect(drawn?.bottom, node.id).toBe(16);
      const by = resizedByHand(stored, a.model, base, node.id, {});
      expect(by.sizes.get(node.id), node.id).toEqual({ ...NO_GROWTH, bottom: 16 });
      expect(appliedGrowth(a.model, base, by), node.id).toEqual(by.sizes);
    }
  });

  it('any sequence of moves, resizes and size resets: what is stored is what is drawn, and a resize moves nothing else', () => {
    for (const a of [...arrangements, ...offPixel]) {
      const random = seeded(37);
      const ids = [...a.base.rects.keys()];
      const groups = groupsOf(a.model).map((node) => node.id);
      // A box at a fraction of a pixel is stored at a whole one when it is moved: at the border
      // of its parent it then lies up to a pixel off its stored place, and goes there when the
      // parent makes room.
      const wholePixels = [...a.base.rects.values()].every((rect) =>
        [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger),
      );
      const slack = wholePixels ? EPS : 1;
      let moves = 0;
      let resizes = 0;
      let resets = 0;
      for (let run = 0; run < 40; run++) {
        let by: HandOverrides = NO_HAND_OVERRIDES;
        for (let step = 0; step < 40; step++) {
          const where = `${a.name}, run ${run}, step ${step}`;
          const before = drawnBy(a, by);
          const kind = random();
          let next: HandOverrides;
          if (kind < 0.4) {
            // A move, held inside the parent as the canvas holds a dragged box.
            const id = pick(random, ids);
            const parentId = a.model.nodes.get(id)?.parentId;
            const rect = relative(before, id);
            let dx = Math.round((random() - 0.5) * 300);
            let dy = Math.round((random() - 0.5) * 300);
            if (parentId !== undefined) {
              const parent = relative(before, parentId);
              const maxX = Math.floor(parent.width - rect.width - rect.x);
              const maxY = Math.floor(parent.height - rect.height - rect.y);
              dx = Math.min(Math.max(dx, Math.ceil(-rect.x)), maxX);
              dy = Math.min(Math.max(dy, Math.ceil(-rect.y)), maxY);
            }
            next = movedByHand(by, a.model, a.base, id, { x: dx, y: dy });
            expect(next.sizes, where).toBe(by.sizes);
            if (next === by) {
              expect([dx, dy].map(Math.abs), where).toEqual([0, 0]);
            } else {
              moves += 1;
              // The box and everything in it went along, by that much; nothing else moved.
              const after = drawnBy(a, next);
              const inside = (other: string): boolean => other === id || other.startsWith(`${id}.`);
              expect(movedNodes(a.model, before, after, inside), where).toEqual([]);
              const problems: string[] = [];
              for (const other of ids.filter(inside)) {
                const from = rectOf(before, other);
                const to = rectOf(after, other);
                const exact =
                  Math.abs(to.x - from.x - dx) <= 1 &&
                  Math.abs(to.y - from.y - dy) <= 1 &&
                  to.width === from.width &&
                  to.height === from.height;
                if (!exact) problems.push(other);
              }
              expect(problems, where).toEqual([]);
            }
          } else {
            const id = pick(random, groups);
            if (kind < 0.9) {
              // One edge of each axis at most, as a control moves them; any distance.
              const delta: { -readonly [edge in keyof EdgeGrowth]?: number } = {};
              const far = (): number => Math.round((random() - 0.5) * 400);
              if (random() < 0.7) delta[random() < 0.5 ? 'left' : 'right'] = far();
              if (random() < 0.7) delta[random() < 0.5 ? 'top' : 'bottom'] = far();
              const limits = limitsFor(a, by, id);
              next = resizedIn(a, by, id, delta);
              if (next !== by) resizes += 1;
              // Every edge went as far as asked, or as far as it goes.
              const went = growthBetween(rectOf(before, id), rectOf(drawnBy(a, next), id));
              for (const edge of EDGES) {
                const asked = delta[edge] ?? 0;
                const want = Math.min(Math.max(asked, -limits.inward[edge]), limits.outward[edge]);
                expect(Math.abs(went[edge] - want), `${where}: ${id} ${edge}`).toBeLessThan(EPS);
              }
            } else {
              next = sizeResetByHand(by, a.model, a.base, id, a.content);
              if (next !== by) resets += 1;
              // Each edge went back as far as it can: asking again changes nothing.
              expect(sizeResetByHand(next, a.model, a.base, id, a.content), where).toBe(next);
            }
            expect(next.positions, where).toBe(by.positions);
            expect(
              movedNodes(a.model, before, drawnBy(a, next), (other) => other === id, slack),
              `${where}: ${id}`,
            ).toEqual([]);
          }
          by = next;
          const out = drawnBy(a, by);
          expect(violations(a.model, out), where).toEqual([]);
          // No stored size is corrected when it is applied.
          expect(appliedGrowth(a.model, a.base, by), where).toEqual(by.sizes);
          // The limits handed to the handles are those of the box drawn, in whole pixels, and
          // no group is smaller than a gesture may make it.
          const problems: string[] = [];
          for (const [id, limits] of allResizeLimits(a.model, a.base, by, a.content)) {
            const rect = relative(out, id);
            if (limits.width !== rect.width || limits.height !== rect.height) problems.push(id);
            const group = a.model.nodes.get(id);
            const smallest = group && smallestOf(a, group);
            if (!smallest || rect.width < smallest.width || rect.height < smallest.height) {
              problems.push(`${id}: ${rect.width}x${rect.height} is too small`);
            }
            for (const edge of EDGES) {
              for (const limit of [limits.inward[edge], limits.outward[edge]]) {
                if (!Number.isInteger(limit) || limit < 0) problems.push(`${id} ${edge} ${limit}`);
              }
            }
          }
          expect(problems, where).toEqual([]);
        }
      }
      expect(moves, a.name).toBeGreaterThan(300);
      expect(resizes, a.name).toBeGreaterThan(300);
      expect(resets, a.name).toBeGreaterThan(20);
    }
  }, 60_000);

  it('a child moved into the room gained stays there, and taking the size back stops at it', () => {
    const a = arrangementNamed('rows');
    const [parent] = groupsOf(a.model).filter((node) => node.parentId === undefined);
    const [childId] = parent?.childIds ?? [];
    if (!parent || childId === undefined) throw new Error('no group with a child');
    const grown = resizedIn(a, NO_HAND_OVERRIDES, parent.id, { right: 200 });
    const roomy = drawnBy(a, grown);
    const child = relative(roomy, childId);
    // To 60 px from the new right edge: beyond where the box of the arrangement ends.
    const far = relative(roomy, parent.id).width - child.width - child.x - 60;
    const by = movedByHand(grown, a.model, a.base, childId, { x: far, y: 0 });
    expect(by.sizes).toBe(grown.sizes);
    const placed = drawnBy(a, by);
    expect(relative(placed, childId).x).toBeCloseTo(child.x + far, 0);
    expect(relative(placed, childId).x + child.width).toBeGreaterThan(
      relative(a.base, parent.id).width,
    );
    // The positions entry is the one a move in a box of that size always gave.
    expect(serializePositions(by.positions)).toBe(
      JSON.stringify({ [childId]: [Math.round(child.x + far), Math.round(child.y)] }),
    );
    // Without the size the same stored position is held in the box of the arrangement.
    const held = drawnBy(a, { positions: by.positions, sizes: NO_SIZE_OVERRIDES });
    expect(relative(held, childId).x).toBe(
      relative(a.base, parent.id).width - relative(a.base, childId).width,
    );
    // Taking the size back stops at the child: it is not moved, and keeps the padding.
    const reset = sizeResetByHand(by, a.model, a.base, parent.id);
    const after = drawnBy(a, reset);
    expect(rectOf(after, childId)).toEqual(rectOf(placed, childId));
    const gap =
      relative(after, parent.id).width -
      relative(after, childId).x -
      relative(after, childId).width;
    expect(gap).toBeGreaterThanOrEqual(GROUP_PADDING.right);
    expect(gap).toBeLessThan(GROUP_PADDING.right + 1);
    expect(relative(after, parent.id).width).toBeGreaterThan(relative(a.base, parent.id).width);
    expect(appliedGrowth(a.model, a.base, reset).size).toBe(1);
  });

  it('a group whose left and top edge were moved keeps its size when it is moved, and takes its children along', () => {
    for (const a of arrangements) {
      const [group] = groupsOf(a.model).filter((node) => node.parentId === undefined);
      if (!group) throw new Error('no top-level group');
      const sized = resizedIn(a, NO_HAND_OVERRIDES, group.id, { left: 60, top: 30 });
      expect(sized.sizes.get(group.id)).toEqual({ ...NO_GROWTH, left: 60, top: 30 });
      const before = drawnBy(a, sized);
      const by = movedByHand(sized, a.model, a.base, group.id, { x: 25, y: -15 });
      expect(by.sizes).toBe(sized.sizes);
      const after = drawnBy(a, by);
      const inside = (id: string): boolean => id === group.id || id.startsWith(`${group.id}.`);
      expect(movedNodes(a.model, before, after, inside), a.name).toEqual([]);
      for (const id of [...a.base.rects.keys()].filter(inside)) {
        const from = rectOf(before, id);
        const to = rectOf(after, id);
        expect(to.x - from.x, `${a.name}: ${id}`).toBeCloseTo(25, 6);
        expect(to.y - from.y, `${a.name}: ${id}`).toBeCloseTo(-15, 6);
        expect([to.width, to.height]).toEqual([from.width, from.height]);
      }
      expect(appliedGrowth(a.model, a.base, by)).toEqual(sized.sizes);
    }
  });

  it('a child is held in a parent made smaller, and a size that cannot go back stays', () => {
    const a = arrangementNamed('rows');
    // A group with room below its children, pulled in; then its first child sent far down.
    const [childId] = a.model.nodes.get('operations')?.childIds ?? [];
    if (childId === undefined) throw new Error('operations has no child');
    const room = limitsFor(a, NO_HAND_OVERRIDES, 'operations').inward.bottom;
    expect(room).toBeGreaterThan(100);
    const smaller = resizedIn(a, NO_HAND_OVERRIDES, 'operations', { bottom: 100 - room });
    const box = relative(drawnBy(a, smaller), 'operations');
    expect(box.height).toBe(relative(a.base, 'operations').height + 100 - room);
    const dropped = movedByHand(smaller, a.model, a.base, childId, { x: 0, y: 5000 });
    const out = drawnBy(a, dropped);
    expect(relative(out, 'operations')).toEqual(box);
    expect(relative(out, childId).y).toBe(box.height - relative(out, childId).height);
    expect(violations(a.model, out)).toEqual([]);
    expect(limitsFor(a, dropped, 'operations').inward.bottom).toBe(0);

    // A group in a group, pulled in at the bottom and then moved down to its parent's border:
    // its bottom edge cannot go back out.
    const pulled = limitsFor(a, NO_HAND_OVERRIDES, 'data.analytics').inward.bottom;
    expect(pulled).toBeGreaterThan(0);
    const short = resizedIn(a, NO_HAND_OVERRIDES, 'data.analytics', { bottom: -pulled });
    const down = limitsFor(a, short, 'data.analytics').outward.bottom;
    expect(down).toBeGreaterThanOrEqual(pulled);
    const by = movedByHand(short, a.model, a.base, 'data.analytics', { x: 0, y: down });
    expect(limitsFor(a, by, 'data.analytics').outward.bottom).toBe(0);
    expect(sizeResetByHand(by, a.model, a.base, 'data.analytics')).toBe(by);
    expect(appliedGrowth(a.model, a.base, by)).toEqual(
      new Map([['data.analytics', { ...NO_GROWTH, bottom: -pulled }]]),
    );
  });

  it('a group does not get narrower than the work-item block it was arranged for', async () => {
    // The narrowest group in a group, arranged for a block much wider than its children need.
    const [narrow] = groupsOf(model)
      .filter((node) => node.parentId !== undefined)
      .sort((one, other) => relative(layout, one.id).width - relative(layout, other.id).width);
    if (!narrow) throw new Error('no group in a group');
    const wide = relative(layout, narrow.id).width + 200;
    const content = new Map<string, Size>([[narrow.id, { width: wide, height: 44 }]]);
    const a: Arrangement = {
      name: 'a wide block',
      model,
      base: await computeLayoutUncached(model, undefined, content),
      content,
    };
    const was = relative(a.base, narrow.id);
    expect(was.width).toBeGreaterThanOrEqual(wide);
    expect(smallestOf(a, narrow).width).toBe(wide);
    const give = Math.floor(was.width - wide + EPS);
    // Its children leave room at a side: without the block the box could come in there.
    const bare = resizeLimits(a.model, a.base, NO_HAND_OVERRIDES, narrow.id);
    if (!bare) throw new Error('no limits');
    expect(Math.max(bare.inward.left, bare.inward.right)).toBeGreaterThan(give + 50);
    const limits = limitsFor(a, NO_HAND_OVERRIDES, narrow.id);
    expect(limits.inward.left).toBe(Math.min(bare.inward.left, give));
    expect(limits.inward.right).toBe(Math.min(bare.inward.right, give));
    const pulled = resizedIn(a, NO_HAND_OVERRIDES, narrow.id, { left: -1e9, right: -1e9 });
    expect(relative(drawnBy(a, pulled), narrow.id).width).toBe(was.width - give);
    // What one edge gives, the edge with the room at it can take, and no more than that.
    const pull = bare.inward.left > bare.inward.right ? 'left' : 'right';
    const grow = pull === 'left' ? 'right' : 'left';
    const room = Math.min(40, limits.outward[grow]);
    expect(room).toBeGreaterThan(0);
    const shifted = resizedIn(a, NO_HAND_OVERRIDES, narrow.id, { [grow]: room, [pull]: -1e9 });
    expect(shifted.sizes.get(narrow.id)).toEqual({
      ...NO_GROWTH,
      [grow]: room,
      [pull]: -(give + room),
    });
    const out = drawnBy(a, shifted);
    expect(relative(out, narrow.id).width).toBe(was.width - give);
    expect(out.content.get(narrow.id)?.width).toBe(was.width - give);
    expect(violations(a.model, out)).toEqual([]);
  });

  it('only a group that is drawn has limits and can be resized', () => {
    const a = arrangementNamed('rows');
    const leaf = [...a.model.nodes.values()].find((node) => node.childIds.length === 0);
    const [group] = groupsOf(a.model);
    if (!leaf || !group) throw new Error('no leaf, no group');
    expect(resizeLimits(a.model, a.base, NO_HAND_OVERRIDES, leaf.id)).toBeUndefined();
    expect(resizeLimits(a.model, a.base, NO_HAND_OVERRIDES, 'nope')).toBeUndefined();
    expect([...allResizeLimits(a.model, a.base, NO_HAND_OVERRIDES).keys()]).toEqual(
      groupsOf(a.model).map((node) => node.id),
    );
    for (const id of [leaf.id, 'nope']) {
      expect(resizedIn(a, NO_HAND_OVERRIDES, id, { right: 40 })).toBe(NO_HAND_OVERRIDES);
      expect(sizeResetByHand(NO_HAND_OVERRIDES, a.model, a.base, id)).toBe(NO_HAND_OVERRIDES);
    }
    // A distance that is not a number moves nothing; a fraction is a whole pixel.
    const nowhere = { right: Number.NaN, bottom: Infinity, left: 0.4 };
    expect(resizedIn(a, NO_HAND_OVERRIDES, group.id, nowhere)).toBe(NO_HAND_OVERRIDES);
    expect(resizedIn(a, NO_HAND_OVERRIDES, group.id, { right: 40.4 }).sizes.get(group.id)).toEqual({
      ...NO_GROWTH,
      right: 40,
    });
    // The limits are those of the box drawn: the room taken is gone from one side and back on the other.
    const before = limitsFor(a, NO_HAND_OVERRIDES, group.id);
    const by = resizedIn(a, NO_HAND_OVERRIDES, group.id, { right: 40 });
    const after = limitsFor(a, by, group.id);
    expect(after.width).toBe(before.width + 40);
    expect(after.inward.right).toBe(before.inward.right + 40);
    expect(after.outward.right).toBe(before.outward.right - 40);
    const back = sizeResetByHand(by, a.model, a.base, group.id);
    expect(back.sizes).toBe(NO_SIZE_OVERRIDES);
    expect(back.positions).toBe(by.positions);
  });

  it('a size on a closed-up arrangement leaves its key, and the arrangement stays the cached one', () => {
    expect(closedUp).toHaveLength(2);
    for (const c of closedUp) {
      const [group] = groupsOf(c.model).filter((node) => node.parentId === undefined);
      if (!group) throw new Error('no top-level group');
      const was = rectOf(c.arranged, group.id);
      const by = resizedByHand(NO_HAND_OVERRIDES, c.model, c.arranged, group.id, {
        right: 120,
        bottom: 40,
      });
      const sized = applyHandOverrides(c.model, c.arranged, by);
      expect(sized).not.toBe(c.arranged);
      expect(rectOf(sized, group.id)).toEqual({
        ...was,
        width: was.width + 120,
        height: was.height + 40,
      });
      expect(sized.key).toBe(c.arranged.key);
      expect(rectOf(c.arranged, group.id)).toBe(was);
      expect(arrangedLayout(c.model, c.reference, c.view)).toBe(c.arranged);
    }
  });
});

describe('movedByHand', () => {
  it('adds the drop offset to the place the node is drawn at, rounding, ignoring no-ops', () => {
    const id = model.rootIds[0] ?? '';
    const rect = layout.rects.get(id);
    if (!rect) throw new Error('rect');
    const once = movedByHand(NO_HAND_OVERRIDES, model, layout, id, { x: 10.4, y: -3.6 });
    expect(once.positions.get(id)).toEqual({
      x: Math.round(rect.x + 10.4),
      y: Math.round(rect.y - 3.6),
    });
    expect(once.sizes).toBe(NO_SIZE_OVERRIDES);
    expect(movedByHand(once, model, layout, id, { x: 0.2, y: -0.3 })).toBe(once);
    expect(movedByHand(once, model, layout, 'nope', { x: 5, y: 5 })).toBe(once);
    expect(movedByHand(once, model, layout, id, { x: Number.NaN, y: 1 })).toBe(once);
    // A second drag starts from where the first one left the node.
    const twice = movedByHand(once, model, layout, id, { x: 5, y: 5 });
    expect(twice.positions.get(id)).toEqual({
      x: Math.round(rect.x + 10.4) + 5,
      y: Math.round(rect.y - 3.6) + 5,
    });
  });
});

describe('resize controls and keys', () => {
  const limits: ResizeLimits = {
    width: 400,
    height: 300,
    inward: { left: 1, top: 2, right: 3, bottom: 4 },
    outward: { left: 10, top: 20, right: 30, bottom: 40 },
  };

  it('a control bounds the size along the edges it moves and along no other', () => {
    expect(RESIZE_CONTROLS).toHaveLength(8);
    expect(new Set(RESIZE_CONTROLS).size).toBe(8);
    expect(controlBounds(limits, 'left')).toEqual({ minWidth: 399, maxWidth: 410 });
    expect(controlBounds(limits, 'right')).toEqual({ minWidth: 397, maxWidth: 430 });
    expect(controlBounds(limits, 'top')).toEqual({ minHeight: 298, maxHeight: 320 });
    expect(controlBounds(limits, 'bottom')).toEqual({ minHeight: 296, maxHeight: 340 });
    expect(controlBounds(limits, 'top-right')).toEqual({
      minWidth: 397,
      maxWidth: 430,
      minHeight: 298,
      maxHeight: 320,
    });
    expect(controlBounds(limits, 'bottom-left')).toEqual({
      minWidth: 399,
      maxWidth: 410,
      minHeight: 296,
      maxHeight: 340,
    });
    expect(Object.keys(controlBounds(limits, 'bottom'))).toEqual(['minHeight', 'maxHeight']);
  });

  it('the edges moved between two boxes of a gesture', () => {
    const start = { x: 10, y: 10, width: 100, height: 50 };
    expect(growthBetween(start, { x: 4, y: 10, width: 126, height: 45 })).toEqual({
      left: 6,
      top: 0,
      right: 20,
      bottom: -5,
    });
    expect(growthBetween(start, start)).toEqual(NO_GROWTH);
  });

  it('an arrow key moves the right or bottom edge, with Shift the left or top one', () => {
    expect(RESIZE_KEY_STEP).toBe(8);
    expect(keyGrowth('ArrowRight', false)).toEqual({ right: 8 });
    expect(keyGrowth('ArrowLeft', false)).toEqual({ right: -8 });
    expect(keyGrowth('ArrowDown', false)).toEqual({ bottom: 8 });
    expect(keyGrowth('ArrowUp', false)).toEqual({ bottom: -8 });
    expect(keyGrowth('ArrowRight', true)).toEqual({ left: -8 });
    expect(keyGrowth('ArrowLeft', true)).toEqual({ left: 8 });
    expect(keyGrowth('ArrowDown', true)).toEqual({ top: -8 });
    expect(keyGrowth('ArrowUp', true)).toEqual({ top: 8 });
    expect(keyGrowth('Enter', false)).toBeUndefined();
    expect(keyGrowth('Delete', true)).toBeUndefined();
  });

  it('says how many boxes were moved and resized', () => {
    expect(handCountText(0, 0)).toBeUndefined();
    expect(handCountText(1, 0)).toBe('1 moved');
    expect(handCountText(0, 3)).toBe('3 resized');
    expect(handCountText(2, 1)).toBe('2 moved · 1 resized');
  });
});

describe('stored sizes', () => {
  const sizes = new Map([['a', { left: 0, top: -4, right: 160, bottom: 40 }]]);

  it('round-trip, and anything invalid is dropped', () => {
    expect(serializeSizes(sizes)).toBe('{"a":[0,-4,160,40]}');
    expect(parseSizes(serializeSizes(sizes))).toEqual(sizes);
    expect(serializeSizes(NO_SIZE_OVERRIDES)).toBe('{}');
    const mixed =
      '{"a":[0,-4,160,40],"b":[0,0,0,0],"c":[1,2,3],"d":[1,2,3,"4"],"e":[1,2,3,4,5],"f":[1,2,3,null],"g":"x","h":null}';
    expect(parseSizes(mixed)).toEqual(sizes);
    for (const text of [null, undefined, '', 'nope', '{', '[1,2,3,4]', '3', 'null', '"a"']) {
      expect(parseSizes(text)).toBe(NO_SIZE_OVERRIDES);
    }
    expect(parseSizes('{"b":[0,0,0,0],"c":[1,2,3]}')).toBe(NO_SIZE_OVERRIDES);
    for (const entry of ['[1e999,0,0,0]', '[true,2,3,4]', '[[1],2,3,4]', '{"left":1,"top":2}']) {
      expect(parseSizes(`{"a":${entry}}`), entry).toBe(NO_SIZE_OVERRIDES);
    }
    // Any name is an ID like another.
    const odd = '{"__proto__":[1,2,3,4],"constructor":[0,0,0,-1]}';
    expect([...parseSizes(odd).keys()]).toEqual(['__proto__', 'constructor']);
    expect(serializeSizes(parseSizes(odd))).toBe(odd);
  });

  it('are written beside the positions, each entry only when it changed', () => {
    const items = new Map<string, string>();
    const written: string[] = [];
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        written.push(key);
        items.set(key, value);
      },
    };
    expect(sizesStorageKey('k')).toBe('architecture-map.sizes:k');
    const moved = { positions: new Map([['a', { x: 1, y: 2 }]]), sizes: NO_SIZE_OVERRIDES };
    writeHandOverrides(storage, 'k', moved, NO_HAND_OVERRIDES);
    expect(written).toEqual([positionsStorageKey('k')]);
    expect(items.get(positionsStorageKey('k'))).toBe('{"a":[1,2]}');
    const both = { positions: moved.positions, sizes };
    writeHandOverrides(storage, 'k', both, moved);
    expect(written).toEqual([positionsStorageKey('k'), sizesStorageKey('k')]);
    expect(items.get(sizesStorageKey('k'))).toBe('{"a":[0,-4,160,40]}');
    writeHandOverrides(storage, 'k', both, both);
    expect(written).toHaveLength(2);
    expect(readHandOverrides(storage, 'k')).toEqual(both);
    // What only the positions entry holds is read as before.
    expect(readPositions(storage, 'k')).toEqual(moved.positions);
    expect(readHandOverrides(storage, 'other')).toBe(NO_HAND_OVERRIDES);
    // Everything taken back: both entries are emptied.
    writeHandOverrides(storage, 'k', NO_HAND_OVERRIDES, both);
    expect(written.slice(2)).toEqual([positionsStorageKey('k'), sizesStorageKey('k')]);
    expect(items.get(sizesStorageKey('k'))).toBe('{}');
    expect(readHandOverrides(storage, 'k')).toBe(NO_HAND_OVERRIDES);
  });

  it('survive a storage that throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    const both = { positions: new Map([['a', { x: 1, y: 2 }]]), sizes };
    expect(readHandOverrides(broken, 'k')).toBe(NO_HAND_OVERRIDES);
    expect(() => writeHandOverrides(broken, 'k', both, NO_HAND_OVERRIDES)).not.toThrow();
    expect(readHandOverrides(undefined, 'k')).toBe(NO_HAND_OVERRIDES);
    expect(() => writeHandOverrides(undefined, 'k', both, NO_HAND_OVERRIDES)).not.toThrow();
    // A sizes entry that cannot be read leaves the positions as they are stored.
    const half = {
      getItem: (key: string) => {
        if (key === sizesStorageKey('k')) throw new Error('blocked');
        return '{"a":[1,2]}';
      },
      setItem: () => undefined,
    };
    expect(readHandOverrides(half, 'k')).toEqual({
      positions: both.positions,
      sizes: NO_SIZE_OVERRIDES,
    });
  });
});
