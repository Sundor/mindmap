import { describe, expect, it } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import {
  buildHierarchyGraph,
  edgeContainer,
  ELK_ROOT_ID,
  fnv1a64,
  LAYOUT_CONFIG,
  layoutKey,
  orderItems,
  sweep1D,
} from './index';
import { parseOk } from './test-helpers';

describe('fnv1a64', () => {
  it('matches the reference FNV-1a 64-bit vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
});

const TREE = `
version: 1
domains:
  - id: a
    name: A
    components:
      - id: a.x
        name: X
        subcomponents:
          - id: a.x.p
            name: P
          - id: a.x.q
            name: Q
      - id: a.y
        name: Y
  - id: b
    name: B
    components:
      - id: b.z
        name: Z
edges:
  - { id: siblings, from: a.x.p, to: a.x.q, kind: dataflow }
  - { id: cousins, from: a.x.p, to: a.y, kind: dataflow }
  - { id: cross, from: a.x.q, to: b.z, kind: control }
  - { id: down, from: a, to: a.x.p, kind: config }
  - { id: up, from: b.z, to: b, kind: dependency }
  - { id: roots, from: a, to: b, kind: dependency }
`;

describe('edgeContainer / ELK graph', () => {
  const model = parseOk(TREE);

  it('puts each edge in the lowest node containing both endpoints', () => {
    expect(edgeContainer(model, 'a.x.p', 'a.x.q')).toBe('a.x');
    expect(edgeContainer(model, 'a.x.p', 'a.y')).toBe('a');
    expect(edgeContainer(model, 'a.x.q', 'b.z')).toBeUndefined();
    expect(edgeContainer(model, 'a', 'a.x.p')).toBe('a');
    expect(edgeContainer(model, 'b.z', 'b')).toBe('b');
    expect(edgeContainer(model, 'a', 'b')).toBeUndefined();
  });

  it('declares every model edge in its container in the ELK graph', () => {
    const graph = buildHierarchyGraph(model, model.rootIds, 0);
    const where = new Map<string, string>();
    const walk = (node: ElkNode): void => {
      for (const edge of node.edges ?? [])
        where.set(`${edge.sources[0]}>${edge.targets[0]}`, node.id);
      node.children?.forEach(walk);
    };
    walk(graph);
    expect(where).toEqual(
      new Map([
        ['a.x.p>a.x.q', 'a.x'],
        ['a.x.p>a.y', 'a'],
        ['a.x.q>b.z', ELK_ROOT_ID],
        ['a>a.x.p', 'a'],
        ['b.z>b', 'b'],
        ['a>b', ELK_ROOT_ID],
      ]),
    );
    expect(graph.layoutOptions?.['elk.hierarchyHandling']).toBe('INCLUDE_CHILDREN');
    expect(graph.layoutOptions?.['elk.direction']).toBe('RIGHT');
  });

  it('only includes edges inside the subtrees being laid out', () => {
    const graph = buildHierarchyGraph(model, ['a'], 0);
    const count = (node: ElkNode): number =>
      (node.edges?.length ?? 0) + (node.children ?? []).reduce((s, c) => s + count(c), 0);
    expect(count(graph)).toBe(3); // siblings, cousins, down
  });
});

describe('layoutKey', () => {
  const base = parseOk(TREE);
  it('ignores edge labels, kinds and descriptions', () => {
    const relabelled = parseOk(
      TREE.replace('kind: control }', 'kind: dataflow, label: new, description: text }'),
    );
    expect(layoutKey(relabelled)).toBe(layoutKey(base));
  });
  it('changes with names, structure and edge endpoints', () => {
    expect(layoutKey(parseOk(TREE.replace('name: Z', 'name: Zed')))).not.toBe(layoutKey(base));
    expect(
      layoutKey(parseOk(TREE.replace('to: b.z, kind: control', 'to: b, kind: control'))),
    ).not.toBe(layoutKey(base));
  });
  it('changes when a layout constant or ELK option changes', () => {
    expect(layoutKey(base)).toBe(layoutKey(base, LAYOUT_CONFIG));
    const taller = { ...LAYOUT_CONFIG, groupPadding: { ...LAYOUT_CONFIG.groupPadding, top: 49 } };
    expect(layoutKey(base, taller)).not.toBe(layoutKey(base));
    const leaf = {
      ...LAYOUT_CONFIG,
      leafSize: { ...LAYOUT_CONFIG.leafSize, 2: { width: 160, height: 56 } },
    };
    expect(layoutKey(base, leaf)).not.toBe(layoutKey(base));
    const elk = { ...LAYOUT_CONFIG, elk: { ...LAYOUT_CONFIG.elk, 'elk.spacing.edgeEdge': '10' } };
    expect(layoutKey(base, elk)).not.toBe(layoutKey(base));
  });
});

describe('orderItems', () => {
  it('orders a chain along its edges regardless of input order', async () => {
    const items = ['c', 'b', 'a'].map((id) => ({ id, width: 100, height: 40 }));
    const order = await orderItems(items, [
      ['a', 'b'],
      ['b', 'c'],
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
  it('keeps input order for unconnected items', async () => {
    const items = ['q', 'p', 'r'].map((id) => ({ id, width: 100, height: 40 }));
    expect(await orderItems(items, [])).toEqual(['q', 'p', 'r']);
  });
});

describe('sweep1D', () => {
  it('keeps non-overlapping items where they want to be', () => {
    expect(sweep1D([10, 10], [0, 50], 0, 5)).toEqual([0, 50]);
  });
  it('centres an overlapping pair on their desired positions', () => {
    // Both want 100: the pair (10 + 4 gap + 10) is split around 100.
    expect(sweep1D([10, 10], [100, 100], 0, 4)).toEqual([93, 107]);
  });
  it('respects the lower bound and keeps order', () => {
    expect(sweep1D([10, 10, 10], [-50, -40, 30], 0, 5)).toEqual([0, 15, 30]);
  });
  it('merges transitively', () => {
    const starts = sweep1D([10, 10, 10], [20, 20, 20], 0, 0);
    expect(starts).toEqual([10, 20, 30]);
  });
  it('appends items without a preference after their predecessor', () => {
    expect(sweep1D([10, 10, 10], [40, undefined, 45], 0, 5)).toEqual([27.5, 42.5, 57.5]);
    expect(sweep1D([10, 10], [40, undefined], 0, 5)).toEqual([40, 55]);
    expect(sweep1D([10, 10], [undefined, undefined], 7, 5)).toEqual([7, 22]);
  });
});
