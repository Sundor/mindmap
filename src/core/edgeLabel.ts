// What an edge says on the map and how much room that takes: the type the labels are set in and
// an upper estimate of a label's box. Shared by the layout, which keeps the room free, and by
// the flow, which places the labels. Pure: no React, no browser APIs.

import type { Size } from './layout/types';
import type { ArchEdge } from './model';
import { estimateTextWidth, wrapBalanced } from './text';

/**
 * The label of an edge as the style sheet draws it (`.arch-edge-label` in styles.css), a little
 * generously: what its box is estimated from when a place is chosen for it (`placeLabel`) and
 * when the layout keeps room for it.
 */
export const EDGE_LABEL = {
  fontSize: 14,
  lineHeight: 19,
  paddingX: 7,
  paddingY: 2,
  /** A label that fits nowhere on one line is broken into at most this many. */
  maxLines: 3,
} as const;

/** Count label of an aggregate edge, e.g. "×3". */
export function aggregateCountLabel(count: number): string {
  return `×${count}`;
}

/** Text shown on an edge: `label [protocol]`, either part alone, or undefined. */
export function edgeLabelText(edge: Pick<ArchEdge, 'label' | 'protocol'>): string | undefined {
  if (edge.label !== undefined && edge.protocol !== undefined) {
    return `${edge.label} [${edge.protocol}]`;
  }
  return edge.label ?? edge.protocol;
}

/**
 * The room a label saying `text` takes between the two ends of its edge: the box of the label
 * on up to `lines` lines, grown by `clearance` on every side, in whole pixels (the layout stays
 * on whole pixels, as it is without labels). The layout keeps this room free on the line
 * between the two ends, and the map closed up around its closed groups keeps it between the
 * boxes (src/core/labelRoom.ts): one rule, so that the one reproduces the other.
 */
export function labelRoomOf(text: string, lines: number, clearance: number): Size {
  const size = edgeLabelSize(wrapBalanced(text, lines));
  return {
    width: Math.ceil(size.width + 2 * clearance),
    height: Math.ceil(size.height + 2 * clearance),
  };
}

/** {@link labelRoomOf} for the label of `edge`; undefined for an edge without a label. */
export function edgeLabelRoom(
  edge: Pick<ArchEdge, 'label' | 'protocol'>,
  lines: number,
  clearance: number,
): Size | undefined {
  const text = edgeLabelText(edge);
  return text === undefined ? undefined : labelRoomOf(text, lines, clearance);
}

/** Upper estimate of the box of an edge label showing `text` (one line per line break). */
export function edgeLabelSize(text: string): Size {
  const lines = text.split('\n');
  const widest = Math.max(0, ...lines.map((line) => estimateTextWidth(line, EDGE_LABEL.fontSize)));
  return {
    width: widest + 2 * EDGE_LABEL.paddingX,
    height: lines.length * EDGE_LABEL.lineHeight + 2 * EDGE_LABEL.paddingY,
  };
}
