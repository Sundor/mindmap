// The Visibility tab of the control panel: what of the map is shown — the focus on a flow or a
// work item, the edge kinds, and which work items the map shows (filter by state and by
// iteration). The values are kept in the browser (see `DisplaySettings` in
// src/core/displaySettings.ts).

import {
  isHiddenState,
  toggleHiddenState,
  withIteration,
  type ArchitectureModel,
  type DisplaySettings,
  type EdgeKind,
  type Focus,
  type WorkItemSummary,
} from '../core';
import { KindFilters } from './KindFilters';
import { Switch } from './Switch';

/** What the focus can be chosen from, and what it is. */
export interface FocusChooser {
  readonly flows: ArchitectureModel['flows'];
  /** The work items the map shows; the epics and features among them are offered. */
  readonly items: readonly WorkItemSummary[];
  readonly focus: Focus | undefined;
  /** Name of the focus, for one that is not among the choices. */
  readonly focusName: string | undefined;
  readonly onChoose: (focus: Focus | undefined) => void;
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

export interface VisibilityTabProps {
  /** A map is drawn: without one only the focus is offered. */
  readonly drawn: boolean;
  /** Absent while there is nothing to focus on. */
  readonly focusChooser?: FocusChooser | undefined;
  /** The Focus / Filter switch, and what its position means for the map: said under it. */
  readonly filterOn: boolean;
  readonly onFilterChange: (on: boolean) => void;
  readonly filterHint: string;
  readonly hiddenKinds: ReadonlySet<EdgeKind>;
  /** Number of edges of each kind on the map, hidden or not. */
  readonly kindCounts: Readonly<Record<EdgeKind, number>>;
  readonly onToggleKind: (kind: EdgeKind) => void;
  readonly settings: DisplaySettings;
  readonly onChange: (settings: DisplaySettings) => void;
  /** Absent while no work items are loaded: the filter is then not offered. */
  readonly workItems?: WorkItemFilterChoices | undefined;
}

function FocusSelect({ flows, items, focus, focusName, onChoose }: FocusChooser) {
  const offered = (type: WorkItemSummary['type']) => items.filter((item) => item.type === type);
  return (
    <label
      className="cp-select"
      id="focus-control"
      title="Choose a flow, an epic or a feature: what it involves stays, the rest is paled (Focus) or not drawn (Filter)"
    >
      <select
        id="focus-select"
        aria-label="Focus"
        value={focus ? `${focus.type}:${focus.id}` : ''}
        onChange={(event) => {
          const [type, ...rest] = event.target.value.split(':');
          const id = rest.join(':');
          if (type === 'flow') onChoose({ type: 'flow', id });
          else if (type === 'workitem') onChoose({ type: 'workitem', id: Number(id) });
          else onChoose(undefined);
        }}
      >
        <option value="">None</option>
        {(['workflow', 'dataflow'] as const).map((kind) => {
          const ofKind = flows.filter((f) => f.kind === kind);
          return ofKind.length > 0 ? (
            <optgroup key={kind} label={kind === 'dataflow' ? 'Data flows' : 'Workflows'}>
              {ofKind.map((f) => (
                <option key={f.id} value={`flow:${f.id}`}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
        {(['Epic', 'Feature'] as const).map((type) => {
          const ofType = offered(type);
          return ofType.length > 0 ? (
            <optgroup key={type} label={`${type}s`}>
              {ofType.map((item) => (
                <option key={item.id} value={`workitem:${item.id}`}>
                  #{item.id} {item.title}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
        {focus?.type === 'workitem' &&
          !items.some(
            (item) => item.id === focus.id && (item.type === 'Epic' || item.type === 'Feature'),
          ) && <option value={`workitem:${focus.id}`}>{focusName}</option>}
      </select>
    </label>
  );
}

export function VisibilityTab({
  drawn,
  focusChooser,
  filterOn,
  onFilterChange,
  filterHint,
  hiddenKinds,
  kindCounts,
  onToggleKind,
  settings,
  onChange,
  workItems,
}: VisibilityTabProps) {
  // An iteration stored for another file is not applied (`usableWorkItemFilter`), so not shown.
  const iteration =
    settings.iteration !== undefined && workItems?.iterations.includes(settings.iteration)
      ? settings.iteration
      : '';
  return (
    <>
      {!drawn && <p className="cp-empty">Nothing is drawn yet.</p>}
      {focusChooser && (
        <>
          <h3 className="cp-section-title">Focus</h3>
          <FocusSelect {...focusChooser} />
          <Switch
            id="focus-mode"
            checked={filterOn}
            onChange={onFilterChange}
            offLabel="Focus"
            onLabel="Filter"
            label="Filter: draw only what the focus involves"
            describedBy="focus-mode-hint"
          />
          <small id="focus-mode-hint" className="settings-note">
            {filterHint}
          </small>
        </>
      )}
      {drawn && (
        <>
          <h3 className="cp-section-title">Edges</h3>
          <KindFilters hiddenKinds={hiddenKinds} counts={kindCounts} onToggle={onToggleKind} />
          <label className="settings-row settings-check">
            <input
              type="checkbox"
              id="edges-on-demand"
              checked={settings.edgesOnDemand}
              onChange={(event) => onChange({ ...settings, edgesOnDemand: event.target.checked })}
            />
            <span>
              Edges on demand
              <small>
                {' '}
                (edges show only at the box under the pointer or selected, and those of the focus)
              </small>
            </span>
          </label>
        </>
      )}
      {drawn && workItems && workItems.total > 0 && (
        <div
          className="settings-group"
          id="workitem-filter"
          role="group"
          aria-label="Work items shown"
        >
          <h3 className="cp-section-title">
            <span>Work items shown</span>
            <span id="workitem-filter-count" className="settings-zoom">
              {workItems.shown} of {workItems.total}
            </span>
          </h3>
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
    </>
  );
}
