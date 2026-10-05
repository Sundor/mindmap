// What the work items say about each node: how much work is left in it (heat)
// and how far the work has come (progress). Pure: no React, no browser APIs.

import type { ArchitectureModel } from './model';
import { isOpenState, type WorkItemOverlay } from './workItemOverlay';

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
    for (const row of overlay.rows.get(node.id) ?? []) {
      ids.add(row.item.id);
      for (const task of row.tasks) ids.add(task.id);
    }
    for (const child of node.childIds) for (const id of result.get(child) ?? []) ids.add(id);
    if (ids.size > 0) result.set(node.id, ids);
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
    let count = 0;
    for (const id of ids) {
      const item = overlay.byId.get(id);
      if (item && isOpenState(item.state)) count += 1;
    }
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
    let done = 0;
    for (const id of ids) {
      const item = overlay.byId.get(id);
      if (item && !isOpenState(item.state)) done += 1;
    }
    progress.set(nodeId, { done, total: ids.size });
  }
  return progress;
}

/** "3 of 8 done (38%)", as the tooltip of a progress bar says it. */
export function progressText(progress: NodeProgress): string {
  const percent = progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0;
  return `${progress.done} of ${progress.total} done (${percent}%)`;
}
