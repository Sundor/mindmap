// Saved views: the tab of the control panel to keep the current arrangement of the map under a
// name, come back to it, delete it, or copy a link that carries it.

import { useState } from 'react';
import { VIEW_NAME_MAX, type SavedView } from '../core';

export interface ViewsTabProps {
  /** A map is drawn: without one there is no arrangement to keep. */
  readonly drawn: boolean;
  /** The tab is the one shown; the note about what was just done goes when it is left. */
  readonly active: boolean;
  readonly views: readonly SavedView[];
  readonly onSave: (name: string) => void;
  readonly onApply: (view: SavedView) => void;
  readonly onDelete: (name: string) => void;
  /** Copies the link of `view` (or of the current arrangement when undefined); resolves to true on success. */
  readonly onCopyLink: (view: SavedView | undefined) => Promise<boolean>;
}

export function ViewsTab({
  drawn,
  active,
  views,
  onSave,
  onApply,
  onDelete,
  onCopyLink,
}: ViewsTabProps) {
  const [name, setName] = useState('');
  const [note, setNote] = useState<string>();
  // Adjusted while rendering (not in an effect), so the tab never comes back with a stale note.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setNote(undefined);
  }

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
  if (!drawn) return <p className="cp-empty">Nothing is drawn yet.</p>;
  return (
    <section className="views" id="views">
      <h3 className="cp-section-title">Save the current view</h3>
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
        A view keeps the collapsed groups, hidden edge kinds, level of detail, focus (and Filter,
        when the map was reduced to the focus), colouring, story mode and where the view is. Saved
        views stay in this browser; a link carries the view itself.
      </small>
    </section>
  );
}
