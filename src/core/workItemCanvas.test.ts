// What is drawn of the work items and how one gets to them: where an item is on the canvas,
// the badge of closed boxes, search, the filter choices, and keeping the place when the layout
// changes with the story mode.

import { beforeAll, describe, expect, it } from 'vitest';
import { COMPACT_GROUP, compactGroupBox, compactGroupRect } from './compactGroup';
import {
  DEFAULT_DISPLAY_SETTINGS,
  parseDisplaySettings,
  serializeDisplaySettings,
  withIteration,
} from './displaySettings';
import { buildFlow, type ArchFlowNode, type FlowGraph } from './flow';
import { computeLayoutUncached, type LayoutResult, type Rect } from './layout';
import { parseOk } from './layout/test-helpers';
import { expandToOpen, viewportKeepingPlace, type Viewport } from './navigate';
import { searchWorkItems } from './search';
import { resolveSelection } from './selection';
import { WORK_ITEM_GEOMETRY, workItemContent, workItemPlace } from './workItemContent';
import {
  buildWorkItemOverlay,
  childWorkItems,
  isHiddenState,
  toggleHiddenState,
  usableWorkItemFilter,
  workItemCountsText,
} from './workItemOverlay';
import { STORY_MODE_LABELS, STORY_MODES } from './workitems';
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
  item(1, 'User Story', ['a'], { title: 'Launch checklist for shop 4' }),
  item(2, 'User Story', ['a.x'], { iteration: 'Sprint 1' }),
  item(3, 'User Story', ['a.x.one', 'b.z'], { title: 'Rotate device certificates' }),
  item(4, 'Task', [], { parentId: 3, title: 'Send the device signals with every event' }),
  item(5, 'Bug', ['a.x.two'], { title: 'Payment page errors after a redeploy' }),
  item(6, 'Bug', ['a.y'], { state: 'Closed', iteration: 'Sprint 2' }),
  item(7, 'User Story', [], { title: 'Evaluate a new panel vendor' }),
  item(8, 'Task', [], { parentId: 7 }),
  item(9, 'User Story', ['nowhere']),
  item(10, 'Feature', ['b'], { title: 'Rule versioning' }),
  item(11, 'User Story', ['b.z'], { parentId: 10, state: 'Closed' }),
];

const overlay = buildWorkItemOverlay(model, ITEMS);

describe('workItemPlace', () => {
  it('says on which nodes an item is drawn as a line', () => {
    expect(workItemPlace(overlay, 'stories', 3)).toEqual({
      status: 'drawn',
      nodeIds: ['a.x.one', 'b.z'],
      drawnOn: ['a.x.one', 'b.z'],
    });
    expect(workItemPlace(overlay, 'tasks', 4)).toMatchObject({
      status: 'drawn',
      drawnOn: ['a.x.one', 'b.z'],
    });
  });

  it('says why an item has no line: mode Off, tasks not shown, no node, filter, unknown', () => {
    expect(workItemPlace(overlay, 'off', 3)).toEqual({
      status: 'off',
      nodeIds: ['a.x.one', 'b.z'],
      drawnOn: [],
    });
    expect(workItemPlace(overlay, 'stories', 4)).toMatchObject({
      status: 'tasks-off',
      nodeIds: ['a.x.one', 'b.z'],
    });
    // No comp: tag, a task of an untagged story, a tag that names no node.
    for (const id of [7, 8, 9]) {
      expect(workItemPlace(overlay, 'tasks', id)).toEqual({
        status: 'unplaced',
        nodeIds: [],
        drawnOn: [],
      });
    }
    const open = buildWorkItemOverlay(model, ITEMS, { hiddenStates: ['closed'] });
    expect(workItemPlace(open, 'stories', 6).status).toBe('filtered');
    expect(workItemPlace(overlay, 'stories', 6).status).toBe('drawn');
    expect(workItemPlace(overlay, 'stories', 999).status).toBe('unknown');
  });

  it('says when an item is under "+k more" on every node that lists it', () => {
    const many = Array.from({ length: 12 }, (_, i) => item(100 + i, 'User Story', ['a.y']));
    const crowded = buildWorkItemOverlay(model, many);
    const kept = WORK_ITEM_GEOMETRY.maxLines - 1;
    expect(workItemPlace(crowded, 'stories', 100 + kept - 1).status).toBe('drawn');
    expect(workItemPlace(crowded, 'stories', 100 + kept)).toEqual({
      status: 'folded',
      nodeIds: ['a.y'],
      drawnOn: [],
    });
  });

  it('agrees with the content the layout reserves, in every mode', () => {
    for (const mode of STORY_MODES) {
      const content = workItemContent(overlay, mode);
      for (const candidate of ITEMS) {
        const place = workItemPlace(overlay, mode, candidate.id);
        for (const nodeId of place.drawnOn) {
          const lines = content.get(nodeId)?.lines ?? [];
          expect(lines.some((line) => line.kind !== 'more' && line.item.id === candidate.id)).toBe(
            true,
          );
        }
        expect(place.status === 'drawn').toBe(place.drawnOn.length > 0);
      }
    }
  });
});

describe('overlay helpers of the panel and the filter', () => {
  it('lists the children of an item, whatever their type, without the filtered ones', () => {
    expect(childWorkItems(overlay, 3).map((child) => child.id)).toEqual([4]);
    expect(childWorkItems(overlay, 10).map((child) => child.id)).toEqual([11]);
    expect(childWorkItems(overlay, 1)).toEqual([]);
    const open = buildWorkItemOverlay(model, ITEMS, { hiddenStates: ['Closed'] });
    expect(childWorkItems(open, 10)).toEqual([]);
  });

  it('knows which items are shown: what a selection may name', () => {
    const open = buildWorkItemOverlay(model, ITEMS, { hiddenStates: ['Closed'] });
    expect(open.shownIds.has(6)).toBe(false);
    expect(open.shownIds.has(5)).toBe(true);
    expect([...overlay.shownIds]).toEqual(ITEMS.map((entry) => entry.id));
    // A selected work item lasts while it is shown, and is none once the filter hides it.
    const selected = { type: 'workitem', id: 6 } as const;
    expect(resolveSelection(model, [], selected, overlay.shownIds)).toBe(selected);
    expect(resolveSelection(model, [], selected, open.shownIds)).toBeUndefined();
  });

  it('applies a stored iteration only when the loaded items have it', () => {
    expect(usableWorkItemFilter(ITEMS, ['Closed'], 'Sprint 1')).toEqual({
      hiddenStates: ['Closed'],
      iteration: 'Sprint 1',
    });
    const other = usableWorkItemFilter(ITEMS, [], 'Another project\\Sprint 9');
    expect(other).toEqual({ hiddenStates: [] });
    expect(buildWorkItemOverlay(model, ITEMS, other).shown).toHaveLength(ITEMS.length);
    expect(usableWorkItemFilter(ITEMS, [], undefined)).toEqual({ hiddenStates: [] });
  });

  it('toggles a hidden state without regard to case, keeping the list sorted', () => {
    expect(toggleHiddenState([], 'Closed')).toEqual(['Closed']);
    expect(toggleHiddenState(['Closed'], 'Active')).toEqual(['Active', 'Closed']);
    expect(toggleHiddenState(['Active', 'Closed'], ' closed ')).toEqual(['Active']);
    expect(isHiddenState(['Closed'], 'closed')).toBe(true);
    expect(isHiddenState(['Closed'], 'Active')).toBe(false);
  });

  it('says the counts of a badge in words', () => {
    expect(workItemCountsText({ stories: 1, openBugs: 0 })).toBe('1 work item');
    expect(workItemCountsText({ stories: 5, openBugs: 1 })).toBe('5 work items · 1 open bug');
    expect(workItemCountsText({ stories: 5, openBugs: 2 })).toBe('5 work items · 2 open bugs');
  });

  it('names every story mode', () => {
    expect(STORY_MODES.map((mode) => STORY_MODE_LABELS[mode])).toEqual([
      'Off',
      'Stories only',
      'Stories + Tasks',
    ]);
  });
});

describe('withIteration', () => {
  it('sets and removes the iteration, and survives the stored form', () => {
    const one = withIteration(DEFAULT_DISPLAY_SETTINGS, 'Sprint 1');
    expect(one.iteration).toBe('Sprint 1');
    expect(parseDisplaySettings(serializeDisplaySettings(one))).toEqual(one);
    for (const none of [withIteration(one, undefined), withIteration(one, '')]) {
      expect('iteration' in none).toBe(false);
      expect(none).toEqual(DEFAULT_DISPLAY_SETTINGS);
    }
  });
});

describe('searchWorkItems', () => {
  const ids = (query: string): number[] => searchWorkItems(ITEMS, query).map((m) => m.item.id);

  it('finds an item by #id or by the digits alone, the exact ID first', () => {
    expect(ids('#3')).toEqual([3]);
    expect(ids('#1')).toEqual([1, 10, 11]);
    expect(searchWorkItems(ITEMS, '#1').map((m) => m.rank)).toEqual([0, 1, 1]);
    expect(ids('10')).toEqual([10]);
    expect(ids('#')).toEqual([]);
    expect(ids('#abc')).toEqual([]);
  });

  it('finds items by their title, ranked like node names, by ID within a rank', () => {
    expect(ids('rotate')).toEqual([3]);
    expect(ids('  CERTIFICATES ')).toEqual([3]);
    const matches = searchWorkItems(ITEMS, 'item');
    expect(matches.map((m) => m.item.id)).toEqual([2, 6, 8, 9, 11]);
    expect(matches.every((m) => m.rank === 1)).toBe(true);
    // A word of the title ranks before a mere part of a word.
    expect(searchWorkItems(ITEMS, 'vers').map((m) => [m.item.id, m.rank])).toEqual([[10, 2]]);
    expect(searchWorkItems(ITEMS, 'ersion').map((m) => [m.item.id, m.rank])).toEqual([[10, 3]]);
  });

  it('matches several words in any order', () => {
    expect(ids('vendor panel')).toEqual([7]);
    expect(ids('redeploy payment')).toEqual([5]);
    expect(ids('payment vendor')).toEqual([]);
  });

  it('matches digits in titles as well as IDs, and nothing for an empty query', () => {
    expect(ids('4')).toEqual([4, 1]);
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
  });

  it('does not depend on the order of the items', () => {
    expect(searchWorkItems([...ITEMS].reverse(), 'item')).toEqual(searchWorkItems(ITEMS, 'item'));
  });
});

describe('expandToOpen', () => {
  it('opens the node itself and everything around it', () => {
    const collapsed = new Set(['a', 'a.x', 'b']);
    expect([...expandToOpen(model, collapsed, ['a.x'])]).toEqual(['b']);
    expect([...expandToOpen(model, collapsed, ['a.x.one'])]).toEqual(['b']);
    expect([...expandToOpen(model, collapsed, ['a'])]).toEqual(['a.x', 'b']);
    expect([...expandToOpen(model, collapsed, ['unknown'])]).toEqual(['a', 'a.x', 'b']);
    expect(collapsed.size).toBe(3);
  });
});

describe('viewportKeepingPlace', () => {
  const size = { width: 1000, height: 600 };
  const rect = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });
  const before = new Map([
    ['a', rect(0, 0, 400, 300)],
    ['a.x', rect(20, 60, 200, 100)],
    ['b', rect(600, 0, 200, 300)],
  ]);
  /** The canvas point in the middle of the screen. */
  const centre = (viewport: Viewport) => ({
    x: (size.width / 2 - viewport.x) / viewport.zoom,
    y: (size.height / 2 - viewport.y) / viewport.zoom,
  });
  /** A viewport with canvas point (x, y) in the middle of the screen. */
  const lookingAt = (x: number, y: number, zoom: number): Viewport => ({
    x: size.width / 2 - x * zoom,
    y: size.height / 2 - y * zoom,
    zoom,
  });

  it('keeps the same point of the innermost node in the middle, at the same zoom', () => {
    const after = new Map([
      ['a', rect(0, 0, 500, 500)],
      ['a.x', rect(40, 200, 300, 200)],
      ['b', rect(700, 0, 200, 500)],
    ]);
    // The middle of a.x (120, 110) → the middle of where a.x is afterwards.
    const next = viewportKeepingPlace(lookingAt(120, 110, 2), size, before, after);
    expect(next.zoom).toBe(2);
    expect(centre(next)).toEqual({ x: 190, y: 300 });
    // A quarter into a.x from its top left.
    const quarter = viewportKeepingPlace(lookingAt(70, 85, 0.5), size, before, after);
    expect(centre(quarter)).toEqual({ x: 115, y: 250 });
    // In `a` but outside a.x: `a` is the anchor.
    const inA = viewportKeepingPlace(lookingAt(300, 150, 1), size, before, after);
    expect(centre(inA)).toEqual({ x: 375, y: 250 });
  });

  it('keeps the distance to the nearest node when the middle is on no node', () => {
    const after = new Map([
      ['a', rect(0, 0, 500, 500)],
      ['b', rect(700, 100, 200, 300)],
    ]);
    // (850, 150) is 50 right of b, whose centre moves from (700, 150) to (800, 250).
    const next = viewportKeepingPlace(lookingAt(850, 150, 1), size, before, after);
    expect(centre(next)).toEqual({ x: 950, y: 250 });
  });

  it('returns the viewport itself when nothing moves or there is nothing to hold on to', () => {
    const current = lookingAt(120, 110, 1.5);
    expect(viewportKeepingPlace(current, size, before, before)).toBe(current);
    expect(viewportKeepingPlace(current, size, before, new Map())).toBe(current);
    expect(viewportKeepingPlace(current, size, new Map(), before)).toBe(current);
    expect(viewportKeepingPlace(current, { width: 0, height: 0 }, before, before)).toBe(current);
  });

  it('keeps a node of the example in view between the layouts of two story modes', async () => {
    const layouts: LayoutResult[] = [];
    for (const mode of ['stories', 'tasks'] as const) {
      layouts.push(await computeLayoutUncached(model, undefined, workItemContent(overlay, mode)));
    }
    const [stories, tasks] = layouts;
    const from = stories?.absolute.get('b.z');
    const to = tasks?.absolute.get('b.z');
    if (!stories || !tasks || !from || !to) throw new Error('no layout');
    const current = lookingAt(from.x + from.width / 2, from.y + from.height / 2, 1.8);
    const next = viewportKeepingPlace(current, size, stories.absolute, tasks.absolute);
    expect(centre(next).x).toBeCloseTo(to.x + to.width / 2, 6);
    expect(centre(next).y).toBeCloseTo(to.y + to.height / 2, 6);
  });
});

describe('compactGroupBox with a badge line', () => {
  const full = { x: 0, y: 0, width: 800, height: 600 };

  it('is taller by the extra height, and still centred in the full box', () => {
    const plain = compactGroupBox(full, 'Group', ['One', 'Two']);
    const badged = compactGroupBox(full, 'Group', ['One', 'Two'], COMPACT_GROUP.badgeLine);
    expect(badged.rect.height).toBe(plain.rect.height + COMPACT_GROUP.badgeLine);
    expect(badged.rect.width).toBe(plain.rect.width);
    expect(badged.rect.y + badged.rect.height / 2).toBe(300);
    expect(badged.hidden).toBe(0);
    expect(compactGroupRect(full, 'Group', ['One', 'Two'], COMPACT_GROUP.badgeLine)).toEqual(
      badged.rect,
    );
    expect(compactGroupBox(full, 'Group', ['One', 'Two'], 0)).toEqual(plain);
  });

  it('never grows beyond the full box: names are left out instead', () => {
    const names = Array.from({ length: 40 }, (_, i) => `Component number ${i}`);
    const small = { x: 0, y: 0, width: 360, height: 150 };
    const plain = compactGroupBox(small, 'Group', names);
    const badged = compactGroupBox(small, 'Group', names, COMPACT_GROUP.badgeLine);
    expect(badged.rect.height).toBeLessThanOrEqual(small.height);
    expect(badged.hidden).toBeGreaterThan(plain.hidden);
  });
});

describe('buildFlow: what the canvas needs to draw the work items', () => {
  const layouts = new Map<StoryMode, LayoutResult>();
  beforeAll(async () => {
    for (const mode of STORY_MODES) {
      layouts.set(
        mode,
        await computeLayoutUncached(model, undefined, workItemContent(overlay, mode)),
      );
    }
  });
  const layoutOf = (mode: StoryMode): LayoutResult => {
    const layout = layouts.get(mode);
    if (!layout) throw new Error('no layout');
    return layout;
  };
  const archNode = (flow: FlowGraph, id: string): ArchFlowNode => {
    const node = flow.nodes.find((n) => n.id === id);
    if (!node || node.type === 'band') throw new Error(`no node ${id}`);
    return node;
  };

  it('tells every node with a reserved block where it is, at every level of detail', () => {
    const layout = layoutOf('stories');
    for (const lodLevel of ['domains', 'components', 'subcomponents', 'detail'] as const) {
      const flow = buildFlow(model, layout, { lodLevel, workItems: { overlay, mode: 'stories' } });
      for (const node of flow.nodes) {
        if (node.type === 'band') continue;
        expect(node.data.contentRect).toEqual(layout.content.get(node.id));
        // Lines only at the detail level, and then in that block.
        if (node.data.workItems) {
          expect(lodLevel).toBe('detail');
          expect(node.data.workItems.rect).toEqual(node.data.contentRect);
        }
        // A leaf or an open group with a badge has the block to draw it in.
        if (node.data.badge && !node.data.collapsed) {
          expect(node.data.contentRect).toBeDefined();
        }
      }
    }
    expect(archNode(buildFlow(model, layout), 'a').data.contentRect).toBeUndefined();
  });

  it('has no block in mode Off', () => {
    const flow = buildFlow(model, layoutOf('off'), { workItems: { overlay, mode: 'off' } });
    for (const node of flow.nodes) {
      if (node.type !== 'band') expect(node.data.contentRect).toBeUndefined();
    }
  });

  it('makes a shrunk closed group with a badge one line taller than without', () => {
    const layout = layoutOf('stories');
    const view = { collapsedIds: new Set(['a']), compactCollapsed: true };
    const plain = archNode(buildFlow(model, layout, view), 'a');
    const badged = archNode(
      buildFlow(model, layout, { ...view, workItems: { overlay, mode: 'stories' } }),
      'a',
    );
    expect(plain.data.compact && badged.data.compact).toBe(true);
    expect(badged.data.badge).toEqual({ stories: 5, openBugs: 1 });
    expect(badged.height).toBe(plain.height + COMPACT_GROUP.badgeLine);
    // Still inside the full box, around the same middle.
    const full = layout.rects.get('a');
    if (!full) throw new Error('no rect');
    expect(badged.height).toBeLessThanOrEqual(full.height);
    expect(badged.position.y + badged.height / 2).toBeCloseTo(full.y + full.height / 2, 0);
  });
});
