import { describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import {
  CATEGORICAL_COLORS,
  EDGE_KINDS,
  OTHER_COLOR,
  colorByOptions,
  labelValueCounts,
  nodeColoring,
  parseArchitecture,
  type ArchitectureModel,
  type SchemeColor,
} from './index';

function parseExample(): ArchitectureModel {
  const result = parseArchitecture(exampleYaml, { sourceName: 'examples/architecture.yaml' });
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  if (!result.model) throw new Error('example did not parse');
  return result.model;
}

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

describe('examples/architecture.yaml', () => {
  it('parses with no errors or warnings, and is large enough to exercise the viewer', () => {
    const model = parseExample();
    const levels = [0, 0, 0];
    for (const node of model.nodes.values()) levels[node.level] = (levels[node.level] ?? 0) + 1;
    const [domains = 0, components = 0, subcomponents = 0] = levels;
    expect(domains).toBeGreaterThanOrEqual(4);
    expect(domains).toBeLessThanOrEqual(6);
    expect(components).toBeGreaterThanOrEqual(12);
    expect(components).toBeLessThanOrEqual(20);
    expect(subcomponents).toBeGreaterThanOrEqual(18);
    expect(subcomponents).toBeLessThanOrEqual(30);
    expect(model.edges.length).toBeGreaterThanOrEqual(35);
    expect(model.edges.length).toBeLessThanOrEqual(50);
    expect(model.rootIds).toHaveLength(domains);
  });

  it('uses every edge kind and connects nodes at every level', () => {
    const model = parseExample();
    expect(new Set(model.edges.map((e) => e.kind))).toEqual(new Set(EDGE_KINDS));
    const levelPairs = new Set(
      model.edges.map((e) => `${model.nodes.get(e.from)?.level}-${model.nodes.get(e.to)?.level}`),
    );
    expect(levelPairs).toContain('0-0');
    expect(levelPairs).toContain('0-1');
    expect(levelPairs).toContain('1-2');
    expect(levelPairs).toContain('2-2');
    expect(levelPairs).toContain('1-0');
  });

  it('exercises every way a node can relate to the rows', () => {
    const model = parseExample();
    const node = (id: string) => {
      const n = model.nodes.get(id);
      if (!n) throw new Error(`missing ${id}`);
      return n;
    };
    expect(model.rows.map((r) => r.id)).toEqual(['backoffice', 'middle', 'channels']);

    // Domain with an explicit row: everything inside inherits it.
    expect(node('storefront').row).toBe('channels');
    expect(node('storefront.web.checkout').row).toBeUndefined();
    expect(node('storefront.web.checkout').effectiveRow).toBe('channels');
    expect(node('storefront.web.checkout').rowRange).toEqual({ top: 2, bottom: 2 });

    // Domain without a row whose components sit in different rows.
    expect(node('operations').row).toBeUndefined();
    expect(node('operations').rowRange).toEqual({ top: 0, bottom: 2 });

    // Component without a row whose subcomponents are in different rows (nested span).
    expect(node('data.analytics').rowRange).toEqual({ top: 0, bottom: 1 });
    expect(node('data').rowRange).toEqual({ top: 0, bottom: 1 });

    // Row-less children inside spanning groups (placed by connections later).
    expect(node('operations.alerts').rowRange).toBeUndefined();
    expect(node('data.analytics.feature-store').rowRange).toBeUndefined();

    // Nothing assigned anywhere in the subtree.
    const platform = node('platform');
    expect(platform.rowRange).toBeUndefined();
    for (const id of platform.childIds) expect(node(id).rowRange).toBeUndefined();
    const platformIds = new Set([...model.nodes.keys()].filter((id) => id.startsWith('platform')));
    const connected = model.edges.filter((e) => platformIds.has(e.from) || platformIds.has(e.to));
    const otherEnds = connected.map((e) => (platformIds.has(e.from) ? e.to : e.from));
    const rowsReached = new Set(otherEnds.map((id) => node(id).rowRange?.top));
    expect(rowsReached.size).toBeGreaterThanOrEqual(3);
  });

  it('the labels and presets of the example', () => {
    const model = parseExample();
    expect(model.nodes.size).toBe(45);
    expect(colorByOptions(model).map((option) => option.value)).toEqual([
      'preset:Exposure',
      'preset:Lifecycle',
      'owner',
      'status',
      'tech',
      'label:exposure',
      'metric:loc',
      'metric:churn',
    ]);

    // Every preset colours something, and every value it lists is on the map.
    expect(model.presets.map((preset) => preset.name)).toEqual(['Exposure', 'Lifecycle']);
    for (const preset of model.presets) {
      const present = labelValueCounts(model, preset.label).map((entry) => entry.value);
      expect(nodeColoring(model, `preset:${preset.name}`).byNode.size).toBeGreaterThan(0);
      for (const entry of preset.values) expect(present, preset.name).toContain(entry.value);
    }

    // A name, a hex, a pair and a generated colour, in the order the preset lists the values.
    const partner = { light: '#8e44ad', dark: '#8e44ad' };
    const exposure = nodeColoring(model, 'preset:Exposure');
    expect(exposure.legend).toEqual([
      { label: 'public', color: RED, kind: 'value', count: 13 },
      { label: 'partner', color: partner, kind: 'value', count: 1 },
      { label: 'staff', color: { light: '#0d6b5e', dark: '#5fd1bf' }, kind: 'value', count: 18 },
      { label: 'internal', color: BLUE, kind: 'value', count: 9 },
    ]);
    expect(exposure.withoutValue).toBe(4);
    expect(exposure.subtitle).toBe('by exposure');
    expect(exposure.description).toBe('Who can reach each part of the shop');

    const lifecycle = nodeColoring(model, 'preset:Lifecycle');
    expect(lifecycle.legend).toEqual([
      { label: 'planned', color: BLUE, kind: 'value', count: 8 },
      { label: 'live', color: GREEN, kind: 'value', count: 36 },
      { label: 'deprecated', color: OTHER_COLOR, kind: 'value', count: 1 },
    ]);
    expect(lifecycle.withoutValue).toBe(0);
    expect(lifecycle.subtitle).toBe('by Status');

    // The file meets the values in another order than the presets list them.
    expect(labelValueCounts(model, 'exposure').map((entry) => entry.value)).toEqual([
      'staff',
      'public',
      'partner',
      'internal',
    ]);
    expect(labelValueCounts(model, 'status').map((entry) => entry.value)).toEqual([
      'live',
      'deprecated',
      'planned',
    ]);

    // Without a preset the label takes the palette in the order of the file.
    const byLabel = nodeColoring(model, 'label:exposure');
    expect(byLabel.legend).toEqual([
      { label: 'staff', color: BLUE, kind: 'value', count: 18 },
      { label: 'public', color: ORANGE, kind: 'value', count: 13 },
      { label: 'partner', color: TEAL, kind: 'value', count: 1 },
      { label: 'internal', color: YELLOW, kind: 'value', count: 9 },
    ]);
    expect(byLabel.withoutValue).toBe(4);

    // Inherited from the domain, replaced on a component, absent where no group has the label.
    expect(exposure.byNode.get('storefront.gateway.api')).toBe(RED);
    expect(exposure.byNode.get('storefront.payment')).toEqual(partner);
    expect(exposure.byNode.has('platform.logging')).toBe(false);
  });

  it('the attributes keep their colours', () => {
    const model = parseExample();

    const owner = nodeColoring(model, 'owner');
    expect(owner.legend).toEqual([
      { label: 'Tooling team', color: BLUE, kind: 'value', count: 9 },
      { label: 'Shop IT', color: ORANGE, kind: 'value', count: 13 },
      { label: 'Web team', color: TEAL, kind: 'value', count: 14 },
      { label: 'Data team', color: YELLOW, kind: 'value', count: 9 },
    ]);
    expect(owner.withoutValue).toBe(0);
    expect(owner.byNode.get('backoffice.studio')).toBe(BLUE);
    expect(owner.byNode.get('data.ingest')).toBe(YELLOW);

    const status = nodeColoring(model, 'status');
    expect(status.legend).toEqual([
      { label: 'live', color: BLUE, kind: 'value', count: 36 },
      { label: 'deprecated', color: ORANGE, kind: 'value', count: 1 },
      { label: 'planned', color: TEAL, kind: 'value', count: 8 },
    ]);
    expect(status.withoutValue).toBe(0);

    const tech = nodeColoring(model, 'tech');
    expect(tech.legend.map((entry) => [entry.label, entry.count])).toEqual([
      ['C# / WPF', 6],
      ['TypeScript / Electron', 3],
      ['Java / Spring', 3],
      ['C++', 1],
      ['TypeScript / React', 10],
      ['Rust', 4],
      ['Python', 9],
    ]);
    expect(tech.legend.map((entry) => entry.color)).toEqual(CATEGORICAL_COLORS.slice(0, 7));
    expect(tech.withoutValue).toBe(9);
  });
});
