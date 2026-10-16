// The room the labels of the drawn edges need between the boxes they join, for the map closed up
// around its closed groups (./arrange.ts): two boxes joined by a labelled edge are kept far
// enough apart for the label to lie between them with the line showing on both sides of it.
// Pure: no React, no browser APIs.

import { aggregateCountLabel, edgeLabelSize, edgeLabelsShown, edgeLabelText } from './flow';
import type { Size } from './layout/types';
import type { ArchitectureModel } from './model';
import { rollupEdges } from './rollup';
import { wrapBalanced } from './text';
import type { LodLevel } from './visibility';

/** How much room a label is given between the two boxes of its edge. */
export const EDGE_LABEL_ROOM = {
  /** On each side of the label, along the edge: enough of the line for the arrowhead to show. */
  margin: 16,
  /** Lines a label may take to fit between two boxes: a long label wraps rather than push them apart. */
  lines: 2,
  /** The room is never more than this, however long the label. */
  maxWidth: 160,
  maxHeight: 72,
} as const;

/**
 * The room the labels need between pairs of drawn nodes: by {@link pairKey} of the two nodes,
 * the width and height a label between them takes, margins included.
 */
export type LabelRoom = ReadonlyMap<string, Size>;

/** Key of an unordered pair of node IDs (which contain no line breaks). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

/** The larger of two sizes in each dimension. */
function larger(a: Size, b: Size): Size {
  return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
}

/**
 * The room the labels of the edges drawn among `visible` take, by pair of drawn nodes: for every
 * rolled-up edge with a label — the count of an aggregate, the labels of parallel edges, the
 * `label [protocol]` of a single edge once `lodLevel` draws edge labels — the box of that label
 * as it would be drawn on {@link EDGE_LABEL_ROOM.lines} lines (`edgeLabelSize`), the margins
 * added, capped at the maxima; the largest where several edges join the same two nodes. Pairs
 * whose edges have no label are not in the map.
 */
export function labelRoom(
  model: ArchitectureModel,
  visible: ReadonlySet<string>,
  lodLevel: LodLevel,
): LabelRoom {
  const shown = edgeLabelsShown(lodLevel);
  const edgesById = new Map(model.edges.map((edge) => [edge.id, edge]));
  const room = new Map<string, Size>();
  for (const edge of rollupEdges(model, visible)) {
    if (edge.source === edge.target) continue;
    let text: string | undefined;
    if (edge.count > 1) {
      const members = edge.memberEdgeIds.map((id) => edgesById.get(id));
      const parallel = members.every(
        (member) => member?.from === edge.source && member.to === edge.target,
      );
      const labels = parallel
        ? members.flatMap((member) => (member ? (edgeLabelText(member) ?? []) : []))
        : [];
      text = shown && labels.length > 0 ? labels.join('\n') : aggregateCountLabel(edge.count);
    } else if (shown && edge.edge) {
      text = edgeLabelText(edge.edge);
    }
    if (text === undefined) continue;
    const label = edgeLabelSize(wrapBalanced(text, EDGE_LABEL_ROOM.lines));
    const size: Size = {
      width: Math.min(EDGE_LABEL_ROOM.maxWidth, label.width + 2 * EDGE_LABEL_ROOM.margin),
      height: Math.min(EDGE_LABEL_ROOM.maxHeight, label.height + 2 * EDGE_LABEL_ROOM.margin),
    };
    const key = pairKey(edge.source, edge.target);
    const known = room.get(key);
    room.set(key, known ? larger(known, size) : size);
  }
  return room;
}
