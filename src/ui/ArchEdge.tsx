// Custom edge styled by kind (dataflow solid, dependency dashed, control dotted,
// config dash-dot thin), with a per-kind arrowhead and a label with a readable background.

import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import {
  curvePath,
  EDGE_KINDS,
  aggregateCountLabel,
  flowEdgeLabel,
  labelPoint,
  routeCurve,
  type EdgeKind,
} from '../core';
import type { AppEdge } from './flowTypes';

function markerId(kind: EdgeKind): string {
  return `arch-arrow-${kind}`;
}

/** Arrowhead definitions, one per edge kind; coloured through CSS (`.arch-arrow-<kind>`). */
export function EdgeMarkers() {
  return (
    <svg className="arch-defs" aria-hidden="true" focusable="false">
      <defs>
        {EDGE_KINDS.map((kind) => (
          <marker
            key={kind}
            id={markerId(kind)}
            className={`arch-arrow arch-arrow-${kind}`}
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="11"
            markerHeight="11"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M 0 0.5 L 10 5 L 0 9.5 z" />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

export function ArchEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  interactionWidth,
}: EdgeProps<AppEdge>) {
  if (!data) return null;
  // The handles give the middle of the chosen sides; the route (src/core/route.ts) says which
  // way the curve leaves them and how far this edge is shifted from its parallel neighbours.
  const { route } = data;
  const curve = routeCurve({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, route);
  const label = labelPoint(curve, route.labelT);
  // An aggregate shows how many edges it stands for; a single edge its own label.
  const text = flowEdgeLabel(data);
  const aggregate = data.count > 1;
  // Parallel edges list their labels (one per line) instead of the count.
  const countShown = aggregate && text === aggregateCountLabel(data.count);
  // A label that has no place where it would not cover what a box says is not drawn
  // (`labelHidden`): the tooltip of the line says it instead.
  const hidden = data.labelHidden === true && text !== undefined;
  const tooltip = [
    hidden ? (aggregate && countShown ? `${data.count} ${data.kind} edges` : text) : undefined,
    data.description,
  ].filter((part) => part !== undefined);
  return (
    <>
      {/* First child of the edge's <g>: native tooltip for the line and its hit area. */}
      {tooltip.length > 0 && <title>{tooltip.join('\n')}</title>}
      <BaseEdge
        id={id}
        path={curvePath(curve)}
        markerEnd={`url(#${markerId(data.kind)})`}
        interactionWidth={interactionWidth}
      />
      {text !== undefined && !hidden && (
        <EdgeLabelRenderer>
          <div
            className={`arch-edge-label arch-edge-label-${data.kind}${
              countShown ? ' arch-edge-label-count' : ''
            }${data.dimmed ? ' arch-dimmed' : ''}${data.faded ? ' arch-faded' : ''}${
              data.quiet ? ' arch-quiet' : ''
            }`}
            data-edge-id={id}
            data-count={data.count}
            title={aggregate ? `${data.count} ${data.kind} edges` : undefined}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
          >
            {/* The same words, on more lines where one line would cover the text of a box. */}
            {data.labelText ?? text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
