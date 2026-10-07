import { describe, expect, it } from 'vitest';
import {
  fromMiniMap,
  MINIMAP,
  MINIMAP_CORNER,
  miniMapCovers,
  miniMapNodes,
  miniMapRoom,
  miniMapTransform,
  rectToMiniMap,
  toMiniMap,
  viewportCentredOn,
  viewportRect,
  zoomAboutCentre,
  type MiniMapRoom,
  type MiniMapSourceNode,
} from './minimap';
import { ZOOM_RANGE, type Viewport } from './navigate';

describe('miniMapTransform', () => {
  it('fits a wide map to the width, centred, with the margin free', () => {
    const t = miniMapTransform({ width: 2000, height: 500 }, { width: 200, height: 150 }, 10);
    expect(t.scale).toBeCloseTo(0.09);
    expect(toMiniMap(t, { x: 0, y: 0 })).toEqual({ x: 10, y: (150 - 45) / 2 });
    const corner = toMiniMap(t, { x: 2000, y: 500 });
    expect(corner.x).toBeCloseTo(190);
    expect(corner.y).toBeCloseTo((150 + 45) / 2);
  });

  it('fits a tall map to the height', () => {
    const t = miniMapTransform({ width: 300, height: 1300 }, { width: 200, height: 150 }, 10);
    expect(t.scale).toBeCloseTo(0.1);
    expect(toMiniMap(t, { x: 0, y: 0 })).toEqual({ x: 85, y: 10 });
  });

  it('depends on the map alone, and survives a map without area', () => {
    expect(miniMapTransform({ width: 1000, height: 750 })).toEqual(
      miniMapTransform({ width: 1000, height: 750 }, MINIMAP, MINIMAP.margin),
    );
    const empty = miniMapTransform({ width: 0, height: 0 });
    expect(empty.scale).toBe(1);
    expect(Number.isFinite(empty.offsetX) && Number.isFinite(empty.offsetY)).toBe(true);
  });

  it('maps points there and back, and rectangles by their corner and size', () => {
    const t = miniMapTransform({ width: 1234, height: 987 });
    const point = { x: 321, y: -45 };
    const back = fromMiniMap(t, toMiniMap(t, point));
    expect(back.x).toBeCloseTo(point.x);
    expect(back.y).toBeCloseTo(point.y);
    const rect = rectToMiniMap(t, { x: 100, y: 200, width: 300, height: 400 });
    expect(rect).toEqual({
      ...toMiniMap(t, { x: 100, y: 200 }),
      width: 300 * t.scale,
      height: 400 * t.scale,
    });
  });
});

describe('viewportRect', () => {
  const screen = { width: 1000, height: 600 };

  it('is the part of the canvas on screen', () => {
    expect(viewportRect({ x: 0, y: 0, zoom: 1 }, screen)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
    });
    expect(viewportRect({ x: -200, y: 100, zoom: 0.5 }, screen)).toEqual({
      x: 400,
      y: -200,
      width: 2000,
      height: 1200,
    });
  });

  it('leaves the minimap when the view is panned off the map, at an unchanged scale', () => {
    const bounds = { width: 2000, height: 1200 };
    const t = miniMapTransform(bounds);
    // The map pushed 500 screen pixels to the right: half of the view is left of the map.
    const view = rectToMiniMap(t, viewportRect({ x: 500, y: 0, zoom: 1 }, screen));
    expect(view.x).toBeLessThan(0);
    expect(view.x + view.width).toBeGreaterThan(0);
    expect(view.width).toBeCloseTo(screen.width * t.scale);
    expect(miniMapTransform(bounds)).toEqual(t);
  });
});

describe('viewportCentredOn', () => {
  it('puts the canvas point in the middle of the screen', () => {
    const screen = { width: 1000, height: 600 };
    const viewport = viewportCentredOn({ x: 700, y: -50 }, 2, screen);
    expect(viewport.zoom).toBe(2);
    const view = viewportRect(viewport, screen);
    expect(view.x + view.width / 2).toBeCloseTo(700);
    expect(view.y + view.height / 2).toBeCloseTo(-50);
  });
});

describe('zoomAboutCentre', () => {
  const screen = { width: 800, height: 600 };
  const viewport = { x: -120, y: 40, zoom: 1 };
  const centreOf = (v: { x: number; y: number; zoom: number }) => {
    const view = viewportRect(v, screen);
    return { x: view.x + view.width / 2, y: view.y + view.height / 2 };
  };

  it('zooms in for a wheel movement up and out for one down, about the middle', () => {
    const closer = zoomAboutCentre(viewport, screen, -300);
    const further = zoomAboutCentre(viewport, screen, 300);
    expect(closer.zoom).toBeCloseTo(2);
    expect(further.zoom).toBeCloseTo(0.5);
    for (const next of [closer, further]) {
      expect(centreOf(next).x).toBeCloseTo(centreOf(viewport).x);
      expect(centreOf(next).y).toBeCloseTo(centreOf(viewport).y);
    }
    expect(zoomAboutCentre(viewport, screen, 0)).toEqual(viewport);
  });

  it('stays within the zoom range', () => {
    expect(zoomAboutCentre(viewport, screen, -100000).zoom).toBe(ZOOM_RANGE.max);
    expect(zoomAboutCentre(viewport, screen, 100000).zoom).toBe(ZOOM_RANGE.min);
    expect(zoomAboutCentre(viewport, screen, -100000, { min: 0.5, max: 1.5 }).zoom).toBe(1.5);
  });
});

describe('miniMapNodes', () => {
  it('adds up the positions along the parents', () => {
    const nodes = [
      { id: 'band', type: 'band', position: { x: 0, y: 0 }, width: 900, height: 300 },
      { id: 'a', type: 'group', position: { x: 100, y: 50 }, width: 400, height: 200 },
      {
        id: 'a.b',
        type: 'group',
        position: { x: 20, y: 40 },
        width: 200,
        height: 100,
        parentId: 'a',
      },
      {
        id: 'a.b.c',
        type: 'leaf',
        position: { x: 5, y: 6 },
        width: 50,
        height: 30,
        parentId: 'a.b',
      },
      { id: 'lost', type: 'leaf', position: { x: 7, y: 8 }, width: 1, height: 1, parentId: 'x' },
    ];
    expect(miniMapNodes(nodes)).toEqual([
      { id: 'band', type: 'band', rect: { x: 0, y: 0, width: 900, height: 300 } },
      { id: 'a', type: 'group', rect: { x: 100, y: 50, width: 400, height: 200 } },
      { id: 'a.b', type: 'group', rect: { x: 120, y: 90, width: 200, height: 100 } },
      { id: 'a.b.c', type: 'leaf', rect: { x: 125, y: 96, width: 50, height: 30 } },
      { id: 'lost', type: 'leaf', rect: { x: 7, y: 8, width: 1, height: 1 } },
    ]);
  });
});

describe('miniMapCovers', () => {
  const screen = { width: 1000, height: 600 };
  // A row band over the whole map, an open group with a leaf in its bottom right corner, and a
  // closed group at the top left.
  const band = { id: 'band', type: 'band', position: { x: 0, y: 0 }, width: 1000, height: 600 };
  const group = { id: 'g', type: 'group', position: { x: 500, y: 300 }, width: 500, height: 300 };
  const leaf = {
    id: 'g.leaf',
    type: 'leaf',
    position: { x: 300, y: 200 },
    width: 150,
    height: 60,
    parentId: 'g',
  };
  const closed = { id: 'c', type: 'group', position: { x: 50, y: 50 }, width: 200, height: 100 };
  const plain = { x: 0, y: 0, zoom: 1 };

  it('takes the minimap with the space around it', () => {
    expect(MINIMAP_CORNER).toEqual({ width: MINIMAP.width + 15, height: MINIMAP.height + 15 });
  });

  it('finds a leaf under the corner, not the band or the open group around it', () => {
    // The corner is 785..1000 by 435..600; the leaf lies at 800..950 by 500..560.
    expect(miniMapCovers([band, group, leaf, closed], plain, screen)).toBe(true);
    expect(miniMapCovers([band, group, closed], plain, screen)).toBe(true);
    // An open group reaches under the minimap with its frame only.
    const inside = { ...leaf, position: { x: 20, y: 40 } };
    expect(miniMapCovers([band, group, inside, closed], plain, screen)).toBe(false);
    expect(miniMapCovers([band], plain, screen)).toBe(false);
    expect(miniMapCovers([], plain, screen)).toBe(false);
  });

  it('counts a closed group like a leaf', () => {
    // Panned so that the closed group stands at 800..1000 by 450..550.
    expect(miniMapCovers([band, closed], { x: 750, y: 400, zoom: 1 }, screen)).toBe(true);
    expect(miniMapCovers([band, closed], plain, screen)).toBe(false);
  });

  it('follows the viewport: zoomed out the same leaf is clear, and touching is not under', () => {
    const nodes = [band, group, leaf];
    expect(miniMapCovers(nodes, { x: 0, y: 0, zoom: 0.5 }, screen)).toBe(false);
    // The right edge of the leaf (950) on the left edge of the corner (785): 165 to the left.
    expect(miniMapCovers(nodes, { x: -165, y: 0, zoom: 1 }, screen)).toBe(false);
    expect(miniMapCovers(nodes, { x: -164, y: 0, zoom: 1 }, screen)).toBe(true);
    // Its top (500) on the bottom of the screen: 100 down; past it, the leaf is off the screen.
    expect(miniMapCovers(nodes, { x: 0, y: 99, zoom: 1 }, screen)).toBe(true);
    expect(miniMapCovers(nodes, { x: 0, y: 100, zoom: 1 }, screen)).toBe(false);
    // Another corner.
    expect(miniMapCovers(nodes, plain, screen, { width: 40, height: 30 })).toBe(false);
  });
});

describe('miniMapRoom', () => {
  const screen = { width: 1000, height: 600 };
  // The fit of a map of `size` from the origin: centred in the room that is left, at 125% at most.
  const fit =
    (size: { width: number; height: number }) =>
    (room: MiniMapRoom): Viewport => {
      const width = screen.width - (room === 'beside' ? MINIMAP_CORNER.width : 0);
      const height = screen.height - (room === 'above' ? MINIMAP_CORNER.height : 0);
      const zoom = Math.min(width / size.width, height / size.height, 1.25);
      return {
        x: (width - size.width * zoom) / 2,
        y: (height - size.height * zoom) / 2,
        zoom,
      };
    };
  const cornerLeaf = (size: { width: number; height: number }): MiniMapSourceNode[] => [
    { id: 'band', type: 'band', position: { x: 0, y: 0 }, ...size },
    {
      id: 'leaf',
      type: 'leaf',
      position: { x: size.width - 200, y: size.height - 80 },
      width: 200,
      height: 80,
    },
  ];

  it('keeps no room while the plain fit leaves no box under the minimap', () => {
    const size = { width: 2000, height: 600 };
    const nodes: MiniMapSourceNode[] = [
      { id: 'band', type: 'band', position: { x: 0, y: 0 }, ...size },
      { id: 'leaf', type: 'leaf', position: { x: 100, y: 100 }, width: 200, height: 80 },
    ];
    expect(miniMapRoom(nodes, screen, fit(size))).toBe('none');
    // A map so wide that, fitted to the width, it ends above the minimap: its corner is clear.
    const wide = { width: 2000, height: 500 };
    expect(miniMapCovers(cornerLeaf(wide), fit(wide)('none'), screen)).toBe(false);
    expect(miniMapRoom(cornerLeaf(wide), screen, fit(wide))).toBe('none');
  });

  it('keeps the room that leaves the map larger, and the fit is then clear', () => {
    // Fitted to the height of the screen: beside the minimap the map stays larger than above.
    const high = { width: 1500, height: 1000 };
    expect(miniMapCovers(cornerLeaf(high), fit(high)('none'), screen)).toBe(true);
    expect(miniMapRoom(cornerLeaf(high), screen, fit(high))).toBe('beside');
    expect(miniMapCovers(cornerLeaf(high), fit(high)('beside'), screen)).toBe(false);
    // Fitted to the width: above the minimap it keeps its size and only moves up.
    const wide = { width: 2000, height: 600 };
    expect(miniMapCovers(cornerLeaf(wide), fit(wide)('none'), screen)).toBe(true);
    expect(miniMapRoom(cornerLeaf(wide), screen, fit(wide))).toBe('above');
    expect(fit(wide)('above').zoom).toBe(fit(wide)('none').zoom);
    expect(miniMapCovers(cornerLeaf(wide), fit(wide)('above'), screen)).toBe(false);
    // A small map at the largest zoom, centred: it reaches the corner, and keeps its size.
    const small = { width: 700, height: 400 };
    expect(miniMapCovers(cornerLeaf(small), fit(small)('none'), screen)).toBe(true);
    expect(miniMapRoom(cornerLeaf(small), screen, fit(small))).toBe('beside');
    expect(fit(small)('beside').zoom).toBeGreaterThan(fit(small)('above').zoom);
  });

  it('takes another corner', () => {
    const high = { width: 1500, height: 1000 };
    expect(miniMapRoom(cornerLeaf(high), screen, fit(high), { width: 10, height: 10 })).toBe(
      'none',
    );
  });
});
