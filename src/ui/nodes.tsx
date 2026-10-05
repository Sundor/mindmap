// Custom React Flow nodes: group (domain/component with children), leaf, and row band.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Fragment, useContext, type CSSProperties, type MouseEvent } from 'react';
import {
  collapseAction,
  COMPACT_GROUP,
  compactGroupText,
  HEAT_STOPS,
  NODE_LEVEL_NAMES,
  PLACED_BY_CONNECTIONS,
  plural,
  progressText,
  SIDES,
  sourceHandleId,
  targetHandleId,
  type ArchNodeData,
  type Side,
} from '../core';
import { CollapseContext } from './collapseContext';
import { NodeLensContext, type NodeLenses } from './nodeLensContext';
import { WorkItemBadge, WorkItemBlock } from './WorkItemBlock';
import type { ArchRFNode, BandRFNode } from './flowTypes';

const POSITION: Readonly<Record<Side, Position>> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/**
 * Invisible source and target handles in the middle of every side. Edges name the pair of sides
 * they attach to (`routeEdge` in src/core/route.ts: normally the sides facing each other), which
 * gives "floating" edges without measuring anything at render time.
 */
function SideHandles() {
  return (
    <>
      {SIDES.map((side) => (
        <Fragment key={side}>
          <Handle
            type="source"
            id={sourceHandleId(side)}
            position={POSITION[side]}
            isConnectable={false}
            className="arch-handle"
          />
          <Handle
            type="target"
            id={targetHandleId(side)}
            position={POSITION[side]}
            isConnectable={false}
            className="arch-handle"
          />
        </Fragment>
      ))}
    </>
  );
}

function tooltip(data: ArchNodeData): string | undefined {
  const placed =
    data.placedRowName === undefined
      ? undefined
      : `${PLACED_BY_CONNECTIONS} (${data.placedRowName})`;
  const parts = [data.description, placed].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function nodeClass(kind: 'group' | 'leaf', data: ArchNodeData): string {
  const placed = data.placedRowName === undefined ? '' : ' arch-node-placed';
  return `arch-node arch-${kind} arch-level-${data.levelName}${placed}`;
}

/**
 * What a collapsed group contains: its direct children and, when it has any, the nodes below
 * them, e.g. "3 components · 7 subcomponents". The work items inside are counted by its badge.
 */
function contentSummary(data: ArchNodeData): string {
  const { children, descendants } = data.counts;
  const parts = [plural(children, NODE_LEVEL_NAMES[data.level + 1] ?? 'node')];
  if (descendants > children) {
    parts.push(plural(descendants - children, NODE_LEVEL_NAMES[data.level + 2] ?? 'node'));
  }
  return parts.join(' · ');
}

function stopPropagation(event: MouseEvent): void {
  event.stopPropagation();
}

/** The gradient of the heat strips: the stops of `HEAT_STOPS`, from the bottom up. */
const HEAT_GRADIENT = `linear-gradient(to top, ${HEAT_STOPS.join(', ')})`;

/** The class and style a node gets from the lenses: the tint of "Colour by". */
function lensStyle(id: string, lenses: NodeLenses): { className: string; style?: CSSProperties } {
  const color = lenses.colors?.get(id);
  if (!color) return { className: '' };
  return {
    className: ' arch-tinted',
    style: { '--tint-light': color.light, '--tint-dark': color.dark } as CSSProperties,
  };
}

/**
 * What the lenses draw on a box: the heat strips up its sides (as tall as the work left in it,
 * against the hottest box of its level; smouldering at the bottom, white-hot at the top) and the
 * progress bar along its bottom edge.
 */
function LensMarks({ id }: { id: string }) {
  const lenses = useContext(NodeLensContext);
  const heat = lenses.heat?.get(id);
  const progress = lenses.progress?.get(id);
  if (!heat && !progress) return null;
  const heatStyle = heat
    ? ({
        '--heat': Math.max(0.08, Math.min(1, heat.fraction)),
        backgroundImage: HEAT_GRADIENT,
      } as CSSProperties)
    : undefined;
  const heatTitle = heat ? `${plural(heat.open, 'open work item')} in here` : undefined;
  const done = progress && progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <>
      {heat && (
        <>
          <span
            className="arch-heat arch-heat-left"
            style={heatStyle}
            title={heatTitle}
            data-heat={heat.open}
          />
          <span className="arch-heat arch-heat-right" style={heatStyle} title={heatTitle} />
        </>
      )}
      {progress && (
        <span
          className="arch-progress"
          style={{ '--done': done } as CSSProperties}
          title={progressText(progress)}
          data-done={progress.done}
          data-total={progress.total}
        />
      )}
    </>
  );
}

/** The numbers of `COMPACT_GROUP` the style sheet uses (`.arch-compact` in styles.css). */
const COMPACT_STYLE = {
  '--compact-padding-x': `${COMPACT_GROUP.paddingX}px`,
  '--compact-name-size': `${COMPACT_GROUP.nameSize}px`,
  '--compact-name-line': `${COMPACT_GROUP.nameLine}px`,
  '--compact-header-top': `${COMPACT_GROUP.headerTop}px`,
  '--compact-header-bottom': `${COMPACT_GROUP.headerBottom}px`,
  '--compact-text-size': `${COMPACT_GROUP.textSize}px`,
  '--compact-text-line': `${COMPACT_GROUP.textLine}px`,
  '--compact-body-top': `${COMPACT_GROUP.bodyTop}px`,
  '--compact-body-bottom': `${COMPACT_GROUP.bodyBottom}px`,
} as CSSProperties;

export function GroupNode({ id, data }: NodeProps<ArchRFNode>) {
  const toggleCollapse = useContext(CollapseContext);
  const lens = lensStyle(id, useContext(NodeLensContext));
  const { collapsed } = data;
  // The chevron edits the manual set only; a group closed just by the level of detail has no
  // toggle (see `collapseAction`) and opens by zooming in.
  const toggle = collapseAction(data);
  const action =
    toggle === undefined
      ? `${data.name}: zoom in to expand`
      : `${toggle === 'expand' ? 'Expand' : 'Collapse'} ${data.name}`;
  // Handles are siblings of the box, not children: they are then positioned against the node
  // wrapper, so edges end exactly on the outer edge of the border.
  return (
    <>
      <div
        className={`${nodeClass('group', data)}${collapsed ? ' arch-collapsed' : ''}${
          data.compact ? ' arch-compact' : ''
        }${lens.className}`}
        title={tooltip(data)}
        data-placed={data.placedRowName !== undefined || undefined}
        data-collapsed={collapsed}
        {...(data.compact || lens.style
          ? { style: { ...(data.compact ? COMPACT_STYLE : {}), ...lens.style } }
          : {})}
      >
        <div className="arch-group-header">
          <button
            type="button"
            // `nokey`: Enter / Space on the button must not also select the node (React Flow
            // treats them as selection keys for anything inside a node without that class).
            className="arch-chevron nodrag nopan nokey"
            aria-expanded={!collapsed}
            aria-label={action}
            title={action}
            disabled={toggle === undefined}
            // The click must not select the node, nor count towards a double-click toggle.
            onClick={(event) => {
              event.stopPropagation();
              toggleCollapse(id);
            }}
            onDoubleClick={stopPropagation}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              <path d="M 2 3.5 L 5 6.5 L 8 3.5" />
            </svg>
          </button>
          <span className="arch-node-name">{data.name}</span>
          <span className="arch-level-tag">{data.levelName}</span>
        </div>
        {collapsed && (
          // Shrunk: the names of what is inside; full box: how much is inside.
          <div className="arch-collapsed-body" title={contentSummary(data)}>
            <span className="arch-collapsed-text">
              {data.compact
                ? compactGroupText(data.childNames, data.compactHidden)
                : contentSummary(data)}
            </span>
            {data.badge && <WorkItemBadge counts={data.badge} />}
          </div>
        )}
        <LensMarks id={id} />
      </div>
      {/* The badge of an open group; its lines are drawn above the edges (GroupWorkItemLists). */}
      {!collapsed && <WorkItemBlock data={data} />}
      <SideHandles />
    </>
  );
}

export function LeafNode({ id, data }: NodeProps<ArchRFNode>) {
  const lens = lensStyle(id, useContext(NodeLensContext));
  // With a block reserved for its work items, the name keeps to the part above the block.
  const reserved = data.contentRect?.height;
  const style: CSSProperties = {
    ...(reserved !== undefined ? { paddingBottom: reserved } : {}),
    ...lens.style,
  };
  return (
    <>
      <div
        className={`${nodeClass('leaf', data)}${lens.className}`}
        title={tooltip(data)}
        data-placed={data.placedRowName !== undefined || undefined}
        {...(Object.keys(style).length > 0 ? { style } : {})}
      >
        <span className="arch-node-name">{data.name}</span>
        <LensMarks id={id} />
      </div>
      <WorkItemBlock data={data} />
      <SideHandles />
    </>
  );
}

/** Row band or the Unassigned area: a non-interactive background with a label. */
export function BandNode({ data }: NodeProps<BandRFNode>) {
  if (data.variant === 'unassigned') {
    return (
      <div className="arch-band arch-band-unassigned">
        <div className="arch-band-title">{data.name}</div>
      </div>
    );
  }
  return (
    <div className={`arch-band arch-band-${data.index % 2 === 0 ? 'even' : 'odd'}`}>
      <div className="arch-band-gutter" style={{ width: data.gutterWidth }}>
        {data.name}
      </div>
    </div>
  );
}
