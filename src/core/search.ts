// Search for nodes by name and ID, and for work items by ID and title. Pure: no
// React, no browser APIs.

import type { ArchitectureModel, NodeLevel } from './model';
import type { WorkItemSummary } from './workitems';

/**
 * How well a node matches, best first:
 * 0 — the name or the ID equals the query;
 * 1 — the name or the ID starts with it;
 * 2 — a word of the name, or a segment of the ID, starts with it;
 * 3 — the name or the ID merely contains it.
 */
export type SearchRank = 0 | 1 | 2 | 3;

export interface SearchMatch {
  readonly id: string;
  readonly name: string;
  readonly level: NodeLevel;
  readonly rank: SearchRank;
}

const NO_MATCH = 4;

/** Rank of `query` in `text` (both lower case), or {@link NO_MATCH}. */
function rankIn(text: string, query: string, wordBreak: RegExp): number {
  const at = text.indexOf(query);
  if (at < 0) return NO_MATCH;
  if (text.length === query.length) return 0;
  if (at === 0) return 1;
  for (let i = at; i >= 0; i = text.indexOf(query, i + 1)) {
    if (wordBreak.test(text.charAt(i - 1))) return 2;
  }
  return 3;
}

const NAME_BREAK = /[^\p{L}\p{N}]/u;
const ID_BREAK = /[._-]/;

/**
 * Nodes whose name or ID contains `query`, ignoring case and surrounding white space. Ranked by
 * {@link SearchRank} (the better of the name's and the ID's rank), and in document order within
 * a rank, so the result is stable. An empty (or all-blank) query matches nothing.
 */
export function searchNodes(model: ArchitectureModel, query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const byRank: SearchMatch[][] = [[], [], [], []];
  for (const node of model.nodes.values()) {
    const rank = Math.min(
      rankIn(node.name.toLowerCase(), needle, NAME_BREAK),
      rankIn(node.id.toLowerCase(), needle, ID_BREAK),
    );
    if (rank >= NO_MATCH) continue;
    byRank[rank]?.push({
      id: node.id,
      name: node.name,
      level: node.level,
      rank: rank as SearchRank,
    });
  }
  return byRank.flat();
}

/** Index after moving `delta` steps through `count` results, wrapping around; -1 when empty. */
export function moveActiveIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

/** Free space kept between the results list and the window edges, in screen pixels. */
export const DROPDOWN_MARGIN = 8;

/**
 * Where to put a results list of `width` under the search box, whose left edge is at
 * `anchorLeft` on screen: the offset of the list's left edge from that edge. The list starts at
 * the left edge of the box where it then lies within a window of `viewportWidth` with `margin`
 * at the right, and is otherwise moved left just far enough; a list wider than the window starts
 * at the left margin, so that the start of every entry can be read.
 */
export function dropdownOffset(
  anchorLeft: number,
  width: number,
  viewportWidth: number,
  margin: number = DROPDOWN_MARGIN,
): number {
  const left = Math.max(margin, Math.min(anchorLeft, viewportWidth - margin - width));
  return left - anchorLeft;
}

// --- Work items ---------------------------------------------------------------------------------

export interface WorkItemMatch {
  readonly item: WorkItemSummary;
  readonly rank: SearchRank;
}

/**
 * Work items whose ID or title matches `query`, ignoring case and surrounding white space:
 * - `#12` (or digits alone) matches the IDs that start with those digits — rank 0 for the ID
 *   itself, 1 otherwise;
 * - any other text matches titles: ranked like node names when the title contains the query as
 *   it is, and rank 3 when it merely contains every word of it, in any order. Digits alone match
 *   titles too.
 *
 * Best rank first, by ID within a rank. An empty (or all-blank) query matches nothing.
 */
export function searchWorkItems(items: readonly WorkItemSummary[], query: string): WorkItemMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '' || needle === '#') return [];
  const idQuery = /^#?(\d+)$/.exec(needle)?.[1];
  const titleQuery = needle.startsWith('#') ? undefined : needle;
  const words = titleQuery?.split(/\s+/) ?? [];
  const byRank: WorkItemMatch[][] = [[], [], [], []];
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    let rank = NO_MATCH;
    if (idQuery !== undefined) {
      const id = String(item.id);
      if (id === idQuery) rank = 0;
      else if (id.startsWith(idQuery)) rank = 1;
    }
    if (titleQuery !== undefined) {
      const title = item.title.toLowerCase();
      rank = Math.min(rank, rankIn(title, titleQuery, NAME_BREAK));
      if (rank === NO_MATCH && words.length > 1 && words.every((word) => title.includes(word))) {
        rank = 3;
      }
    }
    if (rank < NO_MATCH) byRank[rank]?.push({ item, rank: rank as SearchRank });
  }
  return byRank.flat();
}
