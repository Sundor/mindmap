// Work items in the detail panel: the view of a selected work item — the
// only place that shows its description and parameters and the full text of its tasks — and the
// "linked work items" section of a node. Everything shown is computed by src/core.

import type { ReactNode } from 'react';
import {
  childWorkItems,
  isOpenState,
  isWebUrl,
  moreLinesText,
  plural,
  STORY_MODE_LABELS,
  subtreeWorkItemCounts,
  WORK_ITEM_GEOMETRY,
  workItemLines,
  workItemPlace,
  workItemsOfNode,
  type ArchitectureModel,
  type StoryMode,
  type WorkItemOverlay,
  type WorkItemPlace,
  type WorkItemSummary,
} from '../core';
import { Field, NodeLink } from './detailParts';
import { WorkItemIcon } from './WorkItemIcon';
import { PanelSection } from './PanelSection';

export interface WorkItemPanelProps {
  readonly model: ArchitectureModel;
  readonly overlay: WorkItemOverlay;
  readonly storyMode: StoryMode;
  readonly onGoToNode: (id: string) => void;
  /** Select a work item and bring a node that lists it on screen, opened far enough to show it. */
  readonly onGoToWorkItem: (id: number) => void;
  readonly onChooseStoryMode: (mode: StoryMode) => void;
  /** The Focus button of the item (the app owns the focus). */
  readonly focusButton?: ReactNode;
}

/** State and assignee of an item, as the second line of a list entry. */
function context(item: WorkItemSummary): string {
  const parts = [`#${item.id}`, item.state];
  if (item.assignedTo !== undefined) parts.push(item.assignedTo);
  return parts.join(' · ');
}

/**
 * A link to the item in ADO, when the data has one. The parser of the data file lets only web
 * addresses through; checked here as well, for items that reach the panel another way.
 */
function ExternalLink({ item }: { item: WorkItemSummary }) {
  if (item.url === undefined || !isWebUrl(item.url)) return null;
  return (
    <a
      className="detail-external"
      href={item.url}
      target="_blank"
      rel="noreferrer"
      title={`Open #${item.id} in Azure DevOps`}
      aria-label={`Open #${item.id} in Azure DevOps`}
    >
      ↗
    </a>
  );
}

/** One work item in a list: type icon, the full title, then ID, state and assignee. */
function WorkItemEntry({
  item,
  onGoToWorkItem,
  children,
}: {
  item: WorkItemSummary;
  onGoToWorkItem: (id: number) => void;
  children?: ReactNode;
}) {
  return (
    <li>
      <div className="detail-workitem-row">
        <button
          type="button"
          className={`detail-edge detail-workitem${isOpenState(item.state) ? '' : ' detail-workitem-closed'}`}
          data-workitem-id={item.id}
          data-workitem-type={item.type}
          title={`${item.type} #${item.id}`}
          onClick={() => onGoToWorkItem(item.id)}
        >
          <WorkItemIcon type={item.type} labelled />
          <span className="detail-edge-text">
            <span className="detail-workitem-title">{item.title}</span>
            <span className="detail-edge-context">{context(item)}</span>
          </span>
        </button>
        <ExternalLink item={item} />
      </div>
      {children}
    </li>
  );
}

/** Why the canvas does not draw the item, and what to do about it; nothing when it does. */
function PlaceNote({
  model,
  overlay,
  storyMode,
  item,
  place,
  onGoToWorkItem,
  onChooseStoryMode,
}: WorkItemPanelProps & { item: WorkItemSummary; place: WorkItemPlace }) {
  const names = place.nodeIds.map((id) => model.nodes.get(id)?.name ?? id).join(', ');
  let text: string;
  let action: ReactNode = null;
  switch (place.status) {
    case 'drawn':
      return (
        <p className="detail-note" id="detail-workitem-place" data-place="drawn">
          <button
            type="button"
            id="detail-workitem-show"
            className="detail-link"
            title="Open the box that lists it and zoom in until its line is drawn"
            onClick={() => onGoToWorkItem(item.id)}
          >
            Show on the map
          </button>
        </p>
      );
    case 'off':
      text = 'Not drawn on the map: the Stories selector is Off.';
      action = (
        <button
          type="button"
          id="detail-workitem-mode"
          className="detail-link"
          onClick={() => onChooseStoryMode(overlay.listedUnder.has(item.id) ? 'tasks' : 'stories')}
        >
          Show {overlay.listedUnder.has(item.id) ? 'stories and tasks' : 'stories'}
        </button>
      );
      break;
    case 'tasks-off':
      text = `Not drawn on the map: tasks are listed in the ${STORY_MODE_LABELS.tasks} mode only (now: ${STORY_MODE_LABELS[storyMode]}).`;
      action = (
        <button
          type="button"
          id="detail-workitem-mode"
          className="detail-link"
          onClick={() => onChooseStoryMode('tasks')}
        >
          Show tasks
        </button>
      );
      break;
    case 'folded': {
      const [first] = place.nodeIds;
      const lines = first === undefined ? [] : workItemLines(overlay, first, storyMode);
      const more = lines.find((line) => line.kind === 'more');
      text = `Not drawn on the map: the list of ${names} is cut off after ${
        WORK_ITEM_GEOMETRY.maxLines - 1
      } lines, and this item is under "${more?.text ?? moreLinesText(1)}".`;
      break;
    }
    case 'unplaced':
      text =
        item.componentIds.length > 0
          ? 'Not on the map: its comp: tags name no node of the structure.'
          : item.type === 'Task' && item.parentId !== undefined
            ? 'Not on the map: neither the task nor the items above it have a comp: tag that names a node.'
            : 'Not on the map: it has no comp: tag.';
      break;
    default:
      return null;
  }
  return (
    <p className="detail-note" id="detail-workitem-place" data-place={place.status}>
      {text} {action}
    </p>
  );
}

/** The panel of a selected work item. */
export function WorkItemDetail(props: WorkItemPanelProps & { readonly id: number }) {
  const { model, overlay, storyMode, id, onGoToNode, onGoToWorkItem } = props;
  const item = overlay.byId.get(id);
  if (!item) return null;
  const place = workItemPlace(overlay, storyMode, id);
  const parent = item.parentId === undefined ? undefined : overlay.byId.get(item.parentId);
  const children = childWorkItems(overlay, id);
  let allChildren = 0;
  for (const other of overlay.byId.values()) if (other.parentId === id) allChildren += 1;
  const filteredChildren = allChildren - children.length;
  const onlyTasks = children.every((child) => child.type === 'Task');
  const known = item.componentIds.filter((nodeId) => model.nodes.has(nodeId));
  const unknown = item.componentIds.filter((nodeId) => !model.nodes.has(nodeId));
  // A task without tags of its own is on the map with the item it belongs to.
  const inherited = known.length === 0 ? place.nodeIds : [];
  return (
    <>
      <h2 id="detail-title" className="detail-workitem-heading">
        <WorkItemIcon type={item.type} labelled />
        <span>{item.title}</span>
      </h2>
      <p className="detail-ends" id="detail-workitem-id">
        {item.type} #{item.id} <ExternalLink item={item} />
        {props.focusButton}
      </p>
      <PlaceNote {...props} item={item} place={place} />
      <dl className="detail-fields" id="detail-workitem-fields">
        <Field label="State">{item.state}</Field>
        {item.assignedTo !== undefined && <Field label="Assigned to">{item.assignedTo}</Field>}
        {item.iteration !== undefined && <Field label="Iteration">{item.iteration}</Field>}
        {Object.entries(item.fields ?? {}).map(([name, value]) => (
          <Field key={name} label={name}>
            {String(value)}
          </Field>
        ))}
        {item.tags.length > 0 && <Field label="Tags">{item.tags.join(', ')}</Field>}
      </dl>
      {item.description !== undefined && (
        <p className="detail-description" id="detail-workitem-description">
          {item.description}
        </p>
      )}

      <section id="detail-workitem-nodes">
        <h3>{inherited.length > 0 ? 'On the map with its parent' : 'Tagged to'}</h3>
        {known.length + unknown.length + inherited.length === 0 ? (
          <p className="detail-hint">No comp: tag.</p>
        ) : (
          <ul className="detail-list detail-children">
            {[...known, ...inherited].map((nodeId) => (
              <li key={nodeId}>
                <NodeLink model={model} id={nodeId} onGoToNode={onGoToNode} />
              </li>
            ))}
            {unknown.map((nodeId) => (
              <li key={nodeId} className="detail-unknown" title="Not a node of the structure">
                <code>{nodeId}</code> (unknown)
              </li>
            ))}
          </ul>
        )}
      </section>

      {item.parentId !== undefined && (
        <section id="detail-workitem-parent">
          <h3>Parent</h3>
          {parent && overlay.shownIds.has(parent.id) ? (
            <ul className="detail-list">
              <WorkItemEntry item={parent} onGoToWorkItem={onGoToWorkItem} />
            </ul>
          ) : (
            <p className="detail-hint">
              {parent
                ? `${parent.type} #${parent.id} "${parent.title}" (${parent.state}) is hidden by the filter.`
                : `#${item.parentId} is not in the work-items file.`}
            </p>
          )}
        </section>
      )}

      {allChildren > 0 && (
        <section id="detail-workitem-tasks">
          <h3>
            {onlyTasks ? 'Tasks' : 'Child items'} ({children.length})
          </h3>
          <ul className="detail-list">
            {children.map((child) => (
              <WorkItemEntry key={child.id} item={child} onGoToWorkItem={onGoToWorkItem} />
            ))}
          </ul>
          {filteredChildren > 0 && (
            <p className="detail-hint">{filteredChildren} more hidden by the filter.</p>
          )}
        </section>
      )}
    </>
  );
}

/**
 * The "linked work items" of a node: those tagged to the node itself, then those of
 * every node below it, each group under the name of its node; tasks are listed under their item.
 */
export function NodeWorkItems({
  model,
  overlay,
  id,
  onGoToNode,
  onGoToWorkItem,
}: Pick<WorkItemPanelProps, 'model' | 'overlay' | 'onGoToNode' | 'onGoToWorkItem'> & {
  readonly id: string;
}) {
  if (overlay.shown.length === 0) return null;
  const groups = workItemsOfNode(model, overlay, id, { descendants: true });
  const counts = subtreeWorkItemCounts(overlay, id);
  return (
    <PanelSection
      section="workitems"
      id="detail-workitems"
      count={counts.stories}
      title={`Work items (${counts.stories}${
        counts.openBugs > 0 ? `, ${plural(counts.openBugs, 'open bug')}` : ''
      })`}
    >
      {groups.length === 0 && <p className="detail-hint">None tagged to this node.</p>}
      {groups.map((group) => (
        <div key={group.nodeId} className="detail-workitem-group" data-node-id={group.nodeId}>
          <h4>
            {group.nodeId === id ? (
              'On this node'
            ) : (
              <>
                In <NodeLink model={model} id={group.nodeId} onGoToNode={onGoToNode} />
              </>
            )}
          </h4>
          <ul className="detail-list">
            {group.rows.map((row) => (
              <WorkItemEntry key={row.item.id} item={row.item} onGoToWorkItem={onGoToWorkItem}>
                {row.tasks.length > 0 && (
                  <ul className="detail-list detail-workitem-tasks">
                    {row.tasks.map((task) => (
                      <WorkItemEntry key={task.id} item={task} onGoToWorkItem={onGoToWorkItem} />
                    ))}
                  </ul>
                )}
              </WorkItemEntry>
            ))}
          </ul>
        </div>
      ))}
    </PanelSection>
  );
}
