// The work-items data file: tags and parsing, and the dummy data set.

import { describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import { parseOk } from './layout/test-helpers';
import {
  isStoryMode,
  isWorkItemType,
  parseTags,
  parseWorkItems,
  STORY_MODES,
  WORK_ITEM_TYPES,
  type WorkItemSummary,
} from './workitems';

function file(items: unknown[], version: unknown = 1): string {
  return JSON.stringify({ version, items });
}

const story = { id: 1, type: 'User Story', title: 'A story', state: 'Active' };

describe('parseTags', () => {
  it('splits on ";", trims, and takes comp: tags in any letter case', () => {
    expect(parseTags('comp:storefront.web; risk;COMP: Data.Ingest ;  Comp:a.b')).toEqual({
      componentIds: ['storefront.web', 'data.ingest', 'a.b'],
      tags: ['risk'],
    });
  });

  it('drops duplicates, empty entries and comp: tags without an ID', () => {
    expect(parseTags('comp:a; ;comp:A;comp:; comp:  ;x;;')).toEqual({
      componentIds: ['a'],
      tags: ['x'],
    });
  });

  it('gives nothing for no tags, and keeps tags that merely contain "comp:"', () => {
    expect(parseTags(undefined)).toEqual({ componentIds: [], tags: [] });
    expect(parseTags('')).toEqual({ componentIds: [], tags: [] });
    expect(parseTags('not-comp:a; component')).toEqual({
      componentIds: [],
      tags: ['not-comp:a', 'component'],
    });
  });
});

describe('type guards', () => {
  it('know the shown types and the story modes', () => {
    expect(WORK_ITEM_TYPES).toEqual(['Epic', 'Feature', 'User Story', 'Bug', 'Task']);
    expect(isWorkItemType('Bug')).toBe(true);
    expect(isWorkItemType('bug')).toBe(false);
    expect(isWorkItemType(3)).toBe(false);
    expect(STORY_MODES).toEqual(['off', 'stories', 'tasks']);
    expect(isStoryMode('tasks')).toBe(true);
    expect(isStoryMode('all')).toBe(false);
  });
});

describe('parseWorkItems', () => {
  it('reads every field of a valid item', () => {
    const result = parseWorkItems(
      file([
        {
          id: 7,
          type: 'Task',
          title: '  Fix the form ',
          state: 'New',
          assignedTo: 'Anna',
          iteration: 'Sprint 1',
          tags: 'comp:storefront.web; risk',
          parentId: 3,
          description: 'Why and how.',
          url: 'https://ado.example/7',
          fields: { 'Remaining Work': 4, Activity: 'Development' },
        },
        { id: 3, type: 'User Story', title: 'Parent', state: 'Active' },
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.items).toEqual<WorkItemSummary[]>([
      { id: 3, type: 'User Story', title: 'Parent', state: 'Active', componentIds: [], tags: [] },
      {
        id: 7,
        type: 'Task',
        title: 'Fix the form',
        state: 'New',
        assignedTo: 'Anna',
        iteration: 'Sprint 1',
        url: 'https://ado.example/7',
        componentIds: ['storefront.web'],
        tags: ['risk'],
        description: 'Why and how.',
        fields: { 'Remaining Work': 4, Activity: 'Development' },
        parentId: 3,
      },
    ]);
  });

  it('keeps a field whatever its name, "__proto__" included', () => {
    const result = parseWorkItems(
      '{"version":1,"items":[{"id":1,"type":"Task","title":"t","state":"s",' +
        '"fields":{"__proto__":"x","toString":"y","constructor":3}}]}',
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    const fields = result.items[0]?.fields ?? {};
    expect(Object.entries(fields)).toEqual([
      ['__proto__', 'x'],
      ['toString', 'y'],
      ['constructor', 3],
    ]);
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
  });

  it('orders the items by ID and treats null and blank optional values as absent', () => {
    const result = parseWorkItems(
      file([
        { ...story, id: 9, assignedTo: null, iteration: '  ', fields: {} },
        { ...story, id: 2 },
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.id)).toEqual([2, 9]);
    expect(Object.keys(result.items[1] ?? {})).toEqual([
      'id',
      'type',
      'title',
      'state',
      'componentIds',
      'tags',
    ]);
  });

  it('never throws: text that is not JSON is one error naming the source', () => {
    const result = parseWorkItems('{ not json', { sourceName: 'workitems.json' });
    expect(result.items).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      severity: 'error',
      path: '',
      source: 'workitems.json',
    });
    expect(result.errors[0]?.message).toMatch(/^Not valid JSON/);
  });

  it('reads a file that starts with a byte-order mark', () => {
    const result = parseWorkItems(
      '\uFEFF{"version":1,"items":[{"id":1,"type":"Bug","title":"B","state":"New"}]}',
    );
    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.id)).toEqual([1]);
  });

  it('rejects a wrong top-level shape or version', () => {
    for (const text of ['[]', '3', 'null', '"x"']) {
      expect(parseWorkItems(text).errors[0]?.message).toMatch(/must be an object/);
    }
    expect(parseWorkItems(file([story], 2)).errors[0]).toMatchObject({ path: 'version' });
    expect(parseWorkItems('{"items":[]}').errors[0]?.message).toMatch(/Unsupported version/);
    expect(parseWorkItems('{"version":1}').errors[0]).toMatchObject({ path: 'items' });
    expect(parseWorkItems('{"version":1,"items":{}}').errors[0]).toMatchObject({ path: 'items' });
    expect(parseWorkItems(file([story], 2)).items).toEqual([]);
  });

  it('skips a broken item with an error and still loads the rest', () => {
    const result = parseWorkItems(
      file([
        'nope',
        { type: 'Bug', title: 'No id', state: 'New' },
        { id: 1.5, type: 'Bug', title: 'Fraction', state: 'New' },
        { id: 4, type: 'Bug', state: 'New' },
        { id: 5, type: 'Bug', title: 'Bad state', state: 3 },
        { id: 6, type: 'Bug', title: 'Bad parent', state: 'New', parentId: 'x' },
        { id: 7, type: 'Bug', title: 'Bad fields', state: 'New', fields: { a: [1] } },
        { id: 8, type: 'Bug', title: 'Bad fields 2', state: 'New', fields: 'x' },
        { id: 9, type: 'Bug', title: 'Bad tags', state: 'New', tags: ['comp:a'] },
        { id: 10, type: 'Bug', title: '   ', state: 'New' },
        { ...story, id: 11 },
      ]),
      { sourceName: 'w.json' },
    );
    expect(result.items.map((item) => item.id)).toEqual([11]);
    expect(result.errors.map((d) => d.path)).toEqual([
      'items[0]',
      'items[1]',
      'items[2]',
      'items[3]',
      'items[4]',
      'items[5]',
      'items[6]',
      'items[7]',
      'items[8]',
      'items[9]',
    ]);
    expect(result.errors.every((d) => d.source === 'w.json' && d.severity === 'error')).toBe(true);
    expect(result.errors[1]?.message).toContain('"id" must be a positive whole number');
    expect(result.errors[3]?.message).toContain('"title" is required');
    expect(result.errors[9]?.message).toContain('"title" must not be empty');
  });

  it('keeps the first of two items with the same ID', () => {
    const result = parseWorkItems(file([story, { ...story, title: 'Again' }]));
    expect(result.items.map((item) => item.title)).toEqual(['A story']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ path: 'items[1].id' });
    expect(result.errors[0]?.message).toMatch(/Duplicate work item ID 1/);
  });

  it('skips a type the map does not show, with a warning', () => {
    const result = parseWorkItems(
      file([
        { ...story, type: 'Test Case' },
        { ...story, id: 2 },
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.id)).toEqual([2]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ severity: 'warning', path: 'items[0].type' });
    expect(result.warnings[0]?.message).toContain('"Test Case"');
  });

  it('warns about unknown keys and keeps the item', () => {
    const result = parseWorkItems(file([{ ...story, colour: 'red' }]));
    expect(result.items).toHaveLength(1);
    expect(result.warnings.map((d) => d.path)).toEqual(['items[0].colour']);
  });

  it('drops a parent that is not in the file (also one that was skipped)', () => {
    const result = parseWorkItems(
      file([
        { ...story, id: 1, parentId: 99 },
        { ...story, id: 2, parentId: 3 },
        { id: 3, type: 'Issue', title: 'Not shown', state: 'New' },
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => [item.id, item.parentId])).toEqual([
      [1, undefined],
      [2, undefined],
    ]);
    expect(result.warnings.map((d) => d.path)).toEqual([
      'items[2].type',
      'items[0].parentId',
      'items[1].parentId',
    ]);
  });

  it('breaks circles of parents and keeps the items', () => {
    const result = parseWorkItems(
      file([
        { ...story, id: 1, parentId: 2 },
        { ...story, id: 2, parentId: 3 },
        { ...story, id: 3, parentId: 1 },
        { ...story, id: 4, parentId: 4 },
        { ...story, id: 5, parentId: 1 },
        { ...story, id: 6 },
        { ...story, id: 7, parentId: 6 },
      ]),
    );
    expect(result.items.map((item) => [item.id, item.parentId])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, undefined],
      [4, undefined],
      // Hangs under the circle without being part of it.
      [5, 1],
      [6, undefined],
      [7, 6],
    ]);
    expect(result.errors.map((d) => d.path)).toEqual([
      'items[0].parentId',
      'items[1].parentId',
      'items[2].parentId',
      'items[3].parentId',
    ]);
    expect(result.errors[0]?.message).toMatch(/#1 is its own ancestor/);
  });

  it('walks a very long chain of parents once, with or without a circle at its end', () => {
    const length = 20000;
    const chain = Array.from({ length }, (_, i) => ({ ...story, id: i + 1, parentId: i + 2 }));
    const open = parseWorkItems(file([...chain, { ...story, id: length + 1 }]));
    expect(open.errors).toEqual([]);
    expect(open.items).toHaveLength(length + 1);

    const closed = parseWorkItems(file([...chain, { ...story, id: length + 1, parentId: length }]));
    expect(closed.errors.map((d) => d.path)).toEqual([
      `items[${length - 1}].parentId`,
      `items[${length}].parentId`,
    ]);
    expect(closed.items.find((item) => item.id === 1)?.parentId).toBe(2);
  });

  it('keeps only an http(s) "url": anything else is no link to open', () => {
    const result = parseWorkItems(
      file([
        { ...story, id: 1, url: 'HTTPS://dev.azure.com/org/project/_workitems/edit/1' },
        { ...story, id: 2, url: 'javascript:alert(document.domain)' },
        { ...story, id: 3, url: 'data:text/html,<script>alert(1)</script>' },
        { ...story, id: 4, url: '//dev.azure.com/org' },
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.url)).toEqual([
      'HTTPS://dev.azure.com/org/project/_workitems/edit/1',
      undefined,
      undefined,
      undefined,
    ]);
    expect(result.warnings.map((d) => d.path)).toEqual([
      'items[1].url',
      'items[2].url',
      'items[3].url',
    ]);
    expect(result.warnings[0]?.message).toMatch(/#2: "url" is not an http\(s\) address/);
  });
});

describe('fixtures/workitems.json', () => {
  const model = parseOk(exampleYaml);
  const result = parseWorkItems(fixtureJson, { sourceName: 'fixtures/workitems.json' });
  const items = result.items;
  const ofType = (type: string): WorkItemSummary[] => items.filter((item) => item.type === type);
  const byId = new Map(items.map((item) => [item.id, item]));

  it('parses without errors or warnings', () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('has about 60 items of every shown type', () => {
    expect(items.length).toBeGreaterThanOrEqual(55);
    expect(items.length).toBeLessThanOrEqual(66);
    expect(ofType('User Story').length).toBeGreaterThanOrEqual(20);
    expect(ofType('User Story').length).toBeLessThanOrEqual(26);
    expect(ofType('Task').length).toBeGreaterThanOrEqual(24);
    expect(ofType('Task').length).toBeLessThanOrEqual(30);
    expect(ofType('Bug').length).toBeGreaterThanOrEqual(4);
    expect(ofType('Feature').length).toBeGreaterThanOrEqual(2);
    expect(ofType('Epic')).toHaveLength(1);
  });

  it('tags stories to domains, components and subcomponents, one of them to two nodes', () => {
    const levels = new Set<number>();
    for (const item of ofType('User Story')) {
      for (const id of item.componentIds) {
        const level = model.nodes.get(id)?.level;
        if (level !== undefined) levels.add(level);
      }
    }
    expect([...levels].sort()).toEqual([0, 1, 2]);
    expect(ofType('User Story').some((item) => item.componentIds.length >= 2)).toBe(true);
    // Some nodes carry several items, many none.
    const perNode = new Map<string, number>();
    for (const item of items) {
      if (item.type === 'Task' && item.parentId !== undefined) continue;
      for (const id of item.componentIds) perNode.set(id, (perNode.get(id) ?? 0) + 1);
    }
    expect(Math.max(...perNode.values())).toBeGreaterThanOrEqual(2);
    const without = [...model.nodes.keys()].filter((id) => !perNode.has(id));
    expect(without.length).toBeGreaterThanOrEqual(10);
  });

  it('gives stories one to four tasks, some none, with a couple of long task titles', () => {
    const tasksOf = new Map<number, number>();
    for (const task of ofType('Task')) {
      if (task.parentId === undefined) continue;
      expect(byId.get(task.parentId)?.type).toBe('User Story');
      tasksOf.set(task.parentId, (tasksOf.get(task.parentId) ?? 0) + 1);
    }
    expect(Math.min(...tasksOf.values())).toBe(1);
    expect(Math.max(...tasksOf.values())).toBe(4);
    expect(ofType('User Story').some((item) => !tasksOf.has(item.id))).toBe(true);
    expect(ofType('Task').filter((task) => task.title.length > 70).length).toBeGreaterThanOrEqual(
      2,
    );
    // Features and the epic are parents too.
    expect(ofType('User Story').some((s) => byId.get(s.parentId ?? 0)?.type === 'Feature')).toBe(
      true,
    );
    expect(ofType('Feature').every((f) => byId.get(f.parentId ?? 0)?.type === 'Epic')).toBe(true);
  });

  it('covers the edge cases: untagged, unknown IDs, mixed states, iterations, assignees', () => {
    expect(
      items.filter((item) => item.componentIds.length === 0 && item.type !== 'Task').length,
    ).toBeGreaterThanOrEqual(2);
    const unknown = items.flatMap((item) => item.componentIds.filter((id) => !model.nodes.has(id)));
    expect(unknown.length).toBeGreaterThanOrEqual(2);
    expect(new Set(items.map((item) => item.state))).toEqual(
      new Set(['New', 'Active', 'Resolved', 'Closed']),
    );
    const bugStates = new Set(ofType('Bug').map((bug) => bug.state));
    expect(bugStates.has('Closed') && bugStates.has('Active')).toBe(true);
    expect(new Set(items.flatMap((item) => item.iteration ?? [])).size).toBe(3);
    expect(new Set(items.flatMap((item) => item.assignedTo ?? [])).size).toBeGreaterThanOrEqual(4);
    // A task with a tag of its own under a tagged story, and tasks without a parent.
    expect(
      ofType('Task').some((task) => task.parentId !== undefined && task.componentIds.length > 0),
    ).toBe(true);
    expect(ofType('Task').filter((task) => task.parentId === undefined)).toHaveLength(2);
  });

  it('describes every story in one to three sentences and gives it parameters', () => {
    for (const item of ofType('User Story')) {
      const sentences = (item.description ?? '').split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length, `#${item.id}`).toBeGreaterThanOrEqual(1);
      expect(sentences.length, `#${item.id}`).toBeLessThanOrEqual(3);
      expect(Object.keys(item.fields ?? {})).toEqual(['Story Points', 'Priority', 'Area']);
    }
  });
});
