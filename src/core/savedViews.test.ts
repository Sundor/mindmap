import { describe, expect, it } from 'vitest';
import {
  centerToViewport,
  parseSavedView,
  parseSavedViews,
  readSavedViews,
  serializeSavedViews,
  VIEW_NAME_MAX,
  viewFromLinkHash,
  viewLinkHash,
  viewportToCenter,
  VIEWS_MAX,
  withoutSavedView,
  withSavedView,
  writeSavedViews,
  type SavedView,
} from './index';
import { parseOk } from './layout/test-helpers';

const model = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - { id: a.x, name: X }
  - id: b
    name: Beta
edges:
  - { id: e, from: a.x, to: b, kind: dataflow }
flows:
  - { id: f, name: F, edges: [e] }
`);

const view: SavedView = {
  name: 'Data path',
  collapsed: ['a'],
  hiddenKinds: ['control'],
  lodMode: 'components',
  center: { x: 120.5, y: 80, zoom: 0.75 },
  focus: { type: 'flow', id: 'f' },
  colorBy: 'owner',
  storyMode: 'off',
};

describe('view centre', () => {
  it('round-trips through the viewport for a canvas size', () => {
    const size = { width: 1000, height: 600 };
    const viewport = centerToViewport(view.center, size);
    expect(viewportToCenter(viewport, size)).toEqual(view.center);
    // The same centre on another canvas: still in the middle.
    const other = centerToViewport(view.center, { width: 400, height: 300 });
    expect((200 - other.x) / other.zoom).toBeCloseTo(120.5);
  });
});

describe('parseSavedView', () => {
  it('keeps a valid view and drops what the model does not have', () => {
    expect(parseSavedView(JSON.parse(JSON.stringify(view)), model)).toEqual(view);
    const parsed = parseSavedView(
      {
        name: ' x '.padEnd(VIEW_NAME_MAX + 20, 'y'),
        collapsed: ['a', 'a.x', 'nope', 7],
        hiddenKinds: ['control', 'control', 'nope'],
        lodMode: 'loop',
        center: { x: 1, y: 2, zoom: 1 },
        focus: { type: 'flow', id: 'other' },
        colorBy: 'none',
        storyMode: 'all',
      },
      model,
    );
    expect(parsed).toEqual({
      name: expect.stringMatching(/^x y+$/),
      collapsed: ['a'],
      hiddenKinds: ['control'],
      lodMode: 'auto',
      center: { x: 1, y: 2, zoom: 1 },
    });
    expect(parsed?.name).toHaveLength(VIEW_NAME_MAX);
  });

  it('refuses anything without a usable centre', () => {
    for (const bad of [
      null,
      [],
      'view',
      { name: 'n' },
      { name: 'n', center: { x: 1, y: 2 } },
      { name: 'n', center: { x: 1, y: 2, zoom: 0 } },
      { name: 'n', center: { x: Infinity, y: 2, zoom: 1 } },
      { name: 'n', center: { x: '1', y: 2, zoom: 1 } },
    ]) {
      expect(parseSavedView(bad, model)).toBeUndefined();
    }
  });

  it('keeps a work-item focus (the items may arrive later), but only a plausible one', () => {
    const base = { name: 'n', center: { x: 0, y: 0, zoom: 1 } };
    expect(
      parseSavedView({ ...base, focus: { type: 'workitem', id: 1010 } }, model)?.focus,
    ).toEqual({ type: 'workitem', id: 1010 });
    expect(
      parseSavedView({ ...base, focus: { type: 'workitem', id: -1 } }, model)?.focus,
    ).toBeUndefined();
  });

  it('keeps the focus mode only when it is "filter"', () => {
    const base = { name: 'n', center: { x: 0, y: 0, zoom: 1 } };
    const flow = { type: 'flow', id: 'f' };
    expect(parseSavedView({ ...base, focus: flow, focusMode: 'filter' }, model)).toEqual({
      ...base,
      collapsed: [],
      hiddenKinds: [],
      lodMode: 'auto',
      focus: flow,
      focusMode: 'filter',
    });
    expect(
      parseSavedView({ ...base, focus: { type: 'workitem', id: 7 }, focusMode: 'filter' }, model)
        ?.focusMode,
    ).toBe('filter');
    for (const junk of ['focus', 'Filter', '', true, 1, null, ['filter']]) {
      const parsed = parseSavedView({ ...base, focus: flow, focusMode: junk }, model);
      expect(parsed?.focus).toEqual(flow);
      expect(parsed && 'focusMode' in parsed).toBe(false);
    }
  });

  it('keeps the mark of a closed-up map only when it is true', () => {
    const base = { name: 'n', center: { x: 0, y: 0, zoom: 1 } };
    expect(parseSavedView({ ...base, closeGaps: true }, model)?.closeGaps).toBe(true);
    for (const junk of [false, 'true', 1, null, {}]) {
      const parsed = parseSavedView({ ...base, closeGaps: junk }, model);
      expect(parsed && 'closeGaps' in parsed).toBe(false);
    }
    const plain = parseSavedView(base, model);
    expect(plain && 'closeGaps' in plain).toBe(false);
  });

  it('keeps the focus mode of a view whose focus is dropped: its centre is no place on the whole map', () => {
    const base = { name: 'n', center: { x: 296, y: 208, zoom: 1.5 } };
    // No focus, a flow the model does not have, an implausible work item.
    for (const focus of [undefined, { type: 'flow', id: 'other' }, { type: 'workitem', id: 0 }]) {
      const parsed = parseSavedView({ ...base, focus, focusMode: 'filter' }, model);
      expect(parsed && 'focus' in parsed).toBe(false);
      expect(parsed?.focusMode).toBe('filter');
      expect(parsed?.center).toEqual(base.center);
    }
    // A view of the whole map whose focus is dropped stays one of the whole map.
    const whole = parseSavedView({ ...base, focus: { type: 'flow', id: 'other' } }, model);
    expect(whole && 'focus' in whole).toBe(false);
    expect(whole && 'focusMode' in whole).toBe(false);
  });
});

describe('stored list', () => {
  it('round-trips, skips broken entries and keeps the newest', () => {
    const text = serializeSavedViews([view, { ...view, name: 'Second' }]);
    expect(parseSavedViews(text, model)).toEqual([view, { ...view, name: 'Second' }]);
    expect(
      parseSavedViews('[1, {"name":"","center":{"x":0,"y":0,"zoom":1}}, null]', model),
    ).toEqual([]);
    expect(parseSavedViews('nope', model)).toEqual([]);
    const many = Array.from({ length: VIEWS_MAX + 5 }, (_, i) => ({ ...view, name: `v${i}` }));
    expect(parseSavedViews(serializeSavedViews(many), model).map((v) => v.name)[0]).toBe('v5');
  });

  it('stores a view of the whole map without a focus mode, and one of a filtered map with it', () => {
    const text =
      '[{"name":"Data path","collapsed":["a"],"hiddenKinds":["control"],"lodMode":"components",' +
      '"center":{"x":120.5,"y":80,"zoom":0.75},"focus":{"type":"flow","id":"f"},' +
      '"colorBy":"owner","storyMode":"off"}]';
    expect(serializeSavedViews([view])).toBe(text);
    expect(serializeSavedViews(parseSavedViews(text, model))).toBe(text);
    const filtered: SavedView = { ...view, focusMode: 'filter' };
    expect(parseSavedViews(serializeSavedViews([view, filtered]), model)).toEqual([view, filtered]);
  });

  it('stores the mark of a closed-up map with the view', () => {
    const closed: SavedView = { ...view, closeGaps: true };
    expect(parseSavedViews(serializeSavedViews([view, closed]), model)).toEqual([view, closed]);
    expect(serializeSavedViews([view])).not.toContain('closeGaps');
  });

  it('keeps the mark of a filtered map through being read and stored again without its focus', () => {
    // Saved on the map filtered to a flow that the structure has lost since.
    const lost: SavedView = { ...view, focus: { type: 'flow', id: 'gone' }, focusMode: 'filter' };
    const read = parseSavedViews(serializeSavedViews([lost]), model);
    expect(read).toHaveLength(1);
    expect(read[0] && 'focus' in read[0]).toBe(false);
    expect(read[0]?.focusMode).toBe('filter');
    expect(read[0]?.center).toEqual(view.center);
    // The list is stored as it was read whenever a view is added or deleted.
    expect(parseSavedViews(serializeSavedViews(read), model)).toEqual(read);
  });

  it('adds by name, replacing, and removes', () => {
    const views = withSavedView([view], { ...view, name: 'Second' });
    expect(views.map((v) => v.name)).toEqual(['Data path', 'Second']);
    expect(
      withSavedView(views, { ...view, lodMode: 'auto' }).map((v) => [v.name, v.lodMode]),
    ).toEqual([
      ['Second', 'components'],
      ['Data path', 'auto'],
    ]);
    expect(withoutSavedView(views, 'Second')).toEqual([view]);
  });

  it('reads and writes through a storage that may throw', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    writeSavedViews(storage, model, [view]);
    expect(readSavedViews(storage, model)).toEqual([view]);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    expect(() => writeSavedViews(broken, model, [view])).not.toThrow();
    expect(readSavedViews(broken, model)).toEqual([]);
    expect(readSavedViews(undefined, model)).toEqual([]);
  });
});

describe('links', () => {
  it('carries a view in the fragment, without its name, and reads it back', () => {
    const hash = viewLinkHash(view);
    expect(hash).toMatch(/^#view=[A-Za-z0-9_-]+$/);
    const linked = viewFromLinkHash(hash, model);
    expect(linked).toEqual({ ...view, name: 'Linked view' });
    expect(viewFromLinkHash('', model)).toBeUndefined();
    expect(viewFromLinkHash('#view=%%%', model)).toBeUndefined();
    expect(viewFromLinkHash('#view=bm9wZQ', model)).toBeUndefined(); // "nope"
    expect(viewFromLinkHash('#other=1', model)).toBeUndefined();
  });

  it('writes a view of the whole map as one fixed text, and reads that text back', () => {
    const hash =
      '#view=eyJjb2xsYXBzZWQiOlsiYSJdLCJoaWRkZW5LaW5kcyI6WyJjb250cm9sIl0sImxvZE1vZGUiOiJjb21wb25l' +
      'bnRzIiwiY2VudGVyIjp7IngiOjEyMC41LCJ5Ijo4MCwiem9vbSI6MC43NX0sImZvY3VzIjp7InR5cGUiOiJmbG93Iiwi' +
      'aWQiOiJmIn0sImNvbG9yQnkiOiJvd25lciIsInN0b3J5TW9kZSI6Im9mZiJ9';
    expect(viewLinkHash(view)).toBe(hash);
    expect(viewFromLinkHash(hash, model)).toEqual({ ...view, name: 'Linked view' });
  });

  it('carries the focus mode of a filtered map', () => {
    const filtered: SavedView = { ...view, focusMode: 'filter' };
    const hash = viewLinkHash(filtered);
    expect(hash).not.toBe(viewLinkHash(view));
    expect(viewFromLinkHash(hash, model)).toEqual({ ...filtered, name: 'Linked view' });
  });

  it('carries the mark of a closed-up map', () => {
    const closed: SavedView = { ...view, closeGaps: true };
    const hash = viewLinkHash(closed);
    expect(hash).not.toBe(viewLinkHash(view));
    expect(viewFromLinkHash(hash, model)).toEqual({ ...closed, name: 'Linked view' });
  });

  it('carries the focus mode to a structure that does not have the flow', () => {
    const elsewhere: SavedView = {
      ...view,
      focus: { type: 'flow', id: 'gone' },
      focusMode: 'filter',
    };
    const linked = viewFromLinkHash(viewLinkHash(elsewhere), model);
    expect(linked && 'focus' in linked).toBe(false);
    expect(linked?.focusMode).toBe('filter');
  });

  it('survives names and values outside ASCII', () => {
    const odd = { ...view, name: 'Übersicht', colorBy: 'metric:größe' };
    expect(viewFromLinkHash(viewLinkHash(odd), model)?.colorBy).toBe('metric:größe');
  });
});
