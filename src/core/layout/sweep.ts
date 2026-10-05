// 1-D overlap removal for the Unassigned area.

interface Cluster {
  /** Index of the first member; members run up to the next cluster's `first`. */
  readonly first: number;
  /** From the first member's start to the last member's end. */
  readonly length: number;
  /** Sum over members with a preference of (desired start − offset within the cluster). */
  readonly sum: number;
  /** Number of members with a preference. */
  readonly weight: number;
  start: number;
}

/**
 * Places intervals of the given `sizes`, in the given order, as close as possible (least squares)
 * to their `desired` starts, without overlapping (at least `gap` apart) and not before `min`.
 * A `desired` of `undefined` means "no preference": the item goes right after its predecessor.
 *
 * Pool-adjacent-violators: each item starts its own cluster at its desired position; while a
 * cluster overlaps the one before it, the two merge and move to the mean of their members'
 * desired positions. Order is always kept.
 */
export function sweep1D(
  sizes: readonly number[],
  desired: readonly (number | undefined)[],
  min: number,
  gap: number,
): number[] {
  const clusters: Cluster[] = [];
  sizes.forEach((size, i) => {
    const want = desired[i];
    let cluster: Cluster = {
      first: i,
      length: size,
      sum: want ?? 0,
      weight: want === undefined ? 0 : 1,
      start: 0,
    };
    for (;;) {
      const prev = clusters[clusters.length - 1];
      const lowerBound = prev ? prev.start + prev.length + gap : min;
      const mean = cluster.weight > 0 ? cluster.sum / cluster.weight : -Infinity;
      if (!prev || mean >= lowerBound || cluster.weight === 0) {
        cluster.start = Math.max(mean, lowerBound);
        break;
      }
      clusters.pop();
      const shift = prev.length + gap;
      cluster = {
        first: prev.first,
        length: shift + cluster.length,
        sum: prev.sum + cluster.sum - cluster.weight * shift,
        weight: prev.weight + cluster.weight,
        start: 0,
      };
    }
    clusters.push(cluster);
  });

  const starts: number[] = [];
  clusters.forEach((cluster, k) => {
    const end = clusters[k + 1]?.first ?? sizes.length;
    let at = cluster.start;
    for (let i = cluster.first; i < end; i++) {
      starts.push(at);
      at += (sizes[i] ?? 0) + gap;
    }
  });
  return starts;
}
