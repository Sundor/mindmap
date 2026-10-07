// Small pieces shared by the views of the detail panel.

import { useContext, type ReactNode } from 'react';
import type { ArchitectureModel } from '../core';
import { FilterContext, outsideTitle } from './filterContext';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * The name of a node as a link that goes to it. A node the filtered map leaves out is marked:
 * going to it shows the whole map again.
 */
export function NodeLink({
  model,
  id,
  onGoToNode,
}: {
  model: ArchitectureModel;
  id: string;
  onGoToNode: (id: string) => void;
}) {
  const filtered = useContext(FilterContext);
  const outside = filtered !== undefined && !filtered.showsNode(id);
  return (
    <button
      type="button"
      className={`detail-link${outside ? ' detail-link-outside' : ''}`}
      data-node-id={id}
      data-outside={outside ? 'true' : undefined}
      title={outside ? outsideTitle(id) : id}
      onClick={() => onGoToNode(id)}
    >
      {model.nodes.get(id)?.name ?? id}
    </button>
  );
}
