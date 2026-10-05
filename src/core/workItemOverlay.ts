// Work items laid over the structure: which items each node lists, the
// counts its badge shows, and what the diagnostics panel reports about the tags. Pure.

import type { Diagnostic } from './diagnostics';
import { subtreeIds } from './layout/tree';
import type { ArchitectureModel } from './model';
import { plural } from './text';
import type { WorkItemSummary } from './workitems';

/**
 * States in which a work item is no longer open, lower-cased. An "open bug" is a Bug in any
 * other state.
 */
export const CLOSED_STATES: ReadonlySet<string> = new Set([
  'closed',
  'done',
  'removed',
  'resolved',
]);

export function isOpenState(state: string): boolean {
  return !CLOSED_STATES.has(state.trim().toLowerCase());
}

/** Which work items the overlay leaves out. */
export interface WorkItemFilter {
  /** States to hide, e.g. Closed; compared without regard to letter case. */
  readonly hiddenStates?: Iterable<string>;
  /**
   * When set, only items of this iteration are shown — or of an iteration under it: a parent
   * path such as a programme increment covers its sprints (see {@link inIteration}).
   */
  readonly iteration?: string;
  /** Hide the completed items: those in one of the {@link CLOSED_STATES}. */
  readonly hideCompleted?: boolean;
}

/** A work item listed on a node, with the tasks listed under it. */
export interface WorkItemRow {
  readonly item: WorkItemSummary;
  /** Its tasks that pass the filter, by ID. */
  readonly tasks: readonly WorkItemSummary[];
}

/** The numbers of a badge. */
export interface WorkItemCounts {
  /** Top-level items of every type (stories, bugs, features, epics, tasks without a parent). */
  readonly stories: number;
  /** The Bugs among them that are still open (see {@link CLOSED_STATES}). */
  readonly openBugs: number;
}

const NO_COUNTS: WorkItemCounts = { stories: 0, openBugs: 0 };

export interface WorkItemOverlay {
  /** Every item given, filtered or not, by ID (the detail panel can show any of them). */
  readonly byId: ReadonlyMap<number, WorkItemSummary>;
  /** The items that pass the filter, by ID. */
  readonly shown: readonly WorkItemSummary[];
  /** Their IDs: what can be selected and searched for. */
  readonly shownIds: ReadonlySet<number>;
  /** Per node with rows of its own: the top-level items tagged to it, by ID. */
  readonly rows: ReadonlyMap<string, readonly WorkItemRow[]>;
  /** Per node: the counts of the items tagged to the node itself. Nodes without any are absent. */
  readonly ownCounts: ReadonlyMap<string, WorkItemCounts>;
  /**
   * Per node: the counts over the node and all its descendants. An item tagged to several nodes
   * of one subtree counts once. Nodes with nothing in their subtree are absent.
   */
  readonly counts: ReadonlyMap<string, WorkItemCounts>;
  /** Shown item → the shown item it is listed under as a task. */
  readonly listedUnder: ReadonlyMap<number, number>;
  /** Shown item → the nodes it is drawn on: its own rows, or the rows of the item above it. */
  readonly nodesOf: ReadonlyMap<number, readonly string[]>;
}

function passes(
  item: WorkItemSummary,
  hidden: ReadonlySet<string>,
  filter: WorkItemFilter,
): boolean {
  if (hidden.has(item.state.trim().toLowerCase())) return false;
  if (filter.hideCompleted === true && !isOpenState(item.state)) return false;
  return filter.iteration === undefined || inIteration(item.iteration, filter.iteration);
}

/** Separator of the levels of an ADO iteration path (`Project\PI 3\Sprint 13`). */
export const ITERATION_SEPARATOR = '\\';

/**
 * True when `iteration` is `scope` itself or lies under it: `Shop\Sprint 13` is in the scope
 * `Shop`. An item without an iteration is in no scope.
 */
export function inIteration(iteration: string | undefined, scope: string): boolean {
  if (iteration === undefined) return false;
  return iteration === scope || iteration.startsWith(`${scope}${ITERATION_SEPARATOR}`);
}

/**
 * The overlay of `items` on `model`:
 * - Stories, Bugs, Features and Epics are top-level rows on every node they are tagged to;
 * - a Task whose parent is shown as a row is listed under that parent wherever the parent is,
 *   and its own `comp:` tags then place nothing; an untagged Task of a task that is listed
 *   under a row is listed under that same row; any other Task is a row of its own on the nodes
 *   it is tagged to;
 * - a Task without a `comp:` tag under tasks the filter hides, themselves without one, belongs
 *   to the first shown item above them as if it were its parent;
 * - a Task without a `comp:` tag whose parent the filter hides is a row of its own on the
 *   nodes of that parent (so hiding Closed stories, or showing one iteration, keeps the tasks
 *   that pass);
 * - items the filter hides are in no row and no count; tags naming unknown nodes place nothing.
 *
 * Rows and tasks are ordered by ID, so the result does not depend on the order of `items`.
 */
export function buildWorkItemOverlay(
  model: ArchitectureModel,
  items: readonly WorkItemSummary[],
  filter: WorkItemFilter = {},
): WorkItemOverlay {
  const hidden = new Set<string>();
  for (const state of filter.hiddenStates ?? []) hidden.add(state.trim().toLowerCase());
  const byId = new Map<number, WorkItemSummary>();
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const shown = [...byId.values()].filter((item) => passes(item, hidden, filter));
  const shownIds = new Set(shown.map((item) => item.id));
  const knownNodes = (item: WorkItemSummary): string[] =>
    item.componentIds.filter((id) => model.nodes.has(id));
  // Where an item is a row when it is one: the nodes it is tagged to; a task without any takes
  // the place of the parent the filter hides (up the chain, as far as it is hidden tasks).
  // (A loop, not a recursion: the chain is as long as the file makes it.)
  const placement = (item: WorkItemSummary): string[] => {
    const seen = new Set<number>();
    let current = item;
    for (;;) {
      const own = knownNodes(current);
      if (own.length > 0 || current.type !== 'Task' || current.parentId === undefined) return own;
      const parent = byId.get(current.parentId);
      if (!parent || shownIds.has(parent.id) || seen.has(current.id)) return own;
      seen.add(current.id);
      current = parent;
    }
  };
  // The shown item a task hangs under: its parent, or for a task that names no node the first
  // shown item up a chain of tasks the filter hides that name none either (such a chain gives
  // the task no place of its own, see `placement`).
  const shownParent = (item: WorkItemSummary): WorkItemSummary | undefined => {
    if (item.type !== 'Task') return undefined;
    const seen = new Set<number>();
    let current = item;
    while (current.parentId !== undefined && !seen.has(current.id)) {
      const parent = byId.get(current.parentId);
      if (!parent) return undefined;
      if (shownIds.has(parent.id)) return parent;
      if (knownNodes(item).length > 0) return undefined;
      if (parent.type !== 'Task' || knownNodes(parent).length > 0) return undefined;
      seen.add(current.id);
      current = parent;
    }
    return undefined;
  };

  // Which shown items are rows of their own. Tasks may hang under tasks, so this is resolved
  // along the parent chain; a chain that runs in a circle ends where it comes back.
  const isRow = new Map<number, boolean>();
  const resolving = new Set<number>();
  const listedUnder = new Map<number, number>();
  const resolveRow = (item: WorkItemSummary): boolean => {
    const known = isRow.get(item.id);
    if (known !== undefined) return known;
    if (resolving.has(item.id)) return false;
    resolving.add(item.id);
    let row = placement(item).length > 0;
    const parent = shownParent(item);
    if (parent !== undefined) {
      // Under the parent when it is a row. A task of a task that is itself listed under a row
      // has no line to hang under: with a tag of its own it stays a row, without one it joins
      // the list of that row, the nearest item above it that has a line.
      const host = resolveRow(parent) ? parent.id : row ? undefined : listedUnder.get(parent.id);
      if (host !== undefined) {
        listedUnder.set(item.id, host);
        row = false;
      }
    }
    resolving.delete(item.id);
    isRow.set(item.id, row);
    return row;
  };
  for (const item of shown) {
    // The items above it first, from the top down, so that `resolveRow` finds its parent known
    // and goes no deeper than one step however long the chain of tasks is. (A chain that runs
    // in a circle has no top: it is left to `resolveRow`, which ends where it comes back.)
    const above: WorkItemSummary[] = [];
    const onChain = new Set<number>([item.id]);
    let parent = shownParent(item);
    while (parent !== undefined && !isRow.has(parent.id) && !onChain.has(parent.id)) {
      above.push(parent);
      onChain.add(parent.id);
      parent = shownParent(parent);
    }
    if (parent === undefined || isRow.has(parent.id)) {
      for (let i = above.length - 1; i >= 0; i--) {
        const ancestor = above[i];
        if (ancestor) resolveRow(ancestor);
      }
    }
    resolveRow(item);
  }

  const tasksOf = new Map<number, WorkItemSummary[]>();
  for (const item of shown) {
    const parentId = listedUnder.get(item.id);
    if (parentId === undefined) continue;
    const tasks = tasksOf.get(parentId) ?? [];
    tasks.push(item);
    tasksOf.set(parentId, tasks);
  }

  const rows = new Map<string, WorkItemRow[]>();
  const nodesOf = new Map<number, readonly string[]>();
  for (const item of shown) {
    if (isRow.get(item.id) !== true) continue;
    const nodeIds = placement(item);
    nodesOf.set(item.id, nodeIds);
    for (const nodeId of nodeIds) {
      const list = rows.get(nodeId) ?? [];
      list.push({ item, tasks: tasksOf.get(item.id) ?? [] });
      rows.set(nodeId, list);
    }
  }
  for (const [taskId, parentId] of listedUnder) nodesOf.set(taskId, nodesOf.get(parentId) ?? []);

  // Counts: the distinct top-level items of each node, and of each subtree (reverse document
  // order visits every child before its parent).
  const countOf = (ids: ReadonlySet<number>): WorkItemCounts => {
    let openBugs = 0;
    for (const id of ids) {
      const item = byId.get(id);
      if (item?.type === 'Bug' && isOpenState(item.state)) openBugs += 1;
    }
    return { stories: ids.size, openBugs };
  };
  const ownCounts = new Map<string, WorkItemCounts>();
  const counts = new Map<string, WorkItemCounts>();
  const subtree = new Map<string, Set<number>>();
  const nodes = [...model.nodes.values()];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node) continue;
    const own = new Set((rows.get(node.id) ?? []).map((row) => row.item.id));
    const all = new Set(own);
    for (const child of node.childIds) for (const id of subtree.get(child) ?? []) all.add(id);
    subtree.set(node.id, all);
    if (own.size > 0) ownCounts.set(node.id, countOf(own));
    if (all.size > 0) counts.set(node.id, countOf(all));
  }

  // Maps keyed by node in document order, whatever order the items came in.
  const orderedRows = new Map<string, readonly WorkItemRow[]>();
  const orderedOwn = new Map<string, WorkItemCounts>();
  const orderedCounts = new Map<string, WorkItemCounts>();
  for (const node of nodes) {
    const nodeRows = rows.get(node.id);
    if (nodeRows) orderedRows.set(node.id, nodeRows);
    const own = ownCounts.get(node.id);
    if (own) orderedOwn.set(node.id, own);
    const all = counts.get(node.id);
    if (all) orderedCounts.set(node.id, all);
  }
  return {
    byId,
    shown,
    shownIds,
    rows: orderedRows,
    ownCounts: orderedOwn,
    counts: orderedCounts,
    listedUnder,
    nodesOf,
  };
}

/** An overlay without any work item. */
export function emptyWorkItemOverlay(model: ArchitectureModel): WorkItemOverlay {
  return buildWorkItemOverlay(model, []);
}

/** The item with `id`, shown or filtered out; undefined when there is none. */
export function workItemById(overlay: WorkItemOverlay, id: number): WorkItemSummary | undefined {
  return overlay.byId.get(id);
}

/** Counts of the items tagged to `nodeId` itself. */
export function ownWorkItemCounts(overlay: WorkItemOverlay, nodeId: string): WorkItemCounts {
  return overlay.ownCounts.get(nodeId) ?? NO_COUNTS;
}

/** Counts of the items tagged to `nodeId` or anything below it. */
export function subtreeWorkItemCounts(overlay: WorkItemOverlay, nodeId: string): WorkItemCounts {
  return overlay.counts.get(nodeId) ?? NO_COUNTS;
}

/** Counts in words, as the tooltip of a badge says them, e.g. "5 work items · 1 open bug". */
export function workItemCountsText(counts: WorkItemCounts): string {
  const parts = [plural(counts.stories, 'work item')];
  if (counts.openBugs > 0) parts.push(plural(counts.openBugs, 'open bug'));
  return parts.join(' · ');
}

/** The rows of one node, as the detail panel groups them. */
export interface NodeWorkItems {
  readonly nodeId: string;
  readonly rows: readonly WorkItemRow[];
}

/**
 * The work items of `nodeId`: its own rows first, then (with `descendants`) those of every node
 * below it that has any, in document order. Nodes without rows are left out; an unknown node
 * gives nothing.
 */
export function workItemsOfNode(
  model: ArchitectureModel,
  overlay: WorkItemOverlay,
  nodeId: string,
  options: { readonly descendants?: boolean } = {},
): NodeWorkItems[] {
  if (!model.nodes.has(nodeId)) return [];
  const ids = options.descendants === true ? subtreeIds(model, nodeId) : [nodeId];
  return ids.flatMap((id) => {
    const rows = overlay.rows.get(id);
    return rows && rows.length > 0 ? [{ nodeId: id, rows }] : [];
  });
}

/**
 * The shown items whose parent is `id`, by ID: the tasks of a story (whether or not they are
 * listed under it on the canvas), the stories of a feature, the features of an epic.
 */
export function childWorkItems(overlay: WorkItemOverlay, id: number): WorkItemSummary[] {
  return overlay.shown.filter((item) => item.parentId === id);
}

/**
 * The filter to apply to `items` for the stored choices: the hidden states as they are, and the
 * iteration only when some item has it — a stored iteration that the loaded file does not know
 * would otherwise hide everything, with no entry in the list to switch it off.
 */
export function usableWorkItemFilter(
  items: readonly WorkItemSummary[],
  hiddenStates: readonly string[],
  iteration: string | undefined,
  hideCompleted = false,
): WorkItemFilter {
  const known =
    iteration !== undefined && items.some((item) => inIteration(item.iteration, iteration));
  return {
    hiddenStates,
    ...(known ? { iteration } : {}),
    ...(hideCompleted ? { hideCompleted } : {}),
  };
}

/** `hiddenStates` with `state` added or removed (compared without regard to case), sorted. */
export function toggleHiddenState(hiddenStates: readonly string[], state: string): string[] {
  const key = state.trim().toLowerCase();
  const rest = hiddenStates.filter((entry) => entry.trim().toLowerCase() !== key);
  return (rest.length === hiddenStates.length ? [...rest, state.trim()] : rest).sort();
}

/** True when `state` is among `hiddenStates` (compared without regard to case). */
export function isHiddenState(hiddenStates: readonly string[], state: string): boolean {
  const key = state.trim().toLowerCase();
  return hiddenStates.some((entry) => entry.trim().toLowerCase() === key);
}

/** The shown tasks listed under item `id`, by ID. */
export function tasksOfWorkItem(overlay: WorkItemOverlay, id: number): WorkItemSummary[] {
  return overlay.shown.filter((item) => overlay.listedUnder.get(item.id) === id);
}

/**
 * The nodes work item `id` is drawn on: the nodes it is a row of, or for a task listed under
 * another item that item's nodes, or for an untagged task of a filtered-out parent that
 * parent's nodes. Empty when it is filtered out, untagged or unknown.
 */
export function workItemNodeIds(overlay: WorkItemOverlay, id: number): readonly string[] {
  return overlay.nodesOf.get(id) ?? [];
}

/** States in the order they usually progress; other states follow alphabetically. */
const STATE_ORDER = ['new', 'active', 'resolved', 'closed', 'done', 'removed'];

/**
 * The distinct states of `items`, for the filter controls: workflow order, then alphabetical.
 * States that differ only in letter case or in spaces around them are one state, as the filter
 * treats them; it is named as the first item (by ID) spells it.
 */
export function availableStates(items: readonly WorkItemSummary[]): string[] {
  const rank = (state: string): number => {
    const index = STATE_ORDER.indexOf(state.toLowerCase());
    return index === -1 ? STATE_ORDER.length : index;
  };
  const spelling = new Map<string, string>();
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    const state = item.state.trim();
    const key = state.toLowerCase();
    if (!spelling.has(key)) spelling.set(key, state);
  }
  return [...spelling.values()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en'));
}

/**
 * The distinct iterations of `items` and every path above them (`Shop` for `Shop\Sprint
 * 13`: a programme increment, a release), for the filter controls, sorted so that a path comes
 * right before what lies under it.
 */
export function availableIterations(items: readonly WorkItemSummary[]): string[] {
  const iterations = new Set<string>();
  for (const item of items) {
    if (item.iteration === undefined) continue;
    const levels = item.iteration.split(ITERATION_SEPARATOR);
    for (let depth = 1; depth <= levels.length; depth++) {
      iterations.add(levels.slice(0, depth).join(ITERATION_SEPARATOR));
    }
  }
  return [...iterations].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * The first `count` words of `text`, followed by "…" when there are more: what a task shows on
 * the canvas (the full text is in the detail panel).
 */
export function firstWords(text: string, count: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= count) return words.join(' ');
  return `${words.slice(0, Math.max(0, count)).join(' ')}…`;
}

// --- Diagnostics ----------------------------------------------------------------------------

/** A `comp:` tag that names no node of the structure. */
export interface UnknownComponentTag {
  readonly item: WorkItemSummary;
  readonly componentId: string;
}

export interface TagCoverage {
  /** Items linked to the structure: with a `comp:` tag, or tasks of an item with one. */
  readonly tagged: number;
  /** The items covered: those that pass the filter. */
  readonly total: number;
  /** The items the filter leaves out, which are not covered. */
  readonly hidden: number;
  /** `tagged / total` in whole percent (rounded down, so 100 means every item); 100 when empty. */
  readonly percent: number;
}

export interface WorkItemTagReport {
  /** Of every item, filtered out or not; in item order (by ID), then tag order. */
  readonly unknown: readonly UnknownComponentTag[];
  /**
   * The shown items with no `comp:` tag, by ID. A task whose parent has one (or, for a task of a
   * task, an item further up) is not among them, whether or not the filter hides that parent.
   */
  readonly untagged: readonly WorkItemSummary[];
  readonly coverage: TagCoverage;
}

/**
 * What the diagnostics panel reports about the tags: the tags naming
 * unknown nodes — a fault of the file, so of every item — and, of the items that pass `filter`
 * (the ones the map shows), those without any `comp:` tag and the tag coverage.
 */
export function workItemTagReport(
  model: ArchitectureModel,
  items: readonly WorkItemSummary[],
  filter: WorkItemFilter = {},
): WorkItemTagReport {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const byId = new Map(sorted.map((item) => [item.id, item]));
  const hiddenStates = new Set<string>();
  for (const state of filter.hiddenStates ?? []) hiddenStates.add(state.trim().toLowerCase());
  // Linked to the structure: a `comp:` tag of its own, or for a task one on the item above it —
  // its parent, or up a chain of tasks the first item that has one.
  const linkedByTag = (item: WorkItemSummary): boolean => {
    const seen = new Set<number>();
    let current: WorkItemSummary | undefined = item;
    while (current !== undefined && !seen.has(current.id)) {
      if (current.componentIds.length > 0) return true;
      if (current.type !== 'Task' || current.parentId === undefined) return false;
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return false;
  };
  const unknown: UnknownComponentTag[] = [];
  const untagged: WorkItemSummary[] = [];
  let total = 0;
  for (const item of sorted) {
    for (const componentId of item.componentIds) {
      if (!model.nodes.has(componentId)) unknown.push({ item, componentId });
    }
    if (!passes(item, hiddenStates, filter)) continue;
    total += 1;
    if (!linkedByTag(item)) untagged.push(item);
  }
  const tagged = total - untagged.length;
  return {
    unknown,
    untagged,
    coverage: {
      tagged,
      total,
      hidden: sorted.length - total,
      percent: total === 0 ? 100 : Math.floor((tagged / total) * 100),
    },
  };
}

/** How many untagged items a diagnostic names before it says "and k more". */
const UNTAGGED_LISTED = 20;

/**
 * The tag report as diagnostics: a warning per tag that names an unknown node, and one warning
 * with the count, the tag coverage and the list of the items without a `comp:` tag — of the
 * items that pass `filter`, see {@link workItemTagReport}.
 */
export function workItemDiagnostics(
  model: ArchitectureModel,
  items: readonly WorkItemSummary[],
  sourceName?: string,
  filter: WorkItemFilter = {},
): Diagnostic[] {
  const report = workItemTagReport(model, items, filter);
  const source = sourceName === undefined ? {} : { source: sourceName };
  const diagnostics: Diagnostic[] = report.unknown.map(({ item, componentId }) => ({
    severity: 'warning',
    path: `#${item.id}`,
    message: `${item.type} #${item.id} "${item.title}" is tagged comp:${componentId}, which is not a node of the structure.`,
    ...source,
  }));
  if (report.untagged.length > 0) {
    const { coverage, untagged } = report;
    const listed = untagged.slice(0, UNTAGGED_LISTED).map((item) => `#${item.id} ${item.title}`);
    const rest = untagged.length - listed.length;
    diagnostics.push({
      severity: 'warning',
      path: '',
      message:
        `${plural(untagged.length, 'work item')} of ${coverage.total}${coverage.hidden > 0 ? ' shown' : ''} ` +
        `${untagged.length === 1 ? 'has' : 'have'} no comp: tag (tag coverage ${coverage.percent}%): ` +
        `${listed.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`,
      ...source,
    });
  }
  return diagnostics;
}
