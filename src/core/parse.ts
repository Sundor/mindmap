// parseArchitecture: YAML text → validated ArchitectureModel + diagnostics.
//
// Never throws. All problems in the file are collected in one pass: shape problems (zod), ID rules,
// references, rows. Each malformed entry is salvaged as far as possible (its ID and children are
// still registered) so one mistake does not cascade into spurious "unknown ID" errors elsewhere.

import { isMap, isNode, isScalar, LineCounter, parseDocument, type Document } from 'yaml';
import type { z } from './zod';
import { formatPath, type Diagnostic, type DocPath, type Severity } from './diagnostics';
import { didYouMean, ID_RULE, isValidId, isValidSegment, suggest } from './ids';
import {
  EDGE_KINDS,
  FLOW_KINDS,
  isEdgeKind,
  NODE_ATTRIBUTES,
  NODE_LEVEL_NAMES,
  type ArchEdge,
  type ArchFlow,
  type ArchitectureModel,
  type ArchLink,
  type ArchNode,
  type ArchRow,
  type NodeLevel,
  type RowRange,
} from './model';
import {
  ComponentSchema,
  DomainSchema,
  EdgeSchema,
  FileSchema,
  FlowSchema,
  knownKeys,
  LinkSchema,
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
  const domains = listAt(root, 'domains');
  domains.forEach((raw, i) => {
    const record = walkNode(out, raw, ['domains', i], 0, undefined, nodes, rows);
    if (record) rootIds.push(record.id);
  });
  const edges = readEdges(out, root, nodes);
  const flows = readFlows(out, root, nodes, edges);

  if (out.errors.length > 0) return null;
  return buildModel(rows.list, nodes, rootIds, edges, flows);
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
// Model

function buildModel(
  rows: readonly ArchRow[],
  records: ReadonlyMap<string, NodeRecord>,
  rootIds: readonly string[],
  edges: readonly ArchEdge[],
  flows: readonly ArchFlow[],
): ArchitectureModel {
  const rowIndex = new Map(rows.map((row, i) => [row.id, i]));
  // Children come after their parents in document order, so walking it backwards
  // computes every child's range before its parent needs it.
  const ranges = new Map<string, RowRange>();
  const ordered = [...records.values()];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const record = ordered[i];
    if (!record) continue;
    const own = record.effectiveRow === undefined ? undefined : rowIndex.get(record.effectiveRow);
    let range: RowRange | undefined = own === undefined ? undefined : { top: own, bottom: own };
    if (range === undefined) {
      for (const childId of record.childIds) {
        const child = ranges.get(childId);
        if (!child) continue;
        range = range
          ? { top: Math.min(range.top, child.top), bottom: Math.max(range.bottom, child.bottom) }
          : child;
      }
    }
    if (range) ranges.set(record.id, range);
  }

  const nodes = new Map<string, ArchNode>();
  for (const record of ordered) {
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
        level: record.level,
        parentId: record.parentId,
        childIds: record.childIds,
        row: record.row,
        effectiveRow: record.effectiveRow,
        rowRange: ranges.get(record.id),
      }),
    );
  }
  return { version: 1, rows, nodes, rootIds, edges, flows };
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
