// What an edge says on the map and how much room that takes: the type the labels are set in and
// an upper estimate of a label's box. Shared by the layout, which keeps the room free, and by
// the flow, which places the labels. Pure: no React, no browser APIs.

import type { Size } from './layout/types';
import type { ArchEdge } from './model';
import { estimateTextWidth } from './text';

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

/** Text shown on an edge: `label [protocol]`, either part alone, or undefined. */
export function edgeLabelText(edge: Pick<ArchEdge, 'label' | 'protocol'>): string | undefined {
  if (edge.label !== undefined && edge.protocol !== undefined) {
    return `${edge.label} [${edge.protocol}]`;
  }
  return edge.label ?? edge.protocol;
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
