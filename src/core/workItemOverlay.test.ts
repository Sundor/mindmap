// Work items laid over the structure: rows, counts, filters, tag diagnostics.

import { describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import { parseOk } from './layout/test-helpers';
import {
  availableIterations,
  inIteration,
  ITERATION_SEPARATOR,
  usableWorkItemFilter,
  availableStates,
  buildWorkItemOverlay,
  CLOSED_STATES,
  emptyWorkItemOverlay,
  firstWords,
  isHiddenState,
  isOpenState,
  ownWorkItemCounts,
  subtreeWorkItemCounts,
  tasksOfWorkItem,
  toggleHiddenState,
  workItemById,
  workItemDiagnostics,
  workItemNodeIds,
  workItemsOfNode,
  workItemTagReport,
  type WorkItemOverlay,
} from './workItemOverlay';
import { parseWorkItems, type WorkItemSummary, type WorkItemType } from './workitems';

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
`);

function item(
  id: number,
  type: WorkItemType,
  tags: string[] = [],
  extra: Partial<WorkItemSummary> = {},
): WorkItemSummary {
  return { id, type, title: `Item ${id}`, state: 'Active', componentIds: tags, tags: [], ...extra };
}

/** `nodeId → "story(task,task)"` for every node with rows. */
function shape(overlay: WorkItemOverlay): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [nodeId, rows] of overlay.rows) {
    out[nodeId] = rows.map((row) =>
      row.tasks.length > 0
        ? `${row.item.id}(${row.tasks.map((t) => t.id).join(',')})`
        : String(row.item.id),
    );
  }
  return out;
}

describe('buildWorkItemOverlay', () => {
  it('puts stories, bugs, features and epics on every node they are tagged to, by ID', () => {
    const overlay = buildWorkItemOverlay(model, [
      item(5, 'Bug', ['a.x.one']),
      item(2, 'User Story', ['a.x.one', 'b']),
      item(9, 'Epic', ['a']),
      item(3, 'Feature', ['a.x']),
    ]);
    expect(shape(overlay)).toEqual({ a: ['9'], 'a.x': ['3'], 'a.x.one': ['2', '5'], b: ['2'] });
    // Document order of the nodes, whatever the order of the items.
    expect([...overlay.rows.keys()]).toEqual(['a', 'a.x', 'a.x.one', 'b']);
    expect(overlay.shown.map((i) => i.id)).toEqual([2, 3, 5, 9]);
  });

  it('lists a task under its shown parent wherever the parent is, ignoring its own tags', () => {
    const overlay = buildWorkItemOverlay(model, [
      item(1, 'User Story', ['a.x.one', 'b']),
      item(12, 'Task', ['a.y'], { parentId: 1 }),
      item(11, 'Task', [], { parentId: 1 }),
    ]);
    expect(shape(overlay)).toEqual({ 'a.x.one': ['1(11,12)'], b: ['1(11,12)'] });
    expect(workItemNodeIds(overlay, 12)).toEqual(['a.x.one', 'b']);
    expect(workItemNodeIds(overlay, 1)).toEqual(['a.x.one', 'b']);
    expect(overlay.listedUnder.get(12)).toBe(1);
    expect(tasksOfWorkItem(overlay, 1).map((t) => t.id)).toEqual([11, 12]);
  });

  it('makes a task a row of its own when its parent is not shown as a row', () => {
    const overlay = buildWorkItemOverlay(model, [
      // Parent without a comp: tag: it is on no node.
      item(1, 'User Story'),
      item(10, 'Task', ['a.y'], { parentId: 1 }),
      // No parent at all.
      item(20, 'Task', ['a.y']),
      // Parent tagged to an unknown node only.
      item(3, 'User Story', ['nowhere']),
      item(30, 'Task', ['b'], { parentId: 3 }),
      // Neither a shown parent nor a tag: on no node.
      item(40, 'Task', [], { parentId: 1 }),
    ]);
    expect(shape(overlay)).toEqual({ 'a.y': ['10', '20'], b: ['30'] });
    expect(workItemNodeIds(overlay, 40)).toEqual([]);
    expect(workItemNodeIds(overlay, 1)).toEqual([]);
  });

  it('lists tasks under a task that is a row, and does not nest deeper than that', () => {
    const overlay = buildWorkItemOverlay(model, [
      item(1, 'User Story', ['a.x']),
      item(2, 'Task', [], { parentId: 1 }),
      // Under a listed task: not a row, and the task it hangs under is not one either.
      item(3, 'Task', ['b'], { parentId: 2 }),
      item(4, 'Task', ['a.y']),
      item(5, 'Task', [], { parentId: 4 }),
    ]);
    expect(shape(overlay)).toEqual({ 'a.x': ['1(2)'], 'a.y': ['4(5)'], b: ['3'] });
  });

  it('lists an untagged task of a listed task under the same row', () => {
    const overlay = buildWorkItemOverlay(model, [
      item(1, 'User Story', ['a.x.one']),
      item(3, 'Task', [], { parentId: 1 }),
      item(2, 'Task', [], { parentId: 3 }),
      // Three levels down.
      item(5, 'Task', [], { parentId: 2 }),
    ]);
    expect(shape(overlay)).toEqual({ 'a.x.one': ['1(2,3,5)'] });
    expect(overlay.listedUnder.get(2)).toBe(1);
    expect(overlay.listedUnder.get(5)).toBe(1);
    expect(workItemNodeIds(overlay, 5)).toEqual(['a.x.one']);
    expect(tasksOfWorkItem(overlay, 1).map((t) => t.id)).toEqual([2, 3, 5]);
  });

  it('lists an untagged task under the shown item above the tasks the filter hides', () => {
    const closed = { state: 'Closed' };
    const overlay = buildWorkItemOverlay(
      model,
      [
        item(1, 'User Story', ['a.x']),
        item(2, 'Task', [], { parentId: 1, ...closed }),
        item(3, 'Task', [], { parentId: 2 }),
        // Two hidden tasks in between.
        item(4, 'Task', [], { parentId: 2, ...closed }),
        item(5, 'Task', [], { parentId: 4 }),
        // Under a task that is listed under the story: the same row.
        item(6, 'Task', [], { parentId: 1 }),
        item(7, 'Task', [], { parentId: 6, ...closed }),
        item(8, 'Task', [], { parentId: 7 }),
        // The hidden task has a tag of its own: the task takes its place, as a row.
        item(9, 'Task', ['b'], { parentId: 1, ...closed }),
        item(10, 'Task', [], { parentId: 9 }),
        // A tag of its own under a hidden parent: a row of its own.
        item(11, 'Task', ['a.y'], { parentId: 2 }),
        // The shown item above is on no node: neither is the task.
        item(20, 'User Story'),
        item(21, 'Task', [], { parentId: 20, ...closed }),
        item(22, 'Task', [], { parentId: 21 }),
      ],
      { hiddenStates: ['Closed'] },
    );
    expect(shape(overlay)).toEqual({ 'a.x': ['1(3,5,6,8)'], 'a.y': ['11'], b: ['10'] });
    expect(overlay.listedUnder.get(3)).toBe(1);
    expect(workItemNodeIds(overlay, 3)).toEqual(['a.x']);
    expect(workItemNodeIds(overlay, 8)).toEqual(['a.x']);
    expect(workItemNodeIds(overlay, 22)).toEqual([]);
    expect(tasksOfWorkItem(overlay, 1).map((t) => t.id)).toEqual([3, 5, 6, 8]);
  });

  it('follows a chain of tasks of any length without running out of stack', () => {
    const length = 20000;
    // Shown tasks, each under the next; the last one under a story.
    const chain = Array.from({ length }, (_, i) => item(i + 2, 'Task', [], { parentId: i + 3 }));
    const shownChain = buildWorkItemOverlay(model, [
      ...chain,
      item(length + 2, 'User Story', ['a.y']),
    ]);
    expect(shownChain.rows.get('a.y')?.[0]?.tasks).toHaveLength(length);
    expect(shownChain.listedUnder.get(2)).toBe(length + 2);

    // The same chain hidden by the filter, with one shown task at its lower end: it takes the
    // place of the first tagged item above it.
    const hidden = chain.map((task) => ({ ...task, state: 'Closed' }));
    const hiddenChain = buildWorkItemOverlay(
      model,
      [
        item(1, 'Task', [], { parentId: 2 }),
        ...hidden,
        item(length + 2, 'Task', ['b'], { state: 'Closed' }),
      ],
      { hiddenStates: ['closed'] },
    );
    expect(shape(hiddenChain)).toEqual({ b: ['1'] });
  });

  it('survives a circle of parents among tasks', () => {
    const overlay = buildWorkItemOverlay(model, [
      item(1, 'Task', ['a.y'], { parentId: 2 }),
      item(2, 'Task', ['b'], { parentId: 1 }),
    ]);
    expect(Object.values(shape(overlay)).flat().length).toBeGreaterThan(0);
  });

  it('ignores tags that name no node, and keeps the first of duplicate IDs', () => {
    const overlay = buildWorkItemOverlay(model, [
      item(1, 'User Story', ['a.zzz', 'a.y']),
      item(1, 'Bug', ['b']),
    ]);
    expect(shape(overlay)).toEqual({ 'a.y': ['1'] });
    expect(workItemById(overlay, 1)?.type).toBe('User Story');
    expect(workItemById(overlay, 2)).toBeUndefined();
  });

  it('counts distinct top-level items per node and per subtree, and the open bugs', () => {
    const overlay = buildWorkItemOverlay(model, [
      item(1, 'User Story', ['a.x.one', 'a.x.two', 'a']),
      item(2, 'Bug', ['a.x.one']),
      item(3, 'Bug', ['a.x'], { state: 'Closed' }),
      item(4, 'Bug', ['a.y'], { state: 'resolved' }),
      item(5, 'Bug', ['a.y'], { state: 'New' }),
      item(6, 'Task', [], { parentId: 1 }),
    ]);
    expect(subtreeWorkItemCounts(overlay, 'a')).toEqual({ stories: 5, openBugs: 2 });
    expect(ownWorkItemCounts(overlay, 'a')).toEqual({ stories: 1, openBugs: 0 });
    expect(subtreeWorkItemCounts(overlay, 'a.x')).toEqual({ stories: 3, openBugs: 1 });
    expect(ownWorkItemCounts(overlay, 'a.x')).toEqual({ stories: 1, openBugs: 0 });
    expect(subtreeWorkItemCounts(overlay, 'a.x.one')).toEqual({ stories: 2, openBugs: 1 });
    expect(subtreeWorkItemCounts(overlay, 'a.y')).toEqual({ stories: 2, openBugs: 1 });
    expect(subtreeWorkItemCounts(overlay, 'b')).toEqual({ stories: 0, openBugs: 0 });
    expect(ownWorkItemCounts(overlay, 'nope')).toEqual({ stories: 0, openBugs: 0 });
    expect(overlay.counts.has('b')).toBe(false);
  });

  it('leaves out hidden states (any letter case) from rows, tasks and counts', () => {
    const items = [
      item(1, 'User Story', ['a.y']),
      item(2, 'Task', [], { parentId: 1, state: 'Closed' }),
      item(3, 'Task', [], { parentId: 1 }),
      item(4, 'Bug', ['a.y'], { state: 'Closed' }),
      // Its story is hidden: it becomes a row, on its own nodes or else on those of the story.
      item(5, 'User Story', ['b'], { state: 'Closed' }),
      item(6, 'Task', ['b'], { parentId: 5 }),
      item(7, 'Task', [], { parentId: 5 }),
    ];
    expect(shape(buildWorkItemOverlay(model, items))).toEqual({
      'a.y': ['1(2,3)', '4'],
      b: ['5(6,7)'],
    });
    const filtered = buildWorkItemOverlay(model, items, { hiddenStates: ['closed'] });
    expect(shape(filtered)).toEqual({ 'a.y': ['1(3)'], b: ['6', '7'] });
    expect(subtreeWorkItemCounts(filtered, 'a')).toEqual({ stories: 1, openBugs: 0 });
    expect(filtered.shown.map((i) => i.id)).toEqual([1, 3, 6, 7]);
    // The panel can still show a filtered item.
    expect(workItemById(filtered, 4)?.state).toBe('Closed');
    expect(workItemNodeIds(filtered, 4)).toEqual([]);
  });

  it('shows one iteration only when asked', () => {
    const items = [
      item(1, 'User Story', ['a.y'], { iteration: 'S1' }),
      item(2, 'User Story', ['a.y'], { iteration: 'S2' }),
      item(3, 'User Story', ['a.y']),
      item(4, 'Task', [], { parentId: 1, iteration: 'S2' }),
    ];
    expect(shape(buildWorkItemOverlay(model, items, { iteration: 'S1' }))).toEqual({
      'a.y': ['1'],
    });
    // Task 4 passes while its story does not: it takes the story's place (see below).
    expect(shape(buildWorkItemOverlay(model, items, { iteration: 'S2' }))).toEqual({
      'a.y': ['2', '4'],
    });
  });

  it('keeps a task whose parent is filtered out, as a row on the nodes of that parent', () => {
    const items = [
      item(1, 'User Story', ['a.x.one', 'b'], { state: 'Closed' }),
      item(2, 'Task', [], { parentId: 1 }),
      // A tag of its own wins over the hidden parent's.
      item(3, 'Task', ['a.y'], { parentId: 1 }),
      // Under a hidden task: up the chain to the story.
      item(4, 'Task', [], { parentId: 5 }),
      item(5, 'Task', [], { parentId: 1, state: 'Closed' }),
      // The hidden parent is on no node: neither is the task.
      item(6, 'User Story', [], { state: 'Closed' }),
      item(7, 'Task', [], { parentId: 6 }),
      // Hidden tasks that are each other's parent.
      item(8, 'Task', [], { parentId: 9 }),
      item(9, 'Task', [], { parentId: 10, state: 'Closed' }),
      item(10, 'Task', [], { parentId: 9, state: 'Closed' }),
    ];
    const overlay = buildWorkItemOverlay(model, items, { hiddenStates: ['closed'] });
    expect(shape(overlay)).toEqual({ 'a.x.one': ['2', '4'], 'a.y': ['3'], b: ['2', '4'] });
    expect(workItemNodeIds(overlay, 2)).toEqual(['a.x.one', 'b']);
    expect(workItemNodeIds(overlay, 7)).toEqual([]);
    expect(workItemNodeIds(overlay, 8)).toEqual([]);
    expect(overlay.listedUnder.size).toBe(0);
    expect(subtreeWorkItemCounts(overlay, 'a')).toEqual({ stories: 3, openBugs: 0 });
    // Unfiltered, the tasks are back under their story, the task of a task with them.
    expect(shape(buildWorkItemOverlay(model, items))['b']).toEqual(['1(2,3,4,5)']);
  });

  it('is empty without items', () => {
    const overlay = emptyWorkItemOverlay(model);
    expect(overlay.rows.size + overlay.counts.size + overlay.shown.length).toBe(0);
  });
});

describe('workItemsOfNode', () => {
  const overlay = buildWorkItemOverlay(model, [
    item(1, 'User Story', ['a']),
    item(2, 'User Story', ['a.x.two']),
    item(3, 'Bug', ['a.y']),
  ]);

  it('gives the rows of the node alone, or grouped with those of its descendants', () => {
    expect(workItemsOfNode(model, overlay, 'a').map((g) => g.nodeId)).toEqual(['a']);
    const all = workItemsOfNode(model, overlay, 'a', { descendants: true });
    expect(all.map((g) => [g.nodeId, g.rows.map((r) => r.item.id)])).toEqual([
      ['a', [1]],
      ['a.x.two', [2]],
      ['a.y', [3]],
    ]);
    expect(workItemsOfNode(model, overlay, 'a.x', { descendants: true })).toHaveLength(1);
  });

  it('gives nothing for a node without items or an unknown one', () => {
    expect(workItemsOfNode(model, overlay, 'b', { descendants: true })).toEqual([]);
    expect(workItemsOfNode(model, overlay, 'nope')).toEqual([]);
  });
});

describe('helpers', () => {
  it('firstWords keeps the first words and marks the cut', () => {
    expect(firstWords('Send the device signals with every event', 3)).toBe('Send the device…');
    expect(firstWords('Only three words', 3)).toBe('Only three words');
    expect(firstWords('  spaced   out  text here ', 2)).toBe('spaced out…');
    expect(firstWords('', 3)).toBe('');
    expect(firstWords('one two', 0)).toBe('…');
  });

  it('knows which states are closed', () => {
    expect([...CLOSED_STATES].sort()).toEqual(['closed', 'done', 'removed', 'resolved']);
    expect(isOpenState('Active')).toBe(true);
    expect(isOpenState(' Resolved ')).toBe(false);
    expect(isOpenState('DONE')).toBe(false);
  });

  it('lists the states in workflow order and the iterations sorted', () => {
    const items = [
      item(1, 'Bug', [], { state: 'Closed', iteration: 'Sprint 10' }),
      item(2, 'Bug', [], { state: 'Blocked', iteration: 'Sprint 9' }),
      item(3, 'Bug', [], { state: 'New' }),
      item(4, 'Bug', [], { state: 'Active', iteration: 'Sprint 9' }),
    ];
    expect(availableStates(items)).toEqual(['New', 'Active', 'Closed', 'Blocked']);
    expect(availableIterations(items)).toEqual(['Sprint 9', 'Sprint 10']);
    expect(availableStates([])).toEqual([]);
  });

  it('lists states that differ only in letter case or spaces once', () => {
    const items = [
      item(2, 'Bug', [], { state: 'active' }),
      item(1, 'Bug', [], { state: 'Active' }),
      item(3, 'Bug', [], { state: ' closed ' }),
      item(4, 'Bug', [], { state: 'Closed' }),
    ];
    // Named as the first item by ID spells it.
    expect(availableStates(items)).toEqual(['Active', 'closed']);
    expect(isHiddenState(toggleHiddenState([], 'Active'), 'active')).toBe(true);
  });
});

describe('tag report and diagnostics', () => {
  const items = [
    item(1, 'User Story', ['a.y', 'a.nope']),
    item(2, 'Task', [], { parentId: 1 }),
    item(3, 'User Story'),
    // The parent has no tag: the task is untagged too.
    item(4, 'Task', [], { parentId: 3 }),
    item(5, 'Task'),
    item(6, 'Bug', ['gone']),
    // A bug under a tagged story is no task: untagged.
    item(7, 'Bug', [], { parentId: 1 }),
  ];

  it('finds unknown IDs, untagged items and the coverage', () => {
    const report = workItemTagReport(model, items);
    expect(report.unknown.map((u) => [u.item.id, u.componentId])).toEqual([
      [1, 'a.nope'],
      [6, 'gone'],
    ]);
    expect(report.untagged.map((i) => i.id)).toEqual([3, 4, 5, 7]);
    expect(report.coverage).toEqual({ tagged: 3, total: 7, hidden: 0, percent: 42 });
    expect(workItemTagReport(model, []).coverage).toEqual({
      tagged: 0,
      total: 0,
      hidden: 0,
      percent: 100,
    });
  });

  it('covers the items the filter shows, and reports unknown tags of all of them', () => {
    const mixed = [
      item(1, 'User Story', ['a.x'], { state: 'Closed', iteration: 'S1' }),
      // Its tagged parent is hidden: still linked by that tag.
      item(2, 'Task', [], { parentId: 1, iteration: 'S1' }),
      item(3, 'Bug', [], { iteration: 'S1' }),
      item(4, 'Bug', [], { state: 'Closed', iteration: 'S2' }),
      item(5, 'Bug', ['gone'], { state: 'closed', iteration: 'S2' }),
      item(6, 'Bug', [], { iteration: 'S2' }),
    ];
    const hideClosed = workItemTagReport(model, mixed, { hiddenStates: [' CLOSED '] });
    expect(hideClosed.untagged.map((i) => i.id)).toEqual([3, 6]);
    expect(hideClosed.coverage).toEqual({ tagged: 1, total: 3, hidden: 3, percent: 33 });
    expect(hideClosed.unknown.map((u) => u.item.id)).toEqual([5]);
    const sprint = workItemTagReport(model, mixed, { iteration: 'S2' });
    expect(sprint.untagged.map((i) => i.id)).toEqual([4, 6]);
    expect(sprint.coverage).toEqual({ tagged: 1, total: 3, hidden: 3, percent: 33 });
    const nothing = workItemTagReport(model, mixed, { hiddenStates: ['Closed', 'Active'] });
    expect(nothing.coverage).toEqual({ tagged: 0, total: 0, hidden: 6, percent: 100 });
    // The diagnostic says that it counts the shown items only.
    const [unknownTag, untagged] = workItemDiagnostics(model, mixed, undefined, {
      hiddenStates: ['Closed'],
    });
    expect(unknownTag?.message).toMatch(/^Bug #5 .* comp:gone/);
    expect(untagged?.message).toMatch(
      /^2 work items of 3 shown have no comp: tag \(tag coverage 33%\): #3 Item 3; #6 Item 6\.$/,
    );
  });

  it('counts a task of a task as tagged when an item further up has a tag', () => {
    const chain = [
      item(1, 'User Story', ['a.y']),
      item(3, 'Task', [], { parentId: 1 }),
      item(2, 'Task', [], { parentId: 3 }),
      // The chain ends at an untagged story.
      item(10, 'User Story'),
      item(11, 'Task', [], { parentId: 10 }),
      item(12, 'Task', [], { parentId: 11 }),
      // A circle of untagged tasks.
      item(20, 'Task', [], { parentId: 21 }),
      item(21, 'Task', [], { parentId: 20 }),
    ];
    const report = workItemTagReport(model, chain);
    expect(report.untagged.map((i) => i.id)).toEqual([10, 11, 12, 20, 21]);
    expect(report.coverage).toEqual({ tagged: 3, total: 8, hidden: 0, percent: 37 });
  });

  it('reports them as warnings named after the work-items source', () => {
    const diagnostics = workItemDiagnostics(model, items, 'workitems.json');
    expect(diagnostics.map((d) => [d.severity, d.path, d.source])).toEqual([
      ['warning', '#1', 'workitems.json'],
      ['warning', '#6', 'workitems.json'],
      ['warning', '', 'workitems.json'],
    ]);
    expect(diagnostics[0]?.message).toContain('comp:a.nope');
    expect(diagnostics[2]?.message).toBe(
      '4 work items of 7 have no comp: tag (tag coverage 42%): #3 Item 3; #4 Item 4; #5 Item 5; #7 Item 7.',
    );
    expect(workItemDiagnostics(model, [item(1, 'Bug', ['a'])])).toEqual([]);
    expect(workItemDiagnostics(model, [item(1, 'Bug')])[0]?.message).toMatch(
      /^1 work item of 1 has no comp: tag \(tag coverage 0%\)/,
    );
  });

  it('caps the list of untagged items', () => {
    const many = Array.from({ length: 25 }, (_, i) => item(i + 1, 'Bug'));
    expect(workItemDiagnostics(model, many)[0]?.message).toMatch(/#20 Item 20; and 5 more\.$/);
  });
});

describe('the dummy data over examples/architecture.yaml', () => {
  const example = parseOk(exampleYaml);
  const { items } = parseWorkItems(fixtureJson);
  const overlay = buildWorkItemOverlay(example, items);

  it('shows the multi-tagged story on both nodes with its tasks', () => {
    const multi = items.find((i) => i.type === 'User Story' && i.componentIds.length === 2);
    if (!multi) throw new Error('no multi-tagged story');
    expect(workItemNodeIds(overlay, multi.id)).toEqual(multi.componentIds);
    for (const nodeId of multi.componentIds) {
      const row = overlay.rows.get(nodeId)?.find((r) => r.item.id === multi.id);
      expect(row?.tasks.length).toBeGreaterThan(0);
    }
  });

  it('matches the comp: tag whatever its letter case', () => {
    expect(overlay.rows.get('storefront.web.fraud-check')?.map((r) => r.item.id)).toEqual([1010]);
    // Task 1011 carries a tag of its own and is still listed under its story only.
    expect(overlay.rows.get('storefront.web.tracker')).toBeUndefined();
    expect(overlay.listedUnder.get(1011)).toBe(1010);
  });

  it('aggregates counts up to the domains', () => {
    const storefront = subtreeWorkItemCounts(overlay, 'storefront');
    expect(storefront.stories).toBeGreaterThanOrEqual(8);
    expect(storefront.openBugs).toBe(1);
    expect(ownWorkItemCounts(overlay, 'storefront').stories).toBe(2);
    const total = example.rootIds.reduce(
      (sum, id) => sum + subtreeWorkItemCounts(overlay, id).stories,
      0,
    );
    // One story is tagged into two domains.
    expect(total).toBe(new Set([...overlay.rows.values()].flat().map((r) => r.item.id)).size + 1);
  });

  it('reports the two unknown IDs and the untagged items', () => {
    const report = workItemTagReport(example, items);
    expect(report.unknown.map((u) => u.componentId)).toEqual(['storefront.voice', 'data.lake']);
    expect(report.untagged.map((i) => i.id)).toEqual([1057, 1058, 1065, 1067]);
    expect(report.coverage.percent).toBe(93);
    expect(workItemDiagnostics(example, items, 'workitems.json')).toHaveLength(3);
  });

  it('hides closed and resolved work when asked', () => {
    const open = buildWorkItemOverlay(example, items, { hiddenStates: ['Closed', 'Resolved'] });
    expect(open.shown.every((i) => isOpenState(i.state))).toBe(true);
    expect(open.rows.has('data.event-store')).toBe(false);
    expect(subtreeWorkItemCounts(open, 'storefront').stories).toBeLessThan(
      subtreeWorkItemCounts(overlay, 'storefront').stories,
    );
  });
});

describe('iteration scopes', () => {
  it('lists every path above an iteration too, and a scope covers what lies under it', () => {
    const sep = ITERATION_SEPARATOR;
    const items = [
      item(1, 'Bug', ['a.y'], { iteration: ['P', 'PI 2', 'Sprint 10'].join(sep) }),
      item(2, 'Bug', ['a.y'], { iteration: ['P', 'PI 2', 'Sprint 9'].join(sep) }),
      item(3, 'Bug', ['a.y'], { iteration: 'P' }),
      item(4, 'Bug', ['a.y']),
    ];
    expect(availableIterations(items)).toEqual([
      'P',
      ['P', 'PI 2'].join(sep),
      ['P', 'PI 2', 'Sprint 9'].join(sep),
      ['P', 'PI 2', 'Sprint 10'].join(sep),
    ]);
    const shownIn = (iteration: string) =>
      buildWorkItemOverlay(model, items, { iteration }).shown.map((i) => i.id);
    expect(shownIn('P')).toEqual([1, 2, 3]);
    expect(shownIn(['P', 'PI 2'].join(sep))).toEqual([1, 2]);
    expect(shownIn(['P', 'PI 2', 'Sprint 9'].join(sep))).toEqual([2]);
    expect(shownIn('PI 2')).toEqual([]); // not a prefix of a whole level
    expect(inIteration(undefined, 'P')).toBe(false);
    expect(usableWorkItemFilter(items, [], ['P', 'PI 2'].join(sep)).iteration).toBe(
      ['P', 'PI 2'].join(sep),
    );
    expect(usableWorkItemFilter(items, [], 'PI 2').iteration).toBeUndefined();
  });
});
