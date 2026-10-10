// The map as a page of its own: the picture of `mapSvg` in an HTML document that runs no
// script and loads nothing, with the boxes and the edges of the picture listed as text.
// Pure: no DOM, no React.

import { flowEdgeLabel, type ArchFlowNode, type FlowGraph } from './flow';
import {
  heatStripTitle,
  nodeElementId,
  progressBarTitle,
  type MapSvg,
  type PictureLenses,
} from './mapPicture';
import {
  PICTURE_FONT_FAMILY,
  PICTURE_PALETTE,
  xmlElement as el,
  xmlText,
  type ColorScheme,
} from './pictureKit';
import { workItemCountsText } from './workItemOverlay';

/**
 * The policy an exported page declares for itself: nothing is loaded and no script runs.
 * Styles: its one `<style>` element. Images: `data:` only — the empty page icon, which keeps a
 * browser from asking a server for one.
 */
export const EXPORT_PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** The texts of an exported page. */
export const PAGE_TEXTS = {
  fit: 'Fit the width',
  map: 'Map',
  boxes: 'Boxes',
  edges: 'Edges',
  from: 'From',
  to: 'To',
  kind: 'Kind',
  label: 'Label',
  closed: 'closed, inside: ',
} as const;

export interface MapPage {
  /** The heading of the page and its `<title>`. */
  readonly title: string;
  /** The line under the heading (`pictureNote`). */
  readonly note: string;
  /** `<meta name="description">` (`pictureDescription`). */
  readonly description: string;
  /** The picture, as {@link mapSvg} returned it, and the flow and the lenses it was made from. */
  readonly picture: MapSvg;
  readonly flow: FlowGraph;
  readonly lenses?: PictureLenses | undefined;
  /** The scheme the picture was written in: the page has the same. */
  readonly scheme: ColorScheme;
  /** `<meta name="generator">`. */
  readonly generator: string;
}

function pageCss(scheme: ColorScheme): string {
  const p = PICTURE_PALETTE[scheme];
  // No `>` and no `<` in here: the page is well-formed XML as well (see `mapHtml`).
  return [
    `html{color-scheme:${scheme};font-family:${PICTURE_FONT_FAMILY};background:${p.bg};color:${p.fg}}`,
    'body{margin:0 auto;padding:1rem;max-width:110rem;line-height:1.4}',
    'h1{font-size:1.4rem;margin:0 0 .2rem}',
    'h2{font-size:1.1rem;margin:1.4rem 0 .4rem}',
    `.note,small{color:${p.muted}}`,
    '.note{margin:0 0 .8rem}',
    `.map{overflow:auto;max-height:85vh;margin-top:.4rem;border:1px solid ${p.border};border-radius:8px}`,
    '.map svg{display:block}',
    '#fit:checked~.map svg{width:100%;height:auto}',
    `.map g:target rect[data-part="box"]{stroke:${p.nodeSelected};stroke-width:4px}`,
    `a{color:${p.nodeSelected}}`,
    `:focus-visible{outline:2px solid ${p.nodeSelected};outline-offset:2px}`,
    'ul{margin:.2rem 0;padding-left:1.3rem}',
    'table{border-collapse:collapse}',
    `td,th{padding:.15rem .8rem .15rem 0;border-bottom:1px solid ${p.border};text-align:left;vertical-align:top}`,
    '@media print{.fit{display:none}.map{overflow:visible;max-height:none;border:0}.map svg{width:100%;height:auto}}',
  ].join('');
}

/**
 * An HTML element that is not void: always with an end tag, also around nothing (an HTML
 * parser does not close `<title/>` or `<td/>`).
 */
function tag(
  name: string,
  attributes: Readonly<Record<string, string | undefined>>,
  content: string,
): string {
  return el(name, attributes, content);
}

/**
 * The page of a picture. One self-contained file: a heading, the note, a switch that fits the
 * picture to the width of the window (a checkbox and one style rule), the picture in a region
 * that scrolls, then the boxes of the picture as a nested list — each name a link to its box,
 * which the browser scrolls to and the page outlines — and its edges as a table. Only what is
 * in the picture is listed.
 *
 * No script, no event attribute, no address but `data:,` and fragments of the page itself;
 * every text is escaped. The document is HTML and, after its first line, well-formed XML.
 * A picture that was not written by `mapSvg` is refused.
 */
export function mapHtml(page: MapPage): string {
  const { svg } = page.picture;
  if (
    !svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') ||
    /<script|<foreignObject/i.test(svg)
  ) {
    throw new Error('not a picture written by mapSvg');
  }
  const shown = new Set(page.picture.nodeIds);
  const shownEdges = new Set(page.picture.edgeIds);
  const names = new Map<string, string>();
  const children = new Map<string | undefined, ArchFlowNode[]>();
  for (const node of page.flow.nodes) {
    if (node.type === 'band') continue;
    names.set(node.id, node.data.name);
    if (!shown.has(node.id)) continue;
    // A box whose group is not in the picture (a part of the map) is listed at the top.
    const parent =
      node.parentId !== undefined && shown.has(node.parentId) ? node.parentId : undefined;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }

  const boxList = (parent: string | undefined): string => {
    const nodes = children.get(parent);
    if (!nodes) return '';
    return tag(
      'ul',
      parent === undefined ? { class: 'boxes' } : {},
      nodes
        .map((node) => {
          const d = node.data;
          let line =
            tag('a', { href: `#${nodeElementId(node.id)}` }, xmlText(d.name)) +
            ` ${tag('small', {}, xmlText(d.levelName))}`;
          if (d.description) line += ` — ${xmlText(d.description)}`;
          if (d.collapsed && d.childNames.length > 0) {
            const inside = `(${PAGE_TEXTS.closed}${d.childNames.join(', ')})`;
            line += ` ${tag('small', {}, xmlText(inside))}`;
          }
          // What the marks of the box say: its badge, its heat strips, its progress bar.
          const marks: string[] = [];
          if (!d.workItems && d.badge) marks.push(workItemCountsText(d.badge));
          const heat = page.lenses?.heat?.get(node.id);
          if (heat) marks.push(heatStripTitle(heat));
          const progress = page.lenses?.progress?.get(node.id);
          if (progress) marks.push(progressBarTitle(progress));
          if (marks.length > 0) line += ` ${tag('small', {}, xmlText(`· ${marks.join(' · ')}`))}`;
          if (d.workItems) {
            line += tag(
              'ul',
              { class: 'workitems' },
              d.workItems.lines
                .map((item) =>
                  tag(
                    'li',
                    {},
                    item.kind === 'more'
                      ? xmlText(item.text)
                      : `${xmlText(`${item.item.type} #${item.item.id}: ${item.item.title}`)} ${tag(
                          'small',
                          {},
                          xmlText(`(${item.item.state})`),
                        )}`,
                  ),
                )
                .join(''),
            );
          }
          return tag('li', { 'data-node': node.id }, line + boxList(node.id));
        })
        .join(''),
    );
  };

  const rows = page.flow.edges
    .filter((edge) => shownEdges.has(edge.id))
    .map((edge) => {
      // The label of the edge, also where the level of detail does not draw it on the line.
      const label = (flowEdgeLabel({ ...edge.data, labelShown: true }) ?? '').replace(/\n/g, '; ');
      return tag(
        'tr',
        { 'data-edge': edge.id },
        tag('td', {}, xmlText(names.get(edge.source) ?? edge.source)) +
          tag('td', {}, xmlText(names.get(edge.target) ?? edge.target)) +
          tag('td', {}, xmlText(edge.data.kind)) +
          tag('td', {}, xmlText(label)),
      );
    })
    .join('');

  const t = PAGE_TEXTS;
  const head =
    el('meta', { charset: 'utf-8' }) +
    el('meta', { 'http-equiv': 'Content-Security-Policy', content: EXPORT_PAGE_POLICY }) +
    el('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }) +
    el('meta', { name: 'referrer', content: 'no-referrer' }) +
    el('meta', { name: 'generator', content: page.generator }) +
    el('meta', { name: 'description', content: page.description }) +
    el('meta', { name: 'color-scheme', content: page.scheme }) +
    el('link', { rel: 'icon', href: 'data:,' }) +
    tag('title', {}, xmlText(page.title)) +
    tag('style', {}, pageCss(page.scheme));
  const boxes = boxList(undefined);
  const body =
    tag(
      'header',
      {},
      tag('h1', {}, xmlText(page.title)) + tag('p', { class: 'note' }, xmlText(page.note)),
    ) +
    el('input', { type: 'checkbox', id: 'fit', class: 'fit', checked: 'checked' }) +
    ` ${tag('label', { for: 'fit', class: 'fit' }, xmlText(t.fit))}` +
    tag('div', { class: 'map', role: 'region', 'aria-label': t.map, tabindex: '0' }, svg) +
    (boxes === '' ? '' : tag('h2', { id: 'boxes' }, xmlText(t.boxes)) + boxes) +
    (rows === ''
      ? ''
      : tag('h2', { id: 'edges' }, xmlText(t.edges)) +
        tag(
          'table',
          {},
          tag(
            'thead',
            {},
            tag(
              'tr',
              {},
              [t.from, t.to, t.kind, t.label]
                .map((cell) => tag('th', { scope: 'col' }, xmlText(cell)))
                .join(''),
            ),
          ) + tag('tbody', {}, rows),
        ));
  return `<!doctype html>\n${tag('html', { lang: 'en' }, tag('head', {}, head) + tag('body', {}, body))}\n`;
}
