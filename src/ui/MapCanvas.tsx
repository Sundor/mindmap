// The React Flow canvas. Renders a precomputed flow graph; it never lays anything out itself,
// so zooming, panning and collapsing cannot move nodes.

import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
  ViewportPortal,
  type EdgeMouseHandler,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodeDrag,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collapseAction,
  nearestEdgeAt,
  selectionOfRenderedEdge,
  viewportShowsMap,
  ZOOM_RANGE,
  type FlowGraph,
  type Selection,
  type Size,
  type Position,
  type Viewport,
} from '../core';
import { ArchEdgeView, EdgeMarkers } from './ArchEdge';
import { MiniMapFixed } from './MiniMapFixed';
import { CollapseContext, type ToggleCollapse } from './collapseContext';
import { FIT_VIEW_OPTIONS } from './constants';
import type { AppEdge, AppNode } from './flowTypes';
import { BandNode, GroupNode, LeafNode } from './nodes';
import { GroupWorkItemLists } from './WorkItemBlock';
import { NO_LENSES, NodeLensContext, type NodeLenses } from './nodeLensContext';
import { WorkItemCanvasContext, type WorkItemCanvas } from './workItemContext';

const nodeTypes: NodeTypes = { group: GroupNode, leaf: LeafNode, band: BandNode };
const edgeTypes: EdgeTypes = { arch: ArchEdgeView };

const PRO_OPTIONS = { hideAttribution: false } as const;

/** How long the viewport must rest before it is reported (and stored), in milliseconds. */
const VIEWPORT_SETTLE_MS = 250;

/**
 * New nodes for the same layout, keeping the sizes React Flow measured for those still shown.
 * (The selection is not carried: it is part of the flow, see `highlightFlow`.)
 */
function carryNodes(next: readonly AppNode[], previous: readonly AppNode[]): AppNode[] {
  const known = new Map(previous.map((node) => [node.id, node]));
  return next.map((node): AppNode => {
    const measured = known.get(node.id)?.measured;
    if (!measured) return node;
    return node.type === 'band' ? { ...node, measured } : { ...node, measured };
  });
}

export interface MapCanvasProps {
  /**
   * Nodes and edges of the current view (collapsed groups, level of detail, edge-kind filter),
   * with the selection and its dimming already applied.
   */
  readonly flow: FlowGraph;
  readonly onToggleCollapse: ToggleCollapse;
  /** The work-item selection the lines mark, and what a click on a line does. */
  readonly workItemCanvas: WorkItemCanvas;
  /** A node, edge or aggregate was clicked; undefined when the empty canvas was. */
  readonly onSelect: (selection: Selection | undefined) => void;
  /**
   * Viewport to start from (read on mount only); without one the view is fitted. It is also
   * fitted when that viewport would show (next to) nothing of the map on the canvas as it is now.
   */
  readonly initialViewport?: Viewport | undefined;
  /** Size of everything laid out, from the canvas origin (`LayoutResult.bounds`). */
  readonly contentBounds: Size;
  /** The viewport came to rest somewhere else (pan, zoom, fit, programmatic move). */
  readonly onViewportSettled?: ((viewport: Viewport) => void) | undefined;
  /** Positions unlocked: groups and nodes can be dragged; nothing else moves with them. */
  readonly positionsUnlocked?: boolean;
  /** A node was dropped `delta` (canvas pixels) away from where the flow draws it. */
  readonly onNodeMoved?: ((id: string, delta: Position) => void) | undefined;
  /** What the nodes draw besides themselves: heat, progress, tint. */
  readonly lenses?: NodeLenses | undefined;
  /**
   * The pointer entered a model node (its ID) or left it (undefined). Only given while
   * something depends on it (edges on demand), so hovering costs nothing otherwise.
   */
  readonly onHoverNode?: ((id: string | undefined) => void) | undefined;
}

/**
 * Mount with a `key` that changes whenever the layout does: on mount the view is fitted, or
 * `initialViewport` restored. A new `flow` for the same layout (a group collapsed or expanded,
 * another level of detail, another selection) replaces the nodes and edges in place, keeping
 * the viewport.
 *
 * Selection is owned by the app, not by React Flow (`elementsSelectable` is off): clicks are
 * reported through `onSelect` and the selection comes back as part of `flow`.
 */
export function MapCanvas({
  flow,
  onToggleCollapse,
  workItemCanvas,
  onSelect,
  initialViewport,
  contentBounds,
  onViewportSettled,
  positionsUnlocked = false,
  onNodeMoved,
  lenses = NO_LENSES,
  onHoverNode,
}: MapCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AppEdge>(flow.edges);
  // Mount-only: later values must not move the view.
  const [startViewport] = useState(initialViewport);
  const store = useStoreApi();
  const { fitView, screenToFlowPosition } = useReactFlow<AppNode, AppEdge>();
  const container = useRef<HTMLDivElement>(null);

  // A restored viewport is only kept when it shows a useful part of the map on the canvas as it
  // is now (a smaller window, or a map panned to the very edge, would leave it empty): only here
  // is the size of the canvas known. Otherwise fit, as without a stored viewport.
  const onInit = useCallback(() => {
    if (!startViewport) return;
    const size = container.current?.getBoundingClientRect();
    if (!size || !(size.width > 0 && size.height > 0)) return;
    if (!viewportShowsMap(startViewport, contentBounds, size)) {
      void fitView(FIT_VIEW_OPTIONS);
      return;
    }
    // The view starts here without moving, so the subscription below never sees it: report it
    // now. It may differ from the stored one — a layout that replaced another starts from the
    // place the user was looking at — and a reload must come back to this view, not to that.
    onViewportSettled?.(startViewport);
  }, [startViewport, contentBounds, fitView, onViewportSettled]);

  // Report the viewport once it rests. Subscribing to the store (rather than to React Flow's
  // move events) also covers fit to view and programmatic moves.
  useEffect(() => {
    if (!onViewportSettled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transform === previous.transform) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const current = store.getState();
        // Not while there is no canvas, nor while a fit is still to come.
        if (current.panZoom === null || current.fitViewQueued) return;
        const [x, y, zoom] = current.transform;
        onViewportSettled({ x, y, zoom });
      }, VIEWPORT_SETTLE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [store, onViewportSettled]);

  // Adjust the React Flow state while rendering when the flow changes (not in an effect, so
  // there is no frame with stale nodes).
  const [shownFlow, setShownFlow] = useState(flow);
  if (shownFlow !== flow) {
    setShownFlow(flow);
    setNodes((previous) => carryNodes(flow.nodes, previous));
    setEdges(flow.edges);
  }

  const onNodeClick = useCallback<NodeMouseHandler<AppNode>>(
    (_event, node) => {
      if (node.type !== 'band') onSelect({ type: 'node', id: node.id });
    },
    [onSelect],
  );
  const onEdgeClick = useCallback<EdgeMouseHandler<AppEdge>>(
    (event, edge) => {
      // The hit areas of edges running side by side overlap, so the element that received the
      // click may be a neighbour of the line under the pointer: take the nearest line instead.
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const hit = nearestEdgeAt(point, flow.edges) ?? flow.edges.find((e) => e.id === edge.id);
      if (hit) onSelect(selectionOfRenderedEdge(hit));
    },
    [onSelect, flow, screenToFlowPosition],
  );
  const onPaneClick = useCallback(() => onSelect(undefined), [onSelect]);
  const onSelectNode = useCallback((id: string) => onSelect({ type: 'node', id }), [onSelect]);

  // A drag moves the node inside React Flow's own state; the drop is reported as an offset
  // from where the flow draws the node, and comes back as a new flow with the edges rerouted.
  const onNodeDragStop = useCallback<OnNodeDrag<AppNode>>(
    (_event, node) => {
      const drawn = flow.nodes.find((candidate) => candidate.id === node.id);
      if (!drawn || node.type === 'band') return;
      onNodeMoved?.(node.id, {
        x: node.position.x - drawn.position.x,
        y: node.position.y - drawn.position.y,
      });
    },
    [flow, onNodeMoved],
  );

  const onNodeMouseEnter = useCallback<NodeMouseHandler<AppNode>>(
    (_event, node) => {
      if (node.type !== 'band') onHoverNode?.(node.id);
    },
    [onHoverNode],
  );
  const onNodeMouseLeave = useCallback<NodeMouseHandler<AppNode>>(
    () => onHoverNode?.(undefined),
    [onHoverNode],
  );

  const onNodeDoubleClick = useCallback<NodeMouseHandler<AppNode>>(
    (_event, node) => {
      // No toggle on a group closed only by the level of detail (see `collapseAction`).
      if (node.type === 'group' && collapseAction(node.data) !== undefined) {
        onToggleCollapse(node.id);
      }
    },
    [onToggleCollapse],
  );

  return (
    <div className="map-canvas" id="map-canvas" ref={container}>
      <EdgeMarkers />
      <CollapseContext.Provider value={onToggleCollapse}>
        <WorkItemCanvasContext.Provider value={workItemCanvas}>
          <NodeLensContext.Provider value={lenses}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              // Explicit stacking (Z_INDEX in src/core/flow.ts): bands < open groups < edges <
              // leaves and closed groups.
              zIndexMode="manual"
              elevateNodesOnSelect={false}
              elevateEdgesOnSelect={false}
              // The app owns the selection (see above); React Flow only reports the clicks.
              elementsSelectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onInit={onInit}
              nodesDraggable={positionsUnlocked}
              onNodeDragStop={onNodeDragStop}
              nodesConnectable={false}
              edgesReconnectable={false}
              deleteKeyCode={null}
              // Double-click toggles a group; it must not zoom as well.
              zoomOnDoubleClick={false}
              onNodeDoubleClick={onNodeDoubleClick}
              {...(onHoverNode ? { onNodeMouseEnter, onNodeMouseLeave } : {})}
              // Restore the stored viewport when there is one, otherwise fit.
              fitView={startViewport === undefined}
              fitViewOptions={FIT_VIEW_OPTIONS}
              {...(startViewport ? { defaultViewport: startViewport } : {})}
              minZoom={ZOOM_RANGE.min}
              maxZoom={ZOOM_RANGE.max}
              colorMode="system"
              proOptions={PRO_OPTIONS}
            >
              {/* The lists of open groups, above the edges (see GroupWorkItemLists). */}
              <ViewportPortal>
                <GroupWorkItemLists nodes={flow.nodes} onSelectNode={onSelectNode} />
              </ViewportPortal>
              <Background />
              <Controls showInteractive={false} />
              <MiniMapFixed nodes={flow.nodes} bounds={contentBounds} />
            </ReactFlow>
          </NodeLensContext.Provider>
        </WorkItemCanvasContext.Provider>
      </CollapseContext.Provider>
    </div>
  );
}
