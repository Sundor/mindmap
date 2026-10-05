import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_SETTINGS,
  parseDisplaySettings,
  serializeDisplaySettings,
} from './displaySettings';
import { parseOk } from './layout/test-helpers';
import { buildWorkItemOverlay, usableWorkItemFilter } from './workItemOverlay';
import { parseWorkItems } from './workitems';

const model = parseOk(`
version: 1
domains:
  - id: a
    name: A
    components:
      - id: a.x
        name: X
`);

const { items } = parseWorkItems(
  JSON.stringify({
    version: 1,
    items: [
      { id: 1, type: 'User Story', title: 'Open story', state: 'Active', tags: 'comp:a.x' },
      { id: 2, type: 'User Story', title: 'Closed story', state: 'Closed', tags: 'comp:a.x' },
      { id: 3, type: 'Task', title: 'Done task', state: 'done', parentId: 1 },
      { id: 4, type: 'Task', title: 'Open task', state: 'New', parentId: 1 },
      { id: 5, type: 'Bug', title: 'Resolved bug', state: 'Resolved', tags: 'comp:a' },
      { id: 6, type: 'Bug', title: 'Removed bug', state: ' Removed ', tags: 'comp:a' },
    ],
  }),
);

describe('hiding the completed work items', () => {
  it('shows everything by default', () => {
    const overlay = buildWorkItemOverlay(model, items, usableWorkItemFilter(items, [], undefined));
    expect(overlay.shown.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('leaves out every item in a closed state, whatever its letter case', () => {
    const filter = usableWorkItemFilter(items, [], undefined, true);
    expect(filter).toEqual({ hiddenStates: [], hideCompleted: true });
    const overlay = buildWorkItemOverlay(model, items, filter);
    expect(overlay.shown.map((item) => item.id)).toEqual([1, 4]);
    expect(overlay.rows.get('a.x')?.map((row) => row.item.id)).toEqual([1]);
    expect(overlay.rows.get('a.x')?.[0]?.tasks.map((task) => task.id)).toEqual([4]);
    expect(overlay.rows.get('a')).toBeUndefined();
  });

  it('adds to the hidden states rather than replacing them', () => {
    const overlay = buildWorkItemOverlay(
      model,
      items,
      usableWorkItemFilter(items, ['New'], undefined, true),
    );
    expect(overlay.shown.map((item) => item.id)).toEqual([1]);
  });

  it('is a stored display setting, on by default', () => {
    expect(DEFAULT_DISPLAY_SETTINGS.showCompleted).toBe(true);
    const off = { ...DEFAULT_DISPLAY_SETTINGS, showCompleted: false };
    expect(parseDisplaySettings(serializeDisplaySettings(off)).showCompleted).toBe(false);
    expect(parseDisplaySettings('{"showCompleted":"no"}').showCompleted).toBe(true);
  });
});
