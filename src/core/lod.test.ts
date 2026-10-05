import { describe, expect, it } from 'vitest';
import {
  createLodTracker,
  effectiveLod,
  isLodMode,
  isValidZoom,
  LOD_CONFIG,
  LOD_MODES,
  lodForZoom,
  lodModeToReveal,
  lodThreshold,
  type LodConfig,
} from './lod';
import { LOD_LEVELS, type LodLevel } from './visibility';

const H = LOD_CONFIG.hysteresis;
const T1 = LOD_CONFIG.componentsZoom;
const T2 = LOD_CONFIG.subcomponentsZoom;
const T3 = LOD_CONFIG.detailZoom;

/** Each threshold with the level below and above it. */
const THRESHOLDS: ReadonlyArray<readonly [number, LodLevel, LodLevel]> = [
  [T1, 'domains', 'components'],
  [T2, 'components', 'subcomponents'],
  [T3, 'subcomponents', 'detail'],
];

/** Levels over a sequence of zooms, each fed the previous one; starts with no previous level. */
function run(zooms: readonly number[], config?: LodConfig): LodLevel[] {
  const track = createLodTracker(config);
  return zooms.map((zoom) => track(zoom));
}

/** The level changes along `levels`, as `from>to`. */
function transitions(levels: readonly LodLevel[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1];
    const b = levels[i];
    if (a !== undefined && b !== undefined && a !== b) out.push(`${a}>${b}`);
  }
  return out;
}

function sweep(from: number, to: number, steps: number): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);
}

describe('LOD_CONFIG', () => {
  it('holds the thresholds and hysteresis', () => {
    expect(LOD_CONFIG).toEqual({
      componentsZoom: 0.4,
      subcomponentsZoom: 1.0,
      detailZoom: 1.6,
      hysteresis: 0.05,
      fallbackLevel: 'detail',
    });
  });

  it('has one threshold per level above the first, in rising order', () => {
    expect(LOD_LEVELS).toEqual(['domains', 'components', 'subcomponents', 'detail']);
    expect(LOD_LEVELS.map((level) => lodThreshold(level))).toEqual([0, T1, T2, T3]);
    expect(T1).toBeLessThan(T2);
    expect(T2).toBeLessThan(T3);
    // The dead bands of neighbouring thresholds do not touch.
    expect(T1 * (1 + H)).toBeLessThan(T2 * (1 - H));
    expect(T2 * (1 + H)).toBeLessThan(T3 * (1 - H));
  });
});

describe('lodForZoom without a previous level (plain thresholds)', () => {
  it.each([
    [0.05, 'domains'],
    [0.399, 'domains'],
    [0.4, 'components'],
    [0.7, 'components'],
    [1, 'components'],
    [1.000001, 'subcomponents'],
    [1.04, 'subcomponents'],
    [1.6, 'subcomponents'],
    [1.600001, 'detail'],
    [4, 'detail'],
  ] as const)('zoom %s → %s', (zoom, level) => {
    expect(lodForZoom(zoom)).toBe(level);
  });

  it('ignores the hysteresis', () => {
    for (const [t, below, above] of THRESHOLDS) {
      expect(lodForZoom(t * (1 - H / 2))).toBe(below);
      expect(lodForZoom(t * (1 + H / 2))).toBe(above);
    }
  });
});

describe('lodForZoom with a previous level (hysteresis)', () => {
  it.each(THRESHOLDS)('threshold %s: moves up only beyond t * (1 + h)', (t, below, above) => {
    expect(lodForZoom(t, below)).toBe(below);
    expect(lodForZoom(t * (1 + H), below)).toBe(below);
    expect(lodForZoom(t * (1 + H) + 1e-9, below)).toBe(above);
  });

  it.each(THRESHOLDS)('threshold %s: moves down only below t * (1 - h)', (t, below, above) => {
    expect(lodForZoom(t, above)).toBe(above);
    expect(lodForZoom(t * (1 - H), above)).toBe(above);
    expect(lodForZoom(t * (1 - H) - 1e-9, above)).toBe(below);
  });

  it('crosses several thresholds in one change', () => {
    expect(lodForZoom(4, 'domains')).toBe('detail');
    expect(lodForZoom(0.1, 'detail')).toBe('domains');
    expect(lodForZoom(1.3, 'domains')).toBe('subcomponents');
    expect(lodForZoom(0.7, 'detail')).toBe('components');
  });

  it('from levels away, the dead band of the far threshold still applies', () => {
    expect(lodForZoom(T3 * (1 + H / 2), 'domains')).toBe('subcomponents');
    expect(lodForZoom(T1 * (1 - H / 2), 'detail')).toBe('components');
  });

  it('is idempotent', () => {
    for (const previous of LOD_LEVELS) {
      for (const zoom of sweep(0.1, 3, 290)) {
        const level = lodForZoom(zoom, previous);
        expect(lodForZoom(zoom, level)).toBe(level);
      }
    }
  });
});

describe('no flicker', () => {
  it.each(THRESHOLDS)(
    'oscillating within the dead band of threshold %s never changes the level',
    (t, below, above) => {
      const wiggle = [1 - H, 1 + H, 1 - H / 2, 1, 1 + H / 2, 1 - H, 1 + H].map((f) => t * f);
      for (const [start, level] of [
        [t * 0.8, below],
        [t * 1.2, above],
      ] as const) {
        const levels = run([start, ...wiggle]);
        expect(new Set(levels)).toEqual(new Set([level]));
      }
    },
  );

  it('a jitter wider than the dead band flips once per crossing, not per tick', () => {
    const levels = run([0.7, T2 * 1.06, T2 * 0.97, T2 * 1.03, T2 * 0.96, T2 * 1.04]);
    expect(transitions(levels)).toEqual(['components>subcomponents']);
  });

  it('zooming in gives each transition exactly once, just past t * (1 + h)', () => {
    const zooms = sweep(0.1, 3, 2900);
    const levels = run(zooms);
    expect(transitions(levels)).toEqual([
      'domains>components',
      'components>subcomponents',
      'subcomponents>detail',
    ]);
    for (const [t, , above] of THRESHOLDS) {
      const first = zooms[levels.indexOf(above)] ?? 0;
      expect(first).toBeGreaterThan(t * (1 + H));
      expect(first).toBeLessThan(t * (1 + H) + 0.002);
    }
  });

  it('zooming out gives each transition exactly once, just below t * (1 - h)', () => {
    const zooms = sweep(3, 0.1, 2900);
    const levels = run(zooms);
    expect(transitions(levels)).toEqual([
      'detail>subcomponents',
      'subcomponents>components',
      'components>domains',
    ]);
    for (const [t, below] of THRESHOLDS) {
      const first = zooms[levels.indexOf(below)] ?? 0;
      expect(first).toBeLessThan(t * (1 - H));
      expect(first).toBeGreaterThan(t * (1 - H) - 0.002);
    }
  });
});

describe('invalid zoom', () => {
  const invalid = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  it('isValidZoom accepts positive finite numbers only', () => {
    for (const zoom of invalid) expect(isValidZoom(zoom)).toBe(false);
    expect(isValidZoom(0.0001)).toBe(true);
    expect(isValidZoom(4)).toBe(true);
  });

  it('keeps the previous level, or falls back without one', () => {
    for (const zoom of invalid) {
      expect(lodForZoom(zoom)).toBe(LOD_CONFIG.fallbackLevel);
      for (const level of LOD_LEVELS) expect(lodForZoom(zoom, level)).toBe(level);
    }
  });
});

describe('custom config', () => {
  const config: LodConfig = {
    componentsZoom: 0.2,
    subcomponentsZoom: 0.5,
    detailZoom: 2,
    hysteresis: 0.1,
    fallbackLevel: 'components',
  };

  it('thresholds, hysteresis and fallback come from the config', () => {
    expect(lodForZoom(0.19, undefined, config)).toBe('domains');
    expect(lodForZoom(0.3, undefined, config)).toBe('components');
    expect(lodForZoom(0.6, undefined, config)).toBe('subcomponents');
    expect(lodForZoom(2.1, undefined, config)).toBe('detail');
    expect(lodForZoom(0.54, 'components', config)).toBe('components');
    expect(lodForZoom(0.56, 'components', config)).toBe('subcomponents');
    expect(lodForZoom(Number.NaN, undefined, config)).toBe('components');
    expect(lodThreshold('detail', config)).toBe(2);
  });

  it('zero hysteresis reduces to the plain thresholds off the threshold values', () => {
    const plain = { ...LOD_CONFIG, hysteresis: 0 };
    for (const previous of LOD_LEVELS) {
      for (const zoom of [0.1, 0.39, 0.41, 0.99, 1.01, 1.59, 1.61, 3]) {
        expect(lodForZoom(zoom, previous, plain)).toBe(lodForZoom(zoom, undefined, plain));
      }
    }
  });
});

describe('createLodTracker', () => {
  it('trackers are independent', () => {
    const a = createLodTracker();
    const b = createLodTracker();
    expect(a(2)).toBe('detail');
    expect(b(0.2)).toBe('domains');
    expect(a(1.55)).toBe('detail');
    expect(b(0.41)).toBe('domains');
  });

  it('reset: the next zoom is judged by the plain thresholds again', () => {
    const track = createLodTracker();
    expect(track(1)).toBe('components');
    // With the history, both zooms sit inside a dead band and keep the level …
    expect(track(0.39)).toBe('components');
    expect(track(1.03)).toBe('components');
    // … as a first call they do not.
    track.reset();
    expect(track(0.39)).toBe('domains');
    track.reset();
    expect(track(1.03)).toBe('subcomponents');
    // Hysteresis applies again from there.
    expect(track(0.97)).toBe('subcomponents');
  });

  it('hold: keeps the level shown and drops the history', () => {
    const track = createLodTracker();
    // Nothing shown yet: the plain level of the provisional zoom.
    expect(track.hold(1)).toBe('components');
    // The provisional zoom did not seed the hysteresis (the React Flow default zoom of 1,
    // before the first fit to view).
    expect(track(0.39)).toBe('domains');

    // A pending fit: the level does not move with the zoom still on screen …
    expect(track(0.41)).toBe('domains');
    expect(track.hold(0.41)).toBe('domains');
    expect(track.hold(3)).toBe('domains');
    // … and the fitted zoom is a first call.
    expect(track(0.41)).toBe('components');

    track.reset();
    expect(track.hold(2)).toBe('detail');
    expect(track.hold(Number.NaN)).toBe('detail');
  });
});

describe('level-of-detail mode', () => {
  it('lists auto first, then every level', () => {
    expect(LOD_MODES).toEqual(['auto', ...LOD_LEVELS]);
    for (const mode of LOD_MODES) expect(isLodMode(mode)).toBe(true);
    for (const value of ['', 'Auto', 'everything', 3, null, undefined]) {
      expect(isLodMode(value)).toBe(false);
    }
  });

  it('auto follows the zoom, a pinned level ignores it', () => {
    for (const zoomLevel of LOD_LEVELS) {
      expect(effectiveLod('auto', zoomLevel)).toBe(zoomLevel);
      for (const pinned of LOD_LEVELS) expect(effectiveLod(pinned, zoomLevel)).toBe(pinned);
    }
  });

  it('revealing raises a pinned level that is too coarse, and nothing else', () => {
    for (const needed of LOD_LEVELS) expect(lodModeToReveal('auto', needed)).toBe('auto');
    expect(lodModeToReveal('domains', 'components')).toBe('components');
    expect(lodModeToReveal('domains', 'subcomponents')).toBe('subcomponents');
    expect(lodModeToReveal('components', 'subcomponents')).toBe('subcomponents');
    expect(lodModeToReveal('components', 'components')).toBe('components');
    expect(lodModeToReveal('detail', 'domains')).toBe('detail');
    expect(lodModeToReveal('subcomponents', 'components')).toBe('subcomponents');
  });
});
