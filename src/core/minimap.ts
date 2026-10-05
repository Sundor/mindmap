// Geometry of the minimap: the whole map at one fixed scale, with the part the
// canvas shows drawn as a rectangle. Unlike React Flow's own minimap the scale depends on the
// map alone, never on the viewport: a view panned off the map is drawn where it is and simply
// cut off at the edge of the minimap. Pure; the component is src/ui/MiniMapFixed.tsx.

import type { Rect, Size } from './layout/types';
import { ZOOM_RANGE, type Viewport, type ZoomRange } from './navigate';

/** A point, in canvas or in minimap coordinates. */
export interface MiniMapPoint {
  readonly x: number;
  readonly y: number;
}

/** Canvas → minimap: `minimap = canvas * scale + offset`. */
export interface MiniMapTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Size of the minimap in pixels, and the free space kept around the map inside it. */
export const MINIMAP = { width: 200, height: 150, margin: 6 } as const;

/**
 * The transform that fits the map (`bounds`, from the canvas origin) into a minimap of `size`
 * with `margin` pixels free on every side, centred. A map without area gets scale 1.
 */
export function miniMapTransform(
  bounds: Size,
  size: Size = MINIMAP,
  margin: number = MINIMAP.margin,
): MiniMapTransform {
  const roomX = Math.max(1, size.width - 2 * margin);
  const roomY = Math.max(1, size.height - 2 * margin);
  const scale =
    bounds.width > 0 && bounds.height > 0
      ? Math.min(roomX / bounds.width, roomY / bounds.height)
      : 1;
  return {
    scale,
    offsetX: (size.width - bounds.width * scale) / 2,
    offsetY: (size.height - bounds.height * scale) / 2,
  };
}

/** A canvas point in minimap coordinates. */
export function toMiniMap(transform: MiniMapTransform, point: MiniMapPoint): MiniMapPoint {
  return {
    x: point.x * transform.scale + transform.offsetX,
    y: point.y * transform.scale + transform.offsetY,
  };
}

/** A minimap point in canvas coordinates (the inverse of {@link toMiniMap}). */
export function fromMiniMap(transform: MiniMapTransform, point: MiniMapPoint): MiniMapPoint {
  return {
    x: (point.x - transform.offsetX) / transform.scale,
    y: (point.y - transform.offsetY) / transform.scale,
  };
}

/** A canvas rectangle in minimap coordinates. */
export function rectToMiniMap(transform: MiniMapTransform, rect: Rect): Rect {
  const { x, y } = toMiniMap(transform, rect);
  return { x, y, width: rect.width * transform.scale, height: rect.height * transform.scale };
}

/** The part of the canvas a screen of `screen` pixels shows under `viewport`. */
export function viewportRect(viewport: Viewport, screen: Size): Rect {
  return {
    x: (0 - viewport.x) / viewport.zoom,
    y: (0 - viewport.y) / viewport.zoom,
    width: screen.width / viewport.zoom,
    height: screen.height / viewport.zoom,
  };
}

/** The viewport that puts the canvas point `centre` in the middle of the screen at `zoom`. */
export function viewportCentredOn(centre: MiniMapPoint, zoom: number, screen: Size): Viewport {
  return {
    x: screen.width / 2 - centre.x * zoom,
    y: screen.height / 2 - centre.y * zoom,
    zoom,
  };
}

/** Wheel distance (pixels of `deltaY`) that doubles or halves the zoom over the minimap. */
export const MINIMAP_WHEEL_DOUBLING = 300;

/**
 * `viewport` zoomed by a wheel movement of `deltaY` pixels (up = in), keeping the canvas point
 * in the middle of the screen where it is. The zoom stays within `range`.
 */
export function zoomAboutCentre(
  viewport: Viewport,
  screen: Size,
  deltaY: number,
  range: ZoomRange = ZOOM_RANGE,
): Viewport {
  const zoom = Math.min(
    range.max,
    Math.max(range.min, viewport.zoom * 2 ** (-deltaY / MINIMAP_WHEEL_DOUBLING)),
  );
  const view = viewportRect(viewport, screen);
  return viewportCentredOn(
    { x: view.x + view.width / 2, y: view.y + view.height / 2 },
    zoom,
    screen,
  );
}

/** What the minimap needs of a drawn node: where it is, relative to its parent if it has one. */
export interface MiniMapSourceNode {
  readonly id: string;
  readonly type: string;
  readonly position: MiniMapPoint;
  readonly width: number;
  readonly height: number;
  readonly parentId?: string;
}

export interface MiniMapNode {
  readonly id: string;
  readonly type: string;
  /** In canvas coordinates. */
  readonly rect: Rect;
}

/**
 * The drawn nodes with their rectangles in canvas coordinates, in the given order (parents come
 * before their children, as `buildFlow` produces them). A node whose parent is missing is taken
 * as top-level.
 */
export function miniMapNodes(nodes: readonly MiniMapSourceNode[]): MiniMapNode[] {
  const origins = new Map<string, MiniMapPoint>();
  return nodes.map((node) => {
    const parent = node.parentId === undefined ? undefined : origins.get(node.parentId);
    const x = node.position.x + (parent?.x ?? 0);
    const y = node.position.y + (parent?.y ?? 0);
    origins.set(node.id, { x, y });
    return { id: node.id, type: node.type, rect: { x, y, width: node.width, height: node.height } };
  });
}
