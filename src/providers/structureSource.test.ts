import { describe, expect, it } from 'vitest';
import {
  dataFileAddress,
  loadInitialStructure,
  pageSearch,
  readStructureFile,
  requestedDataUrl,
  type LoaderEnv,
  type LoaderResponse,
} from './structureSource';

/** The page as served by a web server, and as opened by double-click. */
const PAGE = 'http://maps.example/team/viewer.html';
const FILE_PAGE = 'file:///C:/maps/viewer.html';

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
  overrides: Partial<LoaderEnv> = {},
  calls: string[] = [],
  reply: (url: string) => Promise<LoaderResponse> = () => Promise.resolve(response('version: 1')),
): LoaderEnv {
  return {
    pageUrl: PAGE,
    fetch: (url) => {
      calls.push(url);
      return reply(url);
    },
    ...overrides,
  };
}

/** The page address with `?data=<name>`. */
function withData(name: string, page: string = PAGE): string {
  return `${page}?data=${encodeURIComponent(name)}`;
}

/** Names that lead to another place than `PAGE`, in every spelling a link could use. */
const ELSEWHERE = [
  'https://other.example/a.yaml',
  'http://other.example/a.yaml',
  // The same host on another port or over another scheme is another server.
  'http://maps.example:8080/a.yaml',
  'https://maps.example/a.yaml',
  // These only look relative: the browser reads each of them as an address on other.example.
  '//other.example/a.yaml',
  '/\\other.example/a.yaml',
  '\\\\other.example\\a.yaml',
  'ht\ttps://other.example/a.yaml',
  'http:\n//other.example/a.yaml',
  // Content carried in the link itself, and local files.
  'data:text/yaml,version: 1',
  'blob:http://maps.example/1f0c6d2e',
  'JavaScript:alert(1)',
  'file:///C:/secret.yaml',
  'ftp://maps.example/a.yaml',
];

describe('requestedDataUrl', () => {
  it('reads ?data=', () => {
    expect(requestedDataUrl('?data=other.yaml')).toBe('other.yaml');
    expect(requestedDataUrl('?x=1&data=maps%2Fa.yaml')).toBe('maps/a.yaml');
  });

  it('is undefined when absent or empty', () => {
    expect(requestedDataUrl('')).toBeUndefined();
    expect(requestedDataUrl('?data=')).toBeUndefined();
    expect(requestedDataUrl('?other=1')).toBeUndefined();
  });
});

describe('pageSearch', () => {
  it('is the query string of the page address, without the fragment', () => {
    expect(pageSearch(`${PAGE}?data=a.yaml#view=x`)).toBe('?data=a.yaml');
    expect(pageSearch(PAGE)).toBe('');
    expect(pageSearch(`${FILE_PAGE}?data=a.yaml`)).toBe('?data=a.yaml');
  });

  it('is empty for an address that cannot be read', () => {
    expect(pageSearch('')).toBe('');
    expect(pageSearch('not an address')).toBe('');
  });
});

describe('dataFileAddress', () => {
  it('resolves a name against the page, on the server the page came from', () => {
    expect(dataFileAddress('architecture.yaml', PAGE)).toEqual({
      url: 'http://maps.example/team/architecture.yaml',
    });
    expect(dataFileAddress('maps/store.yaml', PAGE)).toEqual({
      url: 'http://maps.example/team/maps/store.yaml',
    });
    expect(dataFileAddress('../store.yaml', PAGE)).toEqual({
      url: 'http://maps.example/store.yaml',
    });
    expect(dataFileAddress('/shared/all.yaml?rev=2', PAGE)).toEqual({
      url: 'http://maps.example/shared/all.yaml?rev=2',
    });
  });

  it('takes a full address of the same server, however it is spelled', () => {
    expect(dataFileAddress('http://maps.example/a.yaml', PAGE)).toEqual({
      url: 'http://maps.example/a.yaml',
    });
    expect(dataFileAddress('HTTP://MAPS.EXAMPLE:80/a.yaml', PAGE)).toEqual({
      url: 'http://maps.example/a.yaml',
    });
    expect(dataFileAddress('a.yaml', 'https://maps.example:8443/v/viewer.html')).toEqual({
      url: 'https://maps.example:8443/v/a.yaml',
    });
  });

  it('leaves out what fetch would refuse or not send: user name, password, fragment', () => {
    expect(
      dataFileAddress('a.yaml#top', 'https://user:secret@maps.example/viewer.html#view=x'),
    ).toEqual({ url: 'https://maps.example/a.yaml' });
  });

  it('refuses every name that leads to another place', () => {
    for (const name of ELSEWHERE) {
      expect(dataFileAddress(name, PAGE), name).toEqual({ refused: 'elsewhere' });
    }
  });

  it('refuses everything on file://: local files as such, the rest as another place', () => {
    expect(dataFileAddress('architecture.yaml', FILE_PAGE)).toEqual({ refused: 'local' });
    expect(dataFileAddress('../other/a.yaml', FILE_PAGE)).toEqual({ refused: 'local' });
    expect(dataFileAddress('//server/share/a.yaml', FILE_PAGE)).toEqual({ refused: 'local' });
    expect(dataFileAddress('https://maps.example/a.yaml', FILE_PAGE)).toEqual({
      refused: 'elsewhere',
    });
    expect(dataFileAddress('data:text/yaml,version: 1', FILE_PAGE)).toEqual({
      refused: 'elsewhere',
    });
  });

  it('refuses when the page has no server of its own, or its address cannot be read', () => {
    expect(dataFileAddress('a.yaml', 'about:blank')).toEqual({ refused: 'elsewhere' });
    expect(dataFileAddress('a.yaml', 'blob:http://maps.example/1f0c6d2e')).toEqual({
      refused: 'elsewhere',
    });
    expect(dataFileAddress('a.yaml', '')).toEqual({ refused: 'elsewhere' });
    expect(dataFileAddress('http://[', PAGE)).toEqual({ refused: 'elsewhere' });
  });
});

describe('loadInitialStructure', () => {
  it('2: fetches architecture.yaml next to the page', async () => {
    const calls: string[] = [];
    const result = await loadInitialStructure(env({}, calls));
    expect(calls).toEqual(['http://maps.example/team/architecture.yaml']);
    expect(result.source).toEqual({
      origin: 'url',
      text: 'version: 1',
      name: 'architecture.yaml',
      diagnosticsName: 'architecture.yaml',
    });
  });

  it('2: fetches ?data=<path> instead when given, and names the source as written', async () => {
    const calls: string[] = [];
    const result = await loadInitialStructure(env({ pageUrl: withData('maps/store.yaml') }, calls));
    expect(calls).toEqual(['http://maps.example/team/maps/store.yaml']);
    expect(result.source?.name).toBe('maps/store.yaml');
  });

  it('2: never fetches from another server, nor content carried in the link itself', async () => {
    for (const name of ELSEWHERE) {
      const calls: string[] = [];
      const result = await loadInitialStructure(env({ pageUrl: withData(name) }, calls));
      expect(calls, name).toEqual([]);
      expect(result, name).toEqual({
        reason: expect.stringMatching(/only from the place it was opened from/),
      });
    }
  });

  it('3: reports an HTTP error instead of throwing', async () => {
    const result = await loadInitialStructure(
      env({}, [], () => Promise.resolve(response('nope', { status: 404 }))),
    );
    expect(result.source).toBeUndefined();
    expect(result).toMatchObject({ reason: 'Could not load architecture.yaml (HTTP 404).' });
  });

  it('3: reports a network failure instead of throwing', async () => {
    const result = await loadInitialStructure(
      env({}, [], () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(result).toMatchObject({ reason: 'Could not load architecture.yaml (Failed to fetch).' });
  });

  it('3: does not mistake an HTML fallback page for the structure file', async () => {
    const result = await loadInitialStructure(
      env({}, [], () =>
        Promise.resolve(response('<!doctype html>', { contentType: 'text/html; charset=utf-8' })),
      ),
    );
    expect(result.source).toBeUndefined();
  });

  it('skips the fetch of a local file on file://', async () => {
    const calls: string[] = [];
    const result = await loadInitialStructure(env({ pageUrl: FILE_PAGE }, calls));
    expect(calls).toEqual([]);
    expect(result.source).toBeUndefined();
    // Nothing went wrong: a page opened from disk has to be given its file.
    expect(result).toEqual({
      reason: expect.stringMatching(/opened from disk cannot read architecture\.yaml by itself/),
      local: true,
    });

    await loadInitialStructure(env({ pageUrl: withData('local.yaml', FILE_PAGE) }, calls));
    expect(calls).toEqual([]);
  });

  it('fetches nothing from a server on file:// either', async () => {
    const calls: string[] = [];
    const result = await loadInitialStructure(
      env({ pageUrl: withData('https://maps.example/a.yaml', FILE_PAGE) }, calls),
    );
    expect(calls).toEqual([]);
    expect(result).toEqual({
      reason: expect.stringMatching(/only from the place it was opened from/),
    });
  });
});

describe('readStructureFile', () => {
  it('names the source after the file', async () => {
    const source = await readStructureFile({
      name: 'store.yml',
      text: () => Promise.resolve('version: 1'),
    });
    expect(source).toEqual({
      origin: 'file',
      text: 'version: 1',
      name: 'store.yml',
      diagnosticsName: 'store.yml',
    });
  });
});
