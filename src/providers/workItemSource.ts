// Where the work-items data comes from: the mock "database" is a JSON file
// delivered next to the viewer like the structure file. All `window`/`fetch` access for loading
// it lives here (and is injectable), so `src/core` stays pure.

import {
  parseWorkItems,
  type Diagnostic,
  type WorkItemProvider,
  type WorkItemSummary,
} from '../core';
import {
  DATA_FETCH_OPTIONS,
  dataFileAddress,
  elsewhereReason,
  localReason,
  pageSearch,
  type LoaderResponse,
} from './structureSource';

/** File fetched next to the page when no `?workitems=` is given. */
export const DEFAULT_WORK_ITEMS_URL = 'workitems.json';
/** Query parameter naming the work-items file to fetch: `viewer.html?workitems=<path>`. */
export const WORK_ITEMS_PARAM = 'workitems';
/**
 * How long the page waits for the work-items file, in ms. The map is laid out once the work
 * items are known, so a server that does not answer must not hold it back.
 */
export const WORK_ITEMS_TIMEOUT_MS = 4000;

export type WorkItemOrigin = 'url' | 'file';

export interface WorkItemSource {
  readonly origin: WorkItemOrigin;
  /** JSON text of the work-items file. */
  readonly text: string;
  /** Name shown in the control panel: the path, or the file name. */
  readonly name: string;
  /** Name used in diagnostics. */
  readonly diagnosticsName: string;
}

/** Everything the work-item loader reads from the environment (injectable for tests). */
export interface WorkItemLoaderEnv {
  /** `window.location.href`: the address the page was opened with. */
  readonly pageUrl: string;
  /**
   * Fetches an absolute address that `dataFileAddress` has allowed. Gives up, rejecting, when
   * `signal` aborts.
   */
  fetch(url: string, signal?: AbortSignal): Promise<LoaderResponse>;
  /** Longest wait for the fetched file, in ms; {@link WORK_ITEMS_TIMEOUT_MS} when absent. */
  readonly timeoutMs?: number;
}

/** A source, or the reason there is none (which is not an error: the map then has no work items). */
export type InitialWorkItems =
  | { readonly source: WorkItemSource; readonly reason?: undefined }
  | { readonly source?: undefined; readonly reason: string };

/** Value of `?workitems=` in a query string; undefined when absent or empty. */
export function requestedWorkItemsUrl(search: string): string | undefined {
  const value = new URLSearchParams(search).get(WORK_ITEMS_PARAM);
  return value === null || value.trim() === '' ? undefined : value.trim();
}

/**
 * The work items the page finds by itself, mirroring the structure file: `fetch`
 * of `?workitems=<path>` or `workitems.json` next to the page, else none. Never rejects. Finding nothing is normal — the map simply has no work items — so the reason is for
 * a tooltip, not for an error message. Nothing is fetched on `file://`, and nothing from another
 * server than the page's own (see `dataFileAddress`). A file that has not arrived within the
 * time limit counts as not found, and its request is aborted.
 */
export async function loadInitialWorkItems(env: WorkItemLoaderEnv): Promise<InitialWorkItems> {
  const name = requestedWorkItemsUrl(pageSearch(env.pageUrl)) ?? DEFAULT_WORK_ITEMS_URL;
  const address = dataFileAddress(name, env.pageUrl);
  if (address.url === undefined) {
    return { reason: address.refused === 'elsewhere' ? elsewhereReason(name) : localReason(name) };
  }
  const url = address.url;
  const fetched = async (signal: AbortSignal): Promise<InitialWorkItems> => {
    try {
      const response = await env.fetch(url, signal);
      if (!response.ok) return { reason: `Could not load ${name} (HTTP ${response.status}).` };
      // Dev servers answer unknown paths with the app's HTML page; that is not a data file.
      if (/^text\/html\b/i.test(response.headers.get('content-type') ?? '')) {
        return { reason: `Could not load ${name} (the server returned an HTML page).` };
      }
      const text = await response.text();
      return { source: { origin: 'url', text, name, diagnosticsName: name } };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { reason: `Could not load ${name} (${detail}).` };
    }
  };
  // The headers may come quickly and the body never, so the limit covers both.
  const timeoutMs = env.timeoutMs ?? WORK_ITEMS_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<InitialWorkItems>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ reason: `Could not load ${name} (no answer within ${timeoutMs / 1000} s).` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetched(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The work-item loader environment of the current page. */
export function browserWorkItemEnv(): WorkItemLoaderEnv {
  return {
    pageUrl: window.location.href,
    fetch: (url, signal) => fetch(url, { ...DATA_FETCH_OPTIONS, ...(signal ? { signal } : {}) }),
  };
}

/** A work-items file chosen in the picker or dropped on the page. */
export async function readWorkItemFile(file: {
  readonly name: string;
  text(): Promise<string>;
}): Promise<WorkItemSource> {
  const text = await file.text();
  return { origin: 'file', text, name: file.name, diagnosticsName: file.name };
}

/** True for a file the page treats as work items (`.json`) rather than as a structure file. */
export function isWorkItemFileName(name: string): boolean {
  return /\.json$/i.test(name.trim());
}

/** What one load of the mock data gave. */
export interface WorkItemLoad {
  /** The file the items came from; undefined when there is none (see `reason`). */
  readonly source?: WorkItemSource;
  /** Why there is no source. */
  readonly reason?: string;
  readonly items: WorkItemSummary[];
  /** File and format problems, named after the source (`diagnosticsName`). */
  readonly errors: Diagnostic[];
  readonly warnings: Diagnostic[];
}

export interface MockWorkItemProvider extends WorkItemProvider {
  /** Like `fetch`, with the source and the diagnostics of the file. */
  load(): Promise<WorkItemLoad>;
}

/**
 * The mock provider: reads the work-items data file that `locate` finds
 * (`loadInitialWorkItems`, or a picked file) and parses it. Never rejects: no file gives no
 * items, a broken file gives diagnostics.
 */
export function mockWorkItemProvider(
  locate: () => Promise<InitialWorkItems>,
): MockWorkItemProvider {
  const load = async (): Promise<WorkItemLoad> => {
    let located: InitialWorkItems;
    try {
      located = await locate();
    } catch (err) {
      located = { reason: err instanceof Error ? err.message : String(err) };
    }
    if (!located.source) return { reason: located.reason, items: [], errors: [], warnings: [] };
    const parsed = parseWorkItems(located.source.text, {
      sourceName: located.source.diagnosticsName,
    });
    return { source: located.source, ...parsed };
  };
  return { load, fetch: async () => (await load()).items };
}
