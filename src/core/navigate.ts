// Finding one's way around the model: ancestors and breadcrumb, the edges of a
// node, the edge-kind filter, revealing hidden nodes (expanding groups, the zoom whose level of
// detail shows them) and the viewport that brings something on screen.
// Pure: no React, no browser APIs.

import type { LayoutResult, Rect, Size } from './layout/types';
import { LOD_CONFIG, lodModeToReveal, lodThreshold, type LodConfig, type LodMode } from './lod';
import type { ArchEdge, ArchitectureModel, ArchNode, EdgeKind } from './model';
import { LOD_LEVELS, LOD_MAX_LEVEL, type LodLevel } from './visibility';

// --- Hierarchy ------------------------------------------------------------------------------

/** IDs of the ancestors of `id`, outermost (the domain) first; empty for a domain or unknown ID. */
export function ancestorsOf(model: ArchitectureModel, id: string): string[] {
  const ancestors: string[] = [];
  let current = model.nodes.get(id)?.parentId;
  while (current !== undefined) {
    ancestors.unshift(current);
    current = model.nodes.get(current)?.parentId;
  }
  return ancestors;
}

/** Breadcrumb of `id`: its ancestors, outermost first, then the node itself. Empty if unknown. */
export function nodePath(model: ArchitectureModel, id: string): ArchNode[] {
  const node = model.nodes.get(id);
  if (!node) return [];
  const path: ArchNode[] = [];
  for (const ancestor of ancestorsOf(model, id)) {
    const found = model.nodes.get(ancestor);
    if (found) path.push(found);
  }
  path.push(node);
  return path;
}

/** True when `id` is `ancestorId` or lies anywhere below it. */
export function isSelfOrDescendant(
  model: ArchitectureModel,
  id: string,
  ancestorId: string,
): boolean {
  let current: string | undefined = id;
  while (current !== undefined) {
    if (current === ancestorId) return true;
    current = model.nodes.get(current)?.parentId;
  }
  return false;
}

// --- Edges of a node ------------------------------------------------------------------------

/** A model edge seen from a node: which end is at (or inside) the node. */
export interface NodeEdgeRef {
  readonly edge: ArchEdge;
  /** The end of the edge at the node: the node's own ID, or the ID of a descendant. */
  readonly endId: string;
  /** The node at the far end of the edge. */
  readonly otherId: string;
  /** True when the edge is attached to the node itself, false when to one of its descendants. */
  readonly own: boolean;
}

export interface NodeEdges {
  /** Edges ending at the node or inside it and starting outside it, in document order. */
  readonly incoming: NodeEdgeRef[];
  /** Edges starting at the node or inside it and ending outside it, in document order. */
  readonly outgoing: NodeEdgeRef[];
  /** Edges with both ends at or inside the node, in document order. */
  readonly internal: ArchEdge[];
}

/**
 * The original (never rolled-up) edges of `id`, including those of its descendants; each entry
 * says whether it is the node's own (`own`) and which descendant it belongs to (`endId`).
 */
export function nodeEdges(model: ArchitectureModel, id: string): NodeEdges {
  const result: NodeEdges = { incoming: [], outgoing: [], internal: [] };
  if (!model.nodes.has(id)) return result;
  const inside = new Map<string, boolean>();
  const isInside = (nodeId: string): boolean => {
    let known = inside.get(nodeId);
    if (known === undefined) {
      known = isSelfOrDescendant(model, nodeId, id);
      inside.set(nodeId, known);
    }
    return known;
  };
  for (const edge of model.edges) {
    const fromInside = isInside(edge.from);
    const toInside = isInside(edge.to);
    if (fromInside && toInside) result.internal.push(edge);
    else if (fromInside) {
      result.outgoing.push({ edge, endId: edge.from, otherId: edge.to, own: edge.from === id });
    } else if (toInside) {
      result.incoming.push({ edge, endId: edge.to, otherId: edge.from, own: edge.to === id });
    }
  }
  return result;
}

// --- Edge-kind filter -----------------------------------------------------------------------

/** The edges whose kind is not hidden, in their original order. Applied before the rollup. */
export function filterEdgesByKind(
  edges: readonly ArchEdge[],
  hiddenKinds: ReadonlySet<EdgeKind>,
): ArchEdge[] {
  return edges.filter((edge) => !hiddenKinds.has(edge.kind));
}

/**
 * `model` without the edges of the hidden kinds (nodes and rows untouched), for the flow mapping:
 * aggregates and their counts then only cover what is shown. Returns `model` itself when nothing
 * is hidden.
 */
export function withoutEdgeKinds(
  model: ArchitectureModel,
  hiddenKinds: ReadonlySet<EdgeKind>,
): ArchitectureModel {
  if (hiddenKinds.size === 0) return model;
  return { ...model, edges: filterEdgesByKind(model.edges, hiddenKinds) };
}

/** A copy of `kinds` with `kind` added if absent, removed if present. */
export function toggleEdgeKind(kinds: ReadonlySet<EdgeKind>, kind: EdgeKind): Set<EdgeKind> {
  const next = new Set(kinds);
  if (!next.delete(kind)) next.add(kind);
  return next;
}

// --- Revealing ------------------------------------------------------------------------------

/**
 * A new collapsed set in which every ancestor of each of `ids` is expanded, so that the nodes
 * themselves are no longer hidden by a manual collapse. The nodes themselves stay as they are
 * (a collapsed group that is revealed stays collapsed); unknown IDs are ignored.
 */
export function expandToReveal(
  model: ArchitectureModel,
  collapsedIds: ReadonlySet<string>,
  ids: Iterable<string>,
): Set<string> {
  const next = new Set(collapsedIds);
  for (const id of ids) for (const ancestor of ancestorsOf(model, id)) next.delete(ancestor);
  return next;
}

/**
 * A new collapsed set in which each of `ids` is open and not hidden: the node itself and every
 * ancestor are expanded. This is what shows the work items listed in a node, which a closed
 * group replaces by a badge.
 */
export function expandToOpen(
  model: ArchitectureModel,
  collapsedIds: ReadonlySet<string>,
  ids: Iterable<string>,
): Set<string> {
  const all = [...ids];
  const next = expandToReveal(model, collapsedIds, all);
  for (const id of all) next.delete(id);
  return next;
}

/** The coarsest level of detail that draws node `id`; undefined for an unknown ID. */
export function minLodForNode(model: ArchitectureModel, id: string): LodLevel | undefined {
  const node = model.nodes.get(id);
  if (!node) return undefined;
  return LOD_LEVELS.find((level) => LOD_MAX_LEVEL[level] >= node.level);
}

/** Extra relative zoom beyond the hysteresis band when zooming in to reveal something. */
export const REVEAL_ZOOM_MARGIN = 0.05;

/**
 * The lowest zoom to move to so that `level` (or a finer one) is certainly shown: past the
 * level's threshold, past its hysteresis band — so it holds whatever level was shown before —
 * and `margin` beyond that. 0 for `domains`, which every zoom shows.
 */
export function lodRevealZoom(
  level: LodLevel,
  config: LodConfig = LOD_CONFIG,
  margin: number = REVEAL_ZOOM_MARGIN,
): number {
  if (level === 'domains') return 0;
  return lodThreshold(level, config) * (1 + config.hysteresis) * (1 + margin);
}

/**
 * The mode to switch to so that `needed` (or a finer level) gets drawn: as
 * {@link lodModeToReveal}, except that `auto` gives way to `needed` pinned when no zoom the
 * canvas allows reaches that level — its threshold was moved to the top of the zoom range.
 */
export function lodModeToDraw(
  mode: LodMode,
  needed: LodLevel,
  config: LodConfig = LOD_CONFIG,
  range: ZoomRange = ZOOM_RANGE,
): LodMode {
  if (mode === 'auto' && lodRevealZoom(needed, config) > range.max) return needed;
  return lodModeToReveal(mode, needed);
}

/** {@link lodRevealZoom} for the level of detail that draws all of `ids` (unknown IDs ignored). */
export function revealZoomForNodes(
  model: ArchitectureModel,
  ids: Iterable<string>,
  config: LodConfig = LOD_CONFIG,
): number {
  let zoom = 0;
  for (const id of ids) {
    const level = minLodForNode(model, id);
    if (level !== undefined) zoom = Math.max(zoom, lodRevealZoom(level, config));
  }
  return zoom;
}

// --- Viewport -------------------------------------------------------------------------------

/** Pan and zoom of the canvas, as React Flow has it: screen = canvas * zoom + (x, y). */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface ZoomRange {
  readonly min: number;
  readonly max: number;
}

/** Zoom limits of the canvas. */
export const ZOOM_RANGE: ZoomRange = { min: 0.05, max: 4 };

/**
 * Highest zoom a fit to view goes to. A small map would otherwise be magnified up to
 * `ZOOM_RANGE.max` (one box filling the window); this is just past the detail threshold of the
 * level of detail, so a small map still opens with everything shown.
 */
export const FIT_MAX_ZOOM = 1.25;

export function isValidViewport(value: Viewport, range: ZoomRange = ZOOM_RANGE): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.zoom) &&
    value.zoom >= range.min &&
    value.zoom <= range.max
  );
}

/** The smallest rectangle containing all of `rects`; undefined for none. */
export function unionRect(rects: readonly Rect[]): Rect | undefined {
  const [first] = rects;
  if (!first) return undefined;
  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `rect` (canvas coordinates) in screen coordinates under `viewport`. */
export function toScreen(rect: Rect, viewport: Viewport): Rect {
  return {
    x: rect.x * viewport.zoom + viewport.x,
    y: rect.y * viewport.zoom + viewport.y,
    width: rect.width * viewport.zoom,
    height: rect.height * viewport.zoom,
  };
}

/** True when all of `rect` (canvas coordinates) is on a screen of `size`. */
export function isFullyOnScreen(rect: Rect, viewport: Viewport, size: Size): boolean {
  const s = toScreen(rect, viewport);
  const slack = 1e-6;
  return (
    s.x >= -slack &&
    s.y >= -slack &&
    s.x + s.width <= size.width + slack &&
    s.y + s.height <= size.height + slack
  );
}

/** How much of the map must be on screen for a stored viewport to be worth restoring. */
export const MIN_VISIBLE_MAP = 48;

/**
 * True when a useful part of `rect` (canvas coordinates) is on a screen of `size`: at least
 * `margin` screen pixels of it in each direction — or all of it, or the whole screen, where
 * those are smaller. A sliver at the edge of the screen does not count.
 */
export function showsEnoughOf(
  rect: Rect,
  viewport: Viewport,
  size: Size,
  margin: number = MIN_VISIBLE_MAP,
): boolean {
  const s = toScreen(rect, viewport);
  const enough = (start: number, length: number, screen: number): boolean => {
    const overlap = Math.min(start + length, screen) - Math.max(start, 0);
    return overlap > 0 && overlap >= Math.min(margin, length, screen) - 1e-6;
  };
  return enough(s.x, s.width, size.width) && enough(s.y, s.height, size.height);
}

export interface RevealOptions {
  /** Lowest acceptable zoom (see {@link lodRevealZoom}); wins over fitting the target. */
  readonly minZoom?: number;
  readonly zoomRange?: ZoomRange;
  /** Free space kept around the target, in screen pixels. */
  readonly padding?: number;
  /**
   * The part of the target that must end up on screen whatever happens (for an edge: its
   * source). Matters when the target does not fit at `minZoom`.
   */
  readonly primary?: Rect;
}

export const REVEAL_PADDING = 48;

/**
 * The viewport that brings `target` (canvas coordinates) on a screen of `size`, moving as little
 * as possible:
 * - the zoom stays as it is unless it is below `minZoom` (then it is raised to it) or too high
 *   for the target to fit with `padding` around it (then it is lowered, but never below
 *   `minZoom`: showing the target at all comes before showing all of it);
 * - if the target is then already entirely on screen, nothing changes and `current` itself is
 *   returned; otherwise the target is centred;
 * - when the target does not fit at that zoom (along an axis) and a `primary` part is given, the
 *   view is moved along that axis from the centred position just far enough for the primary part
 *   to be entirely on screen with `padding` around it: one end of a long edge is then shown, with
 *   the view reaching as far toward the other end as it can, instead of the empty middle between
 *   them. Along an axis on which the whole target fits it stays centred, so all of it is shown.
 */
export function viewportToReveal(
  current: Viewport,
  target: Rect,
  size: Size,
  options: RevealOptions = {},
): Viewport {
  const range = options.zoomRange ?? ZOOM_RANGE;
  const padding = options.padding ?? REVEAL_PADDING;
  const clamp = (zoom: number): number => Math.min(range.max, Math.max(range.min, zoom));
  if (!(size.width > 0 && size.height > 0)) return current;

  const availableWidth = Math.max(size.width - 2 * padding, size.width / 2);
  const availableHeight = Math.max(size.height - 2 * padding, size.height / 2);
  const fit = Math.min(
    target.width > 0 ? availableWidth / target.width : Infinity,
    target.height > 0 ? availableHeight / target.height : Infinity,
  );
  const zoom = clamp(Math.max(options.minZoom ?? 0, Math.min(current.zoom, fit)));

  if (zoom === current.zoom && isFullyOnScreen(target, current, size)) return current;

  const { primary } = options;
  /** Translation along one axis: the target centred, then the primary part pulled on screen. */
  const translate = (
    screen: number,
    start: number,
    length: number,
    primaryStart: number | undefined,
    primaryLength: number,
  ): number => {
    const centred = screen / 2 - (start + length / 2) * zoom;
    // The whole target fits along this axis: centred, all of it is on screen.
    if (primaryStart === undefined || length * zoom <= screen) return centred;
    const pad = Math.max(0, Math.min(padding, (screen - primaryLength * zoom) / 2));
    const lowest = pad - primaryStart * zoom;
    const highest = screen - pad - (primaryStart + primaryLength) * zoom;
    // Larger than the screen: centre the primary part itself.
    if (lowest > highest) return (lowest + highest) / 2;
    return Math.min(highest, Math.max(lowest, centred));
  };
  return {
    x: translate(size.width, target.x, target.width, primary?.x, primary?.width ?? 0),
    y: translate(size.height, target.y, target.height, primary?.y, primary?.height ?? 0),
    zoom,
  };
}

// --- Row of a node --------------------------------------------------------------------------

/** How a node relates to the row bands, for the detail panel. */
export type NodeRowInfo =
  /** In one row: its own, an ancestor's, or the one row its subtree uses. */
  | { readonly kind: 'row'; readonly name: string }
  /** No row of its own: placed in this row by its connections. */
  | { readonly kind: 'placed'; readonly name: string }
  /** A group spanning the rows from `from` (top) to `to` (bottom). */
  | { readonly kind: 'spans'; readonly from: string; readonly to: string }
  /** Nothing in its subtree has a row: it sits in the Unassigned area. */
  | { readonly kind: 'unassigned' };

/** Row information of `id`; undefined when the model has no rows at all or the ID is unknown. */
export function nodeRowInfo(
  model: ArchitectureModel,
  layout: Pick<LayoutResult, 'placedRow' | 'rowOf'>,
  id: string,
): NodeRowInfo | undefined {
  const node = model.nodes.get(id);
  if (!node || model.rows.length === 0) return undefined;
  const nameOf = (rowId: string): string =>
    model.rows.find((row) => row.id === rowId)?.name ?? rowId;

  if (node.effectiveRow !== undefined) return { kind: 'row', name: nameOf(node.effectiveRow) };
  const placed = layout.placedRow.get(id);
  if (placed !== undefined) return { kind: 'placed', name: nameOf(placed) };
  if (node.rowRange) {
    const top = model.rows[node.rowRange.top];
    const bottom = model.rows[node.rowRange.bottom];
    if (top && bottom) {
      return top === bottom
        ? { kind: 'row', name: top.name }
        : { kind: 'spans', from: top.name, to: bottom.name };
    }
  }
  // Below a node placed by its connections: in that ancestor's row.
  const inherited = layout.rowOf.get(id);
  if (inherited !== undefined) return { kind: 'row', name: nameOf(inherited) };
  return { kind: 'unassigned' };
}

/** {@link NodeRowInfo} as shown in the detail panel. */
export function rowInfoText(info: NodeRowInfo): string {
  switch (info.kind) {
    case 'row':
      return info.name;
    case 'placed':
      return `${info.name} — placed by connections`;
    case 'spans':
      return `spans ${info.from}–${info.to}`;
    case 'unassigned':
      return 'Unassigned';
  }
}

// --- Keeping the place across layouts ---------------------------------------------------------

/**
 * The viewport that shows, in another layout of the same model, the place `current` shows now
 * (the layout changed because the work-item content did — another story mode, filter or file —
 * or because the map was reduced to a focus or made whole again, so one may lack nodes of the
 * other). The zoom is kept. The anchor is the innermost node under the middle of the screen:
 * the point of that node that is in the middle now (as a fraction of its box) is in the middle
 * afterwards. With no node under the middle, the nearest node keeps its distance to the middle.
 * Returns `current` itself when there is nothing to hold on to (no node in both layouts, no
 * screen).
 *
 * `before` and `after` are the absolute rectangles of the two layouts (`LayoutResult.absolute`).
 */
export function viewportKeepingPlace(
  current: Viewport,
  size: Size,
  before: ReadonlyMap<string, Rect>,
  after: ReadonlyMap<string, Rect>,
): Viewport {
  if (!(size.width > 0 && size.height > 0) || !(current.zoom > 0)) return current;
  const cx = (size.width / 2 - current.x) / current.zoom;
  const cy = (size.height / 2 - current.y) / current.zoom;
  let inside: { from: Rect; to: Rect } | undefined;
  let nearest: { from: Rect; to: Rect; distance: number } | undefined;
  for (const [id, from] of before) {
    const to = after.get(id);
    if (!to || !(from.width > 0 && from.height > 0)) continue;
    const dx = Math.max(from.x - cx, 0, cx - (from.x + from.width));
    const dy = Math.max(from.y - cy, 0, cy - (from.y + from.height));
    if (dx === 0 && dy === 0) {
      // The smallest box around the middle is the innermost node.
      if (!inside || from.width * from.height < inside.from.width * inside.from.height) {
        inside = { from, to };
      }
    } else {
      const distance = Math.hypot(dx, dy);
      if (!nearest || distance < nearest.distance) nearest = { from, to, distance };
    }
  }
  let tx: number;
  let ty: number;
  if (inside) {
    tx = inside.to.x + ((cx - inside.from.x) / inside.from.width) * inside.to.width;
    ty = inside.to.y + ((cy - inside.from.y) / inside.from.height) * inside.to.height;
  } else if (nearest) {
    tx = nearest.to.x + nearest.to.width / 2 + (cx - (nearest.from.x + nearest.from.width / 2));
    ty = nearest.to.y + nearest.to.height / 2 + (cy - (nearest.from.y + nearest.from.height / 2));
  } else {
    return current;
  }
  const next = {
    x: size.width / 2 - tx * current.zoom,
    y: size.height / 2 - ty * current.zoom,
    zoom: current.zoom,
  };
  return Math.abs(next.x - current.x) < 1e-6 && Math.abs(next.y - current.y) < 1e-6
    ? current
    : next;
}
