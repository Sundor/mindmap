// Pure edge routing geometry: which sides of two nodes an edge attaches to, the
// curve it follows, and how parallel edges between the same pair of nodes are kept apart.
// No React or React Flow imports.

import type { Rect, Size } from './layout/types';

// --- Sides ----------------------------------------------------------------------------------

export const SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type Side = (typeof SIDES)[number];

export const OPPOSITE_SIDE: Readonly<Record<Side, Side>> = {
  top: 'bottom',
  right: 'left',
  bottom: 'top',
  left: 'right',
};

export interface FacingSides {
  readonly source: Side;
  readonly target: Side;
}

/**
 * Picks the sides of two rectangles (canvas coordinates) that face each other, for an edge from
 * `source` to `target` ("floating" handle selection):
 * - separated on one axis only → that axis;
 * - separated on both → the axis with the larger gap, or always the vertical one when
 *   `preferVertical` is set (nodes in different row bands);
 * - overlapping or nested → the axis with the larger distance between the centres.
 */
export function facingSides(source: Rect, target: Rect, preferVertical = false): FacingSides {
  const gapRight = target.x - (source.x + source.width);
  const gapLeft = source.x - (target.x + target.width);
  const gapDown = target.y - (source.y + source.height);
  const gapUp = source.y - (target.y + target.height);
  const gapX = Math.max(gapRight, gapLeft);
  const gapY = Math.max(gapDown, gapUp);

  const horizontal = (targetIsRight: boolean): FacingSides =>
    targetIsRight ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
  const vertical = (targetIsBelow: boolean): FacingSides =>
    targetIsBelow ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };

  if (gapX < 0 && gapY < 0) {
    const dx = target.x + target.width / 2 - (source.x + source.width / 2);
    const dy = target.y + target.height / 2 - (source.y + source.height / 2);
    return Math.abs(dx) >= Math.abs(dy) ? horizontal(dx >= 0) : vertical(dy >= 0);
  }
  if (gapY >= 0 && (preferVertical || gapX < gapY)) return vertical(gapDown >= gapUp);
  if (gapX >= 0) return horizontal(gapRight >= gapLeft);
  return vertical(gapDown >= gapUp);
}

// --- Points and curves ----------------------------------------------------------------------

export interface Point {
  readonly x: number;
  readonly y: number;
}

function isHorizontalSide(side: Side): boolean {
  return side === 'left' || side === 'right';
}

/** Moves a point lying on `side` of a node by `offset` pixels along that side. */
export function shiftAlongSide(point: Point, side: Side, offset: number): Point {
  return isHorizontalSide(side)
    ? { x: point.x, y: point.y + offset }
    : { x: point.x + offset, y: point.y };
}

/** Midpoint of a side of a rectangle (where the hidden handles sit), moved by `offset`. */
export function sidePoint(rect: Rect, side: Side, offset = 0): Point {
  const mid: Point =
    side === 'top'
      ? { x: rect.x + rect.width / 2, y: rect.y }
      : side === 'bottom'
        ? { x: rect.x + rect.width / 2, y: rect.y + rect.height }
        : side === 'left'
          ? { x: rect.x, y: rect.y + rect.height / 2 }
          : { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  return shiftAlongSide(mid, side, offset);
}

/** Cubic bezier: start, two control points, end. */
export interface Curve {
  readonly p0: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly p3: Point;
}

const CURVATURE = 0.25;
/** Bounds of the bulge of an edge whose two ends leave in the same direction (an arc). */
const ARC_MIN = 24;
const ARC_MAX = 120;

/** Distance from `from` to `to` measured along the direction `dir` points in. */
function along(dir: Side, from: Point, to: Point): number {
  switch (dir) {
    case 'top':
      return from.y - to.y;
    case 'bottom':
      return to.y - from.y;
    case 'left':
      return from.x - to.x;
    case 'right':
      return to.x - from.x;
  }
}

function controlPoint(end: Point, dir: Side, other: Point, sameDirection: boolean): Point {
  const distance = along(dir, end, other);
  // Same as React Flow's bezier edge: half the distance when the other end lies ahead, a small
  // loop when it lies behind.
  let offset = distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);
  if (sameDirection) {
    // Both ends leave the same way (e.g. top → top): bulge out so the curve arcs around whatever
    // lies between the two nodes instead of running straight through it.
    const across = isHorizontalSide(dir) ? Math.abs(other.y - end.y) : Math.abs(other.x - end.x);
    offset = Math.max(offset, Math.min(ARC_MAX, Math.max(ARC_MIN, 0.5 * across)));
  }
  switch (dir) {
    case 'top':
      return { x: end.x, y: end.y - offset };
    case 'bottom':
      return { x: end.x, y: end.y + offset };
    case 'left':
      return { x: end.x - offset, y: end.y };
    case 'right':
      return { x: end.x + offset, y: end.y };
  }
}

/**
 * The curve of an edge from `source` to `target`. `sourceDir` and `targetDir` are the directions
 * in which the curve leaves the source and approaches the target from (normally the sides the
 * ends sit on; the opposite one for the end on a container's border, see `routeEdge`).
 */
export function edgeCurve(source: Point, sourceDir: Side, target: Point, targetDir: Side): Curve {
  const same = sourceDir === targetDir;
  return {
    p0: source,
    c1: controlPoint(source, sourceDir, target, same),
    c2: controlPoint(target, targetDir, source, same),
    p3: target,
  };
}

/** Point on the curve at parameter `t` in [0, 1]. */
export function curvePoint(curve: Curve, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * curve.p0.x + b * curve.c1.x + c * curve.c2.x + d * curve.p3.x,
    y: a * curve.p0.y + b * curve.c1.y + c * curve.c2.y + d * curve.p3.y,
  };
}

/** Distance from `point` to the segment from `a` to `b`. */
function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Length of a polyline segment when a curve is flattened to measure distances, in pixels. */
const FLATTEN_STEP = 6;

/**
 * Distance from `point` to `curve`, measured to a polyline through points of the curve about
 * `FLATTEN_STEP` pixels apart (well under a pixel off for the curves of `edgeCurve`).
 */
export function distanceToCurve(point: Point, curve: Curve): number {
  const { p0, c1, c2, p3 } = curve;
  // The control polygon is at least as long as the curve.
  const length =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(p3.x - c2.x, p3.y - c2.y);
  const segments = Math.min(512, Math.max(8, Math.ceil(length / FLATTEN_STEP)));
  let nearest = Infinity;
  let previous = curve.p0;
  for (let i = 1; i <= segments; i++) {
    const next = curvePoint(curve, i / segments);
    nearest = Math.min(nearest, distanceToSegment(point, previous, next));
    previous = next;
  }
  return nearest;
}

/** SVG path data of the curve. */
export function curvePath(curve: Curve): string {
  const { p0, c1, c2, p3 } = curve;
  return `M${p0.x},${p0.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p3.x},${p3.y}`;
}

/** Whether `point` lies strictly inside `rect` grown by `margin` (shrunk when negative). */
function inside(point: Point, rect: Rect, margin: number): boolean {
  return (
    point.x > rect.x - margin &&
    point.x < rect.x + rect.width + margin &&
    point.y > rect.y - margin &&
    point.y < rect.y + rect.height + margin
  );
}

/** Whether `outer` contains `inner` entirely (and they are not the same rectangle). */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height &&
    (outer.width > inner.width || outer.height > inner.height)
  );
}

// --- Routing --------------------------------------------------------------------------------

/** Where an edge attaches and which way it leaves / arrives. */
export interface EdgeRoute {
  /** Side of the source node the edge starts on (its hidden source handle). */
  readonly sourceSide: Side;
  /** Side of the target node the edge ends on (its hidden target handle). */
  readonly targetSide: Side;
  /** Direction in which the curve leaves the source. */
  readonly sourceDir: Side;
  /** Direction from which the curve reaches the target (pointing away from the target). */
  readonly targetDir: Side;
}

/** Clearance kept between an edge and a box it passes, in pixels. */
const OBSTACLE_MARGIN = 4;
/** Distance between samples when measuring a curve against the obstacles, in pixels. */
const SAMPLE_STEP = 6;
const MAX_SAMPLES = 400;

interface Score {
  /** Number of samples of the curve that lie behind a box. */
  readonly hidden: number;
  readonly length: number;
}

function routeCurve(source: Rect, target: Rect, route: EdgeRoute): Curve {
  return edgeCurve(
    sidePoint(source, route.sourceSide),
    route.sourceDir,
    sidePoint(target, route.targetSide),
    route.targetDir,
  );
}

/**
 * Scores the curve of `route` against `obstacles` (already stripped of the boxes that contain an
 * end, see `routeEdge`). Gives up and returns undefined as soon as more than `maxHidden` samples
 * are hidden: such a candidate cannot win any more.
 */
function scoreRoute(
  source: Rect,
  target: Rect,
  route: EdgeRoute,
  obstacles: readonly Rect[],
  maxHidden = Infinity,
): Score | undefined {
  const curve = routeCurve(source, target, route);
  const { p0, c1, c2, p3 } = curve;
  const hull =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(p3.x - c2.x, p3.y - c2.y);
  const samples = Math.min(MAX_SAMPLES, Math.max(16, Math.ceil(hull / SAMPLE_STEP)));

  // A bezier curve stays within the bounding box of its control points, so only the boxes
  // reaching into that box (grown by the clearance) can hide any of it.
  const minX = Math.min(p0.x, c1.x, c2.x, p3.x) - OBSTACLE_MARGIN;
  const maxX = Math.max(p0.x, c1.x, c2.x, p3.x) + OBSTACLE_MARGIN;
  const minY = Math.min(p0.y, c1.y, c2.y, p3.y) - OBSTACLE_MARGIN;
  const maxY = Math.max(p0.y, c1.y, c2.y, p3.y) + OBSTACLE_MARGIN;
  const near = obstacles.filter(
    (rect) =>
      rect.x <= maxX &&
      rect.x + rect.width >= minX &&
      rect.y <= maxY &&
      rect.y + rect.height >= minY,
  );

  let hidden = 0;
  let length = 0;
  let previous = p0;
  for (let i = 1; i <= samples; i++) {
    const point = curvePoint(curve, i / samples);
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
    if (i === samples) break;
    for (const rect of near) {
      // The ends of the edge sit on the border of their own nodes; any other box is kept at a
      // small distance.
      const own = rect === source || rect === target;
      if (inside(point, rect, own ? -1 : OBSTACLE_MARGIN)) {
        hidden++;
        break;
      }
    }
    if (hidden > maxHidden) return undefined;
  }
  return { hidden, length };
}

/**
 * Routes an edge between two rectangles (canvas coordinates).
 *
 * - Normally the two sides facing each other (`facingSides`).
 * - When that curve would run behind one of the `obstacles` (the boxes drawn above edges: leaf
 *   nodes), every combination of sides is tried and the one hiding the least of the edge wins,
 *   the shortest among equals; e.g. top → top arcs over a node standing between two neighbours.
 *   The result is always a single curve, so in a dense graph the best candidate may still pass
 *   behind a box (`hiddenSamples` measures how much).
 * - Between a node and one of its own ancestors or descendants the edge stays inside the
 *   container: both ends use the same side (the shortest unobstructed one), and the end on the
 *   container's border points inwards.
 *
 * Pass the endpoint rectangles themselves in `obstacles` (same object identity) when they are
 * leaves, so that a route doubling back through its own node is avoided too.
 */
export function routeEdge(
  source: Rect,
  target: Rect,
  obstacles: readonly Rect[] = [],
  preferVertical = false,
): EdgeRoute {
  const sourceContains = containsRect(source, target);
  const targetContains = !sourceContains && containsRect(target, source);
  // A box that contains an end (its ancestor) is not passed "behind".
  const blocking = obstacles.filter(
    (rect) =>
      rect === source ||
      rect === target ||
      !(containsRect(rect, source) || containsRect(rect, target)),
  );

  let candidates: EdgeRoute[];
  if (sourceContains || targetContains) {
    candidates = SIDES.map((side) => ({
      sourceSide: side,
      targetSide: side,
      sourceDir: sourceContains ? OPPOSITE_SIDE[side] : side,
      targetDir: targetContains ? OPPOSITE_SIDE[side] : side,
    }));
  } else {
    const facing = facingSides(source, target, preferVertical);
    const first: EdgeRoute = {
      sourceSide: facing.source,
      targetSide: facing.target,
      sourceDir: facing.source,
      targetDir: facing.target,
    };
    if (scoreRoute(source, target, first, blocking, 0)) return first;
    candidates = [first];
    for (const sourceSide of SIDES) {
      for (const targetSide of SIDES) {
        if (sourceSide === first.sourceSide && targetSide === first.targetSide) continue;
        candidates.push({ sourceSide, targetSide, sourceDir: sourceSide, targetDir: targetSide });
      }
    }
  }

  let best: EdgeRoute | undefined;
  let bestScore: Score | undefined;
  for (const candidate of candidates) {
    const score = scoreRoute(source, target, candidate, blocking, bestScore?.hidden);
    if (!score) continue; // hides more than the best so far
    if (
      !bestScore ||
      score.hidden < bestScore.hidden ||
      (score.hidden === bestScore.hidden && score.length < bestScore.length - 1e-6)
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best) throw new Error('No route candidates');
  return best;
}

/**
 * The area every candidate curve of `routeEdge` between `source` and `target` stays within,
 * clearance included: a box outside it cannot change the route, so it need not be passed as an
 * obstacle. (A bezier stays within the hull of its control points; a control point lies between
 * the two ends, or beyond one of them by at most the arc bulge or the loop of an end that points
 * away from the other, see `controlPoint`.)
 */
export function routeReach(source: Rect, target: Rect): Rect {
  const left = Math.min(source.x, target.x);
  const top = Math.min(source.y, target.y);
  const right = Math.max(source.x + source.width, target.x + target.width);
  const bottom = Math.max(source.y + source.height, target.y + target.height);
  const extent = Math.max(right - left, bottom - top);
  const grow = Math.max(ARC_MAX, CURVATURE * 25 * Math.sqrt(extent)) + OBSTACLE_MARGIN + 1;
  return {
    x: left - grow,
    y: top - grow,
    width: right - left + 2 * grow,
    height: bottom - top + 2 * grow,
  };
}

/** Whether two rectangles share at least a point (touching counts). */
export function rectsTouch(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

/** Number of samples (out of `samples`, ends excluded) of `curve` strictly inside one of `boxes`. */
export function hiddenSamples(curve: Curve, boxes: readonly Rect[], samples = 400): number {
  let hidden = 0;
  for (let i = 1; i < samples; i++) {
    const point = curvePoint(curve, i / samples);
    if (boxes.some((box) => inside(point, box, 0))) hidden++;
  }
  return hidden;
}

// --- Lanes ----------------------------------------------------------------------------------

/** Distance between parallel edges joining the same two nodes, in pixels. */
export const LANE_GAP = 14;
/** Lanes stay this far from the corners of the node side they attach to. */
const LANE_CORNER_CLEARANCE = 6;

/**
 * Offset of lane `index` of `count` along a node side of length `sideLength`: lanes are centred
 * on the middle of the side, `LANE_GAP` apart, squeezed when the side is too short for that.
 */
export function laneOffset(index: number, count: number, sideLength: number): number {
  if (count <= 1) return 0;
  const room = Math.max(0, sideLength - 2 * LANE_CORNER_CLEARANCE);
  const gap = Math.min(LANE_GAP, room / (count - 1));
  return (index - (count - 1) / 2) * gap;
}

/** Curve parameter at which lane `index` of `count` carries its label (staggered along it). */
export function laneLabelT(index: number, count: number): number {
  return (index + 1) / (count + 1);
}

// --- Labels ---------------------------------------------------------------------------------

/**
 * Where the label of an edge is centred for curve parameter `t`: the point of the curve, and
 * beyond its ends (`t` below 0 or above 1) straight on along the line through the two ends, as
 * far as that fraction of their distance. A label wider than a very short edge is long may sit
 * there (`placeLabel`), over the border of one of the two boxes.
 */
export function labelPoint(curve: Curve, t: number): Point {
  if (t >= 0 && t <= 1) return curvePoint(curve, t);
  const { p0, p3 } = curve;
  const end = t < 0 ? p0 : p3;
  const beyond = t < 0 ? t : t - 1;
  return { x: end.x + beyond * (p3.x - p0.x), y: end.y + beyond * (p3.y - p0.y) };
}

/** The box of a label of `size` centred at {@link labelPoint} `t` of `curve`. */
export function labelRect(curve: Curve, t: number, size: Size): Rect {
  const point = labelPoint(curve, t);
  return {
    x: point.x - size.width / 2,
    y: point.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

/** Area two rectangles share; 0 when they only touch. */
export function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Labels keep to this part of the curve, away from the arrowhead and the node borders. */
const LABEL_T_RANGE = { min: 0.1, max: 0.9 } as const;
/** Distance between the places tried along the curve: as a curve parameter, and in pixels. */
const LABEL_T_STEP = 0.04;
const LABEL_MIN_STEP = 4;

/** Where a label goes on its curve, and how much of the obstacles it covers there. */
export interface LabelPlace {
  /** Curve parameter (0–1), or beyond the ends of a short edge: see {@link labelPoint}. */
  readonly t: number;
  /** Area of the obstacles under the label, in square pixels; 0 when it covers none. */
  readonly covered: number;
}

/**
 * Where a label of `size` sits on `curve`: at `preferred` when the label covers none of the
 * `obstacles` there (the boxes of what it would hide: names, work-item lines, labels already
 * placed); otherwise at the nearest place along the curve where it covers none, and when there
 * is no such place at the one where it covers the least.
 *
 * An edge shorter than its label is wide (two boxes side by side) has no place for it at all: the
 * label may then be centred up to half its width beyond either end, so that it lies on whichever
 * of the two boxes has nothing written there.
 */
export function placeLabel(
  curve: Curve,
  size: Size,
  preferred: number,
  obstacles: readonly Rect[],
): LabelPlace {
  const covered = (t: number): number => {
    const rect = labelRect(curve, t, size);
    let area = 0;
    for (const obstacle of obstacles) area += overlapArea(rect, obstacle);
    return area;
  };
  const length = Math.hypot(curve.p3.x - curve.p0.x, curve.p3.y - curve.p0.y);
  const reach = Math.max(size.width, size.height);
  const beyond = length > 0 && length < reach ? reach / 2 / length : 0;
  const min = beyond > 0 ? -beyond : LABEL_T_RANGE.min;
  const max = beyond > 0 ? 1 + beyond : LABEL_T_RANGE.max;
  const stride = length > 0 ? Math.max(LABEL_T_STEP, LABEL_MIN_STEP / length) : LABEL_T_STEP;
  let best = preferred;
  let bestCovered = covered(preferred);
  for (let step = 1; bestCovered > 0; step++) {
    const below = preferred - step * stride;
    const above = preferred + step * stride;
    const candidates = [above, below].filter((t) => t >= min - 1e-9 && t <= max + 1e-9);
    if (candidates.length === 0) break;
    for (const t of candidates) {
      const area = covered(t);
      if (area < bestCovered) {
        best = t;
        bestCovered = area;
      }
    }
  }
  return { t: best, covered: bestCovered };
}
