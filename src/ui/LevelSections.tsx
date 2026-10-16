// Sections of the Map tab of the control panel about how much of the map is drawn: the groups
// (opening and closing them, drawing closed ones shrunk), how much of the work items the boxes
// show, and the zoom thresholds of the automatic level of detail. The level itself is chosen
// with the button on the rail (ControlPanel). The values are kept in the browser (see
// `DisplaySettings` in src/core/displaySettings.ts).

import { useStore, type ReactFlowState } from '@xyflow/react';
import {
  DEFAULT_DISPLAY_SETTINGS,
  LOD_THRESHOLD_KEYS,
  LOD_THRESHOLD_RANGE,
  STORY_MODE_LABELS,
  STORY_MODES,
  withLodThreshold,
  type DisplaySettings,
  type LodThresholdKey,
  type StoryMode,
} from '../core';

const STORY_MODE_HINTS: Readonly<Record<StoryMode, string>> = {
  off: 'Show nothing about work items on the map (the detail panel still lists them).',
  stories: 'List the stories, bugs, features and epics of each node; counts when zoomed out.',
  tasks: 'Also list the tasks under each story (first words; the full text is in the panel).',
};

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

export interface GroupsSectionProps {
  /** A map is drawn: without one only the buttons that are always there are shown, disabled. */
  readonly drawn: boolean;
  /** Groups collapsed by hand. */
  readonly collapsedCount: number;
  /** There are groups, and not all of them are collapsed. */
  readonly canCollapseAll: boolean;
  readonly onCollapseAll: () => void;
  readonly onExpandAll: () => void;
  readonly settings: DisplaySettings;
  readonly onChange: (settings: DisplaySettings) => void;
  /** Work items are loaded: the story mode is offered. */
  readonly hasWorkItems: boolean;
  readonly onChooseStoryMode: (mode: StoryMode) => void;
}

/** The groups and the work items on the map: the first sections of the Map tab. */
export function GroupsSection({
  drawn,
  collapsedCount,
  canCollapseAll,
  onCollapseAll,
  onExpandAll,
  settings,
  onChange,
  hasWorkItems,
  onChooseStoryMode,
}: GroupsSectionProps) {
  const { storyMode } = settings;
  return (
    <>
      {!drawn && <p className="cp-empty">Nothing is drawn yet.</p>}
      <h3 className="cp-section-title">
        <span>Groups</span>
        {collapsedCount > 0 && (
          <span
            id="collapsed-note"
            className="settings-zoom"
            title="Groups collapsed by hand stay closed at every level of detail. Expand all opens them."
          >
            {collapsedCount} collapsed by hand
          </span>
        )}
      </h3>
      <div className="cp-actions">
        <button
          type="button"
          id="collapse-all"
          disabled={!drawn || !canCollapseAll}
          title="Close every group: each is drawn as one box"
          onClick={onCollapseAll}
        >
          Collapse all
        </button>
        <button
          type="button"
          id="expand-all"
          disabled={!drawn || collapsedCount === 0}
          title="Open every group collapsed by hand"
          onClick={onExpandAll}
        >
          Expand all
        </button>
      </div>
      {drawn && (
        <label
          className="settings-row settings-check"
          title={
            settings.closeGaps
              ? 'A collapsed group is drawn as a small box in the middle of its full box: always on while the gaps are closed up (Layout).'
              : 'A collapsed group is drawn as a small box in the middle of its full box; off, it keeps its full box.'
          }
        >
          <input
            type="checkbox"
            id="compact-collapsed"
            checked={settings.compactCollapsed || settings.closeGaps}
            disabled={settings.closeGaps}
            onChange={(event) => onChange({ ...settings, compactCollapsed: event.target.checked })}
          />
          <span>Shrink collapsed groups</span>
        </label>
      )}
      {drawn && hasWorkItems && (
        <>
          <h3 className="cp-section-title">Work items on the map</h3>
          <span
            id="story-mode"
            className="lod-indicator"
            role="group"
            aria-label="Work items on the map"
            data-story-mode={storyMode}
          >
            {STORY_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`lod-step${mode === storyMode ? ' lod-step-current' : ''}`}
                data-story-option={mode}
                aria-pressed={mode === storyMode}
                title={STORY_MODE_HINTS[mode]}
                onClick={() => onChooseStoryMode(mode)}
              >
                {STORY_MODE_LABELS[mode]}
              </button>
            ))}
          </span>
        </>
      )}
    </>
  );
}

export interface ThresholdsSectionProps {
  /** A map is drawn: without one the section is not shown. */
  readonly drawn: boolean;
  readonly settings: DisplaySettings;
  readonly onChange: (settings: DisplaySettings) => void;
}

/** The zoom thresholds of the Auto level: the last section of the Map tab. */
export function ThresholdsSection({ drawn, settings, onChange }: ThresholdsSectionProps) {
  const { lod } = settings;
  const defaults = LOD_THRESHOLD_KEYS.every(
    (key) => lod[key] === DEFAULT_DISPLAY_SETTINGS.lod[key],
  );
  if (!drawn) return null;
  return (
    <>
      <h3
        className="cp-section-title"
        title="In Auto, the zoom from which each level of detail is drawn"
      >
        <span>Auto: zoom thresholds</span>
        <ZoomReadout />
      </h3>
      {LOD_THRESHOLD_KEYS.map((key) => (
        <label key={key} className="settings-row settings-row-stacked">
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
      <div className="cp-actions">
        <button
          type="button"
          id="reset-thresholds"
          disabled={defaults}
          title="Put the three thresholds back to their defaults"
          onClick={() => onChange({ ...settings, lod: DEFAULT_DISPLAY_SETTINGS.lod })}
        >
          Reset thresholds
        </button>
      </div>
    </>
  );
}
