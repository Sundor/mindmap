import { describe, expect, it } from 'vitest';
import type { RecentMap } from '../core';
import {
  droppedHandles,
  indexedDbRecentStore,
  isFileHandle,
  openRecentMap,
  pickerOptions,
  pickFiles,
  rememberMap,
  sameFile,
  type DataFile,
  type FileHandleLike,
  type HandlePermission,
} from './recentFiles';

/** A stand-in for a file on the disk and the browser's reference to it. */
interface FakeOptions {
  /** What `queryPermission` answers; undefined for a reference without permissions. */
  readonly permission?: HandlePermission;
  /** What the user answers when asked; a rejection when it is an error. */
  readonly answer?: HandlePermission | Error;
  /** What reading fails with. */
  readonly readError?: unknown;
  readonly kind?: string;
}

interface Fake extends FileHandleLike {
  /** How often the browser was made to ask the user. */
  asked: number;
  readonly path: string;
}

function handle(path: string, options: FakeOptions = {}): Fake {
  const name = path.split('/').pop() ?? path;
  let state = options.permission;
  const fake: Fake = {
    asked: 0,
    path,
    kind: options.kind ?? 'file',
    name,
    getFile: () =>
      options.readError !== undefined
        ? Promise.reject(options.readError)
        : Promise.resolve<DataFile>({
            name,
            size: 10,
            text: () => Promise.resolve(`text of ${path}`),
          }),
    isSameEntry: (other) => Promise.resolve((other as Fake).path === path),
    ...(state === undefined
      ? {}
      : {
          queryPermission: () => Promise.resolve(state ?? 'prompt'),
          requestPermission: () => {
            fake.asked += 1;
            if (options.answer instanceof Error) return Promise.reject(options.answer);
            state = options.answer ?? 'granted';
            return Promise.resolve(state);
          },
        }),
  };
  return fake;
}

function entry(structure: Fake, workItems?: Fake): RecentMap<FileHandleLike> {
  return {
    id: 'map-1',
    structure: { name: structure.name, handle: structure },
    ...(workItems ? { workItems: { name: workItems.name, handle: workItems } } : {}),
    hint: '',
    openedAt: 1,
  };
}

const notFound = Object.assign(new Error('A requested file could not be found.'), {
  name: 'NotFoundError',
});

describe('isFileHandle', () => {
  it('takes a reference to a file, and nothing else', () => {
    expect(isFileHandle(handle('/a.yaml'))).toBe(true);
    expect(isFileHandle({ name: 'a.yaml', getFile: () => undefined })).toBe(true);
    expect(isFileHandle(handle('/folder', { kind: 'directory' }))).toBe(false);
    expect(isFileHandle({ name: 'a.yaml' })).toBe(false);
    expect(isFileHandle({ getFile: () => undefined })).toBe(false);
    expect(isFileHandle(null)).toBe(false);
    expect(isFileHandle('a.yaml')).toBe(false);
  });
});

describe('sameFile', () => {
  it('asks the browser, and says no where it cannot tell', async () => {
    const a = handle('/maps/a.yaml');
    expect(await sameFile(a, a)).toBe(true);
    expect(await sameFile(a, handle('/maps/a.yaml'))).toBe(true);
    expect(await sameFile(a, handle('/other/a.yaml'))).toBe(false);
    const plain: FileHandleLike = { name: 'a.yaml', getFile: a.getFile };
    expect(await sameFile(plain, a)).toBe(false);
    const broken: FileHandleLike = {
      ...plain,
      isSameEntry: () => Promise.reject(new Error('gone')),
    };
    expect(await sameFile(broken, a)).toBe(false);
  });
});

describe('rememberMap', () => {
  const ids = ['new-1', 'new-2'];
  const newId = () => ids.shift() ?? 'more';
  const file = (fake: Fake) => ({ name: fake.name, handle: fake });

  it('makes a new entry, first in the list', async () => {
    const old = entry(handle('/old/architecture.yaml'));
    const structure = handle('/shop/architecture.yaml');
    const workItems = handle('/shop/workitems.json');
    const { list, entry: made } = await rememberMap(
      [old],
      { structure: file(structure), workItems: file(workItems), hint: 'Shop' },
      42,
      newId,
    );
    expect(made).toEqual({
      id: 'new-1',
      structure: file(structure),
      workItems: file(workItems),
      hint: 'Shop',
      openedAt: 42,
    });
    expect(list).toEqual([made, old]);
  });

  it('uses the entry of the same file again — told by the file, not by its name', async () => {
    const shop = { ...entry(handle('/shop/architecture.yaml')), id: 'shop' };
    const store = { ...entry(handle('/store/architecture.yaml')), id: 'store' };
    const again = handle('/store/architecture.yaml');
    const { list, entry: made } = await rememberMap(
      [shop, store],
      { structure: file(again), hint: 'Store' },
      50,
      newId,
    );
    expect(made.id).toBe('store');
    expect(made.structure.handle).toBe(again);
    expect(list.map((item) => item.id)).toEqual(['store', 'shop']);
  });

  it('keeps the work items a map was last opened with, unless others come with it', async () => {
    const structure = handle('/shop/architecture.yaml');
    const sprint1 = handle('/shop/sprint1.json');
    const known = { ...entry(structure, sprint1), id: 'shop' };
    const alone = await rememberMap([known], { structure: file(structure), hint: '' }, 60, newId);
    expect(alone.entry.workItems?.handle).toBe(sprint1);
    const sprint2 = handle('/shop/sprint2.json');
    const together = await rememberMap(
      [known],
      { structure: file(structure), workItems: file(sprint2), hint: '' },
      61,
      newId,
    );
    expect(together.entry.workItems?.handle).toBe(sprint2);
    expect(together.list).toHaveLength(1);
  });

  it('keeps the list no longer than allowed', async () => {
    const list = [entry(handle('/a.yaml')), { ...entry(handle('/b.yaml')), id: 'map-2' }];
    const result = await rememberMap(
      list,
      { structure: file(handle('/c.yaml')), hint: '' },
      70,
      () => 'map-3',
      2,
    );
    expect(result.list.map((item) => item.id)).toEqual(['map-3', 'map-1']);
  });
});

describe('openRecentMap', () => {
  it('reads both files when the browser allows it', async () => {
    const result = await openRecentMap(
      entry(
        handle('/shop/architecture.yaml', { permission: 'granted' }),
        handle('/shop/workitems.json', { permission: 'granted' }),
      ),
      false,
    );
    expect(result.status).toBe('opened');
    if (result.status !== 'opened') return;
    expect(await result.structure.text()).toBe('text of /shop/architecture.yaml');
    expect(await result.workItems?.text()).toBe('text of /shop/workitems.json');
    expect(result.workItemsProblem).toBeUndefined();
  });

  it('reads a reference that knows no permissions', async () => {
    const result = await openRecentMap(entry(handle('/shop/architecture.yaml')), false);
    expect(result.status).toBe('opened');
  });

  it('does not make the browser ask unless it may', async () => {
    const structure = handle('/shop/architecture.yaml', { permission: 'prompt' });
    const workItems = handle('/shop/workitems.json', { permission: 'prompt' });
    expect(await openRecentMap(entry(structure, workItems), false)).toEqual({ status: 'ask' });
    expect(structure.asked + workItems.asked).toBe(0);
  });

  it('asks for both files at once inside a click, and reads them when allowed', async () => {
    const structure = handle('/shop/architecture.yaml', { permission: 'prompt' });
    const workItems = handle('/shop/workitems.json', { permission: 'prompt' });
    const result = await openRecentMap(entry(structure, workItems), true);
    expect([structure.asked, workItems.asked]).toEqual([1, 1]);
    expect(result).toMatchObject({ status: 'opened' });
    expect(result.status === 'opened' && result.workItems).toBeTruthy();
  });

  it('stays unopened when the user does not answer, and fails when the answer is no', async () => {
    const dismissed = handle('/shop/architecture.yaml', { permission: 'prompt', answer: 'prompt' });
    expect(await openRecentMap(entry(dismissed), true)).toEqual({ status: 'ask' });
    const refused = handle('/shop/architecture.yaml', { permission: 'prompt', answer: 'denied' });
    expect(await openRecentMap(entry(refused), true)).toEqual({
      status: 'failed',
      reason: 'The browser does not allow this page to read architecture.yaml.',
    });
    const blocked = handle('/shop/architecture.yaml', { permission: 'denied' });
    expect((await openRecentMap(entry(blocked), true)).status).toBe('failed');
    expect(blocked.asked).toBe(0);
  });

  it('takes a refusal to ask (the click was too long ago) as not asked', async () => {
    const structure = handle('/shop/architecture.yaml', {
      permission: 'prompt',
      answer: new Error('User activation is required to request permissions.'),
    });
    expect(await openRecentMap(entry(structure), true)).toEqual({ status: 'ask' });
  });

  it('says so when the file is no longer there', async () => {
    const moved = handle('/shop/architecture.yaml', { permission: 'granted', readError: notFound });
    expect(await openRecentMap(entry(moved), false)).toEqual({
      status: 'failed',
      reason: 'architecture.yaml is no longer where it was (moved, renamed or deleted).',
    });
    const unreadable = handle('/shop/architecture.yaml', { readError: new Error('disk error') });
    expect(await openRecentMap(entry(unreadable), false)).toEqual({
      status: 'failed',
      reason: 'Could not read architecture.yaml (disk error).',
    });
  });

  it('opens the map without its work items when only those cannot be read', async () => {
    const structure = handle('/shop/architecture.yaml', { permission: 'granted' });
    const gone = await openRecentMap(
      entry(
        structure,
        handle('/shop/workitems.json', { permission: 'granted', readError: notFound }),
      ),
      false,
    );
    expect(gone).toMatchObject({
      status: 'opened',
      workItemsProblem: 'workitems.json is no longer where it was (moved, renamed or deleted).',
    });
    expect(gone.status === 'opened' && gone.workItems).toBeUndefined();
    const notAllowed = await openRecentMap(
      entry(structure, handle('/shop/workitems.json', { permission: 'prompt', answer: 'denied' })),
      true,
    );
    expect(notAllowed).toMatchObject({
      status: 'opened',
      workItemsProblem: 'workitems.json was not read: the browser did not allow it.',
    });
  });
});

describe('pickFiles', () => {
  it('offers the structure with its work items for a map, and JSON alone for work items', () => {
    expect(pickerOptions('map')).toMatchObject({ id: 'architecture-map', multiple: true });
    expect(JSON.stringify(pickerOptions('map'))).toMatch(/\.yaml.*\.yml.*\.json/);
    expect(pickerOptions('workitems')).toMatchObject({ multiple: false });
    expect(JSON.stringify(pickerOptions('workitems'))).not.toMatch(/yaml/);
  });

  it('gives the chosen files', async () => {
    const chosen = [handle('/shop/architecture.yaml'), handle('/shop/workitems.json')];
    const seen: unknown[] = [];
    const host = {
      showOpenFilePicker: (options: Record<string, unknown>) => {
        seen.push(options);
        return Promise.resolve<FileHandleLike[]>(chosen);
      },
    };
    expect(await pickFiles(host, 'map')).toEqual(chosen);
    expect(seen).toEqual([pickerOptions('map')]);
  });

  it('is empty when the user chose nothing', async () => {
    const cancelled = Object.assign(new Error('The user aborted a request.'), {
      name: 'AbortError',
    });
    expect(await pickFiles({ showOpenFilePicker: () => Promise.reject(cancelled) }, 'map')).toEqual(
      [],
    );
  });

  it('is undefined where the browser has no such dialog, or does not allow it', async () => {
    expect(await pickFiles({}, 'map')).toBeUndefined();
    const forbidden = Object.assign(new Error('blocked by policy'), { name: 'SecurityError' });
    expect(
      await pickFiles({ showOpenFilePicker: () => Promise.reject(forbidden) }, 'workitems'),
    ).toBeUndefined();
  });
});

describe('droppedHandles', () => {
  const item = (fake: Fake | null, kind = 'file') => ({
    kind,
    getAsFileSystemHandle: () => Promise.resolve<FileHandleLike | null>(fake),
  });

  it('gives the references of the dropped files, leaving out text and folders', async () => {
    const yaml = handle('/shop/architecture.yaml');
    const json = handle('/shop/workitems.json');
    const folder = handle('/shop/docs', { kind: 'directory' });
    expect(await droppedHandles([item(yaml), item(null, 'string'), item(json)])).toEqual([
      yaml,
      json,
    ]);
    expect(await droppedHandles([item(yaml), item(folder)])).toEqual([yaml]);
  });

  it('is undefined where the browser gives none, or not for every file', async () => {
    expect(await droppedHandles([])).toBeUndefined();
    expect(await droppedHandles([{ kind: 'file' }])).toBeUndefined();
    expect(await droppedHandles([item(handle('/a.yaml')), item(null)])).toBeUndefined();
    expect(await droppedHandles([item(handle('/docs', { kind: 'directory' }))])).toBeUndefined();
    const failing = { kind: 'file', getAsFileSystemHandle: () => Promise.reject(new Error('no')) };
    expect(await droppedHandles([failing])).toBeUndefined();
    const throwing = {
      kind: 'file',
      getAsFileSystemHandle: (): Promise<FileHandleLike | null> => {
        throw new Error('no');
      },
    };
    expect(await droppedHandles([throwing])).toBeUndefined();
  });
});

describe('indexedDbRecentStore', () => {
  it('does not wait for ever for storage that never answers', async () => {
    // The request is made and nothing comes back: neither success nor error.
    const silent = { open: () => ({}) } as unknown as IDBFactory;
    const started = Date.now();
    expect(await indexedDbRecentStore(silent, 20).read()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('remembers nothing, and fails at nothing, without IndexedDB', async () => {
    const store = indexedDbRecentStore(undefined);
    await expect(store.write([entry(handle('/a.yaml'))])).resolves.toBeUndefined();
    expect(await store.read()).toEqual([]);
  });

  it('survives an IndexedDB that cannot be opened', async () => {
    const broken = {
      open: () => {
        throw new Error('storage is switched off');
      },
    } as unknown as IDBFactory;
    const store = indexedDbRecentStore(broken);
    await expect(store.write([entry(handle('/a.yaml'))])).resolves.toBeUndefined();
    expect(await store.read()).toEqual([]);
  });
});
