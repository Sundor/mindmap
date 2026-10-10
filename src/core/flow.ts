// Pure mapping from model + layout + view state (collapsed groups, level of detail) to React Flow
// nodes and edges.
// Plain data objects only: the shapes are structurally compatible with `@xyflow/react`'s `Node`
// and `Edge`, but nothing is imported from it, so this stays unit-testable in Node.

import type { LayoutResult, Rect, Size } from './layout/types';
import {
  distanceToCurve,
  edgeCurve,
  laneLabelT,
  laneOffset,
  labelRect,
  overlapArea,
  placeLabel,
  type LabelPlace,
  rectsTouch,
  routeEdge,
  routeReach,
  shiftAlongSide,
  sidePoint,
  type Curve,
  type EdgeRoute,
  type Point,
  type Side,
} from './route';
import {
  NODE_LEVEL_NAMES,
  type ArchEdge,
  type ArchitectureModel,
  type ArchNode,
  type EdgeKind,
  type NodeLevel,
  type NodeLevelName,
} from './model';
import { COMPACT_GROUP, compactGroupBox, fitsCompact, type CompactGroupBox } from './compactGroup';
import { rollupEdges, type AggregateEdge } from './rollup';
import { allGroupCounts, visibleNodes, type GroupCounts, type LodLevel } from './visibility';
import { estimateTextWidth, wrapBalanced } from './text';
import {
  workItemLines,
  workItemLinesRect,
  workItemTextRects,
  type WorkItemLine,
} from './workItemContent';
import {
  ownWorkItemCounts,
  subtreeWorkItemCounts,
  type WorkItemCounts,
  type WorkItemOverlay,
} from './workItemOverlay';
import type { StoryMode } from './workitems';

// --- Sides and handles ----------------------------------------------------------------------

export * from './route';
export * from './compactGroup';

/** ID of the hidden source handle on `side` (every node has one per side). */
export function sourceHandleId(side: Side): string {
  return `s-${side}`;
}

/** ID of the hidden target handle on `side` (every node has one per side). */
export function targetHandleId(side: Side): string {
  return `t-${side}`;
}

// --- Z order --------------------------------------------------------------------------------

/**
 * Explicit stacking order (the canvas runs React Flow in `zIndexMode: 'manual'`): bands at the
 * very back, then groups (nested groups above their parents), then edges, so an edge crossing a
 * group is never hidden behind the group's background, then leaf nodes and closed (collapsed)
 * groups. Edges are routed around the boxes drawn above them (`routeEdge`). The work-item lists
 * of open groups are drawn at the height of the leaves too (`NodeWorkItemLines.above`).
 */
export const Z_INDEX = { band: -10, group: 0, edge: 5, leaf: 10 } as const;

/**
 * The label of an edge as the style sheet draws it (`.arch-edge-label` in styles.css), a little
 * generously: what its box is estimated from when a place is chosen for it (`placeLabel`).
 */
export const EDGE_LABEL = {
  fontSize: 11,
  lineHeight: 15,
  paddingX: 7,
  paddingY: 2,
  /** A label that fits nowhere on one line is broken into at most this many. */
  maxLines: 3,
} as const;

/** The type a leaf name is set in, per level (`.arch-leaf` in styles.css), in pixels. */
const LEAF_NAME_FONT_SIZE: Readonly<Record<NodeLevel, number>> = { 0: 18, 1: 16, 2: 15 };

/**
 * Where the name of a leaf drawn in `box` is, generously: centred in the part of the box above
 * its work-item block (`blockHeight`), no wider than the box.
 */
function leafNameRect(box: Rect, name: string, level: NodeLevel, blockHeight: number): Rect {
  const width = Math.min(box.width, estimateTextWidth(name, LEAF_NAME_FONT_SIZE[level]));
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y,
    width,
    height: Math.max(0, box.height - blockHeight),
  };
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

// --- Nodes ----------------------------------------------------------------------------------

export type ArchNodeType = 'group' | 'leaf';

export type ArchNodeData = {
  readonly name: string;
  readonly level: NodeLevel;
  readonly levelName: NodeLevelName;
  readonly description?: string;
  readonly childCount: number;
  /** Children and descendants, plus the work-item counts shown on a collapsed group. */
  readonly counts: GroupCounts;
  /**
   * True for a group drawn as a closed box: it has children and none of them is visible, either
   * because it was collapsed by hand or because the level of detail hides its children.
   */
  readonly collapsed: boolean;
  /** True when the group is in the manually collapsed set (the chevron then expands it). */
  readonly manuallyCollapsed: boolean;
  /**
   * True for a closed group drawn shrunk around the middle of its box (`FlowView.compactCollapsed`)
   * instead of keeping the full box. False also for one whose full box cannot list even one of
   * its children (`fitsCompact`): that one is drawn as an ordinary collapsed group.
   */
  readonly compact: boolean;
  /** Names of the direct children, in document order: what a shrunk closed group lists. */
  readonly childNames: readonly string[];
  /**
   * How many of `childNames` (from the end) a shrunk group does not list, because even its full
   * box cannot hold them all (`compactGroupBox`); 0 otherwise. Always fewer than all of them.
   */
  readonly compactHidden: number;
  /** Name of the row derived from the node's connections ("placed by connections"). */
  readonly placedRowName?: string;
  /**
   * The work items the node lists, where they are drawn: at the `detail` level, on a leaf or an
   * open group, unless the story mode is Off. `rect` is the block the layout reserved for them,
   * relative to the node.
   */
  readonly workItems?: NodeWorkItemLines;
  /**
   * The block the layout reserved in the node for its work items, relative to the node, at every
   * level of detail (unless the story mode is Off): the name of a leaf stays above it, and the
   * badge of a leaf or an open group is drawn in it.
   */
  readonly contentRect?: Rect;
  /**
   * The work-item counts shown as a badge where the lines are not drawn: at the coarser levels
   * and on closed groups, unless the story mode is Off. Counted over the node and everything
   * hidden inside it (an open group: its own items only); absent when that is nothing.
   */
  readonly badge?: WorkItemCounts;
};

/** Where something is written in the drawn boxes, in canvas coordinates (upper estimates). */
interface BoxTexts {
  /** Names of leaves; closed groups as a whole. */
  readonly names: Rect[];
  /** Work-item lines. */
  readonly lines: Rect[];
}

/** The work-item lines drawn in a node, and where. */
export interface NodeWorkItemLines {
  readonly lines: readonly WorkItemLine[];
  /** The block the layout reserved, relative to the node. */
  readonly rect: Rect;
  /**
   * For an open group: the part of the block its list covers (`workItemLinesRect`), in canvas
   * coordinates. A group lies below the edges, which cross it on their way to its children, so
   * its list is drawn in a layer of its own above them, and edges and labels keep clear of it
   * where they can. A leaf is above the edges anyway and draws its list itself.
   */
  readonly above?: Rect;
}

/** What toggling a group does to the manually collapsed set. */
export type CollapseAction = 'collapse' | 'expand';

/**
 * What the chevron (or a double-click) does for a node, or undefined when toggling is not
 * offered: the node is not a group, or it is closed only by the level of detail. Toggling edits
 * the manual set alone, so on a group closed by the level of detail it would store a collapse
 * while the box stays closed; such a group opens by zooming in instead.
 */
export function collapseAction(
  data: Pick<ArchNodeData, 'childCount' | 'collapsed' | 'manuallyCollapsed'>,
): CollapseAction | undefined {
  if (data.childCount === 0) return undefined;
  if (data.manuallyCollapsed) return 'expand';
  return data.collapsed ? undefined : 'collapse';
}

export type BandNodeData = {
  readonly variant: 'row' | 'unassigned';
  readonly name: string;
  /** Position in the stack of bands, for alternating tints; 0 for the Unassigned area. */
  readonly index: number;
  /** Width of the label gutter at the left of a row band; 0 for the Unassigned area. */
  readonly gutterWidth: number;
};

type FlowNodeBase = {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  style: { width: number; height: number };
  /** Model nodes can be moved by hand while the positions are unlocked; bands never. */
  draggable: boolean;
  connectable: false;
  deletable: false;
  zIndex: number;
};

export type ArchFlowNode = FlowNodeBase & {
  type: ArchNodeType;
  data: ArchNodeData;
  parentId?: string;
  extent?: 'parent';
  /** Set by `highlightFlow` (src/core/selection.ts): dimmed outside the neighbourhood. */
  className?: string;
  /** Set by `highlightFlow` on the selected node. */
  selected?: boolean;
};

export type BandFlowNode = FlowNodeBase & {
  type: 'band';
  data: BandNodeData;
  selectable: false;
  focusable: false;
  className: string;
};

export type FlowNode = ArchFlowNode | BandFlowNode;

const BAND_ID_PREFIX = '__row__:';
/** Node ID of the Unassigned side area. Never collides with a model ID (those are lowercase). */
export const UNASSIGNED_NODE_ID = '__area__:unassigned';
export const UNASSIGNED_LABEL = 'Unassigned';
/** Tooltip of nodes whose row was derived from their connections. */
export const PLACED_BY_CONNECTIONS = 'placed by connections';

/** React Flow node ID of a row band. Never collides with a model ID. */
export function bandNodeId(rowId: string): string {
  return `${BAND_ID_PREFIX}${rowId}`;
}

function bandNode(id: string, rect: Rect, data: BandNodeData): BandFlowNode {
  return {
    id,
    type: 'band',
    position: { x: rect.x, y: rect.y },
    width: rect.width,
    height: rect.height,
    style: { width: rect.width, height: rect.height },
    data,
    selectable: false,
    focusable: false,
    draggable: false,
    connectable: false,
    deletable: false,
    zIndex: Z_INDEX.band,
    className: 'arch-band-node',
  };
}

// --- Edges ----------------------------------------------------------------------------------

/**
 * How an edge is drawn. Edges joining the same two nodes (in either direction, of any kind) share
 * one route and run side by side in `lanes` lanes, so that none hides another.
 */
export type ArchEdgeRoute = EdgeRoute & {
  /** Lane of this edge among those joining the same two nodes, in document order. */
  readonly lane: number;
  readonly lanes: number;
  /**
   * Shift of both ends along the sides they attach to, in canvas pixels (x on top/bottom sides,
   * y on left/right sides).
   */
  readonly offset: number;
  /**
   * Curve parameter (0–1, from the source) at which the label sits: staggered between lanes,
   * and moved along the curve where it would cover the text of a box (`placeLabel`; beyond the
   * ends of a very short edge, see `labelPoint`).
   */
  readonly labelT: number;
};

export type ArchEdgeData = {
  readonly kind: EdgeKind;
  /** Number of model edges this rendered edge stands for; more than 1 for an aggregate. */
  readonly count: number;
  /** IDs of those model edges, in document order. */
  readonly memberEdgeIds: readonly string[];
  readonly label?: string;
  readonly protocol?: string;
  readonly description?: string;
  /**
   * For an aggregate of parallel edges (every member joins the two drawn nodes themselves, none
   * is rolled up from inside a closed group): the members' `label [protocol]` texts, in document
   * order, drawn on top of each other in place of the count.
   */
  readonly labels?: readonly string[];
  /**
   * Whether a single edge draws its `label [protocol]`: only at the `detail` level. The count
   * label of an aggregate is drawn at every level.
   */
  readonly labelShown: boolean;
  /**
   * The label as drawn when it differs from {@link flowEdgeLabel}: the same words on more
   * lines, because on one line it would cover the text of a box (`placeLabel`).
   */
  readonly labelText?: string;
  /**
   * Set when the label is not drawn because it has no place: wherever it went along its edge
   * (two boxes close together) it would lie on a work-item line. The canvas then shows it as
   * the tooltip of the edge; the detail panel shows it as for any edge.
   */
  readonly labelHidden?: boolean;
  readonly route: ArchEdgeRoute;
  /**
   * The line of the edge in canvas coordinates, as computed from the layout: what a click is
   * compared with ({@link nearestEdgeAt}). The edge is drawn with the same {@link routeCurve}.
   */
  readonly curve: Curve;
  /** Set by `highlightFlow`: outside the neighbourhood of the selection (dims the label). */
  readonly dimmed?: boolean;
  /** Set by `focusFlow` (src/core/focus.ts): not involved in the focus (pales the label). */
  readonly faded?: boolean;
  /** Set by `quietEdges` (src/core/edgesOnDemand.ts): out of sight until asked for (no label). */
  readonly quiet?: boolean;
};

export type FlowEdge = {
  id: string;
  type: 'arch';
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  data: ArchEdgeData;
  className: string;
  interactionWidth: number;
  zIndex: number;
  deletable: false;
  reconnectable: false;
  /** Set by `highlightFlow` on the selected edge. */
  selected?: boolean;
};

/** Hit-area width of an edge, in pixels: generous, so that a thin line is easy to click. */
export const EDGE_INTERACTION_WIDTH = 20;

/**
 * The curve of an edge between the middles of the node sides it attaches to (`sourceMid`,
 * `targetMid`: where the hidden handles sit), shifted into its lane.
 */
export function routeCurve(
  sourceMid: Point,
  targetMid: Point,
  route: Pick<ArchEdgeRoute, 'sourceSide' | 'targetSide' | 'sourceDir' | 'targetDir' | 'offset'>,
): Curve {
  return edgeCurve(
    shiftAlongSide(sourceMid, route.sourceSide, route.offset),
    route.sourceDir,
    shiftAlongSide(targetMid, route.targetSide, route.offset),
    route.targetDir,
  );
}

/**
 * The rendered edge whose line is nearest to `point` (canvas coordinates), or undefined when
 * none is within `maxDistance`. Edges running side by side are closer together than their hit
 * areas are wide, so the hit areas overlap and the element under the pointer may belong to a
 * neighbour: a click is therefore resolved by distance to the lines, not by what is on top.
 * Of edges at the same distance the one drawn last (on top) wins. An edge that edges on demand
 * keeps out of sight is not there to be clicked.
 */
export function nearestEdgeAt<E extends { readonly data: Pick<ArchEdgeData, 'curve' | 'quiet'> }>(
  point: Point,
  edges: readonly E[],
  maxDistance: number = EDGE_INTERACTION_WIDTH / 2,
): E | undefined {
  let best: E | undefined;
  let bestDistance = Infinity;
  for (const edge of edges) {
    if (edge.data.quiet === true) continue;
    const distance = distanceToCurve(point, edge.data.curve);
    if (distance <= maxDistance && distance <= bestDistance) {
      best = edge;
      bestDistance = distance;
    }
  }
  return best;
}

/** Text shown on an edge: `label [protocol]`, either part alone, or undefined. */
export function edgeLabelText(edge: Pick<ArchEdge, 'label' | 'protocol'>): string | undefined {
  if (edge.label !== undefined && edge.protocol !== undefined) {
    return `${edge.label} [${edge.protocol}]`;
  }
  return edge.label ?? edge.protocol;
}

/** Count label of an aggregate edge, e.g. "×3". */
export function aggregateCountLabel(count: number): string {
  return `×${count}`;
}

/** True when single edges draw their labels at `lodLevel`: from `subcomponents` on. */
export function edgeLabelsShown(lodLevel: LodLevel): boolean {
  return lodLevel === 'subcomponents' || lodLevel === 'detail';
}

/**
 * Text shown on a rendered edge: the count for an aggregate at every level of
 * detail, otherwise the original edge's `label [protocol]` unless the level of detail hides
 * edge labels (`labelShown === false`).
 */
export function flowEdgeLabel(
  data: Pick<ArchEdgeData, 'count' | 'label' | 'protocol'> &
    Partial<Pick<ArchEdgeData, 'labelShown' | 'labels'>>,
): string | undefined {
  if (data.count > 1) {
    // Parallel edges show all their labels (one per line) where single edges show theirs.
    if (data.labelShown !== false && data.labels !== undefined && data.labels.length > 0) {
      return data.labels.join('\n');
    }
    return aggregateCountLabel(data.count);
  }
  return data.labelShown === false ? undefined : edgeLabelText(data);
}

function sideLength(rect: Rect, side: Side): number {
  return side === 'top' || side === 'bottom' ? rect.width : rect.height;
}

function reverseRoute(route: EdgeRoute): EdgeRoute {
  return {
    sourceSide: route.targetSide,
    targetSide: route.sourceSide,
    sourceDir: route.targetDir,
    targetDir: route.sourceDir,
  };
}

/**
 * Routes already worked out for a layout. Scoring the candidate curves against the boxes is by
 * far the most expensive part of `buildFlow`, and a route depends only on its two ends and on the
 * closed boxes within its reach (`routeReach`) — all fixed by the layout — so it is kept across
 * rebuilds: toggling an edge kind or returning to a level of detail routes nothing again, and
 * collapsing a group reroutes only the edges passing near it.
 */
const routeCaches = new WeakMap<LayoutResult, Map<string, EdgeRoute>>();
/** Entries per layout before the cache starts over (a bound on memory, not a tuning knob). */
const ROUTE_CACHE_LIMIT = 20_000;

function routeCacheOf(layout: LayoutResult): Map<string, EdgeRoute> {
  let cache = routeCaches.get(layout);
  if (!cache) {
    cache = new Map();
    routeCaches.set(layout, cache);
  }
  return cache;
}

/** Number of routes kept for `layout` (for tests and diagnostics). */
export function routeCacheSize(layout: LayoutResult): number {
  return routeCaches.get(layout)?.size ?? 0;
}

/**
 * Rendered edges for the rolled-up `aggregates`. Sides and routes are computed from the absolute
 * rectangles of the visible endpoints; `closed` are the visible nodes drawn above edges (leaves
 * and closed groups).
 */
function buildEdges(
  aggregates: readonly AggregateEdge[],
  layout: LayoutResult,
  closed: ReadonlySet<string>,
  labelShown: boolean,
  model: ArchitectureModel,
  /** Absolute boxes that differ from the layout's: closed groups drawn shrunk. */
  shrunk: ReadonlyMap<string, Rect>,
  /** Absolute boxes of the work-item lists of open groups, drawn above edges too. */
  lists: ReadonlyMap<string, Rect> = new Map(),
  /** Absolute boxes of what is written in the boxes, which no label should lie on. */
  texts: BoxTexts = { names: [], lines: [] },
): FlowEdge[] {
  const absolute = (id: string): Rect | undefined => shrunk.get(id) ?? layout.absolute.get(id);
  const edgesById = new Map(model.edges.map((edge) => [edge.id, edge]));
  const rectOf = (id: string, edgeId: string): Rect => {
    const rect = absolute(id);
    if (!rect) throw new Error(`Layout has no rectangle for an end of ${edgeId}`);
    return rect;
  };
  // Leaf nodes and closed groups are drawn above edges, so edges are routed around them.
  const obstacles: { readonly id: string; readonly rect: Rect }[] = [];
  for (const id of closed) {
    const rect = absolute(id);
    if (rect) obstacles.push({ id, rect });
  }
  // So are the work-item lists of open groups. (Node IDs have no "#", so the names differ.)
  for (const [id, rect] of lists) obstacles.push({ id: `${id}#workitems`, rect });
  // Naming the shrunk nodes keeps their routes apart from the full-box ones. With the size: a
  // shrunk box is taller with a badge, which comes and goes with the work items shown, not with
  // the layout the routes are remembered for.
  const keyPrefix =
    shrunk.size > 0
      ? `shrunk ${[...shrunk].map(([id, rect]) => `${id}:${rect.width}x${rect.height}`).join(' ')}\n`
      : '';
  const routes = routeCacheOf(layout);
  const routeBetween = (
    sourceId: string,
    source: Rect,
    targetId: string,
    target: Rect,
    acrossRows: boolean,
  ): EdgeRoute => {
    const reach = routeReach(source, target);
    const near = obstacles.filter((obstacle) => rectsTouch(obstacle.rect, reach));
    // Node IDs contain neither spaces nor line breaks.
    const key = `${keyPrefix}${sourceId}\n${targetId}\n${acrossRows ? 1 : 0}\n${near.map((o) => o.id).join(' ')}`;
    let route = routes.get(key);
    if (!route) {
      route = routeEdge(
        source,
        target,
        near.map((o) => o.rect),
        acrossRows,
      );
      if (routes.size >= ROUTE_CACHE_LIMIT) routes.clear();
      routes.set(key, route);
    }
    return route;
  };

  // Edges joining the same two nodes, whatever their direction and kind, share one route.
  interface Pair {
    readonly from: string;
    readonly route: EdgeRoute;
    readonly sideLength: number;
    /** Middles of the sides the route attaches to, at the `from` node and at the other one. */
    readonly fromMid: Point;
    readonly toMid: Point;
    readonly edgeIds: string[];
  }
  const pairs = new Map<string, Pair>();
  const pairOf = new Map<string, Pair>();
  for (const edge of aggregates) {
    const key =
      edge.source < edge.target
        ? `${edge.source}\n${edge.target}`
        : `${edge.target}\n${edge.source}`;
    let pair = pairs.get(key);
    if (!pair) {
      const source = rectOf(edge.source, edge.id);
      const target = rectOf(edge.target, edge.id);
      const sourceRow = layout.rowOf.get(edge.source);
      const targetRow = layout.rowOf.get(edge.target);
      const acrossRows =
        sourceRow !== undefined && targetRow !== undefined && sourceRow !== targetRow;
      const route = routeBetween(edge.source, source, edge.target, target, acrossRows);
      pair = {
        from: edge.source,
        route,
        sideLength: Math.min(
          sideLength(source, route.sourceSide),
          sideLength(target, route.targetSide),
        ),
        fromMid: sidePoint(source, route.sourceSide),
        toMid: sidePoint(target, route.targetSide),
        edgeIds: [],
      };
      pairs.set(key, pair);
    }
    pair.edgeIds.push(edge.id);
    pairOf.set(edge.id, pair);
  }

  const edges = aggregates.map((edge): FlowEdge => {
    const pair = pairOf.get(edge.id);
    if (!pair) throw new Error(`Edge ${edge.id} has no route`);
    const lane = pair.edgeIds.indexOf(edge.id);
    const lanes = pair.edgeIds.length;
    const forward = edge.source === pair.from;
    const base = forward ? pair.route : reverseRoute(pair.route);
    // Labels are staggered along the shared route, so measured from the same end for every lane.
    const labelT = laneLabelT(lane, lanes);
    const route: ArchEdgeRoute = {
      ...base,
      lane,
      lanes,
      offset: laneOffset(lane, lanes, pair.sideLength),
      labelT: forward ? labelT : 1 - labelT,
    };
    // Only a single edge shows its own label, protocol and description.
    const original = edge.count === 1 ? edge.edge : undefined;
    const members =
      edge.count > 1 ? edge.memberEdgeIds.map((memberId) => edgesById.get(memberId)) : [];
    const parallel =
      members.length > 0 &&
      members.every((member) => member?.from === edge.source && member.to === edge.target);
    const labels = parallel
      ? members.flatMap((member) => (member ? (edgeLabelText(member) ?? []) : []))
      : [];
    return {
      id: edge.id,
      type: 'arch',
      source: edge.source,
      target: edge.target,
      sourceHandle: sourceHandleId(route.sourceSide),
      targetHandle: targetHandleId(route.targetSide),
      data: {
        kind: edge.kind,
        count: edge.count,
        memberEdgeIds: edge.memberEdgeIds,
        ...(original?.label !== undefined ? { label: original.label } : {}),
        ...(original?.protocol !== undefined ? { protocol: original.protocol } : {}),
        ...(original?.description !== undefined ? { description: original.description } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        labelShown,
        route,
        curve: forward
          ? routeCurve(pair.fromMid, pair.toMid, route)
          : routeCurve(pair.toMid, pair.fromMid, route),
      },
      className:
        edge.count > 1 ? `arch-edge-${edge.kind} arch-edge-aggregate` : `arch-edge-${edge.kind}`,
      interactionWidth: EDGE_INTERACTION_WIDTH,
      zIndex: Z_INDEX.edge,
      deletable: false,
      reconnectable: false,
    };
  });

  // Labels are drawn above everything, so one lying on a box may cover what is written in it:
  // each is moved along its curve to where it covers no text (the name of a leaf, a closed
  // group, a work-item line) and no label placed before it. In document order of the edges.
  const labels: Rect[] = [];
  return edges.map((edge) => {
    const text = flowEdgeLabel(edge.data);
    if (text === undefined) return edge;
    const { curve, route } = edge.data;
    interface Choice {
      readonly text: string;
      readonly size: Size;
      readonly place: LabelPlace;
    }
    // A label too wide for the room between two boxes is broken into more lines, as few as it
    // takes to cover nothing.
    const choose = (obstacles: readonly Rect[]): Choice | undefined => {
      let best: Choice | undefined;
      let previous: string | undefined;
      for (let lines = 1; lines <= EDGE_LABEL.maxLines; lines++) {
        const wrapped = wrapBalanced(text, lines);
        if (wrapped === previous) break;
        previous = wrapped;
        const size = edgeLabelSize(wrapped);
        const place = placeLabel(curve, size, route.labelT, obstacles);
        if (!best || place.covered < best.place.covered) best = { text: wrapped, size, place };
        if (place.covered === 0) break;
      }
      return best;
    };
    // Clear of everything written and of the other labels; failing that, of what is written
    // (two labels on each other is the lesser evil); failing that, where it covers the least
    // of a name, as long as it covers no work-item line. A label that would lie on a work-item
    // line wherever it went is left out: the lines are there to be read and clicked, and the
    // label is still the tooltip of its edge and in the panel of the edge.
    const written = [...texts.names, ...texts.lines];
    let best = choose([...written, ...labels]);
    if (best && best.place.covered > 0) best = choose(written);
    if (best && best.place.covered > 0) {
      const box = labelRect(curve, best.place.t, best.size);
      if (texts.lines.some((line) => overlapArea(box, line) > 0)) {
        best = choose(texts.lines);
        if (best && best.place.covered > 0) {
          return { ...edge, data: { ...edge.data, labelHidden: true } };
        }
      }
    }
    if (!best) return edge;
    const labelT = best.place.t;
    labels.push(labelRect(curve, labelT, best.size));
    if (labelT === route.labelT && best.text === text) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        route: { ...route, labelT },
        ...(best.text === text ? {} : { labelText: best.text }),
      },
    };
  });
}

// --- Mapping --------------------------------------------------------------------------------

export interface FlowGraph {
  /** Bands first, then the visible model nodes in document order (parents before children). */
  nodes: FlowNode[];
  /** The rolled-up edges (`rollupEdges`), in the document order of their first member. */
  edges: FlowEdge[];
}

/** What of the model is shown. The default is everything: nothing collapsed, full detail. */
export interface FlowView {
  /** Manually collapsed groups; unknown IDs and IDs of nodes without children are ignored. */
  readonly collapsedIds?: ReadonlySet<string>;
  readonly lodLevel?: LodLevel;
  /**
   * Draw closed groups shrunk around the middle of their box ({@link compactGroupBox}) instead
   * of keeping the full box ({@link closedGroupSize}). Nothing else moves; edges attach to the
   * shrunk box. On a layout closed up around what is drawn (`arrangeLayout`) the box of a closed
   * group already has that size, and the group fills it.
   */
  readonly compactCollapsed?: boolean;
  /** Positions unlocked: the model nodes can be dragged (see src/core/positions.ts). */
  readonly draggable?: boolean;
  /**
   * The work items to show and how. The layout must have been computed with the
   * content of the same overlay and mode (`workItemContent`): lines are drawn only in the
   * blocks it reserved. Without this, or in mode `off`, nothing about work items is on the
   * canvas.
   */
  readonly workItems?: FlowWorkItems;
}

export interface FlowWorkItems {
  readonly overlay: WorkItemOverlay;
  readonly mode: StoryMode;
}

const NOTHING_COLLAPSED: ReadonlySet<string> = new Set();

/**
 * Whether the closed group `nodeId` gets the work-item badge line: work items are drawn
 * (`workItems` given, mode not `off`) and stories are hidden inside it.
 */
export function closedGroupBadge(workItems: FlowWorkItems | undefined, nodeId: string): boolean {
  return (
    workItems !== undefined &&
    workItems.mode !== 'off' &&
    subtreeWorkItemCounts(workItems.overlay, nodeId).stories > 0
  );
}

function childNamesOf(model: ArchitectureModel, node: ArchNode): string[] {
  return node.childIds.map((child) => model.nodes.get(child)?.name ?? child);
}

/**
 * The box of the closed group `node` drawn shrunk inside `rect` ({@link compactGroupBox}), with
 * a line for the work-item badge when `badge`. Undefined when that box would list none of the
 * children: a full box that small stays an ordinary collapsed group.
 */
function shrunkGroupBox(
  node: ArchNode,
  childNames: readonly string[],
  rect: Rect,
  badge: boolean,
): CompactGroupBox | undefined {
  const box = compactGroupBox(rect, node.name, childNames, badge ? COMPACT_GROUP.badgeLine : 0);
  return fitsCompact(box, childNames) ? box : undefined;
}

/**
 * Size `buildFlow` draws the closed group `node` at when its layout box is `full`: shrunk
 * (`view.compactCollapsed`, when the shrunk box lists at least one child) or the size of `full`.
 * A box of the shrunk size gives that size again, so a closed group laid out at this size is
 * drawn filling its box.
 */
export function closedGroupSize(
  model: ArchitectureModel,
  node: ArchNode,
  full: Rect,
  view: Pick<FlowView, 'compactCollapsed' | 'workItems'>,
): Size {
  const box = view.compactCollapsed
    ? shrunkGroupBox(
        node,
        childNamesOf(model, node),
        full,
        closedGroupBadge(view.workItems, node.id),
      )
    : undefined;
  const rect = box?.rect ?? full;
  return { width: rect.width, height: rect.height };
}

/**
 * Absolute rectangles of the nodes {@link buildFlow} draws of `layout` through `view`, as it
 * draws them: a closed group drawn shrunk has its shrunk box, in the middle of the box the layout
 * gives it (a closed group that spans rows has a whole column there).
 */
export function drawnNodeRects(
  model: ArchitectureModel,
  layout: LayoutResult,
  view: Pick<FlowView, 'collapsedIds' | 'lodLevel' | 'compactCollapsed' | 'workItems'> = {},
): Map<string, Rect> {
  const visible = visibleNodes(
    model,
    view.collapsedIds ?? NOTHING_COLLAPSED,
    view.lodLevel ?? 'detail',
  );
  const rects = new Map<string, Rect>();
  for (const node of model.nodes.values()) {
    const full = visible.has(node.id) ? layout.absolute.get(node.id) : undefined;
    if (!full) continue;
    const closedGroup =
      node.childIds.length > 0 && !node.childIds.some((child) => visible.has(child));
    const box =
      view.compactCollapsed && closedGroup
        ? shrunkGroupBox(
            node,
            childNamesOf(model, node),
            full,
            closedGroupBadge(view.workItems, node.id),
          )
        : undefined;
    rects.set(node.id, box?.rect ?? full);
  }
  return rects;
}

/**
 * React Flow nodes and edges for the model as seen through `view`. Positions and sizes come
 * straight from the layout that is passed in (relative to the parent): the layout of the fully
 * expanded graph, in which a closed group keeps exactly the box it has when open and no node
 * moves whatever is collapsed, or that layout closed up around what is drawn
 * (`arrangeLayout`). Nothing is laid out here; hidden nodes are left out. Edges are the rollup
 * of the model's edges onto the visible nodes.
 *
 * Level of detail, always on top of the manual collapse, which wins:
 * - `domains`: domains only, drawn as closed groups; edges aggregated between domains;
 * - `components`: components too (those with children drawn closed); labels of single edges
 *   hidden, counts of aggregates shown;
 * - `detail`: everything, with edge labels.
 * Row bands and the Unassigned area are the same at every level.
 *
 * Work items (`view.workItems`, mode not `off`): at the `detail` level leaves and open groups
 * list theirs in the block the layout reserved (`data.workItems`); everywhere else a node with
 * any gets the counts for a badge (`data.badge`), and `data.counts` carries the story and
 * open-bug counts of the whole subtree.
 */
export function buildFlow(
  model: ArchitectureModel,
  layout: LayoutResult,
  view: FlowView = {},
): FlowGraph {
  const collapsedIds = view.collapsedIds ?? NOTHING_COLLAPSED;
  const lodLevel = view.lodLevel ?? 'detail';
  const visible = visibleNodes(model, collapsedIds, lodLevel);
  const counts = allGroupCounts(model);
  const workItems = view.workItems?.mode === 'off' ? undefined : view.workItems;
  /** Visible nodes drawn as closed boxes, above the edges: leaves and closed groups. */
  const closed = new Set<string>();
  const nodes: FlowNode[] = [];
  const compactCollapsed = view.compactCollapsed ?? false;
  /** Absolute boxes of the closed groups drawn shrunk. */
  const shrunk = new Map<string, Rect>();
  /** Absolute boxes of the work-item lists of open groups, drawn above the edges. */
  const lists = new Map<string, Rect>();
  /** Absolute boxes of what is written in the boxes: names, and work-item lines. */
  const texts: BoxTexts = { names: [], lines: [] };

  layout.rows.forEach((band, index) => {
    nodes.push(
      bandNode(bandNodeId(band.id), band, {
        variant: 'row',
        name: band.name,
        index,
        gutterWidth: layout.gutterWidth,
      }),
    );
  });
  if (layout.unassignedArea) {
    nodes.push(
      bandNode(UNASSIGNED_NODE_ID, layout.unassignedArea, {
        variant: 'unassigned',
        name: UNASSIGNED_LABEL,
        index: 0,
        gutterWidth: 0,
      }),
    );
  }

  const rowNames = new Map(model.rows.map((row) => [row.id, row.name]));
  for (const node of model.nodes.values()) {
    if (!visible.has(node.id)) continue;
    const full = layout.rects.get(node.id);
    if (!full) throw new Error(`Layout has no rectangle for node ${node.id}`);
    const isGroup = node.childIds.length > 0;
    // Children are shown or hidden together, so none visible means the box is closed.
    const isClosed = !node.childIds.some((child) => visible.has(child));
    if (isClosed) closed.add(node.id);
    const childNames = childNamesOf(model, node);
    let listed: NodeWorkItemLines | undefined;
    let badge: WorkItemCounts | undefined;
    const block = workItems ? layout.content.get(node.id) : undefined;
    if (workItems) {
      const lines =
        lodLevel === 'detail' && block && !(isGroup && isClosed)
          ? workItemLines(workItems.overlay, node.id, workItems.mode)
          : [];
      if (block && lines.length > 0) {
        const absolute = layout.absolute.get(node.id);
        const list = workItemLinesRect(block, lines);
        const inCanvas = absolute && { ...list, x: absolute.x + list.x, y: absolute.y + list.y };
        if (inCanvas) texts.lines.push(...workItemTextRects(inCanvas, lines));
        const above = isGroup ? inCanvas : undefined;
        if (above) lists.set(node.id, above);
        listed = { lines, rect: block, ...(above ? { above } : {}) };
      } else {
        // What is hidden inside a closed box counts for it; open groups show their own.
        const found = isClosed
          ? subtreeWorkItemCounts(workItems.overlay, node.id)
          : ownWorkItemCounts(workItems.overlay, node.id);
        if (found.stories > 0) badge = found;
      }
    }
    // A shrunk box has a line for the badge below its list of names (`closedGroupBadge`).
    const box =
      compactCollapsed && isGroup && isClosed
        ? shrunkGroupBox(node, childNames, full, badge !== undefined)
        : undefined;
    const compact = box !== undefined;
    const rect = box?.rect ?? full;
    if (compact) {
      const absolute = layout.absolute.get(node.id);
      const around = absolute && shrunkGroupBox(node, childNames, absolute, badge !== undefined);
      if (around) shrunk.set(node.id, around.rect);
    }
    if (isClosed) {
      const drawn = shrunk.get(node.id) ?? layout.absolute.get(node.id);
      if (drawn) {
        texts.names.push(
          isGroup ? drawn : leafNameRect(drawn, node.name, node.level, block?.height ?? 0),
        );
      }
    }
    const placedRow = layout.placedRow.get(node.id);
    const structureCounts = counts.get(node.id) ?? {
      children: node.childIds.length,
      descendants: 0,
    };
    const data: ArchNodeData = {
      name: node.name,
      level: node.level,
      levelName: NODE_LEVEL_NAMES[node.level],
      childCount: node.childIds.length,
      counts: workItems
        ? { ...structureCounts, ...subtreeWorkItemCounts(workItems.overlay, node.id) }
        : structureCounts,
      collapsed: isGroup && isClosed,
      manuallyCollapsed: isGroup && collapsedIds.has(node.id),
      compact,
      childNames,
      compactHidden: box?.hidden ?? 0,
      ...(node.description !== undefined ? { description: node.description } : {}),
      ...(placedRow !== undefined ? { placedRowName: rowNames.get(placedRow) ?? placedRow } : {}),
      ...(listed ? { workItems: listed } : {}),
      ...(block ? { contentRect: block } : {}),
      ...(badge ? { badge } : {}),
    };
    nodes.push({
      id: node.id,
      type: isGroup ? 'group' : 'leaf',
      position: { x: rect.x, y: rect.y },
      width: rect.width,
      height: rect.height,
      style: { width: rect.width, height: rect.height },
      data,
      ...(node.parentId !== undefined
        ? { parentId: node.parentId, extent: 'parent' as const }
        : {}),
      draggable: view.draggable ?? false,
      connectable: false,
      deletable: false,
      zIndex: isClosed ? Z_INDEX.leaf : Z_INDEX.group + node.level,
    });
  }

  const edges = buildEdges(
    rollupEdges(model, visible),
    layout,
    closed,
    edgeLabelsShown(lodLevel),
    model,
    shrunk,
    lists,
    texts,
  );
  return { nodes, edges };
}
