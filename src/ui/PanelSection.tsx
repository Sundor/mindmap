// A list in the node detail panel that can be folded away and put in another place: click the
// heading to fold or unfold it, drag the heading onto another one (or use the arrows) to move it.
// The order and the folded set are kept in the browser (src/core/panelSections.ts).

import { useContext, useState, type DragEvent, type ReactNode } from 'react';
import { isSectionCollapsed } from '../core';
import { PanelSectionsContext } from './panelSectionsContext';

/** What a dragged heading carries; other drags (files, text) are not ours. */
const DRAG_TYPE = 'application/x-architecture-map-section';

export interface PanelSectionProps {
  /** Key of the section in the stored arrangement. */
  readonly section: string;
  /** DOM id of the section element. */
  readonly id: string;
  readonly title: ReactNode;
  /** Extra `data-count` on the section, where a list has one. */
  readonly count?: number;
  readonly children: ReactNode;
}

export function PanelSection({ section, id, title, count, children }: PanelSectionProps) {
  const sections = useContext(PanelSectionsContext);
  const [dropTarget, setDropTarget] = useState(false);
  if (!sections) {
    return (
      <section id={id} data-count={count}>
        <h3>{title}</h3>
        {children}
      </section>
    );
  }
  const collapsed = isSectionCollapsed(sections.layout, section);
  const at = sections.shown.indexOf(section);
  const isSectionDrag = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);
  return (
    <section
      id={id}
      className={`detail-section${dropTarget ? ' detail-section-drop' : ''}`}
      data-section={section}
      data-collapsed={collapsed}
      data-count={count}
      onDragOver={(event) => {
        if (!isSectionDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        if (!isSectionDrag(event)) return;
        event.preventDefault();
        setDropTarget(false);
        const dragged = event.dataTransfer.getData(DRAG_TYPE);
        if (dragged !== '' && dragged !== section) sections.move(dragged, { before: section });
      }}
    >
      <h3
        className="detail-section-head"
        draggable
        title="Drag onto another heading to move this list"
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, section);
          event.dataTransfer.effectAllowed = 'move';
        }}
      >
        <button
          type="button"
          className="detail-section-toggle"
          aria-expanded={!collapsed}
          aria-controls={`${id}-body`}
          onClick={() => sections.toggle(section)}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <path d="M 2 3.5 L 5 6.5 L 8 3.5" />
          </svg>
          <span>{title}</span>
        </button>
        <span className="detail-section-moves">
          <button
            type="button"
            className="detail-section-move"
            data-move="up"
            aria-label="Move this list up"
            title="Move up"
            disabled={at <= 0}
            onClick={() => sections.move(section, 'up')}
          >
            ↑
          </button>
          <button
            type="button"
            className="detail-section-move"
            data-move="down"
            aria-label="Move this list down"
            title="Move down"
            disabled={at < 0 || at >= sections.shown.length - 1}
            onClick={() => sections.move(section, 'down')}
          >
            ↓
          </button>
        </span>
      </h3>
      <div id={`${id}-body`} hidden={collapsed}>
        {!collapsed && children}
      </div>
    </section>
  );
}
