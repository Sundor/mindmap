import { describe, expect, it } from 'vitest';
import {
  authoringHints,
  buildWorkItemOverlay,
  HINT_NAMES_SHOWN,
  type WorkItemSummary,
} from './index';
import { parseOk } from './layout/test-helpers';

const model = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    description: Described
    components:
      - { id: a.x, name: X }
      - { id: a.y, name: Y, description: Also }
  - id: b
    name: Beta
  - id: c
    name: Gamma
    description: Lonely
edges:
  - { id: x-b, from: a.x, to: b, kind: dataflow }
`);

describe('authoringHints', () => {
  it('names the nodes without description or connection, and the missing flows', () => {
    const hints = authoringHints(model);
    expect(hints.map((hint) => hint.kind)).toEqual(['description', 'isolated', 'no-flows']);
    expect(hints[0]?.nodeIds).toEqual(['a.x', 'b']);
    expect(hints[0]?.message).toMatch(/^2 nodes without a description: X, Beta\./);
    // a.y has no edge, and c nothing inside it has one; a is reached through a.x.
    expect(hints[1]?.nodeIds).toEqual(['a.y', 'c']);
  });

  it('counts the names beyond the first few', () => {
    const many = parseOk(
      `version: 1\ndomains:\n${Array.from({ length: 9 }, (_, i) => `  - { id: d${i}, name: D${i} }\n`).join('')}`,
    );
    const [hint] = authoringHints(many);
    expect(hint?.message).toContain(`D${HINT_NAMES_SHOWN - 1} (+${9 - HINT_NAMES_SHOWN} more)`);
    // Without any edge, "isolated" would name every node and say nothing: left out.
    expect(authoringHints(many).map((hint) => hint.kind)).toEqual(['description']);
  });

  it('points out domains without work items only when there are work items', () => {
    const items: WorkItemSummary[] = [
      { id: 1, type: 'User Story', title: 't', state: 'Active', componentIds: ['a.x'], tags: [] },
    ];
    const hints = authoringHints(model, buildWorkItemOverlay(model, items));
    const idle = hints.find((hint) => hint.kind === 'no-work');
    expect(idle?.nodeIds).toEqual(['b', 'c']);
    expect(
      authoringHints(model, buildWorkItemOverlay(model, [])).some((h) => h.kind === 'no-work'),
    ).toBe(false);
  });

  it('has nothing to say about a complete file', () => {
    const complete = parseOk(`
version: 1
domains:
  - id: a
    name: A
    description: d
  - id: b
    name: B
    description: d
edges:
  - { id: e, from: a, to: b, kind: dataflow }
flows:
  - { id: f, name: F, edges: [e] }
`);
    expect(authoringHints(complete)).toEqual([]);
  });
});
