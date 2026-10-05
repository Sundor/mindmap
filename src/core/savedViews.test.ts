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

  it('survives names and values outside ASCII', () => {
    const odd = { ...view, name: 'Übersicht', colorBy: 'metric:größe' };
    expect(viewFromLinkHash(viewLinkHash(odd), model)?.colorBy).toBe('metric:größe');
  });
});
