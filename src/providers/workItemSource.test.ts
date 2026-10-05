import { describe, expect, it } from 'vitest';
import fixtureJson from '../../fixtures/workitems.json?raw';
import type { LoaderResponse } from './structureSource';
import {
  isWorkItemFileName,
  loadInitialWorkItems,
  mockWorkItemProvider,
  readWorkItemFile,
  requestedWorkItemsUrl,
  type WorkItemLoaderEnv,
} from './workItemSource';

const SMALL = '{"version":1,"items":[{"id":1,"type":"Bug","title":"B","state":"New"}]}';

/** The page as served by a web server, and as opened by double-click. */
const PAGE = 'http://maps.example/team/viewer.html';
const FILE_PAGE = 'file:///C:/maps/viewer.html';

/** The page address with `?workitems=<name>`. */
function withWorkItems(name: string, page: string = PAGE): string {
  return `${page}?workitems=${encodeURIComponent(name)}`;
}

function response(
  body: string,
  init: { status?: number; contentType?: string } = {},
): LoaderResponse {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? (init.contentType ?? null) : null),
    },
    text: () => Promise.resolve(body),
  };
}

function env(
  overrides: Partial<WorkItemLoaderEnv> = {},
  calls: string[] = [],
  reply: (url: string) => Promise<LoaderResponse> = () => Promise.resolve(response(SMALL)),
): WorkItemLoaderEnv {
  return {
    pageUrl: PAGE,
    fetch: (url) => {
      calls.push(url);
      return reply(url);
    },
    ...overrides,
  };
}

describe('requestedWorkItemsUrl', () => {
  it('reads ?workitems= and ignores ?data=', () => {
    expect(requestedWorkItemsUrl('?workitems=other.json')).toBe('other.json');
    expect(requestedWorkItemsUrl('?data=a.yaml&workitems=sprint%2Fw.json')).toBe('sprint/w.json');
    expect(requestedWorkItemsUrl('?data=a.yaml')).toBeUndefined();
    expect(requestedWorkItemsUrl('?workitems=')).toBeUndefined();
    expect(requestedWorkItemsUrl('')).toBeUndefined();
  });
});

describe('isWorkItemFileName', () => {
  it('takes .json files as work items and everything else as structure', () => {
    expect(isWorkItemFileName('workitems.json')).toBe(true);
    expect(isWorkItemFileName('Export.JSON ')).toBe(true);
    expect(isWorkItemFileName('architecture.yaml')).toBe(false);
    expect(isWorkItemFileName('a.yml')).toBe(false);
    expect(isWorkItemFileName('json')).toBe(false);
  });
});

describe('loadInitialWorkItems', () => {
  it('2: fetches ?workitems=, else workitems.json next to the page', async () => {
    const calls: string[] = [];
    const named = await loadInitialWorkItems(env({ pageUrl: withWorkItems('other.json') }, calls));
    expect(named.source).toEqual({
      origin: 'url',
      text: SMALL,
      name: 'other.json',
      diagnosticsName: 'other.json',
    });
    const fallback = await loadInitialWorkItems(env({}, calls));
    expect(fallback.source?.name).toBe('workitems.json');
    expect(calls).toEqual([
      'http://maps.example/team/other.json',
      'http://maps.example/team/workitems.json',
    ]);
  });

  it('2: never fetches from another server, nor content carried in the link itself', async () => {
    for (const name of [
      'https://other.example/w.json',
      'http://maps.example:8080/w.json',
      '//other.example/w.json',
      '/\\other.example/w.json',
      'data:application/json,{"version":1,"items":[]}',
      'blob:http://maps.example/1f0c6d2e',
    ]) {
      const calls: string[] = [];
      const result = await loadInitialWorkItems(env({ pageUrl: withWorkItems(name) }, calls));
      expect(calls, name).toEqual([]);
      expect(result.source, name).toBeUndefined();
      expect(result.reason, name).toMatch(/only from the place it was opened from/);
    }
  });

  it('fetches nothing on file://: neither a local file nor one on a server', async () => {
    const calls: string[] = [];
    const local = await loadInitialWorkItems(env({ pageUrl: FILE_PAGE }, calls));
    expect(local.source).toBeUndefined();
    expect(local.reason).toMatch(/opened from disk cannot read workitems\.json by itself/);
    const relative = await loadInitialWorkItems(
      env({ pageUrl: withWorkItems('w.json', FILE_PAGE) }, calls),
    );
    expect(relative.source).toBeUndefined();
    expect(relative.reason).toMatch(/cannot read w\.json by itself/);
    const remote = await loadInitialWorkItems(
      env({ pageUrl: withWorkItems('https://maps.example/w.json', FILE_PAGE) }, calls),
    );
    expect(remote.source).toBeUndefined();
    expect(remote.reason).toMatch(/only from the place it was opened from/);
    expect(calls).toEqual([]);
  });

  it('3: gives no source, with the reason, when nothing can be loaded — and never rejects', async () => {
    const missing = await loadInitialWorkItems(
      env({}, [], () => Promise.resolve(response('', { status: 404 }))),
    );
    expect(missing).toEqual({ reason: 'Could not load workitems.json (HTTP 404).' });
    const html = await loadInitialWorkItems(
      env({}, [], () =>
        Promise.resolve(response('<!doctype html>', { contentType: 'text/html; charset=utf-8' })),
      ),
    );
    expect(html.reason).toMatch(/returned an HTML page/);
    const offline = await loadInitialWorkItems(
      env({}, [], () => Promise.reject(new Error('network down'))),
    );
    expect(offline.reason).toBe('Could not load workitems.json (network down).');
    const odd = await loadInitialWorkItems(env({}, [], () => Promise.reject('boom')));
    expect(odd.reason).toBe('Could not load workitems.json (boom).');
  });

  it('does not wait for ever: a file that does not arrive in time counts as not found', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const hanging = await loadInitialWorkItems({
      ...env(),
      timeoutMs: 20,
      fetch: (_url, signal) => {
        signals.push(signal);
        return new Promise<LoaderResponse>(() => undefined);
      },
    });
    expect(hanging).toEqual({ reason: 'Could not load workitems.json (no answer within 0.02 s).' });
    expect(signals[0]?.aborted).toBe(true);

    // Headers at once, the body never.
    const stalled = await loadInitialWorkItems(
      env({ timeoutMs: 20 }, [], () =>
        Promise.resolve({ ...response(SMALL), text: () => new Promise<string>(() => undefined) }),
      ),
    );
    expect(stalled.reason).toMatch(/no answer within/);

    // An answer in time is not aborted.
    const seen: (AbortSignal | undefined)[] = [];
    const quick = await loadInitialWorkItems({
      ...env(),
      fetch: (_url, signal) => {
        seen.push(signal);
        return Promise.resolve(response(SMALL));
      },
    });
    expect(quick.source?.text).toBe(SMALL);
    expect(seen[0]?.aborted).toBe(false);
  });
});

describe('readWorkItemFile', () => {
  it('reads a picked or dropped file', async () => {
    const source = await readWorkItemFile({
      name: 'mine.json',
      text: () => Promise.resolve(SMALL),
    });
    expect(source).toEqual({
      origin: 'file',
      text: SMALL,
      name: 'mine.json',
      diagnosticsName: 'mine.json',
    });
  });
});

describe('mockWorkItemProvider', () => {
  it('fetches the items of the data file it finds', async () => {
    const provider = mockWorkItemProvider(() =>
      loadInitialWorkItems(env({}, [], () => Promise.resolve(response(fixtureJson)))),
    );
    const items = await provider.fetch();
    expect(items.length).toBeGreaterThan(50);
    expect(items[0]).toMatchObject({ id: 1001, type: 'Epic', componentIds: ['storefront'] });
    const loaded = await provider.load();
    expect(loaded.source?.origin).toBe('url');
    expect(loaded.items).toEqual(items);
    expect(loaded.errors).toEqual([]);
    expect(loaded.warnings).toEqual([]);
  });

  it('gives no items and no diagnostics when there is no file', async () => {
    const provider = mockWorkItemProvider(() => loadInitialWorkItems(env({ pageUrl: FILE_PAGE })));
    const loaded = await provider.load();
    expect(loaded).toMatchObject({ items: [], errors: [], warnings: [] });
    expect(loaded.source).toBeUndefined();
    expect(loaded.reason).toMatch(/opened from disk/);
    expect(await provider.fetch()).toEqual([]);
  });

  it('reports a broken file under its diagnostics name', async () => {
    const provider = mockWorkItemProvider(() =>
      loadInitialWorkItems(
        env({}, [], () => Promise.resolve(response('{"version":1,"items":[{"id":1}, 3]}'))),
      ),
    );
    const loaded = await provider.load();
    expect(loaded.items).toEqual([]);
    expect(loaded.errors.map((d) => [d.path, d.source])).toEqual([
      ['items[0]', 'workitems.json'],
      ['items[1]', 'workitems.json'],
    ]);
  });

  it('reads a picked file, and survives a locator that fails', async () => {
    const picked = mockWorkItemProvider(async () => ({
      source: await readWorkItemFile({ name: 'mine.json', text: () => Promise.resolve(SMALL) }),
    }));
    expect((await picked.fetch()).map((item) => item.id)).toEqual([1]);
    const failing = mockWorkItemProvider(() => Promise.reject(new Error('unreadable')));
    expect(await failing.load()).toEqual({
      reason: 'unreadable',
      items: [],
      errors: [],
      warnings: [],
    });
  });
});
