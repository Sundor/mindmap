import { describe, expect, it } from 'vitest';
import {
  boxCountText,
  CATEGORICAL_COLORS,
  COLOR_BY_GROUP_LABELS,
  COLOR_BY_GROUPS,
  COLOR_NAMES,
  colorByOptions,
  colorFromFile,
  DEFAULT_DISPLAY_SETTINGS,
  describeColorBy,
  formatMetric,
  legendEntryTitle,
  nodeColoring,
  OTHER_COLOR,
  OTHER_LABEL,
  OTHER_VALUES_SHOWN,
  parseDisplaySettings,
  parseSavedView,
  SEQUENTIAL_RAMP,
  serializeDisplaySettings,
  usableColorBy,
  valuePalette,
  viewColorBy,
  viewFromLinkHash,
  viewLinkHash,
  type ColorBy,
  type PresetValue,
  type SavedView,
  type SchemeColor,
  type ValueCount,
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

/** The same shape with labels on it, and presets that colour by a label and by an attribute. */
const labelled = parseOk(`version: 1
domains:
  - id: a
    name: Alpha
    owner: Blue
    labels: { zone: public, tier: 1 }
    metrics: { loc: 100 }
    components:
      - id: a.x
        name: X
        labels: { zone: payment }
        metrics: { loc: 400 }
        subcomponents:
          - { id: a.x.k, name: K }
      - { id: a.y, name: Y, owner: Red, labels: { zone: internal } }
  - id: b
    name: Beta
    tech: Go
presets:
  - name: Zones
    label: zone
    description: Who may reach it
    values:
      internal: '#102030'
      public: orange
      partner: green
      payment:
  - { name: zone, label: zone }
  - { name: Teams, label: owner }
`);

/** The palette slot at `index`. */
function slot(index: number): SchemeColor {
  const color = CATEGORICAL_COLORS[index];
  if (!color) throw new Error(`the palette has no slot ${index}`);
  return color;
}

const BLUE = slot(0);
const ORANGE = slot(1);
const TEAL = slot(2);
const YELLOW = slot(3);
const GREEN = slot(5);
const RED = slot(7);

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

/** Values the nodes have: a name alone counts one node. */
function present(...values: (string | [string, number])[]): ValueCount[] {
  return values.map((entry) =>
    typeof entry === 'string' ? { value: entry, count: 1 } : { value: entry[0], count: entry[1] },
  );
}

/** Values a preset lists: a name alone has no colour. */
function listed(...values: (string | [string, SchemeColor])[]): PresetValue[] {
  return values.map((entry) =>
    typeof entry === 'string' ? { value: entry } : { value: entry[0], color: entry[1] },
  );
}

function legendOf(palette: { readonly legend: readonly { readonly label: string }[] }): string[] {
  return palette.legend.map((entry) => entry.label);
}

describe('colorFromFile', () => {
  it('reads the palette names in any letter case, grey in both spellings, hex and pairs', () => {
    expect(COLOR_NAMES).toHaveLength(CATEGORICAL_COLORS.length);
    COLOR_NAMES.forEach((name, index) => {
      expect(colorFromFile(name)).toBe(slot(index));
      expect(colorFromFile(` ${name.toUpperCase()} `)).toBe(slot(index));
    });
    expect(colorFromFile('grey')).toBe(OTHER_COLOR);
    expect(colorFromFile('Gray')).toBe(OTHER_COLOR);
    expect(colorFromFile('#1baf7a')).toEqual({ light: '#1baf7a', dark: '#1baf7a' });
    expect(colorFromFile(' #1BAF7A ')).toEqual({ light: '#1baf7a', dark: '#1baf7a' });
    expect(colorFromFile('#E34')).toEqual({ light: '#ee3344', dark: '#ee3344' });
    expect(colorFromFile({ light: '#C2410C', dark: '#fb9' })).toEqual({
      light: '#c2410c',
      dark: '#ffbb99',
    });
    // Spaces around a colour of a pair are no part of it, as around a colour alone.
    expect(colorFromFile({ light: ' #FFF ', dark: '#000 ' })).toEqual({
      light: '#ffffff',
      dark: '#000000',
    });
  });

  it('refuses everything else', () => {
    const refused: unknown[] = [
      '',
      'none',
      'amber',
      'violet',
      'transparent',
      'currentColor',
      '1baf7a',
      '#12345',
      '#1234567',
      '#12 345',
      '#gggggg',
      'rgb(1,2,3)',
      'url(https://example.com/x)',
      'var(--panel)',
      '#fff; background: url(x)',
      '#fff\n#000',
      'red; background: url(x)',
      'toString',
      '__proto__',
      123456,
      0,
      true,
      null,
      undefined,
      ['red'],
      {},
      { light: '#fff' },
      { dark: '#000' },
      { light: 'red', dark: 'blue' },
      { light: '#fff', dark: '#000', extra: 1 },
      { light: '#fff', dark: 'url(x)' },
      { light: ['#fff'], dark: '#000' },
    ];
    for (const value of refused) {
      expect(colorFromFile(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('whatever it is given, what comes out is two colours of # and six hex digits (seeded)', () => {
    const random = mulberry32(99);
    const pieces = [
      '#',
      'f',
      '0',
      'a',
      'G',
      ' ',
      ';',
      '(',
      ')',
      'red',
      'url',
      'e3',
      '\n',
      '%',
      '-',
    ];
    let colours = 0;
    for (let round = 0; round < 5000; round++) {
      const length = Math.floor(random() * 9);
      let text = '';
      for (let i = 0; i < length; i++) text += pieces[Math.floor(random() * pieces.length)] ?? '';
      const value: unknown = random() < 0.2 ? { light: text, dark: text } : text;
      const color = colorFromFile(value);
      if (!color) continue;
      colours += 1;
      expect(color.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(color.dark).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(colours).toBeGreaterThan(0);
  });
});

describe('valuePalette', () => {
  it('without a list: the slots in the order of the values, the ninth and later are Other', () => {
    const values = 'abcdefghij'.split('');
    const palette = valuePalette(present(...values));
    values.slice(0, 8).forEach((value, index) => {
      expect(palette.colorOf.get(value)).toBe(slot(index));
    });
    expect(palette.colorOf.get('i')).toBe(OTHER_COLOR);
    expect(palette.colorOf.get('j')).toBe(OTHER_COLOR);
    expect(palette.legend).toEqual([
      ...values.slice(0, 8).map((value, index) => ({
        label: value,
        color: slot(index),
        kind: 'value',
        count: 1,
      })),
      { label: OTHER_LABEL, color: OTHER_COLOR, kind: 'other', count: 2, values: ['i', 'j'] },
    ]);
  });

  it('a listed value has the colour the file gives it, and the legend the order of the list', () => {
    const custom = { light: '#102030', dark: '#f0e0d0' };
    const palette = valuePalette(
      present(['low', 3], ['high', 2], ['mid', 5]),
      listed(['high', RED], ['mid', custom], ['low', GREEN]),
    );
    expect(palette.legend).toEqual([
      { label: 'high', color: RED, kind: 'value', count: 2 },
      { label: 'mid', color: custom, kind: 'value', count: 5 },
      { label: 'low', color: GREEN, kind: 'value', count: 3 },
    ]);
  });

  it('a slot the list uses is not handed out again — by name, or by its colour on one scheme', () => {
    const blueByHex = { light: BLUE.light, dark: BLUE.dark };
    const palette = valuePalette(
      present('a', 'b', 'c', 'd'),
      listed(['a', ORANGE], ['b', blueByHex]),
    );
    expect(palette.colorOf.get('c')).toBe(TEAL);
    expect(palette.colorOf.get('d')).toBe(YELLOW);
    // The hex of a slot's light colour, written as one colour for both schemes: the slot would
    // give a second value the same colour on the light scheme. Likewise for the dark colour alone.
    const light = valuePalette(
      present('a', 'b'),
      listed(['a', { light: BLUE.light, dark: BLUE.light }]),
    );
    expect(light.colorOf.get('b')).toBe(ORANGE);
    const dark = valuePalette(
      present('a', 'b'),
      listed(['a', { light: '#000000', dark: BLUE.dark }]),
    );
    expect(dark.colorOf.get('b')).toBe(ORANGE);
    // GREEN is the same in both schemes; one hex takes exactly that slot.
    const green = valuePalette(
      present('a', ...'bcdefgh'.split('')),
      listed(['a', { light: GREEN.light, dark: GREEN.light }]),
    );
    expect([...green.colorOf.values()]).not.toContain(GREEN);
    expect(green.legend.map((entry) => entry.kind)).toEqual(Array(8).fill('value'));
  });

  it('a listed value without a colour takes its slot in list order, whether or not a node has it', () => {
    const list = listed('planned', 'live', ['beta', BLUE], 'deprecated');
    const all = valuePalette(present('deprecated', 'live', 'planned', 'beta'), list);
    const some = valuePalette(present('deprecated'), list);
    // blue is taken by beta: planned → orange, live → teal, deprecated → yellow.
    expect(all.colorOf.get('planned')).toBe(ORANGE);
    expect(all.colorOf.get('live')).toBe(TEAL);
    expect(all.colorOf.get('deprecated')).toBe(YELLOW);
    expect(some.colorOf.get('deprecated')).toBe(YELLOW);
    expect(legendOf(all)).toEqual(['planned', 'live', 'beta', 'deprecated']);
    expect(legendOf(some)).toEqual(['deprecated']);
  });

  it('unlisted values follow the listed ones, with the free slots in the order they occur', () => {
    const palette = valuePalette(
      present('x', 'high', 'y', 'low'),
      listed(['high', RED], ['low', GREEN]),
    );
    expect(legendOf(palette)).toEqual(['high', 'low', 'x', 'y']);
    expect(palette.colorOf.get('x')).toBe(BLUE);
    expect(palette.colorOf.get('y')).toBe(ORANGE);
  });

  it('any number of colours given by the file is kept; only generated ones run out', () => {
    const twelve = Array.from({ length: 12 }, (_, i): [string, SchemeColor] => {
      const hex = `#${(i + 1).toString(16).padStart(2, '0').repeat(3)}`;
      return [`v${i}`, { light: hex, dark: hex }];
    });
    const values = [...twelve.map(([value]) => value), ...'abcdefghij'.split('')];
    const palette = valuePalette(present(...values), listed(...twelve));
    expect(palette.legend).toHaveLength(12 + 8 + 1);
    for (const [value, color] of twelve) expect(palette.colorOf.get(value)).toBe(color);
    expect(palette.legend.at(-1)).toEqual({
      label: OTHER_LABEL,
      color: OTHER_COLOR,
      kind: 'other',
      count: 2,
      values: ['i', 'j'],
    });
  });

  it('a value the file colours grey keeps its own entry; a value named "Other" is a value', () => {
    const palette = valuePalette(
      present(...'abcdefgh'.split(''), 'Other', 'z', 'old'),
      listed(['old', OTHER_COLOR]),
    );
    expect(palette.legend.map((entry) => [entry.kind, entry.label])).toEqual([
      ['value', 'old'],
      ...'abcdefgh'.split('').map((value) => ['value', value]),
      ['other', OTHER_LABEL],
    ]);
    expect(palette.legend.at(-1)?.values).toEqual(['Other', 'z']);
  });

  it('listed values beyond the palette share Other too, and are named there when present', () => {
    const list = listed(...'abcdefghij'.split(''));
    const palette = valuePalette(present('j', 'a'), list);
    expect(palette.legend).toEqual([
      { label: 'a', color: BLUE, kind: 'value', count: 1 },
      { label: OTHER_LABEL, color: OTHER_COLOR, kind: 'other', count: 1, values: ['j'] },
    ]);
  });

  it('a value listed twice counts as listed first', () => {
    const palette = valuePalette(present('a'), listed(['a', RED], ['a', GREEN]));
    expect(palette.legend).toEqual([{ label: 'a', color: RED, kind: 'value', count: 1 }]);
  });

  it('properties over random lists and values (seeded)', () => {
    const random = mulberry32(20261010);
    const below = (count: number): number => Math.floor(random() * count);
    const pool = Array.from({ length: 14 }, (_, i) => `v${i}`);
    const given: SchemeColor[] = [
      ...CATEGORICAL_COLORS,
      OTHER_COLOR,
      // One scheme of a slot only: the hex of "red" for both schemes, and blue's dark colour.
      { light: RED.light, dark: RED.light },
      { light: '#333333', dark: BLUE.dark },
      { light: '#111111', dark: '#eeeeee' },
      { light: '#222222', dark: '#222222' },
    ];
    const isSlot = (color: SchemeColor): boolean => CATEGORICAL_COLORS.includes(color);
    const sameOnAScheme = (a: SchemeColor, b: SchemeColor): boolean =>
      a.light === b.light || a.dark === b.dark;
    let shared = 0;
    for (let round = 0; round < 3000; round++) {
      const shuffled = [...pool].sort(() => random() - 0.5);
      const here = shuffled.slice(0, below(13)).map((value) => ({ value, count: 1 + below(5) }));
      const list: PresetValue[] = [...pool]
        .sort(() => random() - 0.5)
        .slice(0, below(12))
        .map((value) =>
          random() < 0.5 ? { value } : { value, color: given[below(given.length)] ?? OTHER_COLOR },
        );
      const palette = valuePalette(here, list);
      const givenOf = new Map<string, SchemeColor>();
      for (const { value, color } of list) if (color) givenOf.set(value, color);

      // Every present value has a colour, and the one the file gave when it gave one.
      for (const { value } of here) {
        const color = palette.colorOf.get(value);
        expect(color).toBeDefined();
        if (givenOf.has(value)) expect(color).toBe(givenOf.get(value));
      }
      // Generated colours: each a slot nobody else has, never one the file used; or Other.
      const generated = [...palette.colorOf].filter(([value]) => !givenOf.has(value));
      const slotsOut = generated.map(([, color]) => color).filter(isSlot);
      expect(new Set(slotsOut).size).toBe(slotsOut.length);
      for (const color of slotsOut) {
        // On neither scheme does a generated colour equal one the file gave.
        for (const taken of givenOf.values()) expect(sameOnAScheme(taken, color)).toBe(false);
      }
      for (const [, color] of generated) expect(isSlot(color) || color === OTHER_COLOR).toBe(true);
      // Other is used only when no slot is left free.
      if (generated.some(([, color]) => color === OTHER_COLOR)) {
        shared += 1;
        const free = CATEGORICAL_COLORS.filter(
          (candidate) => ![...givenOf.values()].some((taken) => sameOnAScheme(taken, candidate)),
        );
        expect(slotsOut).toHaveLength(free.length);
      }
      // The legend: every present value once — as an entry or among the values of Other.
      const own = palette.legend.filter((entry) => entry.kind === 'value');
      const other = palette.legend.filter((entry) => entry.kind === 'other');
      expect(other.length).toBeLessThanOrEqual(1);
      if (other[0]) expect(palette.legend.at(-1)).toBe(other[0]);
      const named = [...own.map((entry) => entry.label), ...(other[0]?.values ?? [])];
      expect([...named].sort()).toEqual(here.map((entry) => entry.value).sort());
      const total = palette.legend.reduce((sum, entry) => sum + (entry.count ?? 0), 0);
      expect(total).toBe(here.reduce((sum, entry) => sum + entry.count, 0));
      for (const entry of own) expect(entry.color).toBe(palette.colorOf.get(entry.label));
      // Order: the listed ones as listed, then the others as they occur.
      const listOrder = list.map((entry) => entry.value);
      const ownListed = own
        .map((entry) => entry.label)
        .filter((value) => listOrder.includes(value));
      expect(own.map((entry) => entry.label).slice(0, ownListed.length)).toEqual(ownListed);
      expect(ownListed).toEqual(listOrder.filter((value) => ownListed.includes(value)));
      const ownOthers = own.map((entry) => entry.label).slice(ownListed.length);
      expect(ownOthers).toEqual(
        here.map((entry) => entry.value).filter((value) => ownOthers.includes(value)),
      );

      // A listed value's colour does not depend on what the map has.
      const alone = valuePalette([], list);
      for (const { value } of list) {
        expect(palette.colorOf.get(value)).toBe(alone.colorOf.get(value));
      }
      // One more value at the end changes no colour that was there.
      const more = valuePalette([...here, { value: 'new', count: 1 }], list);
      for (const { value } of here) {
        expect(more.colorOf.get(value)).toBe(palette.colorOf.get(value));
      }
    }
    expect(shared).toBeGreaterThan(0);
  });
});

describe('colorByOptions / usableColorBy', () => {
  it('offers the attributes and metrics the file has, in order', () => {
    expect(colorByOptions(model)).toEqual([
      { value: 'owner', label: 'Owner', group: 'label' },
      { value: 'tech', label: 'Tech', group: 'label' },
      { value: 'metric:loc', label: 'loc', group: 'metric' },
      { value: 'metric:churn', label: 'churn', group: 'metric' },
    ]);
    expect(usableColorBy(model, 'owner')).toBe('owner');
    expect(usableColorBy(model, 'status')).toBe('none');
    expect(usableColorBy(model, 'metric:loc')).toBe('metric:loc');
    expect(usableColorBy(model, 'metric:nope')).toBe('none');
    expect(usableColorBy(model, '__proto__')).toBe('none');
  });

  it('offers the presets, then the attributes and labels, then the metrics', () => {
    expect(colorByOptions(labelled)).toEqual([
      { value: 'preset:Zones', label: 'Zones', group: 'preset', description: 'Who may reach it' },
      { value: 'preset:zone', label: 'zone', group: 'preset' },
      { value: 'preset:Teams', label: 'Teams', group: 'preset' },
      { value: 'owner', label: 'Owner', group: 'label' },
      { value: 'tech', label: 'Tech', group: 'label' },
      { value: 'label:zone', label: 'zone', group: 'label' },
      { value: 'label:tier', label: 'tier', group: 'label' },
      { value: 'metric:loc', label: 'loc', group: 'metric' },
    ]);
    expect(COLOR_BY_GROUPS.map((group) => COLOR_BY_GROUP_LABELS[group])).toEqual([
      'Presets',
      'Labels',
      'Metrics',
    ]);
    // The groups come one after the other: a list can be cut into them in one pass.
    const groups = colorByOptions(labelled).map((option) => COLOR_BY_GROUPS.indexOf(option.group));
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
  });

  it('a file with none of them offers nothing', () => {
    expect(colorByOptions(parseOk('version: 1\ndomains:\n  - { id: a, name: A }\n'))).toEqual([]);
  });

  it('usableColorBy keeps what the file offers and nothing else', () => {
    for (const option of colorByOptions(labelled)) {
      expect(usableColorBy(labelled, option.value)).toBe(option.value);
    }
    for (const value of [
      'preset:zones',
      'preset:Nope',
      'preset:',
      'label:nope',
      'label:owner',
      'label:__proto__',
      'label:',
      'zone',
      'status',
      'metric:nope',
      '__proto__',
      '',
    ]) {
      expect(usableColorBy(labelled, value), value).toBe('none');
    }
    expect(usableColorBy(labelled, 'none')).toBe('none');
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
    expect(coloring.legend.at(-1)).toEqual({
      label: OTHER_LABEL,
      color: OTHER_COLOR,
      kind: 'other',
      count: 2,
      values: ['s8', 's9'],
    });
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

describe('nodeColoring by a label and by a preset', () => {
  const colorsOf = (colorBy: ColorBy): Record<string, SchemeColor | undefined> => {
    const { byNode } = nodeColoring(labelled, colorBy);
    return Object.fromEntries([...labelled.nodes.keys()].map((id) => [id, byNode.get(id)]));
  };

  it('a label: one colour per value in document order, inherited, with counts', () => {
    const coloring = nodeColoring(labelled, 'label:zone');
    expect(coloring.title).toBe('zone');
    expect(coloring.subtitle).toBeUndefined();
    expect(coloring.description).toBeUndefined();
    expect(colorsOf('label:zone')).toEqual({
      a: BLUE,
      'a.x': ORANGE,
      'a.x.k': ORANGE,
      'a.y': TEAL,
      b: undefined,
    });
    expect(coloring.legend).toEqual([
      { label: 'public', color: BLUE, kind: 'value', count: 1 },
      { label: 'payment', color: ORANGE, kind: 'value', count: 2 },
      { label: 'internal', color: TEAL, kind: 'value', count: 1 },
    ]);
    expect(coloring.withoutValue).toBe(1);
    expect(coloring.range).toBeUndefined();
  });

  it('a preset: its name, its label under it, its colours and its order', () => {
    const coloring = nodeColoring(labelled, 'preset:Zones');
    expect(coloring.title).toBe('Zones');
    expect(coloring.subtitle).toBe('by zone');
    expect(coloring.description).toBe('Who may reach it');
    expect(colorsOf('preset:Zones')).toEqual({
      a: ORANGE,
      'a.x': BLUE,
      'a.x.k': BLUE,
      'a.y': { light: '#102030', dark: '#102030' },
      b: undefined,
    });
    // "partner" is listed and on no node: not in the legend. "payment" has no colour of the
    // file: the first slot the list does not use (orange and green are used) — blue.
    expect(coloring.legend).toEqual([
      { label: 'internal', color: { light: '#102030', dark: '#102030' }, kind: 'value', count: 1 },
      { label: 'public', color: ORANGE, kind: 'value', count: 1 },
      { label: 'payment', color: BLUE, kind: 'value', count: 2 },
    ]);
    expect(coloring.withoutValue).toBe(1);
  });

  it('a preset without values is the label under another name', () => {
    const preset = nodeColoring(labelled, 'preset:zone');
    const label = nodeColoring(labelled, 'label:zone');
    expect(preset.title).toBe('zone');
    // Its name is the label's: nothing to say under it.
    expect(preset.subtitle).toBeUndefined();
    expect([...preset.byNode]).toEqual([...label.byNode]);
    expect(preset.legend).toEqual(label.legend);
  });

  it('a preset may colour an attribute', () => {
    const coloring = nodeColoring(labelled, 'preset:Teams');
    expect(coloring.title).toBe('Teams');
    expect(coloring.subtitle).toBe('by Owner');
    expect(coloring.legend.map((entry) => [entry.label, entry.count])).toEqual([
      ['Blue', 3],
      ['Red', 1],
    ]);
    expect([...coloring.byNode]).toEqual([...nodeColoring(labelled, 'owner').byNode]);
    // Named as the attribute is titled, it has nothing to say under its name.
    const named = parseOk(`version: 1
domains:
  - { id: a, name: A, owner: Blue }
presets:
  - { name: Owner, label: owner }
  - { name: owner, label: owner }
`);
    expect(nodeColoring(named, 'preset:Owner').subtitle).toBeUndefined();
    expect(nodeColoring(named, 'preset:owner').subtitle).toBe('by Owner');
  });

  it('a label choice that names an attribute reads the attribute, though no list offers it', () => {
    const coloring = nodeColoring(labelled, 'label:owner');
    const owner = nodeColoring(labelled, 'owner');
    expect(usableColorBy(labelled, 'label:owner')).toBe('none');
    expect(coloring.title).toBe('Owner');
    expect(coloring.subtitle).toBeUndefined();
    expect([...coloring.byNode]).toEqual([...owner.byNode]);
    expect(coloring.legend).toEqual(owner.legend);
    expect(coloring.withoutValue).toBe(owner.withoutValue);
  });

  it('an attribute and a metric have a title; a metric no counts', () => {
    const owner = nodeColoring(labelled, 'owner');
    expect(owner.title).toBe('Owner');
    expect(owner.withoutValue).toBe(1);
    expect(owner.legend).toEqual([
      { label: 'Blue', color: BLUE, kind: 'value', count: 3 },
      { label: 'Red', color: ORANGE, kind: 'value', count: 1 },
    ]);
    const loc = nodeColoring(labelled, 'metric:loc');
    expect(loc.title).toBe('loc');
    expect(loc.withoutValue).toBe(0);
    expect(loc.legend.map((entry) => [entry.label, entry.kind, entry.count])).toEqual([
      ['100', 'value', undefined],
      ['400', 'value', undefined],
    ]);
    expect(loc.range).toEqual({ min: 100, max: 400 });
  });

  it('a choice the model does not have colours nothing', () => {
    const absent: ColorBy[] = ['preset:Nope', 'label:nope', 'metric:nope', 'none'];
    for (const value of absent) {
      const coloring = nodeColoring(labelled, value);
      expect(coloring.byNode.size, value).toBe(0);
      expect(coloring.legend).toEqual([]);
      expect(coloring.withoutValue).toBe(0);
    }
  });

  it('the counts add up: coloured nodes and those without a value are all the nodes (seeded)', () => {
    const random = mulberry32(5);
    const below = (count: number): number => Math.floor(random() * count);
    const values = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
    const label = (): string =>
      random() < 0.5 ? `labels: { z: ${values[below(values.length)] ?? 'a'} }` : 'tech: T';
    let colourings = 0;
    for (let round = 0; round < 200; round++) {
      const lines = ['version: 1', 'domains:'];
      for (let d = 0; d < 1 + below(4); d++) {
        lines.push(`  - id: d${d}`, `    name: D`, `    ${label()}`, '    components:');
        for (let c = 0; c < 1 + below(5); c++) {
          lines.push(`      - id: d${d}.c${c}`, `        name: C`, `        ${label()}`);
        }
      }
      lines.push('presets:', '  - name: P', '    label: tech', '    values: { T: red }');
      const generated = parseOk(`${lines.join('\n')}\n`);
      for (const option of colorByOptions(generated)) {
        const coloring = nodeColoring(generated, option.value);
        colourings += 1;
        expect(coloring.byNode.size).toBeGreaterThan(0);
        expect(coloring.byNode.size + coloring.withoutValue).toBe(generated.nodes.size);
        const counted = coloring.legend.reduce((sum, entry) => sum + (entry.count ?? 0), 0);
        expect(counted).toBe(coloring.byNode.size);
        for (const id of coloring.byNode.keys()) expect(generated.nodes.has(id)).toBe(true);
      }
    }
    expect(colourings).toBeGreaterThan(200);
  });
});

describe('what is stored: the settings, a saved view, a link', () => {
  const view = (colorBy: string): SavedView => ({
    name: 'V',
    collapsed: [],
    hiddenKinds: [],
    lodMode: 'auto',
    center: { x: 0, y: 0, zoom: 1 },
    colorBy,
  });

  it('legendEntryTitle names the values behind Other — the first twenty, then how many more', () => {
    expect(legendEntryTitle({ label: 'live', color: BLUE, kind: 'value', count: 3 })).toBe('live');
    const other = (values: string[]): string =>
      legendEntryTitle({ label: OTHER_LABEL, color: OTHER_COLOR, kind: 'other', count: 1, values });
    expect(other(['s8', 's9'])).toBe('s8, s9');
    const many = Array.from({ length: 300 }, (_, i) => `v${i}`);
    expect(other(many.slice(0, OTHER_VALUES_SHOWN))).toBe(many.slice(0, 20).join(', '));
    expect(other(many)).toBe(`${many.slice(0, 20).join(', ')} … and 280 more`);
  });

  it('boxCountText says a count of the legend in words', () => {
    expect([0, 1, 2, 13].map(boxCountText)).toEqual(['0 boxes', '1 box', '2 boxes', '13 boxes']);
  });

  it('describeColorBy says a stored choice in words', () => {
    expect(describeColorBy('preset:Risk')).toBe('preset "Risk"');
    expect(describeColorBy('label:team')).toBe('label "team"');
    expect(describeColorBy('metric:loc')).toBe('metric "loc"');
    expect(describeColorBy('owner')).toBe('owner');
    // A quotation mark in a name does not end the quotation.
    expect(describeColorBy('preset:a"b')).toBe('preset "a\\"b"');
  });

  it('viewColorBy: the choice when the file has it; otherwise nothing, and it says so', () => {
    expect(viewColorBy(labelled, 'preset:Zones')).toEqual({ colorBy: 'preset:Zones' });
    expect(viewColorBy(labelled, 'label:tier')).toEqual({ colorBy: 'label:tier' });
    expect(viewColorBy(labelled, undefined)).toEqual({ colorBy: 'none' });
    expect(viewColorBy(labelled, 'none')).toEqual({ colorBy: 'none' });
    // A view that carries an empty colouring (a link written by hand) has none.
    expect(viewColorBy(labelled, '')).toEqual({ colorBy: 'none' });
    expect(viewColorBy(labelled, '  ')).toEqual({ colorBy: 'none' });
    expect(viewColorBy(labelled, 'preset:Risk')).toEqual({
      colorBy: 'none',
      note: 'This view is coloured by preset "Risk", which this file does not have: the boxes are not coloured.',
    });
    expect(viewColorBy(labelled, 'metric:churn').note).toBe(
      'This view is coloured by metric "churn", which this file does not have: the boxes are not coloured.',
    );
    expect(viewColorBy(labelled, 'status').note).toBe(
      'This view is coloured by status, which this file does not have: the boxes are not coloured.',
    );
  });

  it('a preset and a label survive the stored view, the link and the stored settings', () => {
    for (const colorBy of ['preset:Zones', 'label:zone', `preset:${'ü'.repeat(80)}`]) {
      const stored: unknown = JSON.parse(JSON.stringify(view(colorBy)));
      expect(parseSavedView(stored, labelled)?.colorBy).toBe(colorBy);
      expect(viewFromLinkHash(viewLinkHash(view(colorBy)), labelled)?.colorBy).toBe(colorBy);
      const settings = parseDisplaySettings(
        serializeDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, colorBy }),
      );
      expect(settings.colorBy).toBe(colorBy);
    }
  });
});
