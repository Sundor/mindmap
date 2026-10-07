// Node search.

import { describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import { parseOk } from './layout/test-helpers';
import { dropdownOffset, moveActiveIndex, searchNodes } from './search';

const model = parseOk(`
version: 1
domains:
  - id: data
    name: Data
    components:
      - id: data.store
        name: Data Store
        subcomponents:
          - id: data.store.meta
            name: Metadata
      - id: data.api
        name: Query API
  - id: ops
    name: Operations
    components:
      - id: ops.update
        name: Update Service
      - id: ops.data-export
        name: Exporter
`);

const ids = (query: string): string[] => searchNodes(model, query).map((match) => match.id);

describe('searchNodes', () => {
  it('returns nothing for an empty or blank query', () => {
    expect(searchNodes(model, '')).toEqual([]);
    expect(searchNodes(model, '   ')).toEqual([]);
  });

  it('matches names and IDs as case-insensitive substrings', () => {
    expect(ids('QUERY')).toEqual(['data.api']);
    expect(ids('ops.up')).toEqual(['ops.update']);
    expect(ids('port')).toEqual(['ops.data-export']);
    expect(ids('zzz')).toEqual([]);
  });

  it('ignores white space around the query', () => {
    expect(ids('  query ')).toEqual(['data.api']);
  });

  it('ranks exact matches first, then prefixes, then word starts, then the rest', () => {
    const matches = searchNodes(model, 'data');
    expect(matches.map((m) => [m.id, m.rank])).toEqual([
      ['data', 0], // exact (name and ID)
      ['data.store', 1], // name "Data Store" and ID start with it
      ['data.store.meta', 1], // ID starts with it
      ['data.api', 1],
      ['ops.data-export', 2], // an ID segment starts with it
    ]);
    // "Metadata" merely contains "tada"; "Update" merely contains "pdat".
    expect(searchNodes(model, 'tada').map((m) => m.rank)).toEqual([3]);
    expect(searchNodes(model, 'pdat').map((m) => [m.id, m.rank])).toEqual([['ops.update', 3]]);
  });

  it('counts a later word of the name, and a later segment of the ID, as a word start', () => {
    expect(searchNodes(model, 'store').map((m) => [m.id, m.rank])).toEqual([
      ['data.store', 2],
      ['data.store.meta', 2],
    ]);
    expect(searchNodes(model, 'export').map((m) => [m.id, m.rank])).toEqual([
      ['ops.data-export', 1], // name "Exporter" starts with it
    ]);
  });

  it('takes the better of the name rank and the ID rank', () => {
    // ID "ops" is exact although the name "Operations" is not a match at all.
    expect(searchNodes(model, 'ops')[0]).toEqual({
      id: 'ops',
      name: 'Operations',
      level: 0,
      rank: 0,
    });
  });

  it('keeps document order within a rank and gives the same result every time', () => {
    const first = ids('a');
    expect(ids('a')).toEqual(first);
    const order = [...model.nodes.keys()];
    const matches = searchNodes(model, 'a');
    for (let i = 1; i < matches.length; i++) {
      const previous = matches[i - 1];
      const current = matches[i];
      if (!previous || !current) continue;
      expect(previous.rank).toBeLessThanOrEqual(current.rank);
      if (previous.rank === current.rank) {
        expect(order.indexOf(previous.id)).toBeLessThan(order.indexOf(current.id));
      }
    }
  });

  it('finds nodes of the shipped example by name and by ID', () => {
    const example = parseOk(exampleYaml);
    expect(searchNodes(example, 'iphone')[0]?.id).toBe('storefront.apps.ios');
    expect(searchNodes(example, 'storefront.web')[0]?.id).toBe('storefront.web');
    expect(searchNodes(example, 'event st')[0]?.id).toBe('data.event-store');
  });
});

describe('moveActiveIndex', () => {
  it('steps through the results and wraps around', () => {
    expect(moveActiveIndex(0, 1, 3)).toBe(1);
    expect(moveActiveIndex(2, 1, 3)).toBe(0);
    expect(moveActiveIndex(0, -1, 3)).toBe(2);
  });

  it('starts at the first (down) or last (up) result when none is active', () => {
    expect(moveActiveIndex(-1, 1, 3)).toBe(0);
    expect(moveActiveIndex(-1, -1, 3)).toBe(2);
  });

  it('gives -1 when there are no results', () => {
    expect(moveActiveIndex(0, 1, 0)).toBe(-1);
  });
});

describe('dropdownOffset', () => {
  const width = 384;

  it('starts the list at the left edge of the box where there is room', () => {
    // Search box beside the rail of the control panel: the list hangs over the canvas.
    const anchorLeft = 68;
    for (const viewport of [1836, 1366, 520, 460]) {
      expect(dropdownOffset(anchorLeft, width, viewport)).toBe(0);
      expect(anchorLeft + width).toBeLessThanOrEqual(viewport - 8);
    }
  });

  it('pulls the list back from the right window edge', () => {
    const anchorLeft = 300;
    const left = anchorLeft + dropdownOffset(anchorLeft, width, 500, 8);
    expect(left).toBe(500 - 8 - width);
    // Beside the rail, in a window too narrow for the list to start at the box.
    expect(68 + dropdownOffset(68, width, 420)).toBe(420 - 8 - width);
  });

  it('starts a list wider than the window at the left margin', () => {
    expect(dropdownOffset(68, width, 300, 8)).toBe(8 - 68);
  });

  it('stays at a box at the far left, and never goes left of the margin', () => {
    for (const viewport of [900, 800, 520]) {
      expect(dropdownOffset(16, width, viewport)).toBe(0);
    }
    expect(dropdownOffset(0, width, 1024)).toBe(8);
  });
});
