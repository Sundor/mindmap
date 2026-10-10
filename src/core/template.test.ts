// The template (examples/template/architecture.yaml and workitems.json): a short pair of files
// in which every key the viewer reads occurs once, with what it does. The tests fail when a key
// is added to a schema and not to the template.

import { describe, expect, it } from 'vitest';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';
import templateYaml from '../../examples/template/architecture.yaml?raw';
import templateJson from '../../examples/template/workitems.json?raw';
import {
  authoringHints,
  buildWorkItemOverlay,
  COLOR_NAMES,
  colorByOptions,
  EDGE_KINDS,
  FLOW_KINDS,
  nodeColoring,
  parseArchitecture,
  parseWorkItems,
  TEMPLATE_FILES,
  TEMPLATE_NOTE,
  WORK_ITEM_KEYS,
  WORK_ITEM_TYPES,
  workItemDiagnostics,
  type ArchitectureModel,
} from './index';
import {
  ComponentSchema,
  DomainSchema,
  EdgeSchema,
  FileSchema,
  FlowSchema,
  knownKeys,
  LinkSchema,
  PresetSchema,
  RowSchema,
  SubcomponentSchema,
} from './schema';

/** The longest the template may be and still be read at a glance: two screens. */
const MAX_LINES = 100;
const MAX_ITEMS = 6;

type Entry = Record<string, unknown>;
const isEntry = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const entries = (value: unknown): Entry[] => (Array.isArray(value) ? value.filter(isEntry) : []);
const keysOf = (list: readonly Entry[]): Set<string> =>
  new Set(list.flatMap((e) => Object.keys(e)));

const doc = parseDocument(templateYaml);
const plain: unknown = doc.toJS();
const root: Entry = isEntry(plain) ? plain : {};
const lines = templateYaml.split('\n');

/** The sections of the file that are lists of entries, each with the schema of an entry. */
const SECTIONS = {
  rows: RowSchema,
  edges: EdgeSchema,
  flows: FlowSchema,
  presets: PresetSchema,
} as const;

const domains = entries(root['domains']);
const components = domains.flatMap((domain) => entries(domain['components']));
const subcomponents = components.flatMap((component) => entries(component['subcomponents']));
const nodes = [...domains, ...components, ...subcomponents];

/** The mappings of the lists that `key` of each of `maps` holds (none where it holds no list). */
const mapsIn = (maps: readonly YAMLMap[], key: string): YAMLMap[] =>
  maps.flatMap((map) => {
    const list = map.get(key, true);
    return isSeq(list) ? list.items.filter((item): item is YAMLMap => isMap(item)) : [];
  });
/** The mapping the file is, as a list like the others: empty if the file is no mapping. */
const fileMaps: YAMLMap[] = isMap(doc.contents) ? [doc.contents] : [];
const domainMaps = mapsIn(fileMaps, 'domains');
const componentMaps = mapsIn(domainMaps, 'components');
const nodeMaps = [...domainMaps, ...componentMaps, ...mapsIn(componentMaps, 'subcomponents')];

/**
 * The keys that `maps` set on a line of their own (block style) which says, after a `#`, what
 * the key does. Read from the document, so that a key counts only where it is a key of these
 * mappings: the `label` of a link explains nothing about the `label` of a preset, and the name
 * of a label under `labels:` is no key of a node.
 */
function explainedKeys(maps: readonly YAMLMap[]): Set<string> {
  const found = new Set<string>();
  for (const map of maps) {
    for (const pair of map.items) {
      if (!isScalar(pair.key) || !pair.key.range) continue;
      const at = pair.key.range[0];
      const start = templateYaml.lastIndexOf('\n', at - 1) + 1;
      const end = templateYaml.indexOf('\n', at);
      const line = templateYaml.slice(start, end < 0 ? undefined : end);
      if (/^\s*(?:- )?$/.test(templateYaml.slice(start, at)) && /\s# \S/.test(line)) {
        found.add(String(pair.key.value));
      }
    }
  }
  return found;
}
const unexplained = (maps: readonly YAMLMap[], keys: readonly string[]): string[] => {
  const explained = explainedKeys(maps);
  return keys.filter((key) => !explained.has(key));
};

function parseTemplate(): ArchitectureModel {
  const result = parseArchitecture(templateYaml);
  if (!result.model) throw new Error('the template did not parse');
  return result.model;
}

describe('examples/template/architecture.yaml', () => {
  it('parses without an error or a warning, and no preset is left out', () => {
    const result = parseArchitecture(templateYaml);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.model?.presets).toHaveLength(entries(root['presets']).length);
  });

  it('has every key of the file, and this test knows every section', () => {
    expect(Object.keys(root).sort()).toEqual([...knownKeys(FileSchema)].sort());
    // A section added to the schema has to be added to SECTIONS (and to the template).
    expect([...knownKeys(FileSchema)].sort()).toEqual(
      ['version', 'domains', ...Object.keys(SECTIONS)].sort(),
    );
  });

  it('has every key of a row, an edge, a flow and a preset', () => {
    for (const [section, schema] of Object.entries(SECTIONS)) {
      const used = keysOf(entries(root[section]));
      expect([...used].sort(), section).toEqual([...knownKeys(schema)].sort());
    }
  });

  it('has every key of a node — over the three levels — and of a link', () => {
    const known = new Set([DomainSchema, ComponentSchema, SubcomponentSchema].flatMap(knownKeys));
    expect([...keysOf(nodes)].sort()).toEqual([...known].sort());
    expect(domains.length).toBeGreaterThan(0);
    expect(components.length).toBeGreaterThan(0);
    expect(subcomponents.length).toBeGreaterThan(0);
    const links = nodes.flatMap((node) => entries(node['links']));
    expect([...keysOf(links)].sort()).toEqual([...knownKeys(LinkSchema)].sort());
  });

  it('says on the line of every key what the viewer does with it — section by section', () => {
    expect(unexplained(fileMaps, knownKeys(FileSchema)), 'the file').toEqual([]);
    for (const [section, schema] of Object.entries(SECTIONS)) {
      expect(unexplained(mapsIn(fileMaps, section), knownKeys(schema)), section).toEqual([]);
    }
    const nodeKeys = [
      ...new Set([DomainSchema, ComponentSchema, SubcomponentSchema].flatMap(knownKeys)),
    ];
    expect(unexplained(nodeMaps, nodeKeys), 'nodes').toEqual([]);
    expect(unexplained(mapsIn(nodeMaps, 'links'), knownKeys(LinkSchema)), 'links').toEqual([]);
  });

  it('has every kind of edge and of flow, and every way to write a value', () => {
    const kindsOf = (section: string): unknown[] => entries(root[section]).map((e) => e['kind']);
    expect(new Set(kindsOf('edges'))).toEqual(new Set(EDGE_KINDS));
    expect(new Set(kindsOf('flows'))).toEqual(new Set(FLOW_KINDS));
    // A label as text and as a number.
    const labels = nodes.flatMap((node) =>
      isEntry(node['labels']) ? Object.values(node['labels']) : [],
    );
    expect(labels.some((value) => typeof value === 'string')).toBe(true);
    expect(labels.some((value) => typeof value === 'number')).toBe(true);
    // A colour as a palette name, as a hex colour, as a pair, and left out; a preset with no values.
    const presets = entries(root['presets']);
    const colors = presets.flatMap((preset) =>
      isEntry(preset['values']) ? Object.values(preset['values']) : [],
    );
    const paletteNames: readonly string[] = COLOR_NAMES;
    expect(colors.some((c) => typeof c === 'string' && paletteNames.includes(c))).toBe(true);
    expect(colors.some((c) => typeof c === 'string' && c.startsWith('#'))).toBe(true);
    expect(colors.some((c) => isEntry(c) && 'light' in c && 'dark' in c)).toBe(true);
    expect(colors.some((c) => c === null)).toBe(true);
    expect(presets.some((preset) => preset['values'] === undefined)).toBe(true);
    // One preset on a label of the file, one on an attribute.
    const labelOfPreset = presets.map((preset) => preset['label']);
    expect(labelOfPreset).toContain('owner');
    expect(labelOfPreset.some((label) => label !== 'owner')).toBe(true);
    // Every name of the palette is named in the file, as a word of its own ("red" is also in
    // "Required").
    const words = new Set(templateYaml.split(/[^a-z]+/i));
    for (const name of [...COLOR_NAMES, 'grey']) expect(words, name).toContain(name);
  });

  it('shows what it explains: rows used and spanned, a label inherited and replaced', () => {
    const model = parseTemplate();
    const rowsUsed = new Set([...model.nodes.values()].map((node) => node.effectiveRow));
    for (const row of model.rows) expect(rowsUsed, row.id).toContain(row.id);
    expect(
      [...model.nodes.values()].some(
        (node) => node.rowRange && node.rowRange.top !== node.rowRange.bottom,
      ),
    ).toBe(true);
    const zones = nodeColoring(model, 'preset:Zones');
    expect(zones.legend.map((entry) => entry.label)).toEqual(['public', 'payment', 'internal']);
    expect(zones.withoutValue).toBe(0);
    expect(colorByOptions(model).map((option) => option.value)).toEqual([
      'preset:Zones',
      'preset:Teams',
      'owner',
      'status',
      'tech',
      'label:zone',
      'label:tier',
      'metric:loc',
    ]);
    // Every flow names edges, and one names a node besides.
    expect(model.flows.every((flow) => flow.edgeIds.length > 0)).toBe(true);
    expect(model.flows.some((flow) => flow.nodeIds.length > 0)).toBe(true);
  });

  it('stays short: two screens, and no line longer than the editor is wide', () => {
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(lines.filter((line) => line.length > 100)).toEqual([]);
    expect(templateYaml.endsWith('\n')).toBe(true);
    expect(templateYaml).not.toContain('\r');
    expect(templateYaml).not.toContain('\t');
  });
});

describe('examples/template/workitems.json', () => {
  const result = parseWorkItems(templateJson);
  const raw: unknown = JSON.parse(templateJson);
  const rawItems = entries(isEntry(raw) ? raw['items'] : undefined);

  it('parses without an error or a warning, every item kept', () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(rawItems.length);
    expect(rawItems.length).toBeLessThanOrEqual(MAX_ITEMS);
    expect(isEntry(raw) ? Object.keys(raw).sort() : []).toEqual(['items', 'version']);
  });

  it('has every key of an item and every type', () => {
    expect([...keysOf(rawItems)].sort()).toEqual([...WORK_ITEM_KEYS].sort());
    // One item shows them all together.
    expect(rawItems.some((item) => WORK_ITEM_KEYS.every((key) => key in item))).toBe(true);
    expect(new Set(result.items.map((item) => item.type))).toEqual(new Set(WORK_ITEM_TYPES));
  });

  it('belongs to the template structure: every comp: tag names one of its nodes', () => {
    const model = parseTemplate();
    const tagged = result.items.flatMap((item) => item.componentIds);
    expect(tagged.length).toBeGreaterThan(0);
    for (const id of tagged) expect(model.nodes.has(id), id).toBe(true);
    // A node of every level carries work.
    expect(new Set(tagged.map((id) => model.nodes.get(id)?.level))).toEqual(new Set([0, 1, 2]));
  });

  it('shows what the viewer tells apart', () => {
    const closed = ['closed', 'done', 'resolved', 'removed'];
    const isClosed = (state: string): boolean => closed.includes(state.toLowerCase());
    expect(result.items.some((item) => isClosed(item.state))).toBe(true);
    expect(result.items.some((item) => !isClosed(item.state))).toBe(true);
    // A plain tag beside the comp: tags; an item on two nodes; a task under its parent.
    expect(result.items.some((item) => item.tags.length > 0)).toBe(true);
    expect(result.items.some((item) => item.componentIds.length > 1)).toBe(true);
    const task = result.items.find((item) => item.type === 'Task');
    expect(task?.parentId).toBeDefined();
    expect(task?.componentIds).toEqual([]);
    // Fields: a text and a number. An iteration with a level above the sprint.
    const fields = result.items.flatMap((item) => Object.values(item.fields ?? {}));
    expect(fields.some((value) => typeof value === 'string')).toBe(true);
    expect(fields.some((value) => typeof value === 'number')).toBe(true);
    expect(result.items.some((item) => (item.iteration ?? '').split('\\').length >= 3)).toBe(true);
  });

  it('opens without a complaint of the viewer: every item tagged, every box connected', () => {
    const model = parseTemplate();
    // What the app adds to the parser's diagnostics (tags naming no node, items without a tag).
    expect(workItemDiagnostics(model, result.items, 'workitems.json')).toEqual([]);
    // The hints for the author: descriptions are left to the copy; nothing else is said.
    const hints = authoringHints(model, buildWorkItemOverlay(model, result.items));
    expect(hints.map((hint) => hint.kind)).toEqual(['description']);
  });
});

describe('what the viewer says about the template', () => {
  it('the note names the files the build delivers', () => {
    expect([...TEMPLATE_FILES]).toEqual(['template/architecture.yaml', 'template/workitems.json']);
    for (const file of TEMPLATE_FILES) expect(TEMPLATE_NOTE).toContain(file);
    // A sentence, not an address: the viewer names the files; it neither links to them nor
    // fetches them.
    expect(TEMPLATE_NOTE).not.toMatch(/[a-z]+:\/\//i);
  });
});
