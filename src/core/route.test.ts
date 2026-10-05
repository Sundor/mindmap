import { describe, expect, it } from 'vitest';
import type { Rect } from './layout/types';
import {
  containsRect,
  curvePath,
  curvePoint,
  distanceToCurve,
  edgeCurve,
  facingSides,
  hiddenSamples,
  labelPoint,
  labelRect,
  overlapArea,
  placeLabel,
  rectsTouch,
  routeReach,
  LANE_GAP,
  laneLabelT,
  laneOffset,
  routeEdge,
  shiftAlongSide,
  sidePoint,
  type EdgeRoute,
} from './route';

const rect = (x: number, y: number, width = 100, height = 50): Rect => ({ x, y, width, height });

function curveFor(source: Rect, target: Rect, route: EdgeRoute) {
  return edgeCurve(
    sidePoint(source, route.sourceSide),
    route.sourceDir,
    sidePoint(target, route.targetSide),
    route.targetDir,
  );
}

describe('sidePoint / shiftAlongSide', () => {
  it('gives the middle of each side, shifted along the side', () => {
    const r = rect(10, 20, 100, 50);
    expect(sidePoint(r, 'top')).toEqual({ x: 60, y: 20 });
    expect(sidePoint(r, 'bottom')).toEqual({ x: 60, y: 70 });
    expect(sidePoint(r, 'left')).toEqual({ x: 10, y: 45 });
    expect(sidePoint(r, 'right')).toEqual({ x: 110, y: 45 });
    expect(sidePoint(r, 'top', 7)).toEqual({ x: 67, y: 20 });
    expect(sidePoint(r, 'right', -7)).toEqual({ x: 110, y: 38 });
    expect(shiftAlongSide({ x: 1, y: 2 }, 'bottom', 3)).toEqual({ x: 4, y: 2 });
    expect(shiftAlongSide({ x: 1, y: 2 }, 'left', 3)).toEqual({ x: 1, y: 5 });
  });
});

describe('edgeCurve', () => {
  it('matches the React Flow bezier for ends facing each other', () => {
    const curve = edgeCurve({ x: 1526, y: 503.5 }, 'top', { x: 1124, y: 160.5 }, 'bottom');
    expect(curvePath(curve)).toBe('M1526,503.5 C1526,332 1124,332 1124,160.5');
    expect(curvePoint(curve, 0)).toEqual({ x: 1526, y: 503.5 });
    expect(curvePoint(curve, 1)).toEqual({ x: 1124, y: 160.5 });
    expect(curvePoint(curve, 0.5)).toEqual({ x: 1325, y: 332 });
  });

  it('bulges out when both ends leave the same way', () => {
    const curve = edgeCurve({ x: 0, y: 100 }, 'top', { x: 200, y: 100 }, 'top');
    expect(curve.c1).toEqual({ x: 0, y: 0 });
    expect(curve.c2).toEqual({ x: 200, y: 0 });
    expect(curvePoint(curve, 0.5)).toEqual({ x: 100, y: 25 });
    // The bulge is bounded for distant nodes and never flat for close ones.
    expect(edgeCurve({ x: 0, y: 0 }, 'right', { x: 0, y: 2000 }, 'right').c1.x).toBe(120);
    expect(edgeCurve({ x: 0, y: 0 }, 'right', { x: 0, y: 10 }, 'right').c1.x).toBe(24);
  });
});

describe('distanceToCurve', () => {
  const straight = edgeCurve({ x: 0, y: 0 }, 'right', { x: 300, y: 0 }, 'left');
  const bent = edgeCurve({ x: 0, y: 0 }, 'right', { x: 300, y: 200 }, 'left');

  it('is zero on the curve and the perpendicular distance beside it', () => {
    for (const t of [0, 0.13, 0.5, 0.77, 1]) {
      expect(distanceToCurve(curvePoint(bent, t), bent)).toBeLessThan(0.2);
    }
    expect(distanceToCurve({ x: 150, y: 14 }, straight)).toBeCloseTo(14);
    expect(distanceToCurve({ x: 150, y: -7 }, straight)).toBeCloseTo(7);
  });

  it('is the distance to the nearer end beyond the ends', () => {
    expect(distanceToCurve({ x: -30, y: 40 }, straight)).toBeCloseTo(50);
    expect(distanceToCurve({ x: 340, y: 30 }, straight)).toBeCloseTo(50);
  });

  it('tells two lanes 14 px apart from each other', () => {
    const other = edgeCurve({ x: 0, y: 14 }, 'right', { x: 300, y: 214 }, 'left');
    for (let i = 1; i < 20; i++) {
      const on = curvePoint(bent, i / 20);
      expect(distanceToCurve(on, bent)).toBeLessThan(distanceToCurve(on, other));
    }
  });
});

describe('routeEdge', () => {
  it('uses the facing sides when nothing is in the way', () => {
    const a = rect(0, 0);
    const b = rect(300, 0);
    const far = rect(0, 400);
    expect(routeEdge(a, b, [a, b, far])).toEqual({
      sourceSide: 'right',
      targetSide: 'left',
      sourceDir: 'right',
      targetDir: 'left',
    });
    expect(routeEdge(a, b)).toEqual(routeEdge(a, b, [a, b, far]));
    // Different row bands: vertical, as with facingSides.
    const below = rect(500, 300);
    expect(routeEdge(a, below, [a, below], true)).toMatchObject({
      sourceSide: 'bottom',
      targetSide: 'top',
    });
  });

  it('goes around a node standing between two nodes in a line', () => {
    const a = rect(0, 0);
    const between = rect(150, 0);
    const b = rect(300, 0);
    const obstacles = [a, between, b];
    const route = routeEdge(a, b, obstacles);
    expect(route.sourceSide).not.toBe('right');
    expect(route.sourceSide).toBe(route.targetSide);
    expect(['top', 'bottom']).toContain(route.sourceSide);
    expect(hiddenSamples(curveFor(a, b, route), [between])).toBe(0);
    // The direct curve would be mostly hidden.
    const direct = edgeCurve(sidePoint(a, 'right'), 'right', sidePoint(b, 'left'), 'left');
    expect(hiddenSamples(direct, [between])).toBeGreaterThan(150);
    // The opposite direction takes the same way round.
    const back = routeEdge(b, a, obstacles);
    expect(back.sourceSide).toBe(back.targetSide);
    expect(hiddenSamples(curveFor(b, a, back), [between])).toBe(0);
  });

  it('goes around a node standing between two nodes above each other', () => {
    const a = rect(0, 0);
    const between = rect(0, 150);
    const b = rect(0, 300);
    const route = routeEdge(a, b, [a, between, b], true);
    expect(route.sourceSide).toBe(route.targetSide);
    expect(['left', 'right']).toContain(route.sourceSide);
    expect(hiddenSamples(curveFor(a, b, route), [between])).toBe(0);
  });

  it('ignores boxes that contain an end (groups are crossed, not avoided)', () => {
    const a = rect(20, 40);
    const group = rect(0, 0, 140, 110);
    const b = rect(300, 40);
    expect(routeEdge(a, b, [group])).toMatchObject({ sourceSide: 'right', targetSide: 'left' });
  });

  it('picks the least hidden route when every one is obstructed', () => {
    const a = rect(200, 200);
    const b = rect(500, 200);
    // `a` is walled in on every side; the wall on the right is the thinnest.
    const walls = [rect(170, 100, 160, 60), rect(170, 290, 160, 60), rect(60, 100, 100, 250)];
    const right = rect(340, 150, 20, 150);
    const route = routeEdge(a, b, [a, b, ...walls, right]);
    expect(route.sourceSide).toBe('right');
  });

  it('parent → child: from the nearest container border, pointing inwards', () => {
    const outer = rect(0, 0, 400, 300);
    expect(routeEdge(outer, rect(170, 30, 60, 40))).toEqual({
      sourceSide: 'top',
      targetSide: 'top',
      sourceDir: 'bottom',
      targetDir: 'top',
    });
    expect(routeEdge(outer, rect(170, 240, 60, 40))).toMatchObject({
      sourceSide: 'bottom',
      targetSide: 'bottom',
      sourceDir: 'top',
      targetDir: 'bottom',
    });
    expect(routeEdge(outer, rect(20, 130, 60, 40))).toMatchObject({
      sourceSide: 'left',
      targetSide: 'left',
      sourceDir: 'right',
      targetDir: 'left',
    });
    expect(routeEdge(outer, rect(320, 130, 60, 40))).toMatchObject({
      sourceSide: 'right',
      targetSide: 'right',
      sourceDir: 'left',
    });
  });

  it('child → ancestor: to the nearest container border, arriving from inside', () => {
    const outer = rect(0, 0, 400, 300);
    const inner = rect(320, 130, 60, 40);
    const route = routeEdge(inner, outer);
    expect(route).toEqual({
      sourceSide: 'right',
      targetSide: 'right',
      sourceDir: 'right',
      targetDir: 'left',
    });
    const curve = curveFor(inner, outer, route);
    // A short, straight connection: no loop outside the container.
    expect(curvePath(curve)).toBe('M380,150 C390,150 390,150 400,150');
  });

  it('containment edges avoid a sibling standing before the nearest border', () => {
    const outer = rect(0, 0, 400, 300);
    const inner = rect(170, 100, 60, 40);
    const sibling = rect(120, 30, 160, 40); // between `inner` and the top border
    const route = routeEdge(outer, inner, [inner, sibling]);
    expect(route.sourceSide).not.toBe('top');
    expect(hiddenSamples(curveFor(outer, inner, route), [sibling])).toBe(0);
  });
});

describe('routeEdge on a dense graph', () => {
  // 300 leaves in a staggered grid, 800 edges between pseudo-random pairs (fixed seed).
  const grid: Rect[] = [];
  for (let row = 0; row < 15; row++) {
    for (let col = 0; col < 20; col++) {
      grid.push(rect(col * 190 + (row % 3) * 17, row * 110, 150, 60));
    }
  }
  let seed = 12345;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const at = (index: number): Rect => {
    const r = grid[index % grid.length];
    if (!r) throw new Error('empty grid');
    return r;
  };
  const pairs: [Rect, Rect][] = [];
  for (let i = 0; i < 800; i++) {
    const a = next(grid.length);
    const b = next(grid.length);
    pairs.push([at(a), at(a === b ? b + 1 : b)]);
  }

  it('stays fast: only the boxes near a candidate curve are tested, hopeless candidates dropped', () => {
    const started = performance.now();
    const routes = pairs.map(([a, b], i) => routeEdge(a, b, grid, i % 2 === 0));
    const elapsed = performance.now() - started;
    expect(routes).toHaveLength(pairs.length);
    // About 1 s here; it took 6.5 s when every sample was tested against every box for all 16
    // side combinations. The bound is generous to survive a loaded computer.
    expect(elapsed).toBeLessThan(4500);
  });

  it('never picks a route hiding more of the edge than the facing sides would', () => {
    for (const [a, b] of pairs.slice(0, 200)) {
      const others = grid.filter((r) => r !== a && r !== b);
      const route = routeEdge(a, b, grid);
      const facing = facingSides(a, b);
      const direct = edgeCurve(
        sidePoint(a, facing.source),
        facing.source,
        sidePoint(b, facing.target),
        facing.target,
      );
      // Routing keeps a 4px clearance, so compare against boxes grown by it.
      const grown = others.map((r) => rect(r.x - 4, r.y - 4, r.width + 8, r.height + 8));
      expect(hiddenSamples(curveFor(a, b, route), grown)).toBeLessThanOrEqual(
        hiddenSamples(direct, grown) + 4,
      );
    }
  });
});

describe('containsRect', () => {
  it('is true for a rectangle strictly larger that covers the other', () => {
    expect(containsRect(rect(0, 0, 100, 100), rect(10, 10, 20, 20))).toBe(true);
    expect(containsRect(rect(0, 0, 100, 100), rect(0, 0, 100, 50))).toBe(true);
    expect(containsRect(rect(0, 0, 100, 100), rect(0, 0, 100, 100))).toBe(false);
    expect(containsRect(rect(10, 10, 20, 20), rect(0, 0, 100, 100))).toBe(false);
    expect(containsRect(rect(0, 0, 100, 100), rect(90, 90, 20, 20))).toBe(false);
  });
});

describe('lanes', () => {
  it('centres the lanes on the middle of the side', () => {
    expect(laneOffset(0, 1, 100)).toBe(0);
    expect([0, 1].map((i) => laneOffset(i, 2, 100))).toEqual([-LANE_GAP / 2, LANE_GAP / 2]);
    expect([0, 1, 2].map((i) => laneOffset(i, 3, 100))).toEqual([-LANE_GAP, 0, LANE_GAP]);
  });

  it('squeezes the lanes onto a short side', () => {
    const offsets = [0, 1, 2, 3].map((i) => laneOffset(i, 4, 36));
    expect(offsets).toEqual([-12, -4, 4, 12]);
    expect(laneOffset(1, 2, 4)).toBe(0);
  });

  it('staggers the labels along the curve', () => {
    expect(laneLabelT(0, 1)).toBe(0.5);
    expect([0, 1].map((i) => laneLabelT(i, 2))).toEqual([1 / 3, 2 / 3]);
  });
});

describe('routeReach', () => {
  // Deterministic pseudo-random numbers (an LCG), so a failure can be reproduced.
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  it('contains both ends', () => {
    const source = { x: 0, y: 0, width: 100, height: 40 };
    const target = { x: 500, y: 300, width: 100, height: 40 };
    const reach = routeReach(source, target);
    expect(containsRect(reach, source)).toBe(true);
    expect(containsRect(reach, target)).toBe(true);
  });

  it('boxes outside it never change the route', () => {
    const next = random(42);
    const box = (): Rect => ({
      x: Math.round(next() * 1600),
      y: Math.round(next() * 1000),
      width: 60 + Math.round(next() * 160),
      height: 30 + Math.round(next() * 60),
    });
    let pruned = 0;
    for (let round = 0; round < 300; round++) {
      const source = box();
      const target = box();
      const others = Array.from({ length: 40 }, box);
      // Half the time the ends are obstacles themselves (leaves), as in `buildFlow`.
      const all = round % 2 === 0 ? [source, target, ...others] : others;
      const reach = routeReach(source, target);
      const near = all.filter((rect) => rectsTouch(rect, reach));
      pruned += all.length - near.length;
      const preferVertical = round % 3 === 0;
      expect(routeEdge(source, target, near, preferVertical), `round ${round}`).toEqual(
        routeEdge(source, target, all, preferVertical),
      );
    }
    // The comparison means something: plenty of boxes were left out.
    expect(pruned).toBeGreaterThan(1000);
  });
});

describe('placeLabel', () => {
  // A straight horizontal line from (0, 0) to (1000, 0).
  const line = edgeCurve({ x: 0, y: 0 }, 'right', { x: 1000, y: 0 }, 'left');
  const size = { width: 80, height: 20 };
  const middle = labelRect(line, 0.5, size);

  it('measures the area two boxes share', () => {
    expect(overlapArea(rect(0, 0), rect(50, 25))).toBe(50 * 25);
    expect(overlapArea(rect(0, 0), rect(100, 0))).toBe(0);
    expect(overlapArea(rect(0, 0), rect(300, 300))).toBe(0);
  });

  it('keeps the preferred place when the label covers nothing there', () => {
    expect(middle).toEqual({ x: 460, y: -10, width: 80, height: 20 });
    expect(placeLabel(line, size, 0.5, [])).toEqual({ t: 0.5, covered: 0 });
    expect(placeLabel(line, size, 0.5, [rect(0, -25), rect(900, -25)]).t).toBe(0.5);
    expect(placeLabel(line, size, 1 / 3, [rect(460, -25)]).t).toBe(1 / 3);
  });

  it('moves along the curve to the nearest place that covers no box', () => {
    const box = rect(430, -25, 140, 50);
    const { t, covered } = placeLabel(line, size, 0.5, [box]);
    expect(covered).toBe(0);
    expect(t).not.toBe(0.5);
    expect(Math.abs(t - 0.5)).toBeLessThan(0.2);
    expect(overlapArea(labelRect(line, t, size), box)).toBe(0);
    // Deterministic, and no further than needed.
    expect(placeLabel(line, size, 0.5, [box]).t).toBe(t);
    const nearer = t > 0.5 ? t - 0.04 : t + 0.04;
    expect(overlapArea(labelRect(line, nearer, size), box)).toBeGreaterThan(0);
  });

  it('may centre the label beyond the ends of an edge shorter than the label', () => {
    // Two boxes side by side, 20 apart; the left one is written on up to its right border, the
    // right one only from 40 pixels in.
    const short = edgeCurve({ x: 100, y: 0 }, 'right', { x: 120, y: 0 }, 'left');
    const written = [rect(0, -25, 100, 50), rect(160, -25, 100, 50)];
    const { t, covered } = placeLabel(short, { width: 60, height: 20 }, 0.5, written);
    expect(covered).toBe(0);
    expect(t).toBeGreaterThan(1);
    const box = labelRect(short, t, { width: 60, height: 20 });
    expect(box.x).toBeGreaterThanOrEqual(100);
    expect(box.x + box.width).toBeLessThanOrEqual(160);
    // Never further than half the label beyond an end.
    expect(labelPoint(short, t).x).toBeLessThanOrEqual(120 + 30);
    // On the curve between the ends, straight on beyond them.
    expect(labelPoint(short, 0.5)).toEqual(curvePoint(short, 0.5));
    expect(labelPoint(short, 2)).toEqual({ x: 140, y: 0 });
    expect(labelPoint(short, -0.5)).toEqual({ x: 90, y: 0 });
    // An edge long enough for its label keeps it between its ends.
    expect(placeLabel(line, size, 0.5, [rect(-200, -25, 1500, 50)]).t).toBeGreaterThanOrEqual(0.1);
  });

  it('takes the place that covers the least when every place covers something', () => {
    // Boxes all along the line, one of them only just reaching it.
    const wall = [rect(-100, -25, 500, 50), rect(400, -108, 200, 100), rect(600, -25, 600, 50)];
    const { t, covered } = placeLabel(line, size, 0.3, wall);
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThan(80 * 3);
    const point = curvePoint(line, t);
    expect(point.x).toBeGreaterThan(440);
    expect(point.x).toBeLessThan(560);
    expect(t).toBeGreaterThanOrEqual(0.1);
    expect(t).toBeLessThanOrEqual(0.9);
  });
});
