// Focus: one choice that highlights what a flow, or a work item and everything
// under it, involves — and pales the rest of the map, or in Filter mode leaves it out
// (src/core/focusFilter.ts). Pure: no React, no browser APIs.

import type { FlowEdge, FlowGraph, FlowNode } from './flow';
import type { ArchitectureModel } from './model';
import type { RenderedSelection } from './selection';
import { workItemNodeIds, type WorkItemOverlay } from './workItemOverlay';

/** What the map is focused on: a flow of the structure file, or a work item (with its children). */
export type Focus =
  | { readonly type: 'flow'; readonly id: string }
  | { readonly type: 'workitem'; readonly id: number };

export function sameFocus(a: Focus | undefined, b: Focus | undefined): boolean {
  return a?.type === b?.type && a?.id === b?.id;
}

/** How a focus is shown: the rest of the map paled, or not drawn at all. */
export const FOCUS_MODES = ['focus', 'filter'] as const;
export type FocusMode = (typeof FOCUS_MODES)[number];

export function isFocusMode(value: unknown): value is FocusMode {
  return typeof value === 'string' && (FOCUS_MODES as readonly string[]).includes(value);
}

/** What a focus involves, in model terms. */
export interface FocusSet {
  /** The nodes involved themselves (not their ancestors or descendants). */
  readonly nodes: ReadonlySet<string>;
  /** The model edges involved. */
  readonly edges: ReadonlySet<string>;
  /** For a work item: the item and everything under it that is shown. */
  readonly itemIds: ReadonlySet<number>;
}

/**
 * The nodes and edges `focus` involves:
 * - a flow: its edges, and the nodes it names plus the ends of its edges;
 * - a work item: the nodes that show it or anything under it (its features, stories, bugs and
 *   tasks, as far as the filter shows them), and every edge that runs between those nodes or
 *   what lies inside them.
 *
 * Undefined when the focus names nothing known (a flow of another file, an item not loaded).
 */
export function focusSet(
  model: ArchitectureModel,
  focus: Focus | undefined,
  overlay?: WorkItemOverlay,
): FocusSet | undefined {
  if (!focus) return undefined;
  if (focus.type === 'flow') {
    const flow = model.flows.find((candidate) => candidate.id === focus.id);
    if (!flow) return undefined;
    const nodes = new Set(flow.nodeIds);
    const edges = new Set(flow.edgeIds);
    for (const edge of model.edges) {
      if (!edges.has(edge.id)) continue;
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
    return { nodes, edges, itemIds: new Set() };
  }
  if (!overlay || !overlay.byId.has(focus.id)) return undefined;
  // The item and its descendants, as far as they are shown (a parent that is filtered out still
  // links its children to the item: the chain is walked over every known item).
  const children = new Map<number, number[]>();
  for (const item of overlay.byId.values()) {
    if (item.parentId === undefined) continue;
    const list = children.get(item.parentId) ?? [];
    list.push(item.id);
    children.set(item.parentId, list);
  }
  const itemIds = new Set<number>();
  const queue = [focus.id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (itemIds.has(next)) continue;
    itemIds.add(next);
    for (const child of children.get(next) ?? []) queue.push(child);
  }
  const nodes = new Set<string>();
  for (const id of itemIds) for (const nodeId of workItemNodeIds(overlay, id)) nodes.add(nodeId);
  // Edges among the involved nodes and whatever is inside them.
  const within = new Set(nodes);
  for (const node of model.nodes.values()) {
    if (node.parentId !== undefined && within.has(node.parentId)) within.add(node.id);
  }
  const edges = new Set<string>();
  for (const edge of model.edges) {
    if (within.has(edge.from) && within.has(edge.to)) edges.add(edge.id);
  }
  return { nodes, edges, itemIds };
}

/** Class of a node or edge the focus does not involve. */
export const FADED_CLASS = 'arch-faded';

function withClass(className: string | undefined, extra: string): string {
  return className === undefined || className === '' ? extra : `${className} ${extra}`;
}

/**
 * The drawn nodes the focus involves: the involved nodes themselves, the groups around them
 * (a group is kept so that what it contains can be seen), what is drawn inside them, and the
 * closed groups that stand in for involved nodes the collapse or the level of detail hides.
 */
export function focusedNodeIds(
  model: ArchitectureModel,
  flow: FlowGraph,
  set: FocusSet,
): Set<string> {
  const lit = new Set<string>();
  // Involved nodes and their ancestors: those that are drawn light up (an ancestor that is drawn
  // closed stands in for the node).
  for (const id of set.nodes) {
    for (let node = model.nodes.get(id); node;) {
      lit.add(node.id);
      node = node.parentId === undefined ? undefined : model.nodes.get(node.parentId);
    }
  }
  // Document order lists parents first: one pass collects what is drawn inside involved nodes.
  const inside = new Set(set.nodes);
  for (const node of flow.nodes) {
    if (node.type === 'band' || node.parentId === undefined) continue;
    if (inside.has(node.parentId)) {
      inside.add(node.id);
      lit.add(node.id);
    }
  }
  return lit;
}

/**
 * The drawn nodes the selection is on: the selected node, the two ends of the selected edge, or
 * the nodes that show the selected work item — with the groups drawn around them and, but for an
 * edge, what is drawn inside them (as `highlightFlow` takes a selected node).
 */
function selectedNodeIds(flow: FlowGraph, selection: RenderedSelection): Set<string> {
  let on: readonly string[];
  if (selection.type === 'node') on = [selection.id];
  else if (selection.type === 'workitem') on = selection.nodeIds;
  else {
    const edge = flow.edges.find((candidate) => candidate.id === selection.id);
    on = edge ? [edge.source, edge.target] : [];
  }
  const ids = new Set<string>();
  // Document order lists parents first: one pass finds the parents and what is drawn inside.
  const parents = new Map<string, string | undefined>();
  const inside = new Set(selection.type === 'edge' ? [] : on);
  for (const node of flow.nodes) {
    if (node.type === 'band') continue;
    parents.set(node.id, node.parentId);
    if (node.parentId !== undefined && inside.has(node.parentId)) {
      inside.add(node.id);
      ids.add(node.id);
    }
  }
  for (const start of on) {
    for (let id: string | undefined = start; id !== undefined; id = parents.get(id)) ids.add(id);
  }
  return ids;
}

/**
 * `flow` with the focus shown: every node and edge the focus does not involve gets the class
 * {@link FADED_CLASS} (edges also `data.faded`, for their labels). A rendered edge is involved
 * when any of the model edges it stands for is. Row bands are never faded, and neither is what
 * `selection` is on — the selected node with what is drawn inside it, the selected edge with its
 * two ends, the nodes that show the selected work item, and the groups around those: what the
 * reader is looking at stays readable although the focus does not involve it. Nothing is removed
 * or moved; elements that need no change keep their identity.
 */
export function focusFlow(
  model: ArchitectureModel,
  flow: FlowGraph,
  set: FocusSet,
  selection?: RenderedSelection,
): FlowGraph {
  const lit = focusedNodeIds(model, flow, set);
  if (selection) for (const id of selectedNodeIds(flow, selection)) lit.add(id);
  const nodes = flow.nodes.map((node): FlowNode => {
    if (node.type === 'band' || lit.has(node.id)) return node;
    return { ...node, className: withClass(node.className, FADED_CLASS) };
  });
  const edges = flow.edges.map((edge): FlowEdge => {
    if (selection?.type === 'edge' && edge.id === selection.id) return edge;
    if (edge.data.memberEdgeIds.some((id) => set.edges.has(id))) return edge;
    return {
      ...edge,
      className: withClass(edge.className, FADED_CLASS),
      data: { ...edge.data, faded: true },
    };
  });
  return { nodes, edges };
}

/** Class of an edge that "edges on demand" keeps out of sight. */
export const QUIET_CLASS = 'arch-quiet';

/**
 * Edges on demand: at the coarse levels of detail the edges are the main clutter, so `flow` is
 * returned with every rendered edge hidden (class {@link QUIET_CLASS}) except those that touch
 * `nodeIds` (the hovered or selected drawn nodes), the rendered edge `edgeId` (the selected one)
 * and those the focus involves. Nothing is removed, so the layout and the hit-testing of what is
 * shown do not change.
 */
export function quietEdges(
  flow: FlowGraph,
  nodeIds: ReadonlySet<string>,
  set: FocusSet | undefined,
  edgeId?: string,
): FlowGraph {
  let changed = false;
  const edges = flow.edges.map((edge): FlowEdge => {
    if (edge.id === edgeId) return edge;
    if (nodeIds.has(edge.source) || nodeIds.has(edge.target)) return edge;
    if (set && edge.data.memberEdgeIds.some((id) => set.edges.has(id))) return edge;
    changed = true;
    return {
      ...edge,
      className: withClass(edge.className, QUIET_CLASS),
      data: { ...edge.data, quiet: true },
    };
  });
  return changed ? { nodes: flow.nodes, edges } : flow;
}

/** The flows of the model that involve node `id` (named, or as an end of one of their edges). */
export function flowsOfNode(model: ArchitectureModel, id: string): ArchitectureModel['flows'] {
  const ends = new Map<string, string[]>();
  for (const edge of model.edges) ends.set(edge.id, [edge.from, edge.to]);
  return model.flows.filter(
    (flow) =>
      flow.nodeIds.includes(id) ||
      flow.edgeIds.some((edgeId) => ends.get(edgeId)?.includes(id) ?? false),
  );
}

/** The flows of the model that include edge `id` as a step. */
export function flowsOfEdge(model: ArchitectureModel, id: string): ArchitectureModel['flows'] {
  return model.flows.filter((flow) => flow.edgeIds.includes(id));
}
