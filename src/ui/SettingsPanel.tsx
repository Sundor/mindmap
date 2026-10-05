// Display settings: the zoom thresholds of the automatic level of detail, how collapsed groups
// are drawn, and which work items the map shows (filter by state and by iteration).
// A drop-down in the toolbar; the values are kept in the browser (see `DisplaySettings` in
// src/core/displaySettings.ts).

import { useStore, type ReactFlowState } from '@xyflow/react';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_DISPLAY_SETTINGS,
  dropdownOffset,
  isHiddenState,
  LOD_THRESHOLD_KEYS,
  LOD_THRESHOLD_RANGE,
  toggleHiddenState,
  withIteration,
  withLodThreshold,
  type ColorByOption,
  type DisplaySettings,
  type LodThresholdKey,
} from '../core';

const THRESHOLD_LABELS: Readonly<Record<LodThresholdKey, string>> = {
  componentsZoom: 'Components from',
  subcomponentsZoom: 'Subcomponents from',
  detailZoom: 'Everything from',
};

function percent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

const selectZoomPercent = (state: ReactFlowState): number => Math.round(state.transform[2] * 100);

/** The current zoom, so a threshold can be set against what is on screen. */
function ZoomReadout() {
  const zoom = useStore(selectZoomPercent);
  return (
    <span id="zoom-readout" className="settings-zoom">
      zoom now {zoom}%
    </span>
  );
}

/** What the work-item filter can choose from, and what it leaves. */
export interface WorkItemFilterChoices {
  /** The states found in the loaded work items, in workflow order. */
  readonly states: readonly string[];
  /** The iterations found, sorted. */
  readonly iterations: readonly string[];
  /** How many items pass the filter, of how many. */
  readonly shown: number;
  readonly total: number;
}

export interface SettingsPanelProps {
  readonly settings: DisplaySettings;
  readonly onChange: (settings: DisplaySettings) => void;
  /** Absent while no work items are loaded: the filter is then not offered. */
  readonly workItems?: WorkItemFilterChoices | undefined;
  /** What the structure offers to colour by; empty when it has no attributes and no metrics. */
  readonly colorChoices?: readonly ColorByOption[] | undefined;
}

export function SettingsPanel({
  settings,
  onChange,
  workItems,
  colorChoices = [],
}: SettingsPanelProps) {
  const { lod } = settings;
  // An iteration stored for another file is not applied (`usableWorkItemFilter`), so not shown.
  const iteration =
    settings.iteration !== undefined && workItems?.iterations.includes(settings.iteration)
      ? settings.iteration
      : '';
  const defaults = LOD_THRESHOLD_KEYS.every(
    (key) => lod[key] === DEFAULT_DISPLAY_SETTINGS.lod[key],
  );
  // The drop-down is kept inside the window wherever the button sits in the (wrapping) toolbar.
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
      className="settings"
      id="settings"
      ref={details}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title="Display settings: level-of-detail thresholds, collapsed groups, work-item filter">
        Settings
      </summary>
      <div className="settings-body" ref={body}>
        <div className="settings-heading">
          <span>Auto detail thresholds</span>
          <ZoomReadout />
        </div>
        {LOD_THRESHOLD_KEYS.map((key) => (
          <label key={key} className="settings-row">
            <span className="settings-label">{THRESHOLD_LABELS[key]}</span>
            <input
              type="range"
              data-threshold={key}
              min={LOD_THRESHOLD_RANGE.min}
              max={LOD_THRESHOLD_RANGE.max}
              step={LOD_THRESHOLD_RANGE.step}
              value={lod[key]}
              onChange={(event) =>
                onChange({
                  ...settings,
                  lod: withLodThreshold(lod, key, Number(event.target.value)),
                })
              }
            />
            <output className="settings-value">{percent(lod[key])}</output>
          </label>
        ))}
        <button
          type="button"
          id="reset-thresholds"
          disabled={defaults}
          onClick={() => onChange({ ...settings, lod: DEFAULT_DISPLAY_SETTINGS.lod })}
        >
          Reset thresholds
        </button>
        <label className="settings-row settings-check">
          <input
            type="checkbox"
            id="compact-collapsed"
            checked={settings.compactCollapsed}
            onChange={(event) => onChange({ ...settings, compactCollapsed: event.target.checked })}
          />
          <span>
            Shrink collapsed groups
            <small> (off: a collapsed group keeps its full box)</small>
          </span>
        </label>
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
        <div className="settings-group" id="lenses" role="group" aria-label="Lenses">
          <div className="settings-heading">
            <span>Lenses</span>
          </div>
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
          {workItems && workItems.total > 0 && (
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
          {workItems && workItems.total > 0 && (
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
          <label className="settings-row settings-check">
            <input
              type="checkbox"
              id="edges-on-demand"
              checked={settings.edgesOnDemand}
              onChange={(event) => onChange({ ...settings, edgesOnDemand: event.target.checked })}
            />
            <span>
              Edges on demand
              <small> (zoomed out, edges show only at the box under the pointer or selected)</small>
            </span>
          </label>
        </div>
        {workItems && workItems.total > 0 && (
          <div
            className="settings-group"
            id="workitem-filter"
            role="group"
            aria-label="Work items shown"
          >
            <div className="settings-heading">
              <span>Work items shown</span>
              <span id="workitem-filter-count" className="settings-zoom">
                {workItems.shown} of {workItems.total}
              </span>
            </div>
            <label className="settings-row settings-completed">
              <input
                type="checkbox"
                id="show-completed"
                checked={settings.showCompleted}
                onChange={(event) => onChange({ ...settings, showCompleted: event.target.checked })}
              />
              <span>
                Show completed work items
                <small> (Closed, Done, Resolved, Removed)</small>
              </span>
            </label>
            <div className="settings-states">
              {workItems.states.map((state) => (
                <label key={state} className="settings-state">
                  <input
                    type="checkbox"
                    data-workitem-state={state}
                    checked={!isHiddenState(settings.hiddenStates, state)}
                    onChange={() =>
                      onChange({
                        ...settings,
                        hiddenStates: toggleHiddenState(settings.hiddenStates, state),
                      })
                    }
                  />
                  {state}
                </label>
              ))}
            </div>
            <label className="settings-row">
              <span
                className="settings-label"
                title="A path above a sprint (a programme increment, a release) covers everything under it"
              >
                Iteration
              </span>
              <select
                id="workitem-iteration"
                value={iteration}
                onChange={(event) => onChange(withIteration(settings, event.target.value))}
              >
                <option value="">All iterations</option>
                {workItems.iterations.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <small className="settings-note">
              Hidden items leave the lists, badges and counts; the map is laid out again.
            </small>
          </div>
        )}
      </div>
    </details>
  );
}
