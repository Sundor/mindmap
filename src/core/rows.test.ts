import { describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import { parseOk } from './layout/test-helpers';
import type { ArchRow } from './model';
import { rowRanges } from './rows';

const ROWS: readonly ArchRow[] = [
  { id: 'top', name: 'Top level' },
  { id: 'mid', name: 'Middle level' },
  { id: 'bot', name: 'Bottom level' },
];

/** A node as `rowRanges` reads it. */
function node(id: string, childIds: string[] = [], effectiveRow?: string) {
  return { id, childIds, effectiveRow };
}

describe('rowRanges', () => {
  it('gives a node with an effective row exactly that row', () => {
    const ranges = rowRanges(ROWS, [
      node('a', ['a.x'], 'mid'),
      node('a.x', [], 'mid'),
      node('b', [], 'top'),
    ]);
    expect(ranges.get('a')).toEqual({ top: 1, bottom: 1 });
    expect(ranges.get('a.x')).toEqual({ top: 1, bottom: 1 });
    expect(ranges.get('b')).toEqual({ top: 0, bottom: 0 });
    // Its own row counts, whatever is below it.
    const own = rowRanges(ROWS, [node('p', ['p.c'], 'top'), node('p.c', [], 'bot')]);
    expect(own.get('p')).toEqual({ top: 0, bottom: 0 });
  });

  it('spans a node without one from the top-most to the bottom-most row used below it', () => {
    const ranges = rowRanges(ROWS, [
      node('g', ['g.m', 'g.s', 'g.free']),
      node('g.m', [], 'mid'),
      node('g.s', ['g.s.b', 'g.s.m']),
      node('g.s.b', [], 'bot'),
      node('g.s.m', [], 'mid'),
      node('g.free'),
      node('h', ['h.t', 'h.b']),
      node('h.t', [], 'top'),
      node('h.b', [], 'bot'),
    ]);
    expect(ranges.get('g.s')).toEqual({ top: 1, bottom: 2 });
    expect(ranges.get('g')).toEqual({ top: 1, bottom: 2 });
    // The row in between counts as occupied too.
    expect(ranges.get('h')).toEqual({ top: 0, bottom: 2 });
    expect(ranges.has('g.free')).toBe(false);
  });

  it('has no entry for a node with no row anywhere in its subtree', () => {
    const nodes = [node('u', ['u.a', 'u.b']), node('u.a', ['u.a.k']), node('u.a.k'), node('u.b')];
    expect(rowRanges(ROWS, nodes).size).toBe(0);
    expect(rowRanges([], [node('a', ['a.x'], 'mid'), node('a.x', [], 'mid')]).size).toBe(0);
    expect(rowRanges(ROWS, []).size).toBe(0);
  });

  it('takes an effective row that is not among the rows as none', () => {
    const ranges = rowRanges(ROWS, [
      node('x', [], 'nope'),
      node('g', ['g.a', 'g.b']),
      node('g.a', [], 'nope'),
      node('g.b', [], 'bot'),
      node('h', ['h.a'], 'nope'),
      node('h.a', [], 'mid'),
    ]);
    expect(ranges.has('x')).toBe(false);
    expect(ranges.has('g.a')).toBe(false);
    expect(ranges.get('g')).toEqual({ top: 2, bottom: 2 });
    expect(ranges.get('h')).toEqual({ top: 1, bottom: 1 });
  });

  it('gives every node of the example the row range the parser gave it', () => {
    const model = parseOk(exampleYaml);
    const ranges = rowRanges(model.rows, model.nodes.values());
    for (const [id, parsed] of model.nodes) expect(ranges.get(id), id).toEqual(parsed.rowRange);
    expect(model.rows.map((row) => row.id)).toEqual(['backoffice', 'middle', 'channels']);
    expect(ranges.get('backoffice')).toEqual({ top: 0, bottom: 0 });
    expect(ranges.get('operations')).toEqual({ top: 0, bottom: 2 });
    expect(ranges.get('data')).toEqual({ top: 0, bottom: 1 });
    expect(ranges.has('operations.alerts')).toBe(false);
    expect(ranges.has('platform')).toBe(false);
  });
});
