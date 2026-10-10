// The Files tab of the control panel: what is loaded — the structure and the work items, each
// with the button to open another file — and the maps opened from disk before.

import {
  NODE_LEVEL_NAMES,
  plural,
  TEMPLATE_NOTE,
  type ArchitectureModel,
  type RecentMap,
  type TagCoverage,
} from '../core';
import type { PickKind } from '../providers/recentFiles';
import type { WorkItemOrigin } from '../providers/workItemSource';
import { RecentList } from './RecentList';

/** The work-items file in use and what it holds. */
export interface LoadedWorkItems {
  readonly origin: WorkItemOrigin;
  readonly name: string;
  /** Number of work items in the file. */
  readonly count: number;
  /** Of the items the filter shows, how many are tagged; absent without a structure. */
  readonly coverage: TagCoverage | undefined;
}

export interface FilesTabProps {
  readonly model?: ArchitectureModel | undefined;
  /** Absent while no work-items file is loaded. */
  readonly workItems?: LoadedWorkItems | undefined;
  /** An Open button was pressed: a map (structure, with its work items), or work items alone. */
  readonly onOpen: (kind: PickKind) => void;
  readonly recents: readonly RecentMap<unknown>[];
  /** ID of the recent map that is shown now. */
  readonly currentRecent: string | undefined;
  readonly onOpenRecent: (id: string) => void;
  readonly onForgetRecent: (id: string) => void;
}

function ModelSummary({ model }: { model: ArchitectureModel }) {
  const counts = [0, 0, 0];
  for (const node of model.nodes.values()) counts[node.level] = (counts[node.level] ?? 0) + 1;
  const parts = NODE_LEVEL_NAMES.map((name, level) => plural(counts[level] ?? 0, name));
  parts.push(plural(model.edges.length, 'edge'));
  if (model.rows.length > 0) parts.push(plural(model.rows.length, 'row'));
  return (
    <span
      id="model-summary"
      className="model-summary"
      data-nodes={model.nodes.size}
      data-edges={model.edges.length}
      data-rows={model.rows.length}
    >
      {parts.join(' · ')}
    </span>
  );
}

export function FilesTab({
  model,
  workItems,
  onOpen,
  recents,
  currentRecent,
  onOpenRecent,
  onForgetRecent,
}: FilesTabProps) {
  const coverage = workItems?.coverage;
  return (
    <>
      <h3 className="cp-section-title">Structure</h3>
      {model && <ModelSummary model={model} />}
      <div className="cp-actions">
        <button
          type="button"
          id="open-yaml"
          title="Open a structure file (architecture.yaml) — together with its work items (workitems.json) if you choose both; files can also be dropped on the page"
          onClick={() => onOpen('map')}
        >
          Open YAML…
        </button>
      </div>
      <small className="settings-note" id="template-note">
        {TEMPLATE_NOTE}
      </small>
      <h3 className="cp-section-title">Work items</h3>
      {workItems && (
        <span
          id="workitems-summary"
          className="model-summary"
          data-origin={workItems.origin}
          data-items={workItems.count}
          data-coverage={coverage?.percent}
          data-covered={coverage?.total}
          title={`Work items from ${workItems.name}`}
        >
          {plural(workItems.count, 'work item')}
          {coverage && coverage.hidden > 0 ? ` (${coverage.total} shown)` : ''}
          {coverage && coverage.total > 0 ? ` · ${coverage.percent}% tagged` : ''}
        </span>
      )}
      <div className="cp-actions">
        <button
          type="button"
          id="open-workitems"
          title="Load a work-items file (workitems.json); a .json file can also be dropped on the page"
          onClick={() => onOpen('workitems')}
        >
          Open work items…
        </button>
      </div>
      {recents.length > 0 && (
        <section className="recent" id="recent">
          <h3 className="cp-section-title">Recent maps</h3>
          <RecentList
            id="recent-list"
            recents={recents}
            current={currentRecent}
            onOpen={onOpenRecent}
            onForget={onForgetRecent}
          />
          <small className="settings-note">
            The files are read again from the disk; the browser may ask for your permission first.
            Only the reference to a file is kept in this browser, not its content.
          </small>
        </section>
      )}
    </>
  );
}
