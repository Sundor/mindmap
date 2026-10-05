// The work-item block of a node and the room the layout reserves for it.

import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import {
  BAND_PADDING_Y,
  clearLayoutCache,
  computeLayout,
  computeLayoutUncached,
  deserializeLayout,
  GROUP_PADDING,
  HEADER_HEIGHT,
  layoutKey,
  LAYOUT_CONFIG,
  LEAF_SIZE,
  leafSize,
  serializeLayout,
  type LayoutResult,
  type Rect,
  type Size,
} from './layout';
import { layoutViolations, parseOk, rectOf } from './layout/test-helpers';
import { buildFlow, edgeLabelSize, flowEdgeLabel } from './flow';
import { hiddenSamples, labelRect, overlapArea } from './route';
import type { ArchitectureModel } from './model';
import { estimateTextWidth } from './text';
import {
  moreLinesText,
  WORK_ITEM_GEOMETRY,
  workItemBlockSize,
  workItemContent,
  workItemLineRect,
  workItemLines,
  workItemLinesRect,
  workItemTextRects,
  type NodeContent,
} from './workItemContent';
import { buildWorkItemOverlay } from './workItemOverlay';
import { parseWorkItems, STORY_MODES, type WorkItemSummary, type WorkItemType } from './workitems';

const G = WORK_ITEM_GEOMETRY;

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
edges:
  - { id: e1, from: a.x.one, to: a.y, kind: dataflow }
  - { id: e2, from: a.y, to: b, kind: dependency }
`);

function item(
  id: number,
  type: WorkItemType,
  tags: string[] = [],
  extra: Partial<WorkItemSummary> = {},
): WorkItemSummary {
  return { id, type, title: `Item ${id}`, state: 'Active', componentIds: tags, tags: [], ...extra };
}

const LONG = 'Convert the checkout configuration and re-map all payment routes';

describe('workItemLines', () => {
  const overlay = buildWorkItemOverlay(model, [
    item(1, 'User Story', ['a.y'], { title: LONG }),
    item(2, 'Task', [], { parentId: 1, title: 'Send the device signals with every event' }),
    item(3, 'Task', [], { parentId: 1, title: 'Short task' }),
    item(4, 'Bug', ['a.y']),
  ]);

  it('lists nothing in mode Off or for a node without items', () => {
    expect(workItemLines(overlay, 'a.y', 'off')).toEqual([]);
    expect(workItemLines(overlay, 'b', 'tasks')).toEqual([]);
    expect(workItemLines(overlay, 'nope', 'stories')).toEqual([]);
  });

  it('lists the top-level items in mode Stories, titles cut to the maximum', () => {
    const lines = workItemLines(overlay, 'a.y', 'stories');
    expect(lines.map((line) => line.kind)).toEqual(['item', 'item']);
    expect(lines[0]?.text).toHaveLength(G.maxTitleChars);
    expect(lines[0]?.text.endsWith('…')).toBe(true);
    expect(LONG.startsWith(lines[0]?.text.slice(0, -1) ?? '?')).toBe(true);
    expect(lines[1]).toMatchObject({ kind: 'item', text: 'Item 4' });
  });

  it('adds the tasks under their item in mode Stories + Tasks, as their first words', () => {
    const lines = workItemLines(overlay, 'a.y', 'tasks');
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ['item', lines[0]?.text],
      ['task', 'Send the device…'],
      ['task', 'Short task'],
      ['item', 'Item 4'],
    ]);
    expect(lines[1]).toMatchObject({ parentId: 1, item: { id: 2 } });
  });

  it('caps a long list and says how many lines are left out', () => {
    const many = buildWorkItemOverlay(
      model,
      Array.from({ length: G.maxLines + 4 }, (_, i) => item(i + 1, 'User Story', ['b'])),
    );
    const lines = workItemLines(many, 'b', 'stories');
    expect(lines).toHaveLength(G.maxLines);
    expect(lines.at(-1)).toEqual({ kind: 'more', count: 5, text: moreLinesText(5) });
    expect(lines.at(-1)?.text).toBe('+5 more');
    // Exactly the maximum needs no "more" line.
    const exact = buildWorkItemOverlay(
      model,
      Array.from({ length: G.maxLines }, (_, i) => item(i + 1, 'User Story', ['b'])),
    );
    expect(workItemLines(exact, 'b', 'stories').every((line) => line.kind === 'item')).toBe(true);
  });
});

describe('workItemBlockSize / workItemContent', () => {
  const overlay = buildWorkItemOverlay(model, [
    item(1, 'User Story', ['a.y', 'a'], { title: LONG }),
    item(2, 'Task', [], { parentId: 1, title: 'Send the device signals with every event' }),
    item(4, 'Bug', ['a.x.one']),
  ]);

  it('sizes a block from the shared geometry: one line height each, the widest line', () => {
    const lines = workItemLines(overlay, 'a.y', 'tasks');
    const size = workItemBlockSize(lines);
    expect(size.height).toBe(G.paddingTop + 2 * G.lineHeight + G.paddingBottom);
    const widest = Math.max(
      G.iconSize + G.iconGap + estimateTextWidth(lines[0]?.text ?? '', G.fontSize),
      G.taskIndent + G.iconSize + G.iconGap + estimateTextWidth('Send the device…', G.taskFontSize),
    );
    expect(size.width).toBeGreaterThanOrEqual(2 * G.paddingX + widest);
    expect(size.width).toBeLessThan(2 * G.paddingX + widest + G.widthStep);
    expect(size.width % G.widthStep).toBe(0);
  });

  it('bounds every block: the cap on lines and on title length', () => {
    const wide = 'W'.repeat(200);
    const many = buildWorkItemOverlay(
      model,
      Array.from({ length: 40 }, (_, i) => item(i + 1, 'User Story', ['b'], { title: wide })),
    );
    const block = workItemContent(many, 'tasks').get('b');
    expect(block?.height).toBe(G.paddingTop + G.maxLines * G.lineHeight + G.paddingBottom);
    expect(block?.width).toBeLessThanOrEqual(
      2 * G.paddingX + G.iconSize + G.iconGap + G.maxTitleChars * G.fontSize * 1.4 + G.widthStep,
    );
  });

  it('gives a block to every node with lines, in document order, and none in mode Off', () => {
    expect(workItemContent(overlay, 'off').size).toBe(0);
    const stories = workItemContent(overlay, 'stories');
    expect([...stories.keys()]).toEqual(['a', 'a.x.one', 'a.y']);
    const tasks = workItemContent(overlay, 'tasks');
    expect(tasks.get('a.y')?.lines).toHaveLength(2);
    expect(tasks.get('a.y')?.height).toBe((stories.get('a.y')?.height ?? 0) + G.lineHeight);
    expect(tasks.get('a.x.one')).toEqual(stories.get('a.x.one'));
  });
});

// --- Layout reservation ---------------------------------------------------------------------

const bottom = (r: Rect): number => r.y + r.height;

/** Every content block lies inside its node, clear of the header / name and of the children. */
function contentViolations(
  m: ArchitectureModel,
  layout: LayoutResult,
  content: ReadonlyMap<string, Size>,
): string[] {
  const problems: string[] = [];
  if ([...layout.content.keys()].join() !== [...content.keys()].join()) {
    problems.push('content blocks differ from the content given');
  }
  for (const [id, block] of layout.content) {
    const node = m.nodes.get(id);
    const rect = layout.rects.get(id);
    const size = content.get(id);
    if (!node || !rect || !size) {
      problems.push(`${id}: no node for the block`);
      continue;
    }
    if (block.height !== size.height) problems.push(`${id}: block height`);
    if (block.x !== 0 || block.width !== rect.width) problems.push(`${id}: block not full width`);
    if (rect.width < size.width) problems.push(`${id}: narrower than its content`);
    if (bottom(block) > rect.height) problems.push(`${id}: block sticks out below`);
    if (node.childIds.length === 0) {
      if (block.y !== LEAF_SIZE[node.level].height) problems.push(`${id}: block not below name`);
      if (rect.height !== LEAF_SIZE[node.level].height + size.height) {
        problems.push(`${id}: leaf did not grow by its content`);
      }
      continue;
    }
    if (block.y !== HEADER_HEIGHT) problems.push(`${id}: block not below the header`);
    for (const childId of node.childIds) {
      const child = layout.rects.get(childId);
      if (child && child.y < bottom(block)) problems.push(`${childId}: overlaps block of ${id}`);
    }
  }
  return problems;
}

describe('workItemLinesRect / workItemLineRect', () => {
  const overlay = buildWorkItemOverlay(model, [
    item(1, 'User Story', ['a']),
    item(2, 'Task', [], { parentId: 1 }),
    item(3, 'Bug', ['a']),
  ]);
  const lines = workItemLines(overlay, 'a', 'tasks');
  const size = workItemBlockSize(lines);

  it('covers the left part of a wide block, as wide as the lines need', () => {
    const block = { x: 12, y: 40, width: 900, height: size.height };
    expect(workItemLinesRect(block, lines)).toEqual({ ...block, width: size.width });
    // A block no wider than the lines (a leaf) is covered entirely.
    const narrow = { ...block, width: size.width - 8 };
    expect(workItemLinesRect(narrow, lines)).toEqual(narrow);
  });

  it('finds the line of an item within the block', () => {
    const block = { x: 12, y: 40, width: 900, height: size.height };
    expect(workItemLineRect(block, lines, 1)).toEqual({
      x: 12,
      y: 40 + G.paddingTop,
      width: size.width,
      height: G.lineHeight,
    });
    expect(workItemLineRect(block, lines, 3)?.y).toBe(40 + G.paddingTop + 2 * G.lineHeight);
    expect(workItemLineRect(block, lines, 99)).toBeUndefined();
    // In Stories only the task has no line.
    expect(workItemLineRect(block, workItemLines(overlay, 'a', 'stories'), 2)).toBeUndefined();
  });
});

describe('computeLayout with content (no rows)', () => {
  const content = new Map<string, Size>([
    ['a', { width: 520, height: 70 }],
    ['a.x', { width: 96, height: 50 }],
    ['a.x.one', { width: 240, height: 30 }],
    ['b', { width: 304, height: 52 }],
  ]);
  let plain: LayoutResult;
  let layout: LayoutResult;
  beforeAll(async () => {
    plain = await computeLayoutUncached(model);
    layout = await computeLayoutUncached(model, undefined, content);
  });

  it('keeps every geometric invariant and puts the blocks where they belong', () => {
    expect(layoutViolations(model, layout)).toEqual([]);
    expect(contentViolations(model, layout, content)).toEqual([]);
  });

  it('grows a leaf to fit its block', () => {
    const base = leafSize(model.nodes.get('a.x.one') ?? fail());
    expect(rectOf(layout, 'a.x.one')).toMatchObject({ width: 240, height: base.height + 30 });
    expect(rectOf(layout, 'b')).toMatchObject({ width: 304, height: LEAF_SIZE[0].height + 52 });
    // A leaf without content keeps its size.
    expect(rectOf(layout, 'a.y').height).toBe(rectOf(plain, 'a.y').height);
    expect(rectOf(layout, 'a.y').width).toBe(rectOf(plain, 'a.y').width);
  });

  it('reserves the block of a group between its header and its children', () => {
    const group = rectOf(layout, 'a');
    expect(group.width).toBeGreaterThanOrEqual(520);
    for (const id of ['a.x', 'a.y']) {
      expect(rectOf(layout, id).y).toBeGreaterThanOrEqual(group.y + GROUP_PADDING.top + 70);
    }
    const inner = rectOf(layout, 'a.x');
    expect(rectOf(layout, 'a.x.one').y).toBeGreaterThanOrEqual(inner.y + GROUP_PADDING.top + 50);
    expect(layout.content.get('a')).toEqual({
      x: 0,
      y: HEADER_HEIGHT,
      width: group.width,
      height: 70,
    });
  });

  it('is deterministic and round-trips through the persistent form', async () => {
    const again = await computeLayoutUncached(model, undefined, new Map([...content].reverse()));
    expect(serializeLayout(again)).toBe(serializeLayout(layout));
    expect(deserializeLayout(serializeLayout(layout))).toEqual(layout);
  });

  it('is exactly the plain layout without content, in any way of saying "none"', async () => {
    const ignored = new Map<string, Size>([
      ['nope', { width: 500, height: 100 }],
      ['a.y', { width: 500, height: 0 }],
    ]);
    for (const none of [undefined, new Map<string, Size>(), ignored]) {
      const same = await computeLayoutUncached(model, undefined, none);
      expect(serializeLayout(same)).toBe(serializeLayout(plain));
      expect(same.key).toBe(layoutKey(model));
      expect(same.content.size).toBe(0);
    }
    expect(serializeLayout(plain)).not.toContain('"content"');
    // A layout stored before there was content still loads.
    expect(deserializeLayout(serializeLayout(plain))?.content).toEqual(new Map());
  });
});

function fail(): never {
  throw new Error('missing node');
}

describe('layout cache key with content', () => {
  it('covers the content sizes, in model order', () => {
    const one = new Map<string, Size>([['a.y', { width: 200, height: 30 }]]);
    const taller = new Map<string, Size>([['a.y', { width: 200, height: 52 }]]);
    const wider = new Map<string, Size>([['a.y', { width: 208, height: 30 }]]);
    const keys = [undefined, one, taller, wider].map((c) => layoutKey(model, LAYOUT_CONFIG, c));
    expect(new Set(keys).size).toBe(4);
    expect(layoutKey(model, LAYOUT_CONFIG, new Map())).toBe(layoutKey(model));
    const two = new Map<string, Size>([...one, ['b', { width: 200, height: 30 }]]);
    expect(layoutKey(model, LAYOUT_CONFIG, new Map([...two].reverse()))).toBe(
      layoutKey(model, LAYOUT_CONFIG, two),
    );
  });

  it('caches per content: the same content hits, other content lays out again', async () => {
    clearLayoutCache();
    const content = new Map<string, Size>([['a.y', { width: 200, height: 30 }]]);
    const plain = await computeLayout(model);
    const first = await computeLayout(model, { content });
    expect(first).not.toBe(plain);
    expect(first.key).not.toBe(plain.key);
    expect(await computeLayout(model, { content: new Map(content) })).toBe(first);
    expect(await computeLayout(model, { content: new Map() })).toBe(plain);
    expect(rectOf(first, 'a.y').height).toBe(rectOf(plain, 'a.y').height + 30);
  });
});

describe('computeLayout with content (rows)', () => {
  const tiered = parseOk(`
version: 1
rows:
  - { id: top, name: Top }
  - { id: mid, name: Middle }
  - { id: bot, name: Bottom }
domains:
  - id: s
    name: Span
    components:
      - { id: s.up, name: Up, row: top }
      - id: s.inner
        name: Inner span
        subcomponents:
          - { id: s.inner.mid, name: Mid, row: mid }
          - { id: s.inner.low, name: Low, row: bot }
      - { id: s.free, name: Attracted }
  - id: r
    name: Row domain
    row: mid
    components:
      - { id: r.one, name: One }
  - id: u
    name: Unassigned
    components:
      - { id: u.one, name: One }
edges:
  - { id: e1, from: s.free, to: s.inner.low, kind: dataflow }
  - { id: e2, from: s.up, to: r.one, kind: dataflow }
  - { id: e3, from: u.one, to: r.one, kind: dataflow }
`);
  const content = new Map<string, Size>([
    ['s', { width: 600, height: 80 }],
    ['s.up', { width: 240, height: 30 }],
    ['s.inner', { width: 320, height: 60 }],
    ['s.inner.low', { width: 200, height: 96 }],
    ['s.free', { width: 216, height: 52 }],
    ['r', { width: 400, height: 74 }],
    ['r.one', { width: 264, height: 30 }],
    ['u', { width: 280, height: 52 }],
    ['u.one', { width: 248, height: 74 }],
  ]);
  let plain: LayoutResult;
  let layout: LayoutResult;
  beforeAll(async () => {
    plain = await computeLayoutUncached(tiered);
    layout = await computeLayoutUncached(tiered, undefined, content);
  });

  it('keeps every invariant: no overlap, containment, bands, the Unassigned area', () => {
    expect(layoutViolations(tiered, plain)).toEqual([]);
    expect(layoutViolations(tiered, layout)).toEqual([]);
    expect(contentViolations(tiered, layout, content)).toEqual([]);
    expect(layout.placedRow).toEqual(plain.placedRow);
    expect(layout.rowOf).toEqual(plain.rowOf);
  });

  it('keeps the block of a spanning group free at the top of its top row', () => {
    const span = rectOf(layout, 's');
    expect(span.width).toBeGreaterThanOrEqual(600);
    const top = layout.rows[0] ?? fail();
    expect(span.y).toBe(top.y + BAND_PADDING_Y);
    // Children in the top row start below header + block; the band grew to hold them.
    expect(rectOf(layout, 's.up').y).toBe(span.y + GROUP_PADDING.top + 80);
    expect(bottom(rectOf(layout, 's.up'))).toBeLessThanOrEqual(bottom(top) - BAND_PADDING_Y);
    expect(top.height).toBeGreaterThan(plain.rows[0]?.height ?? Infinity);
    // The nested spanning group starts in the middle row and keeps its own block free there.
    const inner = rectOf(layout, 's.inner');
    expect(rectOf(layout, 's.inner.mid').y).toBe(inner.y + GROUP_PADDING.top + 60);
    expect(inner.width).toBeGreaterThanOrEqual(320);
  });

  it('grows single-row items, attracted nodes and unassigned nodes', () => {
    expect(rectOf(layout, 's.inner.low').height).toBe(LEAF_SIZE[2].height + 96);
    expect(rectOf(layout, 's.free')).toMatchObject({
      width: 216,
      height: LEAF_SIZE[1].height + 52,
    });
    expect(rectOf(layout, 'r').width).toBeGreaterThanOrEqual(400);
    expect(rectOf(layout, 'r.one').y).toBeGreaterThanOrEqual(
      rectOf(layout, 'r').y + GROUP_PADDING.top + 74,
    );
    expect(rectOf(layout, 'u.one').y).toBeGreaterThanOrEqual(
      rectOf(layout, 'u').y + GROUP_PADDING.top + 52,
    );
    expect(layout.unassignedArea?.width).toBeGreaterThan(plain.unassignedArea?.width ?? Infinity);
  });

  it('is exactly the plain layout without content', async () => {
    const same = await computeLayoutUncached(tiered, undefined, new Map());
    expect(serializeLayout(same)).toBe(serializeLayout(plain));
  });
});

describe('the example with the dummy work items', () => {
  const example = parseOk(exampleYaml);
  const { items } = parseWorkItems(fixtureJson);
  const overlay = buildWorkItemOverlay(example, items);
  let plain: LayoutResult;
  beforeAll(async () => {
    plain = await computeLayoutUncached(example);
  });

  it('is the layout of today in mode Off', async () => {
    const content = workItemContent(overlay, 'off');
    const off = await computeLayoutUncached(example, undefined, content);
    expect(serializeLayout(off)).toBe(serializeLayout(plain));
    expect(layoutKey(example, LAYOUT_CONFIG, content)).toBe(layoutKey(example));
  });

  it.each(STORY_MODES.filter((mode) => mode !== 'off'))(
    'keeps every layout invariant in mode %s',
    async (mode) => {
      const content: Map<string, NodeContent> = workItemContent(overlay, mode);
      expect(content.size).toBeGreaterThan(15);
      const layout = await computeLayoutUncached(example, undefined, content);
      expect(layoutViolations(example, layout)).toEqual([]);
      expect(contentViolations(example, layout, content)).toEqual([]);
      expect(layout.key).not.toBe(plain.key);
      expect(layout.placedRow).toEqual(plain.placedRow);
      expect(layout.rowOf).toEqual(plain.rowOf);
      // Deterministic.
      const again = await computeLayoutUncached(example, undefined, workItemContent(overlay, mode));
      expect(serializeLayout(again)).toBe(serializeLayout(layout));
      // Nodes without work items anywhere near keep their size.
      expect(rectOf(layout, 'platform.logging').height).toBe(
        rectOf(plain, 'platform.logging').height,
      );
    },
  );

  it.each(STORY_MODES.filter((mode) => mode !== 'off'))(
    'draws the lists of open groups above the edges, clear of edges and labels, in mode %s',
    async (mode) => {
      const layout = await computeLayoutUncached(
        example,
        undefined,
        workItemContent(overlay, mode),
      );
      const flow = buildFlow(example, layout, { lodLevel: 'detail', workItems: { overlay, mode } });
      const lists: Rect[] = [];
      const texts: Rect[] = [];
      for (const node of flow.nodes) {
        if (node.type === 'band') continue;
        const listed = node.data.workItems;
        const absolute = rectOf(layout, node.id);
        if (listed) {
          const list = listed.above ?? {
            ...listed.rect,
            x: absolute.x + listed.rect.x,
            y: absolute.y + listed.rect.y,
          };
          texts.push(...workItemTextRects(list, listed.lines));
        }
        if (node.type === 'leaf') {
          expect(listed?.above).toBeUndefined();
        } else if (listed) {
          // The left part of the reserved block, in canvas coordinates.
          expect(listed.above).toEqual({
            x: absolute.x + listed.rect.x,
            y: absolute.y + listed.rect.y,
            width: Math.min(listed.rect.width, workItemBlockSize(listed.lines).width),
            height: listed.rect.height,
          });
          if (listed.above) lists.push(listed.above);
        }
      }
      expect(lists.length).toBeGreaterThan(3);
      // No label lies on the text of a work-item line.
      const report: string[] = [];
      const hidden: string[] = [];
      for (const edge of flow.edges) {
        const text = flowEdgeLabel(edge.data);
        if (text === undefined) continue;
        if (edge.data.labelHidden === true) {
          hidden.push(edge.id);
          continue;
        }
        const label = labelRect(
          edge.data.curve,
          edge.data.route.labelT,
          edgeLabelSize(edge.data.labelText ?? text),
        );
        const onText = texts.reduce((sum, rect) => sum + overlapArea(label, rect), 0);
        if (onText > 0) report.push(`${edge.id}: ${Math.round(onText)}`);
      }
      expect(report).toEqual([]);
      // Few labels have no such place (two boxes with lists 20 pixels apart) and are left out.
      expect(hidden.length).toBeLessThanOrEqual(3);
      // The edges are routed around the lists where they can: no edge has more than a fifth
      // of its length behind one.
      const behind = flow.edges.map((edge) => hiddenSamples(edge.data.curve, lists, 100));
      expect(Math.max(...behind)).toBeLessThan(20);
    },
  );

  it('leaves no label out without work items on the canvas', () => {
    const flow = buildFlow(example, plain, { lodLevel: 'detail' });
    const labelled = flow.edges.filter((edge) => flowEdgeLabel(edge.data) !== undefined);
    expect(labelled.length).toBeGreaterThan(30);
    expect(labelled.filter((edge) => edge.data.labelHidden === true)).toEqual([]);
    for (const node of flow.nodes) {
      if (node.type !== 'band') expect(node.data.workItems).toBeUndefined();
    }
  });

  it('needs more room with tasks than with stories only, and less with a filter', async () => {
    const height = async (content: ReadonlyMap<string, Size>): Promise<number> =>
      (await computeLayoutUncached(example, undefined, content)).bounds.height;
    const stories = await height(workItemContent(overlay, 'stories'));
    const tasks = await height(workItemContent(overlay, 'tasks'));
    expect(stories).toBeGreaterThan(plain.bounds.height);
    expect(tasks).toBeGreaterThan(stories);
    const open = buildWorkItemOverlay(example, items, { hiddenStates: ['Closed', 'Resolved'] });
    expect(workItemContent(open, 'tasks').size).toBeLessThan(
      workItemContent(overlay, 'tasks').size,
    );
  });
});
