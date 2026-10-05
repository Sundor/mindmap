// Authoring hints: what an author could add to make the map say more. Not
// problems — the file is valid — so they are neither errors nor warnings. Pure.

import type { ArchitectureModel } from './model';
import { plural } from './text';
import type { WorkItemOverlay } from './workItemOverlay';
import { subtreeWorkItemIds } from './workload';

export type HintKind = 'description' | 'isolated' | 'no-work' | 'no-flows';

export interface AuthoringHint {
  readonly kind: HintKind;
  readonly message: string;
  /** The nodes the hint is about, in document order (empty for a hint about the file). */
  readonly nodeIds: readonly string[];
}

/** How many names a hint spells out before it counts the rest. */
export const HINT_NAMES_SHOWN = 6;

/**
 * The hints for `model` (and, when given, the work items laid over it):
 * - nodes without a description;
 * - nodes that no edge reaches, neither them nor anything inside them;
 * - domains without any work item (only when there are work items at all);
 * - no `flows:` section.
 * Each kind gives at most one hint, naming the first few nodes and counting the rest.
 */
export function authoringHints(
  model: ArchitectureModel,
  overlay?: WorkItemOverlay,
): AuthoringHint[] {
  const hints: AuthoringHint[] = [];
  const nodes = [...model.nodes.values()];
  const named = (ids: readonly string[]): string => {
    const names = ids.slice(0, HINT_NAMES_SHOWN).map((id) => model.nodes.get(id)?.name ?? id);
    const more = ids.length - names.length;
    return names.join(', ') + (more > 0 ? ` (+${more} more)` : '');
  };

  const undescribed = nodes.filter((node) => node.description === undefined).map((n) => n.id);
  if (undescribed.length > 0) {
    hints.push({
      kind: 'description',
      nodeIds: undescribed,
      message: `${plural(undescribed.length, 'node')} without a description: ${named(undescribed)}. A sentence each tells a reader what the box is for.`,
    });
  }

  // A node is connected when an edge ends at it or at anything inside it.
  const connected = new Set<string>();
  for (const edge of model.edges) {
    for (const end of [edge.from, edge.to]) {
      for (let node = model.nodes.get(end); node;) {
        connected.add(node.id);
        node = node.parentId === undefined ? undefined : model.nodes.get(node.parentId);
      }
    }
  }
  const isolated = nodes.filter((node) => !connected.has(node.id)).map((node) => node.id);
  if (isolated.length > 0 && model.edges.length > 0) {
    hints.push({
      kind: 'isolated',
      nodeIds: isolated,
      message: `${plural(isolated.length, 'node')} with no connection at all: ${named(isolated)}. Add the edges that reach them, or ask whether they belong on the map.`,
    });
  }

  if (overlay && overlay.shown.length > 0) {
    const withWork = subtreeWorkItemIds(model, overlay);
    const idle = model.rootIds.filter((id) => !withWork.has(id));
    if (idle.length > 0) {
      hints.push({
        kind: 'no-work',
        nodeIds: idle,
        message: `${plural(idle.length, 'domain')} without any work item: ${named(idle)}. Either nothing is planned there, or the items lack a comp: tag.`,
      });
    }
  }

  if (model.flows.length === 0 && model.edges.length > 0) {
    hints.push({
      kind: 'no-flows',
      nodeIds: [],
      message:
        'No flows: a "flows:" section naming the edges of a workflow or a data flow lets a reader follow one story through the map (Focus in the toolbar).',
    });
  }
  return hints;
}
