// Edge-kind toggles, in the control panel. Each button shows a sample of its kind's line, like
// the legend over the canvas (EdgeLegend).

import { EDGE_KINDS, type EdgeKind } from '../core';

export interface KindFiltersProps {
  readonly hiddenKinds: ReadonlySet<EdgeKind>;
  /** Number of edges of each kind on the map (hidden or not), shown in the tooltip. */
  readonly counts: Readonly<Record<EdgeKind, number>>;
  readonly onToggle: (kind: EdgeKind) => void;
}

export function KindFilters({ hiddenKinds, counts, onToggle }: KindFiltersProps) {
  return (
    <div className="kind-filters" id="kind-filters" role="group" aria-label="Edge kinds shown">
      {EDGE_KINDS.map((kind) => {
        const shown = !hiddenKinds.has(kind);
        const action = `${shown ? 'Hide' : 'Show'} ${kind} edges (${counts[kind]})`;
        return (
          <button
            key={kind}
            type="button"
            className={`kind-filter kind-filter-${kind}`}
            data-kind={kind}
            aria-pressed={shown}
            aria-label={action}
            title={action}
            onClick={() => onToggle(kind)}
          >
            <svg className="kind-sample" viewBox="0 0 28 8" aria-hidden="true" focusable="false">
              <line x1="1" y1="4" x2="27" y2="4" />
            </svg>
            {kind}
          </button>
        );
      })}
    </div>
  );
}
