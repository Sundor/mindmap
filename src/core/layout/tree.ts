// Small tree helpers over the flat node map.

import type { ArchitectureModel } from '../model';

/** `id` followed by its ancestors, nearest first. Unknown IDs yield just `[id]`. */
export function selfAndAncestors(model: ArchitectureModel, id: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = id;
  while (current !== undefined) {
    chain.push(current);
    current = model.nodes.get(current)?.parentId;
  }
  return chain;
}

/** True when `id` is `ancestorId` or one of its descendants. */
export function isWithin(model: ArchitectureModel, id: string, ancestorId: string): boolean {
  return selfAndAncestors(model, id).includes(ancestorId);
}

/** `rootId` and all its descendants, parents before children, in YAML order. */
export function subtreeIds(model: ArchitectureModel, rootId: string): string[] {
  const out: string[] = [];
  const visit = (id: string): void => {
    out.push(id);
    for (const child of model.nodes.get(id)?.childIds ?? []) visit(child);
  };
  visit(rootId);
  return out;
}

/**
 * The node an edge between `a` and `b` belongs to in a compound graph: the ancestor when one
 * endpoint contains the other, otherwise their lowest common ancestor. `undefined` = the canvas.
 */
export function edgeContainer(model: ArchitectureModel, a: string, b: string): string | undefined {
  const chainA = selfAndAncestors(model, a);
  const chainB = new Set(selfAndAncestors(model, b));
  if (chainB.has(a)) return a;
  if (chainA.includes(b)) return b;
  return chainA.slice(1).find((id) => chainB.has(id));
}
