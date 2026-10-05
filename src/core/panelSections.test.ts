import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_LAYOUT,
  isSectionCollapsed,
  moveSection,
  NODE_PANEL_SECTIONS,
  orderSections,
  PANEL_LAYOUT_KEY,
  parsePanelLayout,
  readPanelLayout,
  serializePanelLayout,
  toggleSection,
  writePanelLayout,
  type PanelLayout,
} from './panelSections';

const ALL = NODE_PANEL_SECTIONS;

describe('orderSections', () => {
  it('keeps the default order without a stored one', () => {
    expect(orderSections(ALL, DEFAULT_PANEL_LAYOUT)).toEqual([...ALL]);
  });

  it('puts the named sections first and the rest after, skipping unknown and repeated IDs', () => {
    const layout: PanelLayout = {
      order: ['workitems', 'nope', 'incoming', 'workitems'],
      collapsed: [],
    };
    expect(orderSections(ALL, layout)).toEqual([
      'workitems',
      'incoming',
      'children',
      'outgoing',
      'internal',
    ]);
    expect(orderSections(['incoming', 'outgoing'], layout)).toEqual(['incoming', 'outgoing']);
  });
});

describe('moveSection', () => {
  it('moves one place up or down among the shown sections', () => {
    const up = moveSection(DEFAULT_PANEL_LAYOUT, ALL, ALL, 'workitems', 'up');
    expect(orderSections(ALL, up)).toEqual([
      'children',
      'incoming',
      'outgoing',
      'workitems',
      'internal',
    ]);
    const down = moveSection(DEFAULT_PANEL_LAYOUT, ALL, ALL, 'children', 'down');
    expect(orderSections(ALL, down)).toEqual([
      'incoming',
      'children',
      'outgoing',
      'internal',
      'workitems',
    ]);
  });

  it('steps over the neighbour that is on screen, leaving hidden sections in place', () => {
    // "internal" is not shown: work items go above "outgoing", their visible neighbour.
    const shown = ['incoming', 'outgoing', 'workitems'];
    const moved = moveSection(DEFAULT_PANEL_LAYOUT, ALL, shown, 'workitems', 'up');
    expect(orderSections(shown, moved)).toEqual(['incoming', 'workitems', 'outgoing']);
    expect(orderSections(ALL, moved)).toEqual([
      'children',
      'incoming',
      'workitems',
      'outgoing',
      'internal',
    ]);
  });

  it('drops a section right before another', () => {
    const moved = moveSection(DEFAULT_PANEL_LAYOUT, ALL, ALL, 'workitems', { before: 'children' });
    expect(orderSections(ALL, moved)[0]).toBe('workitems');
    const back = moveSection(moved, ALL, ALL, 'workitems', { before: 'internal' });
    expect(orderSections(ALL, back)).toEqual([
      'children',
      'incoming',
      'outgoing',
      'workitems',
      'internal',
    ]);
  });

  it('returns the same layout when nothing changes', () => {
    const layout = DEFAULT_PANEL_LAYOUT;
    expect(moveSection(layout, ALL, ALL, 'children', 'up')).toBe(layout);
    expect(moveSection(layout, ALL, ALL, 'workitems', 'down')).toBe(layout);
    expect(moveSection(layout, ALL, ALL, 'nope', 'up')).toBe(layout);
    expect(moveSection(layout, ALL, ALL, 'incoming', { before: 'incoming' })).toBe(layout);
    expect(moveSection(layout, ALL, ALL, 'incoming', { before: 'nope' })).toBe(layout);
    expect(moveSection(layout, ALL, ALL, 'children', { before: 'incoming' })).toBe(layout);
    expect(moveSection(layout, ALL, ['incoming'], 'children', 'down')).toBe(layout);
  });

  it('keeps the folded sections', () => {
    const layout = toggleSection(DEFAULT_PANEL_LAYOUT, 'incoming');
    expect(moveSection(layout, ALL, ALL, 'workitems', 'up').collapsed).toEqual(['incoming']);
  });
});

describe('toggleSection', () => {
  it('folds and unfolds', () => {
    const folded = toggleSection(toggleSection(DEFAULT_PANEL_LAYOUT, 'workitems'), 'children');
    expect(folded.collapsed).toEqual(['children', 'workitems']);
    expect(isSectionCollapsed(folded, 'children')).toBe(true);
    expect(isSectionCollapsed(folded, 'incoming')).toBe(false);
    expect(toggleSection(folded, 'children').collapsed).toEqual(['workitems']);
  });
});

describe('stored panel layout', () => {
  it('round-trips, and anything invalid gives the default', () => {
    const layout: PanelLayout = { order: ['workitems', 'children'], collapsed: ['incoming'] };
    expect(parsePanelLayout(serializePanelLayout(layout))).toEqual(layout);
    for (const text of [null, undefined, '', 'nope', '3', '[]', '{"order":3}', '{}']) {
      expect(parsePanelLayout(text)).toBe(DEFAULT_PANEL_LAYOUT);
    }
    expect(parsePanelLayout('{"order":["a",1,"a",""],"collapsed":["b","b"]}')).toEqual({
      order: ['a'],
      collapsed: ['b'],
    });
  });

  it('reads and writes through a storage, and survives one that throws or is missing', () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    const layout: PanelLayout = { order: ['workitems'], collapsed: ['outgoing'] };
    writePanelLayout(storage, layout);
    expect(items.has(PANEL_LAYOUT_KEY)).toBe(true);
    expect(readPanelLayout(storage)).toEqual(layout);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(readPanelLayout(broken)).toBe(DEFAULT_PANEL_LAYOUT);
    expect(() => writePanelLayout(broken, layout)).not.toThrow();
    expect(readPanelLayout(undefined)).toBe(DEFAULT_PANEL_LAYOUT);
  });
});
