import { describe, expect, it } from 'vitest';
import {
  buildWorkItemOverlay,
  heatByWork,
  progressByNode,
  progressText,
  subtreeWorkItemIds,
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

const items = [
  item(1, 'User Story', ['a.x.one']),
  item(2, 'Task', [], { parentId: 1 }),
  item(3, 'Task', [], { parentId: 1, state: 'Closed' }),
  item(4, 'Bug', ['a.y', 'a.x'], { state: 'Resolved' }),
  item(5, 'User Story', ['a.y']),
  item(6, 'User Story', ['b'], { state: 'Done' }),
];

describe('subtreeWorkItemIds', () => {
  it('collects rows and their tasks per subtree, once each', () => {
    const ids = subtreeWorkItemIds(model, buildWorkItemOverlay(model, items));
    const of = (node: string) => [...(ids.get(node) ?? [])].sort();
    expect(of('a.x.one')).toEqual([1, 2, 3]);
    expect(of('a.x')).toEqual([1, 2, 3, 4]);
    expect(of('a.y')).toEqual([4, 5]);
    expect(of('a')).toEqual([1, 2, 3, 4, 5]); // the bug on two nodes counts once
    expect(of('b')).toEqual([6]);
  });
});

describe('heatByWork', () => {
  it('counts the open items of a subtree against the hottest node of the same level', () => {
    const heat = heatByWork(model, buildWorkItemOverlay(model, items));
    expect(heat.get('a')).toEqual({ open: 3, fraction: 1 }); // 1, 2, 5
    expect(heat.get('b')).toBeUndefined(); // nothing open
    expect(heat.get('a.x')).toEqual({ open: 2, fraction: 1 });
    expect(heat.get('a.y')).toEqual({ open: 1, fraction: 0.5 });
    expect(heat.get('a.x.one')).toEqual({ open: 2, fraction: 1 });
  });

  it('follows the filter: hidden items are no work', () => {
    const heat = heatByWork(
      model,
      buildWorkItemOverlay(model, items, { hiddenStates: ['active'] }),
    );
    expect(heat.size).toBe(0);
  });
});

describe('progressByNode', () => {
  it('counts the completed items over all items of a subtree', () => {
    const progress = progressByNode(model, buildWorkItemOverlay(model, items));
    expect(progress.get('a.x.one')).toEqual({ done: 1, total: 3 });
    expect(progress.get('a')).toEqual({ done: 2, total: 5 });
    expect(progress.get('b')).toEqual({ done: 1, total: 1 });
    expect(progress.has('a.x.two')).toBe(false);
    expect(progressText({ done: 3, total: 8 })).toBe('3 of 8 done (38%)');
    expect(progressText({ done: 0, total: 0 })).toBe('0 of 0 done (0%)');
  });

  it('is the progress of one iteration, or of a path above it, when the overlay is filtered so', () => {
    const scoped = [
      item(1, 'User Story', ['a'], { iteration: 'P\\PI 1\\S1', state: 'Closed' }),
      item(2, 'User Story', ['a'], { iteration: 'P\\PI 1\\S2' }),
      item(3, 'User Story', ['a'], { iteration: 'P\\PI 2\\S3', state: 'Closed' }),
    ];
    const of = (iteration?: string) =>
      progressByNode(
        model,
        buildWorkItemOverlay(model, scoped, iteration === undefined ? {} : { iteration }),
      ).get('a');
    expect(of()).toEqual({ done: 2, total: 3 });
    expect(of('P\\PI 1')).toEqual({ done: 1, total: 2 });
    expect(of('P\\PI 1\\S2')).toEqual({ done: 0, total: 1 });
    expect(of('P')).toEqual({ done: 2, total: 3 });
  });
});
