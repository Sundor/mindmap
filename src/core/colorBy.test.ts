import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL_COLORS,
  colorByOptions,
  formatMetric,
  nodeColoring,
  OTHER_COLOR,
  OTHER_LABEL,
  SEQUENTIAL_RAMP,
  usableColorBy,
} from './index';
import { parseOk } from './layout/test-helpers';

const model = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    owner: Blue
    metrics: { loc: 100 }
    components:
      - { id: a.x, name: X, metrics: { loc: 400, churn: 2 } }
      - { id: a.y, name: Y, owner: Red }
  - id: b
    name: Beta
    tech: Go
    metrics: { loc: 250 }
`);

describe('colorByOptions / usableColorBy', () => {
  it('offers the attributes and metrics the file has, in order', () => {
    expect(colorByOptions(model)).toEqual([
      { value: 'owner', label: 'Owner' },
      { value: 'tech', label: 'Tech' },
      { value: 'metric:loc', label: 'loc' },
      { value: 'metric:churn', label: 'churn' },
    ]);
    expect(usableColorBy(model, 'owner')).toBe('owner');
    expect(usableColorBy(model, 'status')).toBe('none');
    expect(usableColorBy(model, 'metric:loc')).toBe('metric:loc');
    expect(usableColorBy(model, 'metric:nope')).toBe('none');
    expect(usableColorBy(model, '__proto__')).toBe('none');
  });
});

describe('nodeColoring', () => {
  it('gives each value of an attribute a slot in document order, inherited down the tree', () => {
    const coloring = nodeColoring(model, 'owner');
    expect(coloring.legend.map((entry) => entry.label)).toEqual(['Blue', 'Red']);
    expect(coloring.byNode.get('a')).toBe(CATEGORICAL_COLORS[0]);
    expect(coloring.byNode.get('a.x')).toBe(CATEGORICAL_COLORS[0]); // inherited
    expect(coloring.byNode.get('a.y')).toBe(CATEGORICAL_COLORS[1]);
    expect(coloring.byNode.has('b')).toBe(false);
  });

  it('folds every value beyond the slots into Other', () => {
    const many = parseOk(
      `version: 1\ndomains:\n${Array.from(
        { length: 10 },
        (_, i) => `  - { id: d${i}, name: D${i}, status: s${i} }\n`,
      ).join('')}`,
    );
    const coloring = nodeColoring(many, 'status');
    expect(coloring.legend).toHaveLength(CATEGORICAL_COLORS.length + 1);
    expect(coloring.legend.at(-1)).toEqual({ label: OTHER_LABEL, color: OTHER_COLOR });
    expect(coloring.byNode.get('d8')).toBe(OTHER_COLOR);
    expect(coloring.byNode.get('d9')).toBe(OTHER_COLOR);
  });

  it('places a metric on the ramp between its smallest and largest value', () => {
    const coloring = nodeColoring(model, 'metric:loc');
    expect(coloring.range).toEqual({ min: 100, max: 400 });
    expect(coloring.byNode.get('a')?.light).toBe(SEQUENTIAL_RAMP[0]);
    expect(coloring.byNode.get('a.x')?.light).toBe(SEQUENTIAL_RAMP.at(-1));
    expect(coloring.byNode.get('b')?.light).toBe(SEQUENTIAL_RAMP[6]);
    expect(coloring.byNode.has('a.y')).toBe(false); // not inherited
    expect(coloring.legend.map((entry) => entry.label)).toEqual(['100', '400']);
    const one = nodeColoring(model, 'metric:churn');
    expect(one.byNode.get('a.x')?.light).toBe(SEQUENTIAL_RAMP.at(-1)); // alone: the full hue
  });

  it('is empty for none or for something the file does not have', () => {
    expect(nodeColoring(model, 'none').byNode.size).toBe(0);
    expect(nodeColoring(model, 'metric:nope').legend).toEqual([]);
    expect(formatMetric(81.5)).toBe('81.5');
    expect(formatMetric(1 / 3)).toBe('0.33');
  });
});
