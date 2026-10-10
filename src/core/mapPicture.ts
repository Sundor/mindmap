// The map as one SVG document, drawn from the flow the canvas is given: boxes, edges, labels,
// work items and the marks of the lenses, the selection and the focus. Pure: no DOM, no React.
//
// Presentation attributes only — no <style>, no style="", no script, no <image>, no <use>,
// no <marker>, no filter, no foreignObject, no address outside the document — so that the same
// text is a file of its own, an image a canvas may read back, and the picture of a page
// without script. The numbers below repeat rules of src/ui/styles.css and the components of
// src/ui/nodes.tsx, ArchEdge.tsx and WorkItemBlock.tsx: a change there is a change here
// (src/ui/pictureStyles.test.ts fails when a repeated value differs).

import type { SchemeColor } from './model';
import { COMPACT_GROUP, compactGroupText } from './compactGroup';
import {
  aggregateCountLabel,
  EDGE_LABEL,
  flowEdgeLabel,
  PLACED_BY_CONNECTIONS,
  Z_INDEX,
  type ArchFlowNode,
  type BandFlowNode,
  type FlowEdge,
  type FlowGraph,
} from './flow';
import { FADED_CLASS } from './focus';
import { HEADER_HEIGHT, UNASSIGNED_HEADER } from './layout/constants';
import type { Rect } from './layout/types';
import { EDGE_KINDS, NODE_LEVEL_NAMES, type EdgeKind } from './model';
import {
  colorHex,
  estimateMeasure,
  fitText,
  mixColors,
  parseColor,
  PICTURE_FONT_FAMILY,
  PICTURE_PALETTE,
  pictureNumber as num,
  wrapText,
  xmlElement as el,
  xmlText,
  type ColorScheme,
  type PicturePalette,
  type Rgba,
  type TextMeasure,
  type XmlAttributes,
} from './pictureKit';
import { curvePath, labelPoint, type Curve } from './route';
import { DIMMED_CLASS } from './selection';
import { plural } from './text';
import { WORK_ITEM_GEOMETRY, type WorkItemLine } from './workItemContent';
import { isOpenState, workItemCountsText, type WorkItemCounts } from './workItemOverlay';
import type { WorkItemType } from './workitems';
import { HEAT_STOPS, progressText } from './workload';

// --- What a picture is made from -----------------------------------------------------------------

/** The heat of a box: `NodeHeat`, and `inAll` where the box shows less than it holds. */
export interface PictureHeat {
  readonly open: number;
  readonly fraction: number;
  readonly inAll?: number | undefined;
}

/** The progress of a box: `NodeProgress`, and `inAll` where the box shows less than it holds. */
export interface PictureProgress {
  readonly done: number;
  readonly total: number;
  readonly inAll?: { readonly done: number; readonly total: number } | undefined;
}

/** The lenses as the canvas gets them (`NodeLenses` of src/ui/nodeLensContext.ts fits). */
export interface PictureLenses {
  readonly heat?: ReadonlyMap<string, PictureHeat> | undefined;
  readonly progress?: ReadonlyMap<string, PictureProgress> | undefined;
  readonly colors?: ReadonlyMap<string, SchemeColor> | undefined;
}

/** One entry of the key of "Colour by" (`LegendEntry` of src/core/colorBy.ts fits). */
export interface PictureLegendEntry {
  readonly label: string;
  readonly color: SchemeColor;
  /** `other`: the shared entry of the values without a colour of their own (set in italics). */
  readonly kind?: string | undefined;
  /** How many nodes carry the value: written after the label when given. */
  readonly count?: number | undefined;
}

/** What the key reads of a colouring (`NodeColoring` of src/core/colorBy.ts fits). */
export interface PictureColoring {
  readonly colorBy: string;
  /** What the key is headed with; without it the name of the metric, label or attribute. */
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly legend: readonly PictureLegendEntry[];
  /** For a metric: its range. The key is then a ramp between the first two entries. */
  readonly range?: { readonly min: number; readonly max: number } | undefined;
  /** How many nodes have no value and are not tinted: more than 0 adds the entry "No value". */
  readonly withoutValue?: number | undefined;
}

export interface MapPicture {
  /** The flow on the canvas, with the marks of the selection, the focus and edges on demand. */
  readonly flow: FlowGraph;
  readonly lenses?: PictureLenses | undefined;
  readonly scheme: ColorScheme;
  /**
   * The larger titles of the `domains` level seen from afar (`data-lod` and `data-zoom-lod` both
   * `domains`).
   */
  readonly largeTitles?: boolean | undefined;
  /**
   * The part of the canvas to draw, in canvas pixels; left out: everything drawn
   * ({@link drawnExtent}).
   */
  readonly extent?: Rect | undefined;
  /** `<title>` of the document. */
  readonly title: string;
  /** `<desc>` of the document: a text, or one made from what the picture turns out to hold. */
  readonly description: string | ((counts: PictureCounts) => string);
  /** Lines above the map. Left out: none. */
  readonly heading?: { readonly title: string; readonly note: string } | undefined;
  /** The key below the map. Left out: none. */
  readonly legend?: { readonly coloring?: PictureColoring | undefined } | undefined;
  /** The work item whose line is marked, and the item a selected task without a line is under. */
  readonly workItem?:
    | { readonly selectedId?: number | undefined; readonly parentId?: number | undefined }
    | undefined;
  /** Default: {@link estimateMeasure}. */
  readonly measure?: TextMeasure | undefined;
}

/** How many boxes (row bands are not counted) and edges a picture holds. */
export interface PictureCounts {
  readonly nodes: number;
  readonly edges: number;
}

export interface MapSvg {
  readonly svg: string;
  /** The description that was written into the document. */
  readonly description: string;
  /** Size of the picture in its own units (canvas pixels): `width` and `height` of the root. */
  readonly width: number;
  readonly height: number;
  /**
   * What is in the picture: the IDs of its boxes (row bands are not listed), of its edges and
   * of the edges whose label it shows, each in the order of the flow.
   */
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly labelIds: readonly string[];
}

/** Free room around everything drawn, in canvas pixels (`CANVAS_PADDING` of the layout). */
export const PICTURE_MARGIN = 24;

/** The `id` of the group of node `id`. Model IDs are lower-case letters, digits, `.`, `-`, `_`. */
export function nodeElementId(id: string): string {
  return `n.${id}`;
}

/**
 * The tooltip of a heat strip, as `LensMarks` of src/ui/nodes.tsx words it; with `inAll`, where
 * the box holds more open work than it shows, the total as well.
 */
export function heatStripTitle(heat: PictureHeat): string {
  const open = plural(heat.open, 'open work item');
  return heat.inAll === undefined || heat.inAll === heat.open
    ? `${open} in here`
    : `${open} here that no box inside shows (${heat.inAll} in here in all)`;
}

/**
 * The tooltip of a progress bar: `progressText` of what the box shows; with `inAll`, where the
 * box holds more work than it shows, the total as well.
 */
export function progressBarTitle(progress: PictureProgress): string {
  const own = progressText(progress);
  const all = progress.inAll;
  return all === undefined || all.total === progress.total
    ? own
    : `${own} of what no box inside shows (${all.done} of ${all.total} in here in all)`;
}

/** The heading of the key of a colouring: its title, else what it colours by, in words. */
export function coloringTitle(coloring: PictureColoring): string {
  let title = coloring.title?.trim() ?? '';
  if (title === '') {
    const at = coloring.colorBy.indexOf(':');
    const name = at < 0 ? coloring.colorBy : coloring.colorBy.slice(at + 1);
    title = at < 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
  }
  const subtitle = coloring.subtitle?.trim() ?? '';
  return subtitle === '' ? title : `${title} (${subtitle})`;
}

// --- Paint ---------------------------------------------------------------------------------------

/** An opacity or the offset of a gradient stop: three decimals (a picture number has two). */
const alpha = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error(`not a number in the picture: ${value}`);
  return String(Math.round(value * 1000) / 1000);
};

/** `fill` — and `fill-opacity` for a translucent colour — of `color`. */
function fill(color: string | Rgba): XmlAttributes {
  const c = typeof color === 'string' ? parseColor(color) : color;
  return c.a >= 1 ? { fill: colorHex(c) } : { fill: colorHex(c), 'fill-opacity': alpha(c.a) };
}

function stroke(color: string, width: number, dash?: string): XmlAttributes {
  const c = parseColor(color);
  return {
    stroke: colorHex(c),
    ...(c.a < 1 ? { 'stroke-opacity': alpha(c.a) } : {}),
    'stroke-width': width,
    ...(dash ? { 'stroke-dasharray': dash } : {}),
  };
}

/** Opacity of a box outside the neighbourhood of the selection, and of one the focus leaves out. */
export const NODE_OPACITY = { dimmed: 0.3, faded: 0.14 } as const;
/** The same for the line of an edge; its label has the opacity of a box. */
export const EDGE_OPACITY = { dimmed: 0.18, faded: 0.08 } as const;

function classes(className: string | undefined): readonly string[] {
  return className?.split(' ') ?? [];
}

function nodeOpacity(node: { className?: string }): number | undefined {
  const names = classes(node.className);
  // The later rule of the style sheet wins where both classes are set.
  if (names.includes(FADED_CLASS)) return NODE_OPACITY.faded;
  if (names.includes(DIMMED_CLASS)) return NODE_OPACITY.dimmed;
  return undefined;
}

// --- Text ----------------------------------------------------------------------------------------

/** From the middle of a line box down to the baseline, in em (the page's fonts: 0.35–0.41). */
const BASELINE_EM = 0.36;

interface TextStyle {
  readonly size: number;
  readonly weight?: number;
  readonly color: string;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly italic?: boolean;
  readonly opacity?: number;
  readonly strike?: boolean;
  /** Letter spacing in pixels. */
  readonly spacing?: number;
}

interface Ctx {
  readonly p: PicturePalette;
  readonly scheme: ColorScheme;
  readonly measure: TextMeasure;
  readonly largeTitles: boolean;
  readonly heatUsed: Set<number>;
  readonly selectedItem: number | undefined;
  readonly relatedItem: number | undefined;
  hatchUsed: boolean;
}

/** Width of `text` as it is written: its measure plus the letter spacing. */
function textWidth(ctx: Ctx, text: string, size: number, weight: number, spacing = 0): number {
  return ctx.measure(text, size, weight) + spacing * [...text].length;
}

/**
 * `text` on one line of `width`: cut with an ellipsis where the canvas cuts it, which only
 * real widths can tell (the estimate is an upper bound and would cut names that fit on screen).
 */
function oneLine(ctx: Ctx, text: string, width: number, size: number, weight: number): string {
  return ctx.measure.exact ? fitText(text, width, size, weight, ctx.measure) : text;
}

/** One line of text, its line box centred on `cy`. */
function textLine(ctx: Ctx, x: number, cy: number, text: string, style: TextStyle): string {
  if (text === '') return '';
  const weight = style.weight ?? 400;
  return el(
    'text',
    {
      x,
      y: cy + BASELINE_EM * style.size,
      'font-size': style.size,
      ...(weight !== 400 ? { 'font-weight': weight } : {}),
      ...(style.italic ? { 'font-style': 'italic' } : {}),
      ...(style.anchor && style.anchor !== 'start' ? { 'text-anchor': style.anchor } : {}),
      ...(style.spacing ? { 'letter-spacing': style.spacing } : {}),
      ...(style.strike ? { 'text-decoration': 'line-through' } : {}),
      ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
      ...(ctx.measure.exact
        ? { textLength: textWidth(ctx, text, style.size, weight, style.spacing) }
        : {}),
      ...fill(style.color),
    },
    xmlText(text),
  );
}

/** Lines of text `lineHeight` apart, the first line box starting at `top`. */
function textBlock(
  ctx: Ctx,
  x: number,
  top: number,
  lines: readonly string[],
  lineHeight: number,
  style: TextStyle,
): string {
  return lines
    .map((line, index) => textLine(ctx, x, top + (index + 0.5) * lineHeight, line, style))
    .join('');
}

// --- Work items ----------------------------------------------------------------------------------

/** The glyph of a work-item type (those of src/ui/WorkItemIcon.tsx, on a 16 × 16 grid). */
function icon(
  ctx: Ctx,
  type: WorkItemType,
  x: number,
  y: number,
  size: number,
  opacity?: number,
): string {
  const p = ctx.p;
  const line = (color: string, d: string, width = 1.2) =>
    el('path', {
      d,
      fill: 'none',
      stroke: color,
      'stroke-width': width,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
  let body: string;
  switch (type) {
    case 'User Story':
      body = el('path', {
        fill: p.wiStory,
        d: 'M7.4 3.7C6 2.8 3.9 2.5 1.5 2.8v9.5c2.4-.3 4.5 0 5.9.9zM8.6 3.7c1.4-.9 3.5-1.2 5.9-.9v9.5c-2.4-.3-4.5 0-5.9.9z',
      });
      break;
    case 'Task':
      body =
        el('path', {
          fill: p.wiTask,
          d: 'M5.4 2.6H3.6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-10a1 1 0 0 0-1-1h-1.8v.9a.9.9 0 0 1-.9.9H6.3a.9.9 0 0 1-.9-.9z',
        }) +
        el('rect', { x: 6.4, y: 1, width: 3.2, height: 2.4, rx: 0.7, fill: p.wiTask }) +
        line(p.wiTaskMark, 'M5.4 9.5l1.8 1.8 3.5-3.8', 1.5);
      break;
    case 'Bug':
      body =
        el('circle', { cx: 8, cy: 4.1, r: 1.9, fill: p.wiBug }) +
        el('ellipse', { cx: 8, cy: 10.1, rx: 3.2, ry: 4.1, fill: p.wiBug }) +
        line(
          p.wiBug,
          'M5 8.3 2.5 6.9M4.8 10.4H2M5.1 12.4l-2.4 1.5M11 8.3l2.5-1.4M11.2 10.4H14M10.9 12.4l2.4 1.5',
        );
      break;
    case 'Feature':
      body =
        el('path', {
          fill: p.wiFeature,
          d: 'M4.6 2h6.8v4.3a3.4 3.4 0 0 1-6.8 0zM7.3 9.3h1.4v2.2H7.3zM5 11.6h6V14H5z',
        }) +
        line(
          p.wiFeature,
          'M4.4 3.3H2.7v1a2.2 2.2 0 0 0 2.2 2.2M11.6 3.3h1.7v1a2.2 2.2 0 0 1-2.2 2.2',
        );
      break;
    case 'Epic':
      body = el('path', {
        fill: p.wiEpic,
        d: 'M1.7 4.6 5 7.5l3-4.9 3 4.9 3.3-2.9-1.1 6.6H2.8zM2.9 12.3h10.2V14H2.9z',
      });
      break;
  }
  return el(
    'g',
    {
      transform: `translate(${num(x)} ${num(y)}) scale(${num(size / 16)})`,
      ...(opacity !== undefined ? { opacity } : {}),
    },
    body,
  );
}

/**
 * The badge with the counts: its middle (or, with `right`, its right end) at `at`, centred on
 * `cy`.
 */
function badge(
  ctx: Ctx,
  counts: WorkItemCounts,
  at: number,
  cy: number,
  scale = 1,
  right = false,
): string {
  const g = WORK_ITEM_GEOMETRY;
  const size = g.badgeFontSize * scale;
  const iconSize = 1.2 * size;
  const parts: { type: WorkItemType; text: string }[] = [
    { type: 'User Story', text: String(counts.stories) },
  ];
  if (counts.openBugs > 0) parts.push({ type: 'Bug', text: String(counts.openBugs) });
  const widths = parts.map((part) => iconSize + 4 * scale + ctx.measure(part.text, size, 600));
  const width = 2 + 16 * scale + widths.reduce((a, b) => a + b, 0) + 8 * scale * (parts.length - 1);
  const height = g.badgeHeight * scale;
  const cx = right ? at - width / 2 : at;
  let x = cx - width / 2 + 1 + 8 * scale;
  let out = el('rect', {
    x: cx - width / 2 + 0.5,
    y: cy - height / 2 + 0.5,
    width: width - 1,
    height: height - 1,
    rx: (height - 1) / 2,
    ...fill(ctx.p.leafBg),
    ...stroke(ctx.p.leafBorder, 1),
  });
  parts.forEach((part, index) => {
    out += icon(ctx, part.type, x, cy - iconSize / 2, iconSize);
    out += textLine(ctx, x + iconSize + 4 * scale, cy, part.text, {
      size,
      weight: 600,
      color: ctx.p.leafFg,
    });
    x += (widths[index] ?? 0) + 8 * scale;
  });
  return el(
    'g',
    { 'data-part': 'badge' },
    el('title', {}, xmlText(workItemCountsText(counts))) + out,
  );
}

/** The lines of a work-item list drawn in `rect`. */
function workItemList(ctx: Ctx, rect: Rect, lines: readonly WorkItemLine[]): string {
  const g = WORK_ITEM_GEOMETRY;
  const room = Math.max(0, rect.width - 2 * g.paddingX);
  let out = '';
  lines.forEach((line, index) => {
    const top = rect.y + g.paddingTop + index * g.lineHeight;
    const cy = top + g.lineHeight / 2;
    const x = rect.x + g.paddingX;
    if (line.kind === 'more') {
      out += textLine(ctx, x, cy, oneLine(ctx, line.text, room, g.taskFontSize, 400), {
        size: g.taskFontSize,
        color: ctx.p.muted,
        italic: true,
      });
      return;
    }
    const closed = !isOpenState(line.item.state);
    const indent = line.kind === 'task' ? g.taskIndent : 0;
    const size = line.kind === 'task' ? g.taskFontSize : g.fontSize;
    const textX = x + indent + g.iconSize + g.iconGap;
    // An item shows as much of its title as the list has room for; a task its first words.
    const shown = line.kind === 'item' ? line.item.title : line.text;
    const textRoom = Math.max(0, room - indent - g.iconSize - g.iconGap);
    // Titles are longer than their room as a rule: cut by whatever measure there is.
    const text = fitText(shown, textRoom, size, 400, ctx.measure);
    const selected = ctx.selectedItem === line.item.id;
    const related = !selected && ctx.relatedItem === line.item.id;
    let mark = '';
    if (selected || related) {
      // The highlight reaches 4 px beyond the line on both sides, into the padding of the block.
      mark = el('rect', {
        x: x - 4,
        y: top,
        width: room + 8,
        height: g.lineHeight,
        rx: 3,
        ...fill(selected ? ctx.p.wiSelected : ctx.p.wiHover),
      });
      if (selected) {
        mark += el('rect', {
          x,
          y: top + g.lineHeight - 2,
          width: room,
          height: 2,
          ...fill(ctx.p.nodeSelected),
        });
      }
    }
    out += el(
      'g',
      { 'data-workitem': String(line.item.id), ...(selected ? { 'data-selected': 'true' } : {}) },
      el(
        'title',
        {},
        xmlText(`${line.item.type} #${line.item.id} · ${line.item.state}\n${line.item.title}`),
      ) +
        mark +
        icon(
          ctx,
          line.item.type,
          x + indent,
          cy - g.iconSize / 2,
          g.iconSize,
          closed ? PICTURE_STYLE.closedItem.icon : undefined,
        ) +
        textLine(ctx, textX, cy, text, {
          size,
          color: ctx.p.leafFg,
          ...(closed ? { strike: true, opacity: PICTURE_STYLE.closedItem.text } : {}),
        }),
    );
  });
  return out;
}

// --- Lenses on a box -----------------------------------------------------------------------------

const HEAT_COLORS = HEAT_STOPS.map(parseColor);

/** Colour of the heat gradient at `t` (0 at the bottom of the box, 1 at its top). */
function heatColorAt(t: number): Rgba {
  const scaled = Math.max(0, Math.min(1, t)) * (HEAT_COLORS.length - 1);
  const index = Math.min(HEAT_COLORS.length - 2, Math.floor(scaled));
  const a = HEAT_COLORS[index];
  const b = HEAT_COLORS[index + 1];
  if (!a || !b) throw new Error('the heat gradient needs two stops');
  return mixColors(b, scaled - index, a);
}

/**
 * The share of the inside of its box a strip is tall for a heat fraction (`--heat` in
 * src/ui/nodes.tsx): 0.08–1.
 */
export function heatShare(fraction: number): number {
  return Math.max(0.08, Math.min(1, fraction));
}

/**
 * That share as a whole percent, 8–100: the gradient a strip is filled with (one definition per
 * percent).
 */
export function heatPercent(fraction: number): number {
  return Math.round(heatShare(fraction) * 100);
}

/**
 * The gradient of a strip `percent` % of its box tall: the part of the full gradient (laid over
 * the whole height of the box) below that height. One definition per percent in use.
 */
function heatGradient(percent: number): string {
  const share = percent / 100;
  const last = HEAT_STOPS.length - 1;
  let stops = '';
  for (let k = 0; k <= last; k++) {
    const at = k / last;
    if (at >= share) break;
    stops += el('stop', { offset: alpha(at / share), 'stop-color': colorHex(heatColorAt(at)) });
  }
  stops += el('stop', { offset: 1, 'stop-color': colorHex(heatColorAt(share)) });
  return el('linearGradient', { id: `am-heat-${percent}`, x1: 0, y1: 1, x2: 0, y2: 0 }, stops);
}

function lensMarks(
  ctx: Ctx,
  id: string,
  w: number,
  h: number,
  border: number,
  lenses: PictureLenses,
): string {
  let out = '';
  const heat = lenses.heat?.get(id);
  if (heat) {
    const percent = heatPercent(heat.fraction);
    ctx.heatUsed.add(percent);
    // As tall as the canvas draws it (`--heat`); only the gradient goes by the whole percent.
    const height = (h - 2 * border) * heatShare(heat.fraction);
    const y = h - border - height;
    const title = el('title', {}, xmlText(heatStripTitle(heat)));
    const glow = parseColor(ctx.p.heatGlow);
    (['left', 'right'] as const).forEach((side) => {
      const x = side === 'left' ? border - 1 : w - border + 1 - PICTURE_STYLE.heat.width;
      out += el(
        'g',
        { 'data-part': 'heat', 'data-side': side, 'data-heat': heat.open },
        title +
          // The glow of the strip, without a filter: a wider, translucent strip behind it.
          el('rect', {
            x: x - 3,
            y: y - 3,
            width: PICTURE_STYLE.heat.width + 6,
            height: height + 6,
            rx: 5,
            fill: colorHex(glow),
            'fill-opacity': alpha(glow.a / 2),
          }) +
          el('rect', {
            x,
            y,
            width: PICTURE_STYLE.heat.width,
            height,
            rx: 2,
            fill: `url(#am-heat-${percent})`,
          }),
      );
    });
  }
  const progress = lenses.progress?.get(id);
  if (progress) {
    const done = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
    const bar = PICTURE_STYLE.progress;
    const x = border + bar.inset;
    const y = h - border + 1 - bar.height;
    const width = Math.max(0, w - 2 * border - 2 * bar.inset);
    out += el(
      'g',
      { 'data-part': 'progress', 'data-done': progress.done, 'data-total': progress.total },
      el('title', {}, xmlText(progressBarTitle(progress))) +
        el('rect', {
          x,
          y,
          width,
          height: bar.height,
          rx: bar.height / 2,
          fill: colorHex(parseColor(ctx.p.fg)),
          'fill-opacity': bar.track,
        }) +
        (done > 0
          ? el('rect', {
              x,
              y,
              width: width * done,
              height: bar.height,
              rx: bar.height / 2,
              ...fill(ctx.p.progressDone),
            })
          : ''),
    );
  }
  return out;
}

// --- Boxes ---------------------------------------------------------------------------------------

/** A rectangle whose two upper corners are rounded with `r`. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const q = Math.max(0, Math.min(r, w / 2, h));
  return `M${num(x)} ${num(y + h)}V${num(y + q)}Q${num(x)} ${num(y)} ${num(x + q)} ${num(y)}H${num(x + w - q)}Q${num(x + w)} ${num(y)} ${num(x + w)} ${num(y + q)}V${num(y + h)}Z`;
}

/** The chevron of a group: a 22 px button at `x`, the glyph in its middle (turned when closed). */
function chevron(
  x: number,
  cy: number,
  color: string,
  collapsed: boolean,
  disabled: boolean,
): string {
  return el('path', {
    d: 'M-3.6 -1.8L0 1.8L3.6 -1.8',
    transform: `translate(${num(x + 11)} ${num(cy)})${collapsed ? ' rotate(-90)' : ''}`,
    fill: 'none',
    stroke: colorHex(parseColor(color)),
    'stroke-width': 2.16,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    ...(disabled ? { opacity: PICTURE_STYLE.chevron.disabledOpacity } : {}),
  });
}

/** What a closed group says it contains, e.g. "3 components · 7 subcomponents". */
function contentSummary(node: ArchFlowNode): string {
  const { children, descendants } = node.data.counts;
  const parts = [plural(children, NODE_LEVEL_NAMES[node.data.level + 1] ?? 'node')];
  if (descendants > children) {
    parts.push(plural(descendants - children, NODE_LEVEL_NAMES[node.data.level + 2] ?? 'node'));
  }
  return parts.join(' · ');
}

/**
 * The numbers a picture repeats from the rules of src/ui/styles.css (the selector is named with
 * each). `src/ui/pictureStyles.test.ts` reads the style sheet and fails when one of them differs.
 */
export const PICTURE_STYLE = {
  /** `.arch-node`: `border-radius`. */
  radius: 8,
  /**
   * `.arch-leaf`, `.arch-leaf.arch-level-*`: `font-size` and `font-weight` of a leaf's name, by
   * level.
   */
  leafFont: [
    { size: 18, weight: 600 },
    { size: 16, weight: 500 },
    { size: 15, weight: 400 },
  ],
  /** `.arch-leaf`: `padding` left and right. */
  leafPaddingX: 12,
  /** `.arch-group.arch-level-* > .arch-group-header`: `font-size` of a group's title, by level. */
  headerFontSize: [19, 17],
  /** `.arch-group-header`: `font-weight`, `padding` left and right, `gap`. */
  headerWeight: 600,
  headerPaddingX: 12,
  headerGap: 8,
  /** `.arch-chevron`: `width`, `margin-left` (negative); `:disabled`: `opacity`. */
  chevron: { size: 22, pull: 4, disabledOpacity: 0.45 },
  /** `.arch-level-tag`: `font-size`, `font-weight`, `letter-spacing` in em, `opacity`. */
  levelTag: { size: 10, weight: 500, spacing: 0.05, opacity: 0.7 },
  /**
   * `.arch-group.arch-level-domain`: `border` width; `.arch-group.arch-collapsed`:
   * `border-width`.
   */
  domainBorder: 2,
  closedBorder: 4,
  /** `.arch-collapsed-body`: `font-size`, `font-weight`. */
  closedBody: { size: 16, weight: 500 },
  /**
   * `.arch-group.arch-collapsed`: the `repeating-linear-gradient` of its `background` — the width
   * of a stripe, the distance from one to the next, and `turn`: the pattern's rotation that
   * draws the stripes the way `135deg` does (from the lower left to the upper right).
   */
  hatch: { stripe: 2, every: 12, turn: 45 },
  /**
   * The rules under `.app[data-lod='domains'][data-zoom-lod='domains']`: `font-size`,
   * `line-height` times the size and `line-clamp` of a domain's name; the `padding-top` of its
   * header; the `font-size` of its body, of a row name and of the Unassigned title;
   * `--badge-scale`.
   */
  largeTitle: {
    size: 28,
    line: 35,
    maxLines: 2,
    padding: 6,
    body: 22,
    band: 20,
    unassigned: 22,
    badge: 1.4,
  },
  /** `.arch-band-gutter`: `font-size`; `.arch-band-title`: `font-size`. */
  band: { size: 15, unassigned: 14 },
  /**
   * `.arch-tinted::before`: `height`; the `color-mix` shares of the three `.arch-tinted`
   * backgrounds; and `closedText`: the share of `--fg` mixed into `--muted` for the summary of a
   * closed, tinted group (`.arch-group.arch-collapsed.arch-tinted .arch-collapsed-body`).
   */
  tint: { stripe: 6, leaf: 0.14, group: 0.1, closed: 0.14, closedText: 0.5 },
  /** `.arch-heat`: `width`. */
  heat: { width: 5 },
  /** `.arch-progress`: `height`, `left`, and the share of `--fg` in its `background`. */
  progress: { height: 5, inset: 6, track: 0.14 },
  /** `.react-flow__node.selected > .arch-node`: `outline` width and `outline-offset`. */
  selected: { width: 2, offset: 1 },
  /**
   * `.arch-edge-label`: `line-height`, `padding` left and right; `.arch-edge-label-count`: the
   * same, and `font-weight`.
   */
  label: { line: 1.3, paddingX: 6, countPaddingX: 7, countWeight: 700 },
  /**
   * `.arch-workitem-closed .arch-workitem-text`: `opacity`; `.arch-workitem-closed .wi-icon`:
   * `opacity`.
   */
  closedItem: { text: 0.6, icon: 0.55 },
} as const;

const LEAF_FONT = PICTURE_STYLE.leafFont;
const HEADER_FONT_SIZE = PICTURE_STYLE.headerFontSize;
const LARGE_TITLE = PICTURE_STYLE.largeTitle;

function drawNode(ctx: Ctx, node: ArchFlowNode, at: Rect, lenses: PictureLenses): string {
  const p = ctx.p;
  const { data } = node;
  const w = at.width;
  const h = at.height;
  const isGroup = node.type === 'group';
  const domain = data.level === 0;
  const placed = data.placedRowName !== undefined;
  const closed = isGroup && data.collapsed;
  const large = ctx.largeTitles && domain && !data.compact;
  const tint = lenses.colors?.get(node.id)?.[ctx.scheme];
  const borderColor = domain ? p.domainBorder : data.level === 1 ? p.componentBorder : p.leafBorder;
  const border = closed
    ? placed
      ? 2
      : PICTURE_STYLE.closedBorder
    : domain
      ? PICTURE_STYLE.domainBorder
      : 1;
  let background: Rgba;
  if (!isGroup) background = parseColor(p.leafBg);
  else if (closed) background = parseColor(p.collapsedBg);
  else background = parseColor(domain ? p.domainBg : p.componentBg);
  if (tint) {
    const t = PICTURE_STYLE.tint;
    background = mixColors(
      parseColor(tint),
      !isGroup ? t.leaf : closed ? t.closed : t.group,
      background,
    );
  }

  let out = '';
  const tip = [
    data.description,
    placed ? `${PLACED_BY_CONNECTIONS} (${data.placedRowName})` : undefined,
  ].filter((part) => part !== undefined);
  if (tip.length > 0) out += el('title', {}, xmlText(tip.join('\n')));

  // The box: its background, the hatch of a closed group, then the border on top.
  out += el('rect', {
    'data-part': 'box',
    width: w,
    height: h,
    rx: PICTURE_STYLE.radius,
    ...fill(background),
  });
  if (closed) {
    ctx.hatchUsed = true;
    // The stripes start at the inside of the border, as the gradient of the style sheet does
    // (its box is the padding box): the pattern is laid from the origin of this rectangle.
    out += el('rect', {
      'data-part': 'hatch',
      transform: `translate(${num(border)} ${num(border)})`,
      x: -border,
      y: -border,
      width: w,
      height: h,
      rx: PICTURE_STYLE.radius,
      fill: 'url(#am-hatch)',
    });
  }
  if (closed && !placed) {
    // `border: 4px double`: two lines of a third of the width each.
    const line = 4 / 3;
    for (const inset of [line / 2, 4 - line / 2]) {
      out += el('rect', {
        x: inset,
        y: inset,
        width: w - 2 * inset,
        height: h - 2 * inset,
        rx: Math.max(0, 8 - inset),
        fill: 'none',
        ...stroke(borderColor, line),
      });
    }
  } else {
    out += el('rect', {
      x: border / 2,
      y: border / 2,
      width: w - border,
      height: h - border,
      rx: 8 - border / 2,
      fill: 'none',
      ...stroke(borderColor, border, placed ? `${3 * border} ${2 * border}` : undefined),
    });
  }

  if (isGroup) {
    const headerBg = domain ? p.domainHeaderBg : p.componentHeaderBg;
    const headerFg = domain ? p.domainHeaderFg : p.componentHeaderFg;
    const inner = w - 2 * border;
    // The summary of a closed group: secondary text, nearer to the text colour on a tinted box.
    const bodyColor =
      tint && PICTURE_STYLE.tint.closedText > 0
        ? colorHex(mixColors(parseColor(p.fg), PICTURE_STYLE.tint.closedText, parseColor(p.muted)))
        : p.muted;
    // A group closed only by the level of detail has no toggle: its chevron is paler.
    const disabled = data.collapsed && !data.manuallyCollapsed;
    if (data.compact) {
      const c = COMPACT_GROUP;
      const nameLines = wrapText(
        data.name,
        Math.max(1, inner - 2 * c.paddingX - c.chevron),
        c.nameSize,
        700,
        ctx.measure,
      );
      const headerHeight = c.headerTop + nameLines.length * c.nameLine + c.headerBottom;
      out += el('path', {
        'data-part': 'header',
        d: topRounded(border, border, inner, headerHeight, 3),
        ...fill(headerBg),
      });
      out += chevron(
        border + c.paddingX - 4,
        border + c.headerTop + c.nameLine / 2,
        headerFg,
        true,
        disabled,
      );
      out += textBlock(
        ctx,
        border + c.paddingX + c.chevron,
        border + c.headerTop,
        nameLines,
        c.nameLine,
        { size: c.nameSize, weight: 700, color: headerFg },
      );
      const listLines = wrapText(
        compactGroupText(data.childNames, data.compactHidden),
        Math.max(1, inner - 2 * c.paddingX),
        c.textSize,
        500,
        ctx.measure,
      );
      const bodyTop = border + headerHeight + c.bodyTop;
      out += textBlock(ctx, w / 2, bodyTop, listLines, c.textLine, {
        size: c.textSize,
        weight: 500,
        color: bodyColor,
        anchor: 'middle',
      });
      if (data.badge) {
        const cy = bodyTop + listLines.length * c.textLine + 6 + WORK_ITEM_GEOMETRY.badgeHeight / 2;
        out += badge(ctx, data.badge, w / 2, cy);
      }
    } else {
      const nameSize = large ? LARGE_TITLE.size : HEADER_FONT_SIZE[domain ? 0 : 1];
      const tagStyle = PICTURE_STYLE.levelTag;
      const tagSpacing = tagStyle.spacing * tagStyle.size;
      const chevronX = border + PICTURE_STYLE.headerPaddingX - PICTURE_STYLE.chevron.pull;
      // Header padding 12, the chevron (22 wide, pulled 4 to the left), a gap of 8.
      const nameX = chevronX + PICTURE_STYLE.chevron.size + PICTURE_STYLE.headerGap;
      const tag = large ? '' : data.levelName.toUpperCase();
      const tagWidth =
        tag === ''
          ? 0
          : textWidth(ctx, tag, tagStyle.size, tagStyle.weight, tagSpacing) +
            PICTURE_STYLE.headerGap;
      const nameRoom = Math.max(0, w - border - PICTURE_STYLE.headerPaddingX - tagWidth - nameX);
      const nameLines = large
        ? wrapText(
            data.name,
            Math.max(1, nameRoom),
            nameSize,
            600,
            ctx.measure,
            LARGE_TITLE.maxLines,
          )
        : [oneLine(ctx, data.name, nameRoom, nameSize, 600)];
      const lineHeight = large ? LARGE_TITLE.line : HEADER_HEIGHT;
      const headerHeight = large
        ? Math.max(HEADER_HEIGHT, nameLines.length * lineHeight + 2 * LARGE_TITLE.padding)
        : HEADER_HEIGHT;
      out += el('path', {
        'data-part': 'header',
        d: topRounded(border, border, inner, headerHeight, data.collapsed ? 3 : 6),
        ...fill(headerBg),
      });
      out += chevron(chevronX, border + headerHeight / 2, headerFg, data.collapsed, disabled);
      out += textBlock(
        ctx,
        nameX,
        border + (headerHeight - nameLines.length * lineHeight) / 2,
        nameLines,
        lineHeight,
        { size: nameSize, weight: 600, color: headerFg },
      );
      if (tag !== '') {
        out += textLine(
          ctx,
          w - border - PICTURE_STYLE.headerPaddingX,
          border + headerHeight / 2,
          tag,
          {
            size: tagStyle.size,
            weight: tagStyle.weight,
            color: headerFg,
            anchor: 'end',
            spacing: tagSpacing,
            opacity: tagStyle.opacity,
          },
        );
      }
      if (data.collapsed) {
        const bodyTop = border + headerHeight;
        const bodyHeight = h - border - bodyTop;
        const size = large ? LARGE_TITLE.body : PICTURE_STYLE.closedBody.size;
        const scale = large ? LARGE_TITLE.badge : 1;
        const badgeHeight = data.badge ? WORK_ITEM_GEOMETRY.badgeHeight * scale + 4 : 0;
        // The canvas wraps a summary that is wider than the body; only real widths can tell
        // (the estimate is an upper bound and would break lines the screen does not break).
        const summary = contentSummary(node);
        const summaryLines = ctx.measure.exact
          ? wrapText(summary, Math.max(1, inner - 20), size, 500, ctx.measure)
          : [summary];
        const textHeight = summaryLines.length * size * 1.2;
        const top = bodyTop + (bodyHeight - textHeight - badgeHeight) / 2;
        out += textBlock(ctx, w / 2, top, summaryLines, size * 1.2, {
          size,
          weight: 500,
          color: bodyColor,
          anchor: 'middle',
        });
        if (data.badge) {
          out += badge(ctx, data.badge, w / 2, top + textHeight + 4 + (badgeHeight - 4) / 2, scale);
        }
      }
    }
  } else {
    const reserved = data.contentRect?.height ?? 0;
    const room = Math.max(0, w - 2 * border - 2 * PICTURE_STYLE.leafPaddingX);
    const cy = border + (h - 2 * border - reserved) / 2;
    if (large) {
      // A domain without children at the `domains` level: the larger title, on two lines at most.
      const lines = wrapText(data.name, Math.max(1, room), LARGE_TITLE.size, 600, ctx.measure, 2);
      out += textBlock(
        ctx,
        w / 2,
        cy - (lines.length * LARGE_TITLE.line) / 2,
        lines,
        LARGE_TITLE.line,
        {
          size: LARGE_TITLE.size,
          weight: 600,
          color: p.leafFg,
          anchor: 'middle',
        },
      );
    } else {
      const font = LEAF_FONT[data.level] ?? LEAF_FONT[2];
      out += textLine(ctx, w / 2, cy, oneLine(ctx, data.name, room, font.size, font.weight), {
        size: font.size,
        weight: font.weight,
        color: p.leafFg,
        anchor: 'middle',
      });
    }
  }

  // Colour by: the stripe along the top, one pixel outside the inside of the border.
  if (tint) {
    out += el('path', {
      'data-part': 'tint',
      d: topRounded(
        border - 1,
        border - 1,
        w - 2 * (border - 1),
        PICTURE_STYLE.tint.stripe,
        PICTURE_STYLE.radius,
      ),
      fill: colorHex(parseColor(tint)),
    });
  }
  out += lensMarks(ctx, node.id, w, h, border, lenses);

  // Work items of a leaf or an open group: the lines (those of an open group are drawn above
  // the edges, by the caller), or the badge where the lines are not drawn.
  const block = data.contentRect;
  if (!block) {
    if (data.badge && !data.collapsed) out += badge(ctx, data.badge, w - 10, 0, 1, true);
  } else if (data.workItems) {
    if (!data.workItems.above) out += workItemList(ctx, block, data.workItems.lines);
  } else if (data.badge && !data.collapsed) {
    out += badge(
      ctx,
      data.badge,
      block.x + block.width / 2,
      block.y + block.height / 2,
      large ? LARGE_TITLE.badge : 1,
    );
  }

  if (node.selected) {
    const ring = PICTURE_STYLE.selected.offset + PICTURE_STYLE.selected.width / 2;
    out += el('rect', {
      'data-part': 'selected',
      // The middle of the outline: its offset and half its width outside the box.
      x: -ring,
      y: -ring,
      width: w + 2 * ring,
      height: h + 2 * ring,
      rx: PICTURE_STYLE.radius + ring,
      fill: 'none',
      ...stroke(p.nodeSelected, PICTURE_STYLE.selected.width),
    });
  }
  const opacity = nodeOpacity(node);
  return el(
    'g',
    {
      id: nodeElementId(node.id),
      'data-node': node.id,
      'data-level': data.levelName,
      transform: `translate(${num(at.x)} ${num(at.y)})`,
      ...(opacity !== undefined ? { opacity } : {}),
    },
    out,
  );
}

/** The list of an open group, on a background of its own above the edges. */
function drawList(
  ctx: Ctx,
  node: ArchFlowNode,
  list: Rect,
  lines: readonly WorkItemLine[],
): string {
  // As on the canvas (`GroupWorkItemLists`): dimmed with its group; the focus does not pale it.
  const dimmed = classes(node.className).includes(DIMMED_CLASS);
  return el(
    'g',
    { 'data-list': node.id, ...(dimmed ? { opacity: NODE_OPACITY.dimmed } : {}) },
    el('rect', {
      x: list.x - 0.5,
      y: list.y - 0.5,
      width: list.width + 1,
      height: list.height + 1,
      rx: 4.5,
      ...fill(ctx.p.leafBg),
      ...stroke(ctx.p.componentBorder, 1),
    }) + workItemList(ctx, list, lines),
  );
}

function bandRect(band: BandFlowNode): Rect {
  return { x: band.position.x, y: band.position.y, width: band.width, height: band.height };
}

function drawBand(ctx: Ctx, node: BandFlowNode): string {
  const p = ctx.p;
  const { width, height, data } = node;
  const attributes = {
    'data-band': node.id,
    transform: `translate(${num(node.position.x)} ${num(node.position.y)})`,
  };
  if (data.variant === 'unassigned') {
    const size = ctx.largeTitles ? LARGE_TITLE.unassigned : PICTURE_STYLE.band.unassigned;
    return el(
      'g',
      attributes,
      el('rect', {
        x: 0.5,
        y: 0.5,
        width: width - 1,
        height: height - 1,
        rx: 7.5,
        ...fill(p.unassignedBg),
        ...stroke(p.unassignedLine, 1, '3 2'),
      }) +
        textLine(ctx, 13, 1 + UNASSIGNED_HEADER / 2, data.name.toUpperCase(), {
          size,
          weight: 600,
          color: p.muted,
          spacing: 0.04 * size,
        }),
    );
  }
  const size = ctx.largeTitles ? LARGE_TITLE.band : PICTURE_STYLE.band.size;
  const lineHeight = size * 1.2;
  const lines = wrapText(data.name, Math.max(1, data.gutterWidth - 25), size, 600, ctx.measure);
  const line = (y: number) =>
    el('line', { x1: 0, y1: y, x2: width, y2: y, ...stroke(p.bandLine, 1) });
  return el(
    'g',
    attributes,
    el('rect', { width, height, ...fill(data.index % 2 === 0 ? p.bandEven : p.bandOdd) }) +
      el('rect', {
        y: 1,
        width: data.gutterWidth,
        height: Math.max(0, height - 2),
        ...fill(p.bandGutter),
      }) +
      line(0.5) +
      line(height - 0.5) +
      el('line', {
        x1: data.gutterWidth - 0.5,
        y1: 1,
        x2: data.gutterWidth - 0.5,
        y2: height - 1,
        ...stroke(p.bandLine, 1),
      }) +
      textBlock(
        ctx,
        data.gutterWidth / 2,
        (height - lines.length * lineHeight) / 2,
        lines,
        lineHeight,
        { size, weight: 600, color: p.bandLabel, anchor: 'middle' },
      ),
  );
}

// --- Edges ---------------------------------------------------------------------------------------

function edgeColor(p: PicturePalette, kind: EdgeKind): string {
  return {
    dataflow: p.edgeDataflow,
    dependency: p.edgeDependency,
    control: p.edgeControl,
    config: p.edgeConfig,
  }[kind];
}

/** Width, dashes and caps of the line of an edge (`.react-flow__edge` rules). */
export function edgeLineStyle(
  kind: EdgeKind,
  aggregate: boolean,
  selected: boolean,
): { readonly width: number; readonly dash?: string; readonly cap?: 'round' } {
  let width: number;
  if (aggregate) width = selected ? 4.5 : 3;
  else if (kind === 'config') width = selected ? 2.2 : 1.1;
  else width = selected ? 3 : 1.75;
  const dash = { dataflow: undefined, dependency: '7 4', control: '1.5 4', config: '8 3 1.5 3' }[
    kind
  ];
  return {
    width,
    ...(dash ? { dash } : {}),
    ...(kind === 'control' ? { cap: 'round' as const } : {}),
  };
}

function edgeLine(kind: EdgeKind, aggregate: boolean, selected: boolean): XmlAttributes {
  const style = edgeLineStyle(kind, aggregate, selected);
  return {
    'stroke-width': style.width,
    ...(style.dash ? { 'stroke-dasharray': style.dash } : {}),
    ...(style.cap ? { 'stroke-linecap': style.cap } : {}),
  };
}

function finiteCurve(curve: Curve, id: string): void {
  for (const point of [curve.p0, curve.c1, curve.c2, curve.p3]) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(`the curve of edge ${id} is not a number`);
    }
  }
}

/** The arrowhead: 11 long and 9.9 wide, its tip on the end of the line, the way it arrives. */
function arrowHead(curve: Curve): string {
  const { p0, c1, c2, p3 } = curve;
  let from = c2;
  if (from.x === p3.x && from.y === p3.y) from = c1;
  if (from.x === p3.x && from.y === p3.y) from = p0;
  const length = Math.hypot(p3.x - from.x, p3.y - from.y);
  const ux = length > 0 ? (p3.x - from.x) / length : 1;
  const uy = length > 0 ? (p3.y - from.y) / length : 0;
  const back = { x: p3.x - 11 * ux, y: p3.y - 11 * uy };
  return `M${num(p3.x)} ${num(p3.y)}L${num(back.x - 4.95 * uy)} ${num(back.y + 4.95 * ux)}L${num(back.x + 4.95 * uy)} ${num(back.y - 4.95 * ux)}Z`;
}

function drawEdge(ctx: Ctx, edge: FlowEdge): string {
  const { curve, kind, count } = edge.data;
  finiteCurve(curve, edge.id);
  const color = colorHex(parseColor(edgeColor(ctx.p, kind)));
  const text = flowEdgeLabel(edge.data);
  const hidden = edge.data.labelHidden === true && text !== undefined;
  const tip = [
    hidden
      ? count > 1 && text === aggregateCountLabel(count)
        ? `${count} ${kind} edges`
        : text
      : undefined,
    edge.data.description,
  ].filter((part) => part !== undefined);
  const names = classes(edge.className);
  const opacity = names.includes(FADED_CLASS)
    ? EDGE_OPACITY.faded
    : names.includes(DIMMED_CLASS)
      ? EDGE_OPACITY.dimmed
      : undefined;
  return el(
    'g',
    {
      'data-edge': edge.id,
      'data-kind': kind,
      ...(count > 1 ? { 'data-count': count } : {}),
      ...(opacity !== undefined ? { opacity } : {}),
    },
    (tip.length > 0 ? el('title', {}, xmlText(tip.join('\n'))) : '') +
      el('path', {
        'data-part': 'line',
        // The path of the canvas, as it writes it.
        d: curvePath(curve),
        fill: 'none',
        stroke: color,
        ...edgeLine(kind, count > 1, edge.selected === true),
      }) +
      el('path', { 'data-part': 'head', d: arrowHead(curve), fill: color }),
  );
}

interface LabelBox {
  readonly rect: Rect;
  readonly lines: readonly string[];
  readonly count: boolean;
}

/** The label an edge draws and its box in canvas pixels; undefined when it draws none. */
function labelBox(edge: FlowEdge, measure: TextMeasure): LabelBox | undefined {
  const { data } = edge;
  const text = flowEdgeLabel(data);
  if (text === undefined || data.labelHidden === true || data.quiet === true) return undefined;
  const lines = (data.labelText ?? text).split('\n');
  const count = data.count > 1 && text === aggregateCountLabel(data.count);
  const weight = count ? PICTURE_STYLE.label.countWeight : 400;
  // The padding and a border of 1 px on each side; lines `label.line` em apart.
  const padX = (count ? PICTURE_STYLE.label.countPaddingX : PICTURE_STYLE.label.paddingX) + 1;
  const width =
    Math.max(0, ...lines.map((line) => measure(line, EDGE_LABEL.fontSize, weight))) + 2 * padX;
  const height = lines.length * EDGE_LABEL.fontSize * PICTURE_STYLE.label.line + 4;
  const at = labelPoint(data.curve, data.route.labelT);
  return { rect: { x: at.x - width / 2, y: at.y - height / 2, width, height }, lines, count };
}

function drawEdgeLabel(ctx: Ctx, edge: FlowEdge, box: LabelBox): string {
  const { data } = edge;
  const { rect, lines, count } = box;
  const color = edgeColor(ctx.p, data.kind);
  const dash = count
    ? undefined
    : data.kind === 'dependency'
      ? '3 2'
      : data.kind === 'control'
        ? '1 2'
        : undefined;
  const opacity = data.faded ? NODE_OPACITY.faded : data.dimmed ? NODE_OPACITY.dimmed : undefined;
  return el(
    'g',
    {
      'data-edge-label': edge.id,
      transform: `translate(${num(rect.x)} ${num(rect.y)})`,
      ...(opacity !== undefined ? { opacity } : {}),
    },
    (data.count > 1 ? el('title', {}, xmlText(`${data.count} ${data.kind} edges`)) : '') +
      el('rect', {
        'data-part': 'label-box',
        x: 0.5,
        y: 0.5,
        width: rect.width - 1,
        height: rect.height - 1,
        rx: count ? (rect.height - 1) / 2 : 3.5,
        ...fill(ctx.p.edgeLabelBg),
        ...stroke(color, 1, dash),
      }) +
      textBlock(ctx, rect.width / 2, 2, lines, EDGE_LABEL.fontSize * PICTURE_STYLE.label.line, {
        size: EDGE_LABEL.fontSize,
        weight: count ? PICTURE_STYLE.label.countWeight : 400,
        color: ctx.p.fg,
        anchor: 'middle',
      }),
  );
}

// --- Geometry ------------------------------------------------------------------------------------

function union(rects: Iterable<Rect>): Rect | undefined {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  if (!Number.isFinite(x1 + y1 + x2 + y2)) return undefined;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Where a cubic turns round on one axis: the roots of its derivative inside (0, 1). */
function turns(a: number, b: number, c: number, d: number): number[] {
  const qa = -a + 3 * b - 3 * c + d;
  const qb = 2 * (a - 2 * b + c);
  const qc = b - a;
  const found: number[] = [];
  if (Math.abs(qa) < 1e-9) {
    if (Math.abs(qb) > 1e-9) found.push(-qc / qb);
  } else {
    const root = qb * qb - 4 * qa * qc;
    if (root >= 0) {
      found.push((-qb + Math.sqrt(root)) / (2 * qa), (-qb - Math.sqrt(root)) / (2 * qa));
    }
  }
  return found.filter((t) => t > 0 && t < 1);
}

/**
 * The box a curve covers: its two ends and the points where it turns round — not its control
 * points, which lie outside the line.
 */
export function curveBounds(curve: Curve): Rect {
  const { p0, c1, c2, p3 } = curve;
  const at = (t: number, a: number, b: number, c: number, d: number) => {
    const u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  };
  const xs = [
    p0.x,
    p3.x,
    ...turns(p0.x, c1.x, c2.x, p3.x).map((t) => at(t, p0.x, c1.x, c2.x, p3.x)),
  ];
  const ys = [
    p0.y,
    p3.y,
    ...turns(p0.y, c1.y, c2.y, p3.y).map((t) => at(t, p0.y, c1.y, c2.y, p3.y)),
  ];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function grown(rect: Rect, dx: number, dy: number): Rect {
  return {
    x: rect.x - dx,
    y: rect.y - dy,
    width: rect.width + 2 * dx,
    height: rect.height + 2 * dy,
  };
}

interface Placed {
  readonly bands: BandFlowNode[];
  readonly boxes: ArchFlowNode[];
  /** Where each box is on the canvas (a node is placed against its parent). */
  readonly absolute: Map<string, Rect>;
  /** The edges that are shown: those edges on demand holds back are left out. */
  readonly edges: FlowEdge[];
}

function place(flow: FlowGraph): Placed {
  const absolute = new Map<string, Rect>();
  const bands: BandFlowNode[] = [];
  const boxes: ArchFlowNode[] = [];
  for (const node of flow.nodes) {
    if (node.type === 'band') {
      bands.push(node);
      continue;
    }
    const parent = node.parentId === undefined ? undefined : absolute.get(node.parentId);
    if (node.parentId !== undefined && !parent) {
      throw new Error(`${node.id} is listed before its parent ${node.parentId}`);
    }
    absolute.set(node.id, {
      x: (parent?.x ?? 0) + node.position.x,
      y: (parent?.y ?? 0) + node.position.y,
      width: node.width,
      height: node.height,
    });
    boxes.push(node);
  }
  return { bands, boxes, absolute, edges: flow.edges.filter((edge) => edge.data.quiet !== true) };
}

/** What a box may paint outside its rectangle: the selection ring, the glow, a corner badge. */
const NODE_OVERHANG = { x: 8, y: 14 } as const;
/** The same for an edge: half its heaviest line and its arrowhead. */
const EDGE_OVERHANG = 12;

function extentOf(placed: Placed, measure: TextMeasure): Rect {
  const rects: Rect[] = [];
  for (const band of placed.bands) rects.push(bandRect(band));
  for (const node of placed.boxes) {
    const at = placed.absolute.get(node.id);
    if (at) rects.push(at);
    const list = node.data.workItems?.above;
    if (list) rects.push(list);
  }
  for (const edge of placed.edges) {
    rects.push(curveBounds(edge.data.curve));
    const label = labelBox(edge, measure);
    if (label) rects.push(label.rect);
  }
  const drawn = union(rects) ?? { x: 0, y: 0, width: 0, height: 0 };
  return wholePixels(grown(drawn, PICTURE_MARGIN, PICTURE_MARGIN));
}

/** `rect` grown to whole pixels on every side, so that a picture has a whole size. */
function wholePixels(rect: Rect): Rect {
  const x = Math.floor(rect.x + 1e-9);
  const y = Math.floor(rect.y + 1e-9);
  return {
    x,
    y,
    width: Math.ceil(rect.x + rect.width - 1e-9) - x,
    height: Math.ceil(rect.y + rect.height - 1e-9) - y,
  };
}

/**
 * The part of the canvas a picture of the whole map shows: the bounding box of the row bands,
 * the boxes, the lines of the shown edges (their true bounds), their labels and the work-item
 * lists, plus {@link PICTURE_MARGIN} on every side. Read from the flow, so boxes moved or
 * resized by hand are inside it wherever they are.
 */
export function drawnExtent(flow: FlowGraph, measure: TextMeasure = estimateMeasure): Rect {
  return extentOf(place(flow), measure);
}

// --- Heading and key -----------------------------------------------------------------------------

const HEADING = {
  titleSize: 18,
  titleLine: 26,
  noteSize: 12,
  noteLine: 17,
  top: 14,
  bottom: 10,
} as const;
const KEY = { size: 12, row: 20, gap: 16, sample: 28, top: 12, bottom: 16 } as const;
/** A picture with a heading or a key is at least this wide, so that their lines have room. */
export const PICTURE_MIN_TEXT_WIDTH = 480;

interface Block {
  readonly svg: string;
  readonly height: number;
}

function drawHeading(ctx: Ctx, heading: { title: string; note: string }, width: number): Block {
  const room = Math.max(1, width - 2 * PICTURE_MARGIN);
  const h = HEADING;
  const titleLines = wrapText(heading.title, room, h.titleSize, 600, ctx.measure, 2);
  const noteLines =
    heading.note === '' ? [] : wrapText(heading.note, room, h.noteSize, 400, ctx.measure);
  const svg =
    textBlock(ctx, PICTURE_MARGIN, h.top, titleLines, h.titleLine, {
      size: h.titleSize,
      weight: 600,
      color: ctx.p.fg,
    }) +
    textBlock(ctx, PICTURE_MARGIN, h.top + titleLines.length * h.titleLine, noteLines, h.noteLine, {
      size: h.noteSize,
      color: ctx.p.muted,
    });
  return {
    svg: el('g', { 'data-part': 'heading' }, svg),
    height: h.top + titleLines.length * h.titleLine + noteLines.length * h.noteLine + h.bottom,
  };
}

/**
 * The texts of the key: the heading of its edge kinds, the entry of an aggregate, the entry of
 * the nodes a colouring has no value for, and the sentences of the two lenses that have no
 * legend on the canvas.
 */
export const KEY_TEXTS = {
  edges: 'Edges',
  aggregate: 'several edges (×n)',
  noValue: 'No value',
  heat: 'Heat: open work in the box; the taller the strip, the more',
  progress: 'Progress: completed work items of all in the box',
} as const;

/**
 * The key below the map: the edge kinds that are in the picture (and the heavy line of an
 * aggregate when there is one), what "Colour by" shows, and one line each for heat and
 * progress while they are on. Entries follow each other on a line and wrap at `width`.
 */
function drawKey(
  ctx: Ctx,
  picture: MapPicture,
  kinds: readonly EdgeKind[],
  aggregates: boolean,
  width: number,
): Block {
  const p = ctx.p;
  const k = KEY;
  const room = Math.max(1, width - 2 * PICTURE_MARGIN);
  let x = 0;
  let y = 0;
  let out = '';
  let rowUsed = false;
  const newRow = () => {
    if (!rowUsed) return;
    x = 0;
    y += k.row;
    rowUsed = false;
  };
  /** An entry: a sample `sampleWidth` wide drawn by `sample(x, y)`, then `label`. */
  const entry = (
    label: string,
    sampleWidth: number,
    sample: (x: number, y: number) => string,
    style: { color?: string; weight?: number; italic?: boolean; count?: number | undefined } = {},
  ) => {
    const weight = style.weight ?? 400;
    const lead = sampleWidth > 0 ? sampleWidth + 6 : 0;
    // A count follows its label, in the colour of what is secondary.
    const count = style.count === undefined ? '' : String(style.count);
    const tail = count === '' ? 0 : 5 + ctx.measure(count, k.size, 400);
    const full = lead + ctx.measure(label, k.size, weight) + tail;
    if (rowUsed && x + full > room) newRow();
    // An entry wider than the whole key is cut: it must not make the picture wider.
    const text = fitText(label, Math.max(0, room - x - lead - tail), k.size, weight, ctx.measure);
    const labelWidth = ctx.measure(text, k.size, weight);
    out += sample(x, y);
    out += textLine(ctx, x + lead, y + k.row / 2, text, {
      size: k.size,
      weight,
      color: style.color ?? p.fg,
      ...(style.italic ? { italic: true } : {}),
    });
    if (count !== '') {
      out += textLine(ctx, x + lead + labelWidth + 5, y + k.row / 2, count, {
        size: k.size,
        color: p.muted,
      });
    }
    x += lead + labelWidth + tail + k.gap;
    rowUsed = true;
  };
  const none = () => '';

  if (kinds.length > 0) {
    const before = out;
    out = '';
    entry(KEY_TEXTS.edges, 0, none, { color: p.muted, weight: 600 });
    for (const kind of kinds) {
      entry(kind, k.sample, (sx, sy) =>
        el('line', {
          'data-key-kind': kind,
          x1: sx,
          y1: sy + k.row / 2,
          x2: sx + k.sample,
          y2: sy + k.row / 2,
          stroke: colorHex(parseColor(edgeColor(p, kind))),
          ...edgeLine(kind, false, false),
        }),
      );
    }
    if (aggregates) {
      entry(KEY_TEXTS.aggregate, k.sample, (sx, sy) =>
        el('line', {
          x1: sx,
          y1: sy + k.row / 2,
          x2: sx + k.sample,
          y2: sy + k.row / 2,
          stroke: colorHex(parseColor(p.muted)),
          'stroke-width': 3,
        }),
      );
    }
    out = before + el('g', { 'data-key': 'edges' }, out);
    newRow();
  }

  const coloring = picture.legend?.coloring;
  if (coloring && coloring.colorBy !== 'none' && coloring.legend.length > 0) {
    const before = out;
    out = '';
    entry(coloringTitle(coloring), 0, none, { color: p.muted, weight: 600 });
    const low = coloring.legend[0];
    const high = coloring.legend[1];
    if (coloring.range && low && high) {
      entry(low.label, 0, none);
      x -= k.gap - 6;
      const ramp = 80;
      if (rowUsed && x + ramp > room) newRow();
      out +=
        el(
          'linearGradient',
          { id: 'am-ramp', x1: 0, y1: 0, x2: 1, y2: 0 },
          el('stop', { offset: 0, 'stop-color': colorHex(parseColor(low.color[ctx.scheme])) }) +
            el('stop', { offset: 1, 'stop-color': colorHex(parseColor(high.color[ctx.scheme])) }),
        ) + el('rect', { x, y: y + 5, width: ramp, height: 10, rx: 3, fill: 'url(#am-ramp)' });
      x += ramp + 6;
      rowUsed = true;
      entry(high.label, 0, none);
    } else {
      for (const item of coloring.legend) {
        entry(
          item.label,
          12,
          (sx, sy) =>
            el('rect', {
              'data-key-value': item.label,
              x: sx,
              y: sy + 4,
              width: 12,
              height: 12,
              rx: 3,
              fill: colorHex(parseColor(item.color[ctx.scheme])),
              // A colour close to the background stays a square.
              stroke: colorHex(parseColor(p.fg)),
              'stroke-opacity': 0.25,
              'stroke-width': 1,
            }),
          { ...(item.kind === 'other' ? { italic: true } : {}), count: item.count },
        );
      }
      if (coloring.withoutValue !== undefined && coloring.withoutValue > 0) {
        entry(
          KEY_TEXTS.noValue,
          12,
          (sx, sy) =>
            el('rect', {
              'data-key-none': 'true',
              x: sx + 0.5,
              y: sy + 4.5,
              width: 11,
              height: 11,
              rx: 2.5,
              fill: 'none',
              ...stroke(p.muted, 1, '2 2'),
            }),
          { italic: true, count: coloring.withoutValue },
        );
      }
    }
    out = before + el('g', { 'data-key': 'colour', 'data-color-by': coloring.colorBy }, out);
    newRow();
  }

  if (picture.lenses?.heat) {
    ctx.heatUsed.add(100);
    const before = out;
    out = '';
    entry(KEY_TEXTS.heat, 5, (sx, sy) =>
      el('rect', { x: sx, y: sy + 2, width: 5, height: 16, rx: 2, fill: 'url(#am-heat-100)' }),
    );
    out = before + el('g', { 'data-key': 'heat' }, out);
    newRow();
  }
  if (picture.lenses?.progress) {
    const before = out;
    out = '';
    entry(
      KEY_TEXTS.progress,
      k.sample,
      (sx, sy) =>
        el('rect', {
          x: sx,
          y: sy + 8,
          width: k.sample,
          height: 5,
          rx: 2.5,
          fill: colorHex(parseColor(p.fg)),
          'fill-opacity': 0.14,
        }) +
        el('rect', { x: sx, y: sy + 8, width: 16, height: 5, rx: 2.5, ...fill(p.progressDone) }),
    );
    out = before + el('g', { 'data-key': 'progress' }, out);
    newRow();
  }
  if (y === 0) return { svg: '', height: 0 };
  return {
    svg: el(
      'g',
      { 'data-part': 'legend', transform: `translate(${num(PICTURE_MARGIN)} ${num(k.top)})` },
      out,
    ),
    height: k.top + y + k.bottom,
  };
}

// --- The picture ---------------------------------------------------------------------------------

/**
 * The SVG of `picture`: back to front as on the canvas (`Z_INDEX`) — row bands, open groups,
 * edges, leaves and closed groups, the work-item lists of open groups, edge labels — with the
 * heading above and the key below when asked for. With an `extent` (grown to whole pixels) only
 * what touches it is written and the rest is clipped. The size of the picture is whole pixels.
 * Same input, same text.
 */
export function mapSvg(picture: MapPicture): MapSvg {
  const ctx: Ctx = {
    p: PICTURE_PALETTE[picture.scheme],
    scheme: picture.scheme,
    measure: picture.measure ?? estimateMeasure,
    largeTitles: picture.largeTitles === true,
    heatUsed: new Set(),
    selectedItem: picture.workItem?.selectedId,
    relatedItem: picture.workItem?.parentId,
    hatchUsed: false,
  };
  const lenses = picture.lenses ?? {};
  const placed = place(picture.flow);
  const clipped = picture.extent !== undefined;
  const asked = picture.extent ?? extentOf(placed, ctx.measure);
  if (
    !(asked.width > 0 && asked.height > 0) ||
    !Number.isFinite(asked.x + asked.y + asked.width + asked.height)
  ) {
    throw new Error('the extent of the picture is empty');
  }
  const extent = wholePixels(asked);
  const within = (rect: Rect) => !clipped || overlaps(rect, extent);

  let below = '';
  let above = '';
  let lists = '';
  const shownNodes = new Set<string>();
  for (const band of placed.bands) if (within(bandRect(band))) below += drawBand(ctx, band);
  // Stable: boxes of one height keep the order of the flow (parents before children).
  const ordered = [...placed.boxes].sort((a, b) => a.zIndex - b.zIndex);
  for (const node of ordered) {
    const at = placed.absolute.get(node.id);
    if (!at) continue;
    const list = node.data.workItems?.above;
    const boxShown = within(grown(at, NODE_OVERHANG.x, NODE_OVERHANG.y));
    if (boxShown) {
      shownNodes.add(node.id);
      if (node.zIndex < Z_INDEX.edge) below += drawNode(ctx, node, at, lenses);
      else above += drawNode(ctx, node, at, lenses);
    }
    if (list && node.data.workItems && within(grown(list, 1, 1))) {
      lists += drawList(ctx, node, list, node.data.workItems.lines);
    }
  }
  let lines = '';
  let labelsOut = '';
  const edgeIds: string[] = [];
  const labelIds: string[] = [];
  const kinds = new Set<EdgeKind>();
  let aggregates = false;
  for (const edge of placed.edges) {
    const box = curveBounds(edge.data.curve);
    const label = labelBox(edge, ctx.measure);
    const lineShown = within(grown(box, EDGE_OVERHANG, EDGE_OVERHANG));
    if (lineShown) {
      edgeIds.push(edge.id);
      kinds.add(edge.data.kind);
      if (edge.data.count > 1) aggregates = true;
      lines += drawEdge(ctx, edge);
    }
    if (label && within(label.rect)) {
      labelIds.push(edge.id);
      labelsOut += drawEdgeLabel(ctx, edge, label);
    }
  }

  const framed = picture.heading !== undefined || picture.legend !== undefined;
  const width = framed ? Math.max(extent.width, PICTURE_MIN_TEXT_WIDTH) : extent.width;
  const heading = picture.heading ? drawHeading(ctx, picture.heading, width) : undefined;
  const key = picture.legend
    ? drawKey(
        ctx,
        picture,
        EDGE_KINDS.filter((kind) => kinds.has(kind)),
        aggregates,
        width,
      )
    : undefined;
  const headingHeight = heading?.height ?? 0;
  const height = headingHeight + extent.height + (key?.height ?? 0);

  let defs = '';
  for (const percent of [...ctx.heatUsed].sort((a, b) => a - b)) defs += heatGradient(percent);
  if (ctx.hatchUsed) {
    defs += el(
      'pattern',
      {
        id: 'am-hatch',
        width: PICTURE_STYLE.hatch.every,
        height: PICTURE_STYLE.hatch.every,
        patternUnits: 'userSpaceOnUse',
        patternTransform: `rotate(${PICTURE_STYLE.hatch.turn})`,
      },
      el('rect', {
        width: PICTURE_STYLE.hatch.stripe,
        height: PICTURE_STYLE.hatch.every,
        ...fill(ctx.p.collapsedHatch),
      }),
    );
  }
  if (clipped) {
    defs += el(
      'clipPath',
      { id: 'am-extent' },
      el('rect', { x: extent.x, y: extent.y, width: extent.width, height: extent.height }),
    );
  }

  const nodeIds = placed.boxes.filter((node) => shownNodes.has(node.id)).map((node) => node.id);
  const description =
    typeof picture.description === 'function'
      ? picture.description({ nodes: nodeIds.length, edges: edgeIds.length })
      : picture.description;
  const body =
    el('title', { id: 'am-title' }, xmlText(picture.title)) +
    el('desc', { id: 'am-desc' }, xmlText(description)) +
    (defs === '' ? '' : el('defs', {}, defs)) +
    el('rect', { 'data-part': 'background', width, height, ...fill(ctx.p.bg) }) +
    (heading?.svg ?? '') +
    el(
      'g',
      {
        'data-part': 'map',
        transform: `translate(${num(-extent.x)} ${num(headingHeight - extent.y)})`,
        ...(clipped ? { 'clip-path': 'url(#am-extent)' } : {}),
      },
      below + lines + above + lists + labelsOut,
    ) +
    (key && key.height > 0
      ? el('g', { transform: `translate(0 ${num(headingHeight + extent.height)})` }, key.svg)
      : '');

  const svg = el(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      width,
      height,
      viewBox: `0 0 ${num(width)} ${num(height)}`,
      role: 'img',
      'aria-labelledby': 'am-title am-desc',
      'font-family': PICTURE_FONT_FAMILY,
    },
    body,
  );
  return { svg, description, width, height, nodeIds, edgeIds, labelIds };
}

/** The root as {@link mapSvg} writes it, and as {@link svgAtSize} leaves it. */
const ROOT_SIZE =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="[^"]*" height="[^"]*"(?: preserveAspectRatio="none")?/;

/**
 * `svg` — a document written by {@link mapSvg}, or one this function has already sized — with
 * `width` × `height` as the size of its root: the pixels it is rasterised at. The view box
 * stays, so the picture is scaled, and it fills the size exactly (`preserveAspectRatio="none"`:
 * the two differ by less than a pixel). Other text throws, and so does a size below one pixel.
 */
export function svgAtSize(svg: string, width: number, height: number): string {
  if (!ROOT_SIZE.test(svg)) throw new Error('not a picture written by mapSvg');
  if (!(width >= 1 && height >= 1)) {
    throw new Error(`not a size of a picture: ${width} × ${height}`);
  }
  return svg.replace(
    ROOT_SIZE,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" preserveAspectRatio="none"`,
  );
}
