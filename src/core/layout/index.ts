// Layout engine entry point: `computeLayout(model)` with an in-memory cache
// and an optional persistent cache.

import { z } from '../zod';
import type { ArchitectureModel } from '../model';
import { CANVAS_PADDING, HEADER_HEIGHT, LAYOUT_CONFIG, LEAF_SIZE } from './constants';
import { layoutHierarchy } from './elk';
import { layoutKey } from './hash';
import { layoutWithRows } from './tiered';
import type { LayoutResult, Rect, Size } from './types';

export * from './constants';
export { buildHierarchyGraph, ELK_ROOT_ID, orderItems, type ContentSizes } from './elk';
export { fnv1a64, LAYOUT_ALGORITHM_VERSION, layoutKey, layoutStructureJson } from './hash';
export { sweep1D } from './sweep';
export {
  attractedRow,
  deriveAttractedRows,
  rowPlacement,
  type AttractionCandidate,
  type RowPlacement,
} from './tiered';
export { edgeContainer } from './tree';
export type { LayoutResult, Rect, RowBand, Size } from './types';

/** Minimal `Storage` subset used for the persistent cache (e.g. `window.localStorage`). */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ComputeLayoutOptions {
  /**
   * Persistent cache, e.g. `window.localStorage`. Optional; failures (quota, privacy mode,
   * corrupt entries) are ignored. Only the most recent layout is kept, under one key.
   */
  readonly storage?: LayoutStorage;
  /**
   * Blocks to reserve inside nodes, by node ID: what a node shows besides its name and children
   * (its work items). A leaf grows to hold its block below the name; a group keeps
   * it free between its header and its children and is at least as wide. Entries for unknown
   * nodes or without height are ignored. Where each block ended up is in `LayoutResult.content`.
   * The sizes are part of the cache key; without any the layout is exactly the plain one.
   */
  readonly content?: ReadonlyMap<string, Size>;
}

/** The entries of `content` that reserve something in `model`, in model order. */
function usedContent(
  model: ArchitectureModel,
  content: ReadonlyMap<string, Size> | undefined,
): Map<string, Size> {
  const used = new Map<string, Size>();
  if (!content) return used;
  for (const id of model.nodes.keys()) {
    const size = content.get(id);
    if (size && size.height > 0) used.set(id, { width: size.width, height: size.height });
  }
  return used;
}

/** Where the content blocks lie inside their nodes, given the nodes' rectangles. */
function contentRects(
  model: ArchitectureModel,
  rects: ReadonlyMap<string, Rect>,
  content: ReadonlyMap<string, Size>,
): Map<string, Rect> {
  const blocks = new Map<string, Rect>();
  for (const [id, size] of content) {
    const node = model.nodes.get(id);
    const rect = rects.get(id);
    if (!node || !rect) continue;
    const y = node.childIds.length > 0 ? HEADER_HEIGHT : LEAF_SIZE[node.level].height;
    blocks.set(id, { x: 0, y, width: rect.width, height: size.height });
  }
  return blocks;
}

/** Storage key of the persistent cache entry. */
export const LAYOUT_STORAGE_KEY = 'architecture-map.layout';
const MEMORY_CACHE_LIMIT = 16;
const memoryCache = new Map<string, Promise<LayoutResult>>();

/**
 * Positions of every node of the fully expanded graph. Deterministic for the same
 * structure and content; results are cached by `layoutKey` (same key → the same result object,
 * which must be treated as immutable).
 *
 * - No rows: plain ELK layered layout (direction RIGHT, hierarchy handled across groups).
 * - With rows: bands, spanning columns, attraction and the Unassigned area (see `tiered.ts`).
 */
export function computeLayout(
  model: ArchitectureModel,
  options: ComputeLayoutOptions = {},
): Promise<LayoutResult> {
  const content = usedContent(model, options.content);
  const key = layoutKey(model, LAYOUT_CONFIG, content);
  const cached = memoryCache.get(key);
  if (cached) {
    memoryCache.delete(key); // refresh LRU position
    memoryCache.set(key, cached);
    return cached;
  }
  const promise = (async () => {
    const stored = readStored(options.storage, key);
    if (stored) return stored;
    const result = await computeLayoutUncached(model, key, content);
    writeStored(options.storage, result);
    return result;
  })();
  memoryCache.set(key, promise);
  promise.catch(() => memoryCache.delete(key));
  while (memoryCache.size > MEMORY_CACHE_LIMIT) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
  return promise;
}

/** Empties the in-memory layout cache. */
export function clearLayoutCache(): void {
  memoryCache.clear();
}

/** Computes the layout without consulting or filling any cache. */
export async function computeLayoutUncached(
  model: ArchitectureModel,
  key?: string,
  content?: ReadonlyMap<string, Size>,
): Promise<LayoutResult> {
  const used = usedContent(model, content);
  key ??= layoutKey(model, LAYOUT_CONFIG, used);
  if (model.rows.length > 0) {
    const tiered = await layoutWithRows(model, used);
    return { key, ...tiered, content: contentRects(model, tiered.rects, used) };
  }

  const { rects: elkRects, size } = await layoutHierarchy(
    model,
    model.rootIds,
    CANVAS_PADDING,
    used,
  );
  const rects = new Map<string, Rect>();
  const absolute = new Map<string, Rect>();
  for (const node of model.nodes.values()) {
    const rel = elkRects.get(node.id);
    if (!rel) throw new Error(`ELK returned no position for ${node.id}`);
    const parent = node.parentId === undefined ? undefined : absolute.get(node.parentId);
    rects.set(node.id, rel);
    absolute.set(node.id, parent ? { ...rel, x: parent.x + rel.x, y: parent.y + rel.y } : rel);
  }
  return {
    key,
    rects,
    absolute,
    rows: [],
    gutterWidth: 0,
    bounds: size,
    placedRow: new Map(),
    rowOf: new Map(),
    content: contentRects(model, rects, used),
  };
}

// --- Serialization (persistent cache) -------------------------------------------------------

const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
const SerializedLayoutSchema = z.object({
  key: z.string(),
  rects: z.array(z.tuple([z.string(), RectSchema])),
  absolute: z.array(z.tuple([z.string(), RectSchema])),
  rows: z.array(
    RectSchema.extend({
      id: z.string(),
      name: z.string(),
    }),
  ),
  gutterWidth: z.number(),
  unassignedArea: RectSchema.optional(),
  bounds: z.object({ width: z.number(), height: z.number() }),
  placedRow: z.array(z.tuple([z.string(), z.string()])),
  rowOf: z.array(z.tuple([z.string(), z.string()])),
  content: z.array(z.tuple([z.string(), RectSchema])).optional(),
});

/** JSON text of a layout (Maps as entry arrays, in iteration order). */
export function serializeLayout(layout: LayoutResult): string {
  return JSON.stringify({
    key: layout.key,
    rects: [...layout.rects],
    absolute: [...layout.absolute],
    rows: layout.rows,
    gutterWidth: layout.gutterWidth,
    ...(layout.unassignedArea ? { unassignedArea: layout.unassignedArea } : {}),
    bounds: layout.bounds,
    placedRow: [...layout.placedRow],
    rowOf: [...layout.rowOf],
    // Left out when empty: a layout without content serializes as it always did.
    ...(layout.content.size > 0 ? { content: [...layout.content] } : {}),
  });
}

/** Inverse of `serializeLayout`; undefined when the text is not a valid serialized layout. */
export function deserializeLayout(text: string): LayoutResult | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = SerializedLayoutSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  return {
    key: data.key,
    rects: new Map(data.rects),
    absolute: new Map(data.absolute),
    rows: data.rows.map(({ id, name, x, y, width, height }) => ({ id, name, x, y, width, height })),
    gutterWidth: data.gutterWidth,
    ...(data.unassignedArea ? { unassignedArea: data.unassignedArea } : {}),
    bounds: data.bounds,
    placedRow: new Map(data.placedRow),
    rowOf: new Map(data.rowOf),
    content: new Map(data.content ?? []),
  };
}

function readStored(storage: LayoutStorage | undefined, key: string): LayoutResult | undefined {
  if (!storage) return undefined;
  try {
    const text = storage.getItem(LAYOUT_STORAGE_KEY);
    const layout = text === null ? undefined : deserializeLayout(text);
    return layout?.key === key ? layout : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(storage: LayoutStorage | undefined, layout: LayoutResult): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(layout));
  } catch {
    // Persistent cache is optional (quota exceeded, storage disabled…).
  }
}
