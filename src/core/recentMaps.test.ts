import { describe, expect, it } from 'vitest';
import { parseArchitecture } from './parse';
import {
  MAX_RECENT_MAPS,
  recentMapHint,
  recentMapLabel,
  sanitizeRecentMaps,
  withoutRecentMap,
  withRecentHint,
  withRecentMap,
  withRecentWorkItems,
  type RecentMap,
} from './recentMaps';

/** A stand-in for the browser's reference to a file. */
interface Handle {
  readonly path: string;
}
const isHandle = (value: unknown): value is Handle =>
  typeof value === 'object' && value !== null && 'path' in value;

function map(id: string, openedAt = 0, workItems = false): RecentMap<Handle> {
  return {
    id,
    structure: { name: `${id}.yaml`, handle: { path: `/maps/${id}.yaml` } },
    ...(workItems
      ? { workItems: { name: `${id}.json`, handle: { path: `/maps/${id}.json` } } }
      : {}),
    hint: `hint of ${id}`,
    openedAt,
  };
}
const ids = (list: readonly RecentMap<Handle>[]) => list.map((entry) => entry.id);

describe('withRecentMap', () => {
  it('puts the map first', () => {
    expect(ids(withRecentMap([map('a'), map('b')], map('c')))).toEqual(['c', 'a', 'b']);
  });

  it('moves a map that is in the list to the front, in its new form', () => {
    const list = withRecentMap([map('a'), map('b'), map('c')], map('b', 7, true));
    expect(ids(list)).toEqual(['b', 'a', 'c']);
    expect(list[0]).toMatchObject({ openedAt: 7, workItems: { name: 'b.json' } });
  });

  it('keeps the latest maps only', () => {
    const many = Array.from({ length: MAX_RECENT_MAPS }, (_, index) => map(`m${index}`));
    const list = withRecentMap(many, map('new'));
    expect(list).toHaveLength(MAX_RECENT_MAPS);
    expect(list[0]?.id).toBe('new');
    expect(ids(list)).not.toContain(`m${MAX_RECENT_MAPS - 1}`);
    expect(ids(withRecentMap([map('a'), map('b')], map('c'), 2))).toEqual(['c', 'a']);
    expect(withRecentMap([map('a')], map('c'), 0)).toEqual([]);
  });

  it('leaves the list it was given as it is', () => {
    const list = [map('a'), map('b')];
    withRecentMap(list, map('b'));
    expect(ids(list)).toEqual(['a', 'b']);
  });
});

describe('withoutRecentMap', () => {
  it('forgets one map', () => {
    expect(ids(withoutRecentMap([map('a'), map('b'), map('c')], 'b'))).toEqual(['a', 'c']);
    expect(ids(withoutRecentMap([map('a')], 'x'))).toEqual(['a']);
  });
});

describe('withRecentWorkItems', () => {
  it('gives a map its work items without moving it', () => {
    const file = { name: 'sprint.json', handle: { path: '/work/sprint.json' } };
    const list = withRecentWorkItems([map('a'), map('b', 3, true)], 'b', file);
    expect(ids(list)).toEqual(['a', 'b']);
    expect(list[1]).toMatchObject({ openedAt: 3, workItems: file });
    expect(list[0]?.workItems).toBeUndefined();
  });

  it('is the same list when the map is not in it', () => {
    const list = [map('a')];
    expect(withRecentWorkItems(list, 'x', { name: 'w.json', handle: { path: '/w' } })).toBe(list);
  });
});

describe('withRecentHint', () => {
  it('sets the hint of one map, and is the same list when nothing changes', () => {
    const list = [map('a'), map('b')];
    expect(withRecentHint(list, 'b', 'Shop, Store')[1]?.hint).toBe('Shop, Store');
    expect(withRecentHint(list, 'b', 'hint of b')).toBe(list);
    expect(withRecentHint(list, 'x', 'new')).toBe(list);
  });
});

describe('recentMapLabel', () => {
  it('names the files of the map', () => {
    expect(recentMapLabel(map('store'))).toBe('store.yaml');
    expect(recentMapLabel(map('store', 0, true))).toBe('store.yaml + store.json');
  });
});

describe('recentMapHint', () => {
  const model = (domains: string[]) =>
    parseArchitecture(
      `version: 1\ndomains:\n${domains.map((name, index) => `  - id: d${index}\n    name: ${name}\n`).join('')}`,
    ).model ?? undefined;

  it('names the first domains', () => {
    expect(recentMapHint(model(['Shop', 'Store']))).toBe('Shop, Store');
    expect(recentMapHint(model(['Shop', 'Store', 'Cloud']))).toBe('Shop, Store, Cloud');
    expect(recentMapHint(model(['Shop', 'Store', 'Cloud', 'Edge']))).toBe('Shop, Store, Cloud …');
  });

  it('is empty without a model or without domains', () => {
    expect(recentMapHint(undefined)).toBe('');
    expect(recentMapHint(parseArchitecture('version: 1\ndomains: []\n').model ?? undefined)).toBe(
      '',
    );
  });
});

describe('sanitizeRecentMaps', () => {
  it('takes back what was stored, latest first', () => {
    const stored = [map('old', 1), map('new', 9, true), map('mid', 5)];
    expect(sanitizeRecentMaps(stored, isHandle)).toEqual([
      map('new', 9, true),
      map('mid', 5),
      map('old', 1),
    ]);
  });

  it('is empty for anything that is not a list', () => {
    for (const value of [undefined, null, 'x', 7, { 0: map('a') }]) {
      expect(sanitizeRecentMaps(value, isHandle)).toEqual([]);
    }
  });

  it('leaves out entries that are not whole, and repeats', () => {
    const whole = map('a', 4);
    const stored = [
      whole,
      { ...map('a', 9), hint: 'the same ID again' },
      { ...map('b'), id: 7 },
      { ...map('c'), structure: { name: 'c.yaml' } },
      { ...map('d'), structure: { name: 'd.yaml', handle: 'not a reference' } },
      { ...map('e'), structure: undefined },
      null,
      'text',
    ];
    expect(sanitizeRecentMaps(stored, isHandle)).toEqual([whole]);
  });

  it('mends what can be mended: work items, hint and time', () => {
    const stored = [
      { ...map('a'), workItems: { name: 'a.json', handle: 5 }, hint: 3, openedAt: 'yesterday' },
      { ...map('b', 2), openedAt: Number.NaN },
    ];
    expect(sanitizeRecentMaps(stored, isHandle)).toEqual([
      { id: 'a', structure: map('a').structure, hint: '', openedAt: 0 },
      { id: 'b', structure: map('b').structure, hint: 'hint of b', openedAt: 0 },
    ]);
  });

  it('is no longer than allowed', () => {
    const stored = Array.from({ length: 12 }, (_, index) => map(`m${index}`, index));
    const list = sanitizeRecentMaps(stored, isHandle);
    expect(list).toHaveLength(MAX_RECENT_MAPS);
    expect(list[0]?.id).toBe('m11');
    expect(sanitizeRecentMaps(stored, isHandle, 2).map((entry) => entry.id)).toEqual([
      'm11',
      'm10',
    ]);
  });
});
