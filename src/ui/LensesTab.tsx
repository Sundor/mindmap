// The Lenses tab of the control panel: what the boxes show besides themselves — a colour by an
// attribute or a metric of the structure, the heat of the open work, the progress of the work.
// The values are kept in the browser (see `DisplaySettings` in src/core/displaySettings.ts).

import type { ColorByOption, DisplaySettings } from '../core';

export interface LensesTabProps {
  /** A map is drawn: without one there is nothing to lay a lens over. */
  readonly drawn: boolean;
  readonly settings: DisplaySettings;
  readonly onChange: (settings: DisplaySettings) => void;
  /** What the structure offers to colour by; empty when it has no attributes and no metrics. */
  readonly colorChoices: readonly ColorByOption[];
  /** Work items are loaded: heat and progress are offered. */
  readonly hasWorkItems: boolean;
}

export function LensesTab({
  drawn,
  settings,
  onChange,
  colorChoices,
  hasWorkItems,
}: LensesTabProps) {
  if (!drawn) return <p className="cp-empty">Nothing is drawn yet.</p>;
  return (
    <div className="settings-group" id="lenses" role="group" aria-label="Lenses">
      {colorChoices.length === 0 && !hasWorkItems && (
        <p className="cp-empty">This map offers nothing to colour by and has no work items.</p>
      )}
      {colorChoices.length > 0 && (
        <label className="settings-row">
          <span className="settings-label">Colour by</span>
          <select
            id="color-by"
            value={
              colorChoices.some((c) => c.value === settings.colorBy) ? settings.colorBy : 'none'
            }
            onChange={(event) => onChange({ ...settings, colorBy: event.target.value })}
          >
            <option value="none">Nothing</option>
            {colorChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {hasWorkItems && (
        <label className="settings-row settings-check">
          <input
            type="checkbox"
            id="heat"
            checked={settings.heat}
            onChange={(event) => onChange({ ...settings, heat: event.target.checked })}
          />
          <span>
            Heat by work
            <small> (the sides of a box glow with the open work left in it)</small>
          </span>
        </label>
      )}
      {hasWorkItems && (
        <label className="settings-row settings-check">
          <input
            type="checkbox"
            id="progress"
            checked={settings.progress}
            onChange={(event) => onChange({ ...settings, progress: event.target.checked })}
          />
          <span>
            Progress bars
            <small> (bottom edge: completed items over all, in the chosen iteration)</small>
          </span>
        </label>
      )}
    </div>
  );
}
