// The lists of the node detail panel (sub-objects, edges, work items) can be put in another
// order and folded away. This is the order and the folded set, and how they are stored.
// Pure: the storage is injected and nothing here throws.

import type { ViewStateStorage } from './visibility';

/** The sections of the node panel, in their default order. */
export const NODE_PANEL_SECTIONS = [
  'children',
  'incoming',
  'outgoing',
  'internal',
  'workitems',
] as const;
export type NodePanelSection = (typeof NODE_PANEL_SECTIONS)[number];

export interface PanelLayout {
  /** Section IDs in the order chosen; sections not named follow in their default order. */
  readonly order: readonly string[];
  /** Folded sections: only their heading is shown. */
  readonly collapsed: readonly string[];
}

export const DEFAULT_PANEL_LAYOUT: PanelLayout = { order: [], collapsed: [] };

/**
 * `sections` in the order of `layout`: those the layout names first, in its order, then the
 * rest as they come. IDs the layout names that are not in `sections` are skipped.
 */
export function orderSections<T extends string>(sections: readonly T[], layout: PanelLayout): T[] {
  const known = new Set<string>(sections);
  const named = layout.order.filter((id, i, all) => known.has(id) && all.indexOf(id) === i);
  const rest = sections.filter((id) => !named.includes(id));
  return [...(named as T[]), ...rest];
}

/** Where a section goes: one place up or down among the shown ones, or right before another. */
export type SectionMove = 'up' | 'down' | { readonly before: string };

/**
 * `layout` with section `id` moved. `shown` are the sections on screen (a panel leaves out the
 * empty ones): "up" and "down" step over the shown neighbour, and the sections not shown keep
 * their place in the order. `all` is every section there is, in default order.
 */
export function moveSection(
  layout: PanelLayout,
  all: readonly string[],
  shown: readonly string[],
  id: string,
  move: SectionMove,
): PanelLayout {
  const order = orderSections(all, layout);
  if (!order.includes(id)) return layout;
  const visible = order.filter((section) => shown.includes(section));
  const at = visible.indexOf(id);
  let target: string | undefined;
  let after = false;
  if (move === 'up') target = visible[at - 1];
  else if (move === 'down') {
    target = visible[at + 1];
    after = true;
  } else target = move.before;
  if (at < 0 || target === undefined || target === id || !order.includes(target)) return layout;
  const without = order.filter((section) => section !== id);
  const index = without.indexOf(target) + (after ? 1 : 0);
  const next = [...without.slice(0, index), id, ...without.slice(index)];
  if (next.every((section, i) => section === order[i])) return layout;
  return { order: next, collapsed: layout.collapsed };
}

export function isSectionCollapsed(layout: PanelLayout, id: string): boolean {
  return layout.collapsed.includes(id);
}

/** `layout` with section `id` folded if it was open, and open if it was folded. */
export function toggleSection(layout: PanelLayout, id: string): PanelLayout {
  const collapsed = layout.collapsed.includes(id)
    ? layout.collapsed.filter((section) => section !== id)
    : [...layout.collapsed, id].sort();
  return { order: layout.order, collapsed };
}

// --- Storage --------------------------------------------------------------------------------

export const PANEL_LAYOUT_KEY = 'architecture-map.panel';

function texts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry === 'string' && entry !== '' && !out.includes(entry)) out.push(entry);
  }
  return out;
}

export function serializePanelLayout(layout: PanelLayout): string {
  return JSON.stringify({ order: layout.order, collapsed: layout.collapsed });
}

/** Layout from stored text; anything missing or invalid falls back to the default. */
export function parsePanelLayout(text: string | null | undefined): PanelLayout {
  if (!text) return DEFAULT_PANEL_LAYOUT;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_PANEL_LAYOUT;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_PANEL_LAYOUT;
  const record = value as Record<string, unknown>;
  const order = texts(record.order);
  const collapsed = texts(record.collapsed).sort();
  return order.length === 0 && collapsed.length === 0 ? DEFAULT_PANEL_LAYOUT : { order, collapsed };
}

export function readPanelLayout(storage: ViewStateStorage | undefined): PanelLayout {
  try {
    return parsePanelLayout(storage?.getItem(PANEL_LAYOUT_KEY));
  } catch {
    return DEFAULT_PANEL_LAYOUT;
  }
}

export function writePanelLayout(storage: ViewStateStorage | undefined, layout: PanelLayout): void {
  try {
    storage?.setItem(PANEL_LAYOUT_KEY, serializePanelLayout(layout));
  } catch {
    // Storage full or blocked: the arrangement simply is not remembered.
  }
}
