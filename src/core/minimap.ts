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

/** Free space React Flow keeps around a panel on the canvas, in pixels; the minimap is one. */
const PANEL_MARGIN = 15;

/** The corner at the bottom right of the canvas that the minimap takes, with that space. */
export const MINIMAP_CORNER: Size = {
  width: MINIMAP.width + PANEL_MARGIN,
  height: MINIMAP.height + PANEL_MARGIN,
};

/**
 * Whether the minimap lies over a box of the map as `viewport` shows it on a screen of `screen`
 * pixels, the minimap taking the bottom right `corner`. Only the boxes that hold no other box
 * count, the leaves and the closed groups: of an open group it is the frame that reaches under
 * the minimap, and a row band is no box.
 */
export function miniMapCovers(
  nodes: readonly MiniMapSourceNode[],
  viewport: Viewport,
  screen: Size,
  corner: Size = MINIMAP_CORNER,
): boolean {
  const view = viewportRect(viewport, screen);
  const right = view.x + view.width;
  const bottom = view.y + view.height;
  const left = right - corner.width / viewport.zoom;
  const top = bottom - corner.height / viewport.zoom;
  const parents = new Set(nodes.map((node) => node.parentId));
  return miniMapNodes(nodes).some(
    ({ id, type, rect }) =>
      type !== 'band' &&
      !parents.has(id) &&
      rect.x < right &&
      rect.x + rect.width > left &&
      rect.y < bottom &&
      rect.y + rect.height > top,
  );
}

/** Where room is kept for the minimap when the map is fitted: nowhere, at its right or below it. */
export type MiniMapRoom = 'none' | 'beside' | 'above';

/**
 * The room to keep for the minimap when the map drawn by `nodes` is fitted into a screen of
 * `screen` pixels. `fitted` gives the viewport of the fit with that room: none (the map may reach
 * into the corner), the map ending beside the minimap, or ending above it. None is kept while
 * the plain fit leaves no box under the minimap; otherwise the one that leaves the map larger.
 */
export function miniMapRoom(
  nodes: readonly MiniMapSourceNode[],
  screen: Size,
  fitted: (room: MiniMapRoom) => Viewport,
  corner: Size = MINIMAP_CORNER,
): MiniMapRoom {
  if (!miniMapCovers(nodes, fitted('none'), screen, corner)) return 'none';
  return fitted('beside').zoom >= fitted('above').zoom ? 'beside' : 'above';
}
