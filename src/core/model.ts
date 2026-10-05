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

/**
 * The attributes a node may carry besides its name and description. Each is free text; a node
 * without one inherits its nearest ancestor's (see `effectiveAttribute`), so an owner set on a
 * domain holds for everything inside it.
 */
export const NODE_ATTRIBUTES = ['owner', 'status', 'tech'] as const;
export type NodeAttribute = (typeof NODE_ATTRIBUTES)[number];

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
}

/**
 * The value of attribute `key` that holds for node `id`: its own, else the nearest ancestor's.
 * Undefined when no node up the chain has one, or `id` is unknown.
 */
export function effectiveAttribute(
  model: ArchitectureModel,
  id: string,
  key: NodeAttribute,
): { readonly value: string; readonly from: string } | undefined {
  for (let node = model.nodes.get(id); node; node = nodeParent(model, node)) {
    const value = node[key];
    if (value !== undefined) return { value, from: node.id };
  }
  return undefined;
}

function nodeParent(model: ArchitectureModel, node: ArchNode): ArchNode | undefined {
  return node.parentId === undefined ? undefined : model.nodes.get(node.parentId);
}
