// The Detail tab of the control panel: the level of detail drawn (following the zoom, or
// pinned), opening and closing the groups, how much of the work items the boxes show, and the
// zoom thresholds of the automatic level. The values are kept in the browser (see
// `DisplaySettings` in src/core/displaySettings.ts).

import { useStore, type ReactFlowState } from '@xyflow/react';
import {
  DEFAULT_DISPLAY_SETTINGS,
  LOD_MODES,
  LOD_THRESHOLD_KEYS,
  LOD_THRESHOLD_RANGE,
  STORY_MODE_LABELS,
  STORY_MODES,
  withLodThreshold,
  type DisplaySettings,
  type LodConfig,
  type LodLevel,
  type LodMode,
  type LodThresholdKey,
  type StoryMode,
} from '../core';

const LOD_LABELS: Readonly<Record<LodMode, string>> = {
  auto: 'Auto',
  domains: 'Domains',
  components: 'Components',
  subcomponents: 'Subcomponents',
  detail: 'Everything',
};

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

/** Tooltips of the level-of-detail buttons: what each mode shows. */
function lodHint(mode: LodMode, config: LodConfig): string {
  switch (mode) {
    case 'auto':
      return `Follow the zoom: domains below ${percent(config.componentsZoom)}, components up to ${percent(config.subcomponentsZoom)}, subcomponents up to ${percent(config.detailZoom)}, everything beyond (the thresholds are below).`;
    case 'domains':
      return 'Always show domains only, with the edges merged between domains.';
    case 'components':
      return 'Always show components; subcomponents and edge labels stay hidden.';
    case 'subcomponents':
      return 'Always show subcomponents and edge labels; what is inside the boxes (work items) stays hidden.';
    case 'detail':
      return 'Always show everything, including what is inside the boxes (work items).';
  }
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

export interface DetailTabProps {
  /** A map is drawn: without one only the buttons that are always there are shown, disabled. */
  readonly drawn: boolean;
  readonly lodMode: LodMode;
  /** The level being drawn (in Auto mode: the one the zoom selected). */
  readonly lodLevel: LodLevel;
  /**
   * The level the zoom has reached and the map is drawn at once the view rests (the map closed
   * up, in Auto mode); undefined while the level drawn is the one of the zoom.
   */
  readonly pendingLevel?: LodLevel | undefined;
  readonly lodConfig: LodConfig;
  readonly onChooseLod: (mode: LodMode) => void;
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

export function DetailTab({
  drawn,
  lodMode,
  lodLevel,
  pendingLevel,
  lodConfig,
  onChooseLod,
  collapsedCount,
  canCollapseAll,
  onCollapseAll,
  onExpandAll,
  settings,
  onChange,
  hasWorkItems,
  onChooseStoryMode,
}: DetailTabProps) {
  const { lod, storyMode } = settings;
  const defaults = LOD_THRESHOLD_KEYS.every(
    (key) => lod[key] === DEFAULT_DISPLAY_SETTINGS.lod[key],
  );
  return (
    <>
      {!drawn && <p className="cp-empty">Nothing is drawn yet.</p>}
      {/* The first section has no title of its own: the panel's says it. */}
      {drawn && (
        <span
          id="lod-indicator"
          className="lod-indicator"
          role="group"
          aria-label="Level of detail"
          data-lod={lodLevel}
          data-lod-mode={lodMode}
          data-lod-pending={pendingLevel}
        >
          {LOD_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={`lod-step${mode === lodLevel ? ' lod-step-current' : ''}${
                mode === pendingLevel ? ' lod-step-pending' : ''
              }`}
              data-lod-option={mode}
              aria-pressed={mode === lodMode}
              aria-current={mode === lodLevel ? 'true' : undefined}
              title={
                mode === pendingLevel
                  ? `The zoom has reached this level: it is drawn once the view rests. ${lodHint(mode, lodConfig)}`
                  : lodHint(mode, lodConfig)
              }
              onClick={() => onChooseLod(mode)}
            >
              {LOD_LABELS[mode]}
            </button>
          ))}
          {collapsedCount > 0 && (
            <span
              id="collapsed-note"
              className="lod-collapsed-note"
              title="Groups collapsed by hand stay closed at every level of detail. Expand all opens them."
            >
              {collapsedCount} collapsed by hand
            </span>
          )}
        </span>
      )}
      <h3 className="cp-section-title">Groups</h3>
      <div className="cp-actions">
        <button
          type="button"
          id="collapse-all"
          disabled={!drawn || !canCollapseAll}
          onClick={onCollapseAll}
        >
          Collapse all
        </button>
        <button
          type="button"
          id="expand-all"
          disabled={!drawn || collapsedCount === 0}
          onClick={onExpandAll}
        >
          Expand all
        </button>
      </div>
      {drawn && (
        <label className="settings-row settings-check">
          <input
            type="checkbox"
            id="compact-collapsed"
            checked={settings.compactCollapsed || settings.closeGaps}
            disabled={settings.closeGaps}
            onChange={(event) => onChange({ ...settings, compactCollapsed: event.target.checked })}
          />
          <span>
            Shrink collapsed groups
            {settings.closeGaps ? (
              <small> (on with Layout → Close up the gaps)</small>
            ) : (
              <small> (off: a collapsed group keeps its full box)</small>
            )}
          </span>
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
      {drawn && (
        <>
          <h3 className="cp-section-title">
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
              onClick={() => onChange({ ...settings, lod: DEFAULT_DISPLAY_SETTINGS.lod })}
            >
              Reset thresholds
            </button>
          </div>
        </>
      )}
    </>
  );
}
