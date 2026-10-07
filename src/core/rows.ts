// Row ranges: which of the rows of a model each node occupies. Pure.

import type { ArchRow, RowRange } from './model';

/**
 * The rows each node occupies, as indexes into `rows`: its effective row, else the span from the
 * top-most to the bottom-most row used below it; no entry when nothing in its subtree has a row.
 * `nodes` in document order (parents before children).
 */
export function rowRanges(
  rows: readonly ArchRow[],
  nodes: Iterable<{
    readonly id: string;
    readonly effectiveRow?: string | undefined;
    readonly childIds: readonly string[];
  }>,
): Map<string, RowRange> {
  const rowIndex = new Map(rows.map((row, i) => [row.id, i]));
  // Children come after their parents in document order, so walking it backwards
  // computes every child's range before its parent needs it.
  const ranges = new Map<string, RowRange>();
  const ordered = [...nodes];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = ordered[i];
    if (!node) continue;
    const own = node.effectiveRow === undefined ? undefined : rowIndex.get(node.effectiveRow);
    let range: RowRange | undefined = own === undefined ? undefined : { top: own, bottom: own };
    if (range === undefined) {
      for (const childId of node.childIds) {
        const child = ranges.get(childId);
        if (!child) continue;
        range = range
          ? { top: Math.min(range.top, child.top), bottom: Math.max(range.bottom, child.bottom) }
          : child;
      }
    }
    if (range) ranges.set(node.id, range);
  }
  return ranges;
}
