import { describe, expect, it } from 'vitest';
import { aggregateCountLabel, edgeLabelSize } from './flow';
import { parseOk } from './layout/test-helpers';
import { EDGE_LABEL_ROOM, labelRoom, pairKey } from './labelRoom';
import { wrapBalanced } from './text';
import { visibleNodes } from './visibility';

const model = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - { id: a.x, name: X }
      - { id: a.y, name: Y }
      - id: a.g
        name: Group
        subcomponents:
          - { id: a.g.one, name: One }
          - { id: a.g.two, name: Two }
  - id: b
    name: Beta
    components:
      - { id: b.z, name: Z }
edges:
  - { id: e1, from: a.x, to: a.y, kind: dataflow, label: reads the orders of the day }
  - { id: e2, from: a.y, to: a.x, kind: control, protocol: http }
  - { id: e3, from: a.g.one, to: b.z, kind: dataflow, label: one }
  - { id: e4, from: a.g.two, to: b.z, kind: dataflow }
  - { id: e5, from: a.x, to: a.g.one, kind: config }
`);

const everything = visibleNodes(model, new Set(), 'detail');
const room = (text: string) => {
  const size = edgeLabelSize(wrapBalanced(text, EDGE_LABEL_ROOM.lines));
  return {
    width: Math.min(EDGE_LABEL_ROOM.maxWidth, size.width + 2 * EDGE_LABEL_ROOM.margin),
    height: Math.min(EDGE_LABEL_ROOM.maxHeight, size.height + 2 * EDGE_LABEL_ROOM.margin),
  };
};

describe('pairKey', () => {
  it('names an unordered pair', () => {
    expect(pairKey('a.x', 'a.y')).toBe('a.x\na.y');
    expect(pairKey('a.y', 'a.x')).toBe('a.x\na.y');
  });
});

describe('labelRoom', () => {
  it('gives each pair joined by labelled edges the room of the largest label', () => {
    const rooms = labelRoom(model, everything);
    // e1 and e2 join the same pair: the longer label, on two lines, with the margins.
    expect(rooms.get(pairKey('a.x', 'a.y'))).toEqual(room('reads the orders of the day'));
    expect(rooms.get(pairKey('a.g.one', 'b.z'))).toEqual(room('one'));
    // No label, no room; and no room for an edge into the own group.
    expect(rooms.has(pairKey('a.g.two', 'b.z'))).toBe(false);
    expect(rooms.has(pairKey('a.x', 'a.g.one'))).toBe(false);
    expect(rooms.size).toBe(2);
    // Two lines take less width and more height than one, within the maxima.
    const one = edgeLabelSize('reads the orders of the day');
    const two = room('reads the orders of the day');
    expect(two.width).toBeLessThan(one.width + 2 * EDGE_LABEL_ROOM.margin);
    expect(two.height).toBeGreaterThan(one.height + 2 * EDGE_LABEL_ROOM.margin);
    expect(two.width).toBeLessThanOrEqual(EDGE_LABEL_ROOM.maxWidth);
    expect(two.height).toBeLessThanOrEqual(EDGE_LABEL_ROOM.maxHeight);
  });

  it('keeps no room for the labels of single edges while they are switched off', () => {
    expect(labelRoom(model, everything, false).size).toBe(0);
    expect(labelRoom(model, everything, true).size).toBe(2);
  });

  it('keeps room for the count of an aggregate, labels on or off', () => {
    const components = visibleNodes(model, new Set(), 'components');
    const rooms = labelRoom(model, components, false);
    // e3 and e4 roll up into one edge from the closed group to b.z, counted.
    expect(rooms.get(pairKey('a.g', 'b.z'))).toEqual(room(aggregateCountLabel(2)));
    expect(rooms.size).toBe(1);
    // With labels on, the edges between the two components keep their room at that level too.
    expect(labelRoom(model, components).size).toBe(2);
    // Closed by hand at the Everything level: the labels of the parallel edges, one per line.
    const closed = visibleNodes(model, new Set(['a.g']), 'detail');
    expect(labelRoom(model, closed).get(pairKey('a.g', 'b.z'))).toEqual(
      room(aggregateCountLabel(2)),
    );
    const parallel = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - { id: a.x, name: X }
      - { id: a.y, name: Y }
edges:
  - { id: e1, from: a.x, to: a.y, kind: dataflow, label: first }
  - { id: e2, from: a.x, to: a.y, kind: dataflow, label: second one }
`);
    const drawn = visibleNodes(parallel, new Set(), 'detail');
    expect(labelRoom(parallel, drawn).get(pairKey('a.x', 'a.y'))).toEqual(
      room('first\nsecond one'),
    );
    expect(labelRoom(parallel, drawn, false).get(pairKey('a.x', 'a.y'))).toEqual(
      room(aggregateCountLabel(2)),
    );
  });

  it('caps the room, however long the label', () => {
    const long = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - { id: a.x, name: X }
      - { id: a.y, name: Y }
edges:
  - { id: e1, from: a.x, to: a.y, kind: dataflow, label: ${'word '.repeat(30).trim()} }
`);
    const rooms = labelRoom(long, visibleNodes(long, new Set(), 'detail'));
    expect(rooms.get(pairKey('a.x', 'a.y'))).toEqual({
      width: EDGE_LABEL_ROOM.maxWidth,
      height: room('word\nword').height,
    });
  });
});
