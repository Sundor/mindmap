// Edge rollup: edges whose ends are hidden are re-attached to the nearest visible
// ancestors and merged into aggregates. Pure: no React, no browser APIs.

import type { ArchEdge, ArchitectureModel, EdgeKind } from './model';

export interface AggregateEdge {
  /** Stable ID derived from `source`, `target` and `kind` (see `aggregateEdgeId`). */
  readonly id: string;
  /** Visible node the member edges start at (or inside). */
  readonly source: string;
  /** Visible node the member edges end at (or inside). */
  readonly target: string;
  readonly kind: EdgeKind;
  /** Number of model edges merged into this one (≥ 1). */
  readonly count: number;
  /** IDs of the merged model edges, in document order. */
  readonly memberEdgeIds: readonly string[];
  /** The original edge when `count === 1`, so that its label and protocol can be rendered. */
  readonly edge?: ArchEdge;
}

/**
 * ID of the aggregate from `source` to `target` of `kind`. Node IDs never contain `>` or `:`
 * (src/core/ids.ts), so distinct triples give distinct IDs; the ID is the same in every collapse
 * state in which the aggregate exists.
 */
export function aggregateEdgeId(source: string, target: string, kind: EdgeKind): string {
  return `${source}>${target}:${kind}`;
}

/** `id` if it is visible, otherwise its nearest visible ancestor; undefined when there is none. */
export function nearestVisible(
  model: ArchitectureModel,
  visible: ReadonlySet<string>,
  id: string,
): string | undefined {
  let current: string | undefined = id;
  while (current !== undefined) {
    if (visible.has(current)) return current;
    current = model.nodes.get(current)?.parentId;
  }
  return undefined;
}

/**
 * The edges to draw for the nodes in `visible`:
 * 1. each end of every model edge is replaced by its nearest visible ancestor (itself if visible);
 * 2. edges whose two ends map to the same node are dropped (as are edges with an end that has no
 *    visible ancestor at all, which cannot happen for a set produced by `visibleNodes`);
 * 3. the rest are grouped by (source, target, kind) — direction and kind are preserved.
 *
 * Deterministic: aggregates come in the document order of their first member edge, and
 * `memberEdgeIds` in document order.
 */
export function rollupEdges(
  model: ArchitectureModel,
  visible: ReadonlySet<string>,
): AggregateEdge[] {
  const groups = new Map<
    string,
    { source: string; target: string; kind: EdgeKind; members: ArchEdge[] }
  >();
  const resolved = new Map<string, string | undefined>();
  const resolve = (id: string): string | undefined => {
    if (!resolved.has(id)) resolved.set(id, nearestVisible(model, visible, id));
    return resolved.get(id);
  };

  for (const edge of model.edges) {
    const source = resolve(edge.from);
    const target = resolve(edge.to);
    if (source === undefined || target === undefined || source === target) continue;
    const id = aggregateEdgeId(source, target, edge.kind);
    const group = groups.get(id);
    if (group) group.members.push(edge);
    else groups.set(id, { source, target, kind: edge.kind, members: [edge] });
  }

  const aggregates: AggregateEdge[] = [];
  for (const [id, group] of groups) {
    const [only] = group.members;
    aggregates.push({
      id,
      source: group.source,
      target: group.target,
      kind: group.kind,
      count: group.members.length,
      memberEdgeIds: group.members.map((edge) => edge.id),
      ...(group.members.length === 1 && only ? { edge: only } : {}),
    });
  }
  return aggregates;
}
