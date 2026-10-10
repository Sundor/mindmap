import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  effectiveAttribute,
  effectiveLabel,
  effectiveLabels,
  labelNames,
  labelValueCounts,
} from './index';
import { parseOk } from './layout/test-helpers';

describe('effectiveLabel, effectiveLabels, labelValueCounts', () => {
  const model = parseOk(`version: 1
domains:
  - id: a
    name: A
    owner: Shop team
    labels: { zone: public, tier: 1 }
    components:
      - id: a.x
        name: X
        labels: { zone: payment }
        subcomponents:
          - { id: a.x.k, name: K }
          - { id: a.x.m, name: M, labels: { zone: public, risk: high } }
      - { id: a.y, name: Y, owner: Core team }
  - id: b
    name: B
    components:
      - { id: b.x, name: X, labels: { risk: low } }
`);

  it('own value, the nearest ancestor’s, none; an attribute by its name', () => {
    expect(effectiveLabel(model, 'a', 'zone')).toEqual({ value: 'public', from: 'a' });
    expect(effectiveLabel(model, 'a.x', 'zone')).toEqual({ value: 'payment', from: 'a.x' });
    expect(effectiveLabel(model, 'a.x.k', 'zone')).toEqual({ value: 'payment', from: 'a.x' });
    expect(effectiveLabel(model, 'a.x.m', 'zone')).toEqual({ value: 'public', from: 'a.x.m' });
    expect(effectiveLabel(model, 'a.y', 'zone')).toEqual({ value: 'public', from: 'a' });
    expect(effectiveLabel(model, 'a.x.k', 'tier')).toEqual({ value: '1', from: 'a' });
    expect(effectiveLabel(model, 'b', 'zone')).toBeUndefined();
    expect(effectiveLabel(model, 'b.x', 'zone')).toBeUndefined();
    expect(effectiveLabel(model, 'nope', 'zone')).toBeUndefined();
    expect(effectiveLabel(model, 'a', 'nope')).toBeUndefined();
    expect(effectiveLabel(model, 'a.x.k', 'owner')).toEqual({ value: 'Shop team', from: 'a' });
    expect(effectiveLabel(model, 'a.y', 'owner')).toEqual({ value: 'Core team', from: 'a.y' });
    expect(effectiveLabel(model, 'b.x', 'owner')).toBeUndefined();
    for (const id of model.nodes.keys()) {
      expect(effectiveAttribute(model, id, 'owner')).toEqual(effectiveLabel(model, id, 'owner'));
    }
  });

  it('a label named like something of Object is a name like any other', () => {
    const odd = parseOk(`version: 1
domains:
  - id: a
    name: A
    labels: { __proto__: a, constructor: b, toString: c, hasOwnProperty: d }
    components:
      - { id: a.x, name: X }
`);
    expect(labelNames(odd)).toEqual(['__proto__', 'constructor', 'toString', 'hasOwnProperty']);
    expect(effectiveLabel(odd, 'a.x', '__proto__')).toEqual({ value: 'a', from: 'a' });
    expect(effectiveLabel(odd, 'a', 'valueOf')).toBeUndefined();
  });

  it('effectiveLabels lists what holds for a node, in the order of labelNames', () => {
    expect(labelNames(model)).toEqual(['zone', 'tier', 'risk']);
    expect(effectiveLabels(model, 'a.x.m')).toEqual([
      { name: 'zone', value: 'public', from: 'a.x.m' },
      { name: 'tier', value: '1', from: 'a' },
      { name: 'risk', value: 'high', from: 'a.x.m' },
    ]);
    expect(effectiveLabels(model, 'b.x')).toEqual([{ name: 'risk', value: 'low', from: 'b.x' }]);
    expect(effectiveLabels(model, 'b')).toEqual([]);
    expect(effectiveLabels(model, 'nope')).toEqual([]);
  });

  it('labelValueCounts counts the nodes a value holds for, in the order of their first node', () => {
    expect(labelValueCounts(model, 'zone')).toEqual([
      { value: 'public', count: 3 },
      { value: 'payment', count: 2 },
    ]);
    expect(labelValueCounts(model, 'owner')).toEqual([
      { value: 'Shop team', count: 4 },
      { value: 'Core team', count: 1 },
    ]);
    expect(labelValueCounts(model, 'nope')).toEqual([]);
  });
});

/** Random numbers in [0, 1) from `seed`, the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('labels of random files (seeded)', () => {
  // Names and values that a YAML file must quote to keep as text, among plain ones.
  const NAMES = ['team', 'zone', 'tier', 'risk', 'x y', 'Ünï', '__proto__', '7'];
  const VALUES = ['a', 'b', 'c', 'x: y', '# not a comment', '1.10', 'true', 'null', '~', 'Ü'];

  interface NodeEntry {
    id: string;
    name: string;
    labels?: Record<string, string>;
    components?: NodeEntry[];
    subcomponents?: NodeEntry[];
  }

  /** A file of one to three domains, and the labels it writes on each node, by node ID. */
  function randomFile(random: () => number): {
    yaml: string;
    written: Map<string, Map<string, string>>;
  } {
    const written = new Map<string, Map<string, string>>();
    const below = (count: number): number => Math.floor(random() * count);
    const node = (id: string): NodeEntry => {
      const entry: NodeEntry = { id, name: id.toUpperCase() };
      const count = below(4);
      if (count > 0) {
        const labels = new Map<string, string>();
        for (let i = 0; i < count; i++) {
          const name = NAMES[below(NAMES.length)] ?? 'team';
          labels.set(name, VALUES[below(VALUES.length)] ?? 'a');
        }
        written.set(id, labels);
        // `Object.fromEntries` keeps "__proto__" as an own key; a number-like key moves first.
        entry.labels = Object.fromEntries(labels);
      }
      return entry;
    };
    const domains: NodeEntry[] = [];
    for (let d = 0; d < 1 + below(3); d++) {
      const domain = node(`d${d}`);
      domain.components = [];
      for (let c = 0; c < below(4); c++) {
        const component = node(`d${d}.c${c}`);
        component.subcomponents = [];
        for (let s = 0; s < below(3); s++) {
          component.subcomponents.push(node(`d${d}.c${c}.s${s}`));
        }
        domain.components.push(component);
      }
      domains.push(domain);
    }
    return { yaml: stringify({ version: 1, domains }), written };
  }

  it('what is written as text comes back as that text, on the node it was written on', () => {
    const random = mulberry32(20261009);
    let labelled = 0;
    for (let round = 0; round < 300; round++) {
      const { yaml, written } = randomFile(random);
      const model = parseOk(yaml);
      for (const node of model.nodes.values()) {
        const expected = written.get(node.id);
        expect(new Map(node.labels ?? [])).toEqual(expected ?? new Map());
        // The order of the file: the order `stringify` wrote, which is that of the plain object.
        if (expected) {
          labelled += 1;
          expect([...(node.labels?.keys() ?? [])]).toEqual(
            Object.keys(Object.fromEntries(expected)),
          );
        }
      }
    }
    expect(labelled).toBeGreaterThan(300);
  });

  it('effectiveLabel is the nearest written value up the chain; the counts add up', () => {
    const random = mulberry32(7);
    let inherited = 0;
    for (let round = 0; round < 300; round++) {
      const model = parseOk(randomFile(random).yaml);
      for (const name of [...labelNames(model), 'absent']) {
        let holding = 0;
        for (const node of model.nodes.values()) {
          // The chain walked by the prefixes of the ID, not by `parentId`.
          let expected: { value: string; from: string } | undefined;
          for (let id: string | undefined = node.id; id !== undefined;) {
            const value = model.nodes.get(id)?.labels?.get(name);
            if (value !== undefined) {
              expected = { value, from: id };
              break;
            }
            id = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : undefined;
          }
          expect(effectiveLabel(model, node.id, name)).toEqual(expected);
          if (expected) holding += 1;
          if (expected && expected.from !== node.id) inherited += 1;
        }
        const counts = labelValueCounts(model, name);
        expect(counts.reduce((sum, entry) => sum + entry.count, 0)).toBe(holding);
        expect(new Set(counts.map((entry) => entry.value)).size).toBe(counts.length);
      }
      for (const id of model.nodes.keys()) {
        expect(effectiveLabels(model, id).map((entry) => entry.name)).toEqual(
          labelNames(model).filter((name) => effectiveLabel(model, id, name) !== undefined),
        );
      }
    }
    expect(inherited).toBeGreaterThan(300);
  });
});
