import { describe, expect, it } from 'vitest';
import {
  boxesAsked,
  buildFlow,
  computeLayoutUncached,
  focusSet,
  onDemandIndex,
  QUIET_CLASS,
  quietEdges,
  revealEdges,
  type FlowGraph,
} from './index';
import { parseOk } from './layout/test-helpers';

const model = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - id: a.x
        name: X
        subcomponents:
          - { id: a.x.one, name: One }
          - { id: a.x.two, name: Two }
      - { id: a.y, name: Y }
  - id: b
    name: Beta
    components:
      - { id: b.p, name: P }
edges:
  - { id: one-two, from: a.x.one, to: a.x.two, kind: dataflow }
  - { id: two-y, from: a.x.two, to: a.y, kind: dataflow }
  - { id: y-p, from: a.y, to: b.p, kind: control }
  - { id: p-one, from: b.p, to: a.x.one, kind: config }
flows:
  - id: deploy
    name: Deploy
    kind: workflow
    nodes: [b]
    edges: [p-one]
`);

/** The model edges of the rendered edges that are not hidden, sorted. */
function shownEdges(flow: FlowGraph): string[] {
  return flow.edges
    .filter((edge) => !edge.className.includes(QUIET_CLASS))
    .flatMap((edge) => edge.data.memberEdgeIds)
    .sort();
}

describe('edges on demand', async () => {
  const layout = await computeLayoutUncached(model);
  const open = buildFlow(model, layout);
  const index = onDemandIndex(open);

  it('takes a box as itself and everything drawn inside it', () => {
    expect([...boxesAsked(index, ['a'])].sort()).toEqual(['a', 'a.x', 'a.x.one', 'a.x.two', 'a.y']);
    expect([...boxesAsked(index, ['a.x'])].sort()).toEqual(['a.x', 'a.x.one', 'a.x.two']);
    expect([...boxesAsked(index, ['a.x.one'])]).toEqual(['a.x.one']);
    expect([...boxesAsked(index, ['a.y', 'b.p'])].sort()).toEqual(['a.y', 'b.p']);
    expect([...boxesAsked(index, [])]).toEqual([]);
    // Not drawn: kept, and it shows nothing.
    expect([...boxesAsked(index, ['nope'])]).toEqual(['nope']);
    // A closed group is itself only: nothing is drawn inside it.
    const closed = onDemandIndex(buildFlow(model, layout, { lodLevel: 'components' }));
    expect([...boxesAsked(closed, ['a.x'])]).toEqual(['a.x']);
  });

  it('knows the boxes that are drawn, and no row band', async () => {
    expect([...index.boxes].sort()).toEqual(['a', 'a.x', 'a.x.one', 'a.x.two', 'a.y', 'b', 'b.p']);
    // What a closed group hides is not drawn.
    const closed = onDemandIndex(buildFlow(model, layout, { lodLevel: 'components' }));
    expect([...closed.boxes].sort()).toEqual(['a', 'a.x', 'a.y', 'b', 'b.p']);
    const rows = parseOk(`
version: 1
rows:
  - { id: top, name: Top }
  - { id: low, name: Low }
domains:
  - id: d
    name: D
    components:
      - { id: d.up, name: Up, row: top }
      - { id: d.down, name: Down, row: low }
`);
    const banded = buildFlow(rows, await computeLayoutUncached(rows));
    expect(banded.nodes.some((node) => node.type === 'band')).toBe(true);
    expect([...onDemandIndex(banded).boxes].sort()).toEqual(['d', 'd.down', 'd.up']);
  });

  it('quietens every edge but those at the given nodes or in the focus', () => {
    const flow = buildFlow(model, layout, { lodLevel: 'components' });
    const quiet = quietEdges(flow, new Set(['a.y']), undefined);
    const loud = quiet.edges.filter((edge) => !edge.className.includes(QUIET_CLASS));
    expect(loud.every((edge) => edge.source === 'a.y' || edge.target === 'a.y')).toBe(true);
    expect(loud.length).toBeGreaterThan(0);
    expect(quiet.edges.filter((edge) => edge.data.quiet === true)).toHaveLength(
      quiet.edges.length - loud.length,
    );
    const set = focusSet(model, { type: 'flow', id: 'deploy' });
    expect(shownEdges(quietEdges(flow, new Set(), set))).toEqual(['p-one']);
    // The selected edge stays.
    const selected = flow.edges.find((edge) => edge.data.memberEdgeIds.includes('y-p'));
    if (!selected) throw new Error('edge');
    expect(shownEdges(quietEdges(flow, new Set(), undefined, selected.id))).toEqual(['y-p']);
    // Nothing to quieten: the same graph.
    const empty = { nodes: [], edges: [] };
    expect(quietEdges(empty, new Set(), undefined)).toBe(empty);
  });

  it('holds at every level: the frame of an open group shows the edges of all it draws', () => {
    // Everything drawn open: the frame of a.x shows the edges at One and Two.
    expect(shownEdges(quietEdges(open, boxesAsked(index, ['a.x']), undefined))).toEqual([
      'one-two',
      'p-one',
      'two-y',
    ]);
    // A box inside it only its own.
    expect(shownEdges(quietEdges(open, boxesAsked(index, ['a.x.two']), undefined))).toEqual([
      'one-two',
      'two-y',
    ]);
    // The frame of a domain: every edge with an end in it.
    expect(shownEdges(quietEdges(open, boxesAsked(index, ['b']), undefined))).toEqual([
      'p-one',
      'y-p',
    ]);
    // The focus shows its edges whatever is pointed at.
    const set = focusSet(model, { type: 'flow', id: 'deploy' });
    expect(shownEdges(quietEdges(open, boxesAsked(index, ['a.y']), set))).toEqual([
      'p-one',
      'two-y',
      'y-p',
    ]);
  });

  it('reveals the edges at a box as quietEdges would, keeping every other edge', () => {
    const set = focusSet(model, { type: 'flow', id: 'deploy' });
    const quiet = quietEdges(open, new Set(), set);
    const asked = boxesAsked(index, ['a.x.two']);
    const revealed = revealEdges(quiet, open, index, asked);
    expect(revealed).toEqual(quietEdges(open, asked, set));
    expect(revealed.nodes).toBe(quiet.nodes);
    revealed.edges.forEach((edge, at) => {
      // Shown again as the unquiet flow has it; the rest untouched.
      expect(edge).toBe(edge.className.includes(QUIET_CLASS) ? quiet.edges[at] : open.edges[at]);
    });
    expect(shownEdges(revealEdges(quiet, open, index, ['b.p']))).toEqual(['p-one', 'y-p']);
    // Nothing more to show: the quiet flow itself.
    expect(revealEdges(quiet, open, index, [])).toBe(quiet);
    expect(revealEdges(quiet, open, index, ['nope'])).toBe(quiet);
    const allShown = quietEdges(open, boxesAsked(index, ['a', 'b']), undefined);
    expect(revealEdges(allShown, open, index, ['a.x.one'])).toBe(allShown);
  });

  it('gives the same list of nodes whatever is pointed at, selected or focused', () => {
    const set = focusSet(model, { type: 'flow', id: 'deploy' });
    const quiets = [
      quietEdges(open, new Set(), undefined),
      quietEdges(open, boxesAsked(index, ['a.y']), set),
      quietEdges(open, boxesAsked(index, ['a', 'b']), undefined),
    ];
    for (const quiet of quiets) {
      expect(quiet.nodes).toBe(open.nodes);
      for (const id of [...index.boxes, 'nope']) {
        expect(revealEdges(quiet, open, index, boxesAsked(index, [id])).nodes).toBe(open.nodes);
      }
    }
  });
});
