// The React Flow canvas. Renders a precomputed flow graph; it never lays anything out itself,
// so zooming, panning and collapsing cannot move nodes. A new flow for the same layout may come
// with other positions (the map closed up around what is drawn): the app then sets the viewport.

import {
  Background,
  ControlButton,
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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
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
import { fitOptions, fitRoom, fitWithRoom } from './constants';
import { coveredCanvasLeft } from './coveredCanvas';
import type { AppEdge, AppNode } from './flowTypes';
import { BandNode, GroupNode, LeafNode } from './nodes';
import { GroupWorkItemLists } from './WorkItemBlock';
import { NO_LENSES, NodeLensContext, type NodeLenses } from './nodeLensContext';
import { WorkItemCanvasContext, type WorkItemCanvas } from './workItemContext';

const nodeTypes: NodeTypes = { group: GroupNode, leaf: LeafNode, band: BandNode };
const edgeTypes: EdgeTypes = { arch: ArchEdgeView };

const PRO_OPTIONS = { hideAttribution: false } as const;

/** The icon of the fit button: the four corners React Flow's controls draw for it. */
function FitViewIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30" aria-hidden="true">
      <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
    </svg>
  );
}

/** How long the viewport must rest before it is reported (and stored), in milliseconds. */
const VIEWPORT_SETTLE_MS = 250;

/**
 * New nodes for the same layout, counted as measured at the size they are given for those still
 * shown. (A box of the map closed up may come back at another size: with the size measured
 * before, React Flow would hold the boxes inside it to that size until it is measured again, a
 * frame later.) The selection is not carried: it is part of the flow, see `highlightFlow`.
 */
function carryNodes(next: readonly AppNode[], previous: readonly AppNode[]): AppNode[] {
  const measured = new Set(previous.filter((node) => node.measured).map((node) => node.id));
  return next.map((node): AppNode => {
    if (!measured.has(node.id)) return node;
    const size = { width: node.width, height: node.height };
    return node.type === 'band' ? { ...node, measured: size } : { ...node, measured: size };
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
   * The pointer entered a model node (its ID) or left it (undefined). Leaving a node for an edge
   * is not reported until the pointer leaves the edges too: the edges a box shows on demand stay
   * while the pointer follows one of them (to click it), or crosses one drawn over the frame of
   * an open group. Both are reported again and again: the ID while the pointer moves on the
   * node, undefined while it moves over the canvas off every box and edge — and undefined when
   * the edge it is on is no longer drawn. Only given while something depends on it (edges on
   * demand), so hovering costs nothing otherwise.
   */
  readonly onHoverNode?: ((id: string | undefined) => void) | undefined;
  /**
   * The canvas has started: it has its pan/zoom, and from now on its store says what this canvas
   * is doing (a fit still to come), no longer what the one before it did.
   */
  readonly onStarted?: (() => void) | undefined;
  /**
   * Fits the view in place of the canvas, for a canvas of `size`: returns whether it did. Asked
   * first wherever the canvas would fit the view on mount; when it does, the fit the canvas has
   * still to make on its own (`fitView`, made once the nodes are measured) is dropped by it.
   */
  readonly fitTo?: ((size: Size) => boolean) | undefined;
  /** The fit button of the canvas controls was pressed. */
  readonly onFit: () => void;
}

/** Whether the pointer went onto a rendered edge: its line or the hit area around it. */
function isOnEdge(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.react-flow__edge') !== null;
}

/** Whether the pointer is on a box of the map (a row band is none) or on a rendered edge. */
function isOnBoxOrEdge(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('.react-flow__node:not(.react-flow__node-band), .react-flow__edge') !== null
  );
}

/**
 * Mount with a `key` that changes whenever the layout does: on mount the view is fitted, or
 * `initialViewport` restored. A new `flow` for the same layout (a group collapsed or expanded,
 * another level of detail, another selection, the same layout closed up otherwise) replaces the
 * nodes and edges in place, keeping the viewport.
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
  onStarted,
  fitTo,
  onFit,
}: MapCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AppEdge>(flow.edges);
  const store = useStoreApi();
  const { fitView, screenToFlowPosition } = useReactFlow<AppNode, AppEdge>();
  const container = useRef<HTMLDivElement>(null);
  // Mount-only: later values must not move the view.
  const [startViewport] = useState(initialViewport);
  // How the view is fitted on mount: clear of what the control panel covers of the canvas then,
  // and of the minimap where the map would have one of the boxes it starts with under it. That
  // is judged by the size of the canvas this one replaces (the store still holds it), and
  // without one taken as not needed.
  const [startNodes] = useState(flow.nodes);
  const [plainFit] = useState(() => fitOptions(coveredCanvasLeft()));
  const [startRoom] = useState(() => {
    const { width, height } = store.getState();
    return fitRoom(plainFit, startNodes, { width, height });
  });
  const fitViewOptions = useMemo(() => fitWithRoom(plainFit, startRoom), [plainFit, startRoom]);

  // Only here is the size of the canvas itself known. A map fitted on mount is fitted again when
  // the minimap needs other room on a canvas of this size. A restored viewport is only kept when
  // it shows a useful part of the map on the canvas as it is now (a smaller window, or a map
  // panned to the very edge, would leave it empty); otherwise fit, as without a stored viewport.
  const onInit = useCallback(() => {
    onStarted?.();
    const size = container.current?.getBoundingClientRect();
    if (!size || !(size.width > 0 && size.height > 0)) return;
    const room = fitRoom(plainFit, startNodes, size);
    if (!startViewport) {
      if (fitTo?.(size)) return;
      if (room !== startRoom) void fitView(fitWithRoom(plainFit, room));
      return;
    }
    if (!viewportShowsMap(startViewport, contentBounds, size)) {
      if (fitTo?.(size)) return;
      void fitView(fitWithRoom(plainFit, room));
      return;
    }
    // The view starts here without moving, so the subscription below never sees it: report it
    // now. It may differ from the stored one — a layout that replaced another starts from the
    // place the user was looking at — and a reload must come back to this view, not to that.
    onViewportSettled?.(startViewport);
  }, [
    startViewport,
    startNodes,
    startRoom,
    plainFit,
    contentBounds,
    fitView,
    fitTo,
    onStarted,
    onViewportSettled,
  ]);

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
  // there is no frame with stale nodes). Each list only when the flow has another one: React
  // Flow keeps what it holds of a node for as long as it is given the very same object, and
  // `carryNodes` makes a new one of every node that has been measured. A flow that differs in
  // its edges alone (the edges of the box under the pointer shown) so leaves every node as it is.
  const [shownFlow, setShownFlow] = useState(flow);
  if (shownFlow !== flow) {
    setShownFlow(flow);
    if (flow.nodes !== shownFlow.nodes) setNodes((previous) => carryNodes(flow.nodes, previous));
    if (flow.edges !== shownFlow.edges) setEdges(flow.edges);
  }

  const onNodeClick = useCallback<NodeMouseHandler<AppNode>>(
    (_event, node) => {
      if (node.type !== 'band') onSelect({ type: 'node', id: node.id });
    },
    [onSelect],
  );
  // The edges drawn, for a click on one of them. Read when the click comes: a handler made anew
  // for every flow would have React Flow render every edge again, whatever changed.
  const drawnEdges = useRef(flow.edges);
  useEffect(() => {
    drawnEdges.current = flow.edges;
  }, [flow.edges]);
  const onEdgeClick = useCallback<EdgeMouseHandler<AppEdge>>(
    (event, edge) => {
      // The hit areas of edges running side by side overlap, so the element that received the
      // click may be a neighbour of the line under the pointer: take the nearest line instead.
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const edges = drawnEdges.current;
      const hit = nearestEdgeAt(point, edges) ?? edges.find((e) => e.id === edge.id);
      if (hit) onSelect(selectionOfRenderedEdge(hit));
    },
    [onSelect, screenToFlowPosition],
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

  // Reported on entering a box and again with every move over it: a box drawn under a pointer at
  // rest (another level of detail, a group opened) is never entered, the pointer only moves on it.
  const onNodeMouseOver = useCallback<NodeMouseHandler<AppNode>>(
    (_event, node) => {
      if (node.type !== 'band') onHoverNode?.(node.id);
    },
    [onHoverNode],
  );
  const onNodeMouseLeave = useCallback<NodeMouseHandler<AppNode>>(
    (event) => {
      if (!isOnEdge(event.relatedTarget)) onHoverNode?.(undefined);
    },
    [onHoverNode],
  );
  // The rendered edge the pointer is on: the one that keeps a box hovered after the pointer left
  // the box.
  const edgeUnderPointer = useRef<string>(undefined);
  const onEdgeMouseEnter = useCallback<EdgeMouseHandler<AppEdge>>((_event, edge) => {
    edgeUnderPointer.current = edge.id;
  }, []);
  // Off the edges onto a node, entering the node reports it; anywhere else nothing is hovered.
  const onEdgeMouseLeave = useCallback<EdgeMouseHandler<AppEdge>>(
    (event) => {
      if (isOnEdge(event.relatedTarget)) return;
      edgeUnderPointer.current = undefined;
      onHoverNode?.(undefined);
    },
    [onHoverNode],
  );
  // An element that is taken away under the pointer (another level of detail, a group closed)
  // gets no leave event. An edge that goes while the pointer is on it keeps nothing hovered any
  // more, and wherever the pointer moves off the boxes and the edges, nothing is. (A box that
  // goes is no longer in the flow: the app drops it.)
  useEffect(() => {
    const id = edgeUnderPointer.current;
    if (id === undefined || flow.edges.some((edge) => edge.id === id)) return;
    edgeUnderPointer.current = undefined;
    onHoverNode?.(undefined);
  }, [flow.edges, onHoverNode]);
  const onPaneMouseMove = useCallback(
    (event: ReactMouseEvent) => {
      if (!isOnBoxOrEdge(event.target)) onHoverNode?.(undefined);
    },
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
              {...(onHoverNode
                ? {
                    onNodeMouseEnter: onNodeMouseOver,
                    onNodeMouseMove: onNodeMouseOver,
                    onNodeMouseLeave,
                    onEdgeMouseEnter,
                    onEdgeMouseLeave,
                    onPaneMouseMove,
                  }
                : {})}
              // Restore the stored viewport when there is one, otherwise fit.
              fitView={startViewport === undefined}
              fitViewOptions={fitViewOptions}
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
              {/* The fit of the app: React Flow's own knows neither the map closed up for
                  another level nor what covers the canvas. */}
              <Controls showInteractive={false} showFitView={false}>
                <ControlButton
                  className="react-flow__controls-fitview"
                  title="Fit view"
                  aria-label="Fit view"
                  onClick={onFit}
                >
                  <FitViewIcon />
                </ControlButton>
              </Controls>
              <MiniMapFixed nodes={flow.nodes} bounds={contentBounds} />
            </ReactFlow>
          </NodeLensContext.Provider>
        </WorkItemCanvasContext.Provider>
      </CollapseContext.Provider>
    </div>
  );
}
