// Three ways the user can depart from the computed arrangement:
// - hiding the rows: the layout is then computed for the same model without its rows, so the
//   nodes are arranged by their connections alone (`withoutRows`);
// - moving nodes by hand (positions unlocked): the moved positions are kept as overrides and
//   applied on top of the computed layout (`applyPositionOverrides`). Nothing else moves;
// - resizing open groups by hand (positions unlocked): how far each edge of a group was moved is
//   kept beside the positions and applied with them (`applyHandOverrides`). What is inside the
//   group stays where it is on the canvas, and nothing around it moves.
// Pure: the storage is injected and nothing here throws.

import { HEADER_HEIGHT, groupMinHeight, groupMinWidth, groupPadding } from './layout/constants';
import type { LayoutResult, Rect, Size } from './layout/types';
import type { ArchitectureModel, ArchNode } from './model';
import type { ViewStateStorage } from './visibility';

/** `model` as if the file had no rows: same nodes and edges, no row on any node. */
export function withoutRows(model: ArchitectureModel): ArchitectureModel {
  if (model.rows.length === 0) return model;
  const nodes = new Map<string, ArchNode>();
  for (const node of model.nodes.values()) {
    // Everything but what the rows gave the node.
    nodes.set(
      node.id,
      Object.fromEntries(
        Object.entries(node).filter(([key]) => !ROW_KEYS.has(key)),
      ) as unknown as ArchNode,
    );
  }
  return { ...model, rows: [], nodes };
}

const ROW_KEYS: ReadonlySet<string> = new Set<keyof ArchNode>(['row', 'effectiveRow', 'rowRange']);

export interface Position {
  readonly x: number;
  readonly y: number;
}

/**
 * Positions set by hand, relative to the parent node (top-level nodes: to the canvas origin). A
 * position is the top-left corner of the box as the arrangement sized it, relative to the same
 * corner of its parent: where an edge of either was moved by hand, the box is drawn that much
 * away from it.
 */
export type PositionOverrides = ReadonlyMap<string, Position>;

export const NO_POSITION_OVERRIDES: PositionOverrides = new Map();

/** How far each edge of a group's box is moved outward by hand, in canvas pixels (negative: inward). */
export interface EdgeGrowth {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export const NO_GROWTH: EdgeGrowth = { left: 0, top: 0, right: 0, bottom: 0 };
export const EDGES = ['left', 'top', 'right', 'bottom'] as const;
export type EdgeName = (typeof EDGES)[number];

/** Sizes set by hand, of groups: per group, how far each edge was moved. */
export type SizeOverrides = ReadonlyMap<string, EdgeGrowth>;

export const NO_SIZE_OVERRIDES: SizeOverrides = new Map();

/** Everything set by hand in one arrangement. */
export interface HandOverrides {
  readonly positions: PositionOverrides;
  readonly sizes: SizeOverrides;
}

export const NO_HAND_OVERRIDES: HandOverrides = {
  positions: NO_POSITION_OVERRIDES,
  sizes: NO_SIZE_OVERRIDES,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Forgives the last bits of a sum of fractions where a length is held against a limit: the boxes
 * of a layout need not lie on whole pixels.
 */
const ROUNDING = 1e-6;

/** `value` cut to whole pixels, never below zero. */
function wholePixels(value: number): number {
  return Math.max(0, Math.floor(value + ROUNDING));
}

function isZero(growth: EdgeGrowth): boolean {
  return EDGES.every((edge) => growth[edge] === 0);
}

/** The size stored for `node` where it counts: on a group, four finite numbers, not all zero. */
function storedGrowth(sizes: SizeOverrides, node: ArchNode): EdgeGrowth | undefined {
  const stored = node.childIds.length > 0 ? sizes.get(node.id) : undefined;
  if (!stored || isZero(stored)) return undefined;
  return EDGES.every((edge) => Number.isFinite(stored[edge])) ? stored : undefined;
}

// --- Applying ---------------------------------------------------------------------------------

/** Where a node is by hand: what its stored position stands for, and how far its edges are moved. */
interface Frame {
  /** Top-left of the box as the layout sized it, relative to the same corner of its parent. */
  readonly x: number;
  readonly y: number;
  /** `NO_GROWTH` for a node drawn in the box the layout gave it. */
  readonly growth: EdgeGrowth;
}

/** A layout with what was set by hand applied, and the frame of every node placed in it. */
interface Placed {
  readonly layout: LayoutResult;
  /** Empty when nothing is stored: every node is then where the layout has it. */
  readonly frames: ReadonlyMap<string, Frame>;
}

/**
 * The content block of the group `id` as the layout sizes take it: as high as `layout` reserved
 * and as wide as the layout was asked for (`content`, what it was computed with).
 */
function blockOf(
  layout: LayoutResult,
  id: string,
  content?: ReadonlyMap<string, Size>,
): Size | undefined {
  const block = layout.content.get(id);
  return block && { width: content?.get(id)?.width ?? 0, height: block.height };
}

/**
 * The size no stored value takes a box below. A leaf, and a group without a stored size, keep
 * the size of the layout; a group with one keeps its header (never more than the layout gave
 * it) and stays as large as the largest floor inside it, so every node fits into its parent
 * whatever is stored.
 */
function sizeFloors(
  model: ArchitectureModel,
  layout: LayoutResult,
  sizes: SizeOverrides,
): ReadonlyMap<string, Size> {
  const floors = new Map<string, Size>();
  // The model order backwards: children before parents, so their floors are known first.
  for (const node of [...model.nodes.values()].reverse()) {
    const rect = layout.rects.get(node.id);
    if (!rect) continue;
    if (!storedGrowth(sizes, node)) {
      floors.set(node.id, { width: rect.width, height: rect.height });
      continue;
    }
    let width = Math.min(rect.width, groupMinWidth(node));
    let height = Math.min(rect.height, groupMinHeight(blockOf(layout, node.id)));
    for (const child of node.childIds) {
      const floor = floors.get(child);
      if (!floor) continue;
      width = Math.max(width, floor.width);
      height = Math.max(height, floor.height);
    }
    floors.set(node.id, { width, height });
  }
  return floors;
}

/** One axis of a box: how far each of its two edges is moved outward, and how long it is. */
interface Span {
  /** The left / top edge. */
  readonly near: number;
  /** The right / bottom edge. */
  readonly far: number;
  readonly length: number;
}

/**
 * One axis of a group resized by hand: `length` in the layout, with the left / top edge moved
 * outward by `near` and the right / bottom one by `far`, in whole pixels. Never shorter than
 * `floor`: the far edge gives way first, then the near one. Inside a parent (`parentLength`)
 * never longer than the parent: growth of the far edge gives way first, then that of the near
 * one. An edge of a top-level group moves outward by no more than the whole pixels of
 * `mapLength`, which is as far as a gesture takes it.
 *
 * Moves that fit come back as they are, number for number. Only a move that is cut is worked
 * out from the lengths: those need not be whole pixels, and a sum of them does not give the
 * whole numbers back. A length that misses a limit by the last bits of such a sum is at the
 * limit, and its moves fit.
 */
function resizedSpan(
  length: number,
  near: number,
  far: number,
  floor: number,
  parentLength: number | undefined,
  mapLength: number,
): Span {
  const cap = parentLength === undefined ? wholePixels(mapLength) : Infinity;
  let nearMoved = Math.min(Math.round(near), cap);
  let farMoved = Math.min(Math.round(far), cap);
  let resized = length + nearMoved + farMoved;
  if (resized < floor) {
    if (floor - resized > ROUNDING) {
      nearMoved = Math.max(nearMoved, floor - length - Math.max(farMoved, 0));
      farMoved = floor - length - nearMoved;
    }
    resized = floor;
  }
  // The parent as drawn is never below this node's floor.
  const most = parentLength === undefined ? Infinity : Math.max(parentLength, floor);
  if (resized > most) {
    if (resized - most > ROUNDING) {
      nearMoved = Math.min(nearMoved, most - length - Math.min(farMoved, 0));
      farMoved = most - length - nearMoved;
    }
    resized = most;
  }
  return { near: nearMoved, far: farMoved, length: resized };
}

/** `layout` with `by` applied, and where that leaves every node: what the functions below share. */
function place(model: ArchitectureModel, layout: LayoutResult, by: HandOverrides): Placed {
  const frames = new Map<string, Frame>();
  if (by.positions.size === 0 && by.sizes.size === 0) return { layout, frames };
  const floors = by.sizes.size > 0 ? sizeFloors(model, layout, by.sizes) : undefined;
  const rects = new Map<string, Rect>();
  const absolute = new Map<string, Rect>();
  let content: Map<string, Rect> | undefined;
  /** Groups drawn at another size than the layout's, or with their left / top edge moved. */
  const reshaped = new Set<string>();
  let changed = false;
  let { width, height } = layout.bounds;
  // Model order: parents before children, so a parent's new box is known first.
  for (const node of model.nodes.values()) {
    const rect = layout.rects.get(node.id);
    if (!rect) continue;
    const parentRect = node.parentId === undefined ? undefined : rects.get(node.parentId);
    const parentAbsolute = node.parentId === undefined ? undefined : absolute.get(node.parentId);
    const parentGrowth =
      (node.parentId === undefined ? undefined : frames.get(node.parentId)?.growth) ?? NO_GROWTH;
    const parentReshaped = node.parentId !== undefined && reshaped.has(node.parentId);

    // The size: only a group has one of its own.
    const stored = storedGrowth(by.sizes, node);
    const floor = floors?.get(node.id);
    let across: Span = { near: 0, far: 0, length: rect.width };
    let down: Span = { near: 0, far: 0, length: rect.height };
    if (stored && floor) {
      across = resizedSpan(
        rect.width,
        stored.left,
        stored.right,
        floor.width,
        parentRect?.width,
        layout.bounds.width,
      );
      down = resizedSpan(
        rect.height,
        stored.top,
        stored.bottom,
        floor.height,
        parentRect?.height,
        layout.bounds.height,
      );
    }
    const resized =
      across.length !== rect.width ||
      down.length !== rect.height ||
      across.near !== 0 ||
      down.near !== 0;
    const growth: EdgeGrowth = resized
      ? { left: across.near, top: down.near, right: across.far, bottom: down.far }
      : NO_GROWTH;

    // The place its position stands for: the stored one, or the layout's.
    const override = by.positions.get(node.id);
    const moved =
      override !== undefined && Number.isFinite(override.x) && Number.isFinite(override.y);
    let frameX = rect.x;
    let frameY = rect.y;
    if (moved) {
      frameX = Math.round(override.x);
      frameY = Math.round(override.y);
      if (!parentRect) {
        // A top-level node may leave the map, but not by more than the map's own size: a stored
        // position far outside would stretch the bounds until nothing else can be seen.
        frameX = clamp(frameX, -layout.bounds.width, 2 * layout.bounds.width);
        frameY = clamp(frameY, -layout.bounds.height, 2 * layout.bounds.height);
      }
    }
    // Where no left / top edge was moved the number is taken as it is, not through a sum.
    let x =
      growth.left === 0 && parentGrowth.left === 0
        ? frameX
        : frameX - growth.left + parentGrowth.left;
    let y =
      growth.top === 0 && parentGrowth.top === 0 ? frameY : frameY - growth.top + parentGrowth.top;
    // A node that was moved or resized stays inside its parent, and so does every child of a
    // parent that was resized: it may have lost the room the child was in.
    if (parentRect && (moved || resized || parentReshaped)) {
      x = clamp(x, 0, parentRect.width - across.length);
      y = clamp(y, 0, parentRect.height - down.length);
    }
    if (resized) reshaped.add(node.id);
    frames.set(node.id, {
      x: x + growth.left - parentGrowth.left,
      y: y + growth.top - parentGrowth.top,
      growth,
    });
    if (x !== rect.x || y !== rect.y || resized) changed = true;

    const placed = { x, y, width: across.length, height: down.length };
    rects.set(node.id, placed);
    const origin = parentAbsolute ?? { x: 0, y: 0 };
    const placedAbsolute = { ...placed, x: origin.x + x, y: origin.y + y };
    absolute.set(node.id, placedAbsolute);
    width = Math.max(width, placedAbsolute.x + placedAbsolute.width);
    height = Math.max(height, placedAbsolute.y + placedAbsolute.height);
    // A content block runs along the whole node.
    const block = placed.width === rect.width ? undefined : layout.content.get(node.id);
    if (block) {
      content ??= new Map(layout.content);
      content.set(node.id, { ...block, width: placed.width });
    }
  }
  if (!changed) return { layout, frames };
  return {
    layout: {
      ...layout,
      routeBase: layout.routeBase ?? layout,
      rects,
      absolute,
      bounds: { width, height },
      ...(content ? { content } : {}),
    },
    frames,
  };
}

/**
 * `layout` with what was set by hand: the moved nodes moved, the resized groups resized. A node
 * stays inside its parent's box, a resized group keeps its children where they are on the
 * canvas, and nothing else moves: no other node, no row band, not the layout key (the view is
 * the same layout, rearranged by hand). The bounds grow to cover what lies beyond them. Unknown
 * IDs, sizes of nodes without children and values that are not finite are ignored; without
 * effective overrides the very same `layout` is returned.
 */
export function applyHandOverrides(
  model: ArchitectureModel,
  layout: LayoutResult,
  by: HandOverrides,
): LayoutResult {
  return place(model, layout, by).layout;
}

/** `layout` with the moved nodes moved: {@link applyHandOverrides} with positions alone. */
export function applyPositionOverrides(
  model: ArchitectureModel,
  layout: LayoutResult,
  overrides: PositionOverrides,
): LayoutResult {
  return applyHandOverrides(model, layout, { positions: overrides, sizes: NO_SIZE_OVERRIDES });
}

/** How far each edge of every resized group is drawn moved; groups at the layout's size are absent. */
export function appliedGrowth(
  model: ArchitectureModel,
  layout: LayoutResult,
  by: HandOverrides,
): ReadonlyMap<string, EdgeGrowth> {
  const applied = new Map<string, EdgeGrowth>();
  for (const [id, frame] of place(model, layout, by).frames) {
    if (!isZero(frame.growth)) applied.set(id, frame.growth);
  }
  return applied;
}

// --- Limits -----------------------------------------------------------------------------------

/** How far each edge of a group can be moved by hand from where it is drawn. */
export interface ResizeLimits {
  /** The box the limits hold for: the group as drawn. */
  readonly width: number;
  readonly height: number;
  /** How far each edge may move inwards: whole pixels >= 0. */
  readonly inward: EdgeGrowth;
  /** How far each edge may move outwards: whole pixels >= 0. */
  readonly outward: EdgeGrowth;
}

/** The limits of a group, and the two things its inward limits are made of, in whole pixels. */
interface Room {
  readonly limits: ResizeLimits;
  /** How far each edge may move inwards before a child is too near to it. */
  readonly free: EdgeGrowth;
  /** How much shorter the box may get along each axis, whichever of its edges move. */
  readonly spare: Size;
}

/** The room of the group `node` as `placed` draws it; `base` is the arrangement it was made of. */
function roomOf(
  base: LayoutResult,
  placed: Placed,
  node: ArchNode,
  content?: ReadonlyMap<string, Size>,
): Room | undefined {
  const rect = placed.layout.rects.get(node.id);
  const was = base.rects.get(node.id);
  if (!rect || !was || node.childIds.length === 0) return undefined;
  const block = blockOf(base, node.id, content);
  // What the children keep to each edge: the padding, or the less the arrangement itself left.
  const keep = { ...groupPadding(block) };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const child of node.childIds) {
    const drawn = placed.layout.rects.get(child);
    const arranged = base.rects.get(child);
    if (!drawn || !arranged) continue;
    minX = Math.min(minX, drawn.x);
    minY = Math.min(minY, drawn.y);
    maxX = Math.max(maxX, drawn.x + drawn.width);
    maxY = Math.max(maxY, drawn.y + drawn.height);
    keep.left = Math.min(keep.left, arranged.x);
    keep.top = Math.min(keep.top, arranged.y);
    keep.right = Math.min(keep.right, was.width - arranged.x - arranged.width);
    keep.bottom = Math.min(keep.bottom, was.height - arranged.y - arranged.height);
  }
  // Never below what its header needs, unless the arrangement itself made the box smaller.
  const spare = {
    width: wholePixels(rect.width - Math.min(was.width, groupMinWidth(node, block))),
    height: wholePixels(rect.height - Math.min(was.height, groupMinHeight(block))),
  };
  const free: EdgeGrowth = {
    left: wholePixels(minX - keep.left),
    top: wholePixels(minY - keep.top),
    right: wholePixels(rect.width - maxX - keep.right),
    bottom: wholePixels(rect.height - maxY - keep.bottom),
  };
  const inward: EdgeGrowth = {
    left: Math.min(free.left, spare.width),
    top: Math.min(free.top, spare.height),
    right: Math.min(free.right, spare.width),
    bottom: Math.min(free.bottom, spare.height),
  };
  return {
    limits: {
      width: rect.width,
      height: rect.height,
      inward,
      outward: outwardRoom(base, placed, node, rect),
    },
    free,
    spare,
  };
}

/** How far each edge of the group `node`, drawn at `rect`, may move outwards. */
function outwardRoom(base: LayoutResult, placed: Placed, node: ArchNode, rect: Rect): EdgeGrowth {
  const parent = node.parentId === undefined ? undefined : placed.layout.rects.get(node.parentId);
  if (parent && node.parentId !== undefined) {
    // A nested group stops at its parent's border; the title bar of the parent, and the parent's
    // own work items below it, stay free.
    const parentTop = HEADER_HEIGHT + (base.content.get(node.parentId)?.height ?? 0);
    return {
      left: wholePixels(rect.x),
      top: wholePixels(rect.y - parentTop),
      right: wholePixels(parent.width - rect.x - rect.width),
      bottom: wholePixels(parent.height - rect.y - rect.height),
    };
  }
  // A top-level group: each edge goes outward by the map's own size at most, in total.
  const growth = placed.frames.get(node.id)?.growth ?? NO_GROWTH;
  return {
    left: wholePixels(base.bounds.width - growth.left),
    top: wholePixels(base.bounds.height - growth.top),
    right: wholePixels(base.bounds.width - growth.right),
    bottom: wholePixels(base.bounds.height - growth.bottom),
  };
}

/**
 * The limits of the group `id` as `base` with `by` draws it; undefined for anything else. `base`
 * is the arrangement before anything by hand, `content` what it was computed with.
 */
export function resizeLimits(
  model: ArchitectureModel,
  base: LayoutResult,
  by: HandOverrides,
  id: string,
  content?: ReadonlyMap<string, Size>,
): ResizeLimits | undefined {
  const node = model.nodes.get(id);
  return node && roomOf(base, place(model, base, by), node, content)?.limits;
}

/** The limits of every group that has a rectangle, in model order. */
export function allResizeLimits(
  model: ArchitectureModel,
  base: LayoutResult,
  by: HandOverrides,
  content?: ReadonlyMap<string, Size>,
): ReadonlyMap<string, ResizeLimits> {
  const placed = place(model, base, by);
  const all = new Map<string, ResizeLimits>();
  for (const node of model.nodes.values()) {
    const room = roomOf(base, placed, node, content);
    if (room) all.set(node.id, room.limits);
  }
  return all;
}

// --- Changes by hand --------------------------------------------------------------------------

/**
 * `by` after node `id` was dropped `delta` away from where `base` with `by` draws it. The
 * position is counted from what the node's stored one stands for as it is drawn now, so it is
 * right whatever box the node was drawn with (full or shrunk, resized or not). A drop that
 * moves nothing by a whole pixel gives `by` itself; the sizes are never touched.
 */
export function movedByHand(
  by: HandOverrides,
  model: ArchitectureModel,
  base: LayoutResult,
  id: string,
  delta: Position,
): HandOverrides {
  const rect = base.rects.get(id);
  if (!rect || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return by;
  if (Math.round(delta.x) === 0 && Math.round(delta.y) === 0) return by;
  const from = place(model, base, by).frames.get(id) ?? rect;
  const positions = new Map(by.positions);
  positions.set(id, { x: Math.round(from.x + delta.x), y: Math.round(from.y + delta.y) });
  return { positions, sizes: by.sizes };
}

/**
 * The moves of the two edges of one axis (outward; negative: inward), cut so that the box gets
 * shorter by no more than `spare`. An edge that moves outward leaves the other one that much
 * more to move inward; of two edges pulled in, the right / bottom one (`far`) stops first.
 */
function withinSpare(near: number, far: number, spare: number): [number, number] {
  const farKept = far < 0 ? Math.min(0, Math.max(far, -spare - near)) : far;
  const nearKept = near < 0 ? Math.min(0, Math.max(near, -spare - farKept)) : near;
  return [nearKept, farKept];
}

/** `by` after the edges of `node`, drawn as `placed` has it, were moved outward by `delta`. */
function withEdgesMoved(
  by: HandOverrides,
  base: LayoutResult,
  placed: Placed,
  node: ArchNode,
  delta: Partial<EdgeGrowth>,
  content?: ReadonlyMap<string, Size>,
): HandOverrides {
  const room = roomOf(base, placed, node, content);
  if (!room) return by;
  const { limits, free, spare } = room;
  /**
   * How far the edge `name` goes of what was asked, in whole pixels: outwards as far as its
   * limit, inwards as far as the children let it.
   */
  const moved = (name: EdgeName): number => {
    const asked = delta[name] ?? 0;
    if (!Number.isFinite(asked)) return 0;
    return clamp(Math.round(asked), -free[name], limits.outward[name]);
  };
  const [left, right] = withinSpare(moved('left'), moved('right'), spare.width);
  const [top, bottom] = withinSpare(moved('top'), moved('bottom'), spare.height);
  const applied = placed.frames.get(node.id)?.growth ?? NO_GROWTH;
  // Whole pixels, as a size is applied: an edge may be drawn at a fraction where a stored size
  // did not fit and was cut. (`|| 0`: a move of less than half a pixel inward is none, not -0.)
  const next: EdgeGrowth = {
    left: Math.round(applied.left + left) || 0,
    top: Math.round(applied.top + top) || 0,
    right: Math.round(applied.right + right) || 0,
    bottom: Math.round(applied.bottom + bottom) || 0,
  };
  const stored = by.sizes.get(node.id);
  if (stored ? EDGES.every((name) => stored[name] === next[name]) : isZero(next)) return by;
  const sizes = new Map(by.sizes);
  if (isZero(next)) sizes.delete(node.id);
  else sizes.set(node.id, next);
  return { positions: by.positions, sizes: sizes.size > 0 ? sizes : NO_SIZE_OVERRIDES };
}

/**
 * `by` after the edges of the group `id` were moved outward by `delta` from where it is drawn
 * (`base` with `by`; `content` is what `base` was computed with). An edge moved alone goes as
 * far as its limit ({@link resizeLimits}) and no further. Where both edges of one axis move,
 * each still stops at the children and at its outward limit, and together they leave the box no
 * smaller than one of them alone could make it: an edge that moves outward lets the other one
 * in by as much. Anything but a group that is drawn, and a change that moves no edge, give `by`
 * itself; a group back at the size of the arrangement has no entry. What is stored is whole
 * pixels, also where the boxes of `base` are not on whole pixels. The positions are never
 * touched: what is inside the group stays where it is.
 */
export function resizedByHand(
  by: HandOverrides,
  model: ArchitectureModel,
  base: LayoutResult,
  id: string,
  delta: Partial<EdgeGrowth>,
  content?: ReadonlyMap<string, Size>,
): HandOverrides {
  const node = model.nodes.get(id);
  return node ? withEdgesMoved(by, base, place(model, base, by), node, delta, content) : by;
}

/**
 * `by` with the group `id` as near the size the layout gave it as what is inside it and around
 * it allows: an edge that was moved outward stops at what was moved into the room, one that was
 * moved inward at the parent's border.
 */
export function sizeResetByHand(
  by: HandOverrides,
  model: ArchitectureModel,
  base: LayoutResult,
  id: string,
  content?: ReadonlyMap<string, Size>,
): HandOverrides {
  const node = model.nodes.get(id);
  if (!node) return by;
  const placed = place(model, base, by);
  const applied = placed.frames.get(id)?.growth ?? NO_GROWTH;
  const back = {
    left: -applied.left,
    top: -applied.top,
    right: -applied.right,
    bottom: -applied.bottom,
  };
  return withEdgesMoved(by, base, placed, node, back, content);
}

/** The edges moved outward between two rectangles of the same node (start and end of a gesture). */
export function growthBetween(start: Rect, end: Rect): EdgeGrowth {
  return {
    left: start.x - end.x,
    top: start.y - end.y,
    right: end.x + end.width - (start.x + start.width),
    bottom: end.y + end.height - (start.y + start.height),
  };
}

/** Where a group has a resize control: the middle of each edge, and each corner. */
export const RESIZE_CONTROLS = [
  'top',
  'right',
  'bottom',
  'left',
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
] as const;
export type ResizeControlPosition = (typeof RESIZE_CONTROLS)[number];

/** The sizes the control at `position` may give the box of `limits`: only for the edges it moves. */
export function controlBounds(
  limits: ResizeLimits,
  position: ResizeControlPosition,
): { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number } {
  const moved: readonly string[] = position.split('-');
  const bounds: { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number } =
    {};
  for (const edge of EDGES) {
    if (!moved.includes(edge)) continue;
    if (edge === 'left' || edge === 'right') {
      bounds.minWidth = limits.width - limits.inward[edge];
      bounds.maxWidth = limits.width + limits.outward[edge];
    } else {
      bounds.minHeight = limits.height - limits.inward[edge];
      bounds.maxHeight = limits.height + limits.outward[edge];
    }
  }
  return bounds;
}

/** How far one press of an arrow key moves an edge, in canvas pixels. */
export const RESIZE_KEY_STEP = 8;

/**
 * What an arrow key on the grip does; undefined for any other key. The arrow says where the edge
 * goes: the right or the bottom one, with Shift the left or the top one.
 */
export function keyGrowth(key: string, shift: boolean): Partial<EdgeGrowth> | undefined {
  const step = RESIZE_KEY_STEP;
  switch (key) {
    case 'ArrowRight':
      return shift ? { left: -step } : { right: step };
    case 'ArrowLeft':
      return shift ? { left: step } : { right: -step };
    case 'ArrowDown':
      return shift ? { top: -step } : { bottom: step };
    case 'ArrowUp':
      return shift ? { top: step } : { bottom: -step };
    default:
      return undefined;
  }
}

/** "2 moved · 1 resized", as the Layout tab says it; undefined when nothing was set by hand. */
export function handCountText(moved: number, resized: number): string | undefined {
  const parts: string[] = [];
  if (moved > 0) parts.push(`${moved} moved`);
  if (resized > 0) parts.push(`${resized} resized`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

// --- Storage --------------------------------------------------------------------------------

export const POSITIONS_STORAGE_PREFIX = 'architecture-map.positions:';

/**
 * `localStorage` key of the positions set by hand on the layout with `layoutKey`: they are
 * offsets within one computed arrangement, so each arrangement (rows shown or hidden, another
 * story mode, an edited structure) has its own.
 */
export function positionsStorageKey(layoutKey: string): string {
  return `${POSITIONS_STORAGE_PREFIX}${layoutKey}`;
}

export function serializePositions(overrides: PositionOverrides): string {
  return JSON.stringify(Object.fromEntries([...overrides].map(([id, p]) => [id, [p.x, p.y]])));
}

/** Overrides from stored text; anything that is not `{ id: [x, y] }` with numbers is dropped. */
export function parsePositions(text: string | null | undefined): PositionOverrides {
  if (!text) return NO_POSITION_OVERRIDES;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return NO_POSITION_OVERRIDES;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return NO_POSITION_OVERRIDES;
  }
  const overrides = new Map<string, Position>();
  for (const [id, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [x, y] = entry as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    overrides.set(id, { x, y });
  }
  return overrides.size > 0 ? overrides : NO_POSITION_OVERRIDES;
}

export function readPositions(
  storage: ViewStateStorage | undefined,
  layoutKey: string,
): PositionOverrides {
  try {
    return parsePositions(storage?.getItem(positionsStorageKey(layoutKey)));
  } catch {
    return NO_POSITION_OVERRIDES;
  }
}

/** Stores the overrides of a layout; an empty set removes the entry where the storage can. */
export function writePositions(
  storage: ViewStateStorage | undefined,
  layoutKey: string,
  overrides: PositionOverrides,
): void {
  try {
    storage?.setItem(positionsStorageKey(layoutKey), serializePositions(overrides));
  } catch {
    // Storage full or blocked: the positions simply are not remembered.
  }
}

export const SIZES_STORAGE_PREFIX = 'architecture-map.sizes:';

/**
 * `localStorage` key of the sizes set by hand on the layout with `layoutKey`: an entry of its
 * own beside the positions of the same arrangement ({@link positionsStorageKey}).
 */
export function sizesStorageKey(layoutKey: string): string {
  return `${SIZES_STORAGE_PREFIX}${layoutKey}`;
}

export function serializeSizes(sizes: SizeOverrides): string {
  return JSON.stringify(
    Object.fromEntries([...sizes].map(([id, g]) => [id, [g.left, g.top, g.right, g.bottom]])),
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Sizes from stored text; anything that is not `{ id: [left, top, right, bottom] }` is dropped. */
export function parseSizes(text: string | null | undefined): SizeOverrides {
  if (!text) return NO_SIZE_OVERRIDES;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return NO_SIZE_OVERRIDES;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return NO_SIZE_OVERRIDES;
  }
  const sizes = new Map<string, EdgeGrowth>();
  for (const [id, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || entry.length !== 4) continue;
    const [left, top, right, bottom] = entry as unknown[];
    if (!isFiniteNumber(left) || !isFiniteNumber(top)) continue;
    if (!isFiniteNumber(right) || !isFiniteNumber(bottom)) continue;
    const growth = { left, top, right, bottom };
    // A group whose edges are where the arrangement put them has no size by hand.
    if (!isZero(growth)) sizes.set(id, growth);
  }
  return sizes.size > 0 ? sizes : NO_SIZE_OVERRIDES;
}

/** Both entries of the arrangement `layoutKey`; never throws. */
export function readHandOverrides(
  storage: ViewStateStorage | undefined,
  layoutKey: string,
): HandOverrides {
  const positions = readPositions(storage, layoutKey);
  let sizes = NO_SIZE_OVERRIDES;
  try {
    sizes = parseSizes(storage?.getItem(sizesStorageKey(layoutKey)));
  } catch {
    // Blocked storage: nothing was resized.
  }
  return positions === NO_POSITION_OVERRIDES && sizes === NO_SIZE_OVERRIDES
    ? NO_HAND_OVERRIDES
    : { positions, sizes };
}

/**
 * Stores what changed from `previous`: an entry whose map is the same object is not written, so
 * moving a node never creates a sizes entry and resizing never rewrites the positions. An empty
 * map is stored as an empty entry. Never throws.
 */
export function writeHandOverrides(
  storage: ViewStateStorage | undefined,
  layoutKey: string,
  next: HandOverrides,
  previous: HandOverrides,
): void {
  if (next.positions !== previous.positions) writePositions(storage, layoutKey, next.positions);
  if (next.sizes === previous.sizes) return;
  try {
    storage?.setItem(sizesStorageKey(layoutKey), serializeSizes(next.sizes));
  } catch {
    // Storage full or blocked: the sizes simply are not remembered.
  }
}
