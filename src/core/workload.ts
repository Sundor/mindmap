// What the work items say about each node: how much work is left in it (heat)
// and how far the work has come (progress) — of the node with everything inside it, and of what
// its box stands for on a map that draws some of the nodes. Pure: no React, no browser APIs.

import type { ArchitectureModel } from './model';
import { nearestVisible } from './rollup';
import { plural } from './text';
import { isOpenState, type WorkItemOverlay, type WorkItemRow } from './workItemOverlay';

/** Adds the IDs of `rows` and of the tasks listed under them to `ids`. */
function addRowIds(ids: Set<number>, rows: readonly WorkItemRow[]): void {
  for (const row of rows) {
    ids.add(row.item.id);
    for (const task of row.tasks) ids.add(task.id);
  }
}

/** How many of the items `ids` are still open. */
function openCount(overlay: WorkItemOverlay, ids: ReadonlySet<number>): number {
  let count = 0;
  for (const id of ids) {
    const item = overlay.byId.get(id);
    if (item && isOpenState(item.state)) count += 1;
  }
  return count;
}

/** The completed items among `ids`, over all of them. */
function progressOf(overlay: WorkItemOverlay, ids: ReadonlySet<number>): NodeProgress {
  let done = 0;
  for (const id of ids) {
    const item = overlay.byId.get(id);
    if (item && !isOpenState(item.state)) done += 1;
  }
  return { done, total: ids.size };
}

/**
 * Per node: the IDs of the distinct shown items on the node and everything below it — the rows
 * and the tasks listed under them. Nodes with none are absent.
 */
export function subtreeWorkItemIds(
  model: ArchitectureModel,
  overlay: WorkItemOverlay,
): ReadonlyMap<string, ReadonlySet<number>> {
  const result = new Map<string, Set<number>>();
  // Reverse document order visits every child before its parent.
  const nodes = [...model.nodes.values()];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node) continue;
    const ids = new Set<number>();
    addRowIds(ids, overlay.rows.get(node.id) ?? []);
    for (const child of node.childIds) for (const id of result.get(child) ?? []) ids.add(id);
    if (ids.size > 0) result.set(node.id, ids);
  }
  return result;
}

/**
 * Per drawn box: the IDs of the distinct shown items it stands for — the rows (and the tasks
 * listed under them) of the box itself and of every node below it that is not drawn. The items
 * of a node count on its nearest drawn box (the node itself, or the nearest ancestor in `drawn`),
 * so a box never counts what a box drawn inside it counts for the same node; an item listed on
 * several nodes counts once on every box one of them lands on. `model` is the whole structure
 * (its parent chain is followed); `drawn` may be the visible set of a part of it, and what lies
 * under no drawn box counts nowhere. Boxes with none are absent. In model order.
 */
export function drawnWorkItemIds(
  model: ArchitectureModel,
  overlay: WorkItemOverlay,
  drawn: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<number>> {
  const found = new Map<string, Set<number>>();
  for (const node of model.nodes.values()) {
    const rows = overlay.rows.get(node.id);
    if (!rows) continue;
    const box = nearestVisible(model, drawn, node.id);
    if (box === undefined) continue;
    const ids = found.get(box) ?? new Set<number>();
    addRowIds(ids, rows);
    found.set(box, ids);
  }
  // `found` lists a box when its first items arrive, which may be after a box drawn inside it.
  const result = new Map<string, ReadonlySet<number>>();
  for (const id of model.nodes.keys()) {
    const ids = found.get(id);
    if (ids && ids.size > 0) result.set(id, ids);
  }
  return result;
}

/** How hot a node is: the open items in it, and that against the most of any node at its level. */
export interface NodeHeat {
  /** Open work items on the node and everything below it. */
  readonly open: number;
  /** `open` over the largest `open` of the nodes at the same level: 0–1. */
  readonly fraction: number;
}

/**
 * Heat by work: per node, how much work is left in it — the shown items on it
 * and inside it that are still open — against the hottest node of the same level, so that a
 * domain is compared with the other domains and a component with the other components. Nodes
 * without open work are absent.
 */
export function heatByWork(
  model: ArchitectureModel,
  overlay: WorkItemOverlay,
): ReadonlyMap<string, NodeHeat> {
  const open = new Map<string, number>();
  const most = [0, 0, 0];
  for (const [nodeId, ids] of subtreeWorkItemIds(model, overlay)) {
    const count = openCount(overlay, ids);
    if (count === 0) continue;
    open.set(nodeId, count);
    const level = model.nodes.get(nodeId)?.level ?? 0;
    most[level] = Math.max(most[level] ?? 0, count);
  }
  const heat = new Map<string, NodeHeat>();
  for (const [nodeId, count] of open) {
    const level = model.nodes.get(nodeId)?.level ?? 0;
    const top = most[level] ?? count;
    heat.set(nodeId, { open: count, fraction: top > 0 ? count / top : 0 });
  }
  return heat;
}

/** Four stops of the heat colour, from the little that smoulders to the white of hot iron. */
export const HEAT_STOPS = ['#5a1a0a', '#d93025', '#f9ab00', '#fff6d5'] as const;

/** How far the work of a node has come. */
export interface NodeProgress {
  /** Items in a completed state (see `CLOSED_STATES`). */
  readonly done: number;
  /** All items counted: the shown ones on the node and everything below it. */
  readonly total: number;
}

/**
 * Progress: per node, the completed items over all items on it and inside it.
 * Give it an overlay built without a state filter — a filter that hides the completed items
 * would make every node look untouched — and with the iteration the progress is asked for
 * (one sprint, a programme increment, or none for the total). Nodes without items are absent.
 */
export function progressByNode(
  model: ArchitectureModel,
  overlay: WorkItemOverlay,
): ReadonlyMap<string, NodeProgress> {
  const progress = new Map<string, NodeProgress>();
  for (const [nodeId, ids] of subtreeWorkItemIds(model, overlay)) {
    progress.set(nodeId, progressOf(overlay, ids));
  }
  return progress;
}

/** "3 of 8 done (38%)", as the tooltip of a progress bar says it. */
export function progressText(progress: NodeProgress): string {
  const percent = progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0;
  return `${progress.done} of ${progress.total} done (${percent}%)`;
}

/**
 * How hot a drawn box is. `open` counts the open items the box stands for, and `fraction` is that
 * over the largest number of open items a node of the same level has on it and below it.
 */
export interface DrawnHeat extends NodeHeat {
  /** Open items on the node and everything below it, drawn or not (`heatByWork`). */
  readonly inAll: number;
}

/**
 * Heat of what each drawn box stands for (`drawnWorkItemIds`), on the scale of `heatByWork`:
 * the hottest node of each level with everything inside it, whatever is drawn — so opening or
 * closing a group changes that group and what it shows or hides, and no other box. Boxes without
 * open work are absent.
 */
export function heatOfDrawn(
  model: ArchitectureModel,
  overlay: WorkItemOverlay,
  drawn: ReadonlySet<string>,
): ReadonlyMap<string, DrawnHeat> {
  const whole = heatByWork(model, overlay);
  // The scale: the most open items of a node with everything inside it, per level.
  const most = [0, 0, 0];
  for (const [nodeId, { open }] of whole) {
    const level = model.nodes.get(nodeId)?.level ?? 0;
    most[level] = Math.max(most[level] ?? 0, open);
  }
  const heat = new Map<string, DrawnHeat>();
  for (const [nodeId, ids] of drawnWorkItemIds(model, overlay, drawn)) {
    const open = openCount(overlay, ids);
    if (open === 0) continue;
    const level = model.nodes.get(nodeId)?.level ?? 0;
    const top = most[level] ?? open;
    heat.set(nodeId, {
      open,
      fraction: top > 0 ? open / top : 0,
      inAll: whole.get(nodeId)?.open ?? open,
    });
  }
  return heat;
}

/** How far the work of a drawn box has come: `done` and `total` count the items it stands for. */
export interface DrawnProgress extends NodeProgress {
  /** Done and total over the node and everything below it, drawn or not (`progressByNode`). */
  readonly inAll: NodeProgress;
}

/**
 * Progress of what each drawn box stands for (`drawnWorkItemIds`): the completed items over all
 * of them. Give it the overlay `progressByNode` takes. Boxes without items are absent.
 */
export function progressOfDrawn(
  model: ArchitectureModel,
  overlay: WorkItemOverlay,
  drawn: ReadonlySet<string>,
): ReadonlyMap<string, DrawnProgress> {
  const whole = progressByNode(model, overlay);
  const progress = new Map<string, DrawnProgress>();
  for (const [nodeId, ids] of drawnWorkItemIds(model, overlay, drawn)) {
    const own = progressOf(overlay, ids);
    progress.set(nodeId, { ...own, inAll: whole.get(nodeId) ?? own });
  }
  return progress;
}

/**
 * The tooltip of a heat strip: "3 open work items in here" — or, when boxes drawn inside the box
 * show the rest, what the box itself shows and how much there is in all.
 */
export function heatText(heat: DrawnHeat): string {
  const open = plural(heat.open, 'open work item');
  if (heat.open === heat.inAll) return `${open} in here`;
  return `${open} here that no box inside shows (${heat.inAll} in here in all)`;
}

/**
 * The tooltip of a progress bar: `progressText` — and, when boxes drawn inside the box show the
 * rest, that this is the progress of what the box itself shows, and the progress of all of it.
 */
export function drawnProgressText(progress: DrawnProgress): string {
  const { inAll } = progress;
  if (progress.total === inAll.total) return progressText(progress);
  const all = `${inAll.done} of ${inAll.total} in here in all`;
  return `${progressText(progress)} of what no box inside shows (${all})`;
}

/**
 * What the detail panel adds for a drawn node whose box shows less than the node holds;
 * undefined when it shows all of it. `all` are the totals, `drawn` the figures of the box (each
 * absent when the lens is off or the node has none).
 */
export function onMapText(
  all: { readonly heat?: NodeHeat | undefined; readonly progress?: NodeProgress | undefined },
  drawn: { readonly heat?: DrawnHeat | undefined; readonly progress?: DrawnProgress | undefined },
): string | undefined {
  const open = drawn.heat?.open ?? 0;
  const { done, total } = drawn.progress ?? { done: 0, total: 0 };
  const less =
    (all.heat !== undefined && open !== all.heat.open) ||
    (all.progress !== undefined && total !== all.progress.total);
  if (!less) return undefined;
  if (!drawn.heat && !drawn.progress) {
    return 'On the map: all of it is on the boxes drawn inside it';
  }
  const parts: string[] = [];
  if (all.heat) parts.push(plural(open, 'open item'));
  if (all.progress) parts.push(`${done} of ${total} done`);
  return `On the map: ${parts.join(' · ')} on this box; the rest is on the boxes drawn inside it`;
}
