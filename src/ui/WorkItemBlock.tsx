// The work items of a node on the canvas: its lines in the block the layout
// reserved, or the badge with the counts where the lines are not drawn. What is listed and how
// much room it has both come from src/core/workItemContent.ts; nothing is measured here.

import { memo, useContext, type CSSProperties, type MouseEvent } from 'react';
import {
  DIMMED_CLASS,
  isOpenState,
  plural,
  WORK_ITEM_GEOMETRY,
  workItemCountsText,
  Z_INDEX,
  type ArchNodeData,
  type FlowNode,
  type Rect,
  type WorkItemCounts,
  type WorkItemLine,
} from '../core';
import { WorkItemIcon } from './WorkItemIcon';
import { WorkItemCanvasContext } from './workItemContext';

/** The numbers of `WORK_ITEM_GEOMETRY` the style sheet uses (`.arch-workitems` in styles.css). */
const GEOMETRY_STYLE = {
  '--wi-line-height': `${WORK_ITEM_GEOMETRY.lineHeight}px`,
  '--wi-font-size': `${WORK_ITEM_GEOMETRY.fontSize}px`,
  '--wi-task-font-size': `${WORK_ITEM_GEOMETRY.taskFontSize}px`,
  '--wi-icon-size': `${WORK_ITEM_GEOMETRY.iconSize}px`,
  '--wi-icon-gap': `${WORK_ITEM_GEOMETRY.iconGap}px`,
  '--wi-task-indent': `${WORK_ITEM_GEOMETRY.taskIndent}px`,
  '--wi-padding-x': `${WORK_ITEM_GEOMETRY.paddingX}px`,
  '--wi-padding-top': `${WORK_ITEM_GEOMETRY.paddingTop}px`,
  '--wi-padding-bottom': `${WORK_ITEM_GEOMETRY.paddingBottom}px`,
  '--wi-badge-height': `${WORK_ITEM_GEOMETRY.badgeHeight}px`,
  '--wi-badge-font-size': `${WORK_ITEM_GEOMETRY.badgeFontSize}px`,
} as CSSProperties;

function stopPropagation(event: MouseEvent): void {
  event.stopPropagation();
}

/**
 * The counts of a node whose lines are not drawn: the work items of the node and of everything
 * hidden inside it, and the open bugs among them.
 */
export function WorkItemBadge({ counts }: { counts: WorkItemCounts }) {
  const text = workItemCountsText(counts);
  return (
    <span
      className="arch-badge"
      style={GEOMETRY_STYLE}
      title={text}
      aria-label={text}
      data-stories={counts.stories}
      data-open-bugs={counts.openBugs}
    >
      <span className="arch-badge-part">
        <WorkItemIcon type="User Story" />
        {counts.stories}
      </span>
      {counts.openBugs > 0 && (
        <span className="arch-badge-part">
          <WorkItemIcon type="Bug" />
          {counts.openBugs}
        </span>
      )}
    </span>
  );
}

function Line({ line }: { line: WorkItemLine }) {
  const canvas = useContext(WorkItemCanvasContext);
  if (line.kind === 'more') {
    return (
      <li
        className="arch-workitem-more"
        data-line-kind="more"
        title={`${plural(line.count, 'more line')}: select the box to see all its work items in the panel`}
      >
        {line.text}
      </li>
    );
  }
  const { item } = line;
  const selected = canvas.selectedId === item.id;
  // The line of the item a selected task belongs to, where the task itself has no line.
  const related = !selected && canvas.parentId === item.id;
  const closed = !isOpenState(item.state);
  return (
    <li>
      <button
        type="button"
        // As for the chevron: no drag, no pan, and Enter / Space must not select the node.
        className={`arch-workitem arch-workitem-${line.kind} nodrag nopan nokey${
          closed ? ' arch-workitem-closed' : ''
        }${selected ? ' arch-workitem-selected' : ''}${related ? ' arch-workitem-related' : ''}`}
        data-workitem-id={item.id}
        data-line-kind={line.kind}
        data-state={item.state}
        aria-pressed={selected}
        title={`${item.type} #${item.id} · ${item.state}\n${item.title}`}
        // The click selects the work item, not the node, and is no half of a double-click.
        onClick={(event) => {
          event.stopPropagation();
          canvas.select(item.id);
        }}
        onDoubleClick={stopPropagation}
      >
        <WorkItemIcon type={item.type} />
        {/* An item shows as much of its title as the box has room for; a task its first words. */}
        <span className="arch-workitem-text">{line.kind === 'item' ? item.title : line.text}</span>
      </button>
    </li>
  );
}

function placed(rect: Rect): CSSProperties {
  return {
    ...GEOMETRY_STYLE,
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function Lines({ lines }: { lines: readonly WorkItemLine[] }) {
  return lines.map((line, index) => (
    <Line
      key={line.kind === 'more' ? 'more' : `${line.kind}:${line.item.id}:${index}`}
      line={line}
    />
  ));
}

/**
 * The block of a leaf or an open group: the lines at the `detail` level, otherwise the badge.
 * Rendered beside the node's box (like the handles), so it is placed against the node itself,
 * exactly where the layout reserved it. A closed group draws its badge in its body instead, and
 * the lines of an open group are drawn above the edges by {@link GroupWorkItemLists}.
 */
export function WorkItemBlock({ data }: { data: ArchNodeData }) {
  const rect = data.contentRect;
  if (!rect) {
    // No room is reserved while the lines are not drawn (below the Everything level): the badge
    // then sits on the top edge of the box, at its right end, where it covers nothing.
    if (!data.badge || data.collapsed) return null;
    return (
      <div className="arch-badge-corner">
        <WorkItemBadge counts={data.badge} />
      </div>
    );
  }
  const style = placed(rect);
  if (data.workItems) {
    if (data.workItems.above) return null;
    return (
      <ul className="arch-workitems" style={style} data-lines={data.workItems.lines.length}>
        <Lines lines={data.workItems.lines} />
      </ul>
    );
  }
  if (data.badge && !data.collapsed) {
    return (
      <div className="arch-workitems arch-workitems-badge" style={style}>
        <WorkItemBadge counts={data.badge} />
      </div>
    );
  }
  return null;
}

/**
 * The work-item lists of the open groups, to be rendered into the viewport (`<ViewportPortal>`)
 * rather than inside their nodes: a group lies below the edges that run to its children, and
 * its list must not — an edge across a line would hide the text and take the click. Each list
 * is placed in canvas coordinates where the layout reserved it (`data.workItems.above`), at the
 * height of the leaves, on a background of its own. A click beside the lines selects the group.
 * Rendered again only for other nodes: a flow that differs in its edges alone leaves the lists.
 */
export const GroupWorkItemLists = memo(function GroupWorkItemLists({
  nodes,
  onSelectNode,
}: {
  nodes: readonly FlowNode[];
  onSelectNode: (id: string) => void;
}) {
  return nodes.map((node) => {
    if (node.type === 'band' || !node.data.workItems?.above) return null;
    const { lines, above } = node.data.workItems;
    const dimmed = node.className?.split(' ').includes(DIMMED_CLASS) === true;
    return (
      // The lines are the controls; a click on the list itself is one on the group's box.
      <ul
        key={node.id}
        className={`arch-workitems arch-workitems-above${dimmed ? ` ${DIMMED_CLASS}` : ''}`}
        style={{ ...placed(above), zIndex: Z_INDEX.leaf }}
        data-node-id={node.id}
        data-lines={lines.length}
        onClick={() => onSelectNode(node.id)}
      >
        <Lines lines={lines} />
      </ul>
    );
  });
});
