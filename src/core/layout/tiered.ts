// Row-aware ("tiered") layout. Our own geometry for bands, spanning columns
// and the Unassigned area; ELK for the inside of single-row items and for ordering items.
//
// Every node plays one of three roles:
//   - row:  it has an effective row. Its whole subtree sits in that row, laid out by plain ELK.
//   - span: no effective row, but rows in its subtree (`rowRange`). It is a column across its
//           rows; each child sits in that child's row (or spans a sub-range, recursively).
//   - free: nothing in its subtree has a row. Inside a spanning group it is "attracted" into the
//           row where most of its connections point (ties: the top-most tied row; no
//           connections: the group's top row); at the top level it goes to the
//           Unassigned area.
//
// Each container (the canvas or a spanning group) is a set of columns × row slices. Items are
// ordered left → right by ELK (see `orderItems`) and packed with a per-row skyline: an item
// starts right of everything already placed in any of the rows it occupies. Band heights are
// the maximum any container needs in that row (measure pass), so bands line up across columns
// and nesting levels; the placement pass then turns row indexes into y coordinates.

import type { ArchitectureModel, ArchNode, RowRange } from '../model';
import {
  BAND_PADDING_X,
  BAND_PADDING_Y,
  GROUP_PADDING,
  ITEM_GAP,
  LEAF_SIZE,
  MIN_BAND_HEIGHT,
  ROW_GUTTER_WIDTH,
  UNASSIGNED_GAP,
  UNASSIGNED_HEADER,
  UNASSIGNED_MIN_WIDTH,
  UNASSIGNED_PADDING,
  groupMinWidth,
  groupPadding,
} from './constants';
import { layoutHierarchy, orderItems, type ContentSizes, type HierarchyLayout } from './elk';
import { sweep1D } from './sweep';
import { isWithin, selfAndAncestors, subtreeIds } from './tree';
import type { Rect, RowBand, Size } from './types';

/** Key of the canvas in the container maps. Never a valid node ID. */
const CANVAS = '#canvas';

type Role = 'row' | 'span' | 'free';

function roleOf(node: ArchNode): Role {
  if (node.effectiveRow !== undefined) return 'row';
  return node.rowRange !== undefined ? 'span' : 'free';
}

interface ContainerItem {
  readonly id: string;
  readonly span: boolean;
  /** Row range the item occupies (top === bottom for single-row items). */
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  /** Real height for single-row items; the column height is only known after band sizing. */
  readonly height: number;
  /** Offset from the container's content-left edge. */
  x: number;
}

interface ContainerMeasure {
  readonly top: number;
  readonly bottom: number;
  /** Items in left → right order. */
  readonly items: ContainerItem[];
  readonly contentWidth: number;
  /** Height of the single-row items in each row slice, indexed by row (0 when none). */
  readonly sliceHeight: number[];
}

export interface TieredLayout {
  readonly rects: Map<string, Rect>;
  readonly absolute: Map<string, Rect>;
  readonly rows: RowBand[];
  readonly gutterWidth: number;
  readonly unassignedArea?: Rect;
  readonly bounds: Size;
  readonly placedRow: Map<string, string>;
  readonly rowOf: Map<string, string>;
}

/**
 * Votes of the row-less `nodeId` (a child of a spanning group with `range`): one per edge between
 * its subtree and a node outside it whose row is known, counted for that node's row. Rows outside
 * `range` count for the nearest row inside it; endpoints without a known row (spanning or
 * unassigned nodes, not yet resolved attracted nodes) don't count.
 */
function attractionVotes(
  model: ArchitectureModel,
  nodeId: string,
  range: RowRange,
  knownRows: ReadonlyMap<string, number>,
): Map<number, number> {
  const votes = new Map<number, number>();
  for (const edge of model.edges) {
    const fromInside = isWithin(model, edge.from, nodeId);
    if (fromInside === isWithin(model, edge.to, nodeId)) continue;
    const row = knownRows.get(fromInside ? edge.to : edge.from);
    if (row === undefined) continue;
    const clamped = Math.min(range.bottom, Math.max(range.top, row));
    votes.set(clamped, (votes.get(clamped) ?? 0) + 1);
  }
  return votes;
}

/**
 * Row the row-less `nodeId` (a child of a spanning group with `range`) is attracted to, given the
 * rows in `knownRows`: the row with the most votes (see `attractionVotes`). Among rows tied for
 * the highest count the top-most tied row wins; with no votes at all it is the parent's top row.
 */
export function attractedRow(
  model: ArchitectureModel,
  nodeId: string,
  range: RowRange,
  knownRows: ReadonlyMap<string, number>,
): number {
  const votes = attractionVotes(model, nodeId, range, knownRows);
  let best = range.top;
  // Top → bottom with a strict comparison: the first (top-most) row with the highest count wins.
  for (let r = range.top; r <= range.bottom; r++) {
    if ((votes.get(r) ?? 0) > (votes.get(best) ?? 0)) best = r;
  }
  return best;
}

/** A row-less child of a spanning group, with the row range of that group. */
export interface AttractionCandidate {
  readonly id: string;
  readonly range: RowRange;
}

/**
 * Rows of all attracted nodes, independent of the order of `candidates` (and so of YAML sibling
 * order). Resolution runs in waves until a fixed point:
 *   1. candidates connected to explicitly-assigned nodes are resolved from those alone;
 *   2. each further wave resolves the candidates connected to something resolved so far, all of
 *      them against the same snapshot of known rows (a wave never sees its own results);
 *   3. candidates still without any vote get their parent's top row.
 * A resolved row is final, so every wave resolves at least one candidate and there are at most
 * `candidates.length` waves. `explicitRows` maps node ID → row index for nodes with an effective
 * row; the result maps candidate ID → row index (descendants share their candidate's row).
 */
export function deriveAttractedRows(
  model: ArchitectureModel,
  candidates: readonly AttractionCandidate[],
  explicitRows: ReadonlyMap<string, number>,
): Map<string, number> {
  const known = new Map(explicitRows);
  const derived = new Map<string, number>();
  let pending = [...candidates];
  for (let wave = 0; wave < candidates.length && pending.length > 0; wave++) {
    const resolved: [AttractionCandidate, number][] = [];
    for (const candidate of pending) {
      if (attractionVotes(model, candidate.id, candidate.range, known).size === 0) continue;
      resolved.push([candidate, attractedRow(model, candidate.id, candidate.range, known)]);
    }
    if (resolved.length === 0) break;
    for (const [candidate, row] of resolved) {
      derived.set(candidate.id, row);
      for (const id of subtreeIds(model, candidate.id)) known.set(id, row);
    }
    pending = pending.filter((candidate) => !derived.has(candidate.id));
  }
  for (const candidate of pending) derived.set(candidate.id, candidate.range.top);
  return derived;
}

/** The rows the nodes of a model sit in, by row ID. */
export interface RowPlacement {
  /** Row-less children of spanning groups → the row their connections place them in (YAML order). */
  readonly placedRow: Map<string, string>;
  /** Every node that sits in one row → that row (model order). */
  readonly rowOf: Map<string, string>;
}

/**
 * Rows of the single-row nodes of `model`: effective rows, then attraction (order-independent,
 * see `deriveAttractedRows`). `itemRow` holds them as row indexes, for the geometry.
 */
function placeInRows(model: ArchitectureModel): RowPlacement & {
  readonly itemRow: Map<string, number>;
} {
  const rowIndex = new Map(model.rows.map((row, i) => [row.id, i]));
  const itemRow = new Map<string, number>();
  for (const node of model.nodes.values()) {
    const r = node.effectiveRow === undefined ? undefined : rowIndex.get(node.effectiveRow);
    if (r !== undefined) itemRow.set(node.id, r);
  }
  const candidates: AttractionCandidate[] = [];
  for (const node of model.nodes.values()) {
    if (roleOf(node) !== 'free' || node.parentId === undefined) continue;
    const parent = model.nodes.get(node.parentId);
    if (!parent || roleOf(parent) !== 'span' || !parent.rowRange) continue;
    candidates.push({ id: node.id, range: parent.rowRange });
  }
  const derivedRows = deriveAttractedRows(model, candidates, itemRow);
  // Reported in YAML order, whatever order the rows were resolved in.
  const placedRow = new Map<string, string>();
  for (const { id, range } of candidates) {
    const r = derivedRows.get(id) ?? range.top;
    placedRow.set(id, model.rows[r]?.id ?? '');
    for (const sub of subtreeIds(model, id)) itemRow.set(sub, r);
  }
  const rowOf = new Map<string, string>();
  for (const id of model.nodes.keys()) {
    const r = itemRow.get(id);
    if (r !== undefined) rowOf.set(id, model.rows[r]?.id ?? '');
  }
  return { itemRow, placedRow, rowOf };
}

/**
 * The rows the nodes of `model` sit in, as the row layout decides them, without laying anything
 * out. Both maps are empty for a model without rows.
 */
export function rowPlacement(model: ArchitectureModel): RowPlacement {
  if (model.rows.length === 0) return { placedRow: new Map(), rowOf: new Map() };
  const { placedRow, rowOf } = placeInRows(model);
  return { placedRow, rowOf };
}

/**
 * Row-aware layout of `model`. `content` reserves a block inside the nodes it names: single-row
 * items and unassigned nodes get it from ELK (`layoutHierarchy`); a spanning group keeps it free
 * below its header, at the top of its top row, which pushes its children in that row down (and
 * makes the band taller when needed) and makes the group at least as wide as the block.
 */
export async function layoutWithRows(
  model: ArchitectureModel,
  content: ContentSizes = new Map(),
): Promise<TieredLayout> {
  const rowCount = model.rows.length;
  const nodeOf = (id: string): ArchNode => {
    const node = model.nodes.get(id);
    if (!node) throw new Error(`Unknown node ${id}`);
    return node;
  };

  // --- Rows of single-row nodes.
  const { itemRow, placedRow, rowOf } = placeInRows(model);

  // --- Boxes: single-row items and unassigned top-level nodes, each laid out by plain ELK.
  const boxes = new Map<string, HierarchyLayout>();
  for (const node of model.nodes.values()) {
    if (roleOf(node) === 'span') continue;
    const parentRole = node.parentId === undefined ? 'canvas' : roleOf(nodeOf(node.parentId));
    if (parentRole !== 'canvas' && parentRole !== 'span') continue;
    boxes.set(node.id, await layoutHierarchy(model, [node.id], 0, content));
  }
  const boxSize = (id: string): Size => {
    const rect = boxes.get(id)?.rects.get(id);
    if (!rect) throw new Error(`No box layout for ${id}`);
    return { width: rect.width, height: rect.height };
  };

  // --- Measure pass (bottom-up): widths, item order and x offsets, slice heights.
  const measures = new Map<string, ContainerMeasure>();
  const measure = async (
    containerId: string,
    childIds: readonly string[],
    range: RowRange,
  ): Promise<ContainerMeasure> => {
    const items: ContainerItem[] = [];
    for (const id of childIds) {
      const child = nodeOf(id);
      if (roleOf(child) === 'span' && child.rowRange) {
        const inner = await measure(id, child.childIds, child.rowRange);
        const width = Math.max(
          groupMinWidth(child, content.get(id)),
          GROUP_PADDING.left + inner.contentWidth + GROUP_PADDING.right,
        );
        const rows = child.rowRange.bottom - child.rowRange.top + 1;
        items.push({
          id,
          span: true,
          ...child.rowRange,
          width,
          height: rows * MIN_BAND_HEIGHT,
          x: 0,
        });
      } else {
        const row = itemRow.get(id);
        if (row === undefined) continue; // unassigned top-level node
        items.push({ id, span: false, top: row, bottom: row, ...boxSize(id), x: 0 });
      }
    }

    // Edges projected onto the items: each endpoint → the item that contains it.
    const itemIds = new Set(items.map((item) => item.id));
    const itemOf = (id: string): string | undefined =>
      selfAndAncestors(model, id).find((a) => itemIds.has(a));
    const seen = new Set<string>();
    const projected: [string, string][] = [];
    for (const edge of model.edges) {
      const a = itemOf(edge.from);
      const b = itemOf(edge.to);
      if (a === undefined || b === undefined || a === b) continue;
      const key = `${a}\u0000${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      projected.push([a, b]);
    }
    const order = await orderItems(items, projected);
    const byId = new Map(items.map((item) => [item.id, item]));
    const ordered = order.map((id) => byId.get(id)).filter((item) => item !== undefined);

    // Skyline packing: per-row cursor of the next free x.
    const cursor = new Array<number>(rowCount).fill(0);
    const sliceHeight = new Array<number>(rowCount).fill(0);
    let contentWidth = 0;
    for (const item of ordered) {
      let x = 0;
      for (let r = item.top; r <= item.bottom; r++) x = Math.max(x, cursor[r] ?? 0);
      item.x = x;
      for (let r = item.top; r <= item.bottom; r++) cursor[r] = x + item.width + ITEM_GAP;
      contentWidth = Math.max(contentWidth, x + item.width);
      if (!item.span) sliceHeight[item.top] = Math.max(sliceHeight[item.top] ?? 0, item.height);
    }
    const result: ContainerMeasure = { ...range, items: ordered, contentWidth, sliceHeight };
    measures.set(containerId, result);
    return result;
  };
  const canvas = await measure(CANVAS, model.rootIds, { top: 0, bottom: rowCount - 1 });

  // Vertical room a container's own padding (and its spanning ancestors' padding) takes inside
  // a band: a spanning group's header sits at the top of its top row, its bottom padding at the
  // bottom of its bottom row. Nested groups that share that row stack their insets. A group's
  // content block lies directly below its header.
  const insetTop = (containerId: string, r: number): number => {
    if (containerId === CANVAS) return 0;
    const node = nodeOf(containerId);
    if (node.rowRange?.top !== r) return 0;
    return groupPadding(content.get(containerId)).top + insetTop(node.parentId ?? CANVAS, r);
  };
  const insetBottom = (containerId: string, r: number): number => {
    if (containerId === CANVAS) return 0;
    const node = nodeOf(containerId);
    if (node.rowRange?.bottom !== r) return 0;
    return GROUP_PADDING.bottom + insetBottom(node.parentId ?? CANVAS, r);
  };

  // --- Band sizing: the tallest need of any container in each row.
  const bandHeight = new Array<number>(rowCount).fill(MIN_BAND_HEIGHT);
  for (const [containerId, m] of measures) {
    for (let r = m.top; r <= m.bottom; r++) {
      const need = insetTop(containerId, r) + (m.sliceHeight[r] ?? 0) + insetBottom(containerId, r);
      bandHeight[r] = Math.max(bandHeight[r] ?? 0, need + 2 * BAND_PADDING_Y);
    }
  }
  const bandY: number[] = [];
  let totalBandHeight = 0;
  for (const h of bandHeight) {
    bandY.push(totalBandHeight);
    totalBandHeight += h;
  }
  const bandTop = (r: number): number => bandY[r] ?? 0;
  const bandBottom = (r: number): number => bandTop(r) + (bandHeight[r] ?? 0);
  const contentTop = (containerId: string, r: number): number =>
    bandTop(r) + BAND_PADDING_Y + insetTop(containerId, r);
  const contentBottom = (containerId: string, r: number): number =>
    bandBottom(r) - BAND_PADDING_Y - insetBottom(containerId, r);

  // --- Placement pass (top-down).
  const absolute = new Map<string, Rect>();
  const relative = new Map<string, Rect>();
  const setRect = (id: string, abs: Rect): void => {
    absolute.set(id, abs);
    const parentId = nodeOf(id).parentId;
    const parent = parentId === undefined ? undefined : absolute.get(parentId);
    relative.set(id, parent ? { ...abs, x: abs.x - parent.x, y: abs.y - parent.y } : abs);
  };
  const placeBox = (id: string, x: number, y: number): void => {
    const box = boxes.get(id);
    if (!box) throw new Error(`No box layout for ${id}`);
    setRect(id, { x, y, ...boxSize(id) });
    for (const descendant of subtreeIds(model, id).slice(1)) {
      const rel = box.rects.get(descendant);
      const parent = absolute.get(nodeOf(descendant).parentId ?? '');
      if (!rel || !parent) throw new Error(`No box layout for ${descendant}`);
      setRect(descendant, { ...rel, x: parent.x + rel.x, y: parent.y + rel.y });
    }
  };
  const place = (containerId: string, contentLeft: number): void => {
    const m = measures.get(containerId);
    if (!m) throw new Error(`Container ${containerId} was not measured`);
    for (const item of m.items) {
      const x = contentLeft + item.x;
      const y = contentTop(containerId, item.top);
      if (item.span) {
        const height = contentBottom(containerId, item.bottom) - y;
        setRect(item.id, { x, y, width: item.width, height });
        place(item.id, x + GROUP_PADDING.left);
      } else {
        placeBox(item.id, x, y);
      }
    }
  };
  place(CANVAS, ROW_GUTTER_WIDTH + BAND_PADDING_X);

  const bandsWidth =
    ROW_GUTTER_WIDTH + 2 * BAND_PADDING_X + Math.max(canvas.contentWidth, LEAF_SIZE[0].width);
  // --- Unassigned area: right of the bands, items pulled toward their connections.
  const unassignedIds = model.rootIds.filter((id) => roleOf(nodeOf(id)) === 'free');
  let unassignedArea: Rect | undefined;
  if (unassignedIds.length > 0) {
    const entries = unassignedIds.map((id, index) => {
      const centres: number[] = [];
      for (const edge of model.edges) {
        const fromInside = isWithin(model, edge.from, id);
        if (fromInside === isWithin(model, edge.to, id)) continue;
        const other = absolute.get(fromInside ? edge.to : edge.from);
        if (other) centres.push(other.y + other.height / 2);
      }
      const target =
        centres.length > 0 ? centres.reduce((sum, c) => sum + c, 0) / centres.length : undefined;
      return { id, index, target, size: boxSize(id) };
    });
    // Items with a target in target order, then the rest in YAML order.
    entries.sort((a, b) => {
      if (a.target === undefined || b.target === undefined) {
        return (
          (a.target === undefined ? 1 : 0) - (b.target === undefined ? 1 : 0) || a.index - b.index
        );
      }
      return a.target - b.target || a.index - b.index;
    });
    const starts = sweep1D(
      entries.map((e) => e.size.height),
      entries.map((e) => (e.target === undefined ? undefined : e.target - e.size.height / 2)),
      UNASSIGNED_HEADER + UNASSIGNED_PADDING,
      UNASSIGNED_GAP,
    );
    const areaX = bandsWidth;
    let maxWidth = 0;
    let lowest = 0;
    entries.forEach((entry, k) => {
      const y = Math.round(starts[k] ?? 0);
      placeBox(entry.id, areaX + UNASSIGNED_PADDING, y);
      maxWidth = Math.max(maxWidth, entry.size.width);
      lowest = Math.max(lowest, y + entry.size.height);
    });
    unassignedArea = {
      x: areaX,
      y: 0,
      width: Math.max(UNASSIGNED_MIN_WIDTH, maxWidth + 2 * UNASSIGNED_PADDING),
      height: Math.max(totalBandHeight, lowest + UNASSIGNED_PADDING),
    };
  }

  // The band stack and the Unassigned area end at the same y. When the area is the taller one
  // the last band is drawn that much taller; nothing inside the bands moves.
  const stretch = Math.max(0, (unassignedArea?.height ?? 0) - totalBandHeight);
  const rows: RowBand[] = model.rows.map((row, r) => ({
    id: row.id,
    name: row.name,
    x: 0,
    y: bandTop(r),
    width: bandsWidth,
    height: (bandHeight[r] ?? 0) + (r === rowCount - 1 ? stretch : 0),
  }));

  // --- Assemble in model order.
  const rects = new Map<string, Rect>();
  const absoluteOrdered = new Map<string, Rect>();
  for (const id of model.nodes.keys()) {
    const rel = relative.get(id);
    const abs = absolute.get(id);
    if (!rel || !abs) throw new Error(`Node ${id} was not placed`);
    rects.set(id, rel);
    absoluteOrdered.set(id, abs);
  }
  return {
    rects,
    absolute: absoluteOrdered,
    rows,
    gutterWidth: ROW_GUTTER_WIDTH,
    ...(unassignedArea ? { unassignedArea } : {}),
    bounds: {
      width: unassignedArea ? unassignedArea.x + unassignedArea.width : bandsWidth,
      height: Math.max(totalBandHeight, unassignedArea?.height ?? 0),
    },
    placedRow,
    rowOf,
  };
}
