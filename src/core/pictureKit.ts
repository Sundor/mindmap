// What a picture of the map is written with: the colours of both schemes, numbers and text as
// XML, and text widths without a browser. Pure: no DOM, no React.

import { estimateTextWidth } from './text';

// --- Colours ---------------------------------------------------------------------------------

export type ColorScheme = 'light' | 'dark';

export const COLOR_SCHEMES = ['light', 'dark'] as const;

/**
 * The colours of the canvas a picture repeats: for each entry the custom property of
 * `src/ui/styles.css` it stands for (`PALETTE_PROPERTIES`), or — for the two that are no
 * property of `:root` — the declaration it is read from (`PALETTE_DECLARATIONS`).
 */
export interface PicturePalette {
  readonly bg: string;
  readonly panel: string;
  readonly fg: string;
  readonly muted: string;
  readonly border: string;
  readonly bandEven: string;
  readonly bandOdd: string;
  readonly bandLine: string;
  readonly bandGutter: string;
  readonly bandLabel: string;
  readonly unassignedBg: string;
  readonly unassignedLine: string;
  readonly domainBg: string;
  readonly domainBorder: string;
  readonly domainHeaderBg: string;
  readonly domainHeaderFg: string;
  readonly componentBg: string;
  readonly componentBorder: string;
  readonly componentHeaderBg: string;
  readonly componentHeaderFg: string;
  readonly leafBg: string;
  readonly leafBorder: string;
  readonly leafFg: string;
  readonly nodeSelected: string;
  readonly collapsedBg: string;
  readonly collapsedHatch: string;
  readonly edgeDataflow: string;
  readonly edgeDependency: string;
  readonly edgeControl: string;
  readonly edgeConfig: string;
  readonly edgeLabelBg: string;
  readonly wiStory: string;
  readonly wiTask: string;
  readonly wiTaskMark: string;
  readonly wiBug: string;
  readonly wiFeature: string;
  readonly wiEpic: string;
  readonly wiHover: string;
  readonly wiSelected: string;
  /** The done part of a progress bar (`.arch-progress::after`). */
  readonly progressDone: string;
  /** The glow of a heat strip (the colour of the shadow of `.arch-heat`). */
  readonly heatGlow: string;
}

/** The custom property of `:root` behind each palette entry that has one. */
export const PALETTE_PROPERTIES = {
  bg: '--bg',
  panel: '--panel',
  fg: '--fg',
  muted: '--muted',
  border: '--border',
  bandEven: '--band-even',
  bandOdd: '--band-odd',
  bandLine: '--band-line',
  bandGutter: '--band-gutter',
  bandLabel: '--band-label',
  unassignedBg: '--unassigned-bg',
  unassignedLine: '--unassigned-line',
  domainBg: '--domain-bg',
  domainBorder: '--domain-border',
  domainHeaderBg: '--domain-header-bg',
  domainHeaderFg: '--domain-header-fg',
  componentBg: '--component-bg',
  componentBorder: '--component-border',
  componentHeaderBg: '--component-header-bg',
  componentHeaderFg: '--component-header-fg',
  leafBg: '--leaf-bg',
  leafBorder: '--leaf-border',
  leafFg: '--leaf-fg',
  nodeSelected: '--node-selected',
  collapsedBg: '--collapsed-bg',
  collapsedHatch: '--collapsed-hatch',
  edgeDataflow: '--edge-dataflow',
  edgeDependency: '--edge-dependency',
  edgeControl: '--edge-control',
  edgeConfig: '--edge-config',
  edgeLabelBg: '--edge-label-bg',
  wiStory: '--wi-story',
  wiTask: '--wi-task',
  wiTaskMark: '--wi-task-mark',
  wiBug: '--wi-bug',
  wiFeature: '--wi-feature',
  wiEpic: '--wi-epic',
  wiHover: '--wi-hover',
  wiSelected: '--wi-selected',
} as const satisfies Partial<Record<keyof PicturePalette, string>>;

/**
 * The two entries that are a colour inside a declaration of a rule: selector, property, and
 * the colour is the first colour of the value (with `var()` resolved from `:root`).
 */
export const PALETTE_DECLARATIONS = {
  progressDone: { selector: '.arch-progress::after', property: 'background' },
  heatGlow: { selector: '.arch-heat', property: 'box-shadow' },
} as const satisfies Partial<
  Record<keyof PicturePalette, { readonly selector: string; readonly property: string }>
>;

const LIGHT: PicturePalette = {
  bg: '#f7f7f8',
  panel: '#ffffff',
  fg: '#1d1d1f',
  muted: '#5f6368',
  border: '#d9d9de',
  bandEven: 'rgba(37, 99, 235, 0.05)',
  bandOdd: 'rgba(37, 99, 235, 0.11)',
  bandLine: 'rgba(37, 99, 235, 0.25)',
  bandGutter: 'rgba(37, 99, 235, 0.1)',
  bandLabel: '#3b4a6b',
  unassignedBg: 'rgba(120, 120, 130, 0.08)',
  unassignedLine: 'rgba(120, 120, 130, 0.45)',
  domainBg: 'rgba(255, 255, 255, 0.72)',
  domainBorder: '#44517a',
  domainHeaderBg: '#44517a',
  domainHeaderFg: '#ffffff',
  componentBg: 'rgba(238, 242, 250, 0.85)',
  componentBorder: '#8b98b8',
  componentHeaderBg: '#dbe2f1',
  componentHeaderFg: '#1f2a44',
  leafBg: '#ffffff',
  leafBorder: '#9aa3b5',
  leafFg: '#1d1d1f',
  nodeSelected: '#2563eb',
  collapsedBg: '#eef1f8',
  collapsedHatch: 'rgba(68, 81, 122, 0.1)',
  edgeDataflow: '#1a73e8',
  edgeDependency: '#5f6368',
  edgeControl: '#d93025',
  edgeConfig: '#188038',
  edgeLabelBg: 'rgba(255, 255, 255, 0.92)',
  wiStory: '#009ccc',
  wiTask: '#f2cb1d',
  wiTaskMark: '#4a3a00',
  wiBug: '#cc293d',
  wiFeature: '#773b93',
  wiEpic: '#ff7b00',
  wiHover: 'rgba(37, 99, 235, 0.1)',
  wiSelected: 'rgba(37, 99, 235, 0.22)',
  progressDone: '#0ca30c',
  heatGlow: 'rgba(255, 120, 30, 0.45)',
};

const DARK: PicturePalette = {
  ...LIGHT,
  bg: '#17181a',
  panel: '#1f2023',
  fg: '#e8e8ea',
  muted: '#9aa0a6',
  border: '#34363b',
  bandEven: 'rgba(138, 180, 248, 0.04)',
  bandOdd: 'rgba(138, 180, 248, 0.09)',
  bandLine: 'rgba(138, 180, 248, 0.25)',
  bandGutter: 'rgba(138, 180, 248, 0.1)',
  bandLabel: '#b9c6e4',
  unassignedBg: 'rgba(160, 160, 170, 0.07)',
  unassignedLine: 'rgba(160, 160, 170, 0.4)',
  domainBg: 'rgba(32, 34, 40, 0.72)',
  domainBorder: '#7f8fc4',
  domainHeaderBg: '#3a4672',
  domainHeaderFg: '#f1f3f9',
  componentBg: 'rgba(44, 48, 58, 0.85)',
  componentBorder: '#5e6a8c',
  componentHeaderBg: '#353c4f',
  componentHeaderFg: '#e3e8f5',
  leafBg: '#26282d',
  leafBorder: '#6b7280',
  leafFg: '#e8e8ea',
  nodeSelected: '#8ab4f8',
  collapsedBg: '#2b2f3a',
  collapsedHatch: 'rgba(160, 175, 220, 0.1)',
  edgeDataflow: '#8ab4f8',
  edgeDependency: '#bdc1c6',
  edgeControl: '#f28b82',
  edgeConfig: '#81c995',
  edgeLabelBg: 'rgba(31, 32, 35, 0.92)',
  wiBug: '#f0626f',
  wiFeature: '#b07fd0',
  wiHover: 'rgba(138, 180, 248, 0.14)',
  wiSelected: 'rgba(138, 180, 248, 0.3)',
};

/** The colours of a picture, per scheme: those of src/ui/styles.css, which a test holds them to. */
export const PICTURE_PALETTE: Readonly<Record<ColorScheme, PicturePalette>> = {
  light: LIGHT,
  dark: DARK,
};

/** A colour as numbers: channels 0–255, alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB =
  /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i;

/**
 * `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)` as numbers — the notations of the
 * palette and of the lens colours. Anything else throws: a colour the picture cannot write is a
 * mistake upstream, and a guess would be a wrong picture.
 */
export function parseColor(text: string): Rgba {
  const value = text.trim();
  const hex = HEX.exec(value);
  if (hex?.[1]) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = RGB.exec(value);
  if (rgb) {
    const channel = (part: string | undefined) => Math.min(255, Number(part));
    return {
      r: channel(rgb[1]),
      g: channel(rgb[2]),
      b: channel(rgb[3]),
      a: rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])),
    };
  }
  throw new Error(`not a colour the picture can write: ${text}`);
}

/**
 * `color-mix(in srgb, a <share>, b)`: `share` (0–1) of `a` and the rest of `b`, interpolated
 * with premultiplied alpha as CSS does it.
 */
export function mixColors(a: Rgba, share: number, b: Rgba): Rgba {
  const alpha = a.a * share + b.a * (1 - share);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (x: number, y: number) => (x * a.a * share + y * b.a * (1 - share)) / alpha;
  return { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: alpha };
}

/** `#rrggbb` of a colour, its alpha left out. */
export function colorHex(color: Rgba): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

// --- Writing XML -----------------------------------------------------------------------------

/**
 * A number of a picture: finite, two decimals at most, never `-0`. A value that is not finite
 * — or too large to be rounded to one that is — throws: a broken coordinate is an error, never
 * `NaN` or `Infinity` in a file.
 */
export function pictureNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (!Number.isFinite(rounded)) throw new Error(`not a number in the picture: ${value}`);
  return rounded === 0 ? '0' : String(rounded);
}

/**
 * Text for XML and HTML, in content and in a double-quoted attribute: `& < > " '` escaped, and
 * what XML 1.0 does not allow (control characters but tab, line feed and carriage return; lone
 * surrogates; U+FFFE and U+FFFF) left out.
 */
export function xmlText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const allowed =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000;
    if (!allowed) continue;
    switch (char) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default:
        out += char;
    }
  }
  return out;
}

/** Attribute values by name; a number is written with {@link pictureNumber}, undefined left out. */
export type XmlAttributes = Readonly<Record<string, string | number | undefined>>;

/**
 * One element: `<name a="…"/>`, or with `content` (markup that is already XML) between its
 * tags. Attribute values are escaped here; content is not.
 */
export function xmlElement(name: string, attributes: XmlAttributes, content?: string): string {
  let attrs = '';
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    attrs += ` ${key}="${typeof value === 'number' ? pictureNumber(value) : xmlText(value)}"`;
  }
  return content === undefined ? `<${name}${attrs}/>` : `<${name}${attrs}>${content}</${name}>`;
}

// --- Text ------------------------------------------------------------------------------------

/** The font of the page (`:root` in styles.css), written on the root of a picture. */
export const PICTURE_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * Width in pixels of `text` on one line at `fontSize` pixels and `weight`. The default
 * ({@link estimateMeasure}) is the upper estimate the layout sizes boxes from; a caller that
 * can measure gives real widths and says so with `exact`.
 */
export interface TextMeasure {
  (text: string, fontSize: number, weight: number): number;
  /**
   * True for real widths. Only then is a one-line text cut where it does not fit (an upper
   * estimate would cut names the screen shows whole), and every text written with `textLength`.
   */
  readonly exact?: boolean;
}

export const estimateMeasure: TextMeasure = (text, fontSize) => estimateTextWidth(text, fontSize);

/** The ellipsis a cut text ends with. */
export const ELLIPSIS = '…';

/** Cuts a text into the characters a reader sees; made once, where the runtime has one. */
let segmenter: Intl.Segmenter | null | undefined;

/**
 * The characters of `text` as a reader sees them (grapheme clusters: a letter with its accents,
 * a flag, a family of emoji joined into one) where the runtime can tell them apart
 * (`Intl.Segmenter`, part of the language, not of a browser); its code points otherwise.
 */
export function textCharacters(text: string): string[] {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  if (segmenter === null) return [...text];
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * `text` cut so that it is at most `width` wide by `measure`: the longest beginning (by the
 * characters a reader sees — {@link textCharacters} —, spaces at the cut removed) followed by an
 * ellipsis; the ellipsis alone when nothing fits beside it. A text that fits is returned as it is.
 */
export function fitText(
  text: string,
  width: number,
  fontSize: number,
  weight: number,
  measure: TextMeasure,
): string {
  if (measure(text, fontSize, weight) <= width) return text;
  const chars = textCharacters(text);
  const cut = (count: number) => `${chars.slice(0, count).join('').trimEnd()}${ELLIPSIS}`;
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(cut(middle), fontSize, weight) <= width) low = middle;
    else high = middle - 1;
  }
  return low === 0 ? ELLIPSIS : cut(low);
}

/**
 * `text` on lines at most `width` wide, broken the way `estimateLineCount` counts: at spaces
 * (not at no-break spaces), and inside a word that is wider than a whole line. With
 * {@link estimateMeasure} the number of lines is exactly `estimateLineCount(text, fontSize, width)`
 * — what the box was sized for. With an exact measure it is never more. At most `maxLines`
 * lines: the last one then ends with an ellipsis. At least one line (empty for an empty text).
 */
export function wrapText(
  text: string,
  width: number,
  fontSize: number,
  weight: number,
  measure: TextMeasure,
  maxLines = Infinity,
): string[] {
  const space = measure(' ', fontSize, weight);
  const lines: string[] = [];
  let line = '';
  /**
   * Width used on the current line, added up as `estimateLineCount` adds it up. Whether the line
   * holds a word is asked of the line itself: a word may measure nothing at all.
   */
  let used = 0;
  const push = () => {
    lines.push(line);
    line = '';
    used = 0;
  };
  for (const word of text.split(' ')) {
    if (word === '') continue;
    const wordWidth = measure(word, fontSize, weight);
    if (line !== '' && used + space + wordWidth <= width) {
      line += ` ${word}`;
      used += space + wordWidth;
      continue;
    }
    if (line !== '') push();
    if (wordWidth <= width) {
      line = word;
      used = wordWidth;
      continue;
    }
    for (const char of word) {
      const charWidth = measure(char, fontSize, weight);
      // By the width: what measures nothing at the start of a word stays with what follows it.
      if (used > 0 && used + charWidth > width) push();
      line += char;
      used += charWidth;
    }
  }
  if (line !== '' || lines.length === 0) push();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines));
  const last = kept.length - 1;
  // Whether or not the measure is exact: text was left out, so the line must say so.
  const cut = fitText(`${kept[last] ?? ''}${ELLIPSIS}`, width, fontSize, weight, measure);
  kept[last] = cut.endsWith(ELLIPSIS) ? cut : `${cut}${ELLIPSIS}`;
  return kept;
}
