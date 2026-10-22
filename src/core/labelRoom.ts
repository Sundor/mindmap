// The room the labels of the drawn edges need between the boxes they join, for the map closed up
// around its closed groups (./arrange.ts): two boxes joined by a labelled edge are kept far
// enough apart for the label to lie between them with the line showing on both sides of it.
// Pure: no React, no browser APIs.

import { aggregateCountLabel, edgeLabelText, labelRoomOf } from './edgeLabel';
import { EDGE_LABEL_CLEARANCE, EDGE_LABEL_LAYOUT_LINES } from './layout/constants';
import type { Size } from './layout/types';
import type { ArchitectureModel } from './model';
import { rollupEdges } from './rollup';

/**
 * How much room a label is given between the two boxes of its edge: the rule of the layout
 * (`labelRoomOf` with the layout's clearance and lines), so that an arrangement of a layout in
 * which nothing closed reproduces the layout.
 */
export const EDGE_LABEL_ROOM = {
  /** On each side of the label: enough of the line for the arrowhead to show. */
  margin: EDGE_LABEL_CLEARANCE,
  /** Lines a label may take to fit between two boxes: a long label wraps rather than push them apart. */
  lines: EDGE_LABEL_LAYOUT_LINES,
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
 * `label [protocol]` of a single edge while `shown` says labels are drawn — the box of that label
 * as it would be drawn on {@link EDGE_LABEL_ROOM.lines} lines (`edgeLabelSize`), the margins
 * added; the largest where several edges join the same two nodes. Pairs whose edges have no
 * label are not in the map.
 */
export function labelRoom(
  model: ArchitectureModel,
  visible: ReadonlySet<string>,
  shown = true,
): LabelRoom {
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
    // The labels of parallel edges each on their own line: as wide as the widest of them takes
    // on its own (the rule the layout keeps room by, per edge), as high as all of them.
    const parts = text.split('\n');
    const size: Size =
      parts.length > 1
        ? {
            width: Math.max(
              ...parts.map(
                (part) => labelRoomOf(part, EDGE_LABEL_ROOM.lines, EDGE_LABEL_ROOM.margin).width,
              ),
            ),
            height: labelRoomOf(text, 1, EDGE_LABEL_ROOM.margin).height,
          }
        : labelRoomOf(text, EDGE_LABEL_ROOM.lines, EDGE_LABEL_ROOM.margin);
    const key = pairKey(edge.source, edge.target);
    const known = room.get(key);
    room.set(key, known ? larger(known, size) : size);
  }
  return room;
}
