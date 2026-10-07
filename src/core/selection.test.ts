// Selection, neighbourhood and dimming.

import { beforeAll, describe, expect, it } from 'vitest';
import { buildFlow, type FlowGraph } from './flow';
import { submodel } from './focusFilter';
import { computeLayoutUncached, type LayoutResult } from './layout';
import { parseOk } from './layout/test-helpers';
import type { ArchitectureModel } from './model';
import { aggregateEdgeId } from './rollup';
import {
  DIMMED_CLASS,
  highlightFlow,
  neighbourhood,
  renderedSelection,
  resolveSelection,
  sameSelection,
  selectionExists,
  selectionOfRenderedEdge,
  workItemDrawnOn,
} from './selection';
import { buildWorkItemOverlay, type WorkItemOverlay } from './workItemOverlay';
import type { WorkItemSummary } from './workitems';

const YAML = `
version: 1
rows:
  - id: top
    name: Top
  - id: bottom
    name: Bottom
domains:
  - id: a
    name: Alpha
    row: top
    components:
      - id: a.x
        name: X
        subcomponents:
          - id: a.x.one
            name: One
          - id: a.x.two
            name: Two
      - id: a.y
        name: Y
  - id: b
    name: Beta
    row: bottom
    components:
      - id: b.p
        name: P
      - id: b.q
        name: Q
  - id: c
    name: Gamma
    row: bottom
edges:
  - id: one-p
    from: a.x.one
    to: b.p
    kind: dataflow
  - id: two-p
    from: a.x.two
    to: b.p
    kind: dataflow
  - id: y-q
    from: a.y
    to: b.q
    kind: control
  - id: one-two
    from: a.x.one
    to: a.x.two
    kind: dependency
  - id: q-c
    from: b.q
    to: c
    kind: config
`;

const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

describe('neighbourhood', () => {
  const edges = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'c', target: 'a' },
    { id: 'e3', source: 'b', target: 'c' },
    { id: 'e4', source: 'd', target: 'e' },
  ];

  it('of a node: itself, its incident edges and their other endpoints', () => {
    const near = neighbourhood({ type: 'node', id: 'a' }, edges);
    expect(sorted(near.nodes)).toEqual(['a', 'b', 'c']);
    expect(sorted(near.edges)).toEqual(['e1', 'e2']);
  });

  it('does not follow edges beyond the direct neighbours', () => {
    const near = neighbourhood({ type: 'node', id: 'd' }, edges);
    expect(sorted(near.nodes)).toEqual(['d', 'e']);
    expect(sorted(near.edges)).toEqual(['e4']);
  });

  it('of an unconnected node: just itself', () => {
    const near = neighbourhood({ type: 'node', id: 'lonely' }, edges);
    expect(sorted(near.nodes)).toEqual(['lonely']);
    expect(near.edges.size).toBe(0);
  });

  it('of an edge or aggregate: itself and both endpoints', () => {
    const near = neighbourhood({ type: 'edge', id: 'e3' }, edges);
    expect(sorted(near.nodes)).toEqual(['b', 'c']);
    expect(sorted(near.edges)).toEqual(['e3']);
  });

  it('of an edge that is not rendered: only its ID', () => {
    const near = neighbourhood({ type: 'edge', id: 'gone' }, edges);
    expect(near.nodes.size).toBe(0);
    expect(sorted(near.edges)).toEqual(['gone']);
  });

  it('keeps node and edge IDs apart (they are separate namespaces)', () => {
    const near = neighbourhood({ type: 'node', id: 'e1' }, edges);
    expect(sorted(near.nodes)).toEqual(['e1']);
    expect(near.edges.size).toBe(0);
  });
});

describe('selection against the rendered flow', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  let open: FlowGraph;
  let closed: FlowGraph;

  beforeAll(async () => {
    model = parseOk(YAML);
    layout = await computeLayoutUncached(model);
    open = buildFlow(model, layout);
    closed = buildFlow(model, layout, { collapsedIds: new Set(['a.x']) });
  });

  it('sameSelection compares type and ID', () => {
    expect(sameSelection(undefined, undefined)).toBe(true);
    expect(sameSelection({ type: 'node', id: 'a' }, { type: 'node', id: 'a' })).toBe(true);
    expect(sameSelection({ type: 'node', id: 'a' }, { type: 'edge', id: 'a' })).toBe(false);
    expect(sameSelection({ type: 'node', id: 'a' }, undefined)).toBe(false);
  });

  it('a clicked single edge selects the original edge, a clicked rollup the aggregate', () => {
    const single = open.edges.find((edge) => edge.data.memberEdgeIds.includes('one-p'));
    const merged = closed.edges.find((edge) => edge.data.memberEdgeIds.includes('one-p'));
    if (!single || !merged) throw new Error('edges missing');
    expect(selectionOfRenderedEdge(single)).toEqual({ type: 'edge', id: 'one-p' });
    expect(merged.data.count).toBe(2);
    expect(selectionOfRenderedEdge(merged)).toEqual({
      type: 'aggregate',
      id: aggregateEdgeId('a.x', 'b.p', 'dataflow'),
    });
  });

  it('selectionExists: nodes and edges by model, aggregates by what is drawn', () => {
    const aggregate = { type: 'aggregate', id: aggregateEdgeId('a.x', 'b.p', 'dataflow') } as const;
    expect(selectionExists(model, open.edges, undefined)).toBe(false);
    expect(selectionExists(model, open.edges, { type: 'node', id: 'a.x.one' })).toBe(true);
    expect(selectionExists(model, open.edges, { type: 'node', id: 'one-p' })).toBe(false);
    expect(selectionExists(model, open.edges, { type: 'edge', id: 'one-p' })).toBe(true);
    expect(selectionExists(model, open.edges, { type: 'edge', id: 'a.x.one' })).toBe(false);
    expect(selectionExists(model, closed.edges, aggregate)).toBe(true);
    expect(selectionExists(model, open.edges, aggregate)).toBe(false);
  });

  it('resolveSelection keeps nodes, edges and aggregates that are still rollups', () => {
    const aggregate = { type: 'aggregate', id: aggregateEdgeId('a.x', 'b.p', 'dataflow') } as const;
    const node = { type: 'node', id: 'a.x.one' } as const;
    const edge = { type: 'edge', id: 'one-p' } as const;
    expect(resolveSelection(model, closed.edges, aggregate)).toBe(aggregate);
    expect(resolveSelection(model, closed.edges, node)).toBe(node);
    expect(resolveSelection(model, closed.edges, edge)).toBe(edge);
    expect(resolveSelection(model, closed.edges, undefined)).toBeUndefined();
    expect(resolveSelection(model, open.edges, { type: 'node', id: 'nope' })).toBeUndefined();
    // No longer drawn at all once the group is open.
    expect(resolveSelection(model, open.edges, aggregate)).toBeUndefined();
  });

  it('resolveSelection turns an aggregate that now stands for one edge into that edge', () => {
    // A rendered edge has the same ID (source>target:kind) whether it stands for one edge or
    // for several, so a stale aggregate selection can name a line that is now a single edge.
    const id = aggregateEdgeId('a.x', 'b.p', 'dataflow');
    const single = [{ id, data: { memberEdgeIds: ['two-p'] } }];
    expect(resolveSelection(model, single, { type: 'aggregate', id })).toEqual({
      type: 'edge',
      id: 'two-p',
    });
    // The same answer as a fresh click on that line.
    const [line] = single;
    if (!line) throw new Error('no line');
    expect(resolveSelection(model, single, { type: 'aggregate', id })).toEqual(
      selectionOfRenderedEdge(line),
    );
  });

  it('a visible node maps to itself, a hidden one to its nearest visible ancestor', () => {
    const selection = { type: 'node', id: 'a.x.one' } as const;
    expect(renderedSelection(model, open, selection)).toEqual({ type: 'node', id: 'a.x.one' });
    expect(renderedSelection(model, closed, selection)).toEqual({ type: 'node', id: 'a.x' });
    const domains = buildFlow(model, layout, { lodLevel: 'domains' });
    expect(renderedSelection(model, domains, selection)).toEqual({ type: 'node', id: 'a' });
    expect(renderedSelection(model, open, undefined)).toBeUndefined();
    expect(renderedSelection(model, open, { type: 'node', id: 'nope' })).toBeUndefined();
  });

  it('an edge maps to the rendered edge that contains it, or to nothing when not drawn', () => {
    const selection = { type: 'edge', id: 'two-p' } as const;
    expect(renderedSelection(model, open, selection)).toEqual({
      type: 'edge',
      id: aggregateEdgeId('a.x.two', 'b.p', 'dataflow'),
    });
    expect(renderedSelection(model, closed, selection)).toEqual({
      type: 'edge',
      id: aggregateEdgeId('a.x', 'b.p', 'dataflow'),
    });
    // Both ends inside the collapsed group: the edge is not drawn at all.
    expect(renderedSelection(model, closed, { type: 'edge', id: 'one-two' })).toBeUndefined();
  });

  it('an aggregate maps to itself only while it is drawn', () => {
    const id = aggregateEdgeId('a.x', 'b.p', 'dataflow');
    expect(renderedSelection(model, closed, { type: 'aggregate', id })).toEqual({
      type: 'edge',
      id,
    });
    expect(renderedSelection(model, open, { type: 'aggregate', id })).toBeUndefined();
  });

  it('highlightFlow without a selection returns the flow itself', () => {
    expect(highlightFlow(open, undefined)).toBe(open);
  });

  it('dims everything outside the neighbourhood and hides or moves nothing', () => {
    const lit = highlightFlow(open, { type: 'node', id: 'b.q' });
    expect(lit.nodes.map((n) => n.id)).toEqual(open.nodes.map((n) => n.id));
    expect(lit.edges.map((e) => e.id)).toEqual(open.edges.map((e) => e.id));
    lit.nodes.forEach((node, index) => {
      expect(node.position).toEqual(open.nodes[index]?.position);
      expect(node.style).toEqual(open.nodes[index]?.style);
    });

    const dimmedNodes = lit.nodes
      .filter((n) => (n.className ?? '').split(' ').includes(DIMMED_CLASS))
      .map((n) => n.id);
    // b.q with its neighbours a.y (y-q) and c (q-c) stay; the rest is dimmed.
    expect(dimmedNodes.sort()).toEqual(['a', 'a.x', 'a.x.one', 'a.x.two', 'b', 'b.p']);
    expect(lit.nodes.filter((n) => n.type !== 'band' && n.selected).map((n) => n.id)).toEqual([
      'b.q',
    ]);

    const undimmedEdges = lit.edges.filter((e) => !e.className.includes(DIMMED_CLASS));
    expect(undimmedEdges.flatMap((e) => e.data.memberEdgeIds).sort()).toEqual(['q-c', 'y-q']);
    for (const edge of lit.edges) {
      const dimmed = edge.className.split(' ').includes(DIMMED_CLASS);
      expect(edge.data.dimmed ?? false).toBe(dimmed);
      // The kind class survives, so a dimmed edge keeps its line style.
      expect(edge.className).toContain(`arch-edge-${edge.data.kind}`);
      expect(edge.selected ?? false).toBe(false);
    }
  });

  it('never dims the row bands', () => {
    const lit = highlightFlow(open, { type: 'node', id: 'c' });
    const bands = lit.nodes.filter((n) => n.type === 'band');
    expect(bands.length).toBe(2);
    for (const band of bands) {
      expect(band.className).not.toContain(DIMMED_CLASS);
      expect(open.nodes).toContain(band);
    }
  });

  it('keeps the nodes drawn inside a selected group undimmed', () => {
    const lit = highlightFlow(open, { type: 'node', id: 'a' });
    const dimmed = new Set(
      lit.nodes.filter((n) => (n.className ?? '').includes(DIMMED_CLASS)).map((n) => n.id),
    );
    for (const id of ['a', 'a.x', 'a.x.one', 'a.x.two', 'a.y']) expect(dimmed.has(id)).toBe(false);
    // `a` itself has no rendered edge while it is open: everything else is dimmed.
    expect(sorted(dimmed)).toEqual(['b', 'b.p', 'b.q', 'c']);
  });

  it('a selected edge is marked, its two ends stay lit', () => {
    const id = aggregateEdgeId('a.y', 'b.q', 'control');
    const lit = highlightFlow(open, { type: 'edge', id });
    expect(lit.edges.filter((e) => e.selected).map((e) => e.id)).toEqual([id]);
    const litNodes = lit.nodes
      .filter((n) => n.type !== 'band' && !(n.className ?? '').includes(DIMMED_CLASS))
      .map((n) => n.id);
    expect(litNodes.sort()).toEqual(['a.y', 'b.q']);
    expect(lit.edges.filter((e) => !e.data.dimmed).map((e) => e.id)).toEqual([id]);
  });

  it('a collapsed group gathers the neighbours of everything inside it', () => {
    const lit = highlightFlow(
      closed,
      renderedSelection(model, closed, { type: 'node', id: 'a.x.one' }),
    );
    const litNodes = lit.nodes
      .filter((n) => n.type !== 'band' && !(n.className ?? '').includes(DIMMED_CLASS))
      .map((n) => n.id);
    expect(litNodes.sort()).toEqual(['a.x', 'b.p']);
  });
});

describe('selection against the flow of a reduced model', () => {
  let model: ArchitectureModel;
  let reduced: ArchitectureModel;
  let layout: LayoutResult;
  let open: FlowGraph;
  let overlay: WorkItemOverlay;
  const story = (id: number, componentIds: string[]): WorkItemSummary => ({
    id,
    type: 'User Story',
    title: `Item ${id}`,
    state: 'Active',
    componentIds,
    tags: [],
  });

  beforeAll(async () => {
    model = parseOk(YAML);
    reduced = submodel(model, {
      nodes: new Set(['a', 'a.x', 'a.x.one', 'b', 'b.p']),
      edges: new Set(['one-p']),
    }).model;
    layout = await computeLayoutUncached(reduced);
    open = buildFlow(reduced, layout);
    overlay = buildWorkItemOverlay(model, [
      story(1, ['a.x.one', 'a.x.two', 'b.q']),
      story(2, ['a.x.two', 'c']),
    ]);
  });

  it('a node the model lacks is not drawn: no group around it is marked in its place', () => {
    const selection = { type: 'node', id: 'a.x.two' } as const;
    expect(renderedSelection(reduced, open, selection)).toBeUndefined();
    expect(renderedSelection(reduced, open, { type: 'node', id: 'c' })).toBeUndefined();
    // Asked with the model the flow was not built from, the group would stand in for it.
    expect(renderedSelection(model, open, selection)).toEqual({ type: 'node', id: 'a.x' });
  });

  it('a kept node maps to itself, or to its nearest visible ancestor while it is hidden', () => {
    const selection = { type: 'node', id: 'a.x.one' } as const;
    expect(renderedSelection(reduced, open, selection)).toEqual(selection);
    const closed = buildFlow(reduced, layout, { collapsedIds: new Set(['a.x']) });
    expect(renderedSelection(reduced, closed, selection)).toEqual({ type: 'node', id: 'a.x' });
  });

  it('a work item is drawn on the kept nodes that list it only', () => {
    const visible = new Set(open.nodes.filter((n) => n.type !== 'band').map((n) => n.id));
    expect(workItemDrawnOn(reduced, overlay, visible, 1)).toEqual(['a.x.one']);
    expect(workItemDrawnOn(model, overlay, visible, 1)).toEqual(['a.x.one', 'a.x', 'b']);
    expect(renderedSelection(reduced, open, { type: 'workitem', id: 1 }, overlay)).toEqual({
      type: 'workitem',
      id: 1,
      nodeIds: ['a.x.one'],
    });
    // Listed on nodes that are left out only.
    expect(workItemDrawnOn(reduced, overlay, visible, 2)).toEqual([]);
    expect(renderedSelection(reduced, open, { type: 'workitem', id: 2 }, overlay)).toBeUndefined();
  });
});
