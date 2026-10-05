// The flow mapping under collapse and level of detail: nothing moves,
// hidden nodes disappear, edges are the rollup and attach to the visible endpoints.

import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import {
  aggregateCountLabel,
  buildFlow,
  collapseAction,
  flowEdgeLabel,
  routeEdge,
  sourceHandleId,
  targetHandleId,
  Z_INDEX,
  type ArchFlowNode,
  type BandFlowNode,
  type FlowGraph,
  type FlowNode,
} from './flow';
import { computeLayoutUncached, type LayoutResult } from './layout';
import { parseOk } from './layout/test-helpers';
import type { Rect } from './layout/types';
import type { ArchitectureModel } from './model';
import { rollupEdges } from './rollup';
import { groupIds, LOD_LEVELS, visibleNodes, type LodLevel } from './visibility';

function isBand(node: FlowNode): node is BandFlowNode {
  return node.type === 'band';
}
function archNodes(flow: FlowGraph): ArchFlowNode[] {
  return flow.nodes.filter((n): n is ArchFlowNode => !isBand(n));
}
function bands(flow: FlowGraph): BandFlowNode[] {
  return flow.nodes.filter(isBand);
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

/** None, all groups, every single group, and deterministic pseudo-random subsets. */
function collapsedSets(model: ArchitectureModel): Set<string>[] {
  const groups = groupIds(model);
  const sets: Set<string>[] = [new Set(), new Set(groups), ...groups.map((id) => new Set([id]))];
  const random = mulberry32(20260930);
  for (let i = 0; i < 60; i++) {
    const density = 0.15 + 0.7 * random();
    sets.push(new Set(groups.filter(() => random() < density)));
  }
  return sets;
}

/** What must not change when something else is collapsed. */
function geometry(node: ArchFlowNode) {
  return {
    id: node.id,
    position: node.position,
    width: node.width,
    height: node.height,
    style: node.style,
    parentId: node.parentId,
    extent: node.extent,
  };
}

/** Asserts every invariant of a collapsed mapping against the fully expanded one. */
function checkView(
  model: ArchitectureModel,
  layout: LayoutResult,
  expanded: FlowGraph,
  collapsed: ReadonlySet<string>,
  lod: LodLevel,
): FlowGraph {
  const flow = buildFlow(model, layout, { collapsedIds: collapsed, lodLevel: lod });
  const visible = visibleNodes(model, collapsed, lod);
  const nodes = archNodes(flow);

  // Exactly the visible nodes, in document order, parents first.
  expect(nodes.map((n) => n.id)).toEqual([...visible]);

  // Row bands and the Unassigned area are untouched.
  expect(bands(flow)).toEqual(bands(expanded));

  // Collapsing never moves or resizes any node that is still shown — the collapsed groups
  // themselves included.
  const before = new Map(archNodes(expanded).map((n) => [n.id, n]));
  for (const node of nodes) {
    const original = before.get(node.id);
    if (!original) throw new Error(`${node.id} is not in the expanded mapping`);
    expect(geometry(node)).toEqual(geometry(original));
    const absolute = layout.absolute.get(node.id);
    expect({ width: node.width, height: node.height }).toEqual({
      width: absolute?.width,
      height: absolute?.height,
    });
    if (node.parentId !== undefined) expect(visible.has(node.parentId)).toBe(true);
  }

  // Closed groups: flagged, still `group` nodes, drawn above the edges like leaves.
  for (const node of nodes) {
    const children = model.nodes.get(node.id)?.childIds ?? [];
    const isClosed = children.length > 0 && !children.some((child) => visible.has(child));
    expect(node.data.collapsed, node.id).toBe(isClosed);
    expect(node.data.manuallyCollapsed, node.id).toBe(
      children.length > 0 && collapsed.has(node.id),
    );
    expect(node.type).toBe(children.length > 0 ? 'group' : 'leaf');
    expect(node.zIndex).toBe(
      isClosed || children.length === 0 ? Z_INDEX.leaf : Z_INDEX.group + node.data.level,
    );
  }

  // Edges are exactly the rollup, attached to visible nodes.
  const aggregates = rollupEdges(model, visible);
  expect(flow.edges.map((e) => e.id)).toEqual(aggregates.map((a) => a.id));
  const closedRects: Rect[] = [];
  for (const node of nodes) {
    const rect = layout.absolute.get(node.id);
    if (rect && node.zIndex === Z_INDEX.leaf) closedRects.push(rect);
  }
  const routedPairs = new Set<string>();
  for (const [index, edge] of flow.edges.entries()) {
    const aggregate = aggregates[index];
    if (!aggregate) throw new Error('missing aggregate');
    expect(edge.source).toBe(aggregate.source);
    expect(edge.target).toBe(aggregate.target);
    expect(visible.has(edge.source) && visible.has(edge.target)).toBe(true);
    expect(edge.data.kind).toBe(aggregate.kind);
    expect(edge.data.count).toBe(aggregate.count);
    expect(edge.data.memberEdgeIds).toEqual(aggregate.memberEdgeIds);
    expect(edge.sourceHandle).toBe(sourceHandleId(edge.data.route.sourceSide));
    expect(edge.targetHandle).toBe(targetHandleId(edge.data.route.targetSide));

    if (aggregate.count > 1) {
      expect(flowEdgeLabel(edge.data)).toBe(`×${aggregate.count}`);
      expect(edge.data.label).toBeUndefined();
      expect(edge.data.protocol).toBeUndefined();
      expect(edge.data.description).toBeUndefined();
      expect(edge.className).toContain('arch-edge-aggregate');
    } else {
      expect(edge.data.label).toBe(aggregate.edge?.label);
      expect(edge.data.protocol).toBe(aggregate.edge?.protocol);
      expect(edge.data.description).toBe(aggregate.edge?.description);
      expect(edge.className).toBe(`arch-edge-${aggregate.kind}`);
    }

    // Floating handle sides come from the absolute rectangles of the visible endpoints: the
    // first edge between a pair of nodes takes exactly the route between those two boxes.
    const pair = [edge.source, edge.target].sort().join('\n');
    if (!routedPairs.has(pair)) {
      routedPairs.add(pair);
      const source = layout.absolute.get(edge.source);
      const target = layout.absolute.get(edge.target);
      if (!source || !target) throw new Error('missing rect');
      const sourceRow = layout.rowOf.get(edge.source);
      const targetRow = layout.rowOf.get(edge.target);
      const acrossRows =
        sourceRow !== undefined && targetRow !== undefined && sourceRow !== targetRow;
      expect(edge.data.route, edge.id).toMatchObject(
        routeEdge(source, target, closedRects, acrossRows),
      );
    }
  }
  return flow;
}

describe('buildFlow with collapsed groups (small model)', () => {
  const yaml = `
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - id: a.x
        name: X
        subcomponents:
          - { id: a.x.p, name: P }
          - { id: a.x.q, name: Q }
      - { id: a.y, name: Y }
  - id: b
    name: Beta
    components:
      - id: b.m
        name: M
        subcomponents:
          - { id: b.m.s, name: S }
      - { id: b.n, name: N }
edges:
  - { id: pq, from: a.x.p, to: a.x.q, kind: dataflow, label: inner }
  - { id: ps, from: a.x.p, to: b.m.s, kind: dataflow, label: across, protocol: HTTP }
  - { id: qn, from: a.x.q, to: b.n, kind: dataflow }
  - { id: sp, from: b.m.s, to: a.x.p, kind: dataflow, description: back }
  - { id: yn, from: a.y, to: b.n, kind: control }
`;
  let model: ArchitectureModel;
  let layout: LayoutResult;
  let expanded: FlowGraph;
  beforeAll(async () => {
    model = parseOk(yaml);
    layout = await computeLayoutUncached(model);
    expanded = buildFlow(model, layout);
  });

  it('defaults to nothing collapsed at full detail', () => {
    expect(buildFlow(model, layout, {})).toEqual(expanded);
    expect(buildFlow(model, layout, { collapsedIds: new Set(), lodLevel: 'detail' })).toEqual(
      expanded,
    );
    expect(archNodes(expanded).every((n) => !n.data.collapsed)).toBe(true);
  });

  it('omits the contents of a collapsed group and keeps its box where it was', () => {
    const flow = checkView(model, layout, expanded, new Set(['a.x']), 'detail');
    expect(archNodes(flow).map((n) => n.id)).toEqual([
      'a',
      'a.x',
      'a.y',
      'b',
      'b.m',
      'b.m.s',
      'b.n',
    ]);
    const box = archNodes(flow).find((n) => n.id === 'a.x');
    const open = archNodes(expanded).find((n) => n.id === 'a.x');
    expect(box?.position).toEqual(open?.position);
    expect([box?.width, box?.height]).toEqual([open?.width, open?.height]);
    expect(box?.data).toMatchObject({
      collapsed: true,
      manuallyCollapsed: true,
      counts: { children: 2, descendants: 2 },
    });
    expect(box?.type).toBe('group');
  });

  it('renders the rollup: counts on aggregates, original label on single edges', () => {
    const flow = checkView(model, layout, expanded, new Set(['a', 'b']), 'detail');
    expect(archNodes(flow).map((n) => n.id)).toEqual(['a', 'b']);
    expect(flow.edges.map((e) => [e.id, e.data.count, flowEdgeLabel(e.data)])).toEqual([
      ['a>b:dataflow', 2, '×2'],
      ['b>a:dataflow', 1, undefined],
      ['a>b:control', 1, undefined],
    ]);
    expect(flow.edges[0]?.data.memberEdgeIds).toEqual(['ps', 'qn']);
    expect(flow.edges[1]?.data.description).toBe('back');
    expect(aggregateCountLabel(3)).toBe('×3');

    const single = checkView(model, layout, expanded, new Set(['b.m']), 'detail');
    const across = single.edges.find((e) => e.data.memberEdgeIds.includes('ps'));
    expect(across).toMatchObject({ source: 'a.x.p', target: 'b.m' });
    expect(across && flowEdgeLabel(across.data)).toBe('across [HTTP]');
  });

  it('gives the three edges between two collapsed groups their own lanes', () => {
    const flow = buildFlow(model, layout, { collapsedIds: new Set(['a', 'b']) });
    expect(flow.edges.map((e) => [e.data.route.lane, e.data.route.lanes])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    const [forward, backward] = flow.edges;
    expect(backward?.data.route.sourceSide).toBe(forward?.data.route.targetSide);
    expect(backward?.data.route.targetSide).toBe(forward?.data.route.sourceSide);
  });

  it('attaches rolled-up edges to the sides of the collapsed boxes that face each other', () => {
    const flow = buildFlow(model, layout, { collapsedIds: new Set(['a', 'b']) });
    const a = layout.absolute.get('a');
    const b = layout.absolute.get('b');
    if (!a || !b) throw new Error('missing rect');
    const edge = flow.edges[0];
    // Two boxes with nothing else on the canvas: the facing sides, from the boxes' own rects.
    expect(edge?.data.route).toMatchObject(routeEdge(a, b, [a, b]));
    expect(edge?.sourceHandle).toBe(sourceHandleId(routeEdge(a, b, [a, b]).sourceSide));
  });

  it('a collapsed group inside a collapsed group stays collapsed when the outer one reopens', () => {
    const both = checkView(model, layout, expanded, new Set(['a', 'a.x']), 'detail');
    expect(archNodes(both).map((n) => n.id)).toEqual(['a', 'b', 'b.m', 'b.m.s', 'b.n']);
    const inner = checkView(model, layout, expanded, new Set(['a.x']), 'detail');
    expect(archNodes(inner).find((n) => n.id === 'a.x')?.data.collapsed).toBe(true);
  });

  it('level of detail closes groups without marking them manually collapsed', () => {
    const flow = checkView(model, layout, expanded, new Set(), 'domains');
    expect(archNodes(flow).map((n) => [n.id, n.data.collapsed, n.data.manuallyCollapsed])).toEqual([
      ['a', true, false],
      ['b', true, false],
    ]);
    const components = checkView(model, layout, expanded, new Set(['b']), 'components');
    expect(archNodes(components).map((n) => n.id)).toEqual(['a', 'a.x', 'a.y', 'b']);
  });

  it('offers the toggle that matches the manual set, and none on a group closed only by level of detail', () => {
    const actions = (collapsed: ReadonlySet<string>, lod: LodLevel) =>
      archNodes(checkView(model, layout, expanded, collapsed, lod)).map((n) => [
        n.id,
        collapseAction(n.data),
      ]);
    const detail = Object.fromEntries(actions(new Set(['b']), 'detail')) as Record<string, unknown>;
    expect(detail['a']).toBe('collapse');
    expect(detail['b']).toBe('expand');
    expect(detail['a.y']).toBeUndefined();
    expect(actions(new Set(['b']), 'domains')).toEqual([
      ['a', undefined],
      ['b', 'expand'],
    ]);
  });

  it('never moves a node, for every collapsed set and level of detail', () => {
    for (const lod of LOD_LEVELS) {
      for (const collapsed of collapsedSets(model)) {
        checkView(model, layout, expanded, collapsed, lod);
      }
    }
  });

  it('ignores unknown and leaf IDs in the collapsed set', () => {
    expect(buildFlow(model, layout, { collapsedIds: new Set(['nope', 'a.y', 'b.n']) })).toEqual(
      expanded,
    );
  });
});

describe('buildFlow with collapsed groups (examples/architecture.yaml)', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  let expanded: FlowGraph;
  beforeAll(async () => {
    model = parseOk(exampleYaml);
    layout = await computeLayoutUncached(model);
    expanded = buildFlow(model, layout);
  });

  it('collapsing never moves any other node: single groups, all groups, random subsets', () => {
    const sets = collapsedSets(model);
    expect(sets.length).toBeGreaterThan(groupIds(model).length + 50);
    for (const collapsed of sets) checkView(model, layout, expanded, collapsed, 'detail');
  });

  it('holds at every level of detail as well', () => {
    const sets = collapsedSets(model).slice(0, 30);
    for (const lod of LOD_LEVELS) {
      for (const collapsed of sets) checkView(model, layout, expanded, collapsed, lod);
    }
  });

  it('collapses everything to the domains, with every edge rolled up or dropped', () => {
    const flow = checkView(model, layout, expanded, new Set(groupIds(model)), 'detail');
    expect(archNodes(flow).map((n) => n.id)).toEqual([...model.rootIds]);
    const members = flow.edges.flatMap((e) => e.data.memberEdgeIds);
    expect(new Set(members).size).toBe(members.length);
    const rootOf = (id: string): string => id.split('.')[0] ?? id;
    const crossing = model.edges.filter((e) => rootOf(e.from) !== rootOf(e.to));
    expect([...members].sort()).toEqual(crossing.map((e) => e.id).sort());
    expect(flow.edges.some((e) => e.data.count > 1)).toBe(true);
    expect(flow.edges.length).toBeLessThan(model.edges.length);
  });

  it('collapses groups spanning several rows in place', () => {
    const spanning = groupIds(model).filter((id) => {
      const range = model.nodes.get(id)?.rowRange;
      return range !== undefined && range.top !== range.bottom;
    });
    expect(spanning.length).toBeGreaterThan(0);
    for (const id of spanning) {
      const flow = checkView(model, layout, expanded, new Set([id]), 'detail');
      const box = archNodes(flow).find((n) => n.id === id);
      expect(box?.data.collapsed).toBe(true);
      // The closed box still covers every band the group spans.
      const rect = layout.absolute.get(id);
      const range = model.nodes.get(id)?.rowRange;
      const top = layout.rows[range?.top ?? 0];
      const bottom = layout.rows[range?.bottom ?? 0];
      if (!rect || !top || !bottom) throw new Error('missing geometry');
      expect(rect.y).toBeLessThan(top.y + top.height);
      expect(rect.y + rect.height).toBeGreaterThan(bottom.y);
      expect([box?.width, box?.height]).toEqual([rect.width, rect.height]);
    }
    checkView(model, layout, expanded, new Set(spanning), 'detail');
  });

  it('collapses groups in the Unassigned area in place', () => {
    const area = layout.unassignedArea;
    if (!area) throw new Error('the example has no Unassigned area');
    const unassigned = model.rootIds.filter(
      (id) =>
        model.nodes.get(id)?.rowRange === undefined &&
        (model.nodes.get(id)?.childIds.length ?? 0) > 0,
    );
    expect(unassigned.length).toBeGreaterThan(0);
    for (const id of unassigned) {
      const flow = checkView(model, layout, expanded, new Set([id]), 'detail');
      const box = archNodes(flow).find((n) => n.id === id);
      const rect = layout.absolute.get(id);
      if (!box || !rect) throw new Error('missing node');
      expect(box.data.collapsed).toBe(true);
      expect(box.position).toEqual({ x: rect.x, y: rect.y });
      expect(rect.x).toBeGreaterThanOrEqual(area.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(area.x + area.width);
      expect(archNodes(flow).some((n) => n.id.startsWith(`${id}.`))).toBe(false);
    }
  });

  it('leaves the row bands and the Unassigned area unaffected', () => {
    const everything = buildFlow(model, layout, { collapsedIds: new Set(groupIds(model)) });
    expect(bands(everything)).toEqual(bands(expanded));
    expect(bands(everything).length).toBe(model.rows.length + (layout.unassignedArea ? 1 : 0));
    expect(bands(buildFlow(model, layout, { lodLevel: 'domains' }))).toEqual(bands(expanded));
  });

  it('is deterministic for the same view', () => {
    const view = { collapsedIds: new Set(groupIds(model).filter((_, i) => i % 2 === 0)) };
    expect(buildFlow(model, layout, view)).toEqual(buildFlow(model, layout, view));
  });
});
