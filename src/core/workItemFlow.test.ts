// Work items on the canvas: what `buildFlow` puts on the nodes, and selecting a work item.

import { beforeAll, describe, expect, it } from 'vitest';
import { buildFlow, type ArchFlowNode, type FlowGraph, type FlowView } from './flow';
import { computeLayoutUncached, HEADER_HEIGHT, LEAF_SIZE, type LayoutResult } from './layout';
import { parseOk } from './layout/test-helpers';
import {
  DIMMED_CLASS,
  highlightFlow,
  neighbourhood,
  renderedSelection,
  resolveSelection,
  sameSelection,
  selectionExists,
  workItemDrawnOn,
  type Selection,
} from './selection';
import { workItemContent } from './workItemContent';
import { buildWorkItemOverlay } from './workItemOverlay';
import type { StoryMode, WorkItemSummary, WorkItemType } from './workitems';

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
      - { id: b.z, name: Z }
edges:
  - { id: e1, from: a.x.one, to: a.y, kind: dataflow }
  - { id: e2, from: a.y, to: b.z, kind: dependency }
`);

function item(
  id: number,
  type: WorkItemType,
  tags: string[] = [],
  extra: Partial<WorkItemSummary> = {},
): WorkItemSummary {
  return { id, type, title: `Item ${id}`, state: 'Active', componentIds: tags, tags: [], ...extra };
}

const ITEMS = [
  item(1, 'User Story', ['a']),
  item(2, 'User Story', ['a.x']),
  item(3, 'User Story', ['a.x.one', 'b.z']),
  item(4, 'Task', [], { parentId: 3, title: 'Send the device signals with every event' }),
  item(5, 'Bug', ['a.x.two']),
  item(6, 'Bug', ['a.y'], { state: 'Closed' }),
  item(7, 'User Story'),
];

const overlay = buildWorkItemOverlay(model, ITEMS);

function archNode(flow: FlowGraph, id: string): ArchFlowNode {
  const node = flow.nodes.find((n) => n.id === id);
  if (!node || node.type === 'band') throw new Error(`no node ${id}`);
  return node;
}

describe('buildFlow with work items', () => {
  const layouts = new Map<StoryMode, LayoutResult>();
  beforeAll(async () => {
    for (const mode of ['off', 'stories', 'tasks'] as const) {
      layouts.set(
        mode,
        await computeLayoutUncached(model, undefined, workItemContent(overlay, mode)),
      );
    }
  });
  const flowOf = (mode: StoryMode, view: FlowView = {}): FlowGraph => {
    const layout = layouts.get(mode);
    if (!layout) throw new Error('no layout');
    return buildFlow(model, layout, { ...view, workItems: { overlay, mode } });
  };

  it('draws the lines at the detail level on leaves and open groups, in the reserved block', () => {
    const flow = flowOf('stories');
    const leaf = archNode(flow, 'a.x.one');
    expect(leaf.data.workItems?.lines.map((line) => line.text)).toEqual(['Item 3']);
    expect(leaf.data.workItems?.rect).toEqual({
      x: 0,
      y: LEAF_SIZE[2].height,
      width: leaf.width,
      height: layouts.get('stories')?.content.get('a.x.one')?.height,
    });
    expect(leaf.data.badge).toBeUndefined();
    const group = archNode(flow, 'a');
    expect(group.data.workItems?.lines.map((line) => line.text)).toEqual(['Item 1']);
    expect(group.data.workItems?.rect).toMatchObject({
      x: 0,
      y: HEADER_HEIGHT,
      width: group.width,
    });
    // A node without items of its own has neither lines nor a badge.
    expect(archNode(flow, 'b').data.workItems).toBeUndefined();
    expect(archNode(flow, 'b').data.badge).toBeUndefined();
  });

  it('adds the tasks in mode Stories + Tasks, as their first words', () => {
    const lines = archNode(flowOf('tasks'), 'b.z').data.workItems?.lines ?? [];
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ['item', 'Item 3'],
      ['task', 'Send the device…'],
    ]);
    expect(archNode(flowOf('stories'), 'b.z').data.workItems?.lines).toHaveLength(1);
  });

  it('shows nothing about work items in mode Off, or without work items', () => {
    const layout = layouts.get('off');
    if (!layout) throw new Error('no layout');
    const plain = buildFlow(model, layout, { collapsedIds: new Set(['a']) });
    for (const flow of [flowOf('off', { collapsedIds: new Set(['a']) }), plain]) {
      for (const node of flow.nodes) {
        if (node.type === 'band') continue;
        expect(node.data.workItems).toBeUndefined();
        expect(node.data.badge).toBeUndefined();
        expect(node.data.counts.stories).toBeUndefined();
        expect(node.data.counts.openBugs).toBeUndefined();
      }
    }
    // Mode Off is exactly the flow without work items.
    expect(flowOf('off', { collapsedIds: new Set(['a']) })).toEqual(plain);
  });

  it('gives a closed group a badge counting everything inside it', () => {
    const flow = flowOf('tasks', { collapsedIds: new Set(['a.x']) });
    const closed = archNode(flow, 'a.x');
    expect(closed.data.collapsed).toBe(true);
    expect(closed.data.workItems).toBeUndefined();
    expect(closed.data.badge).toEqual({ stories: 3, openBugs: 1 });
    expect(closed.data.counts).toEqual({ children: 2, descendants: 2, stories: 3, openBugs: 1 });
    // Its open parent still lists its own item, and carries the counts of the whole subtree.
    expect(archNode(flow, 'a').data.workItems?.lines).toHaveLength(1);
    expect(archNode(flow, 'a').data.counts).toMatchObject({ stories: 5, openBugs: 1 });
  });

  it('shows badges instead of lines at the coarser levels', () => {
    const subcomponents = flowOf('tasks', { lodLevel: 'subcomponents' });
    for (const node of subcomponents.nodes) {
      if (node.type !== 'band') expect(node.data.workItems).toBeUndefined();
    }
    // Open groups count their own items, leaves theirs.
    expect(archNode(subcomponents, 'a').data.badge).toEqual({ stories: 1, openBugs: 0 });
    expect(archNode(subcomponents, 'a.x').data.badge).toEqual({ stories: 1, openBugs: 0 });
    expect(archNode(subcomponents, 'a.x.two').data.badge).toEqual({ stories: 1, openBugs: 1 });
    // A closed bug is a story-count, not an open bug.
    expect(archNode(subcomponents, 'a.y').data.badge).toEqual({ stories: 1, openBugs: 0 });
    expect(archNode(subcomponents, 'b').data.badge).toBeUndefined();

    const components = flowOf('tasks', { lodLevel: 'components' });
    expect(archNode(components, 'a.x').data.badge).toEqual({ stories: 3, openBugs: 1 });
    expect(archNode(components, 'a').data.badge).toEqual({ stories: 1, openBugs: 0 });

    const domains = flowOf('tasks', { lodLevel: 'domains' });
    expect(archNode(domains, 'a').data.badge).toEqual({ stories: 5, openBugs: 1 });
    expect(archNode(domains, 'b').data.badge).toEqual({ stories: 1, openBugs: 0 });
  });

  it('never moves or resizes a node for the level or for collapsing', () => {
    const box = (flow: FlowGraph, id: string) => {
      const { position, width, height } = archNode(flow, id);
      return { position, width, height };
    };
    const open = flowOf('tasks');
    const views: FlowView[] = [
      { lodLevel: 'components' },
      { lodLevel: 'domains' },
      { collapsedIds: new Set(['a.x']) },
    ];
    for (const view of views) {
      const flow = flowOf('tasks', view);
      for (const node of flow.nodes) expect(box(flow, node.id)).toEqual(box(open, node.id));
    }
  });

  it('draws no lines where the layout reserved no block for them', () => {
    const plain = layouts.get('off');
    if (!plain) throw new Error('no layout');
    const flow = buildFlow(model, plain, { workItems: { overlay, mode: 'tasks' } });
    const leaf = archNode(flow, 'a.x.one');
    expect(leaf.data.workItems).toBeUndefined();
    expect(leaf.data.badge).toEqual({ stories: 1, openBugs: 0 });
  });
});

describe('selecting a work item', () => {
  let layout: LayoutResult;
  let open: FlowGraph;
  let closed: FlowGraph;
  beforeAll(async () => {
    layout = await computeLayoutUncached(model, undefined, workItemContent(overlay, 'tasks'));
    const workItems = { overlay, mode: 'tasks' as const };
    open = buildFlow(model, layout, { workItems });
    closed = buildFlow(model, layout, { workItems, collapsedIds: new Set(['a.x']) });
  });
  const story: Selection = { type: 'workitem', id: 3 };

  it('is a selection of its own kind that exists while the item does', () => {
    expect(sameSelection(story, { type: 'workitem', id: 3 })).toBe(true);
    expect(sameSelection(story, { type: 'workitem', id: 4 })).toBe(false);
    expect(selectionExists(model, [], story, overlay.byId)).toBe(true);
    expect(selectionExists(model, [], { type: 'workitem', id: 99 }, overlay.byId)).toBe(false);
    expect(selectionExists(model, [], story)).toBe(false);
    expect(resolveSelection(model, [], story, overlay.byId)).toBe(story);
    expect(resolveSelection(model, [], story)).toBeUndefined();
  });

  it('is drawn on the nodes it is tagged to, or on what stands for them', () => {
    const visible = (flow: FlowGraph): Set<string> =>
      new Set(flow.nodes.filter((n) => n.type !== 'band').map((n) => n.id));
    expect(workItemDrawnOn(model, overlay, visible(open), 3)).toEqual(['a.x.one', 'b.z']);
    expect(workItemDrawnOn(model, overlay, visible(closed), 3)).toEqual(['a.x', 'b.z']);
    // A task is drawn where the item above it is.
    expect(workItemDrawnOn(model, overlay, visible(open), 4)).toEqual(['a.x.one', 'b.z']);
    expect(workItemDrawnOn(model, overlay, visible(open), 7)).toEqual([]);
    expect(renderedSelection(model, open, story, overlay)).toEqual({
      type: 'workitem',
      id: 3,
      nodeIds: ['a.x.one', 'b.z'],
    });
    expect(renderedSelection(model, closed, story, overlay)?.type).toBe('workitem');
    // Untagged, or no overlay: nothing to highlight.
    expect(renderedSelection(model, open, { type: 'workitem', id: 7 }, overlay)).toBeUndefined();
    expect(renderedSelection(model, open, story)).toBeUndefined();
  });

  it('collapses two tags inside one closed group into that group', () => {
    const both = buildWorkItemOverlay(model, [item(1, 'User Story', ['a.x.one', 'a.x.two'])]);
    const visible = new Set(['a', 'a.x', 'a.y', 'b', 'b.z']);
    expect(workItemDrawnOn(model, both, visible, 1)).toEqual(['a.x']);
  });

  it('has the nodes that show it as its neighbourhood, and no edges', () => {
    const rendered = renderedSelection(model, open, story, overlay);
    if (!rendered) throw new Error('not rendered');
    const near = neighbourhood(rendered, open.edges);
    expect([...near.nodes]).toEqual(['a.x.one', 'b.z']);
    expect(near.edges.size).toBe(0);
  });

  it('dims everything else, edges included, and marks no node selected', () => {
    const rendered = renderedSelection(model, closed, story, overlay);
    const lit = highlightFlow(closed, rendered);
    const dimmed = (id: string): boolean =>
      archNode(lit, id).className?.includes(DIMMED_CLASS) ?? false;
    expect(dimmed('a.x')).toBe(false);
    expect(dimmed('b.z')).toBe(false);
    expect(dimmed('a')).toBe(true);
    expect(dimmed('a.y')).toBe(true);
    expect(dimmed('b')).toBe(true);
    expect(lit.nodes.some((node) => 'selected' in node && node.selected === true)).toBe(false);
    expect(lit.edges.every((edge) => edge.data.dimmed === true)).toBe(true);
    // The nodes drawn inside a node that shows it stay lit.
    const onDomain = renderedSelection(model, open, { type: 'workitem', id: 1 }, overlay);
    const inside = highlightFlow(open, onDomain);
    expect(archNode(inside, 'a.x.two').className ?? '').not.toContain(DIMMED_CLASS);
    expect(archNode(inside, 'b').className).toContain(DIMMED_CLASS);
  });
});
