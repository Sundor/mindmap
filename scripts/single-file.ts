// Build step that makes dist/viewer.html one page that works on its own and cannot reach out:
// - the bundled script and stylesheet are put into the HTML file itself;
// - the page gets a Content Security Policy: only the code of this build runs — no script file
//   at all, the data are YAML and JSON — and nothing is loaded from, or sent to, another place;
// - the third-party notices are appended, so the file carries them wherever it is copied;
// - the build fails if the page loads a script file or refers to another server.
//
// The functions are pure and exported for the tests; `singleOfflineFile()` is the Vite plugin.

import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** A start tag of the page, with the text inside it for the elements whose content is not HTML. */
export interface HtmlElement {
  /** Tag name in lower case. */
  readonly name: string;
  /** Attribute values by name (lower case); empty for an attribute without a value. */
  readonly attributes: ReadonlyMap<string, string>;
  /** The content of a `script`, `style`, `title` or `textarea` element. */
  readonly text?: string;
}

const TAG_NAME = /<([a-zA-Z][^\s/>]*)/y;
const ATTRIBUTE = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
/** Elements whose content the browser does not read as HTML: a `<` in it starts no tag. */
const TEXT_ELEMENTS = new Set(['script', 'style', 'title', 'textarea']);

/**
 * The start tags of `html` in document order, the way a browser finds them: comments and the
 * content of scripts and styles are skipped, so a `<script` inside the bundled code is no tag.
 */
export function htmlElements(html: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  let at = 0;
  for (;;) {
    const open = html.indexOf('<', at);
    if (open < 0) break;
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    TAG_NAME.lastIndex = open;
    const tag = TAG_NAME.exec(html);
    if (!tag?.[1]) {
      at = open + 1;
      continue;
    }
    const name = tag[1].toLowerCase();
    const attributes = new Map<string, string>();
    let cursor = TAG_NAME.lastIndex;
    for (;;) {
      ATTRIBUTE.lastIndex = cursor;
      const attribute = ATTRIBUTE.exec(html);
      if (!attribute?.[1]) break;
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      if (!attributes.has(attribute[1].toLowerCase())) {
        attributes.set(attribute[1].toLowerCase(), value);
      }
      cursor = ATTRIBUTE.lastIndex;
    }
    const close = html.indexOf('>', cursor);
    if (close < 0) break;
    at = close + 1;
    if (!TEXT_ELEMENTS.has(name)) {
      found.push({ name, attributes });
      continue;
    }
    const endTag = new RegExp(`</${name}[\\s/>]`, 'gi');
    endTag.lastIndex = at;
    const end = endTag.exec(html);
    const stop = end ? end.index : html.length;
    found.push({ name, attributes, text: html.slice(at, stop) });
    const after = html.indexOf('>', stop);
    at = after < 0 ? html.length : after + 1;
  }
  return found;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `code` as the text of an inline script. Inside a script the browser still looks for the end
 * tag and for a comment start, wherever they are — in a string as well — so both are written
 * with an escape that means the same to JavaScript.
 */
export function inlineScriptText(code: string): string {
  return code.trim().replace(/<(\/script|!--)/gi, '\\x3C$1');
}

/**
 * `html` with the module script that loads `fileName` replaced by the code itself; undefined
 * when the page has no such script.
 */
export function inlineScript(html: string, fileName: string, code: string): string | undefined {
  const reference = new RegExp(
    `<script\\b(?=[^>]*\\stype="module")[^>]*\\ssrc="(?:[^"]*/)?${escapeRegExp(fileName)}"[^>]*></script>`,
  );
  if (!reference.test(html)) return undefined;
  // A function, so that `$&` and the like in the code are not taken for replacement patterns.
  return html.replace(reference, () => `<script type="module">${inlineScriptText(code)}</script>`);
}

/**
 * `html` with the stylesheet link to `fileName` replaced by the styles themselves; undefined
 * when the page has no such link.
 */
export function inlineStyle(html: string, fileName: string, css: string): string | undefined {
  const reference = new RegExp(`<link\\b[^>]*\\shref="(?:[^"]*/)?${escapeRegExp(fileName)}"[^>]*>`);
  if (!reference.test(html)) return undefined;
  if (/<\/style/i.test(css))
    throw new Error(`${fileName} contains "</style" and cannot be inlined`);
  const text = css.replace('@charset "UTF-8";', '').trim();
  return html.replace(reference, () => `<style>${text}</style>`);
}

/** True for a script element whose own text is run as JavaScript. */
function isInlineScript(element: HtmlElement): boolean {
  if (element.name !== 'script' || element.attributes.has('src')) return false;
  const type = (element.attributes.get('type') ?? '').trim().toLowerCase();
  return type === '' || type === 'module' || /^(text|application)\/(java|ecma)script$/.test(type);
}

/**
 * The hash source by which a Content Security Policy allows the inline script with this text.
 * Browsers hash the text after reading the file, when every line break has become a line feed:
 * the same is done here, so that a copy whose line endings were converted still runs.
 */
export function scriptHash(text: string): string {
  const read = text.replace(/\r\n?/g, '\n');
  return `sha256-${createHash('sha256').update(read, 'utf8').digest('base64')}`;
}

/**
 * The policy of the built viewer. Everything is forbidden, then allowed again one by one:
 * - scripts: the inline code of this build, by hash, and nothing else: no script file (not even
 *   one next to the page — the data are YAML and JSON, which are read and never run), no
 *   `eval`, no other inline script;
 * - styles: inline only (the build inlines the stylesheet, and the canvas sets inline styles);
 * - images: `data:` only (the empty page icon);
 * - `fetch`: the page's own server only — the data files when it is served over HTTP;
 * - no fonts, frames, workers, media, plug-ins, forms or `<base>`.
 */
export function contentSecurityPolicy(scriptHashes: readonly string[]): string {
  const hashes = scriptHashes.map((hash) => `'${hash}'`);
  return [
    "default-src 'none'",
    ['script-src', ...(hashes.length > 0 ? hashes : ["'none'"])].join(' '),
    "style-src 'unsafe-inline'",
    'img-src data:',
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * `html` with the policy as a `<meta>` right after the charset declaration: ahead of every
 * script and style, since a policy only governs what comes after it.
 */
export function withPolicy(html: string): string {
  const elements = htmlElements(html);
  const declared = elements.some(
    (element) =>
      element.name === 'meta' &&
      element.attributes.get('http-equiv')?.toLowerCase() === 'content-security-policy',
  );
  if (declared) throw new Error('the page already declares a Content Security Policy');
  const first = elements.find((element) => element.name !== 'html' && element.name !== 'head');
  const charset = /<meta\s+charset=[^>]*>/i.exec(html);
  if (!charset || first?.name !== 'meta' || !first.attributes.has('charset')) {
    throw new Error('the page must start with <meta charset>: the policy goes right after it');
  }
  const hashes = [...new Set(elements.filter(isInlineScript).map((e) => scriptHash(e.text ?? '')))];
  const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(hashes)}" />`;
  const at = charset.index + charset[0].length;
  return `${html.slice(0, at)}\n    ${meta}${html.slice(at)}`;
}

/**
 * The script files the page loads (`<script src>`), by address. The built viewer has none: its
 * code is inlined and the policy lets no script file run, so one that is left would be dead.
 */
export function scriptFiles(html: string): string[] {
  return htmlElements(html)
    .filter((element) => element.name === 'script' && element.attributes.has('src'))
    .map((element) => element.attributes.get('src') ?? '');
}

/** True for an address on another server: one with a scheme (other than `data:`) or a host. */
function isElsewhere(address: string): boolean {
  const value = address.trim();
  if (/^data:/i.test(value)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[/\\]{2}/.test(value);
}

const ADDRESS_ATTRIBUTES = [
  'src',
  'href',
  'data',
  'poster',
  'action',
  'formaction',
  'manifest',
  'ping',
];

/**
 * What in the markup and the styles of `html` points to another server, as readable snippets;
 * empty for a page that is on its own. (Scripts are not read: what they may load is the
 * policy's business.)
 */
export function outsideReferences(html: string): string[] {
  const found: string[] = [];
  for (const element of htmlElements(html)) {
    for (const name of ADDRESS_ATTRIBUTES) {
      const value = element.attributes.get(name);
      if (value !== undefined && isElsewhere(value))
        found.push(`<${element.name} ${name}="${value}">`);
    }
    for (const candidate of (element.attributes.get('srcset') ?? '').split(',')) {
      if (isElsewhere(candidate)) found.push(`<${element.name} srcset="${candidate.trim()}">`);
    }
    if (
      element.name === 'meta' &&
      element.attributes.get('http-equiv')?.toLowerCase() === 'refresh'
    ) {
      found.push('<meta http-equiv="refresh">');
    }
    if (element.name === 'style') {
      const css = element.text ?? '';
      for (const match of css.matchAll(/@import\s+[^;]+|url\(\s*["']?([^"')]*)["']?\s*\)/gi)) {
        const target = match[1];
        if (target === undefined || isElsewhere(target)) found.push(`style: ${match[0]}`);
      }
    }
  }
  return found;
}

/**
 * `html` with `notices` (plain text) as a comment after the document, where it changes nothing
 * about the page. A comment ends at `--` followed by `>`: the text is kept from containing it.
 */
export function withNotices(html: string, notices: string): string {
  const text = notices.replace(/--(!?)>/g, '-- $1>').trim();
  return `${html.trimEnd()}\n<!--\n${text}\n-->\n`;
}

/** The parts of a bundle file the plugin uses (Rollup's and Rolldown's types both fit). */
interface BundleFile {
  readonly type: 'asset' | 'chunk';
  readonly fileName: string;
  code?: string;
  source?: string | Uint8Array;
}

const textOf = (source: string | Uint8Array | undefined): string =>
  typeof source === 'string' ? source : Buffer.from(source ?? '').toString('utf8');

/**
 * Vite plugin: one self-contained, offline HTML file per page (see the top of this file).
 * `noticesFile` names a text asset of the build to append as a comment (optional).
 */
export function singleOfflineFile(options: { noticesFile?: string } = {}): Plugin {
  return {
    name: 'single-offline-file',
    apply: 'build',
    enforce: 'post',
    config: () => ({
      build: {
        // One script and one stylesheet to inline, whatever their size, with nothing kept apart.
        assetsInlineLimit: () => true,
        cssCodeSplit: false,
        assetsDir: '',
        chunkSizeWarningLimit: 100_000,
        // Nothing to preload in a single file; the helper would add a `fetch` to the page.
        modulePreload: false,
        rolldownOptions: { output: { codeSplitting: false } },
      },
    }),
    generateBundle(_options, bundle) {
      const files = Object.values(bundle) as BundleFile[];
      const pages = files.filter((file) => file.type === 'asset' && /\.html?$/.test(file.fileName));
      const [page] = pages;
      if (!page || pages.length > 1) {
        this.error(`expected one HTML page, found ${pages.length}`);
      }
      let html = textOf(page.source);
      for (const file of files) {
        let inlined: string | undefined;
        if (file.type === 'chunk') inlined = inlineScript(html, file.fileName, file.code ?? '');
        else if (/\.css$/.test(file.fileName)) {
          inlined = inlineStyle(html, file.fileName, textOf(file.source));
        } else continue;
        if (inlined === undefined) {
          this.error(`${file.fileName} is not loaded by ${page.fileName}: it cannot be inlined`);
        }
        html = inlined;
        delete bundle[file.fileName];
      }
      const loaded = scriptFiles(html);
      if (loaded.length > 0) {
        this.error(
          `${page.fileName} loads script files, which its policy does not let run: ${loaded.join(', ')}`,
        );
      }
      const outside = outsideReferences(html);
      if (outside.length > 0) {
        this.error(`${page.fileName} refers to another server:\n  ${outside.join('\n  ')}`);
      }
      html = withPolicy(html);
      const notices = options.noticesFile === undefined ? undefined : bundle[options.noticesFile];
      if (options.noticesFile !== undefined && notices?.type !== 'asset') {
        this.error(`${options.noticesFile} is not part of the build`);
      }
      if (notices?.type === 'asset') html = withNotices(html, textOf(notices.source));
      page.source = html;
    },
  };
}
