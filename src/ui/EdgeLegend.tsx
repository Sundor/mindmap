// The key to the edge kinds, over the canvas: a sample of each kind's line with its name. Read
// only — the kinds are switched on and off in the control panel (KindFilters); one that is
// hidden is struck through here.

import { EDGE_KINDS, type EdgeKind } from '../core';

export function EdgeLegend({ hiddenKinds }: { readonly hiddenKinds: ReadonlySet<EdgeKind> }) {
  return (
    <ul className="edge-legend" id="edge-legend" aria-label="Edge kinds">
      {EDGE_KINDS.map((kind) => {
        const hidden = hiddenKinds.has(kind);
        return (
          <li
            key={kind}
            className={`kind-filter-${kind}`}
            data-kind={kind}
            data-hidden={hidden ? 'true' : undefined}
            title={hidden ? `${kind} edges are hidden` : undefined}
          >
            <svg className="kind-sample" viewBox="0 0 28 8" aria-hidden="true" focusable="false">
              <line x1="1" y1="4" x2="27" y2="4" />
            </svg>
            {kind}
          </li>
        );
      })}
    </ul>
  );
}
