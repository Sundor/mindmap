// Exporting the map as a file: what can be chosen and how the choice is kept, the size of a
// PNG, the part of the canvas that is on screen, the name of the file, and what a picture says
// about itself. Pure: storage and the clock are handed in, and nothing here throws.

import type { Rect, Size } from './layout/types';
import type { PictureCounts } from './mapPicture';
import type { EdgeKind } from './model';
import type { Viewport } from './navigate';
import type { ColorScheme } from './pictureKit';
import type { LodLevel, ViewStateStorage } from './visibility';
import { STORY_MODE_LABELS, type StoryMode } from './workitems';

// --- The choices ---------------------------------------------------------------------------------

export const EXPORT_FORMATS = ['png', 'svg', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** `map`: everything that is drawn. `view`: the part of it the canvas shows now. */
export const EXPORT_AREAS = ['map', 'view'] as const;
export type ExportArea = (typeof EXPORT_AREAS)[number];

/** `screen`: the scheme the viewer is shown in at the moment of the export. */
export const EXPORT_SCHEMES = ['screen', 'light', 'dark'] as const;
export type ExportScheme = (typeof EXPORT_SCHEMES)[number];

/** Pixels of a PNG per pixel of the map. */
export const PNG_SCALES = [1, 2, 3] as const;
export type PngScale = (typeof PNG_SCALES)[number];

export interface ExportChoices {
  readonly area: ExportArea;
  readonly scheme: ExportScheme;
  /** The title above the map and the key below it. */
  readonly caption: boolean;
  readonly scale: PngScale;
}

export const DEFAULT_EXPORT_CHOICES: ExportChoices = {
  area: 'map',
  scheme: 'screen',
  caption: true,
  scale: 2,
};

/** One entry for the whole viewer (not per structure), beside `architecture-map.settings`. */
export const EXPORT_CHOICES_KEY = 'architecture-map.export';

/** `value` when it is one of `values`, otherwise `fallback`. */
function oneOf<T extends string | number>(values: readonly T[], value: unknown, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback;
}

export function serializeExportChoices(choices: ExportChoices): string {
  return JSON.stringify({
    area: choices.area,
    scheme: choices.scheme,
    caption: choices.caption,
    scale: choices.scale,
  });
}

/**
 * Choices from stored text. Each of the four is read by itself: one that is missing or is not
 * one of its values is the default, the others are kept; text that is no JSON object gives the
 * defaults. Other entries of the object are ignored.
 */
export function parseExportChoices(text: string | null | undefined): ExportChoices {
  if (!text) return DEFAULT_EXPORT_CHOICES;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_EXPORT_CHOICES;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_EXPORT_CHOICES;
  }
  const record = value as Record<string, unknown>;
  const d = DEFAULT_EXPORT_CHOICES;
  return {
    area: oneOf(EXPORT_AREAS, record.area, d.area),
    scheme: oneOf(EXPORT_SCHEMES, record.scheme, d.scheme),
    caption: typeof record.caption === 'boolean' ? record.caption : d.caption,
    scale: oneOf(PNG_SCALES, record.scale, d.scale),
  };
}

export function readExportChoices(storage: ViewStateStorage | undefined): ExportChoices {
  try {
    return parseExportChoices(storage?.getItem(EXPORT_CHOICES_KEY));
  } catch {
    return DEFAULT_EXPORT_CHOICES;
  }
}

export function writeExportChoices(
  storage: ViewStateStorage | undefined,
  choices: ExportChoices,
): void {
  try {
    storage?.setItem(EXPORT_CHOICES_KEY, serializeExportChoices(choices));
  } catch {
    // Storage full or blocked: the choices simply are not remembered.
  }
}

/** The scheme a file is written in: the chosen one, or — for `screen` — the one on screen. */
export function pictureScheme(choice: ExportScheme, screenIsDark: boolean): ColorScheme {
  if (choice === 'screen') return screenIsDark ? 'dark' : 'light';
  return choice;
}

// --- Sizes ---------------------------------------------------------------------------------------

/**
 * What a canvas is asked for at most: 16 384 px a side (the smallest limit of the current
 * browsers) and 64 million pixels (256 MB while the picture is made).
 */
export const PNG_LIMITS = { side: 16384, area: 64_000_000 } as const;

export interface PngSize {
  /** Whole pixels, at least 1 each. */
  readonly width: number;
  readonly height: number;
  /** Pixels per pixel of the picture, after the reduction. */
  readonly scale: number;
  /** The picture did not fit at the scale asked for. */
  readonly reduced: boolean;
}

/**
 * The pixel size of the PNG of a picture `width` × `height` at `scale`: the scale is lowered
 * until both sides and the area are within `limits`. A size that is no positive number gives
 * 1 × 1.
 */
export function pngSize(
  width: number,
  height: number,
  scale: number,
  limits: { readonly side: number; readonly area: number } = PNG_LIMITS,
): PngSize {
  if (!(width > 0 && height > 0 && scale > 0) || !Number.isFinite(width * height * scale)) {
    return { width: 1, height: 1, scale: 1, reduced: false };
  }
  const fit = Math.min(
    scale,
    limits.side / width,
    limits.side / height,
    Math.sqrt(limits.area / (width * height)),
  );
  // Whole pixels, rounded down: never beyond a limit.
  const pixels = (side: number) => Math.max(1, Math.floor(side * fit + 1e-9));
  return { width: pixels(width), height: pixels(height), scale: fit, reduced: fit < scale };
}

/**
 * The part of the canvas that is on screen, in canvas pixels: what a canvas of `screen` pixels
 * shows under `viewport`, less the `coveredLeft` screen pixels at its left that the control
 * panel lies over. Undefined when nothing is left (a canvas without a size, a zoom of 0).
 */
export function viewExtent(viewport: Viewport, screen: Size, coveredLeft = 0): Rect | undefined {
  const covered = Math.max(0, Math.min(screen.width, coveredLeft));
  const width = (screen.width - covered) / viewport.zoom;
  const height = screen.height / viewport.zoom;
  const x = (covered - viewport.x) / viewport.zoom;
  const y = (0 - viewport.y) / viewport.zoom;
  if (!(width > 0 && height > 0) || !Number.isFinite(x + y + width + height)) return undefined;
  return { x, y, width, height };
}

// --- The file ------------------------------------------------------------------------------------

/** MIME types of the three files. */
export const EXPORT_MIME: Readonly<Record<ExportFormat, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml;charset=utf-8',
  html: 'text/html;charset=utf-8',
};

const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** What a structure file without a usable name is called. */
export const EXPORT_BASE_FALLBACK = 'architecture';
const BASE_MAX = 80;

/**
 * The name a structure goes by: its file name without folders, undefined when nothing is left.
 * A name with a folder is an address, which ends at its query or fragment (`data/shop.yaml?v=3`);
 * the name of a file opened from disk has no folder, and `?` and `#` are characters of it.
 */
export function structureFileName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const end = /[\\/]/.test(name) ? name.search(/[?#]/) : -1;
  const last = (end < 0 ? name : name.slice(0, end)).split(/[\\/]/).pop()?.trim() ?? '';
  return last === '' ? undefined : last;
}

/**
 * The name of an exported file: `<base>-map.<format>`. The base is the structure file's name
 * without folders and without its last extension; characters a file system refuses
 * (`< > : " / \ | ? *`, control characters) become `-`, it is cut to 80 characters, dots and
 * spaces at its ends go, and a name that is empty then — or one Windows reserves — is
 * `architecture`.
 */
export function exportFileName(structureName: string | undefined, format: ExportFormat): string {
  let base = structureFileName(structureName) ?? '';
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-');
  base = [...base].slice(0, BASE_MAX).join('');
  base = base.replace(/^[.\s]+|[.\s]+$/g, '');
  if (base === '' || RESERVED_NAMES.test(base)) base = EXPORT_BASE_FALLBACK;
  return `${base}-map.${format}`;
}

/**
 * `YYYY-MM-DD HH:MM` of the moment `ms` (milliseconds since 1970, UTC) on a clock that is
 * `offsetMinutes` ahead of UTC (`-new Date(ms).getTimezoneOffset()` for the local one); empty
 * for a moment that is none.
 */
export function exportStamp(ms: number, offsetMinutes: number): string {
  const date = new Date(ms + offsetMinutes * 60_000);
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// --- What a picture says about itself ------------------------------------------------------------

/** The levels of detail in the words of the Detail tab. */
export const PICTURE_LEVEL_NAMES: Readonly<Record<LodLevel, string>> = {
  domains: 'Domains',
  components: 'Components',
  subcomponents: 'Subcomponents',
  detail: 'Everything',
};

/** The state of the viewer a picture is taken in, as far as the picture says it in words. */
export interface PictureFacts {
  /** Name of the structure file as the viewer shows it (a path or a file name). */
  readonly structureName?: string | undefined;
  /**
   * Name of the work-items file, while work items are on the map (lines, badges, heat or
   * progress).
   */
  readonly workItemsName?: string | undefined;
  /** The level that is drawn. */
  readonly level: LodLevel;
  /** Name of the focus, while one is set. */
  readonly focusName?: string | undefined;
  /** The map is reduced to its focus (Filter). */
  readonly filtered?: boolean | undefined;
  /** What the boxes are coloured by, in words (`coloringTitle`); left out for nothing. */
  readonly colorBy?: string | undefined;
  readonly heat?: boolean | undefined;
  readonly progress?: boolean | undefined;
  /** What the canvas shows of the work items; left out without work items. */
  readonly storyMode?: StoryMode | undefined;
  readonly iteration?: string | undefined;
  /** The edge kinds that are switched off. */
  readonly hiddenKinds?: readonly EdgeKind[] | undefined;
  /** Edges on demand holds edges back. */
  readonly edgesOnDemand?: boolean | undefined;
  /** Something is selected: its mark, and the dimming around it, are in the picture. */
  readonly selection?: boolean | undefined;
  readonly area: ExportArea;
  /** {@link exportStamp} of the export. */
  readonly exportedAt: string;
}

/** The title of a picture: the structure file's name, and the focus while one is set. */
export function pictureTitle(facts: Pick<PictureFacts, 'structureName' | 'focusName'>): string {
  const name = structureFileName(facts.structureName) ?? 'Architecture map';
  return facts.focusName === undefined || facts.focusName.trim() === ''
    ? name
    : `${name} — ${facts.focusName.trim()}`;
}

/**
 * The line under the title: what the picture shows, part by part, joined by ` · `. A part
 * that says nothing is left out; the level is always there.
 */
export function pictureNote(facts: PictureFacts): string {
  const parts: string[] = [`Level: ${PICTURE_LEVEL_NAMES[facts.level]}`];
  if (facts.focusName !== undefined && facts.focusName.trim() !== '') {
    parts.push(facts.filtered ? 'Filtered to the focus' : 'Focus: the rest is paled');
  }
  if (facts.colorBy !== undefined && facts.colorBy.trim() !== '') {
    parts.push(`Colour by ${facts.colorBy.trim()}`);
  }
  if (facts.heat) parts.push('Heat by work');
  if (facts.progress) parts.push('Progress');
  if (facts.storyMode !== undefined && facts.storyMode !== 'off') {
    parts.push(`Work items: ${STORY_MODE_LABELS[facts.storyMode]}`);
  }
  if (facts.iteration !== undefined && facts.iteration.trim() !== '') {
    parts.push(`Iteration ${facts.iteration.trim()}`);
  }
  const workItems = structureFileName(facts.workItemsName);
  if (workItems !== undefined) parts.push(`Work items from ${workItems}`);
  const hidden = facts.hiddenKinds ?? [];
  if (hidden.length > 0) parts.push(`Without ${hidden.join(', ')} edges`);
  if (facts.edgesOnDemand) parts.push('Edges on demand: only the edges shown');
  if (facts.selection) parts.push('With the selection');
  if (facts.area === 'view') parts.push('Part of the map');
  if (facts.exportedAt !== '') parts.push(`Exported ${facts.exportedAt}`);
  return parts.join(' · ');
}

/**
 * The description of a picture (`<desc>` of the SVG, `<meta name="description">` of the page):
 * one sentence with the counts, then the note, then the viewer that made it.
 */
export function pictureDescription(
  facts: PictureFacts,
  counts: PictureCounts,
  version: string,
): string {
  const boxes = `${counts.nodes} ${counts.nodes === 1 ? 'box' : 'boxes'}`;
  const edges = `${counts.edges} ${counts.edges === 1 ? 'edge' : 'edges'}`;
  return `Architecture map of ${pictureTitle(facts)}: ${boxes} and ${edges}. ${pictureNote(facts)}. Made with Architecture Map ${version}.`;
}

/** The `generator` of an exported page. */
export function exportGenerator(version: string): string {
  return `Architecture Map ${version}`;
}

// --- What the Export section says ----------------------------------------------------------------

export const EXPORT_TEXTS = {
  heading: 'Export',
  area: 'Area',
  areaMap: 'Whole map',
  areaView: 'What is on screen',
  scheme: 'Colours',
  schemeScreen: 'As on screen',
  schemeLight: 'Light',
  schemeDark: 'Dark',
  caption: 'Title and legend',
  scale: 'PNG size',
  pngTitle: 'Save a picture of the map (PNG)',
  svgTitle: 'Save the map as a vector drawing: shapes and text, sharp at any size (SVG)',
  htmlTitle:
    'Save the map as a web page that needs nothing else and lists the boxes as text (HTML)',
  scaleTitle: 'Pixels of the PNG per pixel of the map',
  pending: 'The map is still being laid out',
  working: 'Making the picture…',
  note: 'The map as it is drawn now: level of detail, focus, colours, work items and what is selected. A PNG is a fixed picture; SVG stays sharp at any size; the HTML page opens in any browser.',
  selection:
    'The selection is part of the picture: click the empty canvas first for one without it.',
  onDemand: 'Edges on demand: only the edges shown now are in the picture.',
  tooLarge:
    'Could not make the PNG: the picture is too large for this browser. SVG has no such limit.',
  nothingInView: 'Nothing of the map is on screen.',
  nothingDrawn: 'Nothing is drawn.',
  failed: 'Could not export: ',
} as const;

/**
 * Why the three buttons do nothing at the moment — the tooltip they then have — or undefined
 * when they work: a layout is on its way, or an export is running.
 */
export function exportBlocked(state: {
  readonly pending: boolean;
  readonly busy: boolean;
}): string | undefined {
  if (state.busy) return EXPORT_TEXTS.working;
  return state.pending ? EXPORT_TEXTS.pending : undefined;
}

/** What an export made, for the status line (and its `data-*` attributes). */
export interface ExportOutcome {
  readonly format: ExportFormat;
  /** Name of the file handed to the browser. */
  readonly name: string;
  /** Size of the file in bytes. */
  readonly bytes: number;
  /** Size of the picture: in pixels of the map, or — for a PNG — in pixels of the file. */
  readonly width: number;
  readonly height: number;
  /** For a PNG: the size it was made at. */
  readonly png?: PngSize | undefined;
  readonly nodes: number;
  readonly edges: number;
}

/** What the status line says of an outcome. */
export function outcomeText(outcome: ExportOutcome): string {
  return savedText(outcome.name, outcome.png);
}

/** What the status line says once a file is saved. */
export function savedText(name: string, png?: PngSize): string {
  if (!png) return `Saved ${name}.`;
  const size = `${png.width} × ${png.height} px`;
  if (!png.reduced) return `Saved ${name} (${size}).`;
  const exact = png.scale * 100;
  const rounded = Math.round(exact);
  // A scale is asked for in whole times the map. Reduced by less than half a percent, a picture
  // would be said to have the scale it was asked for: it is said to have one percent less.
  const percent = Math.max(1, rounded > exact && rounded % 100 === 0 ? rounded - 1 : rounded);
  return `Saved ${name} (${size} — reduced to ${percent} % to fit a picture; a smaller part of the map, or SVG, keeps every detail).`;
}
