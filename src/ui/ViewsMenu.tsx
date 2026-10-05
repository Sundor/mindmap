// Saved views: a drop-down in the toolbar to keep the current arrangement of the
// map under a name, come back to it, delete it, or copy a link that carries it.

import { useLayoutEffect, useRef, useState } from 'react';
import { dropdownOffset, VIEW_NAME_MAX, type SavedView } from '../core';

export interface ViewsMenuProps {
  readonly views: readonly SavedView[];
  readonly onSave: (name: string) => void;
  readonly onApply: (view: SavedView) => void;
  readonly onDelete: (name: string) => void;
  /** Copies the link of `view` (or of the current arrangement when undefined); resolves to true on success. */
  readonly onCopyLink: (view: SavedView | undefined) => Promise<boolean>;
}

export function ViewsMenu({ views, onSave, onApply, onDelete, onCopyLink }: ViewsMenuProps) {
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string>();
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

  const save = () => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    onSave(trimmed);
    setName('');
    setNote(`Saved "${trimmed}".`);
  };
  const copy = (view: SavedView | undefined) => {
    void onCopyLink(view).then((ok) =>
      setNote(
        ok ? 'Link copied to the clipboard.' : 'Could not copy; the link is in the address bar.',
      ),
    );
  };
  return (
    <details
      className="settings views"
      id="views"
      ref={details}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) setNote(undefined);
      }}
    >
      <summary title="Saved views: keep the current arrangement under a name, or share it as a link">
        Views{views.length > 0 ? ` (${views.length})` : ''}
      </summary>
      <div className="settings-body views-body" ref={body}>
        <div className="settings-heading">
          <span>Save the current view</span>
        </div>
        <form
          className="views-save"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            id="view-name"
            type="text"
            placeholder="Name"
            maxLength={VIEW_NAME_MAX}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" id="save-view" disabled={name.trim() === ''}>
            Save
          </button>
          <button
            type="button"
            id="copy-view-link"
            title="Copy a link that opens the viewer with this arrangement"
            onClick={() => copy(undefined)}
          >
            Copy link
          </button>
        </form>
        {views.length > 0 && (
          <ul className="views-list" id="views-list">
            {views.map((view) => (
              <li key={view.name} data-view-name={view.name}>
                <button
                  type="button"
                  className="views-apply"
                  title={`Show "${view.name}"`}
                  onClick={() => onApply(view)}
                >
                  {view.name}
                </button>
                <button
                  type="button"
                  className="views-link"
                  title={`Copy a link to "${view.name}"`}
                  aria-label={`Copy a link to ${view.name}`}
                  onClick={() => copy(view)}
                >
                  ⎘
                </button>
                <button
                  type="button"
                  className="views-delete"
                  title={`Delete "${view.name}"`}
                  aria-label={`Delete ${view.name}`}
                  onClick={() => onDelete(view.name)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {note !== undefined && (
          <small className="settings-note" id="views-note" role="status">
            {note}
          </small>
        )}
        <small className="settings-note">
          A view keeps the collapsed groups, hidden edge kinds, level of detail, focus, colouring,
          story mode and where the view is. Saved views stay in this browser; a link carries the
          view itself.
        </small>
      </div>
    </details>
  );
}
