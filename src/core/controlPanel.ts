// The control panel at the left of the map: which of its tabs is shown and whether its body is
// collapsed to the rail, how that is stored (once for the viewer, not per structure), and where
// the keys move among the tabs. Pure: the storage is injected and nothing here throws.

import type { ViewStateStorage } from './visibility';

/** The tabs of the control panel, in rail order. */
export const CONTROL_TABS = ['detail', 'visibility', 'lenses', 'layout', 'views', 'files'] as const;
export type ControlTab = (typeof CONTROL_TABS)[number];

export function isControlTab(value: unknown): value is ControlTab {
  return typeof value === 'string' && (CONTROL_TABS as readonly string[]).includes(value);
}

export interface ControlPanelState {
  readonly tab: ControlTab;
  /** Whether the body is collapsed to the rail; absent until the user has chosen. */
  readonly collapsed?: boolean;
}

export const DEFAULT_CONTROL_PANEL: ControlPanelState = { tab: 'detail' };

/** Window width from which the open body stands beside the canvas (mirrored in styles.css). */
export const CONTROL_PANEL_DOCK_WIDTH = 1400;

/** Collapsed as chosen; never chosen: collapsed on a window narrower than the dock width. */
export function controlPanelCollapsed(state: ControlPanelState, windowWidth: number): boolean {
  return state.collapsed ?? windowWidth < CONTROL_PANEL_DOCK_WIDTH;
}

/** The tab the panel shows: `tab`, or 'files' while there is no structure. */
export function shownControlTab(tab: ControlTab, hasStructure: boolean): ControlTab {
  return hasStructure ? tab : 'files';
}

/**
 * The tab a key moves to from `current` among `tabs`: ArrowDown / ArrowUp (wrapping), Home, End;
 * undefined for any other key or when `tabs` is empty. From a tab that is not among `tabs`,
 * ArrowDown goes to the first and ArrowUp to the last.
 */
export function controlTabAfterKey(
  current: ControlTab,
  key: string,
  tabs: readonly ControlTab[] = CONTROL_TABS,
): ControlTab | undefined {
  if (tabs.length === 0) return undefined;
  const at = tabs.indexOf(current);
  switch (key) {
    case 'ArrowDown':
      return tabs[(at + 1) % tabs.length];
    case 'ArrowUp':
      return tabs[(Math.max(at, 0) - 1 + tabs.length) % tabs.length];
    case 'Home':
      return tabs[0];
    case 'End':
      return tabs[tabs.length - 1];
    default:
      return undefined;
  }
}

// --- Storage --------------------------------------------------------------------------------

export const CONTROL_PANEL_KEY = 'architecture-map.control-panel';

/** `{"tab":"views"}` or `{"tab":"views","collapsed":true}`; `collapsed` only when chosen. */
export function serializeControlPanel(state: ControlPanelState): string {
  return JSON.stringify({
    tab: state.tab,
    ...(state.collapsed === undefined ? {} : { collapsed: state.collapsed }),
  });
}

/**
 * State from stored text. Tolerant: no text, bad JSON, no object → the default; unknown tab →
 * 'detail'; `collapsed` kept only when it is a boolean.
 */
export function parseControlPanel(text: string | null | undefined): ControlPanelState {
  if (!text) return DEFAULT_CONTROL_PANEL;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_CONTROL_PANEL;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_CONTROL_PANEL;
  const record = value as Record<string, unknown>;
  const tab = isControlTab(record.tab) ? record.tab : DEFAULT_CONTROL_PANEL.tab;
  return typeof record.collapsed === 'boolean' ? { tab, collapsed: record.collapsed } : { tab };
}

export function readControlPanel(storage: ViewStateStorage | undefined): ControlPanelState {
  try {
    return parseControlPanel(storage?.getItem(CONTROL_PANEL_KEY));
  } catch {
    return DEFAULT_CONTROL_PANEL;
  }
}

export function writeControlPanel(
  storage: ViewStateStorage | undefined,
  state: ControlPanelState,
): void {
  try {
    storage?.setItem(CONTROL_PANEL_KEY, serializeControlPanel(state));
  } catch {
    // Storage full or blocked: the tab and the collapsed state simply are not remembered.
  }
}
