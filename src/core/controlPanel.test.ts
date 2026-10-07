import { describe, expect, it } from 'vitest';
import {
  CONTROL_PANEL_DOCK_WIDTH,
  CONTROL_PANEL_KEY,
  CONTROL_TABS,
  controlPanelCollapsed,
  controlTabAfterKey,
  DEFAULT_CONTROL_PANEL,
  isControlTab,
  parseControlPanel,
  readControlPanel,
  serializeControlPanel,
  shownControlTab,
  writeControlPanel,
  type ControlPanelState,
} from './controlPanel';

describe('the tabs', () => {
  it('start on Detail, with the collapsed state not chosen', () => {
    expect(DEFAULT_CONTROL_PANEL).toEqual({ tab: 'detail' });
    expect(CONTROL_TABS[0]).toBe('detail');
  });

  it('are told from anything else', () => {
    for (const tab of CONTROL_TABS) expect(isControlTab(tab)).toBe(true);
    for (const value of ['settings', 'Detail', '', 0, null, undefined, ['detail']]) {
      expect(isControlTab(value)).toBe(false);
    }
  });
});

describe('stored control panel', () => {
  it('gives the default for no text, bad JSON and anything that is not an object', () => {
    for (const text of [null, undefined, '', 'nope', '{"tab":', '3', 'null', '"views"']) {
      expect(parseControlPanel(text)).toBe(DEFAULT_CONTROL_PANEL);
    }
  });

  it('falls back to Detail for an unknown or missing tab', () => {
    expect(parseControlPanel('{"tab":"settings"}')).toEqual({ tab: 'detail' });
    expect(parseControlPanel('{"tab":3,"collapsed":true}')).toEqual({
      tab: 'detail',
      collapsed: true,
    });
    expect(parseControlPanel('{}')).toEqual({ tab: 'detail' });
    expect(parseControlPanel('[]')).toEqual({ tab: 'detail' });
  });

  it('keeps `collapsed` only when it is a boolean', () => {
    for (const collapsed of ['"true"', '1', '0', 'null', '{}']) {
      const state = parseControlPanel(`{"tab":"views","collapsed":${collapsed}}`);
      expect(state).toEqual({ tab: 'views' });
      expect('collapsed' in state).toBe(false);
    }
    expect(parseControlPanel('{"tab":"views","collapsed":false}')).toEqual({
      tab: 'views',
      collapsed: false,
    });
  });

  it('round-trips with and without `collapsed`, which is written only when chosen', () => {
    expect(serializeControlPanel({ tab: 'views' })).toBe('{"tab":"views"}');
    expect(serializeControlPanel({ tab: 'views', collapsed: true })).toBe(
      '{"tab":"views","collapsed":true}',
    );
    const states: ControlPanelState[] = [
      { tab: 'files' },
      { tab: 'lenses', collapsed: true },
      { tab: 'layout', collapsed: false },
    ];
    for (const state of states) {
      expect(parseControlPanel(serializeControlPanel(state))).toEqual(state);
    }
  });

  it('reads and writes through a storage, and survives one that throws or is missing', () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    expect(readControlPanel(storage)).toBe(DEFAULT_CONTROL_PANEL);
    const state: ControlPanelState = { tab: 'visibility', collapsed: true };
    writeControlPanel(storage, state);
    expect(items.get(CONTROL_PANEL_KEY)).toBe('{"tab":"visibility","collapsed":true}');
    expect(readControlPanel(storage)).toEqual(state);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(readControlPanel(broken)).toBe(DEFAULT_CONTROL_PANEL);
    expect(() => writeControlPanel(broken, state)).not.toThrow();
    expect(readControlPanel(undefined)).toBe(DEFAULT_CONTROL_PANEL);
    expect(() => writeControlPanel(undefined, state)).not.toThrow();
  });
});

describe('controlPanelCollapsed', () => {
  it('is what the user chose, whatever the window', () => {
    expect(controlPanelCollapsed({ tab: 'detail', collapsed: true }, 1920)).toBe(true);
    expect(controlPanelCollapsed({ tab: 'detail', collapsed: false }, 800)).toBe(false);
  });

  it('follows the window while nothing is chosen: collapsed below the dock width', () => {
    expect(CONTROL_PANEL_DOCK_WIDTH).toBe(1400);
    expect(controlPanelCollapsed(DEFAULT_CONTROL_PANEL, 1399)).toBe(true);
    expect(controlPanelCollapsed(DEFAULT_CONTROL_PANEL, 1400)).toBe(false);
  });
});

describe('shownControlTab', () => {
  it('is the chosen tab with a structure and Files without one', () => {
    expect(shownControlTab('lenses', true)).toBe('lenses');
    expect(shownControlTab('lenses', false)).toBe('files');
    expect(shownControlTab('files', false)).toBe('files');
  });
});

describe('controlTabAfterKey', () => {
  it('steps down and up', () => {
    expect(controlTabAfterKey('detail', 'ArrowDown')).toBe('visibility');
    expect(controlTabAfterKey('layout', 'ArrowUp')).toBe('lenses');
  });

  it('wraps at both ends', () => {
    expect(controlTabAfterKey('files', 'ArrowDown')).toBe('detail');
    expect(controlTabAfterKey('detail', 'ArrowUp')).toBe('files');
  });

  it('goes to the first tab on Home and to the last on End', () => {
    expect(controlTabAfterKey('layout', 'Home')).toBe('detail');
    expect(controlTabAfterKey('layout', 'End')).toBe('files');
  });

  it('gives nothing for any other key', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Tab', 'a']) {
      expect(controlTabAfterKey('detail', key)).toBeUndefined();
    }
  });

  it('moves among the given tabs only', () => {
    const one = ['files'] as const;
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(controlTabAfterKey('files', key, one)).toBe('files');
      expect(controlTabAfterKey('lenses', key, one)).toBe('files');
    }
    const some = ['visibility', 'views'] as const;
    expect(controlTabAfterKey('detail', 'ArrowDown', some)).toBe('visibility');
    expect(controlTabAfterKey('detail', 'ArrowUp', some)).toBe('views');
    expect(controlTabAfterKey('detail', 'ArrowDown', [])).toBeUndefined();
    expect(controlTabAfterKey('detail', 'Home', [])).toBeUndefined();
  });
});
