// Colour by: the nodes tinted by one of their labels — the attributes owner, status and tech,
// or a label of the file's own — with one colour per value, by a colour preset of the file
// (a label with the colours the file gives its values), or by one of their metrics (one hue,
// light to dark). Pure: no React, no browser APIs. The palette is the validated one of the
// dataviz reference (categorical slots in fixed order; the blue sequential ramp), with its light
// and dark variants.

import {
  effectiveLabel,
  isNodeAttribute,
  labelNames,
  labelValueCounts,
  NODE_ATTRIBUTES,
  type ArchitectureModel,
  type ColorPreset,
  type NodeAttribute,
  type PresetValue,
  type SchemeColor,
  type ValueCount,
} from './model';

/**
 * What the nodes are coloured by: nothing, an attribute, a label of the file by its name, a
 * colour preset of the file by its name, or a metric by its name.
 */
export type ColorBy =
  'none' | NodeAttribute | `label:${string}` | `preset:${string}` | `metric:${string}`;

export const METRIC_PREFIX = 'metric:';
export const LABEL_PREFIX = 'label:';
export const PRESET_PREFIX = 'preset:';

/** The metric a `metric:<name>` choice names, or undefined for anything else. */
export function metricOf(colorBy: string): string | undefined {
  return colorBy.startsWith(METRIC_PREFIX) ? colorBy.slice(METRIC_PREFIX.length) : undefined;
}

/** The label a `label:<name>` choice names, or undefined for anything else. */
export function labelOf(colorBy: string): string | undefined {
  return colorBy.startsWith(LABEL_PREFIX) ? colorBy.slice(LABEL_PREFIX.length) : undefined;
}

/** The preset of `model` a `preset:<name>` choice names, or undefined. */
export function presetOf(
  model: Pick<ArchitectureModel, 'presets'>,
  colorBy: string,
): ColorPreset | undefined {
  if (!colorBy.startsWith(PRESET_PREFIX)) return undefined;
  const name = colorBy.slice(PRESET_PREFIX.length);
  return model.presets.find((preset) => preset.name === name);
}

/** The kinds of choice "Colour by" offers, in the order of the list. */
export const COLOR_BY_GROUPS = ['preset', 'label', 'metric'] as const;
export type ColorByGroup = (typeof COLOR_BY_GROUPS)[number];

/** The headings of the groups in the list. */
export const COLOR_BY_GROUP_LABELS: Readonly<Record<ColorByGroup, string>> = {
  preset: 'Presets',
  label: 'Labels',
  metric: 'Metrics',
};

export interface ColorByOption {
  readonly value: ColorBy;
  readonly label: string;
  readonly group: ColorByGroup;
  /** A preset's description. */
  readonly description?: string;
}

/** A label as a heading: an attribute capitalised (`Owner`), a label of the file as written. */
export function labelTitle(label: string): string {
  return isNodeAttribute(label) ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

/**
 * What the loaded structure offers to colour by, group by group: the presets in file order;
 * the labels — each attribute some node has, then each label of the file in the order of first
 * use; the metrics in the order of first use. Empty when the file has none of them.
 */
export function colorByOptions(model: ArchitectureModel): ColorByOption[] {
  const options: ColorByOption[] = [];
  for (const preset of model.presets) {
    options.push({
      value: `${PRESET_PREFIX}${preset.name}`,
      label: preset.name,
      group: 'preset',
      ...(preset.description !== undefined ? { description: preset.description } : {}),
    });
  }
  const attributes = new Set<NodeAttribute>();
  const metrics: string[] = [];
  for (const node of model.nodes.values()) {
    for (const key of NODE_ATTRIBUTES) if (node[key] !== undefined) attributes.add(key);
    for (const name of node.metrics?.keys() ?? []) if (!metrics.includes(name)) metrics.push(name);
  }
  for (const key of NODE_ATTRIBUTES) {
    if (attributes.has(key)) options.push({ value: key, label: labelTitle(key), group: 'label' });
  }
  for (const name of labelNames(model)) {
    options.push({ value: `${LABEL_PREFIX}${name}`, label: name, group: 'label' });
  }
  for (const name of metrics) {
    options.push({ value: `${METRIC_PREFIX}${name}`, label: name, group: 'metric' });
  }
  return options;
}

/** `value` when the structure offers it (or it is `none`); `none` otherwise. */
export function usableColorBy(model: ArchitectureModel, value: string): ColorBy {
  if (value === 'none') return 'none';
  return colorByOptions(model).some((option) => option.value === value)
    ? (value as ColorBy)
    : 'none';
}

/**
 * A stored choice in words: `preset "Risk"`, `label "team"`, `metric "loc"`, `owner` — whether
 * or not a loaded file offers it.
 */
export function describeColorBy(value: string): string {
  for (const [prefix, word] of [
    [PRESET_PREFIX, 'preset'],
    [LABEL_PREFIX, 'label'],
    [METRIC_PREFIX, 'metric'],
  ] as const) {
    if (value.startsWith(prefix)) return `${word} ${JSON.stringify(value.slice(prefix.length))}`;
  }
  return value;
}

/**
 * What applying a saved view colours by, and what to say about it: the view's choice when the
 * structure offers it; otherwise nothing, with the sentence that says what is missing. A view
 * without a colouring — none stored, `none`, or an empty text, which a link written by hand may
 * carry — colours by nothing and says nothing.
 */
export function viewColorBy(
  model: ArchitectureModel,
  stored: string | undefined,
): { readonly colorBy: ColorBy; readonly note?: string } {
  if (stored === undefined || stored === 'none' || stored.trim() === '') return { colorBy: 'none' };
  const colorBy = usableColorBy(model, stored);
  if (colorBy !== 'none') return { colorBy };
  return {
    colorBy,
    note: `This view is coloured by ${describeColorBy(stored)}, which this file does not have: the boxes are not coloured.`,
  };
}

/** Categorical slots in fixed order (dataviz reference palette); a 9th value folds into Other. */
export const CATEGORICAL_COLORS: readonly SchemeColor[] = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#008300', dark: '#008300' },
  { light: '#4a3aa7', dark: '#9085e9' },
  { light: '#e34948', dark: '#e66767' },
];
/** The colour of every value beyond the eight slots. */
export const OTHER_COLOR: SchemeColor = { light: '#898781', dark: '#898781' };
export const OTHER_LABEL = 'Other';
/** What the legend calls the nodes that have no value. */
export const NO_VALUE_LABEL = 'No value';

/** The names a file may give a colour by: the slots of `CATEGORICAL_COLORS`, in their order. */
export const COLOR_NAMES = [
  'blue',
  'orange',
  'teal',
  'yellow',
  'pink',
  'green',
  'purple',
  'red',
] as const;
/** The two spellings of the name of `OTHER_COLOR`. */
export const GREY_NAMES = ['grey', 'gray'] as const;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** `#rgb` or `#rrggbb` in any letter case as `#rrggbb` in lower case; undefined for the rest. */
function hexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (!HEX_COLOR.test(text)) return undefined;
  return text.length === 4 ? `#${[...text.slice(1)].map((digit) => digit + digit).join('')}` : text;
}

/**
 * The colour a file names: a name of the palette (both schemes come with it; any letter case),
 * `grey`, a hex colour `#rgb` or `#rrggbb` (the same in both schemes), or a mapping of exactly
 * `light` and `dark` to two hex colours. Undefined for anything else: the file is not trusted,
 * and nothing but a palette colour or `#` and six hex digits ever reaches a style.
 */
export function colorFromFile(value: unknown): SchemeColor | undefined {
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if ((GREY_NAMES as readonly string[]).includes(text)) return OTHER_COLOR;
    const slot = (COLOR_NAMES as readonly string[]).indexOf(text);
    if (slot >= 0) return CATEGORICAL_COLORS[slot];
    const hex = hexColor(text);
    return hex === undefined ? undefined : { light: hex, dark: hex };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const pair = value as Record<string, unknown>;
  const keys = Object.keys(pair);
  if (keys.length !== 2 || !Object.hasOwn(pair, 'light') || !Object.hasOwn(pair, 'dark')) {
    return undefined;
  }
  const light = hexColor(pair['light']);
  const dark = hexColor(pair['dark']);
  return light !== undefined && dark !== undefined ? { light, dark } : undefined;
}

/** The blue sequential ramp, light to dark (steps 100–700 of the reference palette). */
export const SEQUENTIAL_RAMP: readonly string[] = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
];

export interface LegendEntry {
  readonly label: string;
  readonly color: SchemeColor;
  /**
   * `value`: one value of the label (or an end of the ramp of a metric). `other`: the shared
   * entry of the values that got no colour of their own.
   */
  readonly kind: 'value' | 'other';
  /** The number of nodes that carry it, own or inherited. Absent for the ends of a ramp. */
  readonly count?: number;
  /** For `other`: the values it stands for, in the order of their first node. */
  readonly values?: readonly string[];
}

export interface ValuePalette {
  /** The colour of every value that is listed or present (`OTHER_COLOR` for the shared ones). */
  readonly colorOf: ReadonlyMap<string, SchemeColor>;
  /**
   * One entry per present value with a colour of its own — the listed ones in the order of the
   * list, then the others in the order of `present` — and last, when there are any, the entry
   * of the present values that share `OTHER_COLOR`.
   */
  readonly legend: readonly LegendEntry[];
}

/** True when the two are the same colour on one of the schemes: there they cannot be told apart. */
function sharesColor(a: SchemeColor, b: SchemeColor): boolean {
  return a.light === b.light || a.dark === b.dark;
}

/**
 * The colours of the values of one label. `present`: the values the nodes have, in the order of
 * their first node, each with its number of nodes. `listed`: what a preset lists, in its order
 * (none for a label or an attribute taken as it is).
 * 1. A listed value with a colour has that colour. There is no limit to how many.
 * 2. A slot of the palette that a listed value has — by name, or by a colour that equals the
 *    slot's in the light or in the dark scheme — is not handed out: two values never get the
 *    same colour on a scheme unless the file gives them one.
 * 3. A listed value without a colour takes the next free slot, in the order of the list —
 *    whether or not a node has the value, so its colour does not depend on the map.
 * 4. A present value that is not listed takes the next free slot, in the order of `present`.
 * 5. When the slots are used up, the rest share `OTHER_COLOR` and one legend entry.
 * A value listed twice counts once, as listed first.
 */
export function valuePalette(
  present: readonly ValueCount[],
  listed: readonly PresetValue[] = [],
): ValuePalette {
  const taken = new Set<number>();
  for (const { color } of listed) {
    if (!color) continue;
    CATEGORICAL_COLORS.forEach((candidate, slot) => {
      if (sharesColor(candidate, color)) taken.add(slot);
    });
  }
  const free = CATEGORICAL_COLORS.filter((_, slot) => !taken.has(slot));
  let next = 0;
  const colorOf = new Map<string, SchemeColor>();
  const shared = new Set<string>();
  const generate = (value: string): void => {
    const slot = free[next];
    next += 1;
    if (slot) colorOf.set(value, slot);
    else {
      colorOf.set(value, OTHER_COLOR);
      shared.add(value);
    }
  };
  for (const { value, color } of listed) {
    if (colorOf.has(value)) continue;
    if (color) colorOf.set(value, color);
    else generate(value);
  }
  for (const { value } of present) if (!colorOf.has(value)) generate(value);

  const counts = new Map<string, number>();
  for (const { value, count } of present) counts.set(value, (counts.get(value) ?? 0) + count);
  const legend: LegendEntry[] = [];
  const entered = new Set<string>();
  const enter = (value: string): void => {
    const count = counts.get(value);
    const color = colorOf.get(value);
    if (count === undefined || !color || shared.has(value) || entered.has(value)) return;
    entered.add(value);
    legend.push({ label: value, color, kind: 'value', count });
  };
  for (const { value } of listed) enter(value);
  for (const value of counts.keys()) enter(value);
  const rest = [...counts.keys()].filter((value) => shared.has(value));
  if (rest.length > 0) {
    legend.push({
      label: OTHER_LABEL,
      color: OTHER_COLOR,
      kind: 'other',
      count: rest.reduce((sum, value) => sum + (counts.get(value) ?? 0), 0),
      values: rest,
    });
  }
  return { colorOf, legend };
}

export interface NodeColoring {
  readonly colorBy: ColorBy;
  /** What the legend is headed with: the preset's name, the label, the metric. */
  readonly title: string;
  /** Under a preset: the label it colours by (`by zone`), unless that is its name. */
  readonly subtitle?: string;
  /** A preset's description. */
  readonly description?: string;
  /** Per node: its colour. Nodes the choice says nothing about are absent. */
  readonly byNode: ReadonlyMap<string, SchemeColor>;
  /**
   * For a label, an attribute or a preset: one entry per value, then the shared one (see
   * `valuePalette`). For a metric: the ramp's ends.
   */
  readonly legend: readonly LegendEntry[];
  /**
   * For a label, an attribute or a preset: the number of nodes without a value, which are not
   * tinted. 0 for a metric and for nothing.
   */
  readonly withoutValue: number;
  /** For a metric: its range over the nodes that have it. */
  readonly range?: { readonly min: number; readonly max: number };
}

const NO_COLORING: NodeColoring = {
  colorBy: 'none',
  title: '',
  byNode: new Map(),
  legend: [],
  withoutValue: 0,
};

/** The label a choice colours by, with the preset that says how; undefined for the rest. */
function labelChoice(
  model: ArchitectureModel,
  colorBy: ColorBy,
): { readonly label: string; readonly preset?: ColorPreset } | undefined {
  if (isNodeAttribute(colorBy)) return { label: colorBy };
  const label = labelOf(colorBy);
  if (label !== undefined) return { label };
  const preset = presetOf(model, colorBy);
  return preset ? { label: preset.label, preset } : undefined;
}

/**
 * The colours of the nodes for `colorBy`:
 * - an attribute or a label: the distinct values in the order of their first node (document
 *   order) take the categorical slots; from the ninth value on, every value is "Other". A node
 *   without a value of its own has its nearest ancestor's (`effectiveLabel`);
 * - a preset: the same label, with the colours and the order the preset gives (`valuePalette`);
 * - a metric: the nodes that have it are placed on the sequential ramp between the smallest and
 *   the largest value (all alike when those are equal). It is not inherited.
 * A choice the model does not have colours nothing.
 */
export function nodeColoring(model: ArchitectureModel, colorBy: ColorBy): NodeColoring {
  if (colorBy === 'none') return NO_COLORING;
  const byNode = new Map<string, SchemeColor>();
  const metric = metricOf(colorBy);
  if (metric !== undefined) {
    const values = new Map<string, number>();
    for (const node of model.nodes.values()) {
      const value = node.metrics?.get(metric);
      if (value !== undefined) values.set(node.id, value);
    }
    if (values.size === 0) return { colorBy, title: metric, byNode, legend: [], withoutValue: 0 };
    const min = Math.min(...values.values());
    const max = Math.max(...values.values());
    const last = SEQUENTIAL_RAMP.length - 1;
    for (const [id, value] of values) {
      const t = max > min ? (value - min) / (max - min) : 1;
      const step = SEQUENTIAL_RAMP[Math.round(t * last)] ?? SEQUENTIAL_RAMP[last] ?? '#000000';
      byNode.set(id, { light: step, dark: step });
    }
    const low = SEQUENTIAL_RAMP[0] ?? '#000000';
    const high = SEQUENTIAL_RAMP[last] ?? '#000000';
    return {
      colorBy,
      title: metric,
      byNode,
      legend: [
        { label: formatMetric(min), color: { light: low, dark: low }, kind: 'value' },
        { label: formatMetric(max), color: { light: high, dark: high }, kind: 'value' },
      ],
      withoutValue: 0,
      range: { min, max },
    };
  }
  const choice = labelChoice(model, colorBy);
  if (!choice) return NO_COLORING;
  const { label, preset } = choice;
  const palette = valuePalette(labelValueCounts(model, label), preset?.values);
  for (const id of model.nodes.keys()) {
    const found = effectiveLabel(model, id, label);
    const color = found ? palette.colorOf.get(found.value) : undefined;
    if (color) byNode.set(id, color);
  }
  const title = preset ? preset.name : labelTitle(label);
  const subtitle = preset && labelTitle(label) !== title ? `by ${labelTitle(label)}` : undefined;
  return {
    colorBy,
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(preset?.description !== undefined ? { description: preset.description } : {}),
    byNode,
    legend: palette.legend,
    withoutValue: byNode.size === 0 ? 0 : model.nodes.size - byNode.size,
  };
}

/** How many of the values behind "Other" the tooltip of its legend entry names. */
export const OTHER_VALUES_SHOWN = 20;

/**
 * The tooltip of a legend entry: its label; for the shared entry the values it stands for — the
 * first `OTHER_VALUES_SHOWN`, then how many more there are.
 */
export function legendEntryTitle(entry: LegendEntry): string {
  if (!entry.values) return entry.label;
  const shown = entry.values.slice(0, OTHER_VALUES_SHOWN).join(', ');
  const more = entry.values.length - OTHER_VALUES_SHOWN;
  return more > 0 ? `${shown} … and ${more} more` : shown;
}

/** A number of boxes in words — what a count in the legend means: "1 box", "13 boxes". */
export function boxCountText(count: number): string {
  return `${count} ${count === 1 ? 'box' : 'boxes'}`;
}

/** A metric value for the legend: whole numbers as they are, others with two decimals at most. */
export function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}
