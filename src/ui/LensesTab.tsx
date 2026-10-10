// The Lenses tab of the control panel: what the boxes show besides themselves — a colour by the
// labels, presets and metrics of the structure, the heat of the open work, the progress of the
// work. The values are kept in the browser (see `DisplaySettings` in src/core/displaySettings.ts).

import {
  COLOR_BY_GROUP_LABELS,
  COLOR_BY_GROUPS,
  type ColorByOption,
  type DisplaySettings,
} from '../core';

export interface LensesTabProps {
  /** A map is drawn: without one there is nothing to lay a lens over. */
  readonly drawn: boolean;
  readonly settings: DisplaySettings;
  readonly onChange: (settings: DisplaySettings) => void;
  /** What the structure offers to colour by; empty when it has no labels, presets and metrics. */
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
  // A stored choice the structure does not offer shows as "Nothing".
  const chosen = colorChoices.find((choice) => choice.value === settings.colorBy);
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
            value={chosen ? settings.colorBy : 'none'}
            onChange={(event) => onChange({ ...settings, colorBy: event.target.value })}
            aria-describedby={chosen?.description !== undefined ? 'color-by-note' : undefined}
          >
            <option value="none">Nothing</option>
            {COLOR_BY_GROUPS.map((group) => {
              const choices = colorChoices.filter((choice) => choice.group === group);
              return choices.length === 0 ? null : (
                <optgroup key={group} label={COLOR_BY_GROUP_LABELS[group]}>
                  {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
      )}
      {chosen?.description !== undefined && (
        <small className="settings-note" id="color-by-note">
          {chosen.description}
        </small>
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
            <small>
              {' '}
              (the sides of a box glow with the open work left in it; an open group counts only what
              no box inside it shows)
            </small>
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
            <small>
              {' '}
              (bottom edge: completed items over all, in the chosen iteration; an open group counts
              only what no box inside it shows)
            </small>
          </span>
        </label>
      )}
    </div>
  );
}
