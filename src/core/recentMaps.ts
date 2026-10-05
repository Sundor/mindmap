// Recently opened maps. A page cannot learn where a
// file lies on the disk, but the browser can hand it a reference to the file that it may keep:
// the list of those is what lets a map be opened again with one click instead of a search
// through folders. Pure: what such a reference is, is up to the caller (`H`).

import type { ArchitectureModel } from './model';

/** How many maps are remembered; the one opened longest ago makes room. */
export const MAX_RECENT_MAPS = 8;

/** Domains named in the hint of a map. */
const HINT_DOMAINS = 3;

/** One remembered file: its name and the browser's reference to it. */
export interface RecentFile<H> {
  readonly name: string;
  readonly handle: H;
}

/** One remembered map: a structure file and, when it was opened with one, its work items. */
export interface RecentMap<H> {
  readonly id: string;
  readonly structure: RecentFile<H>;
  readonly workItems?: RecentFile<H>;
  /**
   * A few words from the structure. Two maps often have the same file names
   * (`architecture.yaml`) and the folder is not known: this tells them apart.
   */
  readonly hint: string;
  /** When it was last opened, in milliseconds since 1970. */
  readonly openedAt: number;
}

/** `list` with `entry` first (replacing the entry with its ID), cut to `max` entries. */
export function withRecentMap<H>(
  list: readonly RecentMap<H>[],
  entry: RecentMap<H>,
  max: number = MAX_RECENT_MAPS,
): RecentMap<H>[] {
  return [entry, ...list.filter((other) => other.id !== entry.id)].slice(0, Math.max(0, max));
}

/** `list` without the entry with `id`. */
export function withoutRecentMap<H>(list: readonly RecentMap<H>[], id: string): RecentMap<H>[] {
  return list.filter((entry) => entry.id !== id);
}

/**
 * `list` with `workItems` as the work items of the entry with `id` (its place in the list
 * stays); the same list when there is no such entry.
 */
export function withRecentWorkItems<H>(
  list: readonly RecentMap<H>[],
  id: string,
  workItems: RecentFile<H>,
): readonly RecentMap<H>[] {
  if (!list.some((entry) => entry.id === id)) return list;
  return list.map((entry) => (entry.id === id ? { ...entry, workItems } : entry));
}

/** `list` with the hint of the entry with `id` set; the same list when nothing changes. */
export function withRecentHint<H>(
  list: readonly RecentMap<H>[],
  id: string,
  hint: string,
): readonly RecentMap<H>[] {
  if (!list.some((entry) => entry.id === id && entry.hint !== hint)) return list;
  return list.map((entry) => (entry.id === id ? { ...entry, hint } : entry));
}

/** What the list shows as the name of a map: its file names. */
export function recentMapLabel(entry: RecentMap<unknown>): string {
  return entry.workItems
    ? `${entry.structure.name} + ${entry.workItems.name}`
    : entry.structure.name;
}

/** The hint of a model: its first domains by name. Empty for a file that gave no model. */
export function recentMapHint(model: ArchitectureModel | undefined): string {
  if (!model || model.rootIds.length === 0) return '';
  const names = model.rootIds.map((id) => model.nodes.get(id)?.name ?? id);
  const shown = names.slice(0, HINT_DOMAINS).join(', ');
  return names.length > HINT_DOMAINS ? `${shown} …` : shown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recentFile<H>(
  value: unknown,
  isHandle: (candidate: unknown) => candidate is H,
): RecentFile<H> | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || !isHandle(value.handle)) {
    return undefined;
  }
  return { name: value.name, handle: value.handle };
}

/**
 * The list as read back from the browser's storage, which is not trusted to hold what was put
 * there: entries that are not whole are left out, IDs are unique, and the list is in the order
 * of opening (latest first) and no longer than `max`.
 */
export function sanitizeRecentMaps<H>(
  value: unknown,
  isHandle: (candidate: unknown) => candidate is H,
  max: number = MAX_RECENT_MAPS,
): RecentMap<H>[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: RecentMap<H>[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item) || typeof item.id !== 'string' || seen.has(item.id)) continue;
    const structure = recentFile(item.structure, isHandle);
    if (!structure) continue;
    const workItems = recentFile(item.workItems, isHandle);
    seen.add(item.id);
    entries.push({
      id: item.id,
      structure,
      ...(workItems ? { workItems } : {}),
      hint: typeof item.hint === 'string' ? item.hint : '',
      openedAt:
        typeof item.openedAt === 'number' && Number.isFinite(item.openedAt) ? item.openedAt : 0,
    });
  }
  return entries.sort((a, b) => b.openedAt - a.openedAt).slice(0, Math.max(0, max));
}
