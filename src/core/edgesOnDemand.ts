// Edges on demand: every edge of the map hidden but those at the boxes the reader points at or
// has selected, and those of the focus — at every level of detail. Pure: no React, no browser
// APIs.

import type { FlowEdge, FlowGraph } from './flow';
import type { FocusSet } from './focus';

/** Class of an edge that "edges on demand" keeps out of sight. */
export const QUIET_CLASS = 'arch-quiet';

/**
 * What edges on demand looks up in a drawn flow while the pointer moves, built once per flow so
 * that a box under the pointer costs work in proportion to that box, not to the map.
 */
export interface OnDemandIndex {
  /** The boxes drawn (row bands are not boxes): a box that is not among them shows no edges. */
  readonly boxes: ReadonlySet<string>;
  /** The boxes drawn directly inside each drawn box. */
  readonly inside: ReadonlyMap<string, readonly string[]>;
  /** The rendered edges at each drawn box, as their places in `flow.edges`. */
  readonly edgesAt: ReadonlyMap<string, readonly number[]>;
}

export function onDemandIndex(flow: FlowGraph): OnDemandIndex {
  const boxes = new Set<string>();
  const inside = new Map<string, string[]>();
  for (const node of flow.nodes) {
    if (node.type === 'band') continue;
    boxes.add(node.id);
    if (node.parentId === undefined) continue;
    const list = inside.get(node.parentId);
    if (list) list.push(node.id);
    else inside.set(node.parentId, [node.id]);
  }
  const edgesAt = new Map<string, number[]>();
  const add = (id: string, at: number) => {
    const list = edgesAt.get(id);
    if (list) list.push(at);
    else edgesAt.set(id, [at]);
  };
  flow.edges.forEach((edge, at) => {
    add(edge.source, at);
    if (edge.target !== edge.source) add(edge.target, at);
  });
  return { boxes, inside, edgesAt };
}

/**
 * The boxes whose edges show when the boxes `ids` are pointed at or selected: each box with
 * everything drawn inside it, at any depth. A leaf or a closed group is itself only; an open
 * group is what the reader sees as that box — its frame and its contents — so its frame shows
 * the edges of all of it, and a box inside it only its own. IDs that are not drawn are kept and
 * show nothing.
 */
export function boxesAsked(index: OnDemandIndex, ids: Iterable<string>): Set<string> {
  const boxes = new Set<string>();
  const queue = [...ids];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (boxes.has(id)) continue;
    boxes.add(id);
    for (const child of index.inside.get(id) ?? []) queue.push(child);
  }
  return boxes;
}

function withClass(className: string | undefined, extra: string): string {
  return className === undefined || className === '' ? extra : `${className} ${extra}`;
}

/**
 * `flow` with every rendered edge hidden (class {@link QUIET_CLASS}, and `data.quiet` for its
 * label) except those that touch `nodeIds` (the boxes asked for, see {@link boxesAsked}), the
 * rendered edge `edgeId` (the selected one) and those the focus involves. Nothing is removed, so
 * the layout and the hit-testing of what is shown do not change. Edges kept as they are keep
 * their identity, and so, in the same order, does the list: `flow` itself when nothing is hidden.
 * The list of nodes is always that of `flow` itself: only edges are ever marked.
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

/**
 * `quiet` — made by {@link quietEdges} from `shown` — with the edges at the boxes `nodeIds`
 * shown again, each as `shown` has it. `index` is of a flow with the same edges in the same
 * order (`shown` itself, or the flow it was marked from). The work is in proportion to the
 * edges at those boxes, plus one copy of the list when anything changes; every other edge keeps
 * its identity, and `quiet` itself is returned when nothing changes. The list of nodes is always
 * that of `quiet` itself: whatever the pointer is on, the canvas is given the same nodes.
 */
export function revealEdges(
  quiet: FlowGraph,
  shown: FlowGraph,
  index: OnDemandIndex,
  nodeIds: Iterable<string>,
): FlowGraph {
  let edges: FlowEdge[] | undefined;
  for (const id of nodeIds) {
    for (const at of index.edgesAt.get(id) ?? []) {
      const edge = shown.edges[at];
      if (edge === undefined || quiet.edges[at] === edge) continue;
      edges ??= [...quiet.edges];
      edges[at] = edge;
    }
  }
  return edges ? { nodes: quiet.nodes, edges } : quiet;
}
