// Saved views: a named arrangement of the map — collapsed groups, hidden edge
// kinds, level of detail, focus, colouring and where the view is — kept per structure in the
// browser, and carried in a link (`#view=…`) so that it can be sent to someone. Pure.

import { isEdgeKind, type ArchitectureModel, type EdgeKind } from './model';
import { isLodMode, isValidZoom, type LodMode } from './lod';
import type { Focus } from './focus';
import { isStoryMode, type StoryMode } from './workitems';
import { groupIds, structureIdentity, type ViewStateStorage } from './visibility';
import type { Size } from './layout/types';
import type { Viewport } from './navigate';

/** The point of the map in the middle of the canvas, and the zoom: a view that fits any canvas. */
export interface ViewCenter {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface SavedView {
  readonly name: string;
  readonly collapsed: readonly string[];
  readonly hiddenKinds: readonly EdgeKind[];
  readonly lodMode: LodMode;
  readonly center: ViewCenter;
  readonly focus?: Focus;
  /** A `ColorBy` value; checked against the structure when applied. */
  readonly colorBy?: string;
  readonly storyMode?: StoryMode;
}

/** Longest name of a saved view; longer ones are cut when read. */
export const VIEW_NAME_MAX = 60;
/** How many views are kept per structure; the oldest go first. */
export const VIEWS_MAX = 30;

export const VIEWS_STORAGE_PREFIX = 'architecture-map.views:';

export function viewsStorageKey(model: ArchitectureModel): string {
  return `${VIEWS_STORAGE_PREFIX}${structureIdentity(model)}`;
}

/** The canvas point in the middle of `size` under `viewport`, with the zoom. */
export function viewportToCenter(viewport: Viewport, size: Size): ViewCenter {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  return {
    x: (size.width / 2 - viewport.x) / zoom,
    y: (size.height / 2 - viewport.y) / zoom,
    zoom,
  };
}

/** The viewport that puts `center` in the middle of a canvas of `size`. */
export function centerToViewport(center: ViewCenter, size: Size): Viewport {
  return {
    x: size.width / 2 - center.x * center.zoom,
    y: size.height / 2 - center.y * center.zoom,
    zoom: center.zoom,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * One view from stored or linked data, checked against `model`: unknown or non-group collapsed
 * IDs and unknown kinds are dropped, a flow focus must name a flow of the model, numbers must be
 * finite and the zoom valid. Undefined when the shape is not a view at all.
 */
export function parseSavedView(value: unknown, model: ArchitectureModel): SavedView | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, VIEW_NAME_MAX) : '';
  const center = value.center;
  if (!isRecord(center)) return undefined;
  const x = finite(center.x);
  const y = finite(center.y);
  const zoom = finite(center.zoom);
  if (x === undefined || y === undefined || zoom === undefined || !isValidZoom(zoom)) {
    return undefined;
  }
  const groups = new Set(groupIds(model));
  const collapsed = Array.isArray(value.collapsed)
    ? [
        ...new Set(
          (value.collapsed as unknown[]).filter(
            (id): id is string => typeof id === 'string' && groups.has(id),
          ),
        ),
      ].sort()
    : [];
  const hiddenKinds = Array.isArray(value.hiddenKinds)
    ? [...new Set((value.hiddenKinds as unknown[]).filter(isEdgeKind))]
    : [];
  const lodMode = isLodMode(value.lodMode) ? value.lodMode : 'auto';
  let focus: Focus | undefined;
  const linkedFocus = value.focus;
  if (isRecord(linkedFocus)) {
    const id = linkedFocus.id;
    if (
      linkedFocus.type === 'flow' &&
      typeof id === 'string' &&
      model.flows.some((flow) => flow.id === id)
    ) {
      focus = { type: 'flow', id };
    } else if (
      linkedFocus.type === 'workitem' &&
      typeof id === 'number' &&
      Number.isSafeInteger(id) &&
      id > 0
    ) {
      focus = { type: 'workitem', id };
    }
  }
  const colorBy =
    typeof value.colorBy === 'string' && value.colorBy !== 'none' && value.colorBy.length <= 200
      ? value.colorBy
      : undefined;
  const storyMode = isStoryMode(value.storyMode) ? value.storyMode : undefined;
  return {
    name,
    collapsed,
    hiddenKinds,
    lodMode,
    center: { x, y, zoom },
    ...(focus ? { focus } : {}),
    ...(colorBy !== undefined ? { colorBy } : {}),
    ...(storyMode !== undefined ? { storyMode } : {}),
  };
}

export function serializeSavedViews(views: readonly SavedView[]): string {
  return JSON.stringify(views);
}

/** The stored list; entries that are not views are dropped, as is anything beyond the limit. */
export function parseSavedViews(
  text: string | null | undefined,
  model: ArchitectureModel,
): SavedView[] {
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const views: SavedView[] = [];
  for (const entry of value as unknown[]) {
    const view = parseSavedView(entry, model);
    if (view && view.name !== '') views.push(view);
  }
  return views.slice(-VIEWS_MAX);
}

export function readSavedViews(
  storage: ViewStateStorage | undefined,
  model: ArchitectureModel,
): SavedView[] {
  try {
    return parseSavedViews(storage?.getItem(viewsStorageKey(model)), model);
  } catch {
    return [];
  }
}

export function writeSavedViews(
  storage: ViewStateStorage | undefined,
  model: ArchitectureModel,
  views: readonly SavedView[],
): void {
  try {
    storage?.setItem(viewsStorageKey(model), serializeSavedViews(views));
  } catch {
    // Storage full or blocked: the views are simply not remembered.
  }
}

/** `views` with `view` added, replacing one of the same name; the oldest goes beyond the limit. */
export function withSavedView(views: readonly SavedView[], view: SavedView): SavedView[] {
  const kept = views.filter((candidate) => candidate.name !== view.name);
  return [...kept, view].slice(-VIEWS_MAX);
}

export function withoutSavedView(views: readonly SavedView[], name: string): SavedView[] {
  return views.filter((candidate) => candidate.name !== name);
}

// --- Links ----------------------------------------------------------------------------------

export const VIEW_LINK_PARAM = 'view';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string | undefined {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** The fragment (`#view=…`) that carries `view`; the name is left out of a link. */
export function viewLinkHash(view: SavedView): string {
  const linked: Record<string, unknown> = { ...view };
  delete linked.name;
  return `#${VIEW_LINK_PARAM}=${toBase64Url(JSON.stringify(linked))}`;
}

/** The view a page fragment carries, checked against `model`; undefined when there is none. */
export function viewFromLinkHash(hash: string, model: ArchitectureModel): SavedView | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const encoded = params.get(VIEW_LINK_PARAM);
  if (!encoded) return undefined;
  const json = fromBase64Url(encoded);
  if (json === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const view = parseSavedView(value, model);
  return view ? { ...view, name: view.name === '' ? 'Linked view' : view.name } : undefined;
}
