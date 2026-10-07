// Recent maps: the maps opened from disk before, to
// open again with one click — on the Files tab of the control panel, and on the page shown while
// no map is loaded. The files are read again from the disk each time; the browser may ask first.

import { recentMapLabel, type RecentMap } from '../core';

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
