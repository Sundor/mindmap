// The parts of the viewer that are not components of their own but JSX of `Viewer` in App.tsx —
// the `.app` element with the attributes the stylesheet reads, the head and the rail actions of
// the control panel, the start screen, the status lines, the notices, the drop overlay and the
// page the error boundary shows. Each mirrors the JSX it names, with the same ids and classes, so
// that the design pages show them as the app does.

import type { ReactNode } from 'react';
import { TEMPLATE_NOTE, type RecentMap } from '../core';
import { PanelIcon } from '../ui/PanelIcons';
import { RecentList } from '../ui/RecentList';

const noop = (): undefined => undefined;

export type AppData = Readonly<Record<string, string | number | boolean | undefined>>;

/** `div.app` of `Viewer`, with the `data-*` the stylesheet and the browser test read. */
export function AppFrame({
  data,
  children,
}: {
  readonly data: AppData;
  readonly children: ReactNode;
}) {
  const attributes: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(data)) attributes[`data-${key}`] = value;
  return (
    <div className="app" {...attributes}>
      {children}
    </div>
  );
}

/** The `head` of `ControlPanel`: the title, the version and the names of the files in use. */
export function PanelHead({
  version,
  structureName,
  workItemsName,
}: {
  readonly version: string;
  readonly structureName?: string | undefined;
  readonly workItemsName?: string | undefined;
}) {
  return (
    <>
      <h1>Architecture Map</h1>
      <span id="app-version" className="app-version" title={`Architecture Map, version ${version}`}>
        {version}
      </span>
      {(structureName !== undefined || workItemsName !== undefined) && (
        <div className="cp-files">
          {structureName !== undefined && (
            <span
              id="source-name"
              className="source-name"
              data-origin="file"
              title={`Structure from ${structureName}`}
            >
              {structureName}
            </span>
          )}
          {workItemsName !== undefined && (
            <span
              id="workitems-source"
              className="source-name"
              data-origin="file"
              title={`Work items from ${workItemsName}`}
            >
              {workItemsName}
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** The `actions` of `ControlPanel`: Reload (once files were given) and Fit view. */
export function RailActions({
  reload,
  fitDisabled = false,
}: {
  readonly reload?: string | undefined;
  readonly fitDisabled?: boolean | undefined;
}) {
  return (
    <>
      {reload !== undefined && (
        <button
          type="button"
          id="reload-files"
          className="cp-rail-button"
          title={`Read ${reload} again from the disk`}
        >
          <PanelIcon name="reload" />
          <span className="cp-tab-label">Reload</span>
        </button>
      )}
      <button
        type="button"
        id="fit-view"
        className="cp-rail-button"
        disabled={fitDisabled}
        title="Fit the whole map into the view"
      >
        <PanelIcon name="fit" />
        <span className="cp-tab-label">Fit view</span>
      </button>
    </>
  );
}

/** `#empty-state`: what the page shows before a structure is loaded. */
export function StartScreen({
  reason,
  recents = [],
}: {
  readonly reason: string;
  readonly recents?: readonly RecentMap<unknown>[] | undefined;
}) {
  return (
    <div id="empty-state" className="empty-state">
      <h2>No architecture loaded</h2>
      <p id="load-status">{reason}</p>
      {recents.length > 0 && (
        <div className="recent-start">
          <h3>Open again</h3>
          <RecentList id="recent-start" recents={recents} onOpen={noop} onForget={noop} />
        </div>
      )}
      <p>
        <button type="button" className="primary">
          Open YAML…
        </button>
      </p>
      <p className="hint">
        or drop an architecture.yaml file — with its workitems.json — anywhere on this page.
      </p>
      <p className="hint" id="template-hint">
        {TEMPLATE_NOTE}
      </p>
    </div>
  );
}

/** One of the status lines of `main.app-main`. */
export function StatusLine({
  id,
  text,
  pending = false,
  error = false,
}: {
  readonly id: 'load-status' | 'layout-status';
  readonly text: string;
  readonly pending?: boolean | undefined;
  readonly error?: boolean | undefined;
}) {
  if (error) {
    return (
      <p id={id} className="status notice-error" role="alert">
        {text}
      </p>
    );
  }
  if (pending) {
    return (
      <p id={id} className="status layout-pending" role="status">
        {text}
      </p>
    );
  }
  return (
    <p id={id} className="status">
      {text}
    </p>
  );
}

/** `#file-error`: a file that could not be read. */
export function FileError({ text }: { readonly text: string }) {
  return (
    <p id="file-error" className="notice notice-error" role="alert">
      {text}
    </p>
  );
}

/** `#view-note`: a view applied without its colouring. */
export function ViewNote({ text }: { readonly text: string }) {
  return (
    <p id="view-note" className="notice" role="status">
      {text}
    </p>
  );
}

/** The two hidden file inputs of the app. */
export function HiddenInputs() {
  return (
    <>
      <input id="yaml-file" type="file" accept=".yaml,.yml" hidden readOnly />
      <input id="workitems-file" type="file" accept=".json" hidden readOnly />
    </>
  );
}

/** `#drop-overlay`: shown while a file is dragged over the page. */
export function DropOverlay() {
  return (
    <div id="drop-overlay" className="drop-overlay">
      Drop a YAML file (structure) or a JSON file (work items) to load it
    </div>
  );
}

/** What `ErrorBoundary` shows when the viewer stopped. */
export function ViewerStopped({ message }: { readonly message: string }) {
  return (
    <div id="viewer-error" className="empty-state" role="alert">
      <h2>The viewer stopped</h2>
      <p>Something went wrong while drawing the map: {message}</p>
      <p>
        <button type="button" className="primary">
          Reload
        </button>
      </p>
      <p className="hint">
        If it happens again with the same data, the data file is the likely cause.
      </p>
    </div>
  );
}
