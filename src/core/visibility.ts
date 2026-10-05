// Visibility of nodes under manual collapse and level of detail, the counts
// shown on a collapsed group, and the (de)serialisation of the persisted collapsed set.
// Pure: no React, no browser APIs.

import { fnv1a64 } from './layout/hash';
import type { ArchitectureModel, NodeLevel } from './model';

/** Level of detail, coarsest first. The zoom → level rule is in ./lod. */
export const LOD_LEVELS = ['domains', 'components', 'subcomponents', 'detail'] as const;
export type LodLevel = (typeof LOD_LEVELS)[number];

/**
 * Deepest node level each level of detail shows. `subcomponents` and `detail` draw the same
 * nodes; `detail` additionally shows what is inside the boxes (the work items).
 */
export const LOD_MAX_LEVEL: Readonly<Record<LodLevel, NodeLevel>> = {
  domains: 0,
  components: 1,
  subcomponents: 2,
  detail: 2,
};

/**
 * IDs of the nodes that are drawn: a node is visible iff none of its ancestors is collapsed and
 * its level is allowed by `lodLevel`. A collapsed node itself stays visible (as a closed box).
 * Manual collapse wins over the level of detail: a collapsed group hides its contents at every
 * level. IDs in `collapsedIds` that are unknown, or that name a node without children, have no
 * effect. The result iterates in model (YAML document) order.
 */
export function visibleNodes(
  model: ArchitectureModel,
  collapsedIds: ReadonlySet<string>,
  lodLevel: LodLevel,
): Set<string> {
  const maxLevel = LOD_MAX_LEVEL[lodLevel];
  const visible = new Set<string>();
  // Document order lists every parent before its children.
  for (const node of model.nodes.values()) {
    if (node.level > maxLevel) continue;
    if (node.parentId !== undefined) {
      if (!visible.has(node.parentId) || collapsedIds.has(node.parentId)) continue;
    }
    visible.add(node.id);
  }
  return visible;
}

/** IDs of the nodes that can be collapsed (those with children), in document order. */
export function groupIds(model: ArchitectureModel): string[] {
  const ids: string[] = [];
  for (const node of model.nodes.values()) if (node.childIds.length > 0) ids.push(node.id);
  return ids;
}

/**
 * True when `id` is drawn as a closed box in `visible`: it is visible and has children, none of
 * which is (whether through manual collapse or the level of detail).
 */
export function isClosedGroup(
  model: ArchitectureModel,
  visible: ReadonlySet<string>,
  id: string,
): boolean {
  const node = model.nodes.get(id);
  if (!node || node.childIds.length === 0 || !visible.has(id)) return false;
  return !node.childIds.some((child) => visible.has(child));
}

/** Counts shown on a collapsed group. */
export interface GroupCounts {
  /** Direct children. */
  readonly children: number;
  /** All descendants (children, grandchildren, …). */
  readonly descendants: number;
  /** Linked stories in the subtree. Filled by the work-item overlay; absent without one. */
  readonly stories?: number;
  /** Open bugs in the subtree. Filled by the work-item overlay; absent without one. */
  readonly openBugs?: number;
}

/** Number of direct children and of all descendants of every node, in document order. */
export function allGroupCounts(model: ArchitectureModel): Map<string, GroupCounts> {
  const descendants = new Map<string, number>();
  // Reverse document order visits every child before its parent.
  const nodes = [...model.nodes.values()];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node) continue;
    let total = node.childIds.length;
    for (const child of node.childIds) total += descendants.get(child) ?? 0;
    descendants.set(node.id, total);
  }
  const counts = new Map<string, GroupCounts>();
  for (const node of nodes) {
    counts.set(node.id, {
      children: node.childIds.length,
      descendants: descendants.get(node.id) ?? 0,
    });
  }
  return counts;
}

// --- Persistence of the collapsed set -------------------------------------------------------

export const COLLAPSED_STORAGE_PREFIX = 'architecture-map.collapsed:';

/**
 * Identity of a structure for per-file view state: a hash of its domain IDs. Editing the file
 * (new components, renamed nodes, changed edges) keeps the state; a file describing something
 * else does not inherit it.
 */
export function structureIdentity(model: ArchitectureModel): string {
  return fnv1a64(JSON.stringify([...model.rootIds].sort()));
}

/** `localStorage` key of the collapsed set of `model`. */
export function collapsedStorageKey(model: ArchitectureModel): string {
  return `${COLLAPSED_STORAGE_PREFIX}${structureIdentity(model)}`;
}

/** Stored form of a collapsed set: a sorted JSON array of node IDs. */
export function serializeCollapsed(collapsedIds: ReadonlySet<string>): string {
  return JSON.stringify([...collapsedIds].sort());
}

/**
 * Reads a stored collapsed set. Anything that is not a JSON array yields the empty set; entries
 * that are not the ID of a group of `model` (unknown, removed, or no longer having children) are
 * ignored.
 */
export function parseCollapsed(
  text: string | null | undefined,
  model: ArchitectureModel,
): Set<string> {
  const result = new Set<string>();
  if (typeof text !== 'string') return result;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return result;
  }
  if (!Array.isArray(value)) return result;
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') continue;
    const node = model.nodes.get(entry);
    if (node && node.childIds.length > 0) result.add(entry);
  }
  return result;
}

/** Minimal `Storage` subset used for the collapsed set (e.g. `window.localStorage`). */
export interface ViewStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The collapsed set stored for `model`; empty without storage, without an entry, or when the
 * storage fails (privacy mode, corrupt entry). The app must work without it.
 */
export function readCollapsed(
  storage: ViewStateStorage | undefined,
  model: ArchitectureModel,
): Set<string> {
  if (!storage) return new Set();
  try {
    return parseCollapsed(storage.getItem(collapsedStorageKey(model)), model);
  } catch {
    return new Set();
  }
}

/** Stores the collapsed set of `model`. Returns false when there is no storage or it fails. */
export function writeCollapsed(
  storage: ViewStateStorage | undefined,
  model: ArchitectureModel,
  collapsedIds: ReadonlySet<string>,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(collapsedStorageKey(model), serializeCollapsed(collapsedIds));
    return true;
  } catch {
    return false;
  }
}
