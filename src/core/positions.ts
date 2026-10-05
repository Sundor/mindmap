// Two ways the user can depart from the computed arrangement:
// - hiding the rows: the layout is then computed for the same model without its rows, so the
//   nodes are arranged by their connections alone (`withoutRows`);
// - moving nodes by hand (positions unlocked): the moved positions are kept as overrides and
//   applied on top of the computed layout (`applyPositionOverrides`). Nothing else moves.
// Pure: the storage is injected and nothing here throws.

import type { LayoutResult, Rect } from './layout/types';
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

/** Positions set by hand, relative to the parent node (top-level nodes: to the canvas origin). */
export type PositionOverrides = ReadonlyMap<string, Position>;

export const NO_POSITION_OVERRIDES: PositionOverrides = new Map();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * `layout` with the overridden nodes moved. A node inside a group stays inside that group's box;
 * its own contents move with it. Everything else keeps its place and size: no other node, no row
 * band, and the layout key (the view is the same layout, rearranged by hand). The bounds grow to
 * cover nodes moved beyond them. Unknown IDs are ignored; without effective overrides the very
 * same `layout` is returned.
 */
export function applyPositionOverrides(
  model: ArchitectureModel,
  layout: LayoutResult,
  overrides: PositionOverrides,
): LayoutResult {
  if (overrides.size === 0) return layout;
  const rects = new Map<string, Rect>();
  const absolute = new Map<string, Rect>();
  let moved = false;
  let { width, height } = layout.bounds;
  // Model order: parents before children, so a parent's new place is known first.
  for (const node of model.nodes.values()) {
    const rect = layout.rects.get(node.id);
    if (!rect) continue;
    const parentRect = node.parentId === undefined ? undefined : rects.get(node.parentId);
    const parentAbsolute = node.parentId === undefined ? undefined : absolute.get(node.parentId);
    const override = overrides.get(node.id);
    let { x, y } = rect;
    if (override && Number.isFinite(override.x) && Number.isFinite(override.y)) {
      x = Math.round(override.x);
      y = Math.round(override.y);
      if (parentRect) {
        x = clamp(x, 0, parentRect.width - rect.width);
        y = clamp(y, 0, parentRect.height - rect.height);
      } else {
        // A top-level node may leave the map, but not by more than the map's own size: a stored
        // position far outside would stretch the bounds until nothing else can be seen.
        x = clamp(x, -layout.bounds.width, 2 * layout.bounds.width);
        y = clamp(y, -layout.bounds.height, 2 * layout.bounds.height);
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
  if (!moved) return layout;
  return { ...layout, rects, absolute, bounds: { width, height } };
}

/**
 * The overrides after node `id` was dropped `delta` away from where it was drawn. The override
 * is taken from the node's current place in `layout` (which already has the earlier overrides
 * applied), so it is right whatever box the node was drawn with (full or shrunk).
 */
export function withNodeMoved(
  overrides: PositionOverrides,
  layout: LayoutResult,
  id: string,
  delta: Position,
): PositionOverrides {
  const rect = layout.rects.get(id);
  if (!rect || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return overrides;
  if (Math.round(delta.x) === 0 && Math.round(delta.y) === 0) return overrides;
  const next = new Map(overrides);
  next.set(id, { x: Math.round(rect.x + delta.x), y: Math.round(rect.y + delta.y) });
  return next;
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
