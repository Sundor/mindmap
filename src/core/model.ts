// Architecture model types. Pure data, no behaviour.

/** Node level: 0 = domain, 1 = component, 2 = subcomponent. */
export type NodeLevel = 0 | 1 | 2;

/** Human-readable name of each level, indexed by {@link NodeLevel}. */
export const NODE_LEVEL_NAMES = ['domain', 'component', 'subcomponent'] as const;
export type NodeLevelName = (typeof NODE_LEVEL_NAMES)[NodeLevel];

/** Edge kinds. Order is the canonical display order. */
export const EDGE_KINDS = ['dataflow', 'dependency', 'control', 'config'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === 'string' && (EDGE_KINDS as readonly string[]).includes(value);
}

/** Inclusive range of row indexes (into {@link ArchitectureModel.rows}), top ≤ bottom. */
export interface RowRange {
  readonly top: number;
  readonly bottom: number;
}

/** A horizontal band (tier) such as "Back-office level". */
export interface ArchRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** A link from a node to something outside the map: its source folder, docs, a dashboard. */
export interface ArchLink {
  readonly label: string;
  /** An http(s) address. */
  readonly url: string;
}

/** A colour in both schemes, each as `#rrggbb`. */
export interface SchemeColor {
  readonly light: string;
  readonly dark: string;
}

/**
 * The attributes a node may carry besides its name and description. Each is free text; a node
 * without one inherits its nearest ancestor's (see `effectiveAttribute`), so an owner set on a
 * domain holds for everything inside it.
 */
export const NODE_ATTRIBUTES = ['owner', 'status', 'tech'] as const;
export type NodeAttribute = (typeof NODE_ATTRIBUTES)[number];

export function isNodeAttribute(value: unknown): value is NodeAttribute {
  return typeof value === 'string' && (NODE_ATTRIBUTES as readonly string[]).includes(value);
}

/** Longest name of a label: it is carried in a `ColorBy` text, which storage keeps up to 200. */
export const LABEL_NAME_MAX = 80;
/** Longest name of a colour preset, for the same reason. */
export const PRESET_NAME_MAX = 80;

export interface ArchNode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** The team or person responsible. */
  readonly owner?: string;
  /** Where the node is in its life: planned, live, deprecated … (free text). */
  readonly status?: string;
  /** The technology it is built with. */
  readonly tech?: string;
  readonly links?: readonly ArchLink[];
  /** Numbers about the node (code size, churn, coverage …), by the name the file gives them. */
  readonly metrics?: ReadonlyMap<string, number>;
  /**
   * The labels written on this node, by name, in file order: free `name: value` pairs of the
   * file. Never empty, and no value is empty. A node without one has its nearest ancestor's
   * (see `effectiveLabel`).
   */
  readonly labels?: ReadonlyMap<string, string>;
  readonly level: NodeLevel;
  /** Undefined for domains. */
  readonly parentId?: string;
  /** Direct children in YAML order. */
  readonly childIds: readonly string[];
  /** Row named explicitly on this node in the YAML (`row:`). */
  readonly row?: string;
  /** This node's own row, or else the nearest ancestor's row. */
  readonly effectiveRow?: string;
  /**
   * Rows this node occupies. A node with an effective row occupies exactly that row; a node
   * without one spans from the top-most to the bottom-most row used in its subtree. Undefined
   * when nothing in the subtree has a row ("unassigned").
   */
  readonly rowRange?: RowRange;
}

export interface ArchEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly label?: string;
  readonly protocol?: string;
  readonly description?: string;
}

/** What a flow describes: a sequence of work, or the way data travels. */
export const FLOW_KINDS = ['workflow', 'dataflow'] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export function isFlowKind(value: unknown): value is FlowKind {
  return typeof value === 'string' && (FLOW_KINDS as readonly string[]).includes(value);
}

/**
 * A flow: a set of edges and nodes that together tell one story ("place an order"), defined
 * apart from them. The edges are its steps, in order; the nodes are what it passes through —
 * the ends of its edges, and any named on their own.
 */
export interface ArchFlow {
  readonly id: string;
  readonly name: string;
  readonly kind: FlowKind;
  readonly description?: string;
  /** Edge IDs in step order. An edge may occur more than once. */
  readonly edgeIds: readonly string[];
  /** Node IDs named by the flow itself, in file order, without duplicates. */
  readonly nodeIds: readonly string[];
}

/** One value a colour preset lists: its place in the legend, and its colour when it gives one. */
export interface PresetValue {
  readonly value: string;
  /** Absent: the next free colour of the palette. */
  readonly color?: SchemeColor;
}

/**
 * A colour preset of the file: a named colouring of the boxes by one label, with the colour of
 * each value it lists.
 */
export interface ColorPreset {
  /** Unique among the presets: what "Colour by" lists, the legend is headed with, a view keeps. */
  readonly name: string;
  /** A label some node carries, or one of `NODE_ATTRIBUTES`. */
  readonly label: string;
  readonly description?: string;
  /** The values the file lists, in its order (the order of the legend), each once. */
  readonly values: readonly PresetValue[];
}

/**
 * Validated architecture. Node IDs and edge IDs are separate namespaces: a node and an edge may
 * share an ID (consumers that mix them, e.g. a selection, must tag which one they mean). Row IDs
 * are a third namespace, flow IDs a fourth.
 */
export interface ArchitectureModel {
  readonly version: 1;
  /** Rows in top → bottom order; empty when the file has no `rows:` section. */
  readonly rows: readonly ArchRow[];
  /** All nodes, iterated in YAML document order (depth-first, parents before children). */
  readonly nodes: ReadonlyMap<string, ArchNode>;
  /** Domain IDs in YAML order. */
  readonly rootIds: readonly string[];
  /** Edges in YAML order. */
  readonly edges: readonly ArchEdge[];
  /** Flows in YAML order; empty when the file has none. */
  readonly flows: readonly ArchFlow[];
  /**
   * Colour presets in YAML order; empty when the file has none. Each names a label some node
   * has (one that does not is left out when the file is read).
   */
  readonly presets: readonly ColorPreset[];
}

/** What the label functions read of a node. The parser's own records fit as well. */
export interface LabelledNode {
  readonly id: string;
  readonly parentId?: string;
  readonly owner?: string;
  readonly status?: string;
  readonly tech?: string;
  readonly labels?: ReadonlyMap<string, string>;
}

/** The nodes by ID, in document order: an `ArchitectureModel`, or the parser's records. */
export interface LabelledNodes {
  readonly nodes: ReadonlyMap<string, LabelledNode>;
}

/**
 * The value of label `name` that holds for node `id`: its own, else the nearest ancestor's. An
 * attribute (`owner`, `status`, `tech`) is a label by that name. Undefined when no node up the
 * chain has one, or `id` is unknown.
 */
export function effectiveLabel(
  model: LabelledNodes,
  id: string,
  name: string,
): { readonly value: string; readonly from: string } | undefined {
  const attribute = isNodeAttribute(name) ? name : undefined;
  for (let node = model.nodes.get(id); node; node = nodeParent(model, node)) {
    const value = attribute ? node[attribute] : node.labels?.get(name);
    if (value !== undefined) return { value, from: node.id };
  }
  return undefined;
}

function nodeParent(model: LabelledNodes, node: LabelledNode): LabelledNode | undefined {
  return node.parentId === undefined ? undefined : model.nodes.get(node.parentId);
}

/**
 * The value of attribute `key` that holds for node `id`: its own, else the nearest ancestor's.
 * Undefined when no node up the chain has one, or `id` is unknown.
 */
export function effectiveAttribute(
  model: LabelledNodes,
  id: string,
  key: NodeAttribute,
): { readonly value: string; readonly from: string } | undefined {
  return effectiveLabel(model, id, key);
}

/** The names of the labels the nodes carry, in the order they first occur (document order). */
export function labelNames(model: LabelledNodes): string[] {
  const names = new Set<string>();
  for (const node of model.nodes.values()) {
    for (const name of node.labels?.keys() ?? []) names.add(name);
  }
  return [...names];
}

/**
 * Every label that holds for node `id` — its own and the inherited ones — in the order of
 * `labelNames`, each with the node it comes from. The attributes are not among them.
 */
export function effectiveLabels(
  model: LabelledNodes,
  id: string,
): { readonly name: string; readonly value: string; readonly from: string }[] {
  if (!model.nodes.has(id)) return [];
  const found: { name: string; value: string; from: string }[] = [];
  for (const name of labelNames(model)) {
    const label = effectiveLabel(model, id, name);
    if (label) found.push({ name, ...label });
  }
  return found;
}

/** A value of a label and the number of nodes it holds for (own or inherited). */
export interface ValueCount {
  readonly value: string;
  readonly count: number;
}

/**
 * The values label `name` (or the attribute of that name) has over the nodes, inherited ones
 * included, in the order of their first node (document order), each with its number of nodes.
 */
export function labelValueCounts(model: LabelledNodes, name: string): ValueCount[] {
  const counts = new Map<string, number>();
  for (const id of model.nodes.keys()) {
    const found = effectiveLabel(model, id, name);
    if (found) counts.set(found.value, (counts.get(found.value) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count }));
}
