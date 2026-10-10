// Display settings the user can change while trying things out: the zoom thresholds of the
// automatic level of detail and how collapsed groups are drawn. Stored once for the whole viewer
// (not per structure). Pure: the storage is injected and nothing here throws.

import { isFocusMode, type FocusMode } from './focus';
import { LOD_CONFIG, LOD_THRESHOLD_KEYS, lodConfigFromStored, type LodConfig } from './lod';
import type { ViewStateStorage } from './visibility';
import { isStoryMode, type StoryMode } from './workitems';

export interface DisplaySettings {
  readonly lod: LodConfig;
  /** Draw closed groups shrunk around their middle instead of keeping the full box. */
  readonly compactCollapsed: boolean;
  /**
   * Closed groups are drawn shrunk and the boxes that are drawn close up around them, for every
   * level of detail and every group opened or closed (`arrangeLayout`). Implies shrunk closed
   * groups whatever `compactCollapsed` says, which keeps its own value.
   */
  readonly closeGaps: boolean;
  /**
   * Arrange the map in its row bands. Off: the rows are left out of the layout altogether and
   * the nodes are arranged by their connections alone (`withoutRows`).
   */
  readonly showRows: boolean;
  /** What the canvas shows of the work items: nothing, the stories, or their tasks too. */
  readonly storyMode: StoryMode;
  /** Work-item states the overlay leaves out (e.g. Closed), sorted, without duplicates. */
  readonly hiddenStates: readonly string[];
  /** Show the completed work items (Closed, Done, Resolved, Removed) too; off hides them. */
  readonly showCompleted: boolean;
  /**
   * When set, the overlay shows the work items of this iteration only — or of the iterations
   * under it (a programme increment). The progress bars follow the same choice.
   */
  readonly iteration?: string;
  /** Heat by work: the sides of a box glow with the open work left in it (src/core/workload.ts). */
  readonly heat: boolean;
  /** Progress: the bottom edge of a box is a bar of the completed items over all of them. */
  readonly progress: boolean;
  /** Edges on demand: edges show only at the hovered or selected box, and those of the focus. */
  readonly edgesOnDemand: boolean;
  /** What the boxes are coloured by (`ColorBy`: `none`, an attribute, or `metric:<name>`). */
  readonly colorBy: string;
  /** How a focus is shown: the rest of the map paled (`focus`), or not drawn at all (`filter`). */
  readonly focusMode: FocusMode;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  lod: LOD_CONFIG,
  compactCollapsed: false,
  closeGaps: false,
  showRows: true,
  storyMode: 'stories',
  hiddenStates: [],
  showCompleted: true,
  heat: false,
  progress: false,
  edgesOnDemand: false,
  colorBy: 'none',
  focusMode: 'focus',
};

/** `settings` showing the work items of `iteration` only, or of every iteration (undefined). */
export function withIteration(
  settings: DisplaySettings,
  iteration: string | undefined,
): DisplaySettings {
  const rest: Record<string, unknown> = { ...settings };
  delete rest.iteration;
  const next = rest as unknown as DisplaySettings;
  return iteration !== undefined && iteration !== '' ? { ...next, iteration } : next;
}

/** Texts of a stored list: trimmed, non-empty, sorted, without duplicates; anything else dropped. */
function storedTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const texts = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry === 'string' && entry.trim() !== '') texts.add(entry.trim());
  }
  return [...texts].sort();
}

export const DISPLAY_SETTINGS_KEY = 'architecture-map.settings';

export function serializeDisplaySettings(settings: DisplaySettings): string {
  const lod: Record<string, number> = {};
  for (const key of LOD_THRESHOLD_KEYS) lod[key] = settings.lod[key];
  return JSON.stringify({
    lod,
    compactCollapsed: settings.compactCollapsed,
    closeGaps: settings.closeGaps,
    showRows: settings.showRows,
    storyMode: settings.storyMode,
    hiddenStates: settings.hiddenStates,
    showCompleted: settings.showCompleted,
    heat: settings.heat,
    progress: settings.progress,
    edgesOnDemand: settings.edgesOnDemand,
    colorBy: settings.colorBy,
    focusMode: settings.focusMode,
    ...(settings.iteration !== undefined ? { iteration: settings.iteration } : {}),
  });
}

/** Settings from stored text; anything missing or invalid falls back to the default. */
export function parseDisplaySettings(text: string | null | undefined): DisplaySettings {
  if (!text) return DEFAULT_DISPLAY_SETTINGS;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_DISPLAY_SETTINGS;
  const record = value as Record<string, unknown>;
  const iteration = typeof record.iteration === 'string' ? record.iteration.trim() : '';
  return {
    lod: lodConfigFromStored(record.lod),
    compactCollapsed: record.compactCollapsed === true,
    closeGaps: record.closeGaps === true,
    showRows: record.showRows !== false,
    storyMode: isStoryMode(record.storyMode)
      ? record.storyMode
      : DEFAULT_DISPLAY_SETTINGS.storyMode,
    hiddenStates: storedTexts(record.hiddenStates),
    showCompleted: record.showCompleted !== false,
    heat: record.heat === true,
    progress: record.progress === true,
    edgesOnDemand: record.edgesOnDemand === true,
    // Checked against the loaded structure when used (`usableColorBy`).
    colorBy:
      typeof record.colorBy === 'string' && record.colorBy.length <= 200 ? record.colorBy : 'none',
    focusMode: isFocusMode(record.focusMode)
      ? record.focusMode
      : DEFAULT_DISPLAY_SETTINGS.focusMode,
    ...(iteration !== '' ? { iteration } : {}),
  };
}

export function readDisplaySettings(storage: ViewStateStorage | undefined): DisplaySettings {
  try {
    return parseDisplaySettings(storage?.getItem(DISPLAY_SETTINGS_KEY));
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

export function writeDisplaySettings(
  storage: ViewStateStorage | undefined,
  settings: DisplaySettings,
): void {
  try {
    storage?.setItem(DISPLAY_SETTINGS_KEY, serializeDisplaySettings(settings));
  } catch {
    // Storage full or blocked: the settings simply are not remembered.
  }
}
