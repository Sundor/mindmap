import { describe, expect, it } from 'vitest';
import {
  fromMiniMap,
  MINIMAP,
  miniMapNodes,
  miniMapTransform,
  rectToMiniMap,
  toMiniMap,
  viewportCentredOn,
  viewportRect,
  zoomAboutCentre,
} from './minimap';
import { ZOOM_RANGE } from './navigate';

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
