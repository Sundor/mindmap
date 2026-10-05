// Files remembered by the browser. A page cannot open
// a file by its path, but Edge and Chrome hand out a reference to a file the user has chosen or
// dropped (File System Access API) which may be kept in IndexedDB and read again later — fresh
// from the disk, after the user has allowed it. Everything that touches that API and IndexedDB
// lives here, behind small interfaces, so it can be tested and `src/core` stays pure.
//
// Only references are stored, never the content of a file.

import {
  MAX_RECENT_MAPS,
  sanitizeRecentMaps,
  withRecentMap,
  type RecentFile,
  type RecentMap,
} from '../core';

/** The parts of a `File` the viewer reads. */
export interface DataFile {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}

export type HandlePermission = 'granted' | 'denied' | 'prompt';

/** The parts of a `FileSystemFileHandle` the viewer uses. */
export interface FileHandleLike<F extends DataFile = DataFile> {
  /** `'file'`; a dropped folder gives `'directory'`. */
  readonly kind?: string;
  readonly name: string;
  getFile(): Promise<F>;
  queryPermission?(descriptor: { mode: 'read' }): Promise<HandlePermission>;
  /** Lets the browser ask the user. Only allowed while a click is being handled. */
  requestPermission?(descriptor: { mode: 'read' }): Promise<HandlePermission>;
  isSameEntry?(other: FileHandleLike<F>): Promise<boolean>;
}

/** True for a reference to a file (not to a folder, and not something else found in storage). */
export function isFileHandle(value: unknown): value is FileHandleLike {
  if (typeof value !== 'object' || value === null) return false;
  const handle = value as { kind?: unknown; name?: unknown; getFile?: unknown };
  return (
    typeof handle.name === 'string' &&
    typeof handle.getFile === 'function' &&
    (handle.kind === undefined || handle.kind === 'file')
  );
}

/** Where the list of recent maps is kept. Neither method rejects. */
export interface RecentStore<F extends DataFile = DataFile> {
  /** The stored list, latest first; empty when there is none or it cannot be read. */
  read(): Promise<RecentMap<FileHandleLike<F>>[]>;
  /** Stores the list; a failure only means that it is not remembered. */
  write(list: readonly RecentMap<FileHandleLike<F>>[]): Promise<void>;
}

const DB_NAME = 'architecture-map';
const DB_STORE = 'recent';
const DB_KEY = 'maps';

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cannot be opened'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

/**
 * How long the page waits for the stored list, in ms. The start page waits for it, and storage
 * that never answers (it happens, for pages opened from disk in some browsers) must not hold
 * the page back: after this time there are simply no recent maps.
 */
export const RECENT_STORE_TIMEOUT_MS = 1500;

/**
 * The store in the browser's IndexedDB (file references cannot be put into `localStorage`).
 * Without IndexedDB — private windows of some browsers, storage switched off — nothing is
 * remembered and nothing fails.
 */
export function indexedDbRecentStore<F extends DataFile = DataFile>(
  factory: IDBFactory | undefined,
  timeoutMs: number = RECENT_STORE_TIMEOUT_MS,
): RecentStore<F> {
  const isHandle = isFileHandle as (value: unknown) => value is FileHandleLike<F>;
  const stored = async (database: IDBFactory): Promise<RecentMap<FileHandleLike<F>>[]> => {
    try {
      const opened = await openDatabase(database);
      try {
        const value = await new Promise<unknown>((resolve, reject) => {
          const request = opened
            .transaction(DB_STORE, 'readonly')
            .objectStore(DB_STORE)
            .get(DB_KEY);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('read failed'));
        });
        return sanitizeRecentMaps(value, isHandle);
      } finally {
        opened.close();
      }
    } catch {
      return [];
    }
  };
  return {
    async read() {
      if (!factory) return [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tooLate = new Promise<RecentMap<FileHandleLike<F>>[]>((resolve) => {
        timer = setTimeout(() => resolve([]), timeoutMs);
      });
      try {
        return await Promise.race([stored(factory), tooLate]);
      } finally {
        clearTimeout(timer);
      }
    },
    async write(list) {
      if (!factory) return;
      try {
        const database = await openDatabase(factory);
        try {
          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(DB_STORE, 'readwrite');
            transaction.objectStore(DB_STORE).put([...list], DB_KEY);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error ?? new Error('write failed'));
            transaction.onabort = () => reject(transaction.error ?? new Error('write aborted'));
          });
        } finally {
          database.close();
        }
      } catch {
        // Not remembered; the map is open all the same.
      }
    },
  };
}

/** The store of the current page. */
export function browserRecentStore(): RecentStore<File> {
  let factory: IDBFactory | undefined;
  try {
    factory = window.indexedDB;
  } catch {
    factory = undefined; // access to storage is blocked
  }
  return indexedDbRecentStore<File>(factory);
}

/** True when both references are to the same file. Where the browser cannot tell, they are not. */
export async function sameFile<F extends DataFile>(
  a: FileHandleLike<F>,
  b: FileHandleLike<F>,
): Promise<boolean> {
  if (a === b) return true;
  try {
    return (await a.isSameEntry?.(b)) ?? false;
  } catch {
    return false;
  }
}

/**
 * The list after a map was opened from the file `structure` — together with `workItems` when
 * both were opened in one go. A structure file that is already in the list keeps its entry (and
 * the work items it was last opened with, unless others come with it); otherwise a new entry is
 * made. Either way the entry is first in the list afterwards.
 */
export async function rememberMap<F extends DataFile>(
  list: readonly RecentMap<FileHandleLike<F>>[],
  opened: {
    readonly structure: RecentFile<FileHandleLike<F>>;
    readonly workItems?: RecentFile<FileHandleLike<F>>;
    readonly hint: string;
  },
  now: number,
  newId: () => string,
  max: number = MAX_RECENT_MAPS,
): Promise<{ list: RecentMap<FileHandleLike<F>>[]; entry: RecentMap<FileHandleLike<F>> }> {
  let known: RecentMap<FileHandleLike<F>> | undefined;
  for (const candidate of list) {
    if (await sameFile(candidate.structure.handle, opened.structure.handle)) {
      known = candidate;
      break;
    }
  }
  const workItems = opened.workItems ?? known?.workItems;
  const entry: RecentMap<FileHandleLike<F>> = {
    id: known?.id ?? newId(),
    structure: opened.structure,
    ...(workItems ? { workItems } : {}),
    hint: opened.hint,
    openedAt: now,
  };
  return { list: withRecentMap(list, entry, max), entry };
}

/** What became of opening a remembered map again. */
export type OpenedRecent<F extends DataFile> =
  | {
      readonly status: 'opened';
      readonly structure: F;
      readonly workItems?: F;
      /** Why the work items the map was last opened with could not be read. */
      readonly workItemsProblem?: string;
    }
  /** The browser has to ask the user first, and only a click may make it ask. */
  | { readonly status: 'ask' }
  | { readonly status: 'failed'; readonly reason: string };

function readProblem(name: string, err: unknown): string {
  const gone =
    typeof err === 'object' && err !== null && 'name' in err && err.name === 'NotFoundError';
  if (gone) return `${name} is no longer where it was (moved, renamed or deleted).`;
  return `Could not read ${name} (${err instanceof Error ? err.message : String(err)}).`;
}

/**
 * Reads the files of a remembered map again, fresh from the disk. `ask` says whether the
 * browser may ask the user for permission — true only while a click is being handled; without
 * it a map that needs asking gives `ask` and nothing happens.
 *
 * Both files are asked for at once: after the first answer the click may no longer count, and
 * the browser shows one question for both where it can.
 */
export async function openRecentMap<F extends DataFile>(
  entry: RecentMap<FileHandleLike<F>>,
  ask: boolean,
): Promise<OpenedRecent<F>> {
  const handles = [entry.structure.handle, ...(entry.workItems ? [entry.workItems.handle] : [])];
  const permission = async (handle: FileHandleLike<F>): Promise<HandlePermission> => {
    // A reference without these methods is readable or not: reading it tells.
    if (!handle.queryPermission) return 'granted';
    const state = await handle.queryPermission({ mode: 'read' });
    if (state !== 'prompt' || !ask || !handle.requestPermission) return state;
    // Refusing to ask (the click is too long ago) leaves it where it was.
    return handle.requestPermission({ mode: 'read' }).catch((): HandlePermission => 'prompt');
  };
  let structureAccess: HandlePermission;
  let workItemsAccess: HandlePermission | undefined;
  try {
    [structureAccess = 'denied', workItemsAccess] = await Promise.all(handles.map(permission));
  } catch (err) {
    return { status: 'failed', reason: readProblem(entry.structure.name, err) };
  }
  if (structureAccess === 'prompt') return { status: 'ask' };
  if (structureAccess === 'denied') {
    return {
      status: 'failed',
      reason: `The browser does not allow this page to read ${entry.structure.name}.`,
    };
  }
  let structure: F;
  try {
    structure = await entry.structure.handle.getFile();
  } catch (err) {
    return { status: 'failed', reason: readProblem(entry.structure.name, err) };
  }
  if (!entry.workItems) return { status: 'opened', structure };
  if (workItemsAccess !== 'granted') {
    return {
      status: 'opened',
      structure,
      workItemsProblem: `${entry.workItems.name} was not read: the browser did not allow it.`,
    };
  }
  try {
    return { status: 'opened', structure, workItems: await entry.workItems.handle.getFile() };
  } catch (err) {
    return {
      status: 'opened',
      structure,
      workItemsProblem: readProblem(entry.workItems.name, err),
    };
  }
}

/** Which files a file dialog offers: a map (structure, with its work items) or work items only. */
export type PickKind = 'map' | 'workitems';

/** The page's own file dialog, where the browser has one (`window.showOpenFilePicker`). */
export interface FilePickerHost<F extends DataFile = DataFile> {
  showOpenFilePicker?: (options: Record<string, unknown>) => Promise<FileHandleLike<F>[]>;
}

const YAML_TYPE = {
  description: 'Structure (YAML)',
  accept: { 'application/yaml': ['.yaml', '.yml'] },
};
const JSON_TYPE = { description: 'Work items (JSON)', accept: { 'application/json': ['.json'] } };
const MAP_TYPE = {
  description: 'Architecture map (YAML, with its work items as JSON)',
  accept: { 'application/yaml': ['.yaml', '.yml'], 'application/json': ['.json'] },
};

/**
 * Options of the dialog. `id` makes the browser open each kind of dialog in the folder that
 * kind was last used in. For a map the structure and its work items may be chosen together.
 */
export function pickerOptions(kind: PickKind): Record<string, unknown> {
  return kind === 'map'
    ? { id: 'architecture-map', multiple: true, types: [MAP_TYPE, YAML_TYPE] }
    : { id: 'architecture-map-work', multiple: false, types: [JSON_TYPE] };
}

/**
 * Lets the user choose files in the browser's dialog and gives references to them. Empty when
 * the user chose nothing. Undefined when the browser has no such dialog, or does not let this
 * page use it (a browser policy can switch it off): the caller then uses a plain file input,
 * which opens the file but leaves nothing to remember.
 */
export async function pickFiles<F extends DataFile>(
  host: FilePickerHost<F>,
  kind: PickKind,
): Promise<FileHandleLike<F>[] | undefined> {
  if (typeof host.showOpenFilePicker !== 'function') return undefined;
  try {
    return (await host.showOpenFilePicker(pickerOptions(kind))).filter(isFileHandle);
  } catch (err) {
    const cancelled =
      typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError';
    return cancelled ? [] : undefined;
  }
}

/** The part of a dropped item that gives a file reference (Edge, Chrome). */
export interface DroppedItem<F extends DataFile = DataFile> {
  readonly kind: string;
  getAsFileSystemHandle?: () => Promise<FileHandleLike<F> | null>;
}

/**
 * References to the dropped files. Has to be called while the drop is being handled: afterwards
 * the items are empty. Resolves to undefined when the browser gives no references, or not for
 * every file — the caller then reads the dropped files as they are, without remembering them.
 * Folders are left out.
 */
export function droppedHandles<F extends DataFile>(
  items: readonly DroppedItem<F>[],
): Promise<FileHandleLike<F>[] | undefined> {
  const files = items.filter((item) => item.kind === 'file');
  if (
    files.length === 0 ||
    files.some((item) => typeof item.getAsFileSystemHandle !== 'function')
  ) {
    return Promise.resolve(undefined);
  }
  let asked: Promise<FileHandleLike<F> | null>[];
  try {
    asked = files.map((item) => item.getAsFileSystemHandle?.() ?? Promise.resolve(null));
  } catch {
    return Promise.resolve(undefined);
  }
  return Promise.all(asked).then(
    (handles) => {
      if (handles.some((handle) => handle === null)) return undefined;
      const usable = handles.filter(isFileHandle) as FileHandleLike<F>[];
      return usable.length > 0 ? usable : undefined;
    },
    () => undefined,
  );
}
