// Where the structure YAML comes from. All `window`/`fetch` access
// for loading lives here (and is injectable), so `src/core` stays pure.
//
// The viewer reads data files only — YAML and JSON, which are shown and never run. Served by a
// web server it fetches them from that server; opened from disk (`file://`) the browser lets it
// read only files the user opens or drops, or has opened before (`recentFiles.ts`).

/** File fetched next to the page when no `?data=` is given. */
export const DEFAULT_YAML_URL = 'architecture.yaml';
/** Query parameter naming the YAML to fetch: `viewer.html?data=<path>`. */
export const DATA_PARAM = 'data';

export type StructureOrigin = 'url' | 'file';

export interface StructureSource {
  readonly origin: StructureOrigin;
  /** YAML text. */
  readonly text: string;
  /** Name shown in the toolbar: the path, or the file name. */
  readonly name: string;
  /** Name used in diagnostics. */
  readonly diagnosticsName: string;
}

/** The parts of a `fetch` response the loader uses. */
export interface LoaderResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Everything the loader reads from the environment (injectable for tests). */
export interface LoaderEnv {
  /** `window.location.href`: the address the page was opened with. */
  readonly pageUrl: string;
  /** Fetches an absolute address that {@link dataFileAddress} has allowed. */
  fetch(url: string): Promise<LoaderResponse>;
}

/**
 * A source, or why there is none. `local` marks the ordinary case of a page opened from disk,
 * which cannot read files by itself: nothing went wrong, a file has to be opened.
 */
export type InitialLoad =
  | { readonly source: StructureSource }
  | { readonly source?: undefined; readonly reason: string; readonly local?: boolean };

/** Value of `?data=` in a query string; undefined when absent or empty. */
export function requestedDataUrl(search: string): string | undefined {
  const value = new URLSearchParams(search).get(DATA_PARAM);
  return value === null || value.trim() === '' ? undefined : value.trim();
}

/** The query string (`?a=b`) of the page address; empty when the address cannot be read. */
export function pageSearch(pageUrl: string): string {
  try {
    return new URL(pageUrl).search;
  } catch {
    return '';
  }
}

/**
 * Where a data file may be fetched from, or why it is not fetched:
 * - `local`: the page was opened from `file://`, where browsers cannot fetch the files next to it;
 * - `elsewhere`: the name leads away from the place the page was opened from.
 */
export type DataFileAddress =
  | { readonly url: string; readonly refused?: undefined }
  | { readonly url?: undefined; readonly refused: 'local' | 'elsewhere' };

/**
 * The address to fetch for the data file `name` — a default file name, or the value of `?data=`
 * / `?workitems=`.
 *
 * The viewer only ever reads from the server it was opened from. The
 * name comes from the link the page was opened with, which anyone can write, so it must not be
 * able to make the page contact another server, or show a map that comes from one. The name is
 * resolved the way the browser would resolve it and the result compared with the page's own
 * scheme, host and port — which also covers what only looks relative (`//host/x`, `/\host/x`)
 * and content carried in the link itself (`data:`, `blob:`, `javascript:`).
 */
export function dataFileAddress(name: string, pageUrl: string): DataFileAddress {
  let page: URL;
  let target: URL;
  try {
    page = new URL(pageUrl);
    target = new URL(name, page);
  } catch {
    return { refused: 'elsewhere' };
  }
  const served = page.protocol === 'http:' || page.protocol === 'https:';
  if (served && target.protocol === page.protocol && target.host === page.host) {
    // `fetch` refuses an address with a user name in it, and the fragment is not part of a file.
    target.username = '';
    target.password = '';
    target.hash = '';
    return { url: target.href };
  }
  if (page.protocol === 'file:' && target.protocol === 'file:') return { refused: 'local' };
  return { refused: 'elsewhere' };
}

/** What the page says about a data file whose name leads to another place than its own. */
export function elsewhereReason(name: string): string {
  return (
    `Could not load ${name}: the viewer reads data files only from the place it was opened ` +
    `from, never from another server. Save the file and open it here instead.`
  );
}

/** What the page says when it was opened from disk and so cannot read `name` by itself. */
export function localReason(name: string): string {
  return (
    `A page opened from disk cannot read ${name} by itself: open the file with the button, ` +
    `or drop it on the page.`
  );
}

/**
 * The first loader step: `fetch` of `?data=<path>` or `architecture.yaml` next to
 * the page. Never rejects: when nothing could be loaded the result carries the reason, and the
 * UI goes on to the remembered files, the file picker and drag-and-drop.
 *
 * Nothing is fetched on `file://` (browsers block it), and nothing from another server than the
 * page's own (see {@link dataFileAddress}).
 */
export async function loadInitialStructure(env: LoaderEnv): Promise<InitialLoad> {
  const name = requestedDataUrl(pageSearch(env.pageUrl)) ?? DEFAULT_YAML_URL;
  const address = dataFileAddress(name, env.pageUrl);
  if (address.url === undefined) {
    if (address.refused === 'elsewhere') return { reason: elsewhereReason(name) };
    return { reason: localReason(name), local: true };
  }
  try {
    const response = await env.fetch(address.url);
    if (!response.ok) return { reason: `Could not load ${name} (HTTP ${response.status}).` };
    // Dev servers answer unknown paths with the app's HTML page; that is not a structure file.
    if (/^text\/html\b/i.test(response.headers.get('content-type') ?? '')) {
      return { reason: `Could not load ${name} (the server returned an HTML page).` };
    }
    const text = await response.text();
    return { source: { origin: 'url', text, name, diagnosticsName: name } };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { reason: `Could not load ${name} (${detail}).` };
  }
}

/**
 * Options of every `fetch` of a data file: never from a cache, no address of the page sent
 * along, and cookies only to the page's own server (which is the only one asked).
 */
export const DATA_FETCH_OPTIONS = {
  cache: 'no-store',
  credentials: 'same-origin',
  referrerPolicy: 'no-referrer',
} as const satisfies RequestInit;

/** The loader environment of the current page. */
export function browserLoaderEnv(): LoaderEnv {
  return {
    pageUrl: window.location.href,
    fetch: (url) => fetch(url, DATA_FETCH_OPTIONS),
  };
}

/** A file chosen in the picker, dropped on the page, or opened again from the recent maps. */
export async function readStructureFile(file: {
  readonly name: string;
  text(): Promise<string>;
}): Promise<StructureSource> {
  const text = await file.text();
  return { origin: 'file', text, name: file.name, diagnosticsName: file.name };
}
