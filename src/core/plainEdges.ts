// Plain edges: the map as a reader of the story sees it. The plain edges stand in for the edges
// they replace, and a node that only the replaced edges connected is left out with everything
// inside it. Pure: no React, no browser APIs.

import { submodel, type Submodel } from './focusFilter';
import type { RowPlacement } from './layout/tiered';
import type { ArchEdge, ArchitectureModel } from './model';
import { withPlainEdges } from './navigate';

const NO_PLACED_ROWS: ReadonlyMap<string, string> = new Map();

/** The ends of `edges`, and every node one of them lies inside. */
function reachedBy(model: ArchitectureModel, edges: readonly ArchEdge[]): Set<string> {
  const reached = new Set<string>();
  for (const edge of edges) {
    for (const end of [edge.from, edge.to]) {
      for (let node = model.nodes.get(end); node && !reached.has(node.id);) {
        reached.add(node.id);
        node = node.parentId === undefined ? undefined : model.nodes.get(node.parentId);
      }
    }
  }
  return reached;
}

/**
 * `model` with the edges the map draws (`withPlainEdges`), as a model of its own. With the plain
 * edges shown, a node that only the replaced edges reached — an end of one of them, or holding
 * such an end, and of no edge that is left — is left out with everything inside it, so that the
 * map holds what the story needs. A node no edge reached in the first place stays, as does one
 * an edge still reaches: a group a plain edge ends at keeps its box when all its children go.
 * Rows as `submodel`: every node in the row it has on the whole map. Holds `model` itself when
 * the file has no plain edges.
 */
export function plainEdgesModel(
  model: ArchitectureModel,
  plain: boolean,
  placement?: RowPlacement,
): Submodel {
  const edged = withPlainEdges(model, plain);
  if (edged === model) return { model, placedRow: NO_PLACED_ROWS };
  const nodes = new Set(model.nodes.keys());
  if (plain) {
    const before = reachedBy(model, model.edges);
    const after = reachedBy(model, edged.edges);
    for (const id of before) if (!after.has(id)) nodes.delete(id);
  }
  return submodel(model, { nodes, edges: new Set(edged.edges.map((edge) => edge.id)) }, placement);
}
