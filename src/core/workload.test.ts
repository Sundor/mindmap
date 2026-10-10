import { describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import {
  availableIterations,
  availableStates,
  buildWorkItemOverlay,
  drawnProgressText,
  drawnWorkItemIds,
  filterToFocus,
  focusSet,
  groupIds,
  heatByWork,
  heatOfDrawn,
  heatText,
  isOpenState,
  LOD_LEVELS,
  onMapText,
  parseWorkItems,
  progressByNode,
  progressOfDrawn,
  progressText,
  subtreeWorkItemIds,
  visibleNodes,
  type ArchitectureModel,
  type Focus,
  type WorkItemFilter,
  type WorkItemOverlay,
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

// --- What a drawn box stands for ----------------------------------------------------------------

/** The items above, and one on the domain itself. */
const overlay = buildWorkItemOverlay(model, [...items, item(7, 'User Story', ['a'])]);
const everything = visibleNodes(model, new Set(), 'detail');

function sorted(ids: Iterable<number> | undefined): number[] {
  return [...(ids ?? [])].sort((p, q) => p - q);
}

/** `[box, its items]`, in the order of the map. */
function listed(figures: ReadonlyMap<string, ReadonlySet<number>>): [string, number[]][] {
  return [...figures].map(([box, ids]) => [box, sorted(ids)]);
}

describe('drawnWorkItemIds', () => {
  it('gives every box its own items when everything is drawn', () => {
    expect(listed(drawnWorkItemIds(model, overlay, everything))).toEqual([
      ['a', [7]],
      ['a.x', [4]],
      ['a.x.one', [1, 2, 3]],
      ['a.y', [4, 5]],
      ['b', [6]],
    ]);
  });

  it('gives a closed group everything inside it, once', () => {
    const ids = drawnWorkItemIds(model, overlay, visibleNodes(model, new Set(['a']), 'detail'));
    expect(listed(ids)).toEqual([
      ['a', [1, 2, 3, 4, 5, 7]], // the bug on two nodes counts once
      ['b', [6]],
    ]);
    expect(sorted(ids.get('a'))).toEqual(sorted(subtreeWorkItemIds(model, overlay).get('a')));
  });

  it('takes what the level of detail hides as it takes what a collapse hides', () => {
    const components = visibleNodes(model, new Set(), 'components');
    expect(listed(drawnWorkItemIds(model, overlay, components))).toEqual([
      ['a', [7]],
      ['a.x', [1, 2, 3, 4]],
      ['a.y', [4, 5]],
      ['b', [6]],
    ]);
    const collapsed = visibleNodes(model, new Set(['a.x']), 'detail');
    expect(listed(drawnWorkItemIds(model, overlay, collapsed))).toEqual(
      listed(drawnWorkItemIds(model, overlay, components)),
    );
    const domains = visibleNodes(model, new Set(), 'domains');
    expect(listed(drawnWorkItemIds(model, overlay, domains))).toEqual([
      ['a', [1, 2, 3, 4, 5, 7]],
      ['b', [6]],
    ]);
  });

  it('counts what a filtered map leaves out of a drawn group on that group, and a domain it leaves out nowhere', () => {
    const reduced = filterToFocus(model, {
      nodes: new Set(['a.x.one']),
      edges: new Set(),
      itemIds: new Set(),
    });
    if (!reduced) throw new Error('nothing is left out');
    expect([...reduced.model.nodes.keys()]).toEqual(['a', 'a.x', 'a.x.one']);
    // Who is drawn comes from the part, the way up from the whole model.
    const drawn = visibleNodes(reduced.model, new Set(), 'detail');
    expect(listed(drawnWorkItemIds(model, overlay, drawn))).toEqual([
      ['a', [4, 5, 7]], // its own 7, and the 4 and 5 of a.y
      ['a.x', [4]],
      ['a.x.one', [1, 2, 3]],
    ]);
  });

  it('leaves out the boxes with nothing and keeps the order of the model', () => {
    const plain = buildWorkItemOverlay(model, items);
    expect([...drawnWorkItemIds(model, plain, everything).keys()]).toEqual([
      'a.x',
      'a.x.one',
      'a.y',
      'b',
    ]);
    // The first items of `a` are those of a.y, after the boxes drawn inside `a`.
    const withoutY = new Set(['a', 'a.x', 'a.x.one', 'b']);
    expect(listed(drawnWorkItemIds(model, plain, withoutY))).toEqual([
      ['a', [4, 5]],
      ['a.x', [4]],
      ['a.x.one', [1, 2, 3]],
      ['b', [6]],
    ]);
    expect(drawnWorkItemIds(model, plain, new Set()).size).toBe(0);
  });
});

describe('heatOfDrawn', () => {
  it('counts on an open group what no box inside it shows, against the hottest whole node of its level', () => {
    expect(heatByWork(model, overlay).get('a')).toEqual({ open: 4, fraction: 1 }); // 1, 2, 5, 7
    const open = heatOfDrawn(model, overlay, everything);
    expect([...open]).toEqual([
      ['a', { open: 1, fraction: 0.25, inAll: 4 }],
      ['a.x.one', { open: 2, fraction: 1, inAll: 2 }],
      ['a.y', { open: 1, fraction: 0.5, inAll: 1 }],
    ]);
    const closed = heatOfDrawn(model, overlay, visibleNodes(model, new Set(['a']), 'detail'));
    expect([...closed]).toEqual([['a', { open: 4, fraction: 1, inAll: 4 }]]);
  });

  it('keeps the scale when a group is closed: no other strip changes', () => {
    const closed = heatOfDrawn(model, overlay, visibleNodes(model, new Set(['a.x']), 'detail'));
    expect([...closed]).toEqual([
      ['a', { open: 1, fraction: 0.25, inAll: 4 }],
      ['a.x', { open: 2, fraction: 1, inAll: 2 }],
      ['a.y', { open: 1, fraction: 0.5, inAll: 1 }],
    ]);
  });

  it('follows the filter: hidden items are no work', () => {
    const hidden = buildWorkItemOverlay(model, items, { hiddenStates: ['active'] });
    expect(heatOfDrawn(model, hidden, everything).size).toBe(0);
  });
});

describe('progressOfDrawn', () => {
  it('counts the completed items over all that no box inside shows', () => {
    const open = progressOfDrawn(model, overlay, everything);
    expect([...open]).toEqual([
      ['a', { done: 0, total: 1, inAll: { done: 2, total: 6 } }],
      ['a.x', { done: 1, total: 1, inAll: { done: 2, total: 4 } }],
      ['a.x.one', { done: 1, total: 3, inAll: { done: 1, total: 3 } }],
      ['a.y', { done: 1, total: 2, inAll: { done: 1, total: 2 } }],
      ['b', { done: 1, total: 1, inAll: { done: 1, total: 1 } }],
    ]);
    const closed = progressOfDrawn(model, overlay, visibleNodes(model, new Set(['a.x']), 'detail'));
    expect(closed.get('a.x')).toEqual({ done: 2, total: 4, inAll: { done: 2, total: 4 } });
    expect(closed.get('a')).toEqual({ done: 0, total: 1, inAll: { done: 2, total: 6 } });
    expect(closed.has('a.x.one')).toBe(false);
  });

  it('gives a box with completed items only a bar and no strip, and a box with nothing left neither', () => {
    const heat = heatOfDrawn(model, overlay, everything);
    const progress = progressOfDrawn(model, overlay, everything);
    for (const box of ['a.x', 'b']) {
      expect(heat.has(box), box).toBe(false);
      expect(progress.get(box), box).toMatchObject({ done: 1, total: 1 });
    }
    // Without an item of its own, the open domain has nothing that its boxes do not show.
    const plain = buildWorkItemOverlay(model, items);
    expect(heatByWork(model, plain).get('a')).toEqual({ open: 3, fraction: 1 });
    expect(progressByNode(model, plain).get('a')).toEqual({ done: 2, total: 5 });
    expect(heatOfDrawn(model, plain, everything).has('a')).toBe(false);
    expect(progressOfDrawn(model, plain, everything).has('a')).toBe(false);
  });
});

// --- The same for any level, collapsed set and filter -------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One to four domains, each of up to three components of up to three subcomponents. */
function randomModel(random: () => number): ArchitectureModel {
  const lines = ['version: 1', 'domains:'];
  const domains = 1 + Math.floor(random() * 4);
  for (let d = 0; d < domains; d++) {
    lines.push(`  - id: d${d}`, `    name: D${d}`);
    const components = Math.floor(random() * 4);
    if (components > 0) lines.push('    components:');
    for (let c = 0; c < components; c++) {
      lines.push(`      - id: d${d}.c${c}`, `        name: C${c}`);
      const subcomponents = Math.floor(random() * 4);
      if (subcomponents > 0) lines.push('        subcomponents:');
      for (let s = 0; s < subcomponents; s++) {
        lines.push(`          - { id: d${d}.c${c}.s${s}, name: S${s} }`);
      }
    }
  }
  return parseOk(lines.join('\n'));
}

const STATES = ['New', 'Active', 'Closed', 'Done', 'Resolved'];

/** Stories and bugs on one to `maxTags` of `nodes` each, with up to two tasks under each. */
function randomItems(
  random: () => number,
  nodes: readonly string[],
  maxTags: number,
): WorkItemSummary[] {
  const state = (): string => STATES[Math.floor(random() * STATES.length)] ?? 'Active';
  const result: WorkItemSummary[] = [];
  const count = 5 + Math.floor(random() * 30);
  let id = 1;
  for (let i = 0; i < count; i++) {
    const tags = new Set<string>();
    const tagCount = 1 + Math.floor(random() * maxTags);
    for (let t = 0; t < tagCount; t++) tags.add(nodes[Math.floor(random() * nodes.length)] ?? '');
    const parentId = id++;
    const type = random() < 0.3 ? 'Bug' : 'User Story';
    result.push(item(parentId, type, [...tags], { state: state() }));
    const tasks = Math.floor(random() * 3);
    for (let t = 0; t < tasks; t++)
      result.push(item(id++, 'Task', [], { parentId, state: state() }));
  }
  return result;
}

/** A part of `all`, of any share. */
function randomSubset<T>(random: () => number, all: readonly T[]): Set<T> {
  const share = random();
  return new Set(all.filter(() => random() < share));
}

/** No filter, the completed items hidden, or some of the states hidden. */
function randomFilter(random: () => number): WorkItemFilter {
  const pick = random();
  if (pick < 0.4) return {};
  if (pick < 0.6) return { hideCompleted: true };
  return { hiddenStates: randomSubset(random, STATES) };
}

/** `m` as a filtered map draws it for some of its nodes, or `m` itself when none is left out. */
function randomPart(random: () => number, m: ArchitectureModel): ArchitectureModel {
  const nodes = randomSubset(random, [...m.nodes.keys()]);
  return filterToFocus(m, { nodes, edges: new Set(), itemIds: new Set() })?.model ?? m;
}

/** `id` and the nodes around it, nearest first. */
function chain(m: ArchitectureModel, id: string): string[] {
  const ids: string[] = [];
  for (let node = m.nodes.get(id); node;) {
    ids.push(node.id);
    node = node.parentId === undefined ? undefined : m.nodes.get(node.parentId);
  }
  return ids;
}

/** Every shown item with a node that lists it: as a row, or as a task under one. */
function listings(over: WorkItemOverlay): { id: number; node: string }[] {
  const result: { id: number; node: string }[] = [];
  for (const [node, rows] of over.rows) {
    for (const row of rows) {
      result.push({ id: row.item.id, node });
      for (const task of row.tasks) result.push({ id: task.id, node });
    }
  }
  return result;
}

/** What the strips and the bars of a map add up to. */
interface Sums {
  readonly open: number;
  readonly done: number;
  readonly total: number;
}

/**
 * Holds the figures of the boxes `drawn` of `m` against the rule, told twice — box by box and
 * listing by listing — and the heat and the progress against the figures. Returns their sums.
 * `drawn` is what `visibleNodes` gives for `m` or for a part of it.
 */
function expectFigures(
  m: ArchitectureModel,
  over: WorkItemOverlay,
  drawn: ReadonlySet<string>,
  label: string,
): Sums {
  const figures = drawnWorkItemIds(m, over, drawn);
  const order = [...m.nodes.keys()];
  const isOpen = (id: number): boolean => isOpenState(over.byId.get(id)?.state ?? '');

  // Box by box: its own items and all of every child that is not drawn — so everything inside
  // a closed box, and its own rows alone on a group whose children are all drawn. No box
  // without items; in the order of the model.
  const inside = subtreeWorkItemIds(m, over);
  const perBox: [string, number[]][] = [];
  for (const node of m.nodes.values()) {
    if (!drawn.has(node.id)) continue;
    const ids = new Set<number>();
    for (const row of over.rows.get(node.id) ?? []) {
      ids.add(row.item.id);
      for (const task of row.tasks) ids.add(task.id);
    }
    for (const child of node.childIds) {
      if (!drawn.has(child)) for (const id of inside.get(child) ?? []) ids.add(id);
    }
    if (ids.size > 0) perBox.push([node.id, sorted(ids)]);
  }
  expect(listed(figures), label).toEqual(perBox);

  // Listing by listing: the item is on the nearest drawn box around its node, on no box when
  // nothing around the node is drawn, and on no other box for that node.
  const landed = new Map<string, Set<number>>();
  const listedOn = new Map<number, Set<string>>();
  for (const { id, node } of listings(over)) {
    listedOn.set(id, (listedOn.get(id) ?? new Set<string>()).add(node));
    const box = chain(m, node).find((around) => drawn.has(around));
    if (box !== undefined) landed.set(box, (landed.get(box) ?? new Set<number>()).add(id));
  }
  const perListing: [string, number[]][] = [];
  for (const box of order) if (landed.has(box)) perListing.push([box, sorted(landed.get(box))]);
  expect(listed(figures), label).toEqual(perListing);

  // A box never shows what a box drawn inside it shows: an item on both is listed on several
  // nodes, one for each.
  const shownAgain: string[] = [];
  for (const [box, ids] of figures) {
    for (const around of chain(m, box).slice(1)) {
      for (const id of figures.get(around) ?? []) {
        if (ids.has(id) && (listedOn.get(id)?.size ?? 0) < 2) shownAgain.push(`${id} on ${box}`);
      }
    }
  }
  expect(shownAgain, label).toEqual([]);

  // Heat: the open items of the figure over the open items of the hottest whole node of the
  // level; no strip without open work. Progress: the completed items of the figure over all.
  const wholeHeat = heatByWork(m, over);
  const wholeProgress = progressByNode(m, over);
  const hottest = (box: string): number => {
    const level = m.nodes.get(box)?.level;
    for (const [id, heat] of wholeHeat) {
      if (m.nodes.get(id)?.level === level && heat.fraction === 1) return heat.open;
    }
    return 0;
  };
  const heat = heatOfDrawn(m, over, drawn);
  const progress = progressOfDrawn(m, over, drawn);
  const wantHeat: [string, unknown][] = [];
  const wantProgress: [string, unknown][] = [];
  for (const [box, ids] of perBox) {
    const open = ids.filter(isOpen).length;
    const inAll = wholeProgress.get(box);
    wantProgress.push([box, { done: ids.length - open, total: ids.length, inAll }]);
    if (open === 0) continue;
    wantHeat.push([box, { open, fraction: open / hottest(box), inAll: wholeHeat.get(box)?.open }]);
  }
  expect([...heat], label).toEqual(wantHeat);
  expect([...progress], label).toEqual(wantProgress);
  // A strip is never empty and never higher than the box; no figure is above that of the whole.
  for (const [box, of] of heat) {
    expect(of.fraction, `${label} ${box}`).toBeGreaterThan(0);
    expect(of.fraction, `${label} ${box}`).toBeLessThanOrEqual(1);
    expect(of.open, `${label} ${box}`).toBeLessThanOrEqual(of.inAll);
  }
  for (const [box, of] of progress) {
    expect(of.total, `${label} ${box}`).toBeLessThanOrEqual(of.inAll.total);
    expect(of.done, `${label} ${box}`).toBeLessThanOrEqual(of.inAll.done);
  }

  // The sums: every item once for each box it landed on.
  const onBoxes = [...landed.values()].flatMap((ids) => [...ids]);
  const sums = { open: 0, done: 0, total: 0 };
  for (const of of heat.values()) sums.open += of.open;
  for (const of of progress.values()) {
    sums.done += of.done;
    sums.total += of.total;
  }
  const open = onBoxes.filter(isOpen).length;
  expect(sums, label).toEqual({ open, done: onBoxes.length - open, total: onBoxes.length });
  return sums;
}

describe('the figures of the drawn boxes, for any level, collapsed set and filter', () => {
  it('put every item that is on one node on exactly one box, and add up to the map', () => {
    const random = mulberry32(20261009);
    let filtered = 0;
    let cases = 0;
    for (let round = 0; round < 300; round++) {
      const m = randomModel(random);
      const all = randomItems(random, [...m.nodes.keys()], 1);
      const groups = groupIds(m);
      for (const level of LOD_LEVELS) {
        const over = buildWorkItemOverlay(m, all, randomFilter(random));
        const part = randomPart(random, m);
        const collapsed = randomSubset(random, groups);
        const drawn = visibleNodes(part, collapsed, level);
        const label = `round ${round} ${level} [${[...collapsed].join()}] of ${part.nodes.size}`;
        const sums = expectFigures(m, over, drawn, label);
        // The map: the shown items of the domains that are drawn, in the order of their IDs.
        const onMap = over.shown.filter((shown) =>
          (over.nodesOf.get(shown.id) ?? []).some((node) =>
            chain(m, node).some((id) => drawn.has(id)),
          ),
        );
        const onBoxes = [...drawnWorkItemIds(m, over, drawn).values()].flatMap((ids) => [...ids]);
        expect(sorted(onBoxes), label).toEqual(onMap.map((shown) => shown.id));
        const open = onMap.filter((shown) => isOpenState(shown.state)).length;
        expect(sums, label).toEqual({ open, done: onMap.length - open, total: onMap.length });
        if (part !== m) filtered += 1;
        cases += 1;
      }
    }
    expect(cases).toBe(1200);
    expect(filtered).toBeGreaterThan(300);
  });

  it('put an item that is on several nodes once on every box one of them lands on', () => {
    const random = mulberry32(7);
    let onSeveralBoxes = 0;
    for (let round = 0; round < 300; round++) {
      const m = randomModel(random);
      const all = randomItems(random, [...m.nodes.keys()], 3);
      const groups = groupIds(m);
      for (const level of LOD_LEVELS) {
        const over = buildWorkItemOverlay(m, all, randomFilter(random));
        const part = randomPart(random, m);
        const collapsed = randomSubset(random, groups);
        const drawn = visibleNodes(part, collapsed, level);
        const label = `round ${round} ${level} [${[...collapsed].join()}] of ${part.nodes.size}`;
        // Item by item, from the nodes it is on: the nearest drawn box around each of them, each
        // box once, and no other box.
        const figures = drawnWorkItemIds(m, over, drawn);
        let landings = 0;
        let several = false;
        for (const shown of over.shown) {
          const boxes = new Set<string>();
          for (const node of over.nodesOf.get(shown.id) ?? []) {
            const box = chain(m, node).find((around) => drawn.has(around));
            if (box !== undefined) boxes.add(box);
          }
          const holding = [...figures].filter(([, ids]) => ids.has(shown.id)).map(([box]) => box);
          expect(holding.sort(), `${label} item ${shown.id}`).toEqual([...boxes].sort());
          landings += boxes.size;
          if (boxes.size > 1) several = true;
        }
        // The bars add up to one for every box an item is on, so nothing else is on a box.
        expect(expectFigures(m, over, drawn, label).total, label).toBe(landings);
        if (several) onSeveralBoxes += 1;
      }
    }
    expect(onSeveralBoxes).toBeGreaterThan(300);
  });

  it('give a group that is closed its own figure and those of everything it hides, and change no other box', () => {
    const random = mulberry32(99);
    let cases = 0;
    for (let round = 0; round < 300; round++) {
      const m = randomModel(random);
      const over = buildWorkItemOverlay(m, randomItems(random, [...m.nodes.keys()], 2));
      const groups = groupIds(m);
      const target = groups[Math.floor(random() * groups.length)];
      if (target === undefined) continue;
      const collapsed = randomSubset(random, groups);
      collapsed.delete(target);
      const before = visibleNodes(m, collapsed, 'detail');
      if (!before.has(target)) continue;
      const after = visibleNodes(m, new Set([...collapsed, target]), 'detail');
      const stays = ([box]: readonly [string, unknown]): boolean =>
        after.has(box) && box !== target;

      const open = drawnWorkItemIds(m, over, before);
      const closed = drawnWorkItemIds(m, over, after);
      expect(listed(closed).filter(stays), `round ${round}`).toEqual(listed(open).filter(stays));
      const merged = new Set<number>();
      for (const entry of open) if (!stays(entry)) for (const id of entry[1]) merged.add(id);
      expect(sorted(closed.get(target)), `round ${round}`).toEqual(sorted(merged));

      // Neither a strip nor a bar of another box moves: the scale is not that of what is drawn.
      expect([...heatOfDrawn(m, over, after)].filter(stays), `round ${round}`).toEqual(
        [...heatOfDrawn(m, over, before)].filter(stays),
      );
      expect([...progressOfDrawn(m, over, after)].filter(stays), `round ${round}`).toEqual(
        [...progressOfDrawn(m, over, before)].filter(stays),
      );
      cases += 1;
    }
    expect(cases).toBeGreaterThan(100);
  });
});

describe('the figures on examples/architecture.yaml with fixtures/workitems.json', () => {
  const example = parseOk(exampleYaml);
  const workItems = parseWorkItems(fixtureJson).items;
  const all = buildWorkItemOverlay(example, workItems);
  const groups = groupIds(example);

  it('hold at every level, for collapsed sets, filters of the work items and filtered maps', () => {
    const filters: WorkItemFilter[] = [
      {},
      { hideCompleted: true },
      ...availableStates(workItems).map((state) => ({ hiddenStates: [state] })),
      ...availableIterations(workItems).map((iteration) => ({ iteration })),
    ];
    // The whole map, and every part of it that a flow or a work item reduces it to.
    const focuses: Focus[] = [
      ...example.flows.map((flow): Focus => ({ type: 'flow', id: flow.id })),
      ...[...all.byId.keys()].map((id): Focus => ({ type: 'workitem', id })),
    ];
    const parts = new Map<string, ArchitectureModel>([['', example]]);
    for (const focus of focuses) {
      const set = focusSet(example, focus, all);
      const reduced = set && filterToFocus(example, set);
      if (reduced) parts.set([...reduced.model.nodes.keys()].join(), reduced.model);
    }
    expect(parts.size).toBeGreaterThan(example.flows.length);
    const random = mulberry32(62);
    const collapsedSets = [
      new Set<string>(),
      new Set(groups),
      ...Array.from({ length: 4 }, () => randomSubset(random, groups)),
    ];
    let cases = 0;
    filters.forEach((filter, f) => {
      const over = buildWorkItemOverlay(example, workItems, filter);
      for (const part of parts.values()) {
        for (const level of LOD_LEVELS) {
          collapsedSets.forEach((collapsed, c) => {
            const drawn = visibleNodes(part, collapsed, level);
            expectFigures(
              example,
              over,
              drawn,
              `filter ${f} ${level} set ${c} of ${part.nodes.size}`,
            );
            cases += 1;
          });
        }
      }
    });
    expect(cases).toBe(filters.length * parts.size * LOD_LEVELS.length * collapsedSets.length);
  });

  it('add up to the same at every level and with every group closed', () => {
    // No item is listed on two nodes of one domain: each counts once for every domain it is in,
    // whatever is open.
    for (const [id, nodes] of all.nodesOf) {
      const domains = new Set(nodes.map((node) => chain(example, node).pop()));
      expect(domains.size, `#${id}`).toBe(nodes.length);
    }
    expect([...all.nodesOf.values()].some((nodes) => nodes.length > 1)).toBe(true);
    const heat = heatByWork(example, all);
    const progress = progressByNode(example, all);
    const domains = { open: 0, done: 0, total: 0 };
    for (const id of example.rootIds) {
      domains.open += heat.get(id)?.open ?? 0;
      domains.done += progress.get(id)?.done ?? 0;
      domains.total += progress.get(id)?.total ?? 0;
    }
    expect(domains.open).toBeGreaterThan(0);
    expect(domains.done).toBeGreaterThan(0);
    for (const level of LOD_LEVELS) {
      for (const collapsed of [new Set<string>(), new Set(groups)]) {
        const drawn = visibleNodes(example, collapsed, level);
        expect(expectFigures(example, all, drawn, `${level} ${collapsed.size}`)).toEqual(domains);
      }
    }
    // With everything inside counted on every box, the boxes of an open map add up to more.
    const components = visibleNodes(example, new Set(), 'components');
    let withEverythingInside = 0;
    for (const id of components) withEverythingInside += heat.get(id)?.open ?? 0;
    expect(withEverythingInside).toBeGreaterThan(domains.open);
  });
});

// --- The texts ---------------------------------------------------------------------------------

describe('heatText', () => {
  it('says how much open work is in a box that shows all of it', () => {
    expect(heatText({ open: 3, fraction: 0.5, inAll: 3 })).toBe('3 open work items in here');
    expect(heatText({ open: 1, fraction: 1, inAll: 1 })).toBe('1 open work item in here');
  });

  it('says what is left for a box, and how much there is in all, when boxes inside show the rest', () => {
    expect(heatText({ open: 2, fraction: 0.1, inAll: 14 })).toBe(
      '2 open work items here that no box inside shows (14 in here in all)',
    );
    expect(heatText({ open: 1, fraction: 0.5, inAll: 2 })).toBe(
      '1 open work item here that no box inside shows (2 in here in all)',
    );
  });
});

describe('drawnProgressText', () => {
  it('is the progress of a box that shows all of it', () => {
    const all = { done: 3, total: 8 };
    expect(drawnProgressText({ ...all, inAll: all })).toBe('3 of 8 done (38%)');
    expect(drawnProgressText({ done: 1, total: 1, inAll: { done: 1, total: 1 } })).toBe(
      '1 of 1 done (100%)',
    );
  });

  it('adds the progress of all of it when boxes inside show the rest', () => {
    expect(drawnProgressText({ done: 1, total: 3, inAll: { done: 5, total: 12 } })).toBe(
      '1 of 3 done (33%) of what no box inside shows (5 of 12 in here in all)',
    );
    expect(drawnProgressText({ done: 0, total: 1, inAll: { done: 1, total: 2 } })).toBe(
      '0 of 1 done (0%) of what no box inside shows (1 of 2 in here in all)',
    );
    // The boxes inside show open items only: as many done, of fewer.
    expect(drawnProgressText({ done: 1, total: 1, inAll: { done: 1, total: 3 } })).toBe(
      '1 of 1 done (100%) of what no box inside shows (1 of 3 in here in all)',
    );
  });

  it('agrees with the figures of a map', () => {
    const heat = heatOfDrawn(model, overlay, everything);
    const progress = progressOfDrawn(model, overlay, everything);
    const texts = (id: string): (string | undefined)[] => {
      const strip = heat.get(id);
      const bar = progress.get(id);
      return [strip && heatText(strip), bar && drawnProgressText(bar)];
    };
    expect(texts('a')).toEqual([
      '1 open work item here that no box inside shows (4 in here in all)',
      '0 of 1 done (0%) of what no box inside shows (2 of 6 in here in all)',
    ]);
    expect(texts('a.x')).toEqual([
      undefined,
      '1 of 1 done (100%) of what no box inside shows (2 of 4 in here in all)',
    ]);
    expect(texts('a.x.one')).toEqual(['2 open work items in here', '1 of 3 done (33%)']);
  });
});

describe('onMapText', () => {
  const rest = 'on this box; the rest is on the boxes drawn inside it';
  const heat = { open: 14, fraction: 1 };
  const progress = { done: 5, total: 12 };
  const strip = { open: 2, fraction: 0.1, inAll: 14 };
  const bar = { done: 1, total: 3, inAll: progress };

  it('is undefined when the box shows all the node holds', () => {
    expect(onMapText({}, {})).toBeUndefined();
    expect(
      onMapText(
        { heat, progress },
        { heat: { ...heat, inAll: 14 }, progress: { ...progress, inAll: progress } },
      ),
    ).toBeUndefined();
    expect(onMapText({ heat }, { heat: { ...heat, inAll: 14 } })).toBeUndefined();
    expect(onMapText({ progress }, { progress: { ...progress, inAll: progress } })).toBeUndefined();
  });

  it('names the open items of the box when the heat alone is on', () => {
    expect(onMapText({ heat }, { heat: strip })).toBe(`On the map: 2 open items ${rest}`);
    expect(onMapText({ heat }, { heat: { ...strip, open: 1 } })).toBe(
      `On the map: 1 open item ${rest}`,
    );
  });

  it('names the progress of the box when the progress alone is on', () => {
    expect(onMapText({ progress }, { progress: bar })).toBe(`On the map: 1 of 3 done ${rest}`);
    // As many done as in all of it, of fewer items.
    expect(onMapText({ progress }, { progress: { done: 5, total: 5, inAll: progress } })).toBe(
      `On the map: 5 of 5 done ${rest}`,
    );
  });

  it('names both when both are on, also the one that does not differ or is not on the box', () => {
    expect(onMapText({ heat, progress }, { heat: strip, progress: bar })).toBe(
      `On the map: 2 open items · 1 of 3 done ${rest}`,
    );
    // As much open work as in all of it, but fewer items.
    expect(onMapText({ heat, progress }, { heat: { ...heat, inAll: 14 }, progress: bar })).toBe(
      `On the map: 14 open items · 1 of 3 done ${rest}`,
    );
    // Completed items only: a bar and no strip.
    expect(onMapText({ heat, progress }, { progress: bar })).toBe(
      `On the map: 0 open items · 1 of 3 done ${rest}`,
    );
  });

  it('says that all of it is on the boxes inside when the box shows neither a strip nor a bar', () => {
    const allInside = 'On the map: all of it is on the boxes drawn inside it';
    expect(onMapText({ heat, progress }, {})).toBe(allInside);
    expect(onMapText({ heat }, {})).toBe(allInside);
    expect(onMapText({ progress }, {})).toBe(allInside);
  });

  it('leaves out the part of a lens that is off', () => {
    expect(onMapText({ progress }, { heat: strip, progress: bar })).toBe(
      `On the map: 1 of 3 done ${rest}`,
    );
    expect(onMapText({ heat }, { heat: strip, progress: bar })).toBe(
      `On the map: 2 open items ${rest}`,
    );
    // What only the lens that is off would tell is no difference.
    expect(
      onMapText({ progress }, { heat: strip, progress: { ...progress, inAll: progress } }),
    ).toBeUndefined();
  });

  it('agrees with the figures of a map', () => {
    const of = (drawn: ReadonlySet<string>, over: WorkItemOverlay, id: string) =>
      onMapText(
        { heat: heatByWork(model, over).get(id), progress: progressByNode(model, over).get(id) },
        {
          heat: heatOfDrawn(model, over, drawn).get(id),
          progress: progressOfDrawn(model, over, drawn).get(id),
        },
      );
    expect(of(everything, overlay, 'a')).toBe(`On the map: 1 open item · 0 of 1 done ${rest}`);
    expect(of(everything, overlay, 'a.x')).toBe(`On the map: 0 open items · 1 of 1 done ${rest}`);
    expect(of(everything, overlay, 'a.x.one')).toBeUndefined();
    expect(of(everything, overlay, 'b')).toBeUndefined();
    expect(of(visibleNodes(model, new Set(['a']), 'detail'), overlay, 'a')).toBeUndefined();
    expect(of(everything, buildWorkItemOverlay(model, items), 'a')).toBe(
      'On the map: all of it is on the boxes drawn inside it',
    );
  });
});
