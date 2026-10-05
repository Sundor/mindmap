// The panel of a flow: what it tells, its steps in order, the nodes it names, and
// the button that puts the map's focus on it.

import {
  edgeLabelText,
  focusSet,
  plural,
  sameFocus,
  type ArchitectureModel,
  type Focus,
} from '../core';
import { Field, NodeLink } from './detailParts';

export interface FlowDetailProps {
  readonly model: ArchitectureModel;
  readonly id: string;
  readonly focus: Focus | undefined;
  readonly onFocus: (focus: Focus | undefined) => void;
  readonly onGoToNode: (id: string) => void;
  readonly onGoToEdge: (id: string) => void;
}

/** The "Focus" / "Clear focus" button for `target`, as the flow and work-item panels show it. */
export function FocusButton({
  target,
  focus,
  onFocus,
}: {
  target: Focus;
  focus: Focus | undefined;
  onFocus: (focus: Focus | undefined) => void;
}) {
  const active = sameFocus(focus, target);
  return (
    <button
      type="button"
      className={`detail-focus${active ? ' detail-focus-active' : ''}`}
      data-focus-button={`${target.type}:${target.id}`}
      aria-pressed={active}
      title={
        active
          ? 'The map is focused on this: everything else is paled. Click to clear the focus.'
          : 'Focus the map on this: what it involves stays lit, everything else is paled.'
      }
      onClick={() => onFocus(active ? undefined : target)}
    >
      {active ? 'Clear focus' : 'Focus'}
    </button>
  );
}

export function FlowDetail({ model, id, focus, onFocus, onGoToNode, onGoToEdge }: FlowDetailProps) {
  const flow = model.flows.find((candidate) => candidate.id === id);
  if (!flow) return null;
  const set = focusSet(model, { type: 'flow', id });
  const edges = new Map(model.edges.map((edge) => [edge.id, edge]));
  return (
    <>
      <h2 id="detail-title">{flow.name}</h2>
      <dl className="detail-fields">
        <Field label="ID">
          <code>{flow.id}</code>
        </Field>
        <Field label="Kind">{flow.kind === 'dataflow' ? 'Data flow' : 'Workflow'}</Field>
        <Field label="Involves">
          {plural(set?.nodes.size ?? 0, 'node')} · {plural(flow.edgeIds.length, 'step')}
        </Field>
      </dl>
      {flow.description !== undefined && <p className="detail-description">{flow.description}</p>}
      <p>
        <FocusButton target={{ type: 'flow', id }} focus={focus} onFocus={onFocus} />
      </p>
      {flow.edgeIds.length > 0 && (
        <section id="detail-flow-steps">
          <h3>Steps</h3>
          <ol className="detail-list detail-steps">
            {flow.edgeIds.map((edgeId, index) => {
              const edge = edges.get(edgeId);
              if (!edge) return null;
              return (
                <li key={`${index}:${edgeId}`}>
                  <button
                    type="button"
                    className="detail-edge"
                    data-edge-id={edge.id}
                    title={edge.id}
                    onClick={() => onGoToEdge(edge.id)}
                  >
                    <span className="detail-step-number">{index + 1}</span>
                    <span className={`kind-dot kind-dot-${edge.kind}`} aria-hidden="true" />
                    <span className="detail-edge-text">
                      <span className="detail-edge-label">{edgeLabelText(edge) ?? edge.id}</span>
                      <span className="detail-edge-context">
                        {model.nodes.get(edge.from)?.name ?? edge.from} →{' '}
                        {model.nodes.get(edge.to)?.name ?? edge.to}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {flow.nodeIds.length > 0 && (
        <section id="detail-flow-nodes">
          <h3>Nodes named by the flow</h3>
          <ul className="detail-list">
            {flow.nodeIds.map((nodeId) => (
              <li key={nodeId}>
                <NodeLink model={model} id={nodeId} onGoToNode={onGoToNode} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
