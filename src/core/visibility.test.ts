import { describe, expect, it } from 'vitest';
import { parseOk } from './layout/test-helpers';
import type { ArchitectureModel } from './model';
import {
  allGroupCounts,
  COLLAPSED_STORAGE_PREFIX,
  collapsedStorageKey,
  groupIds,
  isClosedGroup,
  LOD_LEVELS,
  parseCollapsed,
  readCollapsed,
  serializeCollapsed,
  structureIdentity,
  visibleNodes,
  writeCollapsed,
  type ViewStateStorage,
} from './visibility';

const YAML = `
version: 1
domains:
  - id: a
    name: A
    components:
      - id: a.x
        name: X
        subcomponents:
          - { id: a.x.p, name: P }
          - { id: a.x.q, name: Q }
      - { id: a.y, name: Y }
  - id: b
    name: B
    components:
      - id: b.m
        name: M
        subcomponents:
          - { id: b.m.s, name: S }
  - { id: c, name: C }
`;
const model: ArchitectureModel = parseOk(YAML);
const ALL = ['a', 'a.x', 'a.x.p', 'a.x.q', 'a.y', 'b', 'b.m', 'b.m.s', 'c'];

function visible(collapsed: string[], lod: (typeof LOD_LEVELS)[number] = 'detail'): string[] {
  return [...visibleNodes(model, new Set(collapsed), lod)];
}

function memoryStorage(): ViewStateStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe('visibleNodes', () => {
  it('shows everything at full detail with nothing collapsed, in document order', () => {
    expect(visible([])).toEqual(ALL);
  });

  it('hides the descendants of a collapsed group; the group itself stays visible', () => {
    expect(visible(['a.x'])).toEqual(['a', 'a.x', 'a.y', 'b', 'b.m', 'b.m.s', 'c']);
    expect(visible(['a'])).toEqual(['a', 'b', 'b.m', 'b.m.s', 'c']);
  });

  it('collapsed ancestor of a collapsed group: the inner one is hidden with the rest', () => {
    expect(visible(['a', 'a.x'])).toEqual(visible(['a']));
    // Expanding the outer one again shows the inner one still collapsed.
    expect(visible(['a.x'])).toContain('a.x');
    expect(visible(['a.x'])).not.toContain('a.x.p');
  });

  it('limits the levels by level of detail', () => {
    expect(visible([], 'domains')).toEqual(['a', 'b', 'c']);
    expect(visible([], 'components')).toEqual(['a', 'a.x', 'a.y', 'b', 'b.m', 'c']);
    expect(visible([], 'detail')).toEqual(ALL);
  });

  it('manual collapse wins over the level of detail', () => {
    expect(visible(['a'], 'detail')).not.toContain('a.x');
    expect(visible(['a'], 'components')).toEqual(['a', 'b', 'b.m', 'c']);
    expect(visible(['a.x'], 'detail')).toEqual(['a', 'a.x', 'a.y', 'b', 'b.m', 'b.m.s', 'c']);
    expect(visible(['a', 'b'], 'domains')).toEqual(['a', 'b', 'c']);
    // A level of detail never shows more than the collapsed set allows.
    for (const lod of LOD_LEVELS) {
      for (const id of visible(['a', 'b.m'], lod)) expect(visible(['a', 'b.m'])).toContain(id);
    }
  });

  it('ignores unknown IDs and IDs of nodes without children', () => {
    expect(visible(['nope', 'c', 'a.y', 'a.x.p'])).toEqual(ALL);
  });

  it('always keeps every domain, and a node only with its parent', () => {
    for (const lod of LOD_LEVELS) {
      for (const collapsed of [[], ['a'], ['a.x', 'b'], groupIds(model)]) {
        const set = visibleNodes(model, new Set(collapsed), lod);
        for (const root of model.rootIds) expect(set.has(root)).toBe(true);
        for (const id of set) {
          const parent = model.nodes.get(id)?.parentId;
          if (parent !== undefined) {
            expect(set.has(parent)).toBe(true);
            expect(collapsed).not.toContain(parent);
          }
        }
      }
    }
  });
});

describe('groups and counts', () => {
  it('lists the collapsible nodes in document order', () => {
    expect(groupIds(model)).toEqual(['a', 'a.x', 'b', 'b.m']);
  });

  it('tells which groups are drawn closed', () => {
    const collapsed = visibleNodes(model, new Set(['a.x']), 'detail');
    expect(isClosedGroup(model, collapsed, 'a.x')).toBe(true);
    expect(isClosedGroup(model, collapsed, 'a')).toBe(false);
    expect(isClosedGroup(model, collapsed, 'a.y')).toBe(false); // a leaf is not a group
    expect(isClosedGroup(model, collapsed, 'a.x.p')).toBe(false); // hidden
    // Closed by the level of detail, without being collapsed by hand.
    const domains = visibleNodes(model, new Set(), 'domains');
    expect(isClosedGroup(model, domains, 'a')).toBe(true);
    expect(isClosedGroup(model, domains, 'c')).toBe(false);
  });

  it('counts direct children and all descendants of every node, leaving the work-item slots empty', () => {
    const all = allGroupCounts(model);
    expect([...all.keys()]).toEqual(ALL);
    expect(all.get('a')).toEqual({ children: 2, descendants: 4 });
    expect(all.get('a.x')).toEqual({ children: 2, descendants: 2 });
    expect(all.get('b')).toEqual({ children: 1, descendants: 2 });
    expect(all.get('c')).toEqual({ children: 0, descendants: 0 });
    expect(all.get('nope')).toBeUndefined();
    for (const id of ALL) {
      expect(all.get(id)?.stories).toBeUndefined();
      expect(all.get(id)?.openBugs).toBeUndefined();
    }
  });
});

describe('persisted collapsed set', () => {
  it('round-trips through its stored form, sorted', () => {
    const text = serializeCollapsed(new Set(['b.m', 'a']));
    expect(text).toBe('["a","b.m"]');
    expect([...parseCollapsed(text, model)].sort()).toEqual(['a', 'b.m']);
  });

  it('ignores unknown IDs, nodes without children and non-strings', () => {
    const text = JSON.stringify(['a.x', 'gone', 'c', 'a.x.p', 7, null, { id: 'a' }]);
    expect([...parseCollapsed(text, model)]).toEqual(['a.x']);
  });

  it('treats anything that is not a JSON array as empty', () => {
    for (const text of [null, undefined, '', 'not json', '{"a":true}', '"a"', '42']) {
      expect(parseCollapsed(text, model).size).toBe(0);
    }
  });

  it('keys the entry by the structure, so another file does not inherit it', () => {
    const other = parseOk(`
version: 1
domains:
  - id: a
    name: A
    components:
      - { id: a.x, name: X }
  - { id: z, name: Z }
`);
    expect(collapsedStorageKey(model)).toBe(
      `${COLLAPSED_STORAGE_PREFIX}${structureIdentity(model)}`,
    );
    expect(collapsedStorageKey(other)).not.toBe(collapsedStorageKey(model));
    // An edited version of the same structure (same domains) keeps its state.
    const edited = parseOk(YAML.replace('name: Y }', 'name: Renamed }'));
    expect(collapsedStorageKey(edited)).toBe(collapsedStorageKey(model));

    const storage = memoryStorage();
    expect(writeCollapsed(storage, model, new Set(['a', 'a.x']))).toBe(true);
    expect([...readCollapsed(storage, model)]).toEqual(['a', 'a.x']);
    expect(readCollapsed(storage, other).size).toBe(0);
    expect([...readCollapsed(storage, edited)]).toEqual(['a', 'a.x']);
  });

  it('works without storage and survives a storage that throws', () => {
    expect(readCollapsed(undefined, model).size).toBe(0);
    expect(writeCollapsed(undefined, model, new Set(['a']))).toBe(false);
    const broken: ViewStateStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readCollapsed(broken, model).size).toBe(0);
    expect(writeCollapsed(broken, model, new Set(['a']))).toBe(false);
    const corrupt = memoryStorage();
    corrupt.data.set(collapsedStorageKey(model), '{oops');
    expect(readCollapsed(corrupt, model).size).toBe(0);
  });
});
