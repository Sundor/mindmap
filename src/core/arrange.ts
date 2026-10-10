// Closing up the gaps: the layout of the fully expanded map (the reference) arranged for what is
// drawn, without laying anything out again. A closed group takes only the room of the box it is
// drawn at, a leaf keeps its size, an open group closes up around its visible children and
// shrinks to them (never below its minimum size).
//
// Order is kept among the boxes of one group, and among the top-level boxes: every two of them
// that are left / right of each other in the reference stay so, and every two above / below each
// other stay so. The gap between such a pair is never less than the one of the reference, capped
// at LAYER_SPACING (left / right) and NODE_SPACING (above / below). Positions are whole pixels,
// so this holds to the pixel.
//
// With rows, the bands and the placement of the items in them are worked out again from the new
// sizes by the rules of the row layout (./layout/tiered.ts), in the order the reference has
// them: an item stays in its row, right of every item it was right of in any row (the gap capped
// at ITEM_GAP), and a closed group that spans rows keeps its column over those rows. The boxes
// of the Unassigned area are the one exception to the order: they stay right of the bands and
// above / below each other, but, as in the row layout, each goes where its connections are drawn
// now, so it can come to stand beside a box in the bands that it was above or below.
//
// An arrangement is a pure function of the reference, the drawn nodes and the sizes of the closed
// groups. When no closed group is drawn smaller than its box it is the reference itself; it is
// never wider or taller than the reference (but for the rounding to whole pixels).
// Pure: no React, no browser APIs.

import {
  BAND_PADDING_X,
  BAND_PADDING_Y,
  CANVAS_PADDING,
  GROUP_PADDING,
  ITEM_GAP,
  LAYER_SPACING,
  LEAF_SIZE,
  MIN_BAND_HEIGHT,
  NODE_SPACING,
  ROW_GUTTER_WIDTH,
  UNASSIGNED_GAP,
  UNASSIGNED_HEADER,
  UNASSIGNED_MIN_WIDTH,
  UNASSIGNED_PADDING,
  groupMinHeight,
  groupMinWidth,
  groupPadding,
} from './layout/constants';
import { fnv1a64 } from './layout/hash';
import { sweep1D } from './layout/sweep';
import { selfAndAncestors } from './layout/tree';
import type { LayoutResult, Rect, RowBand, Size } from './layout/types';
import type { MiniMapSourceNode } from './minimap';
import type { ArchitectureModel, ArchNode } from './model';

/** What of a map is drawn, as far as closing it up goes. */
export interface ArrangeView {
  /** The nodes that are drawn: `visibleNodes` of the drawn model. */
  readonly visible: ReadonlySet<string>;
  /**
   * Size a closed group is drawn at, given its box in the reference (absolute). Whole pixels,
   * never larger than that box. `closedGroupSize` (src/core/flow.ts), so it is what `buildFlow`
   * draws.
   */
  readonly closedSize: (node: ArchNode, full: Rect) => Size;
  /** The content blocks the reference was computed with (`ComputeLayoutOptions.content`). */
  readonly content?: ReadonlyMap<string, Size> | undefined;
}

// --- One container ----------------------------------------------------------------------------

/** Along one axis: item `to` starts at least `gap` after item `from` ends. */
interface Separation {
  readonly from: number;
  readonly to: number;
  readonly gap: number;
}

/**
 * Starts along one axis of items of `size`, given in `order` (a topological order of
 * `separations`). `lo` is the tightest placement that keeps every separation, which gives the
 * extent; `hi` the latest start within that extent. Each item goes where the reference had it
 * within its own room (`refStart` between the same two bounds worked out with `refSize`), so a
 * box that was centred in its room stays centred, then as far right as a separation from an
 * item already placed demands.
 */
function place1D(
  order: readonly number[],
  separations: readonly Separation[],
  size: readonly number[],
  refStart: readonly number[],
  refSize: readonly number[],
): { starts: number[]; extent: number } {
  const count = size.length;
  const before: Separation[][] = Array.from({ length: count }, () => []);
  const after: Separation[][] = Array.from({ length: count }, () => []);
  for (const separation of separations) {
    before[separation.to]?.push(separation);
    after[separation.from]?.push(separation);
  }
  const earliest = (sizes: readonly number[]): { lo: number[]; extent: number } => {
    const lo = new Array<number>(count).fill(0);
    let extent = 0;
    for (const i of order) {
      let start = 0;
      for (const s of before[i] ?? []) {
        start = Math.max(start, (lo[s.from] ?? 0) + (sizes[s.from] ?? 0) + s.gap);
      }
      lo[i] = start;
      extent = Math.max(extent, start + (sizes[i] ?? 0));
    }
    return { lo, extent };
  };
  const latest = (sizes: readonly number[], extent: number): number[] => {
    const hi = new Array<number>(count).fill(0);
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k] ?? 0;
      let start = extent - (sizes[i] ?? 0);
      for (const s of after[i] ?? []) {
        start = Math.min(start, (hi[s.to] ?? 0) - (sizes[i] ?? 0) - s.gap);
      }
      hi[i] = start;
    }
    return hi;
  };
  const ref = earliest(refSize);
  const refExtent = refStart.reduce(
    (extent, start, i) => Math.max(extent, start + (refSize[i] ?? 0)),
    ref.extent,
  );
  const refHi = latest(refSize, refExtent);
  const { lo, extent } = earliest(size);
  const hi = latest(size, extent);
  const starts = new Array<number>(count).fill(0);
  for (const i of order) {
    const refLo = ref.lo[i] ?? 0;
    const slack = (refHi[i] ?? 0) - refLo;
    const t = slack > 0.5 ? Math.min(1, Math.max(0, ((refStart[i] ?? 0) - refLo) / slack)) : 0;
    let start = (lo[i] ?? 0) + t * ((hi[i] ?? 0) - (lo[i] ?? 0));
    for (const s of before[i] ?? []) {
      start = Math.max(start, (starts[s.from] ?? 0) + (size[s.from] ?? 0) + s.gap);
    }
    starts[i] = start;
  }
  return { starts, extent };
}

interface Indexed {
  readonly rect: Rect;
  readonly index: number;
}

/** `rects` with their indexes, sorted by `compare`, ties by index. */
function sortedRects(rects: readonly Rect[], compare: (a: Rect, b: Rect) => number): Indexed[] {
  return rects
    .map((rect, index) => ({ rect, index }))
    .sort((a, b) => compare(a.rect, b.rect) || a.index - b.index);
}

/** A separation from each rectangle to every later one in `order` that `gapOf` gives a gap. */
function separations(
  order: readonly Indexed[],
  gapOf: (a: Rect, b: Rect) => number | undefined,
): Separation[] {
  const out: Separation[] = [];
  order.forEach((a, p) => {
    for (const b of order.slice(p + 1)) {
      const gap = gapOf(a.rect, b.rect);
      if (gap !== undefined) out.push({ from: a.index, to: b.index, gap });
    }
  });
  return out;
}

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

/** Whether every box of `sizes` has the size of its reference rectangle in `refs`. */
function keepSizes(sizes: readonly Size[], refs: readonly Rect[]): boolean {
  return sizes.every((size, k) => {
    const ref = refs[k];
    return ref !== undefined && sameSize(size, ref);
  });
}

/**
 * Positions, relative to the content origin of one container, of boxes of `size` whose
 * reference rectangles are `ref` (relative to the same origin). Every pair that is left / right
 * of each other in the reference stays so, every pair above / below each other stays so, and the
 * gap between such a pair is at least the one of the reference, capped at `gapX` / `gapY`. Two
 * rectangles that do not overlap in the reference are apart along x or along y, so nothing
 * overlaps. Positions and extents are whole pixels. O(k²) for k boxes.
 */
export function compact2D(
  ref: readonly Rect[],
  size: readonly Size[],
  gapX: number,
  gapY: number,
): { positions: { x: number; y: number }[]; width: number; height: number } {
  const byX = sortedRects(ref, (a, b) => a.x - b.x || a.y - b.y);
  const byY = sortedRects(ref, (a, b) => a.y - b.y || a.x - b.x);
  // Left of each other in the reference — or overlapping there, which a layout never is, so
  // that the result cannot overlap.
  const xs = place1D(
    byX.map((entry) => entry.index),
    separations(byX, (a, b) => {
      const gap = b.x - (a.x + a.width);
      if (gap < 0 && !(a.y < b.y + b.height && b.y < a.y + a.height)) return undefined;
      return Math.min(Math.max(gap, 0), gapX);
    }),
    size.map((s) => s.width),
    ref.map((r) => r.x),
    ref.map((r) => r.width),
  );
  // Above each other in the reference.
  const ys = place1D(
    byY.map((entry) => entry.index),
    separations(byY, (a, b) => {
      const gap = b.y - (a.y + a.height);
      return gap < 0 ? undefined : Math.min(gap, gapY);
    }),
    size.map((s) => s.height),
    ref.map((r) => r.y),
    ref.map((r) => r.height),
  );
  return {
    positions: xs.starts.map((x, i) => ({ x: Math.round(x), y: Math.round(ys.starts[i] ?? 0) })),
    width: Math.round(xs.extent),
    height: Math.round(ys.extent),
  };
}

// --- Naming and caching arrangements ------------------------------------------------------------

/** Key of the canvas in the container maps. Never a valid node ID. */
const CANVAS = '#canvas';

/** The role a node plays in the row layout, as in ./layout/tiered.ts. */
type Role = 'row' | 'span' | 'free';

function roleOf(node: ArchNode): Role {
  if (node.effectiveRow !== undefined) return 'row';
  return node.rowRange !== undefined ? 'span' : 'free';
}

/** A group none of whose children is drawn: it is drawn closed. */
function isClosed(node: ArchNode, visible: ReadonlySet<string>): boolean {
  return node.childIds.length > 0 && !node.childIds.some((child) => visible.has(child));
}

/**
 * Names an arrangement of `reference`: `${id}:${w}x${h}` of every visible closed group whose
 * `closedSize` differs from its reference box, in model order, joined by ' '. '' when none.
 *
 * With rows, a closed group that spans rows is named whatever its size once any group is drawn
 * smaller: its column is worked out from its rows then, not from its children, so the
 * arrangement differs from the one with that group open.
 */
export function arrangementSignature(
  model: ArchitectureModel,
  reference: LayoutResult,
  view: ArrangeView,
): string {
  const parts: string[] = [];
  let smaller = false;
  for (const node of model.nodes.values()) {
    if (!view.visible.has(node.id) || !isClosed(node, view.visible)) continue;
    const full = reference.absolute.get(node.id);
    if (!full) continue;
    const size = view.closedSize(node, full);
    const drawnSmaller = !sameSize(size, full);
    const spans = reference.rows.length > 0 && roleOf(node) === 'span';
    if (drawnSmaller || spans) parts.push(`${node.id}:${size.width}x${size.height}`);
    if (drawnSmaller) smaller = true;
  }
  return smaller ? parts.join(' ') : '';
}

/** Key of the arrangement of `reference` that `signature` names: the reference's own for ''. */
export function arrangementKey(reference: LayoutResult, signature: string): string {
  return signature === '' ? reference.key : `${reference.key}~${fnv1a64(signature)}`;
}

/**
 * `reference` closed up for what `view` draws: the reference itself (the same object) when no
 * closed group is drawn smaller than its box, else {@link closeUp} under the key of
 * {@link arrangementKey}. `model` is the model the reference was computed for (or the drawn
 * model itself: only the rows of the reference decide whether bands are arranged). Pure and
 * deterministic; does not mutate the reference.
 */
export function arrangeLayout(
  model: ArchitectureModel,
  reference: LayoutResult,
  view: ArrangeView,
): LayoutResult {
  const signature = arrangementSignature(model, reference, view);
  if (signature === '') return reference;
  return { ...closeUp(model, reference, view), key: arrangementKey(reference, signature) };
}

/** How many arrangements of one reference {@link arrangedLayout} remembers. */
const ARRANGED_LIMIT = 12;
const arrangedCache = new WeakMap<LayoutResult, Map<string, LayoutResult>>();

/**
 * {@link arrangeLayout}, remembering the last arrangements of each reference object (the least
 * recently used one goes first): coming back to an arrangement gives the very same object, and
 * with it the edge routes `buildFlow` cached for it. `model` and `view.content` must be those
 * the reference was computed with.
 */
export function arrangedLayout(
  model: ArchitectureModel,
  reference: LayoutResult,
  view: ArrangeView,
): LayoutResult {
  const signature = arrangementSignature(model, reference, view);
  if (signature === '') return reference;
  let cache = arrangedCache.get(reference);
  if (!cache) {
    cache = new Map();
    arrangedCache.set(reference, cache);
  }
  let arranged = cache.get(signature);
  if (arranged) cache.delete(signature);
  else arranged = { ...closeUp(model, reference, view), key: arrangementKey(reference, signature) };
  cache.set(signature, arranged);
  if (cache.size > ARRANGED_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return arranged;
}

// --- What an arrangement draws ----------------------------------------------------------------

/** Absolute rectangles of the `visible` nodes of `layout`, in its order. */
export function visibleRects(
  layout: LayoutResult,
  visible: ReadonlySet<string>,
): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  for (const [id, rect] of layout.absolute) if (visible.has(id)) rects.set(id, rect);
  return rects;
}

/**
 * What `layout` draws, as the fit and the minimap take it (`MiniMapSourceNode`): one 'band' node
 * per row band and for the Unassigned area, then the `visible` nodes, parents first, with
 * positions relative to their parent (`layout.rects`).
 */
export function arrangedSourceNodes(
  model: ArchitectureModel,
  layout: LayoutResult,
  visible: ReadonlySet<string>,
): MiniMapSourceNode[] {
  const band = (id: string, rect: Rect): MiniMapSourceNode => ({
    id,
    type: 'band',
    position: { x: rect.x, y: rect.y },
    width: rect.width,
    height: rect.height,
  });
  const nodes = layout.rows.map((row) => band(`band:${row.id}`, row));
  if (layout.unassignedArea) nodes.push(band('band:unassigned', layout.unassignedArea));
  for (const node of model.nodes.values()) {
    const rect = layout.rects.get(node.id);
    if (!rect || !visible.has(node.id)) continue;
    nodes.push({
      id: node.id,
      type: node.childIds.length > 0 ? 'group' : 'leaf',
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      position: { x: rect.x, y: rect.y },
      width: rect.width,
      height: rect.height,
    });
  }
  return nodes;
}

// --- The geometry -------------------------------------------------------------------------------

/** The boxes of the drawn nodes, arranged inside out, and where they have been placed. */
interface Boxes {
  readonly nodeOf: (id: string) => ArchNode;
  /** Absolute rectangle in the reference. */
  readonly referenceRect: (id: string) => Rect;
  /** The content block of a node, as wide as it was asked for, as high as it was reserved. */
  readonly contentOf: (id: string) => Size | undefined;
  /** Size of the box of a drawn node; arranges its inside on first use. */
  readonly sizeOf: (id: string) => Size;
  /** Places the box of a drawn node and, inside it, what `sizeOf` arranged there. */
  readonly place: (id: string, x: number, y: number) => void;
  /** Absolute rectangles of the drawn nodes placed so far. */
  readonly placed: Map<string, Rect>;
  /** Where the drawn children of the groups `sizeOf` arranged sit, relative to their group. */
  readonly offsets: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
}

function rectIn(rects: ReadonlyMap<string, Rect>, id: string): Rect {
  const rect = rects.get(id);
  if (!rect) throw new Error(`Layout has no rectangle for node ${id}`);
  return rect;
}

function arrangeBoxes(model: ArchitectureModel, reference: LayoutResult, view: ArrangeView): Boxes {
  const { visible } = view;
  const nodeOf = (id: string): ArchNode => {
    const node = model.nodes.get(id);
    if (!node) throw new Error(`Unknown node ${id}`);
    return node;
  };
  const referenceRect = (id: string): Rect => rectIn(reference.absolute, id);
  const contentOf = (id: string): Size | undefined => {
    const block = reference.content.get(id);
    return block && { width: view.content?.get(id)?.width ?? 0, height: block.height };
  };

  const sizes = new Map<string, Size>();
  /** Where the drawn children of an arranged group sit, relative to it. */
  const offsets = new Map<string, { x: number; y: number }>();
  const sizeOf = (id: string): Size => {
    const known = sizes.get(id);
    if (known) return known;
    const node = nodeOf(id);
    const ref = rectIn(reference.rects, id);
    let size: Size;
    if (node.childIds.length === 0) {
      size = { width: ref.width, height: ref.height };
    } else if (isClosed(node, visible)) {
      const { width, height } = view.closedSize(node, referenceRect(id));
      size = { width, height };
    } else {
      const children = node.childIds.filter((child) => visible.has(child));
      const childSizes = children.map(sizeOf);
      const childRefs = children.map((child) => rectIn(reference.rects, child));
      if (keepSizes(childSizes, childRefs)) {
        // Nothing inside changed: the inside of the reference.
        children.forEach((child, k) => offsets.set(child, childRefs[k] ?? { x: 0, y: 0 }));
        size = { width: ref.width, height: ref.height };
      } else {
        const content = contentOf(id);
        const pad = groupPadding(content);
        const packed = compact2D(
          childRefs.map((r) => ({ ...r, x: r.x - pad.left, y: r.y - pad.top })),
          childSizes,
          LAYER_SPACING,
          NODE_SPACING,
        );
        children.forEach((child, k) => {
          const at = packed.positions[k] ?? { x: 0, y: 0 };
          offsets.set(child, { x: pad.left + at.x, y: pad.top + at.y });
        });
        size = {
          width: Math.max(groupMinWidth(node, content), pad.left + packed.width + pad.right),
          height: Math.max(groupMinHeight(content), pad.top + packed.height + pad.bottom),
        };
      }
    }
    sizes.set(id, size);
    return size;
  };

  const placed = new Map<string, Rect>();
  const place = (id: string, x: number, y: number): void => {
    placed.set(id, { x, y, ...sizeOf(id) });
    for (const child of nodeOf(id).childIds) {
      const offset = visible.has(child) ? offsets.get(child) : undefined;
      if (offset) place(child, x + offset.x, y + offset.y);
    }
  };

  return { nodeOf, referenceRect, contentOf, sizeOf, place, placed, offsets };
}

/** The band geometry of an arrangement: none without rows. */
interface Frame {
  readonly rows: RowBand[];
  readonly unassignedArea?: Rect;
  readonly bounds: Size;
}

/** Without rows: the top-level nodes closed up on the canvas, as inside a group. */
function arrangeCanvas(model: ArchitectureModel, reference: LayoutResult, boxes: Boxes): Frame {
  const roots = model.rootIds;
  const sizes = roots.map(boxes.sizeOf);
  const refs = roots.map(boxes.referenceRect);
  if (keepSizes(sizes, refs)) {
    roots.forEach((id, k) => boxes.place(id, refs[k]?.x ?? 0, refs[k]?.y ?? 0));
    return { rows: [], bounds: reference.bounds };
  }
  const packed = compact2D(
    refs.map((r) => ({ ...r, x: r.x - CANVAS_PADDING, y: r.y - CANVAS_PADDING })),
    sizes,
    LAYER_SPACING,
    NODE_SPACING,
  );
  roots.forEach((id, k) => {
    const at = packed.positions[k] ?? { x: 0, y: 0 };
    boxes.place(id, CANVAS_PADDING + at.x, CANVAS_PADDING + at.y);
  });
  return {
    rows: [],
    bounds: {
      width: packed.width + 2 * CANVAS_PADDING,
      height: packed.height + 2 * CANVAS_PADDING,
    },
  };
}

interface ContainerItem {
  readonly id: string;
  readonly span: boolean;
  /** A spanning group that is open: a container itself. */
  readonly open: boolean;
  /** Row range the item occupies (top === bottom for single-row items). */
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  /** Real height for single-row items and closed spans; open spans get their column height. */
  readonly height: number;
  /** Absolute rectangle in the reference. */
  readonly ref: Rect;
  /** Offset from the container's content-left edge. */
  x: number;
}

interface ContainerMeasure {
  readonly top: number;
  readonly bottom: number;
  /** Items in left → right order. */
  readonly items: ContainerItem[];
  readonly contentWidth: number;
  /** Height of the single-row items in each row slice, indexed by row (0 when none). */
  readonly sliceHeight: number[];
}

/**
 * With rows: the geometry of `layoutWithRows` (measure, band sizing, placement, Unassigned
 * area) run again on the drawn items with their new sizes. The rows of the items and their
 * order are those of the reference, also between items of different rows; a closed spanning
 * group keeps its column over its rows, and the bottom band of its range grows when that column
 * is lower than its box. The Unassigned area follows the connections of its items and ends no
 * lower than the reference does.
 */
function arrangeRows(
  model: ArchitectureModel,
  reference: LayoutResult,
  view: ArrangeView,
  boxes: Boxes,
): Frame {
  const { visible } = view;
  const { nodeOf, referenceRect, contentOf, sizeOf } = boxes;
  const rowCount = reference.rows.length;
  const rowIndex = new Map(reference.rows.map((band, i) => [band.id, i]));
  const itemRow = (id: string): number | undefined => {
    const row = reference.rowOf.get(id);
    return row === undefined ? undefined : rowIndex.get(row);
  };

  // --- Measure pass (bottom-up).
  const measures = new Map<string, ContainerMeasure>();
  const closedSpans: ContainerItem[] = [];
  const measure = (
    containerId: string,
    childIds: readonly string[],
    top: number,
    bottom: number,
  ): ContainerMeasure => {
    const items: ContainerItem[] = [];
    for (const id of childIds) {
      if (!visible.has(id)) continue;
      const child = nodeOf(id);
      const ref = referenceRect(id);
      if (roleOf(child) === 'span' && child.rowRange) {
        const range = { top: child.rowRange.top, bottom: child.rowRange.bottom };
        if (isClosed(child, visible)) {
          const item = { id, span: true, open: false, ...range, ...sizeOf(id), ref, x: 0 };
          items.push(item);
          closedSpans.push(item);
        } else {
          const inner = measure(id, child.childIds, range.top, range.bottom);
          const width = Math.max(
            groupMinWidth(child, contentOf(id)),
            GROUP_PADDING.left + inner.contentWidth + GROUP_PADDING.right,
          );
          items.push({ id, span: true, open: true, ...range, width, height: 0, ref, x: 0 });
        }
      } else {
        const row = itemRow(id);
        if (row === undefined) continue; // unassigned top-level node
        const size = sizeOf(id);
        items.push({ id, span: false, open: false, top: row, bottom: row, ...size, ref, x: 0 });
      }
    }
    // The order of the reference, left → right.
    items.sort((a, b) => a.ref.x - b.ref.x || a.ref.y - b.ref.y);

    // Skyline packing: per-row cursor of the next free x, which keeps the order of the items
    // that share a row. Once an item has another width than in the reference, the items after
    // it are also held right of every item they were right of there, whatever its rows, by the
    // gap they had, capped at ITEM_GAP. Up to that item the cursors alone give the reference.
    const cursor = new Array<number>(rowCount).fill(0);
    const sliceHeight = new Array<number>(rowCount).fill(0);
    let contentWidth = 0;
    let resized = false;
    for (const item of items) {
      let x = 0;
      for (let r = item.top; r <= item.bottom; r++) x = Math.max(x, cursor[r] ?? 0);
      if (resized) {
        for (const before of items) {
          if (before === item) break;
          const gap = item.ref.x - (before.ref.x + before.ref.width);
          if (gap >= 0) x = Math.max(x, before.x + before.width + Math.min(gap, ITEM_GAP));
        }
      }
      resized ||= item.width !== item.ref.width;
      item.x = x;
      for (let r = item.top; r <= item.bottom; r++) cursor[r] = x + item.width + ITEM_GAP;
      contentWidth = Math.max(contentWidth, x + item.width);
      if (!item.span) sliceHeight[item.top] = Math.max(sliceHeight[item.top] ?? 0, item.height);
    }
    const result: ContainerMeasure = { top, bottom, items, contentWidth, sliceHeight };
    measures.set(containerId, result);
    return result;
  };
  const canvas = measure(CANVAS, model.rootIds, 0, rowCount - 1);

  // Vertical room a container's own padding (and its spanning ancestors' padding) takes inside
  // a band, as in the row layout.
  const insetTop = (containerId: string, r: number): number => {
    if (containerId === CANVAS) return 0;
    const node = nodeOf(containerId);
    if (node.rowRange?.top !== r) return 0;
    return groupPadding(contentOf(containerId)).top + insetTop(node.parentId ?? CANVAS, r);
  };
  const insetBottom = (containerId: string, r: number): number => {
    if (containerId === CANVAS) return 0;
    const node = nodeOf(containerId);
    if (node.rowRange?.bottom !== r) return 0;
    return GROUP_PADDING.bottom + insetBottom(node.parentId ?? CANVAS, r);
  };

  // --- Band sizing: the tallest need of any container in each row.
  const bandHeight = new Array<number>(rowCount).fill(MIN_BAND_HEIGHT);
  for (const [containerId, m] of measures) {
    for (let r = m.top; r <= m.bottom; r++) {
      const need = insetTop(containerId, r) + (m.sliceHeight[r] ?? 0) + insetBottom(containerId, r);
      bandHeight[r] = Math.max(bandHeight[r] ?? 0, need + 2 * BAND_PADDING_Y);
    }
  }
  // A closed spanning group keeps its rows; its column must still hold the box it is drawn at.
  // Those that end highest first: a band grown for one is counted for the next, so the bands
  // grow by no more than is needed.
  closedSpans.sort((a, b) => a.bottom - b.bottom);
  for (const item of closedSpans) {
    const containerId = nodeOf(item.id).parentId ?? CANVAS;
    let column = -2 * BAND_PADDING_Y;
    for (let r = item.top; r <= item.bottom; r++) column += bandHeight[r] ?? 0;
    column -= insetTop(containerId, item.top) + insetBottom(containerId, item.bottom);
    if (item.height > column) {
      bandHeight[item.bottom] = (bandHeight[item.bottom] ?? 0) + item.height - column;
    }
  }
  const bandY: number[] = [];
  let totalBandHeight = 0;
  for (const h of bandHeight) {
    bandY.push(totalBandHeight);
    totalBandHeight += h;
  }
  const bandTop = (r: number): number => bandY[r] ?? 0;
  const bandBottom = (r: number): number => bandTop(r) + (bandHeight[r] ?? 0);
  const contentTop = (containerId: string, r: number): number =>
    bandTop(r) + BAND_PADDING_Y + insetTop(containerId, r);
  const contentBottom = (containerId: string, r: number): number =>
    bandBottom(r) - BAND_PADDING_Y - insetBottom(containerId, r);

  // --- Placement pass (top-down). A spanning group's rectangle is its column.
  const place = (containerId: string, contentLeft: number): void => {
    const m = measures.get(containerId);
    if (!m) throw new Error(`Container ${containerId} was not measured`);
    for (const item of m.items) {
      const x = contentLeft + item.x;
      const y = contentTop(containerId, item.top);
      if (item.span) {
        const height = contentBottom(containerId, item.bottom) - y;
        boxes.placed.set(item.id, { x, y, width: item.width, height });
        if (item.open) place(item.id, x + GROUP_PADDING.left);
      } else {
        boxes.place(item.id, x, y);
      }
    }
  };
  place(CANVAS, ROW_GUTTER_WIDTH + BAND_PADDING_X);

  const bandsWidth =
    ROW_GUTTER_WIDTH + 2 * BAND_PADDING_X + Math.max(canvas.contentWidth, LEAF_SIZE[0].width);
  // --- Unassigned area: right of the bands, in the order of the reference, each item pulled
  // toward where the other ends of its connections are drawn now, as in the row layout: an item
  // follows its connections up or down past the boxes in the bands, whichever of them it was
  // above or below in the reference.
  const drawnAt = (id: string): Rect | undefined => {
    for (let at: string | undefined = id; at !== undefined; at = model.nodes.get(at)?.parentId) {
      const rect = visible.has(at) ? boxes.placed.get(at) : undefined;
      if (rect) return rect;
    }
    return undefined;
  };
  const unassignedIds = model.rootIds.filter((id) => roleOf(nodeOf(id)) === 'free');
  let unassignedArea: Rect | undefined;
  if (unassignedIds.length > 0) {
    // Per item, the centres of where the other ends of its connections are drawn, in the order
    // of the edges: one pass over the edges, whatever the number of items.
    const centres = new Map<string, number[]>(unassignedIds.map((id) => [id, []]));
    const rootOf = (id: string): string => selfAndAncestors(model, id).at(-1) ?? id;
    for (const edge of model.edges) {
      const from = rootOf(edge.from);
      const to = rootOf(edge.to);
      if (from === to) continue;
      for (const [item, otherEnd] of [
        [from, edge.to],
        [to, edge.from],
      ] as const) {
        const other = centres.has(item) ? drawnAt(otherEnd) : undefined;
        if (other) centres.get(item)?.push(other.y + other.height / 2);
      }
    }
    const entries = unassignedIds
      .map((id) => {
        const ends = centres.get(id) ?? [];
        const target =
          ends.length > 0 ? ends.reduce((sum, c) => sum + c, 0) / ends.length : undefined;
        return { id, target, size: sizeOf(id) };
      })
      .sort((a, b) => referenceRect(a.id).y - referenceRect(b.id).y);
    const heights = entries.map((e) => e.size.height);
    const ys = sweep1D(
      heights,
      entries.map((e) => (e.target === undefined ? undefined : e.target - e.size.height / 2)),
      UNASSIGNED_HEADER + UNASSIGNED_PADDING,
      UNASSIGNED_GAP,
    ).map((start) => Math.round(start));
    // The area ends no lower than the bands and the area of the reference do (or than its
    // items stacked from the top, should they need more): an item that would end lower moves
    // up, and so do the items above it as far as it then needs their room. `limit` is the
    // lowest the area could end were the item at hand its last.
    const stacked = heights.reduce(
      (bottom, height) => bottom + UNASSIGNED_GAP + height,
      UNASSIGNED_HEADER + 2 * UNASSIGNED_PADDING - UNASSIGNED_GAP,
    );
    let limit = Math.max(totalBandHeight, reference.unassignedArea?.height ?? 0, stacked);
    for (let k = entries.length - 1; k >= 0; k--) {
      const height = heights[k] ?? 0;
      if ((ys[k] ?? 0) + height + UNASSIGNED_PADDING <= limit) break;
      const y = Math.floor(limit - UNASSIGNED_PADDING - height);
      ys[k] = y;
      limit = y - UNASSIGNED_GAP + UNASSIGNED_PADDING;
    }
    let maxWidth = 0;
    let lowest = 0;
    entries.forEach((entry, k) => {
      const y = ys[k] ?? 0;
      boxes.place(entry.id, bandsWidth + UNASSIGNED_PADDING, y);
      maxWidth = Math.max(maxWidth, entry.size.width);
      lowest = Math.max(lowest, y + entry.size.height);
    });
    unassignedArea = {
      x: bandsWidth,
      y: 0,
      width: Math.max(UNASSIGNED_MIN_WIDTH, maxWidth + 2 * UNASSIGNED_PADDING),
      height: Math.max(totalBandHeight, lowest + UNASSIGNED_PADDING),
    };
  }

  // The band stack and the Unassigned area end at the same y.
  const stretch = Math.max(0, (unassignedArea?.height ?? 0) - totalBandHeight);
  const rows: RowBand[] = reference.rows.map((row, r) => ({
    id: row.id,
    name: row.name,
    x: 0,
    y: bandTop(r),
    width: bandsWidth,
    height: (bandHeight[r] ?? 0) + (r === rowCount - 1 ? stretch : 0),
  }));
  return {
    rows,
    ...(unassignedArea ? { unassignedArea } : {}),
    bounds: {
      width: unassignedArea ? unassignedArea.x + unassignedArea.width : bandsWidth,
      height: Math.max(totalBandHeight, unassignedArea?.height ?? 0),
    },
  };
}

/**
 * The geometry of {@link arrangeLayout}, always computed (also when no closed group is drawn
 * smaller); the key is the reference's. With nothing closed it reproduces the reference.
 *
 * `rects` and `absolute` hold every node of the model, in model order. A node that is not drawn
 * gets the place it had inside its nearest drawn ancestor, scaled to that ancestor's new box.
 * Every content block is as wide as its node. Rows of nodes (`placedRow`, `rowOf`) and the
 * gutter are the reference's. Does not mutate the reference.
 */
export function closeUp(
  model: ArchitectureModel,
  reference: LayoutResult,
  view: ArrangeView,
): LayoutResult {
  const boxes = arrangeBoxes(model, reference, view);
  const frame =
    reference.rows.length === 0
      ? arrangeCanvas(model, reference, boxes)
      : arrangeRows(model, reference, view, boxes);

  const absolute = new Map<string, Rect>();
  const rects = new Map<string, Rect>();
  /** How much the box of the nearest drawn ancestor of a hidden node grew or shrank. */
  const scaleOf = (node: ArchNode): { x: number; y: number } => {
    let holder = node.parentId;
    while (holder !== undefined && !boxes.placed.has(holder)) {
      holder = model.nodes.get(holder)?.parentId;
    }
    const to = holder === undefined ? undefined : boxes.placed.get(holder);
    const from = holder === undefined ? undefined : boxes.referenceRect(holder);
    return to && from ? { x: to.width / from.width, y: to.height / from.height } : { x: 1, y: 1 };
  };
  for (const node of model.nodes.values()) {
    const parent = node.parentId === undefined ? undefined : absolute.get(node.parentId);
    const placed = boxes.placed.get(node.id);
    let rel: Rect;
    if (placed) {
      const offset = boxes.offsets.get(node.id);
      rel = offset
        ? { ...placed, x: offset.x, y: offset.y }
        : { ...placed, x: placed.x - (parent?.x ?? 0), y: placed.y - (parent?.y ?? 0) };
    } else {
      // Not drawn: where it was in its parent, scaled as the box that stands for it.
      const original = rectIn(reference.rects, node.id);
      const scale = scaleOf(node);
      rel = {
        x: original.x * scale.x,
        y: original.y * scale.y,
        width: original.width * scale.x,
        height: original.height * scale.y,
      };
    }
    rects.set(node.id, rel);
    absolute.set(
      node.id,
      placed ?? { ...rel, x: (parent?.x ?? 0) + rel.x, y: (parent?.y ?? 0) + rel.y },
    );
  }
  const content = new Map<string, Rect>();
  for (const [id, block] of reference.content) {
    const rect = rects.get(id);
    if (rect) content.set(id, { ...block, width: rect.width });
  }
  return {
    key: reference.key,
    rects,
    absolute,
    rows: frame.rows,
    gutterWidth: reference.gutterWidth,
    ...(frame.unassignedArea ? { unassignedArea: frame.unassignedArea } : {}),
    bounds: frame.bounds,
    placedRow: reference.placedRow,
    rowOf: reference.rowOf,
    content,
  };
}
