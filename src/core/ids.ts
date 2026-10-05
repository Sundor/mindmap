// ID rules and "did you mean" suggestions.

/** One ID segment: lowercase letters and digits, optionally joined by single '-' or '_'. */
export const ID_SEGMENT_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Human-readable description of the ID rule, for error messages. */
export const ID_RULE =
  "lowercase letters and digits, optionally joined by '-' or '_', in dot-separated segments";

/** True when `id` is one or more valid segments separated by '.'. */
export function isValidId(id: string): boolean {
  return id.split('.').every((segment) => ID_SEGMENT_PATTERN.test(segment));
}

/** True when `id` is exactly one valid segment (domain and row IDs). */
export function isValidSegment(id: string): boolean {
  return ID_SEGMENT_PATTERN.test(id);
}

/** Edit distance counting insertions, deletions, substitutions and adjacent transpositions. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  // rows[i][j] = distance between a[0, i) and b[0, j)
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (rows[i - 1]?.[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (rows[i - 1]?.[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (rows[i - 2]?.[j - 2] ?? 0) + 1);
      }
      row[j] = best;
    }
    rows.push(row);
  }
  return rows[a.length]?.[b.length] ?? 0;
}

/**
 * Closest candidate to `input`, or undefined when nothing is plausibly what was meant.
 * Matches are case-insensitive; a candidate whose last segment equals the input also counts
 * (e.g. `reader` → `ingest.reader`). Ties go to the earliest candidate.
 */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  const needle = input.toLowerCase();
  // Short inputs only match case-insensitively; longer ones tolerate up to 3 edits.
  const maxDistance = Math.min(3, Math.floor(needle.length / 3));
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate === input) continue;
    const hay = candidate.toLowerCase();
    let score = editDistance(needle, hay);
    if (score > maxDistance) {
      const lastSegment = hay.slice(hay.lastIndexOf('.') + 1);
      score = lastSegment === needle ? maxDistance + 0.5 : Infinity;
    }
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** `; did you mean "x"?` or '' — ready to append to a message. */
export function didYouMean(input: string, candidates: Iterable<string>): string {
  const match = suggest(input, candidates);
  return match === undefined ? '' : `; did you mean "${match}"?`;
}
