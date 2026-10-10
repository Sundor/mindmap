// Filter: a focus shown by drawing only what it involves. The model is reduced to that part and
// laid out as a model of its own, with every node in the row it has on the whole map. Going to
// something then depends on which map has it: the one on screen, or the one on its way.
// Pure: no React, no browser APIs.

import { sameFocus, type Focus, type FocusSet } from './focus';
import { rowPlacement, type RowPlacement } from './layout/tiered';
import type { LayoutResult } from './layout/types';
import type { ArchFlow, ArchitectureModel, ArchNode } from './model';
import { rowRanges } from './rows';
import type { Selection } from './selection';
import { workItemNodeIds, type WorkItemOverlay } from './workItemOverlay';

/** What a focus keeps on the map, in model terms: independent of collapse and level of detail. */
export interface FocusScope {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

/**
 * - nodes: every node of `set.nodes` that exists, each of its ancestors, and each of its
 *   descendants — the rule of `focusedNodeIds` without its dependence on what is drawn;
 * - edges: the model edges whose id is in `set.edges` and whose two ends are among those nodes.
 */
export function focusScope(model: ArchitectureModel, set: FocusSet): FocusScope {
  const nodes = new Set<string>();
  for (const id of set.nodes) {
    for (let node = model.nodes.get(id); node;) {
      nodes.add(node.id);
      node = node.parentId === undefined ? undefined : model.nodes.get(node.parentId);
    }
  }
  // Document order lists parents first: one pass collects what lies inside involved nodes.
  const inside = new Set<string>();
  for (const node of model.nodes.values()) {
    if (set.nodes.has(node.id) || (node.parentId !== undefined && inside.has(node.parentId))) {
      inside.add(node.id);
      nodes.add(node.id);
    }
  }
  const edges = new Set<string>();
  for (const edge of model.edges) {
    if (set.edges.has(edge.id) && nodes.has(edge.from) && nodes.has(edge.to)) edges.add(edge.id);
  }
  return { nodes, edges };
}

/** A part of a model, as a model of its own. */
export interface Submodel {
  readonly model: ArchitectureModel;
  /**
   * The kept nodes without a row of their own that the whole model places in a row by their
   * connections, with that row's id, in document order. In `model` they carry that row.
   */
  readonly placedRow: ReadonlyMap<string, string>;
}

const NO_PLACED_ROWS: ReadonlyMap<string, string> = new Map();
const ROW_KEYS: ReadonlySet<string> = new Set<keyof ArchNode>(['row', 'effectiveRow', 'rowRange']);

/**
 * `model` reduced to `keep`. Never a key for stored state. Does not mutate.
 *
 * - Nodes: those of `keep.nodes` whose parent, if any, is kept too (a node whose parent is left
 *   out goes with everything below it), in document order; a kept group lists its kept children.
 * - Edges: those of `keep.edges` with both ends kept — the same objects, in the same order.
 * - Rows: no node changes row. A node the whole model places by its connections is assigned to
 *   that row (and reported in `placedRow`), and what lies inside it inherits the row. A row left
 *   without a node is dropped, so the bands close up; `rowRange` is derived again for the rows
 *   that remain.
 * - Flows: their kept edges and nodes; a flow left with neither is dropped.
 * - Presets: the file's, unchanged — also one whose label no kept node carries. Nothing reads
 *   the presets of a part: colours, legend and the list of "Colour by" come from the whole model.
 *
 * When nothing is left out, the result holds `model` itself. `placement` is the row placement of
 * `model` (`rowPlacement`), computed here when it is not given.
 */
export function submodel(
  model: ArchitectureModel,
  keep: FocusScope,
  placement?: RowPlacement,
): Submodel {
  // Document order lists parents first, so a dropped parent drops everything below it.
  const kept: ArchNode[] = [];
  const keptIds = new Set<string>();
  for (const node of model.nodes.values()) {
    if (!keep.nodes.has(node.id)) continue;
    if (node.parentId !== undefined && !keptIds.has(node.parentId)) continue;
    keptIds.add(node.id);
    kept.push(node);
  }
  const edges = model.edges.filter(
    (edge) => keep.edges.has(edge.id) && keptIds.has(edge.from) && keptIds.has(edge.to),
  );
  if (kept.length === model.nodes.size && edges.length === model.edges.length) {
    return { model, placedRow: NO_PLACED_ROWS };
  }

  // The rows the nodes have on the whole map, pinned: what attraction decided there must not be
  // decided again from the connections that are left.
  const whole = model.rows.length > 0 ? (placement ?? rowPlacement(model)) : undefined;
  const placedRow = new Map<string, string>();
  const usedRows = new Set<string>();
  const drafts = kept.map((node) => {
    const effectiveRow = node.effectiveRow ?? whole?.rowOf.get(node.id);
    const placed = node.effectiveRow === undefined ? whole?.placedRow.get(node.id) : undefined;
    if (placed !== undefined) placedRow.set(node.id, placed);
    if (effectiveRow !== undefined) usedRows.add(effectiveRow);
    return {
      node,
      id: node.id,
      childIds: node.childIds.filter((id) => keptIds.has(id)),
      row: node.row ?? placed,
      effectiveRow,
    };
  });
  const rows = model.rows.filter((row) => usedRows.has(row.id));
  const ranges = rowRanges(rows, drafts);

  const nodes = new Map<string, ArchNode>();
  for (const { node, id, childIds, row, effectiveRow } of drafts) {
    const rowRange = ranges.get(id);
    nodes.set(id, {
      // Everything but what the rows gave the node.
      ...(Object.fromEntries(
        Object.entries(node).filter(([key]) => !ROW_KEYS.has(key)),
      ) as unknown as ArchNode),
      childIds,
      ...(row !== undefined ? { row } : {}),
      ...(effectiveRow !== undefined ? { effectiveRow } : {}),
      ...(rowRange ? { rowRange } : {}),
    });
  }

  const edgeIds = new Set(edges.map((edge) => edge.id));
  const flows: ArchFlow[] = [];
  for (const flow of model.flows) {
    const flowEdges = flow.edgeIds.filter((id) => edgeIds.has(id));
    const flowNodes = flow.nodeIds.filter((id) => keptIds.has(id));
    if (flowEdges.length === 0 && flowNodes.length === 0) continue;
    flows.push({ ...flow, edgeIds: flowEdges, nodeIds: flowNodes });
  }

  return {
    model: {
      version: model.version,
      rows,
      nodes,
      rootIds: model.rootIds.filter((id) => keptIds.has(id)),
      edges,
      flows,
      presets: model.presets,
    },
    placedRow,
  };
}

/**
 * `model` reduced to what `set` involves: what Filter draws, and exactly what `focusFlow` leaves
 * unfaded. Undefined when there is nothing to filter: the focus involves no node of the model, or
 * nothing would be left out.
 */
export function filterToFocus(
  model: ArchitectureModel,
  set: FocusSet,
  placement?: RowPlacement,
): Submodel | undefined {
  const scope = focusScope(model, set);
  if (scope.nodes.size === 0) return undefined;
  const reduced = submodel(model, scope, placement);
  return reduced.model === model ? undefined : reduced;
}

/**
 * `layout` reporting `placedRow` for the nodes of a reduced model that the whole map places by
 * their connections; `layout` itself when there are none or it has no row bands.
 */
export function withPlacedRows(
  layout: LayoutResult,
  placedRow: ReadonlyMap<string, string>,
): LayoutResult {
  if (placedRow.size === 0 || layout.rows.length === 0) return layout;
  return { ...layout, placedRow: new Map([...layout.placedRow, ...placedRow]) };
}

/**
 * True when `model` has what `target` names: the node; the edge; for a work item, one of the
 * nodes that list it (`workItemNodeIds`) or no node at all; always for a flow or an aggregate.
 */
export function modelShows(
  model: ArchitectureModel,
  target: Selection,
  overlay?: WorkItemOverlay,
): boolean {
  switch (target.type) {
    case 'node':
      return model.nodes.has(target.id);
    case 'edge':
      return model.edges.some((edge) => edge.id === target.id);
    case 'workitem': {
      const nodeIds = overlay ? workItemNodeIds(overlay, target.id) : [];
      return nodeIds.length === 0 || nodeIds.some((id) => model.nodes.has(id));
    }
    case 'flow':
    case 'aggregate':
      return true;
  }
}

/**
 * When something that was asked for can be gone to: at once; once the map that has it has
 * arrived; or once Filter has been left, because the map reduced to the focus leaves it out.
 */
export type GoToTiming = 'now' | 'wait' | 'leave';

/**
 * When `target` can be gone to. `wanted` is the model the next layout is for and `onScreen` the
 * one that is drawn — each `whole` or a part of it, and absent while there is none.
 *
 * - `'leave'`: the wanted map does not have the target, whatever the one on screen has: it can
 *   only be shown on the whole map;
 * - `'wait'`: the wanted map has it and the one on screen does not: that map is on its way;
 * - `'now'`: neither leaves it out — or `whole` does not have it at all, which is for the caller
 *   to handle as it does on the whole map.
 */
export function goToTiming(
  whole: ArchitectureModel,
  wanted: ArchitectureModel | undefined,
  onScreen: ArchitectureModel | undefined,
  target: Selection,
  overlay?: WorkItemOverlay,
): GoToTiming {
  if (!modelShows(whole, target, overlay)) return 'now';
  if (wanted && !modelShows(wanted, target, overlay)) return 'leave';
  return onScreen && !modelShows(onScreen, target, overlay) ? 'wait' : 'now';
}

/**
 * How the view comes to what a newly chosen focus involves: moved there at once; moved there
 * once the whole map is back; or not moved at all, because the map reduced to the focus arrives
 * fitted.
 */
export type FocusMoveTiming = 'now' | 'wait' | 'fitted';

/**
 * How the view comes to what the focus `next` involves. `reduced` says whether `next` is shown
 * on a map reduced to it (Filter, and it leaves something out) or on the whole one; `onScreen`
 * is the focus the map on screen is reduced to, undefined for the whole map.
 *
 * - `'now'`: the map that shows the focus is the one on screen;
 * - `'fitted'`: it is a reduced map that is yet to arrive;
 * - `'wait'`: it is the whole map, and a reduced one is on screen: a move now would be made in
 *   the coordinates of the map that goes.
 */
export function focusMoveTiming(
  next: Focus,
  reduced: boolean,
  onScreen: Focus | undefined,
): FocusMoveTiming {
  if (reduced) return sameFocus(onScreen, next) ? 'now' : 'fitted';
  return onScreen === undefined ? 'now' : 'wait';
}
