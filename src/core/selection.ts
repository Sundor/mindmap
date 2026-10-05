// Selection and neighbourhood: what is selected, how that maps onto what is
// currently drawn, and which drawn elements stay undimmed. Pure: no React, no browser APIs.

import type { ArchEdgeData, FlowEdge, FlowGraph, FlowNode } from './flow';
import type { ArchitectureModel } from './model';
import { nearestVisible } from './rollup';
import { workItemNodeIds, type WorkItemOverlay } from './workItemOverlay';

/**
 * What the user selected, in model terms. Node and edge IDs are separate namespaces, hence the
 * tag. `node` and `edge` name a model node / model edge and survive collapsing and zooming;
 * `aggregate` names a rendered rollup of several edges (`aggregateEdgeId`) and only means
 * something while that rollup is drawn. `workitem` names a work item by its ID (a number, the
 * third namespace); it lasts while the item is among the known ones (the app passes those the
 * filter shows, so an item that is filtered out is no longer selected). `flow` names a flow of
 * the structure file (a fourth namespace): it opens the flow's panel and marks nothing on the
 * canvas — the focus does that (src/core/focus.ts).
 */
export type Selection =
  | { readonly type: 'node'; readonly id: string }
  | { readonly type: 'edge'; readonly id: string }
  | { readonly type: 'aggregate'; readonly id: string }
  | { readonly type: 'workitem'; readonly id: number }
  | { readonly type: 'flow'; readonly id: string };

/** The work items a selection may name: anything that knows which IDs exist. */
export interface KnownWorkItems {
  has(id: number): boolean;
}

export function sameSelection(a: Selection | undefined, b: Selection | undefined): boolean {
  return a?.type === b?.type && a?.id === b?.id;
}

/**
 * True when `selection` still names something: a node or edge of `model`, an aggregate among
 * the `renderedEdges`, or one of the `workItems`. An aggregate stops existing when its groups
 * are opened or its kind is filtered out; the selection is then treated as none.
 */
export function selectionExists(
  model: ArchitectureModel,
  renderedEdges: readonly { readonly id: string }[],
  selection: Selection | undefined,
  workItems?: KnownWorkItems,
): selection is Selection {
  if (!selection) return false;
  switch (selection.type) {
    case 'node':
      return model.nodes.has(selection.id);
    case 'edge':
      return model.edges.some((edge) => edge.id === selection.id);
    case 'aggregate':
      return renderedEdges.some((edge) => edge.id === selection.id);
    case 'workitem':
      return workItems?.has(selection.id) ?? false;
    case 'flow':
      return model.flows.some((flow) => flow.id === selection.id);
  }
}

/**
 * `selection` as it stands against what is drawn now:
 * - a node or an edge of `model`, or one of the `workItems`, is kept as it is;
 * - an aggregate that is still drawn as a rollup of several edges is kept;
 * - an aggregate whose rendered edge now stands for a single edge (its groups were opened, or a
 *   filter left one member) becomes that edge: the same line must not give two different panels;
 * - an aggregate that is no longer drawn, or anything unknown, is no selection (undefined).
 *
 * Returns `selection` itself when it is kept.
 */
export function resolveSelection(
  model: ArchitectureModel,
  renderedEdges: readonly (Pick<FlowEdge, 'id'> & {
    readonly data: Pick<ArchEdgeData, 'memberEdgeIds'>;
  })[],
  selection: Selection | undefined,
  workItems?: KnownWorkItems,
): Selection | undefined {
  if (!selectionExists(model, renderedEdges, selection, workItems)) return undefined;
  if (selection.type !== 'aggregate') return selection;
  const rendered = renderedEdges.find((edge) => edge.id === selection.id);
  if (!rendered) return undefined;
  const resolved = selectionOfRenderedEdge(rendered);
  return resolved.type === 'aggregate' ? selection : resolved;
}

/**
 * A selection in terms of what is drawn: the ID of a rendered node or of a rendered edge, or a
 * work item with the rendered nodes that show it.
 */
export type RenderedSelection =
  | { readonly type: 'node'; readonly id: string }
  | { readonly type: 'edge'; readonly id: string }
  | { readonly type: 'workitem'; readonly id: number; readonly nodeIds: readonly string[] };

/** The part of a rendered edge the neighbourhood needs. */
export interface RenderedEdgeEnds {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface Neighbourhood {
  readonly nodes: Set<string>;
  readonly edges: Set<string>;
}

/**
 * The selected element plus the elements directly connected to it:
 * - a node: itself, every rendered edge incident to it and those edges' other endpoints;
 * - an edge or aggregate: itself and both of its endpoints;
 * - a work item: the nodes that show it, and no edge (work items have none).
 *
 * A node without rendered edges gives just itself; an edge ID that is not among `renderedEdges`
 * gives just that ID. Everything outside the result is drawn dimmed.
 */
export function neighbourhood(
  selection: RenderedSelection,
  renderedEdges: readonly RenderedEdgeEnds[],
): Neighbourhood {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (selection.type === 'workitem') {
    for (const id of selection.nodeIds) nodes.add(id);
  } else if (selection.type === 'node') {
    nodes.add(selection.id);
    for (const edge of renderedEdges) {
      if (edge.source !== selection.id && edge.target !== selection.id) continue;
      edges.add(edge.id);
      nodes.add(edge.source);
      nodes.add(edge.target);
    }
  } else {
    edges.add(selection.id);
    for (const edge of renderedEdges) {
      if (edge.id !== selection.id) continue;
      nodes.add(edge.source);
      nodes.add(edge.target);
    }
  }
  return { nodes, edges };
}

/**
 * The selection made by clicking a rendered edge: the original edge when it stands for exactly
 * one, otherwise the aggregate.
 */
export function selectionOfRenderedEdge(
  edge: Pick<FlowEdge, 'id'> & { readonly data: Pick<ArchEdgeData, 'memberEdgeIds'> },
): Selection {
  const [only, ...others] = edge.data.memberEdgeIds;
  return only !== undefined && others.length === 0
    ? { type: 'edge', id: only }
    : { type: 'aggregate', id: edge.id };
}

function isArchNode(node: FlowNode): boolean {
  return node.type !== 'band';
}

/**
 * Where `selection` is in the drawn `flow`, or undefined when it is not drawn at all:
 * - a node maps to itself, or to its nearest visible ancestor while collapse or the level of
 *   detail hides it;
 * - an edge maps to the rendered edge that contains it (itself, or the aggregate it was rolled
 *   into); it is not drawn when its kind is filtered out or both ends are inside one closed box;
 * - an aggregate maps to itself while it is drawn;
 * - a work item maps to the drawn nodes that show it (`workItemDrawnOn`); it is not drawn when
 *   there is no `overlay`, or it is filtered out or tagged to no node.
 */
export function renderedSelection(
  model: ArchitectureModel,
  flow: FlowGraph,
  selection: Selection | undefined,
  overlay?: WorkItemOverlay,
): RenderedSelection | undefined {
  if (!selection) return undefined;
  const visibleIds = (): Set<string> => {
    const visible = new Set<string>();
    for (const node of flow.nodes) if (isArchNode(node)) visible.add(node.id);
    return visible;
  };
  switch (selection.type) {
    case 'node': {
      const id = nearestVisible(model, visibleIds(), selection.id);
      return id === undefined ? undefined : { type: 'node', id };
    }
    case 'workitem': {
      if (!overlay) return undefined;
      const nodeIds = workItemDrawnOn(model, overlay, visibleIds(), selection.id);
      return nodeIds.length > 0 ? { type: 'workitem', id: selection.id, nodeIds } : undefined;
    }
    case 'edge': {
      const edge = flow.edges.find((e) => e.data.memberEdgeIds.includes(selection.id));
      return edge ? { type: 'edge', id: edge.id } : undefined;
    }
    case 'aggregate':
      return flow.edges.some((e) => e.id === selection.id)
        ? { type: 'edge', id: selection.id }
        : undefined;
    case 'flow':
      return undefined;
  }
}

/**
 * The visible nodes that show work item `id`: each node it is listed on (`workItemNodeIds`: the
 * nodes it is tagged to, or for a task those of the item it is listed under), or that node's
 * nearest visible ancestor while collapse or the level of detail hides it. In document order of
 * the item's tags, without duplicates.
 */
export function workItemDrawnOn(
  model: ArchitectureModel,
  overlay: WorkItemOverlay,
  visible: ReadonlySet<string>,
  id: number,
): string[] {
  const drawn: string[] = [];
  for (const nodeId of workItemNodeIds(overlay, id)) {
    const shown = nearestVisible(model, visible, nodeId);
    if (shown !== undefined && !drawn.includes(shown)) drawn.push(shown);
  }
  return drawn;
}

/** Class of a node or edge outside the neighbourhood of the selection. */
export const DIMMED_CLASS = 'arch-dimmed';

function withClass(className: string | undefined, extra: string): string {
  return className === undefined || className === '' ? extra : `${className} ${extra}`;
}

/**
 * `flow` with the selection shown: the selected element gets `selected: true`, and every node
 * and edge outside its neighbourhood gets the class {@link DIMMED_CLASS} (edges also
 * `data.dimmed`, for their labels, which are drawn outside the edge's own element). Nothing is
 * removed or moved. Row bands and the Unassigned area are never dimmed. When a node is selected,
 * the nodes drawn inside it count as part of it and stay undimmed too; likewise the nodes drawn
 * inside the nodes that show a selected work item (no node is marked selected then: the item's
 * line is, by the canvas).
 *
 * Returns `flow` itself when nothing is selected. Elements that need no change keep their object
 * identity.
 */
export function highlightFlow(
  flow: FlowGraph,
  selection: RenderedSelection | undefined,
): FlowGraph {
  if (!selection) return flow;
  const near = neighbourhood(selection, flow.edges);
  const lit = near.nodes;
  if (selection.type !== 'edge') {
    // Document order lists parents first, so one pass collects all drawn descendants.
    const inside = new Set(selection.type === 'node' ? [selection.id] : selection.nodeIds);
    for (const node of flow.nodes) {
      if (node.type === 'band' || node.parentId === undefined) continue;
      if (inside.has(node.parentId)) {
        inside.add(node.id);
        lit.add(node.id);
      }
    }
  }

  const nodes = flow.nodes.map((node): FlowNode => {
    if (node.type === 'band') return node;
    if (selection.type === 'node' && node.id === selection.id) return { ...node, selected: true };
    if (lit.has(node.id)) return node;
    return { ...node, className: withClass(node.className, DIMMED_CLASS) };
  });
  const edges = flow.edges.map((edge): FlowEdge => {
    if (selection.type === 'edge' && edge.id === selection.id) return { ...edge, selected: true };
    if (near.edges.has(edge.id)) return edge;
    return {
      ...edge,
      className: withClass(edge.className, DIMMED_CLASS),
      data: { ...edge.data, dimmed: true },
    };
  });
  return { nodes, edges };
}
