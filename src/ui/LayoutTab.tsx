// The Layout tab of the control panel: whether the map is arranged in rows, whether the boxes
// close up around closed groups, and the positions and sizes set by hand — unlocking the boxes to
// drag them and to resize open groups, and putting them back.

import { handCountText, type DisplaySettings } from '../core';

export interface LayoutTabProps {
  /** A map is drawn: without one only the buttons that are always there are shown, disabled. */
  readonly drawn: boolean;
  readonly settings: DisplaySettings;
  readonly onChange: (settings: DisplaySettings) => void;
  readonly positionsUnlocked: boolean;
  readonly onToggleUnlocked: () => void;
  /** Nodes moved by hand in the arrangement on screen. */
  readonly movedCount: number;
  /** Groups resized by hand in the arrangement on screen. */
  readonly resizedCount: number;
  readonly onResetPositions: () => void;
}

export function LayoutTab({
  drawn,
  settings,
  onChange,
  positionsUnlocked,
  onToggleUnlocked,
  movedCount,
  resizedCount,
  onResetPositions,
}: LayoutTabProps) {
  const handCount = handCountText(movedCount, resizedCount);
  return (
    <>
      {!drawn && <p className="cp-empty">Nothing is drawn yet.</p>}
      {drawn && (
        <>
          <h3 className="cp-section-title">Rows</h3>
          <label className="settings-row settings-check">
            <input
              type="checkbox"
              id="show-rows"
              checked={settings.showRows}
              onChange={(event) => onChange({ ...settings, showRows: event.target.checked })}
            />
            <span>
              Arrange in rows
              <small> (off: no row bands; nodes are arranged by their connections)</small>
            </span>
          </label>
          <h3 className="cp-section-title">Closed groups</h3>
          <label className="settings-row settings-check">
            <input
              type="checkbox"
              id="close-gaps"
              checked={settings.closeGaps}
              onChange={(event) => onChange({ ...settings, closeGaps: event.target.checked })}
            />
            <span>
              Close up the gaps
              <small>
                {' '}
                (closed groups are drawn shrunk and the boxes move together, whenever groups close
                or open — by hand or by the level of detail)
              </small>
            </span>
          </label>
        </>
      )}
      <h3 className="cp-section-title">Positions</h3>
      <div className="cp-actions">
        <button
          type="button"
          id="unlock-positions"
          disabled={!drawn}
          aria-pressed={positionsUnlocked}
          title={
            positionsUnlocked
              ? 'Positions are unlocked: drag a box to move it — an open group by its title bar — and drag an edge or a corner of an open group to resize it. Click to lock.'
              : 'Positions are locked. Click to unlock, then move boxes and resize open groups by hand.'
          }
          onClick={onToggleUnlocked}
        >
          {positionsUnlocked ? 'Lock positions' : 'Unlock positions'}
        </button>
        <button
          type="button"
          id="reset-positions"
          disabled={!drawn || movedCount + resizedCount === 0}
          title="Put every box moved or resized by hand back as the layout made it"
          onClick={onResetPositions}
        >
          Reset positions
        </button>
      </div>
      {handCount !== undefined && (
        <small className="settings-note" id="hand-count">
          {handCount}
        </small>
      )}
      <small className="settings-note">
        Positions and sizes set by hand belong to one arrangement: each layout, and each closed-up
        arrangement of it, has its own.
      </small>
      {positionsUnlocked && (
        <small className="settings-note" id="resize-hint">
          An open group is moved by its title bar and resized at its edges and corners. Double-click
          an edge to give the group back the size the layout made.
        </small>
      )}
    </>
  );
}
