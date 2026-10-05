// The minimap: the whole map at a fixed scale, with the part the canvas shows as a rectangle.
// React Flow's own <MiniMap> fits its view box around the map *and* the viewport, so it shrinks
// whenever the view is panned off the map; this one never changes scale (src/core/minimap.ts):
// a view partly or wholly off the map is cut off at the edge of the minimap.

import { Panel, useReactFlow, useStore, useStoreApi, type ReactFlowState } from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, type PointerEvent } from 'react';
import {
  fromMiniMap,
  MINIMAP,
  miniMapNodes,
  miniMapTransform,
  rectToMiniMap,
  viewportCentredOn,
  viewportRect,
  zoomAboutCentre,
  type FlowNode,
  type MiniMapTransform,
  type Rect,
  type Size,
} from '../core';

/** The part of the canvas on screen; `undefined` while the canvas has no size yet. */
function selectView(state: ReactFlowState): Rect | undefined {
  if (!(state.width > 0 && state.height > 0)) return undefined;
  const [x, y, zoom] = state.transform;
  return viewportRect({ x, y, zoom }, { width: state.width, height: state.height });
}

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

const OUTLINE = `M0,0h${MINIMAP.width}v${MINIMAP.height}h${-MINIMAP.width}z`;

/** The viewport rectangle and the veil over everything outside it. Re-renders while panning. */
function ViewportMask({ transform }: { readonly transform: MiniMapTransform }) {
  // The equality function keeps this from rendering unless the rectangle really changed.
  const view = useStore(selectView, sameRect);
  if (!view) return null;
  const { x, y, width, height } = rectToMiniMap(transform, view);
  return (
    <>
      <path
        className="react-flow__minimap-mask"
        d={`${OUTLINE}M${x},${y}h${width}v${height}h${-width}z`}
        fillRule="evenodd"
      />
      {/* Drawn where it is; the SVG cuts off what lies outside the minimap. */}
      <rect className="arch-minimap-viewport" x={x} y={y} width={width} height={height} />
    </>
  );
}

/** The boxes of the map. Rendered again only for another flow, never for a pan or zoom. */
const MiniMapNodes = memo(function MiniMapNodes({
  nodes,
  transform,
}: {
  readonly nodes: readonly FlowNode[];
  readonly transform: MiniMapTransform;
}) {
  const boxes = useMemo(() => miniMapNodes(nodes), [nodes]);
  return (
    <>
      {boxes.map(({ id, type, rect }) => {
        const { x, y, width, height } = rectToMiniMap(transform, rect);
        return (
          <rect
            key={id}
            className={`react-flow__minimap-node arch-minimap-${type}`}
            data-id={id}
            x={x}
            y={y}
            width={width}
            height={height}
            rx={type === 'band' ? 0 : 1}
          />
        );
      })}
    </>
  );
});

export interface MiniMapFixedProps {
  /** The nodes drawn on the canvas (`FlowGraph.nodes`: parents before their children). */
  readonly nodes: readonly FlowNode[];
  /** Size of everything laid out, from the canvas origin (`LayoutResult.bounds`). */
  readonly bounds: Size;
}

/**
 * Minimap at the bottom right of the canvas; must be rendered inside `<ReactFlow>`.
 *
 * Pressing anywhere in it puts that point of the map in the middle of the canvas, and dragging
 * keeps doing so (the view follows the pointer; the rectangle is not grabbed by its edge). The
 * wheel zooms the canvas about its middle.
 */
export function MiniMapFixed({ nodes, bounds }: MiniMapFixedProps) {
  const store = useStoreApi();
  const { setViewport } = useReactFlow();
  const svg = useRef<SVGSVGElement>(null);
  const transform = useMemo(() => miniMapTransform(bounds), [bounds]);

  const centreOn = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const { width, height, transform: current } = store.getState();
      if (!(box.width > 0 && box.height > 0 && width > 0 && height > 0)) return;
      const point = fromMiniMap(transform, {
        x: ((event.clientX - box.left) * MINIMAP.width) / box.width,
        y: ((event.clientY - box.top) * MINIMAP.height) / box.height,
      });
      void setViewport(viewportCentredOn(point, current[2], { width, height }));
    },
    [store, setViewport, transform],
  );
  const onPointerDown = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      centreOn(event);
    },
    [centreOn],
  );
  const onPointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) centreOn(event);
    },
    [centreOn],
  );

  // A native listener: React's wheel listeners are passive and could not stop the page scrolling.
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { width, height, transform: current } = store.getState();
      if (!(width > 0 && height > 0)) return;
      const [x, y, zoom] = current;
      // Lines or pages rather than pixels: one notch is roughly a hundred pixels.
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : event.deltaY * 33;
      void setViewport(zoomAboutCentre({ x, y, zoom }, { width, height }, delta));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [store, setViewport]);

  return (
    <Panel position="bottom-right" className="react-flow__minimap arch-minimap">
      <svg
        ref={svg}
        id="minimap"
        className="react-flow__minimap-svg"
        width={MINIMAP.width}
        height={MINIMAP.height}
        viewBox={`0 0 ${MINIMAP.width} ${MINIMAP.height}`}
        role="img"
        aria-label="Mini map"
        data-scale={transform.scale}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <title>Mini map: press or drag to move the view, wheel to zoom</title>
        <MiniMapNodes nodes={nodes} transform={transform} />
        <ViewportMask transform={transform} />
      </svg>
    </Panel>
  );
}
