// Per-structure view state kept in `localStorage`: the last viewport and the hidden
// edge kinds. (The collapsed set is in ./visibility.) Every read and write is wrapped: without
// storage, with a storage that throws, or with a corrupt entry the app simply starts fresh.
// Pure: the storage is passed in.

import type { Size } from './layout/types';
import { isEdgeKind, type ArchitectureModel, type EdgeKind } from './model';
import {
  isValidViewport,
  showsEnoughOf,
  ZOOM_RANGE,
  type Viewport,
  type ZoomRange,
} from './navigate';
import { structureIdentity, type ViewStateStorage } from './visibility';

export const VIEWPORT_STORAGE_PREFIX = 'architecture-map.viewport:';
export const HIDDEN_KINDS_STORAGE_PREFIX = 'architecture-map.hidden-edge-kinds:';

/** `localStorage` key of the last viewport of `model`. */
export function viewportStorageKey(model: ArchitectureModel): string {
  return `${VIEWPORT_STORAGE_PREFIX}${structureIdentity(model)}`;
}

/** `localStorage` key of the hidden edge kinds of `model`. */
export function hiddenKindsStorageKey(model: ArchitectureModel): string {
  return `${HIDDEN_KINDS_STORAGE_PREFIX}${structureIdentity(model)}`;
}

function parseJson(text: string | null | undefined): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function safeGet(storage: ViewStateStorage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: ViewStateStorage | undefined, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// --- Viewport -------------------------------------------------------------------------------

/** Stored form of a viewport; coordinates rounded so that the entry stays short. */
export function serializeViewport(viewport: Viewport): string {
  const round = (value: number, digits: number): number => Number(value.toFixed(digits));
  return JSON.stringify({
    x: round(viewport.x, 1),
    y: round(viewport.y, 1),
    zoom: round(viewport.zoom, 4),
  });
}

/**
 * Reads a stored viewport: an object with finite numbers `x`, `y` and a `zoom` within
 * `zoomRange`. Anything else gives undefined.
 */
export function parseViewport(
  text: string | null | undefined,
  zoomRange: ZoomRange = ZOOM_RANGE,
): Viewport | undefined {
  const value = parseJson(text);
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y, zoom } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return undefined;
  const viewport: Viewport = { x, y, zoom };
  return isValidViewport(viewport, zoomRange) ? viewport : undefined;
}

/** True when `viewport` shows a useful part of a map of size `bounds` on a canvas of `screen`. */
export function viewportShowsMap(viewport: Viewport, bounds: Size, screen: Size): boolean {
  const map = { x: 0, y: 0, width: bounds.width, height: bounds.height };
  return showsEnoughOf(map, viewport, screen);
}

export interface ViewportCheck {
  readonly zoomRange?: ZoomRange;
  /**
   * Size of everything laid out (from the canvas origin), with the size of the canvas element
   * (not of the window: toolbar and panels take their share).
   */
  readonly content?: { readonly bounds: Size; readonly screen: Size };
}

/**
 * The viewport stored for `model`, or undefined when there is none, the storage fails, the entry
 * is not a valid viewport, or (with `check.content`) it would show none of the map, or only a
 * sliver of it at the edge ({@link showsEnoughOf}) — the caller then fits the view instead.
 */
export function readViewport(
  storage: ViewStateStorage | undefined,
  model: ArchitectureModel,
  check: ViewportCheck = {},
): Viewport | undefined {
  const viewport = parseViewport(safeGet(storage, viewportStorageKey(model)), check.zoomRange);
  if (!viewport) return undefined;
  if (check.content) {
    const { bounds, screen } = check.content;
    if (!viewportShowsMap(viewport, bounds, screen)) return undefined;
  }
  return viewport;
}

/** Stores the viewport of `model`. Returns false when it is invalid, or the storage fails. */
export function writeViewport(
  storage: ViewStateStorage | undefined,
  model: ArchitectureModel,
  viewport: Viewport,
): boolean {
  if (!isValidViewport(viewport, { min: Number.MIN_VALUE, max: Infinity })) return false;
  return safeSet(storage, viewportStorageKey(model), serializeViewport(viewport));
}

// --- Hidden edge kinds ----------------------------------------------------------------------

/** Stored form of the hidden edge kinds: a sorted JSON array. */
export function serializeHiddenKinds(kinds: ReadonlySet<EdgeKind>): string {
  return JSON.stringify([...kinds].sort());
}

/** Reads stored hidden edge kinds; anything that is not an array, or not a kind, is ignored. */
export function parseHiddenKinds(text: string | null | undefined): Set<EdgeKind> {
  const result = new Set<EdgeKind>();
  const value = parseJson(text);
  if (!Array.isArray(value)) return result;
  for (const entry of value as unknown[]) if (isEdgeKind(entry)) result.add(entry);
  return result;
}

/** The hidden edge kinds stored for `model`; none without storage or when it fails. */
export function readHiddenKinds(
  storage: ViewStateStorage | undefined,
  model: ArchitectureModel,
): Set<EdgeKind> {
  return parseHiddenKinds(safeGet(storage, hiddenKindsStorageKey(model)));
}

/** Stores the hidden edge kinds of `model`. Returns false without storage or when it fails. */
export function writeHiddenKinds(
  storage: ViewStateStorage | undefined,
  model: ArchitectureModel,
  kinds: ReadonlySet<EdgeKind>,
): boolean {
  return safeSet(storage, hiddenKindsStorageKey(model), serializeHiddenKinds(kinds));
}
