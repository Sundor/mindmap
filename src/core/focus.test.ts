import { describe, expect, it } from 'vitest';
import {
  buildFlow,
  computeLayoutUncached,
  FADED_CLASS,
  flowsOfEdge,
  flowsOfNode,
  FOCUS_MODES,
  focusFlow,
  focusSet,
  isFocusMode,
  buildWorkItemOverlay,
  type WorkItemSummary,
  type WorkItemType,
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
  - id: order
    name: Order
    edges: [one-two, two-y]
  - id: deploy
    name: Deploy
    kind: workflow
    nodes: [b]
    edges: [p-one]
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
  item(5, 'User Story', ['b.p'], { parentId: 2, state: 'Closed' }),
  item(6, 'User Story', ['a.y']),
]);

describe('focusSet', () => {
  it('for a flow: its edges, their ends and the nodes it names', () => {
    const set = focusSet(model, { type: 'flow', id: 'deploy' });
    expect([...(set?.nodes ?? [])].sort()).toEqual(['a.x.one', 'b', 'b.p']);
    expect([...(set?.edges ?? [])]).toEqual(['p-one']);
    expect(set?.itemIds.size).toBe(0);
  });

  it('for a work item: everything under it, the nodes that show those, and the edges among them', () => {
    const set = focusSet(model, { type: 'workitem', id: 2 }, overlay);
    expect([...(set?.itemIds ?? [])].sort()).toEqual([2, 3, 4, 5]);
    expect([...(set?.nodes ?? [])].sort()).toEqual(['a.x', 'a.x.two', 'b.p']);
    // one-two lies inside a.x; p-one joins b.p with a.x.one, which lies inside a.x.
    expect([...(set?.edges ?? [])].sort()).toEqual(['one-two', 'p-one']);
  });

  it('is undefined for nothing, an unknown flow, or an item that is not loaded', () => {
    expect(focusSet(model, undefined)).toBeUndefined();
    expect(focusSet(model, { type: 'flow', id: 'nope' })).toBeUndefined();
    expect(focusSet(model, { type: 'workitem', id: 99 }, overlay)).toBeUndefined();
    expect(focusSet(model, { type: 'workitem', id: 1 })).toBeUndefined();
  });
});

describe('isFocusMode', () => {
  it('knows the two ways a focus is shown, and nothing else', () => {
    expect(FOCUS_MODES).toEqual(['focus', 'filter']);
    for (const mode of FOCUS_MODES) expect(isFocusMode(mode)).toBe(true);
    for (const other of ['Filter', 'off', '', 0, true, null, undefined, ['filter']]) {
      expect(isFocusMode(other)).toBe(false);
    }
  });
});

describe('focusFlow', async () => {
  const layout = await computeLayoutUncached(model);

  it('pales what the flow does not involve, keeping the groups around what it does', () => {
    const set = focusSet(model, { type: 'flow', id: 'order' });
    if (!set) throw new Error('set');
    const faded = focusFlow(model, buildFlow(model, layout), set);
    const fadedIds = faded.nodes
      .filter((node) => node.className?.includes(FADED_CLASS))
      .map((node) => node.id);
    expect(fadedIds.sort()).toEqual(['b', 'b.p']);
    const fadedEdges = faded.edges.filter((edge) => edge.className.includes(FADED_CLASS));
    expect(
      fadedEdges
        .map((edge) => edge.data.memberEdgeIds)
        .flat()
        .sort(),
    ).toEqual(['p-one', 'y-p']);
    expect(fadedEdges.every((edge) => edge.data.faded === true)).toBe(true);
    // Bands are never faded.
    expect(
      faded.nodes.filter((n) => n.type === 'band').every((n) => !n.className.includes(FADED_CLASS)),
    ).toBe(true);
  });

  it('lights a closed group that stands in for an involved node, and what is drawn inside an involved group', () => {
    const set = focusSet(model, { type: 'flow', id: 'deploy' });
    if (!set) throw new Error('set');
    const flow = buildFlow(model, layout, { collapsedIds: new Set(['a.x']) });
    const faded = focusFlow(model, flow, set);
    const isFaded = (id: string) =>
      faded.nodes.find((node) => node.id === id)?.className?.includes(FADED_CLASS) ?? false;
    expect(isFaded('a.x')).toBe(false); // stands in for a.x.one
    expect(isFaded('a')).toBe(false); // group around it
    expect(isFaded('a.y')).toBe(true);
    expect(isFaded('b.p')).toBe(false); // inside the named node b
  });

  it('never pales what the selection is on, with the groups around it', () => {
    const set = focusSet(model, { type: 'flow', id: 'order' });
    if (!set) throw new Error('set');
    const flow = buildFlow(model, layout);
    const fadedNodes = (shown: ReturnType<typeof focusFlow>) =>
      shown.nodes
        .filter((node) => node.className?.includes(FADED_CLASS))
        .map((node) => node.id)
        .sort();
    const fadedEdges = (shown: ReturnType<typeof focusFlow>) =>
      shown.edges
        .filter((edge) => edge.className.includes(FADED_CLASS))
        .flatMap((edge) => edge.data.memberEdgeIds)
        .sort();
    // Without a selection the flow leaves Beta and its component paled.
    expect(fadedNodes(focusFlow(model, flow, set))).toEqual(['b', 'b.p']);
    // A selected node, and the group it is drawn in; its edges stay as the focus has them.
    const node = focusFlow(model, flow, set, { type: 'node', id: 'b.p' });
    expect(fadedNodes(node)).toEqual([]);
    expect(fadedEdges(node)).toEqual(['p-one', 'y-p']);
    // A selected edge, with its two ends and their groups.
    const selected = flow.edges.find((edge) => edge.data.memberEdgeIds.includes('y-p'));
    if (!selected) throw new Error('edge');
    const edge = focusFlow(model, flow, set, { type: 'edge', id: selected.id });
    expect(fadedNodes(edge)).toEqual([]);
    expect(fadedEdges(edge)).toEqual(['p-one']);
    expect(edge.edges.find((candidate) => candidate.id === selected.id)?.data.faded).not.toBe(true);
    // The nodes that show a selected work item.
    const shownBy = focusFlow(model, flow, set, { type: 'workitem', id: 5, nodeIds: ['b.p'] });
    expect(fadedNodes(shownBy)).toEqual([]);
    // A selection inside the focus changes nothing, and one that is not drawn lights nothing.
    expect(fadedNodes(focusFlow(model, flow, set, { type: 'node', id: 'a.y' }))).toEqual([
      'b',
      'b.p',
    ]);
    expect(fadedNodes(focusFlow(model, flow, set, { type: 'edge', id: 'nope' }))).toEqual([
      'b',
      'b.p',
    ]);
    // Only the group around the selected node: its other contents stay paled.
    const deploy = focusSet(model, { type: 'flow', id: 'deploy' });
    if (!deploy) throw new Error('set');
    expect(fadedNodes(focusFlow(model, flow, deploy))).toEqual(['a.x.two', 'a.y']);
    expect(fadedNodes(focusFlow(model, flow, deploy, { type: 'node', id: 'a.y' }))).toEqual([
      'a.x.two',
    ]);
    // A selected group with what is drawn inside it; the ends of an edge without their contents.
    expect(fadedNodes(focusFlow(model, flow, set, { type: 'node', id: 'b' }))).toEqual([]);
    const order = focusSet(model, { type: 'flow', id: 'order' });
    const closed = buildFlow(model, layout, { lodLevel: 'domains' });
    const between = closed.edges.find((candidate) => candidate.data.memberEdgeIds.includes('y-p'));
    if (!order || !between) throw new Error('domains');
    expect(fadedNodes(focusFlow(model, closed, order))).toEqual(['b']);
    expect(fadedNodes(focusFlow(model, closed, order, { type: 'edge', id: between.id }))).toEqual(
      [],
    );
    const edgeAtGroup = focusFlow(model, flow, deploy, {
      type: 'edge',
      id: flow.edges.find((candidate) => candidate.data.memberEdgeIds.includes('two-y'))?.id ?? '',
    });
    // two-y runs from a.x.two to a.y: both ends light up, nothing else changes.
    expect(fadedNodes(edgeAtGroup)).toEqual([]);
  });
});

describe('flowsOfNode / flowsOfEdge', () => {
  it('find the flows by named node, by edge end and by edge', () => {
    expect(flowsOfNode(model, 'b').map((f) => f.id)).toEqual(['deploy']);
    expect(flowsOfNode(model, 'a.x.one').map((f) => f.id)).toEqual(['order', 'deploy']);
    expect(flowsOfNode(model, 'a').map((f) => f.id)).toEqual([]);
    expect(flowsOfEdge(model, 'two-y').map((f) => f.id)).toEqual(['order']);
    expect(flowsOfEdge(model, 'y-p')).toEqual([]);
  });
});
