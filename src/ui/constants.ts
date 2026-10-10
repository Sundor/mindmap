// Sizes shared between components and the code that positions the view.

import { getViewportForBounds, type FitViewOptions } from '@xyflow/react';
import {
  FIT_MAX_ZOOM,
  MINIMAP_CORNER,
  miniMapNodes,
  miniMapRoom,
  unionRect,
  ZOOM_RANGE,
  type MiniMapRoom,
  type MiniMapSourceNode,
  type Size,
  type Viewport,
} from '../core';

/** Width of the detail panel in pixels; allowed for when something is brought on screen. */
export const DETAIL_PANEL_WIDTH = 340;

/** How the view is fitted: on load, when a stored viewport is useless, and by **Fit view**. */
export const FIT_VIEW_OPTIONS = { padding: 0.05, maxZoom: FIT_MAX_ZOOM } as const;

/** Free space kept between the map and whatever covers the left of the canvas, in pixels. */
const FIT_INSET_GAP = 16;

type FitPadding = NonNullable<FitViewOptions['padding']>;

/** A fit of the map: the free space kept around it, and how far it may zoom in. */
export interface MapFit {
  readonly padding: FitPadding;
  readonly maxZoom: number;
}

/**
 * {@link FIT_VIEW_OPTIONS} for a canvas whose left `insetLeft` pixels are covered (see
 * `coveredCanvasLeft`): the map is fitted into what is left free.
 */
export function fitOptions(insetLeft: number): MapFit {
  if (!(insetLeft > 0)) return FIT_VIEW_OPTIONS;
  const { padding, maxZoom } = FIT_VIEW_OPTIONS;
  return {
    maxZoom,
    padding: {
      top: padding,
      right: padding,
      bottom: padding,
      left: `${Math.round(insetLeft) + FIT_INSET_GAP}px`,
    },
  };
}

/**
 * `fit` with room kept for the minimap: the map ends beside it or above it. `fit` itself for no
 * room.
 */
export function fitWithRoom(fit: MapFit, room: MiniMapRoom): MapFit {
  if (room === 'none') return fit;
  const { padding, maxZoom } = fit;
  const sides =
    typeof padding === 'object'
      ? padding
      : { top: padding, right: padding, bottom: padding, left: padding };
  return {
    maxZoom,
    padding:
      room === 'beside'
        ? { ...sides, right: `${MINIMAP_CORNER.width}px` }
        : { ...sides, bottom: `${MINIMAP_CORNER.height}px` },
  };
}

/**
 * The room `fit` has to keep for the minimap so that the map drawn by `nodes`, fitted into a
 * canvas of `size`, has none of its boxes under it (`miniMapRoom`): none while the fit leaves
 * the minimap clear anyway, and none for a canvas without a size.
 */
export function fitRoom(fit: MapFit, nodes: readonly MiniMapSourceNode[], size: Size): MiniMapRoom {
  const bounds = unionRect(miniMapNodes(nodes).map((node) => node.rect));
  if (!bounds || !(size.width > 0 && size.height > 0)) return 'none';
  // The viewport React Flow gives the fit with that room.
  return miniMapRoom(nodes, size, (room) =>
    getViewportForBounds(
      bounds,
      size.width,
      size.height,
      ZOOM_RANGE.min,
      fit.maxZoom,
      fitWithRoom(fit, room).padding,
    ),
  );
}

/**
 * The viewport that fits the map drawn by `nodes` into a canvas of `size` with `plain` and the
 * room the minimap needs (`fitRoom`): what React Flow's `fitView` with those options gives for
 * those nodes. Undefined for no nodes or a canvas without a size.
 */
export function fittedViewport(
  plain: MapFit,
  nodes: readonly MiniMapSourceNode[],
  size: Size,
): Viewport | undefined {
  const bounds = unionRect(miniMapNodes(nodes).map((node) => node.rect));
  if (!bounds || !(size.width > 0 && size.height > 0)) return undefined;
  const fit = fitWithRoom(plain, fitRoom(plain, nodes, size));
  return getViewportForBounds(
    bounds,
    size.width,
    size.height,
    ZOOM_RANGE.min,
    fit.maxZoom,
    fit.padding,
  );
}
