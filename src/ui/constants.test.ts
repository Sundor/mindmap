// How the map is fitted into the canvas: clear of what covers its left, and of the minimap.

import { getViewportForBounds } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import {
  FIT_MAX_ZOOM,
  MINIMAP_CORNER,
  miniMapCovers,
  ZOOM_RANGE,
  type MiniMapSourceNode,
  type Size,
} from '../core';
import { FIT_VIEW_OPTIONS, fitOptions, fitRoom, fitWithRoom, type MapFit } from './constants';

/** A map of `size` from the origin: a row band over all of it, a box in its bottom right corner. */
function mapWithCornerBox(size: Size): MiniMapSourceNode[] {
  return [
    { id: 'band', type: 'band', position: { x: 0, y: 0 }, ...size },
    {
      id: 'box',
      type: 'leaf',
      position: { x: size.width - 220, y: size.height - 80 },
      width: 200,
      height: 72,
    },
  ];
}

/** Whether `fit` leaves a box of the map under the minimap, as React Flow fits it. */
function covered(fit: MapFit, nodes: readonly MiniMapSourceNode[], map: Size, canvas: Size) {
  const viewport = getViewportForBounds(
    { x: 0, y: 0, ...map },
    canvas.width,
    canvas.height,
    ZOOM_RANGE.min,
    fit.maxZoom,
    fit.padding,
  );
  return miniMapCovers(nodes, viewport, canvas);
}

describe('fitOptions', () => {
  it('is the plain fit while nothing covers the left of the canvas', () => {
    expect(fitOptions(0)).toBe(FIT_VIEW_OPTIONS);
    expect(fitOptions(-5)).toBe(FIT_VIEW_OPTIONS);
    expect(fitOptions(Number.NaN)).toBe(FIT_VIEW_OPTIONS);
  });

  it('keeps what is covered, and a gap beside it, free at the left', () => {
    expect(fitOptions(280)).toEqual({
      maxZoom: FIT_MAX_ZOOM,
      padding: { top: 0.05, right: 0.05, bottom: 0.05, left: '296px' },
    });
  });
});

describe('fitWithRoom', () => {
  it('is the fit itself without room', () => {
    const inset = fitOptions(280);
    expect(fitWithRoom(FIT_VIEW_OPTIONS, 'none')).toBe(FIT_VIEW_OPTIONS);
    expect(fitWithRoom(inset, 'none')).toBe(inset);
  });

  it('keeps the corner of the minimap free at the right or at the bottom, and the rest as it is', () => {
    expect(fitWithRoom(FIT_VIEW_OPTIONS, 'beside')).toEqual({
      maxZoom: FIT_MAX_ZOOM,
      padding: { top: 0.05, right: `${MINIMAP_CORNER.width}px`, bottom: 0.05, left: 0.05 },
    });
    expect(fitWithRoom(fitOptions(280), 'above')).toEqual({
      maxZoom: FIT_MAX_ZOOM,
      padding: { top: 0.05, right: 0.05, bottom: `${MINIMAP_CORNER.height}px`, left: '296px' },
    });
  });
});

describe('fitRoom', () => {
  const canvas = { width: 1100, height: 820 };

  it('keeps none while the fit leaves the minimap clear, or nothing can be judged', () => {
    // So wide that, fitted, it ends well above the minimap.
    const wide = { width: 2400, height: 600 };
    expect(fitRoom(FIT_VIEW_OPTIONS, mapWithCornerBox(wide), canvas)).toBe('none');
    expect(covered(FIT_VIEW_OPTIONS, mapWithCornerBox(wide), wide, canvas)).toBe(false);
    // Only the band reaches the corner.
    const band: MiniMapSourceNode[] = [
      { id: 'band', type: 'band', position: { x: 0, y: 0 }, width: 1000, height: 740 },
    ];
    expect(fitRoom(FIT_VIEW_OPTIONS, band, canvas)).toBe('none');
    expect(fitRoom(FIT_VIEW_OPTIONS, [], canvas)).toBe('none');
    const small = { width: 800, height: 560 };
    expect(fitRoom(FIT_VIEW_OPTIONS, mapWithCornerBox(small), { width: 0, height: 0 })).toBe(
      'none',
    );
  });

  it('keeps the room that leaves the map larger, and the fit with it is clear of the minimap', () => {
    for (const map of [
      { width: 800, height: 560 },
      { width: 1040, height: 740 },
      { width: 1500, height: 1000 },
      { width: 2000, height: 1200 },
      { width: 700, height: 1400 },
    ]) {
      const nodes = mapWithCornerBox(map);
      if (!covered(FIT_VIEW_OPTIONS, nodes, map, canvas)) {
        expect(fitRoom(FIT_VIEW_OPTIONS, nodes, canvas), JSON.stringify(map)).toBe('none');
        continue;
      }
      const room = fitRoom(FIT_VIEW_OPTIONS, nodes, canvas);
      expect(room, JSON.stringify(map)).not.toBe('none');
      expect(covered(fitWithRoom(FIT_VIEW_OPTIONS, room), nodes, map, canvas)).toBe(false);
      // The other room would leave the map no larger.
      const zoom = (kept: 'beside' | 'above') =>
        getViewportForBounds(
          { x: 0, y: 0, ...map },
          canvas.width,
          canvas.height,
          ZOOM_RANGE.min,
          FIT_MAX_ZOOM,
          fitWithRoom(FIT_VIEW_OPTIONS, kept).padding,
        ).zoom;
      expect(zoom(room as 'beside' | 'above')).toBe(Math.max(zoom('beside'), zoom('above')));
    }
    // A small map at the largest zoom reaches the corner: the plain fit hides its box.
    const small = { width: 800, height: 560 };
    expect(covered(FIT_VIEW_OPTIONS, mapWithCornerBox(small), small, canvas)).toBe(true);
    expect(fitRoom(FIT_VIEW_OPTIONS, mapWithCornerBox(small), canvas)).not.toBe('none');
  });

  it('judges the fit into what the control panel leaves free', () => {
    // At the largest zoom the map stands in the middle, clear of the minimap; beside a covered
    // left it is pushed towards it.
    const map = { width: 500, height: 600 };
    const nodes = mapWithCornerBox(map);
    const inset = fitOptions(280);
    expect(fitRoom(FIT_VIEW_OPTIONS, nodes, canvas)).toBe('none');
    expect(covered(inset, nodes, map, canvas)).toBe(true);
    const room = fitRoom(inset, nodes, canvas);
    expect(room).not.toBe('none');
    expect(covered(fitWithRoom(inset, room), nodes, map, canvas)).toBe(false);
  });
});
