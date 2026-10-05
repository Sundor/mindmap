// Layout geometry constants. All values are in canvas pixels at zoom 1.

import type { ArchNode, NodeLevel } from '../model';
import type { Size } from './types';

/** Default leaf size per level (domain, component, subcomponent); widths grow for long names. */
export const LEAF_SIZE: Readonly<Record<NodeLevel, { width: number; height: number }>> = {
  0: { width: 200, height: 72 },
  1: { width: 180, height: 60 },
  2: { width: 160, height: 48 },
};

/** Height of a group's header bar (name, chevron, badges). */
export const HEADER_HEIGHT = 40;

/** Inner padding of a group; `top` includes the header bar. */
export const GROUP_PADDING = { top: HEADER_HEIGHT + 8, right: 16, bottom: 16, left: 16 } as const;

/** ELK spacing between sibling nodes, and between layers. */
export const NODE_SPACING = 24;
export const LAYER_SPACING = 48;
/** ELK padding around the whole canvas when there are no rows. */
export const CANVAS_PADDING = 24;

/** Horizontal gap between items packed left → right in a container (rows mode). */
export const ITEM_GAP = 32;
/** Width of the band label gutter on the left of the rows. */
export const ROW_GUTTER_WIDTH = 140;
/** Vertical padding inside a band, above and below its content. */
export const BAND_PADDING_Y = 16;
/** Horizontal padding between the gutter / band end and the content. */
export const BAND_PADDING_X = 24;
/** Minimum band height (a band with no content still shows its label). */
export const MIN_BAND_HEIGHT = 96;

/** Unassigned side area: title strip, inner padding, gap between items, minimum width. */
export const UNASSIGNED_HEADER = 36;
export const UNASSIGNED_PADDING = 24;
export const UNASSIGNED_GAP = 24;
export const UNASSIGNED_MIN_WIDTH = 200;

const LEAF_CHAR_WIDTH = 8.6;
const HEADER_CHAR_WIDTH = 10;

/** ELK options shared by every ELK run (plain layouts and item ordering). */
export const ELK_BASE_OPTIONS: Readonly<Record<string, string>> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': String(NODE_SPACING),
  'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_SPACING),
  'elk.spacing.edgeNode': '16',
  'elk.spacing.edgeEdge': '8',
  // Where the graph leaves freedom, follow YAML order. ELK is deterministic for a fixed seed.
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.randomSeed': '1',
};

/**
 * Fingerprint of every constant that shapes the geometry. It is part of the layout cache key, so
 * changing a constant invalidates cached layouts without bumping `LAYOUT_ALGORITHM_VERSION`
 * (which remains for changes to the code itself).
 */
export const LAYOUT_CONFIG = {
  leafSize: LEAF_SIZE,
  groupPadding: GROUP_PADDING,
  nodeSpacing: NODE_SPACING,
  layerSpacing: LAYER_SPACING,
  canvasPadding: CANVAS_PADDING,
  itemGap: ITEM_GAP,
  rowGutterWidth: ROW_GUTTER_WIDTH,
  bandPaddingX: BAND_PADDING_X,
  bandPaddingY: BAND_PADDING_Y,
  minBandHeight: MIN_BAND_HEIGHT,
  unassigned: {
    header: UNASSIGNED_HEADER,
    padding: UNASSIGNED_PADDING,
    gap: UNASSIGNED_GAP,
    minWidth: UNASSIGNED_MIN_WIDTH,
  },
  leafCharWidth: LEAF_CHAR_WIDTH,
  headerCharWidth: HEADER_CHAR_WIDTH,
  elk: ELK_BASE_OPTIONS,
} as const;

function roundUp8(value: number): number {
  return Math.ceil(value / 8) * 8;
}

/**
 * Size of a node without children: level default, widened to fit its name on one line. With a
 * `content` block (see `ComputeLayoutOptions.content`) it is at least as wide as the block and
 * taller by the block's height: the block sits below the name.
 */
export function leafSize(node: ArchNode, content?: Size): { width: number; height: number } {
  const base = LEAF_SIZE[node.level];
  const width = Math.max(base.width, roundUp8(node.name.length * LEAF_CHAR_WIDTH + 32));
  if (!content) return { width, height: base.height };
  return { width: Math.max(width, content.width), height: base.height + content.height };
}

/**
 * Minimum width of a group so its header (chevron, name, count badges) fits, and its `content`
 * block when it has one.
 */
export function groupMinWidth(node: ArchNode, content?: Size): number {
  const header = Math.max(
    LEAF_SIZE[node.level].width,
    roundUp8(node.name.length * HEADER_CHAR_WIDTH + 64),
  );
  return content ? Math.max(header, content.width) : header;
}

/** Minimum height of a group: header, its `content` block if any, padding and one leaf row. */
export function groupMinHeight(content?: Size): number {
  return GROUP_PADDING.top + (content?.height ?? 0) + LEAF_SIZE[2].height + GROUP_PADDING.bottom;
}

/**
 * Inner padding of a group with a `content` block: the block lies between the header and the
 * children, so the top padding grows by its height.
 */
export function groupPadding(content?: Size): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  return content ? { ...GROUP_PADDING, top: GROUP_PADDING.top + content.height } : GROUP_PADDING;
}
