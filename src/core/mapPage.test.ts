import { describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import { quietEdges } from './edgesOnDemand';
import { flowEdgeLabel } from './flow';
import { EXPORT_PAGE_POLICY, mapHtml, PAGE_TEXTS, type MapPage } from './mapPage';
import { heatStripTitle, mapSvg, nodeElementId, progressBarTitle } from './mapPicture';
import { COLOR_SCHEMES, PICTURE_PALETTE, type ColorScheme } from './pictureKit';
import { buildMap, readXml, unescapeXml, type XmlElement } from './pictureTestHelpers';
import { moreLinesText, WORK_ITEM_GEOMETRY } from './workItemContent';
import { workItemCountsText } from './workItemOverlay';
import { heatByWork, progressByNode } from './workload';

const TEXTS = {
  title: 'architecture.yaml',
  note: 'Level: Everything',
  description: 'd',
  generator: 'g',
};

/** A small map: two edges between the same two boxes, and a box with more work items than it lists. */
const SMALL_YAML = [
  'version: 1',
  'domains:',
  '  - id: a',
  '    name: A',
  '    components:',
  '      - { id: a.x, name: X }',
  '      - { id: a.y, name: Y }',
  'edges:',
  '  - { id: e1, from: a.x, to: a.y, kind: dataflow, label: orders, protocol: REST }',
  '  - { id: e2, from: a.x, to: a.y, kind: dataflow, label: refunds }',
  '',
].join('\n');
const SMALL_ITEMS = JSON.stringify({
  version: 1,
  items: Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    type: 'User Story',
    title: `Story ${index + 1}`,
    state: 'Active',
    tags: 'comp:a.x',
  })),
});

/** The HTML elements without an end tag that a page has: the only ones written `<name …/>`. */
const VOID_ELEMENTS = ['meta', 'link', 'input'];

/** Elements that run, load or send something. */
const ACTIVE_ELEMENTS = [
  'script',
  'img',
  'image',
  'picture',
  'source',
  'iframe',
  'frame',
  'object',
  'embed',
  'applet',
  'audio',
  'video',
  'track',
  'form',
  'base',
  'use',
  'feimage',
];

/** Attributes that hold an address. */
const ADDRESS_ATTRIBUTES = [
  'href',
  'xlink:href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'data',
  'background',
  'ping',
  'manifest',
  'cite',
];

/** The page without its first line: it must be well-formed XML. */
function read(html: string): XmlElement[] {
  expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
  return readXml(html.slice(html.indexOf('\n') + 1).trimEnd());
}

/** The directives of a policy by name, each with its sources. */
function directives(policy: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const directive of policy.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) result.set(name, sources);
  }
  return result;
}

/**
 * What every page must be, read from its text: well-formed, the same document for an HTML
 * parser, without anything that runs, and asking a browser for nothing but what the policy it
 * declares allows. `svg` is the picture the page was made of.
 */
function check(html: string, svg: string): XmlElement[] {
  const elements = read(html);
  const named = (name: string) => elements.filter((e) => e.name.toLowerCase() === name);
  const ids = elements.map((e) => e.attrs.get('id')).filter((id) => id !== undefined);
  expect(new Set(ids).size).toBe(ids.length);

  // No script: no element that runs, loads or sends, and no event attribute.
  expect(html).not.toMatch(/<script|<iframe|<object|<embed|<form|<base|<img/i);
  expect(
    elements.map((e) => e.name).filter((name) => ACTIVE_ELEMENTS.includes(name.toLowerCase())),
  ).toEqual([]);
  const events: string[] = [];
  const styled: string[] = [];
  const addresses: { element: string; name: string; value: string }[] = [];
  const references: string[] = [];
  for (const element of elements) {
    for (const [name, value] of element.attrs) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on')) events.push(`${element.name} ${name}`);
      if (lower === 'style') styled.push(element.name);
      if (ADDRESS_ATTRIBUTES.includes(lower))
        addresses.push({ element: element.name, name, value });
      if (value.includes('url(')) references.push(value);
    }
  }
  expect(events).toEqual([]);

  // The policy: declared right after the charset, before anything it is to judge, and once.
  const head = elements.filter((e) => elements[e.parent]?.name === 'head');
  expect(head[0]?.name).toBe('meta');
  expect(head[0]?.attrs.get('charset')).toBe('utf-8');
  expect(head[1]?.name).toBe('meta');
  expect(head[1]?.attrs.get('http-equiv')).toBe('Content-Security-Policy');
  expect(elements.filter((e) => e.attrs.has('http-equiv'))).toHaveLength(1);
  const policy = unescapeXml(head[1]?.attrs.get('content') ?? '');
  expect(policy).toBe(EXPORT_PAGE_POLICY);
  // Its quotes are written as character references, which an HTML parser turns back.
  expect(html).toContain(
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data:"/>',
  );
  const allowed = directives(policy);
  expect([...allowed.keys()].sort()).toEqual(['default-src', 'img-src', 'style-src']);
  // Nothing by default — so no script at all, and nothing fetched but what follows.
  expect(allowed.get('default-src')).toEqual(["'none'"]);
  // Styles: inline only. The page has one style element, which loads nothing, and no
  // `style` attribute.
  expect(allowed.get('style-src')).toEqual(["'unsafe-inline'"]);
  const styles = named('style');
  expect(styles).toHaveLength(1);
  expect(elements[styles[0]?.parent ?? -1]?.name).toBe('head');
  expect(styles[0]?.text).not.toMatch(/url\(|@import|@font-face|image-set\(|expression\(/i);
  expect(styled).toEqual([]);
  // Images: `data:` only. The one thing loaded as an image is the empty icon.
  expect(allowed.get('img-src')).toEqual(['data:']);
  const links = named('link');
  expect(links.map((e) => [...e.attrs])).toEqual([
    [
      ['rel', 'icon'],
      ['href', 'data:,'],
    ],
  ]);
  // Every other address is a place in the page itself: a link of the list to a box that is
  // there, and inside the picture a reference to one of its own definitions.
  const elsewhere = addresses.filter((address) => address.element !== 'link');
  expect(
    elsewhere.filter(
      ({ element, name, value }) =>
        element !== 'a' ||
        name !== 'href' ||
        !value.startsWith('#') ||
        !ids.includes(value.slice(1)),
    ),
  ).toEqual([]);
  expect(
    references.filter((value) => {
      const id = /^url\(#(am-[\w-]+)\)$/.exec(value)?.[1];
      return id === undefined || !ids.includes(id);
    }),
  ).toEqual([]);

  // Read as HTML it is the same document. Outside the picture only void elements are written
  // without an end tag (an HTML parser would leave any other open), and the style rules hold
  // no character an HTML parser and an XML parser read differently.
  expect(html).toContain(svg);
  const selfClosed = [...html.replace(svg, '').matchAll(/<([A-Za-z][\w:-]*)[^<>]*\/>/g)];
  expect(
    selfClosed.map((match) => match[1]).filter((name) => !VOID_ELEMENTS.includes(name ?? '')),
  ).toEqual([]);
  for (const name of VOID_ELEMENTS) {
    expect(named(name).length, name).toBeGreaterThan(0);
    expect(html).not.toContain(`</${name}>`);
  }
  const rules = /<style>([^<]*)<\/style>/.exec(html)?.[1] ?? '';
  expect(rules).not.toBe('');
  expect(rules).not.toMatch(/[&<>]/);
  expect(styles[0]?.text).toBe(rules);
  return elements;
}

/** The entry of the list of boxes that `element` lies in, if any. */
function listedIn(elements: readonly XmlElement[], element: XmlElement): XmlElement | undefined {
  let up = elements[element.parent];
  while (up && !(up.name === 'li' && up.attrs.has('data-node'))) up = elements[up.parent];
  return up;
}

describe('the page of the example', () => {
  it('is one well-formed document without script, with its policy first and every box and edge listed', async () => {
    const { model, overlay, flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const lenses = { heat: heatByWork(model, overlay), progress: progressByNode(model, overlay) };
    for (const scheme of COLOR_SCHEMES) {
      const picture = mapSvg({ flow, scheme, lenses, title: 't', description: 'd' });
      const page: MapPage = { ...TEXTS, picture, flow, lenses, scheme };
      const html = mapHtml(page);
      const elements = check(html, picture.svg);
      // The same page every time.
      expect(mapHtml(page)).toBe(html);
      // No event attribute and no address that runs, in the text of the page either.
      expect(html).not.toMatch(/\son[a-z]+=|javascript:/i);
      const head = elements.filter((e) => elements[e.parent]?.name === 'head');
      expect(head.find((e) => e.attrs.get('name') === 'color-scheme')?.attrs.get('content')).toBe(
        scheme,
      );
      expect(head.find((e) => e.attrs.get('name') === 'generator')?.attrs.get('content')).toBe(
        TEXTS.generator,
      );
      expect(head.find((e) => e.attrs.get('name') === 'description')?.attrs.get('content')).toBe(
        TEXTS.description,
      );
      expect(head.find((e) => e.attrs.get('name') === 'referrer')?.attrs.get('content')).toBe(
        'no-referrer',
      );
      // One list entry per box of the picture, each a link to an `id` that exists once.
      const ids = elements.map((e) => e.attrs.get('id')).filter((id) => id !== undefined);
      const items = elements.filter((e) => e.name === 'li' && e.attrs.has('data-node'));
      expect(items.map((e) => e.attrs.get('data-node'))).toEqual(picture.nodeIds);
      const links = elements.filter((e) => e.name === 'a');
      expect(links).toHaveLength(picture.nodeIds.length);
      for (const link of links) expect(ids).toContain((link.attrs.get('href') ?? '').slice(1));
      // The list is nested as the map is.
      for (const node of flow.nodes) {
        if (node.type === 'band') continue;
        const item = items.find((e) => e.attrs.get('data-node') === node.id);
        if (!item) throw new Error(`${node.id} is not listed`);
        expect(listedIn(elements, item)?.attrs.get('data-node'), node.id).toBe(node.parentId);
      }
      // One table row per edge of the picture, in its order, with four cells.
      const rows = elements.filter((e) => e.name === 'tr' && e.attrs.has('data-edge'));
      expect(rows.map((e) => unescapeXml(e.attrs.get('data-edge') ?? ''))).toEqual(picture.edgeIds);
      for (const row of rows) {
        expect(elements.filter((e) => e.parent === row.index && e.name === 'td')).toHaveLength(4);
      }
      const headings = elements.filter((e) => e.name === 'th');
      expect(headings.map((e) => e.attrs.get('scope'))).toEqual(['col', 'col', 'col', 'col']);
      expect(headings.map((e) => e.text)).toEqual([
        PAGE_TEXTS.from,
        PAGE_TEXTS.to,
        PAGE_TEXTS.kind,
        PAGE_TEXTS.label,
      ]);
      // The switch before the region it sizes, the region, the headings.
      const fit = elements.find((e) => e.attrs.get('id') === 'fit');
      expect(fit?.name).toBe('input');
      expect(fit?.attrs.get('type')).toBe('checkbox');
      expect(fit?.attrs.get('checked')).toBe('checked');
      const label = elements.find((e) => e.name === 'label' && e.attrs.get('for') === 'fit');
      expect(label?.text).toBe(PAGE_TEXTS.fit);
      const region = elements.find((e) => e.attrs.get('class') === 'map');
      expect(region?.name).toBe('div');
      expect(region?.attrs.get('role')).toBe('region');
      expect(region?.attrs.get('aria-label')).toBe(PAGE_TEXTS.map);
      expect(region?.attrs.get('tabindex')).toBe('0');
      expect(region?.parent).toBe(fit?.parent);
      expect(region?.index ?? 0).toBeGreaterThan(fit?.index ?? Infinity);
      expect(elements[(region?.index ?? 0) + 1]?.name).toBe('svg');
      expect(html).toContain(`<h1>${TEXTS.title}</h1>`);
      expect(html).toContain(`<title>${TEXTS.title}</title>`);
      expect(html).toContain(`<p class="note">${TEXTS.note}</p>`);
      expect(html).toContain(`<h2 id="boxes">${PAGE_TEXTS.boxes}</h2><ul class="boxes">`);
      expect(html).toContain(`<h2 id="edges">${PAGE_TEXTS.edges}</h2><table>`);
      // Work items and the lenses are said in words.
      expect(html).toContain('open work item');
      expect(html).toMatch(/\d+ of \d+ done/);
      expect(html).toMatch(/<ul class="workitems"><li>(User Story|Bug|Feature|Epic|Task) #\d+: /);
    }
  }, 60_000);
});

describe('hostile texts', () => {
  it('stay text in the page too', async () => {
    const yaml = [
      'version: 1',
      'domains:',
      '  - id: a',
      '    name: "</li><script>alert(1)</script> &amp; \\" \\u0001"',
      '    description: "</style><img src=x onerror=alert(1)>"',
      '    components:',
      '      - { id: a.x, name: "<x>" }',
      '      - { id: a.y, name: "y" }',
      'edges:',
      '  - { id: e, from: a.x, to: a.y, kind: control, label: "</td><script>", protocol: "\\"" }',
      '',
    ].join('\n');
    const { flow } = await buildMap(yaml, undefined, 'detail');
    const picture = mapSvg({ flow, scheme: 'light', title: '</title><script>', description: 'd' });
    const html = mapHtml({
      title: '</title><script>alert(1)</script>',
      note: '</p><script>',
      description: '"><script>',
      generator: '"><script>',
      picture,
      flow,
      scheme: 'light',
    });
    const elements = check(html, picture.svg);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(elements.filter((e) => e.name === 'script' || e.name === 'img')).toHaveLength(0);
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).toContain('<h1>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</h1>');
    expect(html).toContain('<p class="note">&lt;/p&gt;&lt;script&gt;</p>');
    expect(elements.filter((e) => e.name === 'style')).toHaveLength(1);
    // The texts are there, as text: the name and the description in the list, the label in the
    // table, the two attributes of the head.
    const item = elements.find((e) => e.name === 'li' && e.attrs.get('data-node') === 'a');
    const link = elements.find((e) => e.name === 'a' && e.parent === item?.index);
    expect(link?.text).toBe('</li><script>alert(1)</script> &amp; " ');
    expect(item?.text).toContain(' — </style><img src=x onerror=alert(1)>');
    const cells = elements.filter((e) => e.name === 'td').map((e) => e.text);
    expect(cells).toEqual(['<x>', 'y', 'control', '</td><script> ["]']);
    for (const name of ['generator', 'description']) {
      const meta = elements.find((e) => e.name === 'meta' && e.attrs.get('name') === name);
      expect(unescapeXml(meta?.attrs.get('content') ?? '')).toBe('"><script>');
    }
  });

  it('texts that are empty keep their elements closed', async () => {
    const yaml = [
      'version: 1',
      'domains:',
      '  - id: a',
      '    name: A',
      '    components:',
      '      - { id: a.x, name: X }',
      '      - { id: a.y, name: Y }',
      'edges:',
      '  - { id: e, from: a.x, to: a.y, kind: dataflow }',
      '',
    ].join('\n');
    const { flow } = await buildMap(yaml, undefined, 'detail');
    const picture = mapSvg({ flow, scheme: 'dark', title: '', description: '' });
    const html = mapHtml({
      title: '',
      note: '',
      description: '',
      generator: '',
      picture,
      flow,
      scheme: 'dark',
    });
    const elements = check(html, picture.svg);
    expect(html).toContain('<title></title>');
    expect(html).toContain('<header><h1></h1><p class="note"></p></header>');
    // An edge without a label has its cell all the same.
    expect(elements.filter((e) => e.name === 'td').map((e) => e.text)).toEqual([
      'X',
      'Y',
      'dataflow',
      '',
    ]);
    expect(html).toContain('<td>dataflow</td><td></td></tr>');
  });
});

describe('only what is in the picture is listed', () => {
  it('a part of the map lists its boxes; edges held back are not in the table', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const first = flow.nodes.find((n) => n.type !== 'band');
    const quiet = quietEdges(flow, new Set([first?.id ?? '']), undefined);
    const picture = mapSvg({
      flow: quiet,
      scheme: 'light',
      title: 't',
      description: 'd',
      extent: { x: 200, y: 100, width: 800, height: 500 },
    });
    expect(picture.nodeIds.length).toBeGreaterThan(0);
    expect(picture.nodeIds.length).toBeLessThan(flow.nodes.length - 3);
    expect(picture.edgeIds.length).toBeGreaterThan(0);
    expect(picture.edgeIds.length).toBeLessThan(flow.edges.length);
    const html = mapHtml({ ...TEXTS, picture, flow: quiet, scheme: 'light' });
    const elements = check(html, picture.svg);
    const items = elements.filter((e) => e.name === 'li' && e.attrs.has('data-node'));
    expect(items.map((e) => e.attrs.get('data-node')).sort()).toEqual([...picture.nodeIds].sort());
    const ids = new Set(elements.map((e) => e.attrs.get('id')));
    for (const link of elements.filter((e) => e.name === 'a')) {
      expect(ids.has((link.attrs.get('href') ?? '').slice(1))).toBe(true);
    }
    for (const id of picture.nodeIds) expect(ids.has(nodeElementId(id))).toBe(true);
    const rows = elements.filter((e) => e.name === 'tr' && e.attrs.has('data-edge'));
    expect(rows.map((e) => unescapeXml(e.attrs.get('data-edge') ?? ''))).toEqual(picture.edgeIds);
  });

  it('a picture without boxes and edges has neither heading', () => {
    const none = { nodes: [], edges: [] };
    const empty = mapSvg({ flow: none, scheme: 'dark', title: 't', description: 'd' });
    const bare = mapHtml({ ...TEXTS, picture: empty, flow: none, scheme: 'dark' });
    const elements = check(bare, empty.svg);
    expect(elements.filter((e) => ['h2', 'ul', 'li', 'table', 'a'].includes(e.name))).toEqual([]);
    expect(bare).not.toContain(`>${PAGE_TEXTS.boxes}<`);
    expect(bare).not.toContain(`>${PAGE_TEXTS.edges}<`);
    expect(bare).toContain(`<h1>${TEXTS.title}</h1>`);
  });

  it('a box whose group is not in the picture is listed at the top', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const whole = mapSvg({ flow, scheme: 'light', title: 't', description: 'd' });
    const boxes = flow.nodes.flatMap((n) => (n.type === 'band' ? [] : [n]));
    const group = boxes.find((n) => boxes.some((child) => child.parentId === n.id));
    if (!group) throw new Error('a group with boxes in it');
    const inside = boxes.filter((n) => n.parentId === group.id);
    expect(inside.length).toBeGreaterThan(0);
    const picture = { ...whole, nodeIds: whole.nodeIds.filter((id) => id !== group.id) };
    const elements = check(mapHtml({ ...TEXTS, picture, flow, scheme: 'light' }), picture.svg);
    const items = elements.filter((e) => e.name === 'li' && e.attrs.has('data-node'));
    expect(items.map((e) => e.attrs.get('data-node')).sort()).toEqual([...picture.nodeIds].sort());
    for (const node of inside) {
      const item = items.find((e) => e.attrs.get('data-node') === node.id);
      if (!item) throw new Error(`${node.id} is not listed`);
      expect(listedIn(elements, item), node.id).toBeUndefined();
      expect(elements[item.parent]?.attrs.get('class')).toBe('boxes');
    }
  });

  it('a closed group says what is inside it, a box without lines its counts', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'domains');
    const picture = mapSvg({ flow, scheme: 'light', title: 't', description: 'd' });
    const elements = check(mapHtml({ ...TEXTS, picture, flow, scheme: 'light' }), picture.svg);
    let closed = 0;
    let counted = 0;
    for (const node of flow.nodes) {
      if (node.type === 'band') continue;
      const item = elements.find((e) => e.name === 'li' && e.attrs.get('data-node') === node.id);
      if (!item) throw new Error(`${node.id} is not listed`);
      const notes = elements
        .filter((e) => e.parent === item.index && e.name === 'small')
        .map((e) => e.text);
      const says = `(${PAGE_TEXTS.closed}${node.data.childNames.join(', ')})`;
      const isClosed = node.data.collapsed && node.data.childNames.length > 0;
      expect(notes.includes(says), node.id).toBe(isClosed);
      expect(
        notes.some((note) => note.includes(PAGE_TEXTS.closed)),
        node.id,
      ).toBe(isClosed);
      if (isClosed) closed += 1;
      const counts = node.data.badge ? `· ${workItemCountsText(node.data.badge)}` : undefined;
      expect(notes.at(-1) === counts, node.id).toBe(counts !== undefined);
      if (counts !== undefined) counted += 1;
    }
    expect(closed).toBeGreaterThan(0);
    expect(counted).toBeGreaterThan(0);
  });
});

describe('what is not a picture of mapSvg', () => {
  it('is refused', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'domains');
    const picture = mapSvg({ flow, scheme: 'light', title: 't', description: 'd' });
    const page = (svg: string): MapPage => ({
      ...TEXTS,
      picture: { ...picture, svg },
      flow,
      scheme: 'light',
    });
    const refused = 'not a picture written by mapSvg';
    expect(() => mapHtml(page('<svg><script>alert(1)</script></svg>'))).toThrow(refused);
    expect(() => mapHtml(page(picture.svg.replace('</svg>', '<script>x</script></svg>')))).toThrow(
      refused,
    );
    expect(() => mapHtml(page(picture.svg.replace('</svg>', '<SCRIPT>x</SCRIPT></svg>')))).toThrow(
      refused,
    );
    expect(() =>
      mapHtml(page(picture.svg.replace('</svg>', '<foreignObject>x</foreignObject></svg>'))),
    ).toThrow(refused);
    expect(() => mapHtml(page('<p>hello</p>'))).toThrow(refused);
    expect(() => mapHtml(page(` ${picture.svg}`))).toThrow(refused);
    expect(() => mapHtml(page(picture.svg))).not.toThrow();
  });
});

// --- What the page says, line by line ------------------------------------------------------------
// The picture inside the page says "open work item" and the names too (its tooltips and texts):
// these tests read the list and the table themselves, element by element.

describe('what the list, the table and the style sheet of the page say', () => {
  it('a box is listed with its name, level, description and what its lenses say', async () => {
    const { model, overlay, flow } = await buildMap(exampleYaml, fixtureJson, 'components');
    const lenses = { heat: heatByWork(model, overlay), progress: progressByNode(model, overlay) };
    const picture = mapSvg({ flow, scheme: 'light', lenses, title: 't', description: 'd' });
    const elements = read(mapHtml({ ...TEXTS, picture, flow, lenses, scheme: 'light' }));
    let described = 0;
    let hot = 0;
    let measured = 0;
    for (const node of flow.nodes) {
      if (node.type === 'band') continue;
      const item = elements.find((e) => e.name === 'li' && e.attrs.get('data-node') === node.id);
      if (!item) throw new Error(`${node.id} is not listed`);
      const parts = elements.filter((e) => e.parent === item.index);
      const link = parts.find((e) => e.name === 'a');
      expect(link?.text, node.id).toBe(node.data.name);
      expect(link?.attrs.get('href')).toBe(`#${nodeElementId(node.id)}`);
      const notes = parts.filter((e) => e.name === 'small').map((e) => e.text);
      expect(notes[0], node.id).toBe(node.data.levelName);
      if (node.data.description !== undefined) {
        expect(item.text, node.id).toContain(` — ${node.data.description}`);
        described += 1;
      } else {
        expect(item.text, node.id).not.toContain('—');
      }
      const heat = lenses.heat.get(node.id);
      const progress = lenses.progress.get(node.id);
      const said = notes.slice(1).join(' ');
      expect(said.includes(heat ? heatStripTitle(heat) : 'open work item'), node.id).toBe(
        heat !== undefined,
      );
      expect(said.includes(progress ? progressBarTitle(progress) : ' done ('), node.id).toBe(
        progress !== undefined,
      );
      if (heat) hot += 1;
      if (progress) measured += 1;
    }
    expect([described, hot, measured].every((count) => count > 0)).toBe(true);
  });

  it('a box that draws its work items lists them line by line', async () => {
    let lists = 0;
    let cut = 0;
    for (const { flow } of [
      await buildMap(exampleYaml, fixtureJson, 'detail'),
      await buildMap(SMALL_YAML, SMALL_ITEMS, 'detail'),
    ]) {
      const picture = mapSvg({ flow, scheme: 'light', title: 't', description: 'd' });
      const elements = read(mapHtml({ ...TEXTS, picture, flow, scheme: 'light' }));
      for (const node of flow.nodes) {
        if (node.type === 'band') continue;
        const item = elements.find((e) => e.name === 'li' && e.attrs.get('data-node') === node.id);
        if (!item) throw new Error(`${node.id} is not listed`);
        const list = elements.filter(
          (e) => e.parent === item.index && e.attrs.get('class') === 'workitems',
        );
        const lines = node.data.workItems?.lines;
        expect(list, node.id).toHaveLength(lines ? 1 : 0);
        if (!lines) continue;
        lists += 1;
        const entries = elements.filter((e) => e.parent === list[0]?.index);
        expect(entries.map((e) => e.name)).toEqual(lines.map(() => 'li'));
        const said = entries.map((entry) => [
          entry.text,
          ...elements.filter((e) => e.parent === entry.index).map((e) => `${e.name} ${e.text}`),
        ]);
        expect(said, node.id).toEqual(
          lines.map((line) =>
            line.kind === 'more'
              ? [line.text]
              : [
                  `${line.item.type} #${line.item.id}: ${line.item.title} `,
                  `small (${line.item.state})`,
                ],
          ),
        );
        if (lines.some((line) => line.kind === 'more')) cut += 1;
        // The lines say the work items: the counts of a badge are not repeated beside them.
        const notes = elements.filter((e) => e.parent === item.index && e.name === 'small');
        expect(notes.map((e) => e.text)).toEqual([node.data.levelName]);
      }
    }
    expect(lists).toBeGreaterThan(1);
    expect(cut).toBe(1);
  });

  it('a list that is cut says what is left out, and edges drawn as one line share a cell', async () => {
    const { flow } = await buildMap(SMALL_YAML, SMALL_ITEMS, 'detail');
    const picture = mapSvg({ flow, scheme: 'light', title: 't', description: 'd' });
    const elements = check(mapHtml({ ...TEXTS, picture, flow, scheme: 'light' }), picture.svg);
    const list = elements.find((e) => e.attrs.get('class') === 'workitems');
    expect(elements[list?.parent ?? -1]?.attrs.get('data-node')).toBe('a.x');
    const entries = elements.filter((e) => e.parent === list?.index).map((e) => e.text);
    expect(entries).toHaveLength(WORK_ITEM_GEOMETRY.maxLines);
    expect(entries[0]).toBe('User Story #1: Story 1 ');
    expect(entries.at(-1)).toBe(moreLinesText(12 - (WORK_ITEM_GEOMETRY.maxLines - 1)));
    expect(elements.filter((e) => e.name === 'td').map((e) => e.text)).toEqual([
      'X',
      'Y',
      'dataflow',
      'orders [REST]; refunds',
    ]);
    // Three edges drawn as one line: every label in the one cell, none on a line of its own.
    const three = {
      nodes: flow.nodes,
      edges: flow.edges.map((e) => ({
        ...e,
        data: { ...e.data, count: 3, labels: ['orders [REST]', 'refunds', 'returns'] },
      })),
    };
    const cells = read(mapHtml({ ...TEXTS, picture, flow: three, scheme: 'light' }))
      .filter((e) => e.name === 'td')
      .map((e) => e.text);
    expect(cells.at(-1)).toBe('orders [REST]; refunds; returns');
  });

  it('a box says of its marks what the picture draws: lines in place of their count, and nothing inside a box that names nothing', async () => {
    const { flow } = await buildMap(SMALL_YAML, SMALL_ITEMS, 'detail');
    const picture = mapSvg({ flow, scheme: 'light', title: 't', description: 'd' });
    // A box with lines that is given a badge too, and a closed box without a name inside it.
    const odd = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) => {
        if (n.type === 'band') return n;
        if (n.id === 'a.x')
          return { ...n, data: { ...n.data, badge: { stories: 12, openBugs: 1 } } };
        if (n.id === 'a.y') return { ...n, data: { ...n.data, collapsed: true, childNames: [] } };
        return n;
      }),
    };
    const elements = check(mapHtml({ ...TEXTS, picture, flow: odd, scheme: 'light' }), picture.svg);
    for (const id of ['a.x', 'a.y']) {
      const item = elements.find((e) => e.name === 'li' && e.attrs.get('data-node') === id);
      if (!item) throw new Error(`${id} is not listed`);
      const notes = elements.filter((e) => e.parent === item.index && e.name === 'small');
      expect(
        notes.map((e) => e.text),
        id,
      ).toEqual(['component']);
    }
    expect(elements.filter((e) => e.attrs.get('class') === 'workitems')).toHaveLength(1);
  });

  it('an edge is a row of its two ends, its kind and its label — at a level that draws no label too', async () => {
    let labelled = 0;
    for (const level of ['components', 'detail'] as const) {
      const { flow } = await buildMap(exampleYaml, undefined, level);
      const picture = mapSvg({ flow, scheme: 'light', title: 't', description: 'd' });
      const elements = read(mapHtml({ ...TEXTS, picture, flow, scheme: 'light' }));
      const names = new Map(flow.nodes.map((n) => [n.id, n.type === 'band' ? '' : n.data.name]));
      for (const edge of flow.edges) {
        const row = elements.find(
          (e) => e.name === 'tr' && unescapeXml(e.attrs.get('data-edge') ?? '') === edge.id,
        );
        if (!row) throw new Error(`${edge.id} has no row`);
        const label = (flowEdgeLabel({ ...edge.data, labelShown: true }) ?? '').replace(
          /\n/g,
          '; ',
        );
        expect(
          elements.filter((e) => e.parent === row.index).map((e) => e.text),
          edge.id,
        ).toEqual([names.get(edge.source), names.get(edge.target), edge.data.kind, label]);
        // An edge from a box to itself would hide a swap of the two ends.
        expect(edge.source).not.toBe(edge.target);
        if (label !== '' && flowEdgeLabel(edge.data) === undefined) labelled += 1;
      }
    }
    // Labels the picture does not draw (a single edge below the Everything level) are in the table.
    expect(labelled).toBeGreaterThan(0);
  }, 60_000);

  it('the style sheet has the rules the page works by, in the colours of its scheme', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'domains');
    const css = (scheme: ColorScheme) => {
      const picture = mapSvg({ flow, scheme, title: 't', description: 'd' });
      const style = read(mapHtml({ ...TEXTS, picture, flow, scheme })).find(
        (e) => e.name === 'style',
      );
      return style?.text ?? '';
    };
    for (const scheme of COLOR_SCHEMES) {
      const p = PICTURE_PALETTE[scheme];
      const text = css(scheme);
      // "Fit the width": the checkbox before the region, and this one rule.
      expect(text).toContain('#fit:checked~.map svg{width:100%;height:auto}');
      // A link of the list marks its box.
      expect(text).toContain(
        `.map g:target rect[data-part="box"]{stroke:${p.nodeSelected};stroke-width:4px}`,
      );
      expect(text).toContain(`html{color-scheme:${scheme};`);
      expect(text).toContain(`background:${p.bg};color:${p.fg}`);
      expect(text).toContain(`.note,small{color:${p.muted}}`);
      expect(text).toContain(`border:1px solid ${p.border}`);
      expect(text).toContain('.map{overflow:auto;max-height:85vh;');
      expect(text).toContain(
        '@media print{.fit{display:none}.map{overflow:visible;max-height:none;border:0}.map svg{width:100%;height:auto}}',
      );
      expect(text).not.toMatch(/[<>]/);
      expect(text).not.toMatch(/url\(|@import|expression\(/);
    }
    // The two schemes differ in their colours, not only in what the scheme is called: each page
    // has the page colour of its own scheme and not that of the other.
    const colours = (scheme: ColorScheme) => css(scheme).replace(`color-scheme:${scheme};`, '');
    expect(css('light')).not.toBe(colours('light'));
    expect(colours('light')).not.toBe(colours('dark'));
    for (const [scheme, other] of [
      ['light', 'dark'],
      ['dark', 'light'],
    ] as const) {
      expect(css(scheme)).toContain(`background:${PICTURE_PALETTE[scheme].bg};`);
      expect(css(scheme)).not.toContain(`background:${PICTURE_PALETTE[other].bg};`);
    }
    // The picture has what the two rules select: a group with the `id` a link names, and in it
    // the rectangle of its box.
    const picture = mapSvg({ flow, scheme: 'light', title: 't', description: 'd' });
    const elements = readXml(picture.svg);
    for (const id of picture.nodeIds) {
      const group = elements.find((e) => e.attrs.get('id') === nodeElementId(id));
      expect(group?.name, id).toBe('g');
      expect(
        elements.filter(
          (e) =>
            e.parent === group?.index && e.name === 'rect' && e.attrs.get('data-part') === 'box',
        ),
        id,
      ).toHaveLength(1);
    }
  });
});
