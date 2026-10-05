// Colour by: the nodes tinted by one of their attributes (owner, status, tech —
// one colour per value) or by one of their metrics (one hue, light to dark). Pure: no React, no
// browser APIs. The palette is the validated one of the dataviz reference (categorical slots in
// fixed order; the blue sequential ramp), with its light and dark variants.

import {
  effectiveAttribute,
  NODE_ATTRIBUTES,
  type ArchitectureModel,
  type NodeAttribute,
} from './model';

/** What the nodes are coloured by: nothing, an attribute, or a metric by its name. */
export type ColorBy = 'none' | NodeAttribute | `metric:${string}`;

export const METRIC_PREFIX = 'metric:';

export function isNodeAttribute(value: unknown): value is NodeAttribute {
  return typeof value === 'string' && (NODE_ATTRIBUTES as readonly string[]).includes(value);
}

/** The metric a `metric:<name>` choice names, or undefined for anything else. */
export function metricOf(colorBy: string): string | undefined {
  return colorBy.startsWith(METRIC_PREFIX) ? colorBy.slice(METRIC_PREFIX.length) : undefined;
}

export interface ColorByOption {
  readonly value: ColorBy;
  readonly label: string;
}

/**
 * What the loaded structure offers to colour by: each attribute some node has, then each metric
 * some node has, in the order they first occur. Empty when the file has none of either.
 */
export function colorByOptions(model: ArchitectureModel): ColorByOption[] {
  const options: ColorByOption[] = [];
  const attributes = new Set<NodeAttribute>();
  const metrics: string[] = [];
  for (const node of model.nodes.values()) {
    for (const key of NODE_ATTRIBUTES) if (node[key] !== undefined) attributes.add(key);
    for (const name of node.metrics?.keys() ?? []) if (!metrics.includes(name)) metrics.push(name);
  }
  for (const key of NODE_ATTRIBUTES) {
    if (attributes.has(key)) options.push({ value: key, label: capitalize(key) });
  }
  for (const name of metrics) options.push({ value: `${METRIC_PREFIX}${name}`, label: name });
  return options;
}

/** `value` when the structure offers it (or it is `none`); `none` otherwise. */
export function usableColorBy(model: ArchitectureModel, value: string): ColorBy {
  if (value === 'none') return 'none';
  return colorByOptions(model).some((option) => option.value === value)
    ? (value as ColorBy)
    : 'none';
}

/** A colour in both schemes. */
export interface SchemeColor {
  readonly light: string;
  readonly dark: string;
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
}

export interface NodeColoring {
  readonly colorBy: ColorBy;
  /** Per node: its colour. Nodes the choice says nothing about are absent. */
  readonly byNode: ReadonlyMap<string, SchemeColor>;
  /** For an attribute: one entry per value, in slot order. For a metric: the ramp's ends. */
  readonly legend: readonly LegendEntry[];
  /** For a metric: its range over the nodes that have it. */
  readonly range?: { readonly min: number; readonly max: number };
}

const NO_COLORING: NodeColoring = { colorBy: 'none', byNode: new Map(), legend: [] };

/**
 * The colours of the nodes for `colorBy`:
 * - an attribute: the distinct values in the order of their first node (document order) take
 *   the categorical slots; from the ninth value on, every value is "Other". A node without a
 *   value of its own has its nearest ancestor's (`effectiveAttribute`);
 * - a metric: the nodes that have it are placed on the sequential ramp between the smallest and
 *   the largest value (all alike when those are equal). It is not inherited.
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
    if (values.size === 0) return { colorBy, byNode, legend: [] };
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
      byNode,
      legend: [
        { label: formatMetric(min), color: { light: low, dark: low } },
        { label: formatMetric(max), color: { light: high, dark: high } },
      ],
      range: { min, max },
    };
  }
  if (!isNodeAttribute(colorBy)) return NO_COLORING;
  const slots = new Map<string, SchemeColor>();
  const legend: LegendEntry[] = [];
  let other = false;
  for (const node of model.nodes.values()) {
    const found = effectiveAttribute(model, node.id, colorBy);
    if (!found) continue;
    let color = slots.get(found.value);
    if (!color) {
      const slot = CATEGORICAL_COLORS[slots.size];
      color = slot ?? OTHER_COLOR;
      slots.set(found.value, color);
      if (slot) legend.push({ label: found.value, color });
      else other = true;
    }
    byNode.set(node.id, color);
  }
  if (other) legend.push({ label: OTHER_LABEL, color: OTHER_COLOR });
  return { colorBy, byNode, legend };
}

/** A metric value for the legend: whole numbers as they are, others with two decimals at most. */
export function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
