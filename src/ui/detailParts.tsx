// Small pieces shared by the views of the detail panel.

import type { ReactNode } from 'react';
import type { ArchitectureModel } from '../core';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** The name of a node as a link that goes to it. */
export function NodeLink({
  model,
  id,
  onGoToNode,
}: {
  model: ArchitectureModel;
  id: string;
  onGoToNode: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="detail-link"
      data-node-id={id}
      title={id}
      onClick={() => onGoToNode(id)}
    >
      {model.nodes.get(id)?.name ?? id}
    </button>
  );
}
