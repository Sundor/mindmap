// ELK integration: plain hierarchical layouts of whole subtrees, and left → right
// ordering of the items in a row-mode container. Uses the bundled build, which runs without a
// worker in the browser single-file build and in Node/Vitest.

import ElkConstructor, {
  type ELK,
  type ElkExtendedEdge,
  type ElkNode,
  type LayoutOptions,
} from 'elkjs/lib/elk.bundled.js';
import { aggregateCountLabel, edgeLabelText, labelRoomOf } from '../edgeLabel';
import type { ArchitectureModel, ArchNode } from '../model';
import {
  EDGE_LABEL_CLEARANCE,
  EDGE_LABEL_LAYOUT_LINES,
  ELK_BASE_OPTIONS,
  LAYER_SPACING,
  groupMinHeight,
  groupMinWidth,
  groupPadding,
  leafSize,
} from './constants';
import { edgeContainer, subtreeIds } from './tree';
import type { Rect, Size } from './types';

/** ID of the synthetic ELK root. Never a valid node ID (those are lowercase dot-separated). */
export const ELK_ROOT_ID = '#root';

const BASE_OPTIONS: LayoutOptions = { ...ELK_BASE_OPTIONS };

let instance: ELK | undefined;
function elk(): ELK {
  instance ??= new ElkConstructor();
  return instance;
}

function padding(p: { top: number; right: number; bottom: number; left: number }): string {
  return `[top=${p.top},left=${p.left},bottom=${p.bottom},right=${p.right}]`;
}

/** Content blocks reserved inside nodes, by node ID (see `ComputeLayoutOptions.content`). */
export type ContentSizes = ReadonlyMap<string, Size>;

const NO_CONTENT: ContentSizes = new Map();

/**
 * The spacing of the base options, given to every group as well: with the children of the
 * hierarchy laid out together, a group that says nothing gets ELK's own spacing, not the root's.
 */
const SPACING_OPTIONS: LayoutOptions = Object.fromEntries(
  Object.entries(ELK_BASE_OPTIONS).filter(
    ([key]) =>
      key.startsWith('elk.spacing.') ||
      key.startsWith('elk.layered.spacing.') ||
      key.startsWith('elk.edgeLabels.'),
  ),
);

function groupOptions(node: ArchNode, content: Size | undefined): LayoutOptions {
  return {
    ...SPACING_OPTIONS,
    'elk.padding': padding(groupPadding(content)),
    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
    'elk.nodeSize.minimum': `(${groupMinWidth(node, content)}, ${groupMinHeight(content)})`,
  };
}

/**
 * ELK graph of the subtrees rooted at `rootIds` (fully expanded), under a synthetic root. Every
 * model edge with both endpoints in those subtrees is declared in its containing node: the
 * endpoint that contains the other one, else the lowest common ancestor, else the root. Nodes
 * with a `content` block are sized for it: a leaf grows, a group keeps the block free between
 * its header and its children. An edge with a label carries a label (ELK reads one only with
 * its text), which the layout keeps free on the line between the two ends with the layer
 * spacing on each side of it: the label is given its box (on up to `EDGE_LABEL_LAYOUT_LINES`
 * lines) less what the layer spacing on both sides exceeds the clearance, so that the two ends
 * come to lie the box and `EDGE_LABEL_CLEARANCE` on each side apart — the room the row packing
 * and the map closed up around its closed groups keep as well. Edges of one kind between the
 * same two nodes are drawn as one, with their count where they have no labels: the first of
 * them carries that count. The sizes are even numbers of pixels, so that a layer holding a
 * label beside boxes (whose sizes are even) centres them on whole pixels.
 */
export function buildHierarchyGraph(
  model: ArchitectureModel,
  rootIds: readonly string[],
  rootPadding: number,
  content: ContentSizes = NO_CONTENT,
): ElkNode {
  const scope = new Set(rootIds.flatMap((id) => subtreeIds(model, id)));
  const groups = new Map<string, ElkNode>();
  const makeNode = (id: string): ElkNode => {
    const node = model.nodes.get(id);
    if (!node) throw new Error(`Unknown node ${id}`);
    if (node.childIds.length === 0) return { id, ...leafSize(node, content.get(id)) };
    const group: ElkNode = {
      id,
      layoutOptions: groupOptions(node, content.get(id)),
      children: node.childIds.map(makeNode),
      edges: [],
    };
    groups.set(id, group);
    return group;
  };
  const root: ElkNode = {
    id: ELK_ROOT_ID,
    layoutOptions: {
      ...BASE_OPTIONS,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.padding': padding({
        top: rootPadding,
        right: rootPadding,
        bottom: rootPadding,
        left: rootPadding,
      }),
    },
    children: rootIds.map(makeNode),
    edges: [],
  };
  // Edges of one kind between the same two nodes, in order: drawn as one, counted.
  const alike = new Map<string, number[]>();
  model.edges.forEach((edge, index) => {
    const key = `${edge.from}\n${edge.to}\n${edge.kind}`;
    alike.set(key, [...(alike.get(key) ?? []), index]);
  });
  const even = (n: number): number => 2 * Math.ceil(n / 2);
  model.edges.forEach((edge, index) => {
    if (!scope.has(edge.from) || !scope.has(edge.to)) return;
    const containerId = edgeContainer(model, edge.from, edge.to);
    const container = (containerId !== undefined && groups.get(containerId)) || root;
    const together = alike.get(`${edge.from}\n${edge.to}\n${edge.kind}`) ?? [index];
    const labelled = together.some((i) => edgeLabelText(model.edges[i] ?? edge) !== undefined);
    let text = edgeLabelText(edge);
    if (together.length > 1 && !labelled && together[0] === index) {
      text = aggregateCountLabel(together.length);
    }
    const room =
      text === undefined
        ? undefined
        : labelRoomOf(text, EDGE_LABEL_LAYOUT_LINES, EDGE_LABEL_CLEARANCE);
    const elkEdge: ElkExtendedEdge = {
      id: `edge:${index}`,
      sources: [edge.from],
      targets: [edge.to],
      ...(text !== undefined && room
        ? {
            labels: [
              {
                id: `label:${index}`,
                text,
                width: even(Math.max(1, room.width - 2 * LAYER_SPACING)),
                height: even(room.height),
              },
            ],
          }
        : {}),
    };
    container.edges?.push(elkEdge);
  });
  return root;
}

export interface HierarchyLayout {
  /** Rects of every node in the subtrees, relative to the parent (roots: relative to origin). */
  readonly rects: Map<string, Rect>;
  /** Size of the whole laid-out graph including the root padding. */
  readonly size: Size;
}

/** Plain ELK layered layout (direction RIGHT, INCLUDE_CHILDREN) of the given subtrees. */
export async function layoutHierarchy(
  model: ArchitectureModel,
  rootIds: readonly string[],
  rootPadding: number,
  content: ContentSizes = NO_CONTENT,
): Promise<HierarchyLayout> {
  const result = await elk().layout(buildHierarchyGraph(model, rootIds, rootPadding, content));
  const rects = new Map<string, Rect>();
  const walk = (node: ElkNode): void => {
    for (const child of node.children ?? []) {
      rects.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
      walk(child);
    }
  };
  walk(result);
  return { rects, size: { width: result.width ?? 0, height: result.height ?? 0 } };
}

export interface OrderItem {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

interface PlacedItem {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly right: number;
  readonly index: number;
}

/**
 * Left → right order of flat items so that connected items end up close and edges mostly point
 * right: ELK layered (direction RIGHT) on the items with the given edges, read back layer by
 * layer (x), within a layer by y, ties by input order.
 */
export async function orderItems(
  items: readonly OrderItem[],
  edges: readonly (readonly [string, string])[],
): Promise<string[]> {
  if (items.length <= 1) return items.map((item) => item.id);
  const graph: ElkNode = {
    id: ELK_ROOT_ID,
    layoutOptions: BASE_OPTIONS,
    children: items.map(({ id, width, height }) => ({ id, width, height })),
    edges: edges.map(([from, to], k) => ({ id: `edge:${k}`, sources: [from], targets: [to] })),
  };
  const result = await elk().layout(graph);
  const index = new Map(items.map((item, i) => [item.id, i]));
  const placed: PlacedItem[] = (result.children ?? []).map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    right: (c.x ?? 0) + (c.width ?? 0),
    index: index.get(c.id) ?? 0,
  }));
  placed.sort((a, b) => a.x - b.x || a.index - b.index);
  // Layers = runs of items whose x-ranges overlap.
  const layers: PlacedItem[][] = [];
  let layerRight = -Infinity;
  for (const item of placed) {
    const current = layers[layers.length - 1];
    if (current && item.x < layerRight) {
      current.push(item);
      layerRight = Math.max(layerRight, item.right);
    } else {
      layers.push([item]);
      layerRight = item.right;
    }
  }
  return layers.flatMap((layer) =>
    layer.sort((a, b) => a.y - b.y || a.index - b.index).map((item) => item.id),
  );
}
