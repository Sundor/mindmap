// Filter: what a focus keeps, the model reduced to it, and that the reduced map draws exactly
// what Focus leaves unfaded on the whole one.

import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import workItemsJson from '../../fixtures/workitems.json?raw';
import { buildFlow, type FlowGraph } from './flow';
import { FADED_CLASS, focusFlow, focusSet, type Focus, type FocusSet } from './focus';
import {
  filterToFocus,
  focusMoveTiming,
  focusScope,
  goToTiming,
  modelShows,
  submodel,
  withPlacedRows,
  type FocusScope,
} from './focusFilter';
import { computeLayoutUncached, layoutKey, rowPlacement, type LayoutResult } from './layout';
import { layoutViolations, parseOk } from './layout/test-helpers';
import type { ArchitectureModel } from './model';
import { withoutRows } from './positions';
import type { Selection } from './selection';
import { groupIds, LOD_LEVELS } from './visibility';
import { workItemContent } from './workItemContent';
import { buildWorkItemOverlay } from './workItemOverlay';
import { parseWorkItems, type WorkItemSummary, type WorkItemType } from './workitems';

const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

/** A focus set written out by hand. */
function involving(nodes: readonly string[], edges: readonly string[] = []): FocusSet {
  return { nodes: new Set(nodes), edges: new Set(edges), itemIds: new Set() };
}

function keeping(nodes: readonly string[], edges: readonly string[] = []): FocusScope {
  return { nodes: new Set(nodes), edges: new Set(edges) };
}

function flowSet(model: ArchitectureModel, id: string): FocusSet {
  const set = focusSet(model, { type: 'flow', id });
  if (!set) throw new Error(`no flow ${id}`);
  return set;
}

const ROW_KEYS = ['row', 'effectiveRow', 'rowRange'] as const;

const model = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    description: The first domain
    owner: Team A
    components:
      - id: a.x
        name: X
        subcomponents:
          - { id: a.x.one, name: One }
          - { id: a.x.two, name: Two }
      - { id: a.y, name: Y, tech: Go }
  - id: b
    name: Beta
    components:
      - { id: b.p, name: P }
      - { id: b.q, name: Q }
  - { id: c, name: Gamma }
edges:
  - { id: one-two, from: a.x.one, to: a.x.two, kind: dataflow }
  - { id: two-y, from: a.x.two, to: a.y, kind: dataflow }
  - { id: y-p, from: a.y, to: b.p, kind: control }
  - { id: p-one, from: b.p, to: a.x.one, kind: config }
  - { id: q-c, from: b.q, to: c, kind: dependency }
flows:
  - id: order
    name: Order
    edges: [one-two, two-y]
  - id: deploy
    name: Deploy
    nodes: [b]
    edges: [p-one]
  - id: handover
    name: Handover
    nodes: [a.x]
    edges: [y-p, two-y, y-p]
  - id: side
    name: Side
    edges: [q-c]
`);

function item(
  id: number,
  type: WorkItemType,
  tags: string[] = [],
  extra: Partial<WorkItemSummary> = {},
): WorkItemSummary {
  return { id, type, title: `Item ${id}`, state: 'Active', componentIds: tags, tags: [], ...extra };
}

const overlay = buildWorkItemOverlay(model, [
  item(1, 'Epic', ['a']),
  item(2, 'Feature', ['a.x'], { parentId: 1 }),
  item(3, 'User Story', ['a.x.two'], { parentId: 2 }),
  item(4, 'Task', [], { parentId: 3 }),
  item(5, 'User Story', ['b.p'], { parentId: 2 }),
  item(6, 'User Story', ['a.y', 'b.q']),
  item(7, 'User Story'),
  item(8, 'Bug', ['c']),
]);

const THREE_ROWS = `
version: 1
rows:
  - { id: top, name: Top level }
  - { id: mid, name: Middle level }
  - { id: bot, name: Bottom level }
`;

/** A spanning group over all three rows, a domain in one row, and one without a row. */
const tiered = parseOk(`${THREE_ROWS}
domains:
  - id: g
    name: G
    components:
      - { id: g.t, name: T, row: top }
      - { id: g.m, name: M, row: mid }
      - { id: g.b, name: B, row: bot }
  - id: h
    name: H
    row: mid
    components:
      - { id: h.a, name: HA }
  - id: u
    name: U
    components:
      - { id: u.a, name: UA }
edges:
  - { id: t-b, from: g.t, to: g.b, kind: dataflow }
  - { id: m-h, from: g.m, to: h.a, kind: dataflow }
  - { id: u-t, from: u.a, to: g.t, kind: control }
`);

/**
 * `s.free` has no row: its connections place it at the bottom (s.b through its child, and o,
 * against s.t at the top), and `s.free.in` with it.
 */
const attracted = parseOk(`${THREE_ROWS}
domains:
  - id: s
    name: S
    components:
      - { id: s.t, name: T, row: top }
      - { id: s.b, name: B, row: bot }
      - id: s.free
        name: Free
        description: Placed by its connections
        owner: Team S
        subcomponents:
          - { id: s.free.in, name: In }
  - { id: o, name: O, row: bot }
edges:
  - { id: f-b, from: s.free.in, to: s.b, kind: dataflow }
  - { id: f-o, from: s.free, to: o, kind: dataflow }
  - { id: f-t, from: s.free, to: s.t, kind: control }
flows:
  - id: up
    name: Up
    edges: [f-t, f-b]
`);

describe('focusScope', () => {
  it('of a flow: the ends of its edges and the groups around them', () => {
    const scope = focusScope(model, flowSet(model, 'order'));
    expect(sorted(scope.nodes)).toEqual(['a', 'a.x', 'a.x.one', 'a.x.two', 'a.y']);
    expect(sorted(scope.edges)).toEqual(['one-two', 'two-y']);
  });

  it('of a flow that names a group: the whole subtree of that group too', () => {
    const scope = focusScope(model, flowSet(model, 'deploy'));
    expect(sorted(scope.nodes)).toEqual(['a', 'a.x', 'a.x.one', 'b', 'b.p', 'b.q']);
    expect(sorted(scope.edges)).toEqual(['p-one']);
  });

  it('of a work item: the nodes that show it or what is under it, around and inside them', () => {
    const set = focusSet(model, { type: 'workitem', id: 2 }, overlay);
    if (!set) throw new Error('no set');
    const scope = focusScope(model, set);
    expect(sorted(scope.nodes)).toEqual(['a', 'a.x', 'a.x.one', 'a.x.two', 'b', 'b.p']);
    expect(sorted(scope.edges)).toEqual(['one-two', 'p-one']);
  });

  it('ignores node ids the model does not have', () => {
    const scope = focusScope(model, involving(['nope', 'a.y', 'a.x.nope']));
    expect(sorted(scope.nodes)).toEqual(['a', 'a.y']);
    expect(focusScope(model, involving(['nope'])).nodes.size).toBe(0);
  });

  it('leaves out an edge of the set with an end outside the nodes, or unknown', () => {
    // y-p ends at b.p and two-y starts at a.x.two: neither is among the nodes.
    expect(focusScope(model, involving(['a.y'], ['y-p', 'two-y'])).edges.size).toBe(0);
    const scope = focusScope(model, involving(['a.y', 'b.p'], ['y-p', 'two-y', 'nope']));
    expect(sorted(scope.edges)).toEqual(['y-p']);
  });
});

describe('submodel', () => {
  it('keeps the nodes in document order, with the children and domains that are left', () => {
    const { model: reduced, placedRow } = submodel(
      model,
      focusScope(model, flowSet(model, 'order')),
    );
    expect([...reduced.nodes.keys()]).toEqual(['a', 'a.x', 'a.x.one', 'a.x.two', 'a.y']);
    expect(reduced.rootIds).toEqual(['a']);
    expect(reduced.nodes.get('a')?.childIds).toEqual(['a.x', 'a.y']);
    expect(reduced.version).toBe(1);
    expect(reduced.rows).toEqual([]);
    expect(placedRow.size).toBe(0);
    // Everything else about a node is what it was.
    expect(reduced.nodes.get('a')).toEqual(model.nodes.get('a'));
    expect(reduced.nodes.get('a.y')).toEqual(model.nodes.get('a.y'));
  });

  it('drops a node whose parent is not kept, with everything below it', () => {
    const { model: reduced } = submodel(model, keeping(['a', 'a.x.one', 'a.x.two', 'a.y', 'b.p']));
    expect([...reduced.nodes.keys()]).toEqual(['a', 'a.y']);
    expect(reduced.nodes.get('a')?.childIds).toEqual(['a.y']);
    expect(reduced.rootIds).toEqual(['a']);
  });

  it('keeps only the listed edges with both ends kept: the same objects, in model order', () => {
    const { model: reduced } = submodel(
      model,
      keeping(
        ['a', 'a.x', 'a.x.one', 'a.x.two', 'a.y', 'b', 'b.p', 'b.q'],
        ['q-c', 'p-one', 'nope', 'one-two'],
      ),
    );
    expect(reduced.edges.map((edge) => edge.id)).toEqual(['one-two', 'p-one']);
    for (const edge of reduced.edges) expect(model.edges).toContain(edge);
  });

  it('lists only the kept children of a group kept as an ancestor, which stays a group', () => {
    const { model: reduced } = submodel(model, focusScope(model, flowSet(model, 'deploy')));
    expect(reduced.nodes.get('a')?.childIds).toEqual(['a.x']);
    expect(reduced.nodes.get('a.x')?.childIds).toEqual(['a.x.one']);
    expect(groupIds(reduced)).toEqual(['a', 'a.x', 'b']);
  });

  it('keeps the whole subtree of an involved group', () => {
    const { model: reduced } = submodel(model, focusScope(model, flowSet(model, 'deploy')));
    expect(reduced.nodes.get('b')).toEqual(model.nodes.get('b'));
    expect(reduced.nodes.get('b')?.childIds).toEqual(['b.p', 'b.q']);
  });

  it('trims the flows to the kept edges and nodes, and drops a flow left with neither', () => {
    const { model: reduced } = submodel(model, focusScope(model, flowSet(model, 'handover')));
    expect(reduced.edges.map((edge) => edge.id)).toEqual(['two-y', 'y-p']);
    expect(reduced.flows).toEqual([
      { id: 'order', name: 'Order', kind: 'workflow', edgeIds: ['two-y'], nodeIds: [] },
      // b is kept as the group around b.p; the flow's own edge is not.
      { id: 'deploy', name: 'Deploy', kind: 'workflow', edgeIds: [], nodeIds: ['b'] },
      // Order and repeats of the steps are kept.
      {
        id: 'handover',
        name: 'Handover',
        kind: 'workflow',
        edgeIds: ['y-p', 'two-y', 'y-p'],
        nodeIds: ['a.x'],
      },
    ]);
  });

  it('returns the model itself when every node and edge is kept', () => {
    const everything = keeping(
      [...model.nodes.keys(), 'nope'],
      [...model.edges.map((edge) => edge.id), 'nope'],
    );
    const result = submodel(model, everything);
    expect(result.model).toBe(model);
    expect(result.placedRow.size).toBe(0);
    const withRows = submodel(
      attracted,
      keeping(
        [...attracted.nodes.keys()],
        attracted.edges.map((edge) => edge.id),
      ),
    );
    expect(withRows.model).toBe(attracted);
    expect(withRows.placedRow.size).toBe(0);
    // The same nodes with an edge less is another model.
    const fewer = submodel(model, keeping([...model.nodes.keys()], ['one-two']));
    expect(fewer.model).not.toBe(model);
    expect([...fewer.model.nodes.keys()]).toEqual([...model.nodes.keys()]);
    expect(fewer.model.edges.map((edge) => edge.id)).toEqual(['one-two']);
  });

  it('does not change the model or the placement it is given', () => {
    for (const whole of [model, tiered, attracted]) {
      const placement = rowPlacement(whole);
      const before = structuredClone({ whole, placement });
      for (const flow of whole.flows) {
        submodel(whole, focusScope(whole, flowSet(whole, flow.id)), placement);
      }
      for (const id of whole.nodes.keys()) {
        submodel(whole, focusScope(whole, involving([id])), placement);
      }
      expect({ whole, placement }).toEqual(before);
    }
  });
});

describe('submodel with rows', () => {
  it('drops a row left empty and counts the row ranges in the rows that remain', () => {
    const { model: reduced } = submodel(tiered, keeping(['g', 'g.t', 'g.b'], ['t-b']));
    expect(reduced.rows.map((row) => row.id)).toEqual(['top', 'bot']);
    for (const row of reduced.rows) expect(tiered.rows).toContain(row);
    expect(tiered.nodes.get('g')?.rowRange).toEqual({ top: 0, bottom: 2 });
    expect(reduced.nodes.get('g')?.rowRange).toEqual({ top: 0, bottom: 1 });
    expect(reduced.nodes.get('g.t')).toEqual(tiered.nodes.get('g.t'));
    expect(reduced.nodes.get('g.b')).toEqual({
      ...tiered.nodes.get('g.b'),
      rowRange: { top: 1, bottom: 1 },
    });
  });

  it('has no rows and no row on any node when no row is left', () => {
    const { model: reduced, placedRow } = submodel(tiered, keeping(['u', 'u.a']));
    expect(reduced.rows).toEqual([]);
    expect(placedRow.size).toBe(0);
    for (const node of reduced.nodes.values()) {
      for (const key of ROW_KEYS) expect(key in node).toBe(false);
    }
  });

  it('leaves a domain without a row anywhere inside it row-less', async () => {
    const { model: reduced, placedRow } = submodel(
      tiered,
      keeping(['g', 'g.t', 'u', 'u.a'], ['u-t']),
    );
    expect(reduced.rows.map((row) => row.id)).toEqual(['top']);
    expect(placedRow.size).toBe(0);
    for (const id of ['u', 'u.a']) {
      for (const key of ROW_KEYS) expect(key in (reduced.nodes.get(id) ?? {})).toBe(false);
    }
    const layout = await computeLayoutUncached(reduced);
    expect(layoutViolations(reduced, layout)).toEqual([]);
    expect(layout.unassignedArea).toBeDefined();
    expect(layout.rowOf.has('u')).toBe(false);
  });

  it('assigns a row-less child that is all a spanning group keeps to the row the whole map places it in', async () => {
    expect([...rowPlacement(attracted).placedRow]).toEqual([['s.free', 'bot']]);
    const { model: reduced, placedRow } = submodel(
      attracted,
      keeping(['s', 's.free', 's.free.in']),
    );
    expect([...placedRow]).toEqual([['s.free', 'bot']]);
    expect(reduced.rows.map((row) => row.id)).toEqual(['bot']);
    expect(reduced.nodes.get('s.free')).toMatchObject({
      row: 'bot',
      effectiveRow: 'bot',
      rowRange: { top: 0, bottom: 0 },
    });
    // The group still spans: it has no row of its own, only the one its child is in.
    const group = reduced.nodes.get('s');
    expect(group?.rowRange).toEqual({ top: 0, bottom: 0 });
    expect(group && 'effectiveRow' in group).toBe(false);

    const layout = await computeLayoutUncached(reduced);
    expect(layoutViolations(reduced, layout)).toEqual([]);
    expect(layout.rows.map((band) => band.id)).toEqual(['bot']);
    expect(layout.unassignedArea).toBeUndefined();
    expect(layout.rowOf.get('s.free')).toBe('bot');
    // Assigned, so the layout of the reduced model derives nothing from connections.
    expect(layout.placedRow.size).toBe(0);

    // Left row-less, nothing below the group would have a row: it would be unassigned.
    const unpinned = parseOk(`${THREE_ROWS}
domains:
  - id: s
    name: S
    components:
      - id: s.free
        name: Free
        subcomponents:
          - { id: s.free.in, name: In }
`);
    expect(unpinned.nodes.get('s')?.rowRange).toBeUndefined();
  });

  it('keeps a row-less child in the row of the whole map when the edges that are left would place it elsewhere', async () => {
    const whole = await computeLayoutUncached(attracted);
    expect(whole.rowOf.get('s.free')).toBe('bot');
    const { model: reduced, placedRow } = submodel(
      attracted,
      keeping(['s', 's.t', 's.free', 's.free.in'], ['f-t']),
    );
    expect([...placedRow]).toEqual([['s.free', 'bot']]);
    expect(reduced.rows.map((row) => row.id)).toEqual(['top', 'bot']);
    // What lies inside the assigned node inherits its row.
    const inner = reduced.nodes.get('s.free.in');
    expect(inner).toMatchObject({ effectiveRow: 'bot', rowRange: { top: 1, bottom: 1 } });
    expect(inner && 'row' in inner).toBe(false);

    const layout = await computeLayoutUncached(reduced);
    expect(layoutViolations(reduced, layout)).toEqual([]);
    for (const id of reduced.nodes.keys()) expect(layout.rowOf.get(id)).toBe(whole.rowOf.get(id));
    expect(layout.placedRow.size).toBe(0);

    // With the one edge that is left, its connections alone would pull it to the top.
    const unpinned = parseOk(`
version: 1
rows:
  - { id: top, name: Top level }
  - { id: bot, name: Bottom level }
domains:
  - id: s
    name: S
    components:
      - { id: s.t, name: T, row: top }
      - id: s.free
        name: Free
        subcomponents:
          - { id: s.free.in, name: In }
edges:
  - { id: f-t, from: s.free, to: s.t, kind: control }
`);
    expect(rowPlacement(unpinned).placedRow.get('s.free')).toBe('top');
  });

  it('equals the model of the reduced file, written with the row on the node placed by connections', () => {
    const { model: reduced } = submodel(
      attracted,
      keeping(['s', 's.t', 's.free', 's.free.in'], ['f-t']),
    );
    const written = parseOk(`
version: 1
rows:
  - { id: top, name: Top level }
  - { id: bot, name: Bottom level }
domains:
  - id: s
    name: S
    components:
      - { id: s.t, name: T, row: top }
      - id: s.free
        name: Free
        description: Placed by its connections
        owner: Team S
        row: bot
        subcomponents:
          - { id: s.free.in, name: In }
edges:
  - { id: f-t, from: s.free, to: s.t, kind: control }
flows:
  - id: up
    name: Up
    edges: [f-t]
`);
    expect(reduced).toEqual(written);
    expect([...reduced.nodes.keys()]).toEqual([...written.nodes.keys()]);
    for (const [id, node] of written.nodes) {
      expect(Object.keys(reduced.nodes.get(id) ?? {}).sort()).toEqual(Object.keys(node).sort());
    }
    expect(layoutKey(reduced)).toBe(layoutKey(written));
  });
});

describe('filterToFocus', () => {
  it('is the model reduced to the scope of the focus', () => {
    const set = flowSet(model, 'order');
    const filtered = filterToFocus(model, set);
    expect(filtered).toEqual(submodel(model, focusScope(model, set)));
    expect(filtered?.model).not.toBe(model);
  });

  it('gives the same with the placement of the whole model handed in', () => {
    const set = involving(['s.free'], ['f-t']);
    const filtered = filterToFocus(attracted, set, rowPlacement(attracted));
    expect(filtered).toEqual(filterToFocus(attracted, set));
    expect([...(filtered?.placedRow ?? [])]).toEqual([['s.free', 'bot']]);
  });

  it('is undefined for a focus that involves no node of the model', () => {
    expect(filterToFocus(model, involving([]))).toBeUndefined();
    expect(filterToFocus(model, involving(['nope'], ['one-two']))).toBeUndefined();
    // An item tagged to nothing.
    const set = focusSet(model, { type: 'workitem', id: 7 }, overlay);
    expect(set?.nodes.size).toBe(0);
    expect(set && filterToFocus(model, set)).toBeUndefined();
  });

  it('is undefined for a focus that leaves nothing out', () => {
    const all = involving(
      model.rootIds,
      model.edges.map((edge) => edge.id),
    );
    expect(filterToFocus(model, all)).toBeUndefined();
    // One edge less is something to leave out.
    expect(filterToFocus(model, involving(model.rootIds, ['one-two']))?.model.edges).toHaveLength(
      1,
    );
  });
});

describe('withPlacedRows', () => {
  const layout: LayoutResult = {
    key: 'k',
    rects: new Map([['n', { x: 0, y: 0, width: 10, height: 10 }]]),
    absolute: new Map([['n', { x: 0, y: 0, width: 10, height: 10 }]]),
    rows: [{ id: 'bot', name: 'Bottom level', x: 0, y: 0, width: 100, height: 50 }],
    gutterWidth: 20,
    bounds: { width: 100, height: 50 },
    placedRow: new Map(),
    rowOf: new Map([['n', 'bot']]),
    content: new Map(),
  };
  const placed = new Map([['n', 'bot']]);

  it('returns the layout itself for no placed rows, or a layout without row bands', () => {
    expect(withPlacedRows(layout, new Map())).toBe(layout);
    const plain: LayoutResult = { ...layout, rows: [] };
    expect(withPlacedRows(plain, placed)).toBe(plain);
  });

  it('otherwise changes nothing but the placed rows', () => {
    const marked = withPlacedRows(layout, placed);
    expect(marked).toEqual({ ...layout, placedRow: placed });
    for (const key of ['rects', 'absolute', 'rows', 'bounds', 'rowOf', 'content'] as const) {
      expect(marked[key]).toBe(layout[key]);
    }
    expect(layout.placedRow.size).toBe(0);
    // What the layout derived itself stays.
    const own: LayoutResult = { ...layout, placedRow: new Map([['m', 'top']]) };
    expect([...withPlacedRows(own, placed).placedRow]).toEqual([
      ['m', 'top'],
      ['n', 'bot'],
    ]);
  });
});

describe('modelShows', () => {
  const reduced = submodel(model, focusScope(model, flowSet(model, 'order'))).model;

  it('a node or an edge the model has', () => {
    expect(modelShows(reduced, { type: 'node', id: 'a.y' })).toBe(true);
    expect(modelShows(reduced, { type: 'node', id: 'b.p' })).toBe(false);
    expect(modelShows(reduced, { type: 'edge', id: 'one-two' })).toBe(true);
    expect(modelShows(reduced, { type: 'edge', id: 'y-p' })).toBe(false);
    // Separate namespaces.
    expect(modelShows(reduced, { type: 'edge', id: 'a.y' })).toBe(false);
    expect(modelShows(model, { type: 'node', id: 'b.p' })).toBe(true);
  });

  it('a work item when the model has one of the nodes that list it, or no node lists it', () => {
    expect(modelShows(reduced, { type: 'workitem', id: 3 }, overlay)).toBe(true);
    // Listed on a.y, which is kept, and on b.q, which is not.
    expect(modelShows(reduced, { type: 'workitem', id: 6 }, overlay)).toBe(true);
    // A task listed under item 3, on that item's node.
    expect(modelShows(reduced, { type: 'workitem', id: 4 }, overlay)).toBe(true);
    // Only on nodes that are left out.
    expect(modelShows(reduced, { type: 'workitem', id: 5 }, overlay)).toBe(false);
    expect(modelShows(reduced, { type: 'workitem', id: 8 }, overlay)).toBe(false);
    expect(modelShows(model, { type: 'workitem', id: 8 }, overlay)).toBe(true);
    // Tagged to nothing, unknown, or no work items at all: no node could show it.
    expect(modelShows(reduced, { type: 'workitem', id: 7 }, overlay)).toBe(true);
    expect(modelShows(reduced, { type: 'workitem', id: 99 }, overlay)).toBe(true);
    expect(modelShows(reduced, { type: 'workitem', id: 5 })).toBe(true);
  });

  it('always a flow or an aggregate', () => {
    expect(reduced.flows.map((flow) => flow.id)).not.toContain('deploy');
    expect(modelShows(reduced, { type: 'flow', id: 'deploy' })).toBe(true);
    expect(modelShows(reduced, { type: 'aggregate', id: 'b>c:dependency' })).toBe(true);
  });
});

describe('goToTiming', () => {
  // Reduced to a, a.x, a.x.one, a.x.two and a.y; and to b, b.q and c.
  const order = submodel(model, focusScope(model, flowSet(model, 'order'))).model;
  const side = submodel(model, focusScope(model, flowSet(model, 'side'))).model;
  const node = (id: string): Selection => ({ type: 'node', id });
  const edge = (id: string): Selection => ({ type: 'edge', id });
  const workItem = (id: number): Selection => ({ type: 'workitem', id });

  it('is now for what the map on screen has and the wanted one does not leave out', () => {
    expect(goToTiming(model, model, model, node('b.p'))).toBe('now');
    expect(goToTiming(model, order, order, node('a.y'))).toBe('now');
    expect(goToTiming(model, order, order, edge('one-two'))).toBe('now');
    // The whole map is on its way back, and the reduced one still on screen has the target.
    expect(goToTiming(model, model, order, node('a.y'))).toBe('now');
    // The reduced map is on its way, and it keeps the target.
    expect(goToTiming(model, order, model, node('a.y'))).toBe('now');
  });

  it('is to leave Filter for what the wanted map leaves out, whatever is on screen', () => {
    expect(goToTiming(model, order, order, node('b.p'))).toBe('leave');
    expect(goToTiming(model, order, order, edge('y-p'))).toBe('leave');
    // While the reduced map is on its way: the whole one on screen has the target, and goes.
    expect(goToTiming(model, order, model, node('b.p'))).toBe('leave');
    // Another focus is on its way, and the target is on the map that goes.
    expect(goToTiming(model, side, order, node('a.y'))).toBe('leave');
    expect(goToTiming(model, order, undefined, node('c'))).toBe('leave');
  });

  it('is to wait when only the map on screen leaves it out', () => {
    // Filter was left, or the focus cleared: the whole map has not arrived yet.
    expect(goToTiming(model, model, order, node('b.p'))).toBe('wait');
    expect(goToTiming(model, model, order, edge('q-c'))).toBe('wait');
    // Another focus was chosen, whose map has the target.
    expect(goToTiming(model, side, order, node('b.q'))).toBe('wait');
  });

  it('judges a work item by the nodes that list it', () => {
    // Listed on b.p only; on a.y and b.q; on no node at all.
    expect(goToTiming(model, order, order, workItem(5), overlay)).toBe('leave');
    expect(goToTiming(model, model, order, workItem(5), overlay)).toBe('wait');
    expect(goToTiming(model, order, order, workItem(6), overlay)).toBe('now');
    expect(goToTiming(model, side, order, workItem(6), overlay)).toBe('now');
    expect(goToTiming(model, order, order, workItem(7), overlay)).toBe('now');
    // Without the work items nothing says where it is listed.
    expect(goToTiming(model, order, order, workItem(5))).toBe('now');
  });

  it('is now for what no map can leave out, or the structure does not have', () => {
    expect(goToTiming(model, order, order, { type: 'flow', id: 'side' })).toBe('now');
    expect(goToTiming(model, order, order, { type: 'aggregate', id: 'b>c:dependency' })).toBe(
      'now',
    );
    expect(goToTiming(model, order, order, node('nope'))).toBe('now');
    expect(goToTiming(model, order, order, edge('nope'))).toBe('now');
  });

  it('is now while no map is wanted or drawn', () => {
    expect(goToTiming(model, undefined, undefined, node('b.p'))).toBe('now');
    expect(goToTiming(model, model, undefined, node('b.p'))).toBe('now');
  });
});

describe('focusMoveTiming', () => {
  const order: Focus = { type: 'flow', id: 'order' };
  const side: Focus = { type: 'flow', id: 'side' };

  it('is now when the map that shows the focus is on screen', () => {
    // The whole map, for a focus that pales the rest or leaves nothing out.
    expect(focusMoveTiming(order, false, undefined)).toBe('now');
    // The map reduced to it, chosen again.
    expect(focusMoveTiming(order, true, order)).toBe('now');
  });

  it('is fitted for a map reduced to the focus that is yet to arrive', () => {
    expect(focusMoveTiming(order, true, undefined)).toBe('fitted');
    expect(focusMoveTiming(order, true, side)).toBe('fitted');
    // A flow and a work item are different focuses, whatever their ids.
    expect(focusMoveTiming({ type: 'workitem', id: 1 }, true, { type: 'flow', id: '1' })).toBe(
      'fitted',
    );
  });

  it('is to wait for the whole map while a reduced one is on screen', () => {
    expect(focusMoveTiming(order, false, side)).toBe('wait');
    // Also the map reduced to this very focus: Filter was switched off, the whole map is not back.
    expect(focusMoveTiming(order, false, order)).toBe('wait');
  });
});

describe('Filter on examples/architecture.yaml', () => {
  const example = parseOk(exampleYaml);
  const workItems = buildWorkItemOverlay(example, parseWorkItems(workItemsJson).items);
  const placement = rowPlacement(example);
  const setOf = (focus: Focus): FocusSet => {
    const set = focusSet(example, focus, workItems);
    if (!set) throw new Error(`no ${focus.type} ${focus.id}`);
    return set;
  };
  const flows = example.flows.map((flow): Focus => ({ type: 'flow', id: flow.id }));
  const everyFocus: Focus[] = [
    ...flows,
    ...[...workItems.byId.keys()].map((id): Focus => ({ type: 'workitem', id })),
  ];
  const reducedTo = (focus: Focus): ArchitectureModel => {
    const filtered = filterToFocus(example, setOf(focus), placement);
    if (!filtered) throw new Error(`${focus.type} ${focus.id} does not filter`);
    return filtered.model;
  };

  let whole: LayoutResult;
  /** The layouts of the reduced models, by key: several focuses reduce the map to the same part. */
  const layouts = new Map<string, Promise<LayoutResult>>();
  const layoutOf = (reduced: ArchitectureModel): Promise<LayoutResult> => {
    const key = layoutKey(reduced);
    const known = layouts.get(key) ?? computeLayoutUncached(reduced, key);
    layouts.set(key, known);
    return known;
  };
  beforeAll(async () => {
    whole = await computeLayoutUncached(example);
  });

  it('reduces the map for every focus that involves a node, and none involves everything', () => {
    const filtering = everyFocus.filter((focus) => filterToFocus(example, setOf(focus), placement));
    const others = everyFocus.filter((focus) => !filtering.includes(focus));
    expect(filtering.length).toBeGreaterThan(flows.length);
    expect(others.length).toBeGreaterThan(0);
    for (const focus of others) expect(focusScope(example, setOf(focus)).nodes.size).toBe(0);
    for (const focus of flows) expect(filtering).toContain(focus);
  });

  it('keeps the expected part for the flows and two work items', async () => {
    expect([...placement.placedRow]).toEqual([
      ['operations.alerts', 'backoffice'],
      ['data.analytics.feature-store', 'middle'],
    ]);
    const all = ['backoffice', 'middle', 'channels'];
    const cases: {
      focus: Focus;
      involved: number;
      nodes: number;
      edges: number;
      rows: string[];
      bounds: { width: number; height: number };
      placedRow?: [string, string][];
    }[] = [
      {
        focus: { type: 'flow', id: 'telemetry-to-dashboards' },
        involved: 8,
        nodes: 14,
        edges: 7,
        rows: all,
        bounds: { width: 1074, height: 560 },
      },
      {
        focus: { type: 'flow', id: 'campaign-run' },
        involved: 7,
        nodes: 11,
        edges: 5,
        rows: all,
        bounds: { width: 873, height: 612 },
      },
      {
        focus: { type: 'flow', id: 'rule-release' },
        involved: 3,
        nodes: 7,
        edges: 2,
        rows: ['backoffice', 'middle'],
        bounds: { width: 592, height: 416 },
      },
      {
        focus: { type: 'workitem', id: 1001 },
        involved: 7,
        nodes: 23,
        edges: 13,
        rows: all,
        bounds: { width: 1336, height: 740 },
        placedRow: [['data.analytics.feature-store', 'middle']],
      },
      {
        focus: { type: 'workitem', id: 1046 },
        involved: 1,
        nodes: 2,
        edges: 0,
        rows: ['backoffice'],
        bounds: { width: 400, height: 156 },
        placedRow: [['operations.alerts', 'backoffice']],
      },
    ];
    for (const expected of cases) {
      const label = `${expected.focus.type} ${expected.focus.id}`;
      const set = setOf(expected.focus);
      const filtered = filterToFocus(example, set, placement);
      if (!filtered) throw new Error(`${label} does not filter`);
      expect(set.nodes.size, label).toBe(expected.involved);
      expect(filtered.model.nodes.size, label).toBe(expected.nodes);
      expect(filtered.model.edges.length, label).toBe(expected.edges);
      expect(
        filtered.model.rows.map((row) => row.id),
        label,
      ).toEqual(expected.rows);
      expect([...filtered.placedRow], label).toEqual(expected.placedRow ?? []);
      expect((await layoutOf(filtered.model)).bounds, label).toEqual(expected.bounds);
    }
  });

  it('takes the plain layout when only unassigned nodes are kept', async () => {
    const reduced = reducedTo({ type: 'workitem', id: 1055 });
    expect(reduced.rows).toEqual([]);
    expect(sorted(reduced.rootIds)).toEqual(['platform']);
    const layout = await layoutOf(reduced);
    expect(layout.rows).toEqual([]);
    expect(layout.unassignedArea).toBeUndefined();
  });

  it('keeps every node in its row and gives a valid layout, for every focus that filters', async () => {
    const content = workItemContent(workItems, 'tasks');
    const checked = new Set<string>();
    for (const focus of everyFocus) {
      const label = `${focus.type} ${focus.id}`;
      const filtered = filterToFocus(example, setOf(focus), placement);
      if (!filtered) continue;
      const reduced = filtered.model;
      const key = layoutKey(reduced);
      expect(key, label).not.toBe(whole.key);
      expect(layoutKey(reducedTo(focus)), label).toBe(key);
      if (checked.has(key)) continue;
      checked.add(key);

      const layout = await layoutOf(reduced);
      expect(layout.key, label).toBe(key);
      expect(layoutViolations(reduced, layout), label).toEqual([]);
      for (const id of reduced.nodes.keys()) {
        expect(layout.rowOf.get(id), `${label}: ${id}`).toBe(whole.rowOf.get(id));
      }
      // Every node the whole map places by its connections is assigned in the reduced model.
      expect(layout.placedRow.size, label).toBe(0);
      // … and marked as on the whole map once the layout is told so.
      const marked = withPlacedRows(layout, filtered.placedRow);
      for (const id of reduced.nodes.keys()) {
        expect(marked.placedRow.get(id), `${label}: ${id}`).toBe(whole.placedRow.get(id));
      }

      const plain = withoutRows(reduced);
      expect(layoutViolations(plain, await computeLayoutUncached(plain)), label).toEqual([]);
      const withContent = await computeLayoutUncached(reduced, undefined, content);
      expect(layoutViolations(reduced, withContent), label).toEqual([]);
    }
    expect(checked.size).toBeGreaterThan(flows.length);
  }, 60_000);

  it('draws exactly what Focus leaves unfaded, at every level of detail and collapse', async () => {
    const groups = groupIds(example);
    // Nothing, everything, the groups inside the domains, and every second group.
    const collapsedSets: ReadonlySet<string>[] = [
      new Set(),
      new Set(groups),
      new Set(groups.filter((id) => !example.rootIds.includes(id))),
      new Set(groups.filter((_, index) => index % 2 === 0)),
    ];
    /** The model nodes and the rendered edges of `flow` that are not paled. */
    const unfaded = (flow: FlowGraph): { nodes: string[]; edges: string[] } => ({
      nodes: flow.nodes
        .filter((node) => node.type !== 'band' && !node.className?.includes(FADED_CLASS))
        .map((node) => node.id),
      edges: sorted(
        flow.edges.filter((edge) => !edge.className.includes(FADED_CLASS)).map((edge) => edge.id),
      ),
    });
    const focuses: Focus[] = [
      ...flows,
      ...[1001, 1003, 1033, 1046].map((id): Focus => ({ type: 'workitem', id })),
    ];
    for (const lodLevel of LOD_LEVELS) {
      for (const collapsedIds of collapsedSets) {
        const view = { lodLevel, collapsedIds };
        const wholeFlow = buildFlow(example, whole, view);
        for (const focus of focuses) {
          const label = `${focus.type} ${focus.id} at ${lodLevel}, ${collapsedIds.size} collapsed`;
          const set = setOf(focus);
          const reduced = reducedTo(focus);
          const drawn = buildFlow(reduced, await layoutOf(reduced), view);
          const everything = unfaded(drawn);
          // The nodes are in document order on both maps.
          expect(everything, label).toEqual(unfaded(focusFlow(example, wholeFlow, set)));
          expect(everything.nodes.length, label).toBeGreaterThan(0);
          // Nothing is left to pale on the reduced map.
          expect(unfaded(focusFlow(example, drawn, set)), label).toEqual(everything);
        }
      }
    }
  });
});
