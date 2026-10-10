// The app's own canvas drawn without a browser: React Flow's store as the app has it once a map
// is on screen, the MapCanvas below it, and the edge labels, which React Flow draws through a
// portal and so leaves out of a render to markup.

import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { useState, type ReactNode } from 'react';
import { labelPoint, ZOOM_RANGE, type FlowGraph, type Size, type Viewport } from '../core';
import { EdgeLabel } from '../ui/ArchEdge';
import { MapCanvas } from '../ui/MapCanvas';
import type { NodeLenses } from '../ui/nodeLensContext';
import { NO_WORK_ITEM_CANVAS, type WorkItemCanvas } from '../ui/workItemContext';
import { storeSettings, withSideHandles, type StoreSettings } from './fixtures';

const noop = (): undefined => undefined;
const NO_FLOW: FlowGraph = { nodes: [], edges: [] };

/**
 * Puts `settings` into the first state of the store. A render to markup reads the state the
 * store was made with, which `setState` does not change: that object itself is changed, once,
 * before anything below reads it.
 */
function StoreSeed({
  settings,
  children,
}: {
  readonly settings: StoreSettings;
  readonly children: ReactNode;
}) {
  const store = useStoreApi();
  useState(() => Object.assign(store.getState(), settings));
  return children;
}

export interface FlowStoreProps {
  /** What the canvas below draws; none for a control panel shown without a map. */
  readonly flow?: FlowGraph | undefined;
  /** The size of the canvas the view belongs to. */
  readonly size: Size;
  /** The view. For a map: `fittedViewport(fitOptions(covered), flow.nodes, size)` of src/ui/constants.ts. */
  readonly view: Viewport;
  /** Positions unlocked: the boxes can be dragged. */
  readonly unlocked?: boolean | undefined;
  readonly children: ReactNode;
}

/**
 * React Flow's store as the app has it once a map is on screen: the nodes with the handles their
 * edges attach to, the settings MapCanvas gives `<ReactFlow>`, the view. Everything that reads
 * the store stands below it: the canvas, and the Detail tab with its zoom readout. Renders no
 * element of its own.
 */
export function FlowStore({
  flow = NO_FLOW,
  size,
  view,
  unlocked = false,
  children,
}: FlowStoreProps) {
  return (
    // No `fitView`: the fit the store makes by itself is not the app's.
    <ReactFlowProvider
      initialNodes={flow.nodes.map(withSideHandles)}
      initialEdges={flow.edges}
      initialWidth={size.width}
      initialHeight={size.height}
      initialMinZoom={ZOOM_RANGE.min}
      initialMaxZoom={ZOOM_RANGE.max}
      zIndexMode="manual"
    >
      <StoreSeed settings={storeSettings(unlocked, view)}>{children}</StoreSeed>
    </ReactFlowProvider>
  );
}

export interface StaticCanvasProps {
  /** The same flow the `FlowStore` above was given. */
  readonly flow: FlowGraph;
  /** `LayoutResult.bounds` of the layout the flow was built from. */
  readonly bounds: Size;
  /** Positions unlocked, as the `FlowStore` above was told. */
  readonly unlocked?: boolean | undefined;
  readonly lenses?: NodeLenses | undefined;
  /** The work-item selection the lines mark. */
  readonly workItemCanvas?: WorkItemCanvas | undefined;
}

/** The app's MapCanvas with handlers that do nothing. Must stand below a `FlowStore`. */
export function StaticCanvas({
  flow,
  bounds,
  unlocked = false,
  lenses,
  workItemCanvas = NO_WORK_ITEM_CANVAS,
}: StaticCanvasProps) {
  return (
    <MapCanvas
      flow={flow}
      onToggleCollapse={noop}
      workItemCanvas={workItemCanvas}
      onSelect={noop}
      contentBounds={bounds}
      positionsUnlocked={unlocked}
      lenses={lenses}
      onFit={noop}
    />
  );
}

export interface EdgeLabelLayerProps {
  readonly flow: FlowGraph;
}

/**
 * The labels of the edges of `flow`, each where its curve has it: the content of the container
 * React Flow leaves empty without a browser.
 */
export function EdgeLabelLayer({ flow }: EdgeLabelLayerProps) {
  return flow.edges.map((edge) => {
    const at = labelPoint(edge.data.curve, edge.data.route.labelT);
    return <EdgeLabel key={edge.id} id={edge.id} data={edge.data} x={at.x} y={at.y} />;
  });
}
