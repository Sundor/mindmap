// parseArchitecture: YAML text → validated ArchitectureModel + diagnostics.
//
// Never throws. All problems in the file are collected in one pass: shape problems (zod), ID rules,
// references, rows. Each malformed entry is salvaged as far as possible (its ID and children are
// still registered) so one mistake does not cascade into spurious "unknown ID" errors elsewhere.

import { isAlias, isMap, isNode, isScalar, LineCounter, parseDocument, type Document } from 'yaml';
import type { z } from './zod';
import { COLOR_NAMES, colorFromFile, GREY_NAMES } from './colorBy';
import { formatPath, type Diagnostic, type DocPath, type Severity } from './diagnostics';
import { didYouMean, ID_RULE, isValidId, isValidSegment, suggest } from './ids';
import {
  EDGE_KINDS,
  FLOW_KINDS,
  isEdgeKind,
  isNodeAttribute,
  LABEL_NAME_MAX,
  labelNames,
  labelValueCounts,
  NODE_ATTRIBUTES,
  NODE_LEVEL_NAMES,
  PRESET_NAME_MAX,
  type ArchEdge,
  type ArchFlow,
  type ArchitectureModel,
  type ArchLink,
  type ArchNode,
  type ArchRow,
  type ColorPreset,
  type NodeLevel,
  type PresetValue,
  type SchemeColor,
} from './model';
import { rowRanges } from './rows';
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
import { isWebUrl } from './text';

export interface ParseOptions {
  /** File name or path shown with each diagnostic (e.g. `architecture.yaml`). */
  readonly sourceName?: string;
}

export interface ParseResult {
  /** The validated model; null if and only if `errors` is non-empty. */
  readonly model: ArchitectureModel | null;
  readonly errors: Diagnostic[];
  readonly warnings: Diagnostic[];
}

/** Limits YAML alias expansion ("billion laughs"). */
const MAX_ALIAS_COUNT = 100;

const CHILD_KEYS = ['components', 'subcomponents'] as const;
const NODE_SCHEMAS = [DomainSchema, ComponentSchema, SubcomponentSchema] as const;
/** Keys that hold lists of nodes; found at the wrong level, they would silently drop nodes. */
const NODE_LIST_KEYS: readonly string[] = ['domains', ...CHILD_KEYS];
/** Where each level (file, domain, component, subcomponent) keeps its nodes. */
const WHERE_NODES_GO = [
  'the file lists its domains under "domains"',
  'a domain lists its children under "components"',
  'a component lists its children under "subcomponents"',
  'a subcomponent has no children',
] as const;

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;
type PlainObject = Record<string, unknown>;

interface NodeRecord {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  status?: string;
  tech?: string;
  links?: ArchLink[];
  metrics?: Map<string, number>;
  labels?: Map<string, string>;
  row?: string;
  level: NodeLevel;
  parentId?: string;
  childIds: string[];
  /** Effective row; for a row that conflicts with an ancestor, the ancestor's row is kept. */
  effectiveRow?: string;
  path: DocPath;
}

/** What a child needs to know about its parent while walking the tree. */
interface ParentInfo {
  /** Undefined when the parent has no usable ID. */
  readonly record?: NodeRecord;
  readonly id?: string;
  readonly level: NodeLevel;
  readonly effectiveRow?: string;
  /** ID of the node that set `effectiveRow` (the parent itself or one of its ancestors). */
  readonly effectiveRowFrom?: string;
}

/**
 * Where each label name was first written, by the name in lower case, and the other spellings
 * that were reported already: two names that differ only in letter case are two labels, and
 * most often a slip — said once per spelling, not once per node.
 */
type LabelUse = Map<
  string,
  { readonly name: string; readonly path: DocPath; readonly reported: Set<string> }
>;

interface Located {
  line: number;
  column: number;
}

class Collector {
  readonly errors: Diagnostic[] = [];
  readonly warnings: Diagnostic[] = [];
  doc: Document | undefined;
  private readonly lineCounter: LineCounter;
  private readonly source: string | undefined;

  constructor(lineCounter: LineCounter, source: string | undefined) {
    this.lineCounter = lineCounter;
    this.source = source;
  }

  error(path: DocPath, message: string, atKey = false): void {
    this.add('error', path, message, atKey);
  }

  warning(path: DocPath, message: string, atKey = false): void {
    this.add('warning', path, message, atKey);
  }

  /** Adds a diagnostic with an explicit position (YAML syntax errors). */
  addAt(severity: Severity, message: string, pos: Located | undefined): void {
    this.push({ severity, path: '', message, ...pos });
  }

  private add(severity: Severity, path: DocPath, message: string, atKey: boolean): void {
    this.push({ severity, path: formatPath(path), message, ...this.locate(path, atKey) });
  }

  private push(d: Omit<Diagnostic, 'source'>): void {
    const withSource: Diagnostic = this.source === undefined ? d : { ...d, source: this.source };
    (d.severity === 'error' ? this.errors : this.warnings).push(withSource);
  }

  /** Line/column of the YAML node at `path` (or its key), else of its nearest existing ancestor. */
  private locate(path: DocPath, atKey: boolean): Located | undefined {
    const doc = this.doc;
    if (!doc) return undefined;
    const nodeAt = (p: DocPath): unknown => (p.length === 0 ? doc.contents : doc.getIn(p, true));
    if (atKey && path.length > 0) {
      const parent = nodeAt(path.slice(0, -1));
      const key = path[path.length - 1];
      if (isMap(parent)) {
        // Compare as strings: a YAML key such as `1` is a number, but Object.keys() yields "1".
        const pair = parent.items.find(
          (item) => isScalar(item.key) && String(item.key.value) === String(key),
        );
        const range = isNode(pair?.key) ? pair.key.range : undefined;
        if (range) return this.position(range[0]);
      }
    }
    for (let p = path; ; p = p.slice(0, -1)) {
      const node = nodeAt(p);
      if (isNode(node) && node.range) return this.position(node.range[0]);
      if (p.length === 0) return undefined;
    }
  }

  private position(offset: number): Located {
    const { line, col } = this.lineCounter.linePos(offset);
    return { line, column: col };
  }
}

/**
 * Parses and validates an architecture file. Never throws: every problem, including YAML syntax
 * errors and unexpected input, is reported as a diagnostic.
 */
export function parseArchitecture(yamlText: string, opts: ParseOptions = {}): ParseResult {
  const lineCounter = new LineCounter();
  const out = new Collector(lineCounter, opts.sourceName);
  let model: ArchitectureModel | null = null;
  try {
    model = run(yamlText, lineCounter, out);
  } catch (err) {
    out.error([], `Unexpected problem while reading the file: ${errorText(err)}`);
  }
  return {
    model: out.errors.length === 0 ? model : null,
    errors: byPosition(out.errors),
    warnings: byPosition(out.warnings),
  };
}

function run(
  yamlText: unknown,
  lineCounter: LineCounter,
  out: Collector,
): ArchitectureModel | null {
  if (typeof yamlText !== 'string') {
    out.error([], `Expected YAML text but got ${describeValue(yamlText)}`);
    return null;
  }
  const doc = parseDocument(yamlText, { lineCounter, prettyErrors: true });
  out.doc = doc;
  for (const e of doc.errors) {
    // The library's own text for this one is advice to its caller ("please use
    // YAML.parseAllDocuments()"), not to the author of the file.
    const message = e.code === 'MULTIPLE_DOCS' ? MULTIPLE_DOCS_MESSAGE : yamlMessage(e.message);
    out.addAt('error', message, linePos(e.linePos));
  }
  for (const w of doc.warnings) out.addAt('warning', yamlMessage(w.message), linePos(w.linePos));
  if (doc.errors.length > 0) return null;

  const root: unknown = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  if (root === null || root === undefined) {
    out.error([], 'The file is empty; expected a mapping with "version: 1" and "domains:"');
    return null;
  }
  if (!isPlainObject(root)) {
    out.error(
      [],
      `The top level must be a mapping with "version: 1" and "domains:", but got ${describeValue(root)}`,
    );
    return null;
  }

  checkEntry(out, FileSchema, root, [], 'the file', WHERE_NODES_GO[0]);
  const rows = readRows(out, root);
  const nodes = new Map<string, NodeRecord>();
  const rootIds: string[] = [];
  const labelUse: LabelUse = new Map();
  const domains = listAt(root, 'domains');
  domains.forEach((raw, i) => {
    const record = walkNode(out, raw, ['domains', i], 0, undefined, nodes, rows, labelUse);
    if (record) rootIds.push(record.id);
  });
  const edges = readEdges(out, root, nodes);
  const flows = readFlows(out, root, nodes, edges);
  const presets = readPresets(out, root, nodes);

  if (out.errors.length > 0) return null;
  return buildModel(rows.list, nodes, rootIds, edges, flows, presets);
}

// ---------------------------------------------------------------------------------------------
// Rows

interface RowsInfo {
  /** Whether the file has a `rows:` key at all. */
  readonly defined: boolean;
  readonly list: ArchRow[];
  readonly index: Map<string, number>;
}

function readRows(out: Collector, root: PlainObject): RowsInfo {
  const list: ArchRow[] = [];
  const index = new Map<string, number>();
  const firstPath = new Map<string, DocPath>();
  listAt(root, 'rows').forEach((raw, i) => {
    const path: DocPath = ['rows', i];
    const obj = isPlainObject(raw) ? raw : {};
    const id = stringField(obj, 'id');
    const data = checkEntry(out, RowSchema, raw, path, id === undefined ? 'row' : `row "${id}"`);
    if (id === undefined) return;
    if (!isValidSegment(id)) {
      out.error(
        [...path, 'id'],
        `Invalid row ID "${id}": use a single segment of lowercase letters and digits, optionally joined by '-' or '_'`,
      );
    }
    const first = firstPath.get(id);
    if (first) {
      out.error(
        [...path, 'id'],
        `Duplicate row ID "${id}" (first defined at ${formatPath(first)})`,
      );
      return;
    }
    firstPath.set(id, path);
    index.set(id, list.length);
    list.push(
      compact({
        id,
        name: data?.name ?? stringField(obj, 'name') ?? id,
        description: data?.description,
      }),
    );
  });
  // An empty `rows:` (null) counts as no rows section, like any other empty optional key.
  return { defined: root['rows'] !== undefined && root['rows'] !== null, list, index };
}

// ---------------------------------------------------------------------------------------------
// Nodes

function walkNode(
  out: Collector,
  raw: unknown,
  path: DocPath,
  level: NodeLevel,
  parent: ParentInfo | undefined,
  nodes: Map<string, NodeRecord>,
  rows: RowsInfo,
  labelUse: LabelUse,
): NodeRecord | undefined {
  const levelName = NODE_LEVEL_NAMES[level];
  const obj = isPlainObject(raw) ? raw : {};
  const id = stringField(obj, 'id');
  const label = id === undefined ? levelName : `${levelName} "${id}"`;
  const data = checkEntry(out, NODE_SCHEMAS[level], raw, path, label, WHERE_NODES_GO[level + 1]);

  let record: NodeRecord | undefined;
  if (id !== undefined) {
    checkNodeId(out, id, path, level, parent);
    const first = nodes.get(id);
    if (first) {
      out.error(
        [...path, 'id'],
        `Duplicate node ID "${id}" (first defined at ${formatPath(first.path)})`,
      );
    } else {
      record = {
        id,
        name: data?.name ?? stringField(obj, 'name') ?? id,
        level,
        childIds: [],
        path,
      };
      const description = stringField(obj, 'description');
      if (description !== undefined) record.description = description;
      for (const key of NODE_ATTRIBUTES) {
        const value = stringField(obj, key)?.trim();
        if (value !== undefined && value !== '') record[key] = value;
      }
      const links = readLinks(out, obj, path, label);
      if (links.length > 0) record.links = links;
      const metrics = readMetrics(out, obj, path, label);
      if (metrics.size > 0) record.metrics = metrics;
      const labels = readLabels(out, obj, path, label, levelName, labelUse);
      if (labels.size > 0) record.labels = labels;
      if (parent?.id !== undefined) record.parentId = parent.id;
      nodes.set(id, record);
      parent?.record?.childIds.push(id);
    }
  }

  // Rows: own row must exist and agree with any row inherited from an ancestor.
  const row = stringField(obj, 'row');
  let effectiveRow = parent?.effectiveRow;
  let effectiveRowFrom = parent?.effectiveRowFrom;
  if (row !== undefined) {
    const rowPath = [...path, 'row'];
    if (!rows.defined) {
      out.error(
        rowPath,
        `${capitalize(label)} is assigned to row "${row}", but the file has no top-level "rows:" section`,
      );
    } else if (!rows.index.has(row)) {
      const known = [...rows.index.keys()];
      out.error(
        rowPath,
        `Unknown row "${row}" on ${label}${didYouMean(row, known)} (defined rows: ${known.join(', ') || 'none'})`,
      );
    } else if (effectiveRow !== undefined && effectiveRow !== row) {
      out.error(
        rowPath,
        `${capitalize(label)} is assigned to row "${row}", but "${effectiveRowFrom ?? '?'}" puts it in row "${effectiveRow}"; a group with a row keeps all its contents in that row`,
      );
    } else if (effectiveRow === undefined) {
      effectiveRow = row;
      effectiveRowFrom = id;
    }
    if (record) record.row = row;
  }
  if (record && effectiveRow !== undefined) record.effectiveRow = effectiveRow;

  // Children
  const childKey = level === 2 ? undefined : CHILD_KEYS[level];
  if (childKey !== undefined) {
    const childInfo: ParentInfo = {
      record,
      id,
      level,
      effectiveRow,
      effectiveRowFrom,
    };
    listAt(obj, childKey).forEach((child, i) => {
      walkNode(
        out,
        child,
        [...path, childKey, i],
        (level + 1) as NodeLevel,
        childInfo,
        nodes,
        rows,
        labelUse,
      );
    });
  }
  return record;
}

/**
 * A node's `links`: entries with an http(s) `url` and an optional `label` (the URL when absent).
 * The shape of an entry is checked like any other; an address that is not http(s) is a warning
 * and the link is left out — the file is not trusted, and a link is opened by a click.
 */
function readLinks(out: Collector, obj: PlainObject, path: DocPath, label: string): ArchLink[] {
  const links: ArchLink[] = [];
  listAt(obj, 'links').forEach((raw, i) => {
    const linkPath: DocPath = [...path, 'links', i];
    const data = checkEntry(out, LinkSchema, raw, linkPath, `link ${i + 1} of ${label}`);
    if (!data) return;
    const url = data.url.trim();
    if (!isWebUrl(url)) {
      out.warning(
        [...linkPath, 'url'],
        `Link ${JSON.stringify(url)} of ${label} is not an http(s) address and is left out`,
      );
      return;
    }
    const text = data.label?.trim();
    links.push({ label: text === undefined || text === '' ? url : text, url });
  });
  return links;
}

/** A node's `metrics`: finite numbers by name. Anything else is an error. */
function readMetrics(
  out: Collector,
  obj: PlainObject,
  path: DocPath,
  label: string,
): Map<string, number> {
  const metrics = new Map<string, number>();
  const raw = obj['metrics'];
  if (!isPlainObject(raw)) return metrics;
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (name.trim() !== '') metrics.set(name.trim(), value);
    } else {
      out.error(
        [...path, 'metrics', name],
        `Metric "${name}" of ${label} must be a number, but got ${describeValue(value)}`,
      );
    }
  }
  return metrics;
}

/**
 * A node's `labels`: values by name, in file order. A value is text, or a number or true/false,
 * which is kept as the file writes it (`1.10` stays "1.10"). An entry without a value, or with
 * an empty text, is the same as no entry. A value that is a list or a mapping, an empty or
 * overlong name and the name of an attribute (in any letter case) are errors: a label that
 * vanished would give a wrong picture.
 */
function readLabels(
  out: Collector,
  obj: PlainObject,
  path: DocPath,
  label: string,
  levelName: string,
  labelUse: LabelUse,
): Map<string, string> {
  const labels = new Map<string, string>();
  const raw = obj['labels'];
  if (!isPlainObject(raw)) return labels;
  for (const entry of entriesInFileOrder(out.doc, [...path, 'labels'], raw)) {
    const name = entry.key.trim();
    const at: DocPath = [...path, 'labels', entry.pathKey];
    if (name === '') {
      out.error(at, `A label of ${label} has an empty name`, true);
      continue;
    }
    if (name.length > LABEL_NAME_MAX) {
      out.error(
        at,
        `Label name "${truncate(name, 40)}" of ${label} is longer than ${LABEL_NAME_MAX} characters`,
        true,
      );
      continue;
    }
    // In any letter case: a label "Owner" would stand beside the attribute as a second "Owner".
    const attribute = name.toLowerCase();
    if (isNodeAttribute(attribute)) {
      out.error(
        at,
        `Label "${name}" of ${label} is a key of its own: write "${attribute}:" on the ${levelName} itself, not under "labels"`,
        true,
      );
      continue;
    }
    const { value } = entry;
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      out.error(
        at,
        `Label "${name}" of ${label} must be text, a number or true/false, but got ${describeValue(value)}`,
      );
      continue;
    }
    const text = (typeof value === 'string' ? value : (entry.written ?? String(value))).trim();
    if (text === '') continue;
    const first = labelUse.get(name.toLowerCase());
    if (!first) labelUse.set(name.toLowerCase(), { name, path: at, reported: new Set() });
    else if (first.name !== name && !first.reported.has(name)) {
      first.reported.add(name);
      out.warning(
        at,
        `Label "${name}" of ${label} differs only in letter case from "${first.name}" (first used at ${formatPath(first.path)}); they are two labels`,
        true,
      );
    }
    if (labels.has(name)) {
      out.warning(
        at,
        `Label "${name}" of ${label} is written twice; the first value is kept`,
        true,
      );
      continue;
    }
    labels.set(name, text);
  }
  return labels;
}

function checkNodeId(
  out: Collector,
  id: string,
  path: DocPath,
  level: NodeLevel,
  parent: ParentInfo | undefined,
): void {
  const idPath = [...path, 'id'];
  const levelName = NODE_LEVEL_NAMES[level];
  if (!isValidId(id)) {
    out.error(idPath, `Invalid ${levelName} ID "${id}": use ${ID_RULE}`);
    return;
  }
  if (level === 0) {
    if (id.includes('.')) {
      out.error(idPath, `Domain ID "${id}" must be a single segment (no dots)`);
    }
    return;
  }
  if (parent?.id === undefined) return;
  const parentName = NODE_LEVEL_NAMES[parent.level];
  const prefix = `${parent.id}.`;
  if (!id.startsWith(prefix)) {
    const lastSegment = id.slice(id.lastIndexOf('.') + 1);
    out.error(
      idPath,
      `${capitalize(levelName)} ID "${id}" must start with its ${parentName}'s ID "${parent.id}" followed by a dot (e.g. "${prefix}${lastSegment}")`,
    );
  } else if (id.slice(prefix.length).includes('.')) {
    out.error(
      idPath,
      `${capitalize(levelName)} ID "${id}" has too many segments: expected "${prefix}<name>" with exactly one segment after its ${parentName}'s ID`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Edges

function readEdges(
  out: Collector,
  root: PlainObject,
  nodes: ReadonlyMap<string, NodeRecord>,
): ArchEdge[] {
  const edges: ArchEdge[] = [];
  const firstById = new Map<string, DocPath>();
  const firstByKey = new Map<string, string>();
  listAt(root, 'edges').forEach((raw, i) => {
    const path: DocPath = ['edges', i];
    const obj = isPlainObject(raw) ? raw : {};
    const id = stringField(obj, 'id');
    const label = id === undefined ? `edge ${formatPath(path)}` : `edge "${id}"`;
    const data = checkEntry(out, EdgeSchema, raw, path, label);

    if (id !== undefined) {
      if (!isValidId(id)) out.error([...path, 'id'], `Invalid edge ID "${id}": use ${ID_RULE}`);
      const first = firstById.get(id);
      if (first) {
        out.error(
          [...path, 'id'],
          `Duplicate edge ID "${id}" (first defined at ${formatPath(first)})`,
        );
      } else {
        firstById.set(id, path);
      }
    }

    const from = stringField(obj, 'from');
    const to = stringField(obj, 'to');
    for (const [end, ref] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (ref !== undefined && !nodes.has(ref)) {
        out.error(
          [...path, end],
          `${capitalize(label)}: "${end}" refers to unknown node "${ref}"${didYouMean(ref, nodes.keys())}`,
        );
      }
    }
    if (from !== undefined && from === to) {
      out.error(
        [...path, 'to'],
        `${capitalize(label)} connects "${from}" to itself; self-edges are not allowed`,
      );
    }

    const kind = obj['kind'];
    if (from !== undefined && to !== undefined && isEdgeKind(kind)) {
      const key = `${from}\u0000${to}\u0000${kind}`;
      const first = firstByKey.get(key);
      if (first !== undefined) {
        out.warning(
          path,
          `${capitalize(label)} duplicates ${first} (same from "${from}", to "${to}" and kind "${kind}")`,
        );
      } else {
        firstByKey.set(key, label);
      }
    }

    if (data) edges.push(compact({ ...data }));
  });
  return edges;
}

// ---------------------------------------------------------------------------------------------
// Flows

/**
 * The `flows:` section: each names its edges (its steps, in order) and any further nodes. An
 * edge or node that does not exist is an error; a flow that names nothing is a warning (it
 * would highlight nothing). Flow IDs follow the ID rule and are a namespace of their own.
 */
function readFlows(
  out: Collector,
  root: PlainObject,
  nodes: ReadonlyMap<string, NodeRecord>,
  edges: readonly ArchEdge[],
): ArchFlow[] {
  const flows: ArchFlow[] = [];
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const firstById = new Map<string, DocPath>();
  listAt(root, 'flows').forEach((raw, i) => {
    const path: DocPath = ['flows', i];
    const obj = isPlainObject(raw) ? raw : {};
    const id = stringField(obj, 'id');
    const label = id === undefined ? `flow ${formatPath(path)}` : `flow "${id}"`;
    const data = checkEntry(out, FlowSchema, raw, path, label);

    if (id !== undefined) {
      if (!isValidId(id)) out.error([...path, 'id'], `Invalid flow ID "${id}": use ${ID_RULE}`);
      const first = firstById.get(id);
      if (first) {
        out.error(
          [...path, 'id'],
          `Duplicate flow ID "${id}" (first defined at ${formatPath(first)})`,
        );
      } else {
        firstById.set(id, path);
      }
    }

    const refs = (key: 'edges' | 'nodes', known: (ref: string) => boolean, what: string) => {
      const ids: string[] = [];
      listAt(obj, key).forEach((entry, j) => {
        const refPath: DocPath = [...path, key, j];
        if (typeof entry !== 'string') {
          out.error(
            refPath,
            `${capitalize(label)}: entry ${j + 1} of "${key}" must be the ID of a${what === 'edge' ? 'n' : ''} ${what}, but got ${describeValue(entry)}`,
          );
          return;
        }
        if (!known(entry)) {
          const candidates = key === 'edges' ? edgeIds : nodes.keys();
          out.error(
            refPath,
            `${capitalize(label)} refers to unknown ${what} "${entry}"${didYouMean(entry, candidates)}`,
          );
          return;
        }
        ids.push(entry);
      });
      return ids;
    };
    const flowEdges = refs('edges', (ref) => edgeIds.has(ref), 'edge');
    const flowNodes = refs('nodes', (ref) => nodes.has(ref), 'node');
    if (listAt(obj, 'edges').length === 0 && listAt(obj, 'nodes').length === 0) {
      out.warning(
        path,
        `${capitalize(label)} names no edges and no nodes, so it highlights nothing`,
      );
    }

    if (data && id !== undefined) {
      flows.push(
        compact({
          id,
          name: data.name,
          kind: data.kind ?? 'workflow',
          description: data.description,
          edgeIds: flowEdges,
          nodeIds: [...new Set(flowNodes)],
        }),
      );
    }
  });
  return flows;
}

// ---------------------------------------------------------------------------------------------
// Colour presets

/** How a message says what a colour may be. */
const COLOR_HELP = `Use ${[...COLOR_NAMES, GREY_NAMES[0]].join(', ')}, or a hex colour in quotes such as '#1baf7a'`;
/** What happens to a value whose colour could not be read. */
const COLOR_FALLBACK = 'The next free colour is used';
/**
 * The hex colour a comment was meant as: an unquoted `#1baf7a` after a key is a comment to YAML.
 * The comment must begin, right after its `#`, with three or six hex digits, and either end
 * there or have a numeral among them — `#fff` and `#1baf7a the green` are colours, `#decade of
 * work` and `# fff` (a space first) are comments. Only the first line counts: the YAML library
 * joins the comment lines that follow directly to the comment of an empty value.
 */
function hexInComment(comment: string | undefined): string | undefined {
  const onTheLine = (comment ?? '').split(/\r?\n/, 1)[0] ?? '';
  const match = /^([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])(.*)$/i.exec(onTheLine);
  const hex = match?.[1];
  if (hex === undefined) return undefined;
  return (match?.[2] ?? '').trim() === '' || /[0-9]/.test(hex) ? hex : undefined;
}

/**
 * True when `a` and `b` are the same text around different numerals: two members of a series
 * (tier-2 and tier-9, 1.10 and 1.11), which resemble each other without one being a slip.
 */
function sameSeries(a: string, b: string): boolean {
  const frame = (text: string): string => text.toLowerCase().replace(/[0-9]+/g, '#');
  const numerals = (text: string): string => (text.match(/[0-9]+/g) ?? []).join(' ');
  return frame(a) === frame(b) && numerals(a) !== numerals(b);
}

/**
 * The edit distance of `a` and `b` as `editDistance` counts it when it is at most `limit`,
 * undefined when it is more. What the two texts begin and end with alike costs nothing and is
 * left out. Of the rest, each row is filled only as far from the diagonal as `limit` (beginnings
 * whose lengths differ by more are further apart than that), and a row with no cell within the
 * limit ends the comparison: the cost grows with the length of the texts, not with its square.
 */
function distanceWithin(a: string, b: string, limit: number): number | undefined {
  if (Math.abs(a.length - b.length) > limit) return undefined;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let rows = a.length - start;
  let columns = b.length - start;
  while (rows > 0 && columns > 0 && a[start + rows - 1] === b[start + columns - 1]) {
    rows--;
    columns--;
  }
  const beyond = limit + 1;
  const width = 2 * limit + 1;
  // Cell k of row i: the distance between the first i letters of the rest of `a` and the first
  // j of the rest of `b`, j = i - limit + k. Three rows are kept: i - 2, i - 1 and i.
  let before = new Array<number>(width).fill(beyond);
  let above = new Array<number>(width).fill(beyond);
  let row = new Array<number>(width).fill(beyond);
  for (let j = 0; j <= limit; j++) above[limit + j] = j;
  for (let i = 1; i <= rows; i++) {
    let least = beyond;
    for (let k = 0; k < width; k++) {
      const j = i - limit + k;
      let best = beyond;
      if (j === 0) {
        best = i;
      } else if (j > 0 && j <= columns) {
        const inA = start + i - 1;
        const inB = start + j - 1;
        best = Math.min(
          (above[k + 1] ?? beyond) + 1,
          (row[k - 1] ?? beyond) + 1,
          (above[k] ?? beyond) + (a[inA] === b[inB] ? 0 : 1),
        );
        if (i > 1 && j > 1 && a[inA] === b[inB - 1] && a[inA - 1] === b[inB]) {
          best = Math.min(best, (before[k] ?? beyond) + 1);
        }
      }
      row[k] = Math.min(best, beyond);
      least = Math.min(least, best);
    }
    if (least > limit) return undefined;
    [before, above, row] = [above, row, before];
  }
  const distance = above[columns - rows + limit] ?? beyond;
  return distance > limit ? undefined : distance;
}

/**
 * The value among `candidates` that `value`, which no node has, was probably meant as: what
 * `suggest` answers once the members of the series of `value` are set aside, for texts that may
 * be long and many. A label has no limit on the length or the number of its values, and
 * `suggest` fills a table of one length by the other for every pair.
 */
function nearMiss(value: string, candidates: readonly string[]): string | undefined {
  const needle = value.toLowerCase();
  const maxDistance = Math.min(3, Math.floor(needle.length / 3));
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const hay = candidate.toLowerCase();
    const score =
      distanceWithin(needle, hay, maxDistance) ??
      (hay.slice(hay.lastIndexOf('.') + 1) === needle ? maxDistance + 0.5 : Infinity);
    if (score < bestScore && !sameSeries(candidate, value)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** Why `value` is no colour, for the value `what` names; a whole sentence. */
function colorProblem(value: unknown, what: string): string {
  if (typeof value === 'string') {
    const names = [...COLOR_NAMES, ...GREY_NAMES];
    const meant = suggest(value.trim().toLowerCase(), names);
    return `Unknown colour ${JSON.stringify(truncate(value, 40))} for ${what}${meant === undefined ? '.' : `; did you mean "${meant}"?`}`;
  }
  if (isPlainObject(value)) {
    return `The colour for ${what} must give "light" and "dark", each a hex colour in quotes, and nothing else.`;
  }
  return `The colour for ${what} must be a colour name or a hex colour in quotes, but got ${describeValue(value)}.`;
}

/**
 * The `presets:` section: named colourings of the boxes by a label. Each has a name of its own
 * (a name used twice is an error) and names the label it reads — a label some node carries, or
 * owner, status or tech; one that no node has is a warning and the preset is left out, since it
 * would colour nothing. `values` lists values with their colours, in the order of the legend.
 * What only costs a colour is a warning, and the map is drawn: a colour that is none (the value
 * then takes the next free colour of the palette), and a listed value that no node has but that
 * resembles one a node has.
 */
function readPresets(
  out: Collector,
  root: PlainObject,
  nodes: ReadonlyMap<string, NodeRecord>,
): ColorPreset[] {
  const presets: ColorPreset[] = [];
  const firstByName = new Map<string, DocPath>();
  const model = { nodes };
  const known: string[] = [
    ...NODE_ATTRIBUTES.filter((key) => [...nodes.values()].some((node) => node[key] !== undefined)),
    ...labelNames(model),
  ];
  listAt(root, 'presets').forEach((raw, i) => {
    const path: DocPath = ['presets', i];
    const obj = isPlainObject(raw) ? raw : {};
    const written = stringField(obj, 'name')?.trim();
    const what =
      written === undefined || written === ''
        ? `preset ${formatPath(path)}`
        : `preset "${truncate(written, 40)}"`;
    const data = checkEntry(out, PresetSchema, raw, path, what);

    let usable = true;
    if (written !== undefined && written !== '') {
      if (written.length > PRESET_NAME_MAX) {
        out.error(
          [...path, 'name'],
          `"name" of ${what} is longer than ${PRESET_NAME_MAX} characters`,
        );
        usable = false;
      }
      const first = firstByName.get(written);
      if (first) {
        out.error(
          [...path, 'name'],
          `Duplicate preset name "${truncate(written, 40)}" (first defined at ${formatPath(first)})`,
        );
        usable = false;
      } else {
        firstByName.set(written, path);
      }
    }
    if (!data || !usable) return;

    const label = data.label;
    if (!known.includes(label)) {
      out.warning(
        [...path, 'label'],
        `${capitalize(what)} colours by label "${truncate(label, 40)}", which no node has, so it is left out${didYouMean(label, known)}`,
      );
      return;
    }

    const values: PresetValue[] = [];
    const listed = new Set<string>();
    const pathKeys = new Map<string, string>();
    const rawValues = obj['values'];
    const entries = isPlainObject(rawValues)
      ? entriesInFileOrder(out.doc, [...path, 'values'], rawValues)
      : [];
    for (const entry of entries) {
      const value = entry.key.trim();
      const at: DocPath = [...path, 'values', entry.pathKey];
      if (value === '') {
        out.warning(at, `${capitalize(what)} lists an empty value (ignored)`, true);
        continue;
      }
      if (listed.has(value)) {
        out.warning(
          at,
          `${capitalize(what)} lists value "${truncate(value, 40)}" twice; the first is kept`,
          true,
        );
        continue;
      }
      listed.add(value);
      pathKeys.set(value, entry.pathKey);
      const of = `value "${truncate(value, 40)}" of ${what}`;
      let color: SchemeColor | undefined;
      if (entry.value === null || entry.value === undefined) {
        const hex = hexInComment(entry.comment);
        if (hex !== undefined) {
          out.warning(
            at,
            `${capitalize(of)} has no colour: YAML reads the unquoted #${hex} as a comment; write '#${hex}' in quotes. ${COLOR_FALLBACK}`,
            true,
          );
        }
      } else {
        color = colorFromFile(entry.value);
        if (color === undefined) {
          out.warning(at, `${colorProblem(entry.value, of)} ${COLOR_HELP}. ${COLOR_FALLBACK}`);
        }
      }
      values.push(color === undefined ? { value } : { value, color });
    }

    // A listed value nobody has is no mistake (a vocabulary may be ahead of the map) unless it
    // resembles one somebody has and the preset does not list. Two values that differ only in
    // their numerals (tier-2 and tier-9, 1.10 and 1.11) are a series, not a slip.
    const present = labelValueCounts(model, label).map((entry) => entry.value);
    const unlisted = present.filter((value) => !listed.has(value));
    for (const { value } of values) {
      if (present.includes(value)) continue;
      const meant = nearMiss(value, unlisted);
      if (meant !== undefined) {
        out.warning(
          [...path, 'values', pathKeys.get(value) ?? value],
          `${capitalize(what)} lists value "${truncate(value, 40)}", which no node has as its "${truncate(label, 40)}"; did you mean "${truncate(meant, 40)}"?`,
          true,
        );
      }
    }

    const description = data.description?.trim();
    presets.push(
      compact({
        name: data.name,
        label,
        description: description === '' ? undefined : description,
        values,
      }),
    );
  });
  return presets;
}

// ---------------------------------------------------------------------------------------------
// Model

function buildModel(
  rows: readonly ArchRow[],
  records: ReadonlyMap<string, NodeRecord>,
  rootIds: readonly string[],
  edges: readonly ArchEdge[],
  flows: readonly ArchFlow[],
  presets: readonly ColorPreset[],
): ArchitectureModel {
  const ranges = rowRanges(rows, records.values());
  const nodes = new Map<string, ArchNode>();
  for (const record of records.values()) {
    nodes.set(
      record.id,
      compact({
        id: record.id,
        name: record.name,
        description: record.description,
        owner: record.owner,
        status: record.status,
        tech: record.tech,
        links: record.links,
        metrics: record.metrics,
        labels: record.labels,
        level: record.level,
        parentId: record.parentId,
        childIds: record.childIds,
        row: record.row,
        effectiveRow: record.effectiveRow,
        rowRange: ranges.get(record.id),
      }),
    );
  }
  return { version: 1, rows, nodes, rootIds, edges, flows, presets };
}

// ---------------------------------------------------------------------------------------------
// Helpers

/**
 * Validates one mapping against its schema: unknown keys become warnings, schema issues become
 * errors. Returns the parsed data, or undefined when the entry is invalid.
 *
 * For the file and node entries, `whereNodesGo` says where this level keeps its nodes; a node-list
 * key at the wrong level (e.g. `subcomponents:` directly in a domain) is then an error rather than
 * an unknown-key warning when it holds entries, because a whole subtree would vanish from the map.
 */
function checkEntry<S extends AnyObjectSchema>(
  out: Collector,
  schema: S,
  raw: unknown,
  path: DocPath,
  label: string,
  whereNodesGo?: string,
): z.infer<S> | undefined {
  if (isPlainObject(raw)) {
    const known = knownKeys(schema);
    for (const key of Object.keys(raw)) {
      if (known.includes(key)) continue;
      if (whereNodesGo !== undefined && NODE_LIST_KEYS.includes(key)) {
        reportMisplacedNodes(out, [...path, key], raw[key], label, whereNodesGo);
        continue;
      }
      const hint = suggest(key, known);
      out.warning(
        [...path, key],
        `Unknown key "${key}" in ${label} (ignored)${hint === undefined ? '' : `; did you mean "${hint}"?`}`,
        true,
      );
    }
  }
  const result = schema.safeParse(raw, { reportInput: true });
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const issuePath = [...path, ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))];
    out.error(issuePath, issueMessage(issue, label));
  }
  return undefined;
}

function reportMisplacedNodes(
  out: Collector,
  path: DocPath,
  value: unknown,
  label: string,
  whereNodesGo: string,
): void {
  const key = String(path[path.length - 1]);
  const lost = countNodeEntries(value);
  const message =
    `"${key}" is not allowed in ${label}: the hierarchy is domains → components → subcomponents, ` +
    `and ${whereNodesGo}`;
  if (lost === 0) {
    out.warning(path, `${message} (ignored)`, true);
  } else {
    out.error(
      path,
      `${message}; ${lost} ${lost === 1 ? 'node' : 'nodes'} under it would be left out of the map`,
      true,
    );
  }
}

/** Number of entries in a node list, including the entries nested in their own node lists. */
function countNodeEntries(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  for (const entry of value as unknown[]) {
    count += 1;
    if (!isPlainObject(entry)) continue;
    for (const key of NODE_LIST_KEYS) count += countNodeEntries(entry[key]);
  }
  return count;
}

function issueMessage(issue: z.core.$ZodIssue, label: string): string {
  const key = issue.path[issue.path.length - 1];
  const field = typeof key === 'string' ? key : undefined;
  const input: unknown = issue.input;
  const where = field === undefined ? capitalize(label) : `"${field}" of ${label}`;

  if (field === 'kind') {
    const ofFlow = label.startsWith('flow');
    const allowed = (ofFlow ? FLOW_KINDS : EDGE_KINDS).join(', ');
    return input === undefined
      ? `Missing required field "kind" in ${label} (one of: ${allowed})`
      : `Invalid ${ofFlow ? 'flow' : 'edge'} kind ${JSON.stringify(input)} in ${label}; allowed kinds: ${allowed}`;
  }
  if (field === 'version' && issue.path.length === 1) {
    return input === undefined
      ? 'Missing required field "version" (must be 1)'
      : `Unsupported version ${JSON.stringify(input)}; this viewer understands version 1`;
  }
  if (input === undefined && field !== undefined) {
    return `Missing required field "${field}" in ${label}`;
  }
  switch (issue.code) {
    case 'invalid_type':
      return `${where} must be ${expectedText(issue.expected)}, but got ${describeValue(input)}`;
    case 'too_small':
      return `${where} must not be empty`;
    case 'invalid_value':
      return `${where} must be one of: ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`;
    default:
      return `${where}: ${issue.message}`;
  }
}

function expectedText(expected: string): string {
  switch (expected) {
    case 'object':
    case 'record':
      return 'a mapping (key: value pairs)';
    case 'array':
      return 'a list';
    case 'string':
      return 'text';
    default:
      return expected;
  }
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'an empty value';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') return `text ${JSON.stringify(truncate(value, 40))}`;
  return `${typeof value} ${String(value)}`;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One entry of a mapping of the file, as `entriesInFileOrder` gives it. */
interface FileEntry {
  /** The key as the file writes it (`1.10`, not `1.1`). */
  readonly key: string;
  /** The key as the plain object has it: what a `DocPath` to the entry ends with. */
  readonly pathKey: string;
  /** The value as JavaScript has it. */
  readonly value: unknown;
  /** A number or true/false as the file writes it. */
  readonly written?: string;
  /** For an empty value: the comment that follows it on its line, without the `#`. */
  readonly comment?: string;
}

/**
 * The entries of the mapping at `path`, in the order of the file and with keys, numbers and
 * true/false as they are written. The plain object the rest of the parser reads gives neither:
 * JavaScript moves keys that look like whole numbers to the front, and `1.10` has become 1.1.
 * Falls back to the entries of `obj` where the document has no mapping of its own at the path
 * (below an alias), and where a key of the mapping is a list or a mapping: such a key has no text
 * of its own, the plain object has the one the YAML library gives it, and no entry is dropped.
 */
function entriesInFileOrder(
  doc: Document | undefined,
  path: DocPath,
  obj: PlainObject,
): FileEntry[] {
  let node: unknown = doc?.getIn(path, true);
  if (doc && isAlias(node)) node = node.resolve(doc);
  if (!doc || !isMap(node) || node.items.some((pair) => !isScalar(pair.key))) {
    return Object.entries(obj).map(([key, value]) => ({ key, pathKey: key, value }));
  }
  const entries: FileEntry[] = [];
  for (const pair of node.items) {
    if (!isScalar(pair.key)) continue;
    const keyValue: unknown = pair.key.value;
    const key =
      typeof keyValue === 'string'
        ? keyValue
        : keyValue === null
          ? ''
          : (pair.key.source ?? String(keyValue));
    const pathKey = keyValue === null ? '' : String(keyValue);
    const valueNode = isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
    if (isScalar(valueNode)) {
      const value: unknown = valueNode.value;
      const asWritten = typeof value === 'number' || typeof value === 'boolean';
      entries.push({
        key,
        pathKey,
        value,
        ...(asWritten && valueNode.source !== undefined ? { written: valueNode.source } : {}),
        ...(value === null && typeof valueNode.comment === 'string'
          ? { comment: valueNode.comment }
          : {}),
      });
    } else {
      const value: unknown = isNode(valueNode)
        ? valueNode.toJS(doc, { maxAliasCount: MAX_ALIAS_COUNT })
        : null;
      entries.push({ key, pathKey, value });
    }
  }
  return entries;
}

/** The list stored under `key`, or [] when absent or not a list (zod reports the latter). */
function listAt(obj: PlainObject, key: string): unknown[] {
  const value = obj[key];
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function stringField(obj: PlainObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/** Removes keys whose value is undefined, so optional fields are absent rather than undefined. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const MULTIPLE_DOCS_MESSAGE =
  'The file contains several YAML documents (separated by "---"); only one is supported';

/** First line of a yaml-library message, without the "at line X, column Y" suffix. */
function yamlMessage(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? message;
  return firstLine.replace(/ at line \d+, column \d+:?$/, '');
}

function linePos(pos: readonly { line: number; col: number }[] | undefined): Located | undefined {
  const start = pos?.[0];
  return start ? { line: start.line, column: start.col } : undefined;
}

/** Stable sort by line/column; diagnostics without a position keep their place at the top. */
function byPosition(list: Diagnostic[]): Diagnostic[] {
  return [...list].sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
