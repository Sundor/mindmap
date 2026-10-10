// Right-side detail panel for the selected node, edge, aggregate or work item.
// Everything shown is computed by pure helpers in src/core.

import { useContext, useState, type ReactNode } from 'react';
import {
  edgeLabelText,
  effectiveAttribute,
  flowsOfEdge,
  flowsOfNode,
  formatMetric,
  moveSection,
  NODE_ATTRIBUTES,
  NODE_LEVEL_NAMES,
  NODE_PANEL_SECTIONS,
  nodeEdges,
  nodePath,
  nodeRowInfo,
  onMapText,
  orderSections,
  plural,
  progressText,
  readPanelLayout,
  rowInfoText,
  toggleSection,
  writePanelLayout,
  type NodePanelSection,
  type PanelLayout,
  type ArchEdge,
  type ArchFlow,
  type ArchitectureModel,
  type DrawnHeat,
  type DrawnProgress,
  type EdgeKind,
  type FlowEdge,
  type Focus,
  type LayoutResult,
  type NodeEdgeRef,
  type NodeHeat,
  type NodeProgress,
  type Selection,
  type StoryMode,
  type WorkItemOverlay,
} from '../core';
import { browserStorage } from './browserStorage';
import { DETAIL_PANEL_WIDTH } from './constants';
import { Field, NodeLink } from './detailParts';
import { FilterContext, outsideTitle } from './filterContext';
import { FlowDetail, FocusButton } from './FlowDetail';
import { PanelSection } from './PanelSection';
import { PanelSectionsContext, type PanelSections } from './panelSectionsContext';
import { NodeWorkItems, WorkItemDetail } from './WorkItemDetail';

export interface DetailPanelProps {
  readonly model: ArchitectureModel;
  /** The rows the nodes of `model` sit in; both maps empty while it is not arranged in rows. */
  readonly rows: Pick<LayoutResult, 'placedRow' | 'rowOf'>;
  readonly selection: Selection;
  /** The rendered edges, to look up a selected aggregate. */
  readonly edges: readonly FlowEdge[];
  readonly hiddenKinds: ReadonlySet<EdgeKind>;
  /** Select a node, revealing it (expanding its ancestors, panning and zooming to it). */
  readonly onGoToNode: (id: string) => void;
  /** Select an original edge, revealing both of its ends. */
  readonly onGoToEdge: (id: string) => void;
  /** The work items as laid over the model; absent while there are none to show. */
  readonly overlay?: WorkItemOverlay | undefined;
  /** What the canvas shows of them: a work item that is not drawn says why. */
  readonly storyMode: StoryMode;
  /** Select a work item, revealing a node that lists it. */
  readonly onGoToWorkItem: (id: number) => void;
  readonly onChooseStoryMode: (mode: StoryMode) => void;
  /** Select a flow (its panel) and focus the map on it. */
  readonly onGoToFlow: (id: string) => void;
  /** The map's focus, and how to change it (src/core/focus.ts). */
  readonly focus: Focus | undefined;
  readonly onFocus: (focus: Focus | undefined) => void;
  /**
   * Per node, when the heat / progress lenses are on: what the panel states in words. The counts
   * are those of the node with everything inside it, drawn or not.
   */
  readonly heat?: ReadonlyMap<string, NodeHeat> | undefined;
  readonly progress?: ReadonlyMap<string, NodeProgress> | undefined;
  /**
   * What the boxes on the map show of that, per drawn node (`drawnIds`): an open group counts
   * only what no box inside it shows, and the panel says so where the two differ.
   */
  readonly drawnHeat?: ReadonlyMap<string, DrawnHeat> | undefined;
  readonly drawnProgress?: ReadonlyMap<string, DrawnProgress> | undefined;
  readonly drawnIds?: ReadonlySet<string> | undefined;
  /**
   * What is selected is not drawn: the filtered map leaves it out. The panel says so and offers
   * `onShowOnMap`, which goes to it on the whole map.
   */
  readonly outside?: boolean | undefined;
  readonly onShowOnMap?: (() => void) | undefined;
  readonly onClose: () => void;
}

/**
 * The lists name the whole model whatever the map draws. Inside a `FilterContext` the links to
 * what the filtered map leaves out are marked.
 */
export function DetailPanel(props: DetailPanelProps) {
  const { selection, outside = false, onShowOnMap, onClose } = props;
  const title = {
    node: 'Node',
    edge: 'Edge',
    aggregate: 'Merged edges',
    workitem: 'Work item',
    flow: 'Flow',
  }[selection.type];
  return (
    <aside
      id="detail-panel"
      className="detail-panel"
      style={{ width: DETAIL_PANEL_WIDTH }}
      aria-label={`${title} details`}
      data-selection-type={selection.type}
      data-selection-id={selection.id}
    >
      <header className="detail-header">
        <span className="detail-kicker">{title}</span>
        <button
          type="button"
          id="detail-close"
          className="detail-close"
          aria-label="Close details"
          title="Close (Esc)"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {outside && (
        <p id="detail-outside-note" className="detail-outside-note">
          Not on the map: Filter leaves it out.{' '}
          <button type="button" id="detail-show-on-map" onClick={onShowOnMap}>
            Show it
          </button>
        </p>
      )}
      <div className="detail-body">
        {selection.type === 'node' && <NodeDetail {...props} id={selection.id} />}
        {selection.type === 'edge' && <EdgeDetail {...props} id={selection.id} />}
        {selection.type === 'aggregate' && <AggregateDetail {...props} id={selection.id} />}
        {selection.type === 'workitem' && props.overlay && (
          <WorkItemDetail
            model={props.model}
            overlay={props.overlay}
            storyMode={props.storyMode}
            id={selection.id}
            onGoToNode={props.onGoToNode}
            onGoToWorkItem={props.onGoToWorkItem}
            onChooseStoryMode={props.onChooseStoryMode}
            focusButton={
              <FocusButton
                target={{ type: 'workitem', id: selection.id }}
                focus={props.focus}
                onFocus={props.onFocus}
              />
            }
          />
        )}
        {selection.type === 'flow' && (
          <FlowDetail
            model={props.model}
            id={selection.id}
            focus={props.focus}
            onFocus={props.onFocus}
            onGoToNode={props.onGoToNode}
            onGoToEdge={props.onGoToEdge}
          />
        )}
      </div>
    </aside>
  );
}

type DetailProps = DetailPanelProps & { readonly id: string };

/**
 * One original edge in a list: `label [protocol]` (or its ID), kind, and the given context. An
 * edge the filtered map leaves out is marked, whether or not its kind is hidden as well.
 */
function EdgeItem({
  edge,
  hidden,
  onGoToEdge,
  children,
}: {
  edge: ArchEdge;
  hidden: boolean;
  onGoToEdge: (id: string) => void;
  children: ReactNode;
}) {
  const filtered = useContext(FilterContext);
  const outside = filtered !== undefined && !filtered.showsEdge(edge.id);
  const hiddenTitle = hidden ? `${edge.id} — edge kind hidden; click to show` : edge.id;
  return (
    <li>
      <button
        type="button"
        className="detail-edge"
        data-edge-id={edge.id}
        data-outside={outside ? 'true' : undefined}
        title={outside ? outsideTitle(edge.id) : hiddenTitle}
        onClick={() => onGoToEdge(edge.id)}
      >
        <span className={`kind-dot kind-dot-${edge.kind}`} aria-hidden="true" />
        <span className="detail-edge-text">
          <span className="detail-edge-label">{edgeLabelText(edge) ?? edge.id}</span>
          <span className="detail-edge-context">{children}</span>
        </span>
        <span className="detail-edge-kind">
          {edge.kind}
          {hidden ? ' · hidden' : ''}
        </span>
      </button>
    </li>
  );
}

function name(model: ArchitectureModel, id: string): string {
  return model.nodes.get(id)?.name ?? id;
}

function kindName(flow: ArchFlow): string {
  return flow.kind === 'dataflow' ? 'data flow' : 'workflow';
}

/** The flows a node or an edge is part of, each a link to the flow's panel and focus. */
function FlowList({
  flows,
  onGoToFlow,
}: {
  flows: readonly ArchFlow[];
  onGoToFlow: (id: string) => void;
}) {
  if (flows.length === 0) return null;
  return (
    <section className="detail-flows" id="detail-flows">
      <h3>Part of {plural(flows.length, 'flow')}</h3>
      <ul className="detail-list">
        {flows.map((flow) => (
          <li key={flow.id}>
            <button
              type="button"
              className="detail-link"
              data-flow-id={flow.id}
              title={`${kindName(flow)} ${flow.id}: focus the map on it`}
              onClick={() => onGoToFlow(flow.id)}
            >
              {flow.name}
            </button>
            <span className="detail-flow-kind"> · {kindName(flow)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EdgeRefList({
  model,
  refs,
  direction,
  hiddenKinds,
  onGoToEdge,
}: Pick<DetailPanelProps, 'model' | 'hiddenKinds' | 'onGoToEdge'> & {
  refs: readonly NodeEdgeRef[];
  direction: 'from' | 'to';
}) {
  return (
    <ul className="detail-list">
      {refs.map((ref) => (
        <EdgeItem
          key={ref.edge.id}
          edge={ref.edge}
          hidden={hiddenKinds.has(ref.edge.kind)}
          onGoToEdge={onGoToEdge}
        >
          {direction} {name(model, ref.otherId)}
          {!ref.own && ` · via ${name(model, ref.endId)}`}
        </EdgeItem>
      ))}
    </ul>
  );
}

function NodeDetail({
  model,
  rows,
  id,
  hiddenKinds,
  overlay,
  onGoToNode,
  onGoToEdge,
  onGoToWorkItem,
  onGoToFlow,
  heat,
  progress,
  drawnHeat,
  drawnProgress,
  drawnIds,
}: DetailProps) {
  const [panelLayout, setPanelLayout] = useState(() => readPanelLayout(browserStorage()));
  const node = model.nodes.get(id);
  if (!node) return null;
  // What the box of the node shows of its work, when that is less than the node holds.
  const onMap = drawnIds?.has(id)
    ? onMapText(
        { heat: heat?.get(id), progress: progress?.get(id) },
        { heat: drawnHeat?.get(id), progress: drawnProgress?.get(id) },
      )
    : undefined;
  const path = nodePath(model, id);
  const row = nodeRowInfo(model, rows, id);
  const edges = nodeEdges(model, id);
  const listProps = { model, hiddenKinds, onGoToEdge };

  // The lists below the description: each can be folded and moved (PanelSection); the order and
  // the folded set are the same for every node and kept in the browser.
  const changePanelLayout = (next: PanelLayout) => {
    if (next === panelLayout) return;
    setPanelLayout(next);
    writePanelLayout(browserStorage(), next);
  };
  const hasWorkItems = overlay !== undefined && overlay.shown.length > 0;
  const present: Record<NodePanelSection, boolean> = {
    children: node.childIds.length > 0,
    incoming: true,
    outgoing: true,
    internal: edges.internal.length > 0,
    workitems: hasWorkItems,
  };
  const shown = orderSections(NODE_PANEL_SECTIONS, panelLayout).filter((key) => present[key]);
  const sections: PanelSections = {
    layout: panelLayout,
    shown,
    toggle: (key) => changePanelLayout(toggleSection(panelLayout, key)),
    move: (key, move) =>
      changePanelLayout(moveSection(panelLayout, NODE_PANEL_SECTIONS, shown, key, move)),
  };
  const renderSection = (key: NodePanelSection): ReactNode => {
    switch (key) {
      case 'children':
        return (
          <PanelSection
            key={key}
            section={key}
            id="detail-children"
            title={`${NODE_LEVEL_NAMES[node.level + 1] ?? 'node'}s (${node.childIds.length})`}
          >
            <ul className="detail-list detail-children">
              {node.childIds.map((child) => (
                <li key={child}>
                  <NodeLink model={model} id={child} onGoToNode={onGoToNode} />
                </li>
              ))}
            </ul>
          </PanelSection>
        );
      case 'incoming':
        return (
          <PanelSection
            key={key}
            section={key}
            id="detail-incoming"
            title={`Incoming edges (${edges.incoming.length})`}
          >
            <EdgeRefList {...listProps} refs={edges.incoming} direction="from" />
          </PanelSection>
        );
      case 'outgoing':
        return (
          <PanelSection
            key={key}
            section={key}
            id="detail-outgoing"
            title={`Outgoing edges (${edges.outgoing.length})`}
          >
            <EdgeRefList {...listProps} refs={edges.outgoing} direction="to" />
          </PanelSection>
        );
      case 'internal':
        return (
          <PanelSection
            key={key}
            section={key}
            id="detail-internal"
            title={`Edges inside (${edges.internal.length})`}
          >
            <ul className="detail-list">
              {edges.internal.map((edge) => (
                <EdgeItem
                  key={edge.id}
                  edge={edge}
                  hidden={hiddenKinds.has(edge.kind)}
                  onGoToEdge={onGoToEdge}
                >
                  {name(model, edge.from)} → {name(model, edge.to)}
                </EdgeItem>
              ))}
            </ul>
          </PanelSection>
        );
      case 'workitems':
        return overlay ? (
          <NodeWorkItems
            key={key}
            model={model}
            overlay={overlay}
            id={id}
            onGoToNode={onGoToNode}
            onGoToWorkItem={onGoToWorkItem}
          />
        ) : null;
    }
  };
  return (
    <>
      <h2 id="detail-title">{node.name}</h2>
      <nav className="detail-breadcrumb" id="detail-breadcrumb" aria-label="Parent path">
        {path.map((step, index) => (
          <span key={step.id}>
            {index > 0 && <span className="detail-breadcrumb-sep"> › </span>}
            {step.id === id ? (
              <span aria-current="true">{step.name}</span>
            ) : (
              <NodeLink model={model} id={step.id} onGoToNode={onGoToNode} />
            )}
          </span>
        ))}
      </nav>
      <dl className="detail-fields">
        <Field label="ID">
          <code>{node.id}</code>
        </Field>
        <Field label="Level">{NODE_LEVEL_NAMES[node.level]}</Field>
        {row && (
          <Field label="Row">
            <span id="detail-row" data-row-kind={row.kind}>
              {rowInfoText(row)}
            </span>
          </Field>
        )}
        {NODE_ATTRIBUTES.map((key) => {
          const found = effectiveAttribute(model, id, key);
          if (!found) return null;
          return (
            <Field key={key} label={key.charAt(0).toUpperCase() + key.slice(1)}>
              <span data-attribute={key}>{found.value}</span>
              {found.from !== id && (
                <span className="detail-inherited"> (from {name(model, found.from)})</span>
              )}
            </Field>
          );
        })}
        {node.metrics &&
          [...node.metrics].map(([metric, value]) => (
            <Field key={`metric:${metric}`} label={metric}>
              <span data-metric={metric}>{formatMetric(value)}</span>
            </Field>
          ))}
        {(heat?.has(id) || progress?.has(id)) && (
          <Field label={node.childIds.length > 0 ? 'Work, with everything inside' : 'Work'}>
            <span id="detail-work">
              {[
                heat?.has(id) ? plural(heat.get(id)?.open ?? 0, 'open item') : undefined,
                progress?.has(id)
                  ? progressText(progress.get(id) ?? { done: 0, total: 0 })
                  : undefined,
              ]
                .filter((part) => part !== undefined)
                .join(' · ')}
            </span>
            {onMap !== undefined && (
              <>
                <br />
                <span id="detail-work-drawn">{onMap}</span>
              </>
            )}
          </Field>
        )}
      </dl>
      {node.description !== undefined && <p className="detail-description">{node.description}</p>}
      {node.links && node.links.length > 0 && (
        <ul className="detail-links" id="detail-links">
          {node.links.map((link) => (
            <li key={`${link.label}:${link.url}`}>
              <a href={link.url} target="_blank" rel="noreferrer" title={link.url}>
                {link.label} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      <FlowList flows={flowsOfNode(model, id)} onGoToFlow={onGoToFlow} />

      <PanelSectionsContext.Provider value={sections}>
        <div id="detail-sections">{shown.map(renderSection)}</div>
      </PanelSectionsContext.Provider>
    </>
  );
}

function EdgeDetail({ model, id, hiddenKinds, onGoToNode, onGoToFlow }: DetailProps) {
  const edge = model.edges.find((candidate) => candidate.id === id);
  if (!edge) return null;
  return (
    <>
      <h2 id="detail-title">{edge.label ?? edge.id}</h2>
      <p className="detail-ends" id="detail-ends">
        <NodeLink model={model} id={edge.from} onGoToNode={onGoToNode} />
        <span className="detail-arrow"> → </span>
        <NodeLink model={model} id={edge.to} onGoToNode={onGoToNode} />
      </p>
      <dl className="detail-fields">
        <Field label="ID">
          <code>{edge.id}</code>
        </Field>
        <Field label="Kind">
          <span className={`kind-dot kind-dot-${edge.kind}`} aria-hidden="true" /> {edge.kind}
          {hiddenKinds.has(edge.kind) && ' (edge kind hidden)'}
        </Field>
        {edge.label !== undefined && <Field label="Label">{edge.label}</Field>}
        {edge.protocol !== undefined && <Field label="Protocol">{edge.protocol}</Field>}
      </dl>
      {edge.description !== undefined && <p className="detail-description">{edge.description}</p>}
      <FlowList flows={flowsOfEdge(model, id)} onGoToFlow={onGoToFlow} />
    </>
  );
}

function AggregateDetail({ model, id, edges, hiddenKinds, onGoToNode, onGoToEdge }: DetailProps) {
  const aggregate = edges.find((candidate) => candidate.id === id);
  if (!aggregate) return null;
  const { kind, count, memberEdgeIds } = aggregate.data;
  const members = memberEdgeIds
    .map((memberId) => model.edges.find((edge) => edge.id === memberId))
    .filter((edge) => edge !== undefined);
  return (
    <>
      <h2 id="detail-title">
        {count} {kind} edges
      </h2>
      <p className="detail-ends" id="detail-ends">
        <NodeLink model={model} id={aggregate.source} onGoToNode={onGoToNode} />
        <span className="detail-arrow"> → </span>
        <NodeLink model={model} id={aggregate.target} onGoToNode={onGoToNode} />
      </p>
      <dl className="detail-fields">
        <Field label="Kind">
          <span className={`kind-dot kind-dot-${kind}`} aria-hidden="true" /> {kind}
        </Field>
        <Field label="Count">{count}</Field>
      </dl>
      <section id="detail-members">
        <h3>Member edges</h3>
        <p className="detail-hint">
          Click one to open its groups, zoom to both ends and select it.
        </p>
        <ul className="detail-list">
          {members.map((edge) => (
            <EdgeItem
              key={edge.id}
              edge={edge}
              hidden={hiddenKinds.has(edge.kind)}
              onGoToEdge={onGoToEdge}
            >
              {name(model, edge.from)} → {name(model, edge.to)}
            </EdgeItem>
          ))}
        </ul>
      </section>
    </>
  );
}
