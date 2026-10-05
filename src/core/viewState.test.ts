// Persistence of the viewport and the edge-kind filter: must never throw.

import { describe, expect, it } from 'vitest';
import { parseOk } from './layout/test-helpers';
import type { EdgeKind } from './model';
import {
  hiddenKindsStorageKey,
  parseHiddenKinds,
  parseViewport,
  readHiddenKinds,
  readViewport,
  serializeHiddenKinds,
  serializeViewport,
  viewportStorageKey,
  writeHiddenKinds,
  writeViewport,
} from './viewState';
import {
  collapsedStorageKey,
  readCollapsed,
  writeCollapsed,
  type ViewStateStorage,
} from './visibility';

const yaml = (domain: string): string => `
version: 1
domains:
  - id: ${domain}
    name: Domain
    components:
      - id: ${domain}.x
        name: X
`;
const model = parseOk(yaml('a'));
const other = parseOk(yaml('b'));

function memoryStorage(): ViewStateStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

/** A storage as in a browser that blocks it: every access throws. */
const throwing: ViewStateStorage = {
  getItem: () => {
    throw new Error('SecurityError: access denied');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('viewport persistence', () => {
  it('round-trips a viewport, rounded', () => {
    const storage = memoryStorage();
    expect(writeViewport(storage, model, { x: -12.3456, y: 78.91, zoom: 0.734567 })).toBe(true);
    expect(readViewport(storage, model)).toEqual({ x: -12.3, y: 78.9, zoom: 0.7346 });
  });

  it('is keyed by the structure: another file does not inherit it', () => {
    const storage = memoryStorage();
    writeViewport(storage, model, { x: 1, y: 2, zoom: 1 });
    expect(viewportStorageKey(model)).not.toBe(viewportStorageKey(other));
    expect(readViewport(storage, other)).toBeUndefined();
    // Separate entries from the collapsed set and the filter of the same structure.
    expect(
      new Set([viewportStorageKey(model), hiddenKindsStorageKey(model), collapsedStorageKey(model)])
        .size,
    ).toBe(3);
  });

  it('rejects anything that is not a valid viewport', () => {
    for (const text of [
      null,
      undefined,
      '',
      'not json',
      'null',
      '[]',
      '42',
      '{}',
      '{"x":0,"y":0}',
      '{"x":"0","y":0,"zoom":1}',
      '{"x":0,"y":0,"zoom":0}',
      '{"x":0,"y":0,"zoom":-1}',
      '{"x":0,"y":0,"zoom":100}',
      '{"x":1e999,"y":0,"zoom":1}',
      '{"x":null,"y":0,"zoom":1}',
    ]) {
      expect(parseViewport(text)).toBeUndefined();
    }
    expect(parseViewport('{"x":5,"y":-6,"zoom":0.5}')).toEqual({ x: 5, y: -6, zoom: 0.5 });
    expect(parseViewport(serializeViewport({ x: 0, y: 0, zoom: 1 }))).toEqual({
      x: 0,
      y: 0,
      zoom: 1,
    });
  });

  it('honours a custom zoom range', () => {
    expect(parseViewport('{"x":0,"y":0,"zoom":3}', { min: 0.1, max: 2 })).toBeUndefined();
    const storage = memoryStorage();
    writeViewport(storage, model, { x: 0, y: 0, zoom: 3 });
    expect(readViewport(storage, model, { zoomRange: { min: 0.1, max: 2 } })).toBeUndefined();
    expect(readViewport(storage, model)).toEqual({ x: 0, y: 0, zoom: 3 });
  });

  it('refuses to write an invalid viewport', () => {
    const storage = memoryStorage();
    expect(writeViewport(storage, model, { x: NaN, y: 0, zoom: 1 })).toBe(false);
    expect(writeViewport(storage, model, { x: 0, y: 0, zoom: 0 })).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it('ignores a stored viewport that would show none of the map', () => {
    const storage = memoryStorage();
    const content = { bounds: { width: 2000, height: 1000 }, screen: { width: 800, height: 600 } };
    writeViewport(storage, model, { x: -500, y: -200, zoom: 1 });
    expect(readViewport(storage, model, { content })).toEqual({ x: -500, y: -200, zoom: 1 });
    writeViewport(storage, model, { x: -5000, y: 0, zoom: 1 }); // map entirely left of the screen
    expect(readViewport(storage, model, { content })).toBeUndefined();
    writeViewport(storage, model, { x: 0, y: 900, zoom: 1 }); // entirely below
    expect(readViewport(storage, model, { content })).toBeUndefined();
    expect(readViewport(storage, model)).toEqual({ x: 0, y: 900, zoom: 1 });
  });

  it('ignores a stored viewport that leaves only a sliver of the map at the edge', () => {
    const storage = memoryStorage();
    const content = { bounds: { width: 2000, height: 1000 }, screen: { width: 800, height: 600 } };
    // The map starts 2 px before the right / bottom edge of the canvas.
    writeViewport(storage, model, { x: 798, y: 598, zoom: 1 });
    expect(readViewport(storage, model, { content })).toBeUndefined();
    writeViewport(storage, model, { x: 798, y: 0, zoom: 1 });
    expect(readViewport(storage, model, { content })).toBeUndefined();
    writeViewport(storage, model, { x: 0, y: 598, zoom: 1 });
    expect(readViewport(storage, model, { content })).toBeUndefined();
    // 2 px of its right / bottom end left on screen.
    writeViewport(storage, model, { x: -1998, y: -998, zoom: 1 });
    expect(readViewport(storage, model, { content })).toBeUndefined();
    // 48 px in both directions is enough.
    writeViewport(storage, model, { x: 752, y: 552, zoom: 1 });
    expect(readViewport(storage, model, { content })).toEqual({ x: 752, y: 552, zoom: 1 });
    // A map zoomed out to less than that still counts when all of it is on screen.
    const small = { bounds: { width: 400, height: 300 }, screen: content.screen };
    writeViewport(storage, model, { x: 100, y: 100, zoom: 0.1 }); // 40 x 30 px
    expect(readViewport(storage, model, { content: small })).toEqual({ x: 100, y: 100, zoom: 0.1 });
    writeViewport(storage, model, { x: 790, y: 100, zoom: 0.1 }); // 10 of its 40 px
    expect(readViewport(storage, model, { content: small })).toBeUndefined();
  });

  it('works without storage and with a storage that throws', () => {
    expect(readViewport(undefined, model)).toBeUndefined();
    expect(writeViewport(undefined, model, { x: 0, y: 0, zoom: 1 })).toBe(false);
    expect(() => readViewport(throwing, model)).not.toThrow();
    expect(readViewport(throwing, model)).toBeUndefined();
    expect(() => writeViewport(throwing, model, { x: 0, y: 0, zoom: 1 })).not.toThrow();
    expect(writeViewport(throwing, model, { x: 0, y: 0, zoom: 1 })).toBe(false);
  });
});

describe('edge-kind filter persistence', () => {
  const kinds = (...list: EdgeKind[]): Set<EdgeKind> => new Set(list);

  it('round-trips the hidden kinds per structure', () => {
    const storage = memoryStorage();
    expect(writeHiddenKinds(storage, model, kinds('control', 'config'))).toBe(true);
    expect([...readHiddenKinds(storage, model)].sort()).toEqual(['config', 'control']);
    expect(readHiddenKinds(storage, other).size).toBe(0);
    writeHiddenKinds(storage, model, kinds());
    expect(readHiddenKinds(storage, model).size).toBe(0);
  });

  it('serialises sorted, and ignores anything that is not a known kind', () => {
    expect(serializeHiddenKinds(kinds('dependency', 'config'))).toBe('["config","dependency"]');
    expect([...parseHiddenKinds('["dataflow","bogus",3,null,"control"]')]).toEqual([
      'dataflow',
      'control',
    ]);
    for (const text of [null, undefined, '', '{', '{}', '"dataflow"', '7']) {
      expect(parseHiddenKinds(text).size).toBe(0);
    }
  });

  it('works without storage and with a storage that throws', () => {
    expect(readHiddenKinds(undefined, model).size).toBe(0);
    expect(writeHiddenKinds(undefined, model, kinds('control'))).toBe(false);
    expect(() => readHiddenKinds(throwing, model)).not.toThrow();
    expect(readHiddenKinds(throwing, model).size).toBe(0);
    expect(() => writeHiddenKinds(throwing, model, kinds('control'))).not.toThrow();
    expect(writeHiddenKinds(throwing, model, kinds('control'))).toBe(false);
  });
});

describe('all view state with a throwing storage', () => {
  it('reads give the defaults and writes report failure, none throws', () => {
    expect(readCollapsed(throwing, model).size).toBe(0);
    expect(writeCollapsed(throwing, model, new Set(['a']))).toBe(false);
    expect(readViewport(throwing, model)).toBeUndefined();
    expect(readHiddenKinds(throwing, model).size).toBe(0);
  });
});
