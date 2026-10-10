// The pages as text: reading the start tags of rendered markup, the few changes made to it after
// rendering, the wrapper of a specimen, the document around a page, and the check that a page is
// nothing but markup and styles. Pure functions of text.
//
// What is read is markup as React writes it and as this file writes it; a start tag is read as
// HTML reads one (quoted and unquoted values, entities in values), and the text of a `<style>`,
// `<script>`, `<title>` or `<textarea>` element is not looked into for tags.

import { DARK_ROOT, DARK_SCOPE } from './stylesheet';

// --- Text and attribute values ----------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
};

function unescaped(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(quot|amp|lt|gt|apos));/gi,
    (_all, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
      return ENTITIES[(name ?? '').toLowerCase()] ?? '';
    },
  );
}

/** `text` as the content of an element or the value of a quoted attribute, as React escapes it. */
function escaped(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Start tags -------------------------------------------------------------------------------

interface ScannedAttribute {
  readonly name: string;
  /** The value, entities resolved; empty for an attribute without one. */
  readonly value: string;
  /** The attribute as it is written. */
  readonly raw: string;
}

interface ScannedTag {
  readonly name: string;
  readonly attributes: readonly ScannedAttribute[];
  /** Where the tag starts (its `<`) and where it ends (after its `>`). */
  readonly start: number;
  readonly end: number;
  readonly selfClosing: boolean;
}

/** Elements whose content is text even where it looks like a tag. */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['style', 'script', 'title', 'textarea']);

const TAG_NAME = /[A-Za-z][^\s/>]*/y;
const ATTRIBUTE = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
const TAG_END = /\s*(\/?)>/y;

/** The start tags of `html` in document order, with where each stands. */
function scannedTags(html: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  let at = 0;
  for (;;) {
    const start = html.indexOf('<', at);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const close = html.indexOf('-->', start + 4);
      at = close < 0 ? html.length : close + 3;
      continue;
    }
    TAG_NAME.lastIndex = start + 1;
    const name = TAG_NAME.exec(html)?.[0];
    if (name === undefined) {
      // An end tag, the doctype, or a `<` of the text.
      at = start + 1;
      continue;
    }
    let cursor = TAG_NAME.lastIndex;
    const attributes: ScannedAttribute[] = [];
    for (;;) {
      ATTRIBUTE.lastIndex = cursor;
      const found = ATTRIBUTE.exec(html);
      if (!found) break;
      attributes.push({
        name: found[1] ?? '',
        value: unescaped(found[2] ?? found[3] ?? found[4] ?? ''),
        raw: found[0].trimStart(),
      });
      cursor = ATTRIBUTE.lastIndex;
    }
    TAG_END.lastIndex = cursor;
    const tagEnd = TAG_END.exec(html);
    if (!tagEnd) {
      // Not a tag after all (`a <b` in a text): go on behind the `<`.
      at = start + 1;
      continue;
    }
    at = TAG_END.lastIndex;
    tags.push({ name, attributes, start, end: at, selfClosing: tagEnd[1] === '/' });
    if (TEXT_ELEMENTS.has(name.toLowerCase())) {
      const close = html.slice(at).search(new RegExp(`</${name}[\\s/>]`, 'i'));
      at = close < 0 ? html.length : at + close;
    }
  }
  return tags;
}

/** The value of attribute `name` of `tag`, as HTML takes it: the first one written. */
function attributeOf(tag: ScannedTag, name: string): string | undefined {
  return tag.attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

export interface StartTag {
  /** The name of the element as written. */
  readonly name: string;
  /** Its attributes by name as written, the values with their entities resolved. */
  readonly attributes: ReadonlyMap<string, string>;
}

/**
 * The start tags of `html` in document order: what the classes, IDs and attributes of a page are
 * read from. Nothing is taken from inside a `<style>` block (the tag of the block itself is one
 * of them). An attribute without a value has the empty string.
 */
export function startTags(html: string): StartTag[] {
  return scannedTags(html).map((tag) => {
    const attributes = new Map<string, string>();
    for (const { name, value } of tag.attributes) {
      if (!attributes.has(name)) attributes.set(name, value);
    }
    return { name: tag.name, attributes };
  });
}

// --- Changes to rendered markup ---------------------------------------------------------------

/**
 * `html` with `content` put into its one empty `<div class="className"></div>`; throws when
 * there is not exactly one.
 */
export function fillContainer(html: string, className: string, content: string): string {
  const empty = `<div class="${className}"></div>`;
  const parts = html.split(empty);
  if (parts.length !== 2) {
    throw new Error(
      `Expected one empty <div class="${className}">, found ${String(parts.length - 1)}`,
    );
  }
  return `${parts[0] ?? ''}<div class="${className}">${content}</div>${parts[1] ?? ''}`;
}

/**
 * `html` without the handles of its boxes: every empty `<div data-handleid=…></div>`. They are
 * invisible, and close to half of the markup of a canvas.
 */
export function withoutHandles(html: string): string {
  return html.replace(/<div data-handleid="[^"]*"[^>]*><\/div>/g, '');
}

/** What {@link markElement} does to a start tag. */
export interface ElementChange {
  /** A class to add to those the element has. */
  readonly addClass?: string;
  /** Attributes to set, by name: added, or given another value. */
  readonly set?: Readonly<Record<string, string>>;
  /** Attributes to take away. */
  readonly remove?: readonly string[];
}

/**
 * `html` with the start tag of its one element with the ID `id` changed. Only the tag changes:
 * no element and no text is added. Throws when the ID is not there exactly once.
 */
export function markElement(html: string, id: string, change: ElementChange): string {
  const found = scannedTags(html).filter((tag) => attributeOf(tag, 'id') === id);
  const [tag] = found;
  if (!tag || found.length !== 1) {
    throw new Error(`Expected one element with the ID "${id}", found ${String(found.length)}`);
  }
  const removed = new Set(change.remove);
  const values = new Map(Object.entries(change.set ?? {}));
  if (change.addClass !== undefined) {
    const classes = values.get('class') ?? attributeOf(tag, 'class') ?? '';
    values.set('class', classes === '' ? change.addClass : `${classes} ${change.addClass}`);
  }
  const written = (name: string, value: string): string => `${name}="${escaped(value)}"`;
  const attributes: string[] = [];
  for (const { name, raw } of tag.attributes) {
    if (removed.has(name)) continue;
    const value = values.get(name);
    attributes.push(value === undefined ? raw : written(name, value));
    values.delete(name);
  }
  for (const [name, value] of values) {
    if (!removed.has(name)) attributes.push(written(name, value));
  }
  const startTag = `<${[tag.name, ...attributes].join(' ')}${tag.selfClosing ? '/>' : '>'}`;
  return html.slice(0, tag.start) + startTag + html.slice(tag.end);
}

// --- A specimen -------------------------------------------------------------------------------

/**
 * How a specimen stands on its page: a `panel` or a `canvas` in a stage laid out like the frame
 * of the app, a `block` in a plain one, a `screen` as the whole app.
 */
export type SpecimenKind = 'panel' | 'canvas' | 'block' | 'screen';

export interface SpecimenSection {
  /** The slug of the specimen: the section gets the ID `tpl-<id>`. */
  readonly id: string;
  readonly kind: SpecimenKind;
  /** The label. */
  readonly title: string;
  /** The states that show by the pointer or the keyboard only, said beside the label. */
  readonly states?: string | undefined;
  /** One sentence: what it is and when the app shows it. */
  readonly note: string;
  /** Size of the stage in pixels; a side left out is as large as its content. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** The stage stands for a narrow window (the class `tpl-narrow`). */
  readonly narrow?: boolean | undefined;
  /** The app's markup, as rendered. */
  readonly html: string;
}

/**
 * A specimen on its page: label, note, and the app's markup in a stage (`div.tpl-stage`) of the
 * stated size — for a screen in `section.tpl-screen-section` › `div.tpl-screen`. Title, states
 * and note are text; `html` is put in as it is.
 */
export function specimenSection(specimen: SpecimenSection): string {
  const { id, kind, title, states, note, width, height, narrow, html } = specimen;
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Not a specimen ID: "${id}"`);
  const screen = kind === 'screen';
  const size = [
    ...(width === undefined ? [] : [`width:${String(width)}px`]),
    ...(height === undefined ? [] : [`height:${String(height)}px`]),
  ].join(';');
  const stage = `${screen ? 'tpl-screen' : 'tpl-stage'}${narrow === true ? ' tpl-narrow' : ''}`;
  const label =
    states === undefined || states === ''
      ? escaped(title)
      : `${escaped(title)} <span class="tpl-states">${escaped(states)}</span>`;
  return [
    `<section class="${screen ? 'tpl-screen-section' : 'tpl-specimen'}" id="tpl-${id}" data-kind="${kind}">`,
    `<h3 class="tpl-label">${label}</h3>`,
    `<p class="tpl-note">${escaped(note)}</p>`,
    `<div class="${stage}"${size === '' ? '' : ` style="${size}"`}>${html}</div>`,
    '</section>',
  ].join('\n');
}

// --- A page -----------------------------------------------------------------------------------

const withoutCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The selector under which the library keeps its dark values. */
const LIBRARY_DARK = '.react-flow.dark';

/**
 * The rule that gives React Flow's own colours (controls, minimap, background dots) their dark
 * values in a page: the declarations of the `.react-flow.dark` rule of `libraryCss`, for
 * `.react-flow` in the dark scope. (In the app the library puts the class `dark` on the element;
 * rendered without a browser it is `light`, always.) It weighs what the library's own
 * `.react-flow` rule weighs. Throws when the library has not exactly one such rule.
 */
export function darkLibraryRule(libraryCss: string): string {
  // Every innermost block with what stands before it: a rule and its selector.
  const found = [...withoutCssComments(libraryCss).matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(
    (rule) => (rule[1] ?? '').trim() === LIBRARY_DARK,
  );
  const [rule] = found;
  if (!rule || found.length !== 1) {
    throw new Error(`Expected one rule "${LIBRARY_DARK}", found ${String(found.length)}`);
  }
  const declarations = (rule[2] ?? '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '');
  if (declarations.length === 0) throw new Error(`The rule "${LIBRARY_DARK}" declares nothing`);
  return `${DARK_SCOPE} .react-flow {\n${declarations.map((declaration) => `  ${declaration};\n`).join('')}}`;
}

export interface PageParts {
  /** The title of the document, as text. */
  readonly title: string;
  /** The stylesheet of @xyflow/react, as shipped. */
  readonly libraryCss: string;
  /** The app's stylesheet as it is to stand in the page: with its conditions as scopes. */
  readonly appCss: string;
  /** The page's own stylesheet; the three rules that follow it are added here. */
  readonly pageCss: string;
  /** What follows the scheme switch in the body, as markup. */
  readonly body: string;
  /** Dark by the class `tpl-dark` on the root, and without the switch. */
  readonly dark?: boolean | undefined;
}

/** The text of a style block; a stylesheet that would end the block is refused. */
function styleBlock(css: string): string {
  if (/<\/style/i.test(css)) throw new Error('A stylesheet must not contain "</style"');
  return `<style>${css}</style>`;
}

/**
 * A page as one self-contained document: the three style blocks in the order the app loads its
 * styles — the library's, the app's between its two marker comments, the page's own —, and the
 * body, which starts with the scheme switch unless the page is `dark`.
 *
 * The page's block ends with three rules of its own: the colour scheme of the root for light
 * and for dark (form controls and scroll bars then follow the page, not the system), and
 * {@link darkLibraryRule}. `appCss` stands between the markers so that `appStylesheetOf` gives
 * it back as it was put in.
 */
export function pageDocument({
  title,
  libraryCss,
  appCss,
  pageCss,
  body,
  dark,
}: PageParts): string {
  const generated = [
    ':root { color-scheme: light }',
    `${DARK_ROOT} { color-scheme: dark; background: var(--bg); color: var(--fg) }`,
    darkLibraryRule(libraryCss),
  ].join('\n');
  // The reading takes off the line break after the first marker, and an empty line before the
  // second: a stylesheet that ends with a line break gets one more, so that it ends with it.
  const app = appCss.endsWith('\n') ? `${appCss}\n` : appCss;
  const switched =
    dark === true
      ? ''
      : '<input type="checkbox" id="tpl-dark" class="tpl-switch" aria-label="Dark scheme" />\n' +
        '<label for="tpl-dark" class="tpl-switch-label">Dark scheme</label>\n';
  return [
    '<!doctype html>',
    dark === true ? '<html lang="en" class="tpl-dark">' : '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="icon" href="data:,">',
    `<title>${escaped(title)}</title>`,
    styleBlock(
      `/* tpl:library @xyflow/react dist/style.css — as shipped, not to be changed */\n${libraryCss}`,
    ),
    styleBlock(
      `/* tpl:app-stylesheet:begin — src/ui/styles.css; the block to restyle */\n${app}/* tpl:app-stylesheet:end */`,
    ),
    styleBlock(
      `/* tpl:page — the page's own; every selector starts with .tpl- or #tpl- */\n${pageCss}\n${generated}\n`,
    ),
    '</head>',
    '<body>',
    `${switched}${body}`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// --- Nothing but markup and styles ------------------------------------------------------------

/** Elements that run or load something. */
const LOADING_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'img',
  'image',
  'iframe',
  'frame',
  'object',
  'embed',
  'base',
  'video',
  'audio',
  'source',
  'track',
]);

/** The addresses of `css` that are not a reference into the page itself (`url(#…)`). */
function loadedByStyle(css: string): string[] {
  const text = withoutCssComments(css);
  const found = /@import\b/i.test(text) ? ['@import'] : [];
  for (const [url, address] of text.matchAll(/url\(\s*([^)]*)\)/gi)) {
    if (!/^["']?#/.test(address ?? '')) found.push(url);
  }
  return found;
}

/**
 * What in the page `html` is more than markup and styles, one line each; empty for a page that
 * runs nothing and loads nothing:
 * - an element that runs or loads something (`script`, `img`, `iframe`, `object`, `embed`,
 *   `base`, a media element), a `link` other than the empty page icon, a `meta http-equiv`;
 * - an attribute that is a handler (`on…`), a `src` or `srcset`, a `javascript:` address;
 * - `@import`, or a `url(…)` that is not a reference into the page (`url(#…)`), in a style
 *   block or a `style` attribute.
 * A link a person may follow (`a href`) is none of these: nothing is loaded from it.
 */
export function staticProblems(html: string): string[] {
  const problems: string[] = [];
  for (const tag of scannedTags(html)) {
    const element = tag.name.toLowerCase();
    if (LOADING_ELEMENTS.has(element)) problems.push(`<${element}> element`);
    if (
      element === 'link' &&
      !(attributeOf(tag, 'rel') === 'icon' && attributeOf(tag, 'href') === 'data:,')
    ) {
      problems.push(`<link> other than the empty page icon: ${attributeOf(tag, 'href') ?? ''}`);
    }
    if (element === 'meta' && attributeOf(tag, 'http-equiv') !== undefined) {
      problems.push(`<meta http-equiv="${attributeOf(tag, 'http-equiv') ?? ''}">`);
    }
    for (const attribute of tag.attributes) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) problems.push(`Handler ${name} on <${element}>`);
      if (name === 'src' || name === 'srcset') problems.push(`${name} on <${element}>`);
      if (/^\s*javascript:/i.test(attribute.value)) {
        problems.push(`javascript: address in ${name} on <${element}>`);
      }
      if (name === 'style') {
        for (const loaded of loadedByStyle(attribute.value)) {
          problems.push(`${loaded} in the style of <${element}>`);
        }
      }
    }
    if (element === 'style') {
      const close = html.slice(tag.end).search(/<\/style[\s/>]/i);
      const css = close < 0 ? html.slice(tag.end) : html.slice(tag.end, tag.end + close);
      for (const loaded of loadedByStyle(css)) problems.push(`${loaded} in a style block`);
    }
  }
  return problems;
}
