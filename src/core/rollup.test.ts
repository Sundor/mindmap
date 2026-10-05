import { describe, expect, it } from 'vitest';
import { parseOk } from './layout/test-helpers';
import type { ArchitectureModel } from './model';
import { aggregateEdgeId, nearestVisible, rollupEdges, type AggregateEdge } from './rollup';
import { groupIds, LOD_LEVELS, visibleNodes } from './visibility';

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
      - { id: b.n, name: N }
  - { id: c, name: C }
edges:
  - { id: pq, from: a.x.p, to: a.x.q, kind: dataflow, label: inner }
  - { id: py, from: a.x.p, to: a.y, kind: dataflow, label: to y, protocol: HTTP }
  - { id: qy, from: a.x.q, to: a.y, kind: dataflow }
  - { id: ps, from: a.x.p, to: b.m.s, kind: dataflow, label: across }
  - { id: qn, from: a.x.q, to: b.n, kind: dataflow }
  - { id: sp, from: b.m.s, to: a.x.p, kind: dataflow }
  - { id: yn, from: a.y, to: b.n, kind: control }
  - { id: ac, from: a, to: c, kind: config }
  - { id: pa, from: a.x.p, to: a, kind: dependency }
`;

const model: ArchitectureModel = parseOk(YAML);

function rollup(...collapsed: string[]): AggregateEdge[] {
  return rollupEdges(model, visibleNodes(model, new Set(collapsed), 'detail'));
}

/** `source>target:kind ×count [members]`, one line per aggregate. */
function summary(aggregates: readonly AggregateEdge[]): string[] {
  return aggregates.map(
    (a) => `${a.source}>${a.target}:${a.kind} ×${a.count} [${a.memberEdgeIds.join(',')}]`,
  );
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every single group, all groups, none, and deterministic pseudo-random subsets. */
function collapsedSets(m: ArchitectureModel): Set<string>[] {
  const groups = groupIds(m);
  const sets: Set<string>[] = [new Set(), new Set(groups), ...groups.map((id) => new Set([id]))];
  const random = mulberry32(42);
  for (let i = 0; i < 40; i++) sets.push(new Set(groups.filter(() => random() < 0.4)));
  return sets;
}

describe('nearestVisible', () => {
  it('is the node itself when visible, otherwise its nearest visible ancestor', () => {
    const visible = visibleNodes(model, new Set(['a.x']), 'detail');
    expect(nearestVisible(model, visible, 'a.y')).toBe('a.y');
    expect(nearestVisible(model, visible, 'a.x.p')).toBe('a.x');
    expect(nearestVisible(model, visibleNodes(model, new Set(['a']), 'detail'), 'a.x.p')).toBe('a');
    expect(nearestVisible(model, new Set(), 'a.x.p')).toBeUndefined();
  });
});

describe('rollupEdges', () => {
  it('fully expanded: one aggregate per edge, carrying the original edge, in document order', () => {
    const aggregates = rollup();
    expect(aggregates.map((a) => a.memberEdgeIds)).toEqual(model.edges.map((e) => [e.id]));
    for (const [index, aggregate] of aggregates.entries()) {
      const edge = model.edges[index];
      expect(aggregate.count).toBe(1);
      expect(aggregate.edge).toBe(edge);
      expect(aggregate).toMatchObject({ source: edge?.from, target: edge?.to, kind: edge?.kind });
    }
    expect(aggregates.find((a) => a.memberEdgeIds[0] === 'py')?.edge).toMatchObject({
      label: 'to y',
      protocol: 'HTTP',
    });
  });

  it('derives a stable ID from source, target and kind', () => {
    for (const aggregate of [...rollup(), ...rollup('a', 'b'), ...rollup('a.x')]) {
      expect(aggregate.id).toBe(
        aggregateEdgeId(aggregate.source, aggregate.target, aggregate.kind),
      );
    }
    expect(aggregateEdgeId('a', 'b', 'dataflow')).toBe('a>b:dataflow');
    // The same aggregate keeps its ID whatever else is collapsed.
    const id = aggregateEdgeId('a.y', 'b.n', 'control');
    expect(rollup().some((a) => a.id === id)).toBe(true);
    expect(rollup('a.x', 'b.m').some((a) => a.id === id)).toBe(true);
    for (const collapsed of collapsedSets(model)) {
      const ids = rollupEdges(model, visibleNodes(model, collapsed, 'detail')).map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('drops edges between siblings inside a collapsed group', () => {
    const aggregates = rollup('a.x');
    expect(aggregates.flatMap((a) => a.memberEdgeIds)).not.toContain('pq');
    expect(aggregates.some((a) => a.source === a.target)).toBe(false);
  });

  it('re-attaches the ends to the collapsed group and merges same-kind edges', () => {
    expect(summary(rollup('a.x'))).toEqual([
      'a.x>a.y:dataflow ×2 [py,qy]',
      'a.x>b.m.s:dataflow ×1 [ps]',
      'a.x>b.n:dataflow ×1 [qn]',
      'b.m.s>a.x:dataflow ×1 [sp]',
      'a.y>b.n:control ×1 [yn]',
      'a>c:config ×1 [ac]',
      'a.x>a:dependency ×1 [pa]',
    ]);
  });

  it('count === 1 carries the original edge, aggregates do not', () => {
    const aggregates = rollup('a.x');
    const single = aggregates.find((a) => a.memberEdgeIds[0] === 'ps');
    expect(single?.edge).toBe(model.edges.find((e) => e.id === 'ps'));
    expect(single?.edge?.label).toBe('across');
    const merged = aggregates.find((a) => a.count === 2);
    expect(merged?.memberEdgeIds).toEqual(['py', 'qy']);
    expect(merged && 'edge' in merged).toBe(false);
  });

  it('nested collapse: the outer collapsed group takes over, whatever is collapsed inside', () => {
    const expected = [
      'a>b.m.s:dataflow ×1 [ps]',
      'a>b.n:dataflow ×1 [qn]',
      'b.m.s>a:dataflow ×1 [sp]',
      'a>b.n:control ×1 [yn]',
      'a>c:config ×1 [ac]',
    ];
    expect(summary(rollup('a'))).toEqual(expected);
    // Collapsed ancestor of a collapsed group: same result.
    expect(summary(rollup('a', 'a.x'))).toEqual(expected);
    // Everything inside `a`, including the edge to its own ancestor, is dropped.
    const members = rollup('a').flatMap((a) => a.memberEdgeIds);
    for (const dropped of ['pq', 'py', 'qy', 'pa']) expect(members).not.toContain(dropped);
  });

  it('edges crossing two collapsed groups join them, one aggregate per direction and kind', () => {
    expect(summary(rollup('a', 'b'))).toEqual([
      'a>b:dataflow ×2 [ps,qn]',
      'b>a:dataflow ×1 [sp]',
      'a>b:control ×1 [yn]',
      'a>c:config ×1 [ac]',
    ]);
  });

  it('mixed kinds between the same pair give two aggregates', () => {
    const between = rollup('a', 'b').filter((a) => a.source === 'a' && a.target === 'b');
    expect(between.map((a) => [a.kind, a.count])).toEqual([
      ['dataflow', 2],
      ['control', 1],
    ]);
  });

  it('preserves direction: A→B and B→A are separate aggregates', () => {
    const aggregates = rollup('a', 'b');
    const forward = aggregates.find((a) => a.id === 'a>b:dataflow');
    const backward = aggregates.find((a) => a.id === 'b>a:dataflow');
    expect(forward?.memberEdgeIds).toEqual(['ps', 'qn']);
    expect(backward?.memberEdgeIds).toEqual(['sp']);
    expect(backward?.edge?.id).toBe('sp');
  });

  it('a collapsed group on one side only: the other end keeps its own node', () => {
    expect(summary(rollup('b.m'))).toContain('a.x.p>b.m:dataflow ×1 [ps]');
    expect(summary(rollup('b.m'))).toContain('b.m>a.x.p:dataflow ×1 [sp]');
  });

  it('accounts for every edge exactly once, or drops it because both ends coincide', () => {
    for (const lod of LOD_LEVELS) {
      for (const collapsed of collapsedSets(model)) {
        const visible = visibleNodes(model, collapsed, lod);
        const aggregates = rollupEdges(model, visible);
        const members = aggregates.flatMap((a) => a.memberEdgeIds);
        expect(new Set(members).size).toBe(members.length);
        for (const aggregate of aggregates) {
          expect(aggregate.count).toBe(aggregate.memberEdgeIds.length);
          expect(aggregate.count).toBeGreaterThan(0);
          expect(visible.has(aggregate.source)).toBe(true);
          expect(visible.has(aggregate.target)).toBe(true);
          expect(aggregate.source).not.toBe(aggregate.target);
          expect(aggregate.edge === undefined).toBe(aggregate.count !== 1);
          for (const id of aggregate.memberEdgeIds) {
            const edge = model.edges.find((e) => e.id === id);
            expect(edge?.kind).toBe(aggregate.kind);
            expect(nearestVisible(model, visible, edge?.from ?? '')).toBe(aggregate.source);
            expect(nearestVisible(model, visible, edge?.to ?? '')).toBe(aggregate.target);
          }
        }
        for (const edge of model.edges) {
          const same =
            nearestVisible(model, visible, edge.from) === nearestVisible(model, visible, edge.to);
          expect(members.includes(edge.id)).toBe(!same);
        }
      }
    }
  });

  it('is deterministic: aggregates in the document order of their first member', () => {
    const position = new Map(model.edges.map((e, index) => [e.id, index]));
    for (const collapsed of collapsedSets(model)) {
      const visible = visibleNodes(model, collapsed, 'detail');
      const aggregates = rollupEdges(model, visible);
      expect(rollupEdges(model, new Set([...visible].reverse()))).toEqual(aggregates);
      const first = aggregates.map((a) => position.get(a.memberEdgeIds[0] ?? '') ?? -1);
      expect(first).toEqual([...first].sort((x, y) => x - y));
      for (const aggregate of aggregates) {
        const order = aggregate.memberEdgeIds.map((id) => position.get(id) ?? -1);
        expect(order).toEqual([...order].sort((x, y) => x - y));
      }
    }
  });

  it('level of detail rolls up like collapsing every group below that level', () => {
    expect(rollupEdges(model, visibleNodes(model, new Set(), 'domains'))).toEqual(rollup('a', 'b'));
    expect(rollupEdges(model, visibleNodes(model, new Set(), 'components'))).toEqual(
      rollup('a.x', 'b.m'),
    );
  });

  it('merges duplicate edges (same from, to and kind) even when fully expanded', () => {
    const duplicated = parseOk(`
version: 1
domains:
  - { id: a, name: A }
  - { id: b, name: B }
edges:
  - { id: one, from: a, to: b, kind: dataflow, label: first }
  - { id: two, from: a, to: b, kind: dataflow, label: second }
`);
    const aggregates = rollupEdges(duplicated, visibleNodes(duplicated, new Set(), 'detail'));
    expect(summary(aggregates)).toEqual(['a>b:dataflow ×2 [one,two]']);
  });
});
