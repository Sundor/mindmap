// Zoom-driven level of detail: which `LodLevel` a zoom factor selects, with
// hysteresis around each threshold so the detail does not flicker at a boundary, and the mode
// that lets the user pin one level instead.
// Pure: no React, no browser APIs. What each level shows is decided in ./visibility and ./flow.

import { LOD_LEVELS, type LodLevel } from './visibility';

export interface LodConfig {
  /** Zoom below which only domains are shown (`domains`); at or above it, `components`. */
  readonly componentsZoom: number;
  /** Zoom above which subcomponents are shown (`subcomponents`); at or below it, `components`. */
  readonly subcomponentsZoom: number;
  /**
   * Zoom above which everything is shown (`detail`: also what is inside the boxes, i.e. the
   * work items); at or below it, `subcomponents`.
   */
  readonly detailZoom: number;
  /**
   * Relative half-width of the dead band around each threshold: to move up past a threshold `t`
   * the zoom must exceed `t * (1 + hysteresis)`, to move down it must fall below
   * `t * (1 - hysteresis)`.
   */
  readonly hysteresis: number;
  /** Level used when the zoom is not a positive finite number and there is no previous level. */
  readonly fallbackLevel: LodLevel;
}

/** Everything that tunes the level of detail is here. */
export const LOD_CONFIG: LodConfig = {
  componentsZoom: 0.4,
  subcomponentsZoom: 1.0,
  detailZoom: 1.6,
  hysteresis: 0.05,
  fallbackLevel: 'detail',
};

/** True for a zoom factor React Flow can actually have: finite and positive. */
export function isValidZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom > 0;
}

/** The zoom thresholds between consecutive levels: entry `i` separates level `i` from `i + 1`. */
function thresholds(config: LodConfig): readonly number[] {
  return [config.componentsZoom, config.subcomponentsZoom, config.detailZoom];
}

/** Zoom at which `level` starts; 0 for `domains`, which has no lower bound. */
export function lodThreshold(level: LodLevel, config: LodConfig = LOD_CONFIG): number {
  const index = LOD_LEVELS.indexOf(level);
  return index <= 0 ? 0 : (thresholds(config)[index - 1] ?? 0);
}

/**
 * Level of detail for `zoom`.
 *
 * Without a `previousLevel` (first call) the plain thresholds apply: below `componentsZoom` →
 * `domains`, above `subcomponentsZoom` → `subcomponents`, above `detailZoom` → `detail`,
 * otherwise `components` (`componentsZoom` itself is `components`; each upper threshold value
 * belongs to the level below it).
 *
 * With a `previousLevel`, each threshold is judged on its own from the side the previous level
 * was on: a threshold the previous level was above is only left by falling below
 * `t * (1 - hysteresis)`, one it was below is only passed by exceeding `t * (1 + hysteresis)`.
 * A single change that crosses several thresholds therefore moves several levels at once, and a
 * zoom staying inside the dead band of a threshold never changes the level.
 *
 * A zoom that is not a positive finite number (0, negative, NaN, ±Infinity) keeps
 * `previousLevel`, or gives `config.fallbackLevel` when there is none.
 *
 * Idempotent: `lodForZoom(z, lodForZoom(z, p)) === lodForZoom(z, p)`.
 */
export function lodForZoom(
  zoom: number,
  previousLevel?: LodLevel,
  config: LodConfig = LOD_CONFIG,
): LodLevel {
  if (!isValidZoom(zoom)) return previousLevel ?? config.fallbackLevel;
  const { hysteresis } = config;
  const previous = previousLevel === undefined ? undefined : LOD_LEVELS.indexOf(previousLevel);

  let index = 0;
  thresholds(config).forEach((threshold, i) => {
    let passed: boolean;
    if (previous === undefined) passed = i === 0 ? zoom >= threshold : zoom > threshold;
    else if (previous > i) passed = zoom >= threshold * (1 - hysteresis);
    else passed = zoom > threshold * (1 + hysteresis);
    if (passed) index = i + 1;
  });
  return LOD_LEVELS[index] ?? config.fallbackLevel;
}

// --- Adjusting the thresholds ---------------------------------------------------------------

export type LodThresholdKey = 'componentsZoom' | 'subcomponentsZoom' | 'detailZoom';
/** The thresholds, lowest first. */
export const LOD_THRESHOLD_KEYS: readonly LodThresholdKey[] = [
  'componentsZoom',
  'subcomponentsZoom',
  'detailZoom',
];
/** Range offered for a threshold (the sliders on the Detail tab). */
export const LOD_THRESHOLD_RANGE = { min: 0.05, max: 4, step: 0.05 } as const;

/** Smallest ratio between consecutive thresholds: their dead bands must not touch. */
function thresholdRatio(config: LodConfig): number {
  return ((1 + config.hysteresis) / (1 - config.hysteresis)) * 1.02;
}

/**
 * `config` with threshold `key` set to `value` (clamped to {@link LOD_THRESHOLD_RANGE}). The
 * other thresholds are pushed along where needed, so the three stay in rising order with dead
 * bands that do not touch.
 */
export function withLodThreshold(
  config: LodConfig,
  key: LodThresholdKey,
  value: number,
): LodConfig {
  if (!Number.isFinite(value)) return config;
  const ratio = thresholdRatio(config);
  const index = LOD_THRESHOLD_KEYS.indexOf(key);
  const last = LOD_THRESHOLD_KEYS.length - 1;
  const values = LOD_THRESHOLD_KEYS.map((k) => config[k]);
  // Leave room below and above for the other thresholds.
  const min = LOD_THRESHOLD_RANGE.min * ratio ** index;
  const max = LOD_THRESHOLD_RANGE.max / ratio ** (last - index);
  values[index] = Math.min(max, Math.max(min, value));
  for (let i = index + 1; i <= last; i++) {
    values[i] = Math.max(values[i] ?? 0, (values[i - 1] ?? 0) * ratio);
  }
  for (let i = index - 1; i >= 0; i--) {
    values[i] = Math.min(values[i] ?? 0, (values[i + 1] ?? 0) / ratio);
  }
  // Rounding in the pushes may overshoot the range by a hair.
  const [componentsZoom = 0, subcomponentsZoom = 0, detailZoom = 0] = values.map((v) =>
    Math.min(LOD_THRESHOLD_RANGE.max, Math.max(LOD_THRESHOLD_RANGE.min, v)),
  );
  return { ...config, componentsZoom, subcomponentsZoom, detailZoom };
}

/**
 * `base` with the thresholds found in `value` (as stored: an object with the three threshold
 * keys); anything that is not three rising numbers within the range gives `base` unchanged.
 */
export function lodConfigFromStored(value: unknown, base: LodConfig = LOD_CONFIG): LodConfig {
  if (typeof value !== 'object' || value === null) return base;
  const record = value as Record<string, unknown>;
  let config = base;
  const wanted: number[] = [];
  for (const key of LOD_THRESHOLD_KEYS) {
    const threshold = record[key];
    if (typeof threshold !== 'number' || !isValidZoom(threshold)) return base;
    wanted.push(threshold);
    config = { ...config, [key]: threshold };
  }
  // Applying each through `withLodThreshold` must change nothing: otherwise the stored values
  // are out of range or out of order. "Nothing" allows for rounding: a threshold that was pushed
  // along by its neighbour (`value * ratio`) may come out one bit different when pushed again,
  // and an exact comparison would throw away settings the sliders themselves produced.
  let checked = config;
  for (const key of LOD_THRESHOLD_KEYS) checked = withLodThreshold(checked, key, checked[key]);
  return LOD_THRESHOLD_KEYS.every((key, i) => Math.abs(checked[key] - (wanted[i] ?? NaN)) < 1e-9)
    ? config
    : base;
}

// --- Mode -----------------------------------------------------------------------------------

/** How the level of detail is chosen: by the zoom (`auto`) or pinned to one level. */
export type LodMode = 'auto' | LodLevel;
export const LOD_MODES: readonly LodMode[] = ['auto', ...LOD_LEVELS];

export function isLodMode(value: unknown): value is LodMode {
  return typeof value === 'string' && (LOD_MODES as readonly string[]).includes(value);
}

/** The level that is drawn: the pinned one, or in `auto` mode the one the zoom selects. */
export function effectiveLod(mode: LodMode, zoomLevel: LodLevel): LodLevel {
  return mode === 'auto' ? zoomLevel : mode;
}

/**
 * The mode to switch to so that `needed` (or a finer level) can be drawn: a pinned level that
 * is too coarse is replaced by `needed`; `auto` and fine enough pinned levels are kept.
 */
export function lodModeToReveal(mode: LodMode, needed: LodLevel): LodMode {
  if (mode === 'auto') return mode;
  return LOD_LEVELS.indexOf(mode) < LOD_LEVELS.indexOf(needed) ? needed : mode;
}

// --- Tracker --------------------------------------------------------------------------------

/** A stateful `zoom → LodLevel` function; see `createLodTracker`. */
export interface LodTracker {
  /** Level for `zoom`, judged with hysteresis against the level last returned. */
  (zoom: number): LodLevel;
  /**
   * Level to show while `zoom` is provisional (no viewport yet, or a fit to view is pending):
   * the level last returned, or the plain-threshold level of `zoom` when there is none. The
   * hysteresis history is dropped, so the next tracked zoom is judged by the plain thresholds.
   */
  hold(zoom: number): LodLevel;
  /** Forgets everything: the tracker is as new. */
  reset(): void;
}

/**
 * A stateful `zoom → LodLevel` function that remembers the level it last returned and feeds it
 * back as the previous level. Suited as a store selector: called with every zoom value, it
 * returns the same string for as long as the level does not change.
 */
export function createLodTracker(config: LodConfig = LOD_CONFIG): LodTracker {
  /** Level the next zoom is judged against; `undefined` → plain thresholds. */
  let previous: LodLevel | undefined;
  /** Level last returned by either form. */
  let shown: LodLevel | undefined;
  const track = (zoom: number): LodLevel => {
    previous = shown = lodForZoom(zoom, previous, config);
    return shown;
  };
  const hold = (zoom: number): LodLevel => {
    previous = undefined;
    shown ??= lodForZoom(zoom, undefined, config);
    return shown;
  };
  const reset = (): void => {
    previous = shown = undefined;
  };
  return Object.assign(track, { hold, reset });
}
