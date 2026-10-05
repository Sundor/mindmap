// Recent maps: the maps opened from disk before, to
// open again with one click — in a drop-down of the toolbar, and on the page shown while no map
// is loaded. The files are read again from the disk each time; the browser may ask first.

import { useLayoutEffect, useRef, useState } from 'react';
import { dropdownOffset, recentMapLabel, type RecentMap } from '../core';

export interface RecentListProps {
  readonly id: string;
  readonly recents: readonly RecentMap<unknown>[];
  /** ID of the map that is shown now. */
  readonly current?: string;
  readonly onOpen: (id: string) => void;
  readonly onForget: (id: string) => void;
}

/** "5 Oct 2026", in the reader's own format; empty for an unknown time. */
function openedLabel(openedAt: number): string {
  if (openedAt <= 0) return '';
  return new Date(openedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function RecentList({ id, recents, current, onOpen, onForget }: RecentListProps) {
  return (
    <ul className="views-list recent-list" id={id}>
      {recents.map((entry) => {
        const label = recentMapLabel(entry);
        const detail = [entry.hint, openedLabel(entry.openedAt)].filter((part) => part !== '');
        return (
          <li
            key={entry.id}
            data-recent={label}
            data-current={entry.id === current ? 'true' : undefined}
          >
            <button
              type="button"
              className="recent-open"
              title={`Open ${label} again, as it is on the disk now`}
              onClick={() => onOpen(entry.id)}
            >
              <span className="recent-name">{label}</span>
              {detail.length > 0 && <span className="recent-hint">{detail.join(' · ')}</span>}
            </button>
            <button
              type="button"
              className="views-delete recent-forget"
              title={`Forget ${label} (the files stay where they are)`}
              aria-label={`Forget ${label}`}
              onClick={() => onForget(entry.id)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export type RecentMenuProps = Omit<RecentListProps, 'id'>;

export function RecentMenu({ recents, current, onOpen, onForget }: RecentMenuProps) {
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = details.current?.getBoundingClientRect();
      const element = body.current;
      if (!anchor || !element) return;
      const viewportWidth = document.documentElement.clientWidth;
      element.style.left = `${dropdownOffset(anchor, element.offsetWidth, viewportWidth)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  return (
    <details
      className="settings recent"
      id="recent"
      ref={details}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title="Maps opened before: open one again with a click">
        Recent ({recents.length})
      </summary>
      <div className="settings-body views-body" ref={body}>
        <div className="settings-heading">
          <span>Open again</span>
        </div>
        <RecentList
          id="recent-list"
          recents={recents}
          current={current}
          onOpen={(id) => {
            if (details.current) details.current.open = false;
            onOpen(id);
          }}
          onForget={onForget}
        />
        <small className="settings-note">
          The files are read again from the disk; the browser may ask for your permission first.
          Only the reference to a file is kept in this browser, not its content.
        </small>
      </div>
    </details>
  );
}
