// Stable layout cache key.

import type { ArchitectureModel } from '../model';
import { LAYOUT_CONFIG } from './constants';
import type { Size } from './types';

/**
 * Bump when the layout code changes, so cached layouts are invalidated. Geometry constants and ELK
 * options need no bump: they are part of the key through `LAYOUT_CONFIG`.
 */
export const LAYOUT_ALGORITHM_VERSION = 2;

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a over the UTF-16 code units of `text`, as 16 hex digits. */
export function fnv1a64(text: string): string {
  let hash = FNV64_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Canonical JSON of everything that affects the layout: row IDs and names, node IDs, names
 * (widths depend on them), parents, levels, order and explicit rows, and edge endpoints in order.
 * Descriptions, edge IDs, kinds, labels and protocols do not move anything, so editing them keeps
 * the cached layout. The algorithm version and the layout constants (`config`, defaulting to
 * `LAYOUT_CONFIG`) are included, so a new release with different geometry does not reuse stale
 * persistent cache entries. So are the content blocks reserved inside nodes (`content`, see
 * `ComputeLayoutOptions.content`), in model order; without any the text is the same as before
 * there was content.
 */
export function layoutStructureJson(
  model: ArchitectureModel,
  config: unknown = LAYOUT_CONFIG,
  content: ReadonlyMap<string, Size> = new Map(),
): string {
  const blocks: [string, number, number][] = [];
  for (const id of model.nodes.keys()) {
    const size = content.get(id);
    if (size) blocks.push([id, size.width, size.height]);
  }
  return JSON.stringify({
    v: LAYOUT_ALGORITHM_VERSION,
    c: config,
    rows: model.rows.map((row) => [row.id, row.name]),
    nodes: [...model.nodes.values()].map((n) => [
      n.id,
      n.name,
      n.parentId ?? null,
      n.level,
      n.row ?? null,
    ]),
    edges: model.edges.map((e) => [e.from, e.to]),
    ...(blocks.length > 0 ? { content: blocks } : {}),
  });
}

/** Cache key of the layout of `model` with the given `content` blocks. */
export function layoutKey(
  model: ArchitectureModel,
  config: unknown = LAYOUT_CONFIG,
  content?: ReadonlyMap<string, Size>,
): string {
  return fnv1a64(layoutStructureJson(model, config, content));
}
