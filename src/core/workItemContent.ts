// What a node lists of its work items, line by line, and how much room that takes.
// The layout reserves exactly this room and the canvas draws the lines in it, both from the one
// geometry object below. Pure.

import type { Rect, Size } from './layout/types';
import { estimateTextWidth } from './text';
import { firstWords, workItemNodeIds, type WorkItemOverlay } from './workItemOverlay';
import type { StoryMode, WorkItemSummary } from './workitems';

/**
 * Geometry of the work-item lines inside a node, in canvas pixels. The one place for these
 * numbers: the reserved block is sized from them here, and the style sheet gets them as custom
 * properties, so what is reserved is what is drawn.
 */
export const WORK_ITEM_GEOMETRY = {
  /** Height of every line: an item, a task, or "+k more". */
  lineHeight: 22,
  /** Font size of an item title, and of a task text. */
  fontSize: 13,
  taskFontSize: 12,
  /** Type icon (a square) and the gap between it and the text. */
  iconSize: 14,
  iconGap: 6,
  /** How far a task is indented under its item. */
  taskIndent: 18,
  /** Padding of the block around the lines. */
  paddingX: 10,
  paddingTop: 2,
  paddingBottom: 6,
  /** A title longer than this many characters is cut off with an ellipsis. */
  maxTitleChars: 28,
  /** Words of a task title shown on the canvas before the ellipsis. */
  taskWords: 3,
  /** The same cut for a task whose first words are very long. */
  maxTaskChars: 30,
  /** Lines per node; a longer list ends with "+k more" as its last line. */
  maxLines: 8,
  /** Widths are rounded up to a multiple of this, like the rest of the layout. */
  widthStep: 8,
  /**
   * The badge with the counts, drawn where the lines are not (coarser levels, closed groups):
   * its height and font size. It is never higher than a block of one line.
   */
  badgeHeight: 20,
  badgeFontSize: 12,
} as const;

/** One line of a node's work-item block. */
export type WorkItemLine =
  | {
      readonly kind: 'item';
      readonly item: WorkItemSummary;
      /** The title as reserved for: cut to `maxTitleChars` (the canvas also ellipsizes). */
      readonly text: string;
    }
  | {
      readonly kind: 'task';
      readonly item: WorkItemSummary;
      /** ID of the item the task is listed under. */
      readonly parentId: number;
      /** The first words of the task title, with "…" when there are more. */
      readonly text: string;
    }
  | {
      readonly kind: 'more';
      /** Lines left out. */
      readonly count: number;
      readonly text: string;
    };

/** The work-item block of one node: its lines and the room they need. */
export interface NodeContent extends Size {
  readonly lines: readonly WorkItemLine[];
}

function cut(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars
    ? text
    : `${chars
        .slice(0, maxChars - 1)
        .join('')
        .trimEnd()}…`;
}

/** Text of the line that stands for `count` lines left out. */
export function moreLinesText(count: number): string {
  return `+${count} more`;
}

function lineWidth(line: WorkItemLine): number {
  const g = WORK_ITEM_GEOMETRY;
  switch (line.kind) {
    case 'item':
      return g.iconSize + g.iconGap + estimateTextWidth(line.text, g.fontSize);
    case 'task':
      return g.taskIndent + g.iconSize + g.iconGap + estimateTextWidth(line.text, g.taskFontSize);
    case 'more':
      return estimateTextWidth(line.text, g.taskFontSize);
  }
}

/**
 * The lines node `nodeId` lists in `mode`: its top-level items by ID and, in mode `tasks`, under
 * each one its tasks. At most `maxLines` lines: a longer list keeps the first `maxLines − 1` and
 * ends with "+k more". Empty in mode `off` and for a node without items.
 */
export function workItemLines(
  overlay: WorkItemOverlay,
  nodeId: string,
  mode: StoryMode,
): WorkItemLine[] {
  if (mode === 'off') return [];
  const g = WORK_ITEM_GEOMETRY;
  const lines: WorkItemLine[] = [];
  for (const row of overlay.rows.get(nodeId) ?? []) {
    lines.push({ kind: 'item', item: row.item, text: cut(row.item.title, g.maxTitleChars) });
    if (mode !== 'tasks') continue;
    for (const task of row.tasks) {
      lines.push({
        kind: 'task',
        item: task,
        parentId: row.item.id,
        text: cut(firstWords(task.title, g.taskWords), g.maxTaskChars),
      });
    }
  }
  if (lines.length <= g.maxLines) return lines;
  const kept = lines.slice(0, g.maxLines - 1);
  const count = lines.length - kept.length;
  return [...kept, { kind: 'more', count, text: moreLinesText(count) }];
}

/** Room the given lines need: padding, one line height each, the widest line. */
export function workItemBlockSize(lines: readonly WorkItemLine[]): Size {
  const g = WORK_ITEM_GEOMETRY;
  const widest = Math.max(0, ...lines.map(lineWidth));
  return {
    width: Math.ceil((2 * g.paddingX + widest) / g.widthStep) * g.widthStep,
    height: g.paddingTop + lines.length * g.lineHeight + g.paddingBottom,
  };
}

/**
 * The part of the reserved `block` in which `lines` are drawn: its left part, as wide as the
 * lines need (`workItemBlockSize`). The block of a leaf is exactly that wide; the one of a group
 * runs along the whole group, and only this part of it is covered by the list — the rest stays
 * free for the edges that cross the group.
 */
export function workItemLinesRect(block: Rect, lines: readonly WorkItemLine[]): Rect {
  return { ...block, width: Math.min(block.width, workItemBlockSize(lines).width) };
}

/**
 * Where the texts of `lines` are, icons included, when the list is drawn in `list` (the block
 * of a leaf, or `workItemLinesRect` of a group's): one box per line, in the coordinates of
 * `list`. Upper estimates — an item shows as much of its title as the list has room for.
 * What an edge label must not lie on (`placeLabel`).
 */
export function workItemTextRects(list: Rect, lines: readonly WorkItemLine[]): Rect[] {
  const g = WORK_ITEM_GEOMETRY;
  const room = Math.max(0, list.width - 2 * g.paddingX);
  return lines.map((line, index) => {
    const drawn =
      line.kind === 'item'
        ? g.iconSize + g.iconGap + estimateTextWidth(line.item.title, g.fontSize)
        : lineWidth(line);
    return {
      x: list.x + g.paddingX,
      y: list.y + g.paddingTop + index * g.lineHeight,
      width: Math.min(room, drawn),
      height: g.lineHeight,
    };
  });
}

/**
 * Where the line of work item `id` is within `block` (same coordinates as `block`): the first
 * line that shows it. Undefined when no line does (it is under "+k more", or not listed here).
 */
export function workItemLineRect(
  block: Rect,
  lines: readonly WorkItemLine[],
  id: number,
): Rect | undefined {
  const g = WORK_ITEM_GEOMETRY;
  const index = lines.findIndex((line) => line.kind !== 'more' && line.item.id === id);
  if (index === -1) return undefined;
  const list = workItemLinesRect(block, lines);
  return {
    x: list.x,
    y: list.y + g.paddingTop + index * g.lineHeight,
    width: list.width,
    height: g.lineHeight,
  };
}

/**
 * The work-item block of every node that lists something in `mode`, in the order of
 * `overlay.rows` (document order). This is the content the layout reserves room for
 * (`computeLayout`'s `content`); it depends on the work items, the filter and the mode only,
 * never on zoom or collapse. Empty in mode `off`.
 */
export function workItemContent(
  overlay: WorkItemOverlay,
  mode: StoryMode,
): Map<string, NodeContent> {
  const content = new Map<string, NodeContent>();
  if (mode === 'off') return content;
  for (const nodeId of overlay.rows.keys()) {
    const lines = workItemLines(overlay, nodeId, mode);
    if (lines.length > 0) content.set(nodeId, { ...workItemBlockSize(lines), lines });
  }
  return content;
}

// --- Where an item is on the canvas -------------------------------------------------------------

/**
 * Whether the canvas draws a work item as a line, and if not, why:
 * - `drawn`: it is a line of at least one node (at the `detail` level, in an open box);
 * - `off`: the story mode is Off;
 * - `tasks-off`: it is a task listed under another item, and the mode shows no tasks;
 * - `folded`: every node that lists it has more lines than fit, and it is under "+k more";
 * - `unplaced`: it has no `comp:` tag that names a node (nor a parent that places it);
 * - `filtered`: the filter (state, iteration) leaves it out;
 * - `unknown`: there is no such item.
 */
export type WorkItemPlaceStatus =
  'drawn' | 'off' | 'tasks-off' | 'folded' | 'unplaced' | 'filtered' | 'unknown';

export interface WorkItemPlace {
  readonly status: WorkItemPlaceStatus;
  /** The nodes that list the item (`workItemNodeIds`), whatever the mode. */
  readonly nodeIds: readonly string[];
  /** Of those, the nodes whose lines include it in `mode`; empty unless `drawn`. */
  readonly drawnOn: readonly string[];
}

/** Where work item `id` is on the canvas in `mode` (see {@link WorkItemPlaceStatus}). */
export function workItemPlace(
  overlay: WorkItemOverlay,
  mode: StoryMode,
  id: number,
): WorkItemPlace {
  const place = (status: WorkItemPlaceStatus, nodeIds: readonly string[] = []): WorkItemPlace => ({
    status,
    nodeIds,
    drawnOn: [],
  });
  const item = overlay.byId.get(id);
  if (!item) return place('unknown');
  if (!overlay.shownIds.has(id)) return place('filtered');
  const nodeIds = workItemNodeIds(overlay, id);
  if (nodeIds.length === 0) return place('unplaced');
  if (mode === 'off') return place('off', nodeIds);
  if (mode !== 'tasks' && overlay.listedUnder.has(id)) return place('tasks-off', nodeIds);
  const drawnOn = nodeIds.filter((nodeId) =>
    workItemLines(overlay, nodeId, mode).some(
      (line) => line.kind !== 'more' && line.item.id === id,
    ),
  );
  return drawnOn.length > 0 ? { status: 'drawn', nodeIds, drawnOn } : place('folded', nodeIds);
}
