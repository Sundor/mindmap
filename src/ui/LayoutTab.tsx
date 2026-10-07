// The Layout tab of the control panel: whether the map is arranged in rows, and the positions
// set by hand — unlocking the boxes to drag them, and putting them back.

import type { DisplaySettings } from '../core';

export interface LayoutTabProps {
  /** A map is drawn: without one only the buttons that are always there are shown, disabled. */
  readonly drawn: boolean;
  readonly settings: DisplaySettings;
  readonly onChange: (settings: DisplaySettings) => void;
  readonly positionsUnlocked: boolean;
  readonly onToggleUnlocked: () => void;
  /** Nodes moved by hand in the arrangement on screen. */
  readonly movedCount: number;
  readonly onResetPositions: () => void;
}

export function LayoutTab({
  drawn,
  settings,
  onChange,
  positionsUnlocked,
  onToggleUnlocked,
  movedCount,
  onResetPositions,
}: LayoutTabProps) {
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
              ? 'Positions are unlocked: drag groups and nodes to move them. Click to lock.'
              : 'Positions are locked. Click to unlock and move groups and nodes by hand.'
          }
          onClick={onToggleUnlocked}
        >
          {positionsUnlocked ? 'Lock positions' : 'Unlock positions'}
        </button>
        <button
          type="button"
          id="reset-positions"
          disabled={!drawn || movedCount === 0}
          title="Put every node moved by hand back where the layout placed it"
          onClick={onResetPositions}
        >
          Reset positions
        </button>
      </div>
      <small className="settings-note">
        Moved positions belong to one arrangement: each layout has its own.
      </small>
    </>
  );
}
