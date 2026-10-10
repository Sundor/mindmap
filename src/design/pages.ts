// The two design pages as text: every specimen and screen rendered to markup on its own, the
// portals of each canvas filled, and the pages put together around the app's real stylesheet.

import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import libraryCss from '@xyflow/react/dist/style.css?raw';
import appCss from '../ui/styles.css?raw';
import pageCss from './template.css?raw';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { GroupWorkItemLists } from '../ui/WorkItemBlock';
import { loadFixtures } from './fixtures';
import { KitSpecimen } from './Kit';
import { fillContainer, pageDocument, specimenSection, withoutHandles } from './markup';
import { Screen } from './Screens';
import {
  KIT_SPECIMENS,
  prepare,
  SCREENS,
  type Canvas,
  type Prepared,
  type SpecimenInfo,
} from './specimens';
import { EdgeLabelLayer } from './StaticCanvas';
import { customProperties, scoped, type CustomProperty } from './stylesheet';

export interface DesignPage {
  readonly fileName: 'kit.html' | 'screens.html';
  readonly html: string;
}

const noop = (): undefined => undefined;
const render = (element: ReactElement): string => renderToStaticMarkup(element);

/** The two portals of a canvas filled with what the app renders into them. */
function withPortals(html: string, canvas: Canvas): string {
  const labels = render(createElement(EdgeLabelLayer, { flow: canvas.flow }));
  const lists = render(
    createElement(GroupWorkItemLists, { nodes: canvas.flow.nodes, onSelectNode: noop }),
  );
  const filled = fillContainer(
    fillContainer(html, 'react-flow__edgelabel-renderer', labels),
    'react-flow__viewport-portal',
    lists,
  );
  return canvas.handles ? filled : withoutHandles(filled);
}

function specimenHtml(
  info: SpecimenInfo,
  prepared: Prepared,
  properties: readonly CustomProperty[],
): string {
  // A screen stands inside the error boundary, as the app does.
  const element =
    info.kind === 'screen'
      ? createElement(ErrorBoundary, null, createElement(Screen, { id: info.id, prepared }))
      : createElement(KitSpecimen, { id: info.id, prepared, properties });
  const canvas = prepared.canvases.get(info.id);
  const html = render(element);
  return canvas ? withPortals(html, canvas) : html;
}

function sections(
  list: readonly SpecimenInfo[],
  prepared: Prepared,
  properties: readonly CustomProperty[],
): string {
  const parts: string[] = [];
  let section: string | undefined;
  for (const info of list) {
    if (info.section !== section) {
      section = info.section;
      parts.push(`<h2 class="tpl-section">${section}</h2>`);
    }
    parts.push(specimenSection({ ...info, html: specimenHtml(info, prepared, properties) }));
  }
  return parts.join('\n');
}

const INTRO = (what: string): string =>
  `<header class="tpl-intro"><h1>Architecture Map — ${what}</h1><p>This page shows the viewer's interface as static markup, with its real stylesheet. The style block marked <em>app stylesheet</em> is the one to change: keep its selectors and the names of its custom properties, and the changes carry back into the app. Classes starting with <code>tpl-</code> and the last style block belong to this page. Hover and keyboard-focus states show when an element is pointed at or reached with Tab.</p></header>`;

/** The pages, light with a scheme switch, or dark by a class on the root. */
export async function designPages(
  options: { readonly dark?: boolean | undefined } = {},
): Promise<DesignPage[]> {
  const dark = options.dark === true;
  const prepared = await prepare(await loadFixtures());
  const properties = customProperties(appCss);
  const styles = { libraryCss, appCss: scoped(appCss), pageCss, dark };
  return [
    {
      fileName: 'kit.html',
      html: pageDocument({
        ...styles,
        title: 'Architecture Map — design kit',
        body: `${INTRO('design kit')}\n${sections(KIT_SPECIMENS, prepared, properties)}`,
      }),
    },
    {
      fileName: 'screens.html',
      html: pageDocument({
        ...styles,
        title: 'Architecture Map — screens',
        body: `${INTRO('screens')}\n${sections(SCREENS, prepared, properties)}`,
      }),
    },
  ];
}
