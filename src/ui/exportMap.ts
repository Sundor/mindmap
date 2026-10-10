// The browser half of exporting the map: the picture (src/core/mapPicture.ts) with the widths of
// its texts measured by a canvas, as a PNG through an image and a canvas, and the file handed to
// the browser as a download. All of it stays within the policy of the built viewer
// (scripts/single-file.ts): the picture becomes an image from a `data:` address, nothing is
// fetched, and a download is no request the policy judges.

import {
  estimateMeasure,
  EXPORT_MIME,
  EXPORT_TEXTS,
  exportFileName,
  exportGenerator,
  exportStamp,
  mapHtml,
  mapSvg,
  PICTURE_FONT_FAMILY,
  pictureDescription,
  pictureNote,
  pictureScheme,
  pictureTitle,
  pngSize,
  svgAtSize,
  viewExtent,
  type ExportChoices,
  type ExportFormat,
  type ExportOutcome,
  type FlowGraph,
  type PictureColoring,
  type PictureFacts,
  type PictureLenses,
  type PngSize,
  type Size,
  type TextMeasure,
  type Viewport,
} from '../core';

/** Everything an export is made from: the map as it is drawn, and how it is looked at. */
export interface ExportRequest {
  readonly format: ExportFormat;
  readonly choices: ExportChoices;
  /** The flow on the canvas, with the marks of the selection, the focus and edges on demand. */
  readonly flow: FlowGraph;
  readonly lenses: PictureLenses;
  readonly coloring: PictureColoring | undefined;
  /** The larger titles of the domains level are shown. */
  readonly largeTitles: boolean;
  /** The work item whose line is marked, and the item a selected task without a line is under. */
  readonly workItem: {
    readonly selectedId?: number | undefined;
    readonly parentId?: number | undefined;
  };
  /** What the picture says about itself; the area and the time are added at the export. */
  readonly facts: Omit<PictureFacts, 'area' | 'exportedAt'>;
  readonly viewport: Viewport;
  /** Size of the canvas on screen. */
  readonly canvas: Size;
  /** How many pixels at the left of the canvas the control panel lies over. */
  readonly coveredLeft: number;
  /** Version of the viewer, for the description of the file. */
  readonly version: string;
}

/**
 * The sentences an export ends with when there is nothing to save or no PNG can be made: they
 * are shown as they are. Any other failure is shown after {@link EXPORT_TEXTS.failed}.
 */
const REFUSALS: ReadonlySet<string> = new Set([
  EXPORT_TEXTS.tooLarge,
  EXPORT_TEXTS.nothingInView,
  EXPORT_TEXTS.nothingDrawn,
]);

/**
 * Text widths as the browser draws them, measured with a canvas that is never shown; every
 * width is measured once. For one export: the widths are kept as long as the function is.
 * Where a canvas measures nothing (no 2D context, or one that gives a text no width), the
 * estimate of the layout.
 */
export function canvasMeasure(): TextMeasure {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return estimateMeasure;
  const fonts = new Map<string, Map<string, number>>();
  let current: string | undefined;
  const measure = (text: string, fontSize: number, weight: number): number => {
    const font = `${weight} ${fontSize}px ${PICTURE_FONT_FAMILY}`;
    let widths = fonts.get(font);
    if (!widths) {
      widths = new Map();
      fonts.set(font, widths);
    }
    let width = widths.get(text);
    if (width === undefined) {
      if (font !== current) {
        context.font = font;
        current = font;
      }
      width = context.measureText(text).width;
      widths.set(text, width);
    }
    return width;
  };
  // Widths of nothing would be taken as exact: no name would be cut and no text wrapped.
  if (!(measure('Mm', 16, 400) > 0)) return estimateMeasure;
  return Object.assign(measure, { exact: true });
}

/** An image of the picture at `url`; rejects when the browser cannot read it. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('the picture did not load')), {
      once: true,
    });
    image.src = url;
  });
}

/**
 * The picture at `url` drawn on `canvas` at `width` × `height` pixels and read back as a PNG;
 * undefined where the canvas does not take the size, gives no 2D context, draws nothing, or
 * gives no file.
 */
async function paintPng(
  canvas: HTMLCanvasElement,
  url: string,
  width: number,
  height: number,
): Promise<Blob | undefined> {
  const image = await loadImage(url);
  canvas.width = width;
  canvas.height = height;
  if (canvas.width !== width || canvas.height !== height) return undefined;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.drawImage(image, 0, 0, width, height);
  // A picture has an opaque background over all of it: a corner that is still transparent means
  // the canvas took the size and drew nothing, or only a part. Browsers answer a canvas they
  // cannot fill in different ways, and not all of them with an error.
  const painted = (x: number, y: number): boolean => context.getImageData(x, y, 1, 1).data[3] !== 0;
  if (!painted(0, 0) || !painted(width - 1, height - 1)) return undefined;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ?? undefined;
}

/**
 * A PNG of `width` × `height` pixels of a picture written by `svgAtSize` for that size. The
 * picture is given to an image as a `data:` address (the one kind of image the policy of the
 * viewer allows; an image of an SVG runs no script and loads nothing) and drawn on a canvas.
 * Rejects with {@link EXPORT_TEXTS.tooLarge} when the browser makes no PNG of it. A browser set
 * to keep pages from reading a canvas hands over a blank or noisy picture without an error:
 * nothing here can tell.
 */
export async function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const canvas = document.createElement('canvas');
  let blob: Blob | undefined;
  try {
    blob = await paintPng(canvas, url, width, height);
  } catch {
    // The image did not load, or the canvas refused to be read: no PNG, as below.
  } finally {
    // Lets go of the pixels now, not when the canvas is collected.
    canvas.width = 0;
    canvas.height = 0;
  }
  if (!blob) throw new Error(EXPORT_TEXTS.tooLarge);
  return blob;
}

/**
 * Hands `blob` to the browser as a download named `name`; where the file goes is the browser's
 * business. The address of the blob is given up a minute later: the download has read it by
 * then.
 */
export function saveFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The file of `request`, handed to the browser; throws whatever goes wrong on the way. */
async function makeFile(request: ExportRequest): Promise<ExportOutcome> {
  const { format, choices, flow, lenses, version } = request;
  // Row bands alone are no map, whatever part of the canvas is asked for.
  if (flow.nodes.every((node) => node.type === 'band')) throw new Error(EXPORT_TEXTS.nothingDrawn);
  const scheme = pictureScheme(
    choices.scheme,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  // The whole map needs no extent: the picture then holds everything that is drawn.
  const extent =
    choices.area === 'view'
      ? viewExtent(request.viewport, request.canvas, request.coveredLeft)
      : undefined;
  if (choices.area === 'view' && !extent) throw new Error(EXPORT_TEXTS.nothingInView);
  const facts: PictureFacts = {
    ...request.facts,
    area: choices.area,
    exportedAt: exportStamp(Date.now(), -new Date().getTimezoneOffset()),
  };
  const title = pictureTitle(facts);
  const note = pictureNote(facts);
  const picture = mapSvg({
    flow,
    lenses,
    scheme,
    largeTitles: request.largeTitles,
    extent,
    title,
    description: (counts) => pictureDescription(facts, counts, version),
    heading: choices.caption ? { title, note } : undefined,
    legend: choices.caption ? { coloring: request.coloring } : undefined,
    workItem: request.workItem,
    measure: canvasMeasure(),
  });
  const nodes = picture.nodeIds.length;
  const edges = picture.edgeIds.length;
  // A part of the map without a box is still a picture when an edge crosses it.
  if (choices.area === 'view' && nodes === 0 && edges === 0) {
    throw new Error(EXPORT_TEXTS.nothingInView);
  }
  if (choices.area === 'map' && nodes === 0) throw new Error(EXPORT_TEXTS.nothingDrawn);

  let png: PngSize | undefined;
  let blob: Blob;
  if (format === 'png') {
    png = pngSize(picture.width, picture.height, choices.scale);
    blob = await svgToPng(svgAtSize(picture.svg, png.width, png.height), png.width, png.height);
  } else {
    const text =
      format === 'html'
        ? mapHtml({
            title,
            note,
            description: picture.description,
            picture,
            flow,
            lenses,
            scheme,
            generator: exportGenerator(version),
          })
        : picture.svg;
    blob = new Blob([text], { type: EXPORT_MIME[format] });
  }

  const name = exportFileName(facts.structureName, format);
  saveFile(name, blob);
  // A PNG has the size it was made at, the other two that of the picture in pixels of the map.
  const { width, height } = png ?? picture;
  return { format, name, bytes: blob.size, width, height, png, nodes, edges };
}

/**
 * Makes the file of the map as `request` describes it and hands it to the browser. Nothing of
 * the app changes. Rejects only with an Error whose message is a whole sentence for the user:
 * that there is nothing to save, that no PNG could be made, or {@link EXPORT_TEXTS.failed} with
 * the reason.
 */
export async function exportMap(request: ExportRequest): Promise<ExportOutcome> {
  try {
    return await makeFile(request);
  } catch (error) {
    if (error instanceof Error && REFUSALS.has(error.message)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(EXPORT_TEXTS.failed + reason, { cause: error });
  }
}
