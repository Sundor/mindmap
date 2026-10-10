// The app's stylesheet as text. Two of its conditions cannot be met by a static page that shows
// both schemes and a narrow window at once: they are rewritten as scopes of the page, and back.
// The rules, custom properties and scales are read from the text, and two versions of it are
// compared rule by rule. Pure functions of text.
//
// The scopes add NO specificity (`:where()`), so every rule keeps the weight it has in the app
// and the cascade of the page is the cascade of the app: a later or more specific rule outside
// the condition still wins over a rule inside it, exactly as in the viewer.
//
// What is read: comments, style rules, and `@media` blocks one level deep. A rule inside a rule
// or any other at-rule throws, with the offset where it stands.

const DARK_CONDITION = '(prefers-color-scheme: dark)';

/** Inside a dark part of the page: the whole page while the switch is on, or below `.tpl-dark`. Weighs nothing. */
export const DARK_SCOPE = ':where(:root:has(#tpl-dark:checked), .tpl-dark)';
/** Stands where `:root` stood under the dark condition: the element the dark values are set on. Weighs what `:root` weighs. */
export const DARK_ROOT = `:is(:root, .tpl-dark)${DARK_SCOPE}`;
/** Inside a narrow frame. Weighs nothing. */
export const NARROW_SCOPE = ':where(.tpl-narrow)';

export interface ScopedCondition {
  readonly condition: string;
  readonly scope: string;
  /** What a selector that is exactly `:root` becomes; without it `:root` gets the scope in front like any other. */
  readonly root?: string;
}

/** The conditions rewritten as scopes of the page. */
export const SCOPED_CONDITIONS: readonly ScopedCondition[] = [
  { condition: DARK_CONDITION, scope: DARK_SCOPE, root: DARK_ROOT },
  { condition: '(max-width: 1399.98px)', scope: NARROW_SCOPE },
];
/** Conditions left as they are: they describe the device the page is opened on. */
export const DEVICE_CONDITIONS: readonly string[] = ['(pointer: coarse)'];

const wasMark = (condition: string): string => `@media all /*tpl:was ${condition}*/`;

/** `css` without its comments. */
export const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** `text` on one line: every run of white space one space, none at the ends. */
const collapsed = (text: string): string => text.replace(/\s+/g, ' ').trim();

// --- Scanning ---------------------------------------------------------------

/**
 * The index after the comment or the string that starts at `at`; `at` itself when neither starts
 * there. A quote without its partner on the same line is a character like any other.
 */
function inertEnd(css: string, at: number): number {
  if (css.startsWith('/*', at)) {
    const end = css.indexOf('*/', at + 2);
    if (end < 0) throw new Error(`comment not closed at ${at}`);
    return end + 2;
  }
  const quote = css.charAt(at);
  if (quote !== '"' && quote !== "'") return at;
  for (let i = at + 1; i < css.length; i += 1) {
    const ch = css.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === quote) return i + 1;
    else if (ch === '\n') break;
  }
  return at;
}

/** Index of the next `needle` at or after `from` that is not inside a comment or a string; -1 for none. */
function nextOutside(css: string, needle: string, from: number): number {
  for (let i = from; i < css.length; i += 1) {
    if (css.startsWith(needle, i)) return i;
    const end = inertEnd(css, i);
    if (end > i) i = end - 1;
  }
  return -1;
}

/** Index of the `}` closing the block opened by the `{` at `open`; comments and strings are skipped. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const end = inertEnd(css, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    const ch = css.charAt(i);
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`block not closed at ${open}`);
}

// --- The two conditions as scopes, and back ---------------------------------

/**
 * `prelude` (a selector list with its white space and comments) with every selector mapped. The
 * selectors are separated at the commas outside parentheses, brackets and strings; the white
 * space and the comments around each stay where they are.
 */
function mapPrelude(prelude: string, map: (selector: string) => string): string {
  let out = '';
  let piece = '';
  // Where the selector starts and ends within `piece`: -1 while only white space and comments.
  let first = -1;
  let last = 0;
  let depth = 0;
  const keep = (text: string, selector: boolean): void => {
    if (selector) {
      if (first < 0) first = piece.length;
      last = piece.length + text.length;
    }
    piece += text;
  };
  const flush = (): void => {
    out +=
      first < 0 ? piece : piece.slice(0, first) + map(piece.slice(first, last)) + piece.slice(last);
    piece = '';
    first = -1;
  };
  for (let i = 0; i < prelude.length; i += 1) {
    const end = inertEnd(prelude, i);
    if (end > i) {
      keep(prelude.slice(i, end), !prelude.startsWith('/*', i));
      i = end - 1;
      continue;
    }
    const ch = prelude.charAt(i);
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      flush();
      out += ',';
    } else keep(ch, ch.trim() !== '');
  }
  flush();
  return out;
}

/** The inside of a media block with every selector of every rule mapped. */
function mapSelectors(body: string, map: (selector: string) => string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = nextOutside(body, '{', at);
    if (open < 0) break;
    const close = blockEnd(body, open);
    out += mapPrelude(body.slice(at, open), map) + body.slice(open, close + 1);
    at = close + 1;
  }
  return out + body.slice(at);
}

function rewrite(css: string, forward: boolean): string {
  let out = css;
  for (const { condition, scope, root } of SCOPED_CONDITIONS) {
    const from = forward ? `@media ${condition}` : wasMark(condition);
    const to = forward ? wasMark(condition) : `@media ${condition}`;
    const map = forward
      ? (s: string): string => (root !== undefined && s === ':root' ? root : `${scope} ${s}`)
      : (s: string): string =>
          root !== undefined && s === root
            ? ':root'
            : s.startsWith(`${scope} `)
              ? s.slice(scope.length + 1)
              : s;
    let at = 0;
    for (;;) {
      const start = nextOutside(out, from, at);
      if (start < 0) break;
      const open = nextOutside(out, '{', start + from.length);
      if (open < 0) throw new Error(`media block not opened at ${start}`);
      const close = blockEnd(out, open);
      const block = `${to}${out.slice(start + from.length, open + 1)}${mapSelectors(out.slice(open + 1, close), map)}`;
      out = out.slice(0, start) + block + out.slice(close);
      at = start + block.length;
    }
  }
  return out;
}

/** The app's stylesheet as it stands in a page: the two conditions as scopes of the page. */
export const scoped = (css: string): string => rewrite(css, true);
/**
 * The reverse of {@link scoped}. A selector without the scope inside a rewritten block is left
 * as it is: a rule added there applies under the condition.
 */
export const unscoped = (css: string): string => rewrite(css, false);

// --- Reading the rules ------------------------------------------------------

interface Declaration {
  readonly name: string;
  readonly value: string;
  /** The comment it stands under: the last one on a line of its own before it in its block, else the one on the line above the rule; empty for none. */
  readonly heading: string;
}

interface StyleRule {
  /** The condition of the media block the rule stands in. */
  readonly condition?: string;
  readonly selectors: readonly string[];
  readonly declarations: readonly Declaration[];
}

interface Stylesheet {
  readonly rules: readonly StyleRule[];
  /** The condition of every media block, in order. */
  readonly conditions: readonly string[];
}

/** The selectors of `prelude`, each on one line and without comments. */
function selectorsIn(prelude: string): string[] {
  const found: string[] = [];
  let piece = '';
  let depth = 0;
  for (let i = 0; i < prelude.length; i += 1) {
    const end = inertEnd(prelude, i);
    if (end > i) {
      if (!prelude.startsWith('/*', i)) piece += prelude.slice(i, end);
      i = end - 1;
      continue;
    }
    const ch = prelude.charAt(i);
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      found.push(collapsed(piece));
      piece = '';
    } else piece += ch;
  }
  found.push(collapsed(piece));
  return found.filter((selector) => selector !== '');
}

/** The comment on the line above the rule `prelude` leads to; empty when there is none. */
function headingOf(prelude: string): string {
  const start = prelude.lastIndexOf('/*');
  const end = prelude.indexOf('*/', start + 2);
  if (start < 0 || end < 0) return '';
  const gap = /^\s*/.exec(prelude.slice(end + 2))?.[0] ?? '';
  return gap.split('\n').length === 2 ? collapsed(prelude.slice(start + 2, end)) : '';
}

/** The declarations of the block `body`, which starts at `offset` of the stylesheet. */
function declarationsIn(body: string, offset: number, heading: string): Declaration[] {
  const found: Declaration[] = [];
  let current = heading;
  let piece = '';
  let depth = 0;
  // Nothing but white space since the line began.
  let lineStart = true;
  const flush = (at: number): void => {
    const text = collapsed(piece);
    piece = '';
    if (text === '') return;
    const colon = text.indexOf(':');
    if (colon <= 0) throw new Error(`not a declaration before ${offset + at}: ${text}`);
    found.push({
      name: text.slice(0, colon).trimEnd(),
      value: text.slice(colon + 1).trimStart(),
      heading: current,
    });
  };
  for (let i = 0; i < body.length; i += 1) {
    const end = inertEnd(body, i);
    if (end > i) {
      if (!body.startsWith('/*', i)) piece += body.slice(i, end);
      else if (lineStart && piece.trim() === '') current = collapsed(body.slice(i + 2, end - 2));
      lineStart = false;
      i = end - 1;
      continue;
    }
    const ch = body.charAt(i);
    if (ch === '\n') lineStart = true;
    else if (ch.trim() !== '') lineStart = false;
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ';' && depth === 0) flush(i);
    else piece += ch;
  }
  flush(body.length);
  return found;
}

/** The condition of a media block from what stands before its `{`; a rewritten one is the condition it was. */
function conditionOf(prelude: string): string {
  const text = prelude.slice(nextOutside(prelude, '@media', 0) + '@media'.length);
  const was = /\ball\s*\/\*\s*tpl:was\s+([\s\S]*?)\s*\*\//g;
  return collapsed(withoutComments(text.replace(was, '$1')));
}

function parsed(css: string): Stylesheet {
  const rules: StyleRule[] = [];
  const conditions: string[] = [];
  const walk = (from: number, to: number, condition?: string): void => {
    let at = from;
    for (;;) {
      const open = nextOutside(css, '{', at);
      if (open < 0 || open >= to) break;
      const close = blockEnd(css, open);
      const prelude = css.slice(at, open);
      const head = collapsed(withoutComments(prelude));
      if (head.startsWith('@media')) {
        if (condition !== undefined) {
          throw new Error(`media block inside a media block at ${open}: ${head}`);
        }
        const inner = conditionOf(prelude);
        conditions.push(inner);
        walk(open + 1, close, inner);
      } else if (head.startsWith('@')) {
        throw new Error(`at-rule not handled at ${open}: ${head}`);
      } else {
        const nested = nextOutside(css, '{', open + 1);
        if (nested >= 0 && nested < close) {
          throw new Error(`rule inside a rule at ${nested}: ${head}`);
        }
        rules.push({
          ...(condition === undefined ? {} : { condition }),
          selectors: selectorsIn(prelude),
          declarations: declarationsIn(css.slice(open + 1, close), open + 1, headingOf(prelude)),
        });
      }
      at = close + 1;
    }
    const rest = collapsed(withoutComments(css.slice(at, to)));
    if (rest !== '') throw new Error(`text outside a rule after ${at}: ${rest}`);
  };
  walk(0, css.length);
  return { rules, conditions };
}

/** What is left of `selector` after `lead`, white space counted in neither; undefined when it does not start with it. */
function after(selector: string, lead: string): string | undefined {
  const wanted = lead.replace(/\s+/g, '');
  let matched = 0;
  let i = 0;
  for (; matched < wanted.length && i < selector.length; i += 1) {
    const ch = selector.charAt(i);
    if (ch.trim() === '') continue;
    if (ch !== wanted.charAt(matched)) return undefined;
    matched += 1;
  }
  return matched === wanted.length ? selector.slice(i) : undefined;
}

/** A selector that starts with a scope of the page as the condition of that scope and the selector the app has. */
function unscopedSelector(selector: string): { condition?: string; selector: string } {
  for (const { condition, scope, root } of SCOPED_CONDITIONS) {
    if (root !== undefined && after(selector, root)?.trim() === '') {
      return { condition, selector: ':root' };
    }
    const rest = after(selector, scope);
    if (rest !== undefined && rest !== '' && rest.trimStart() !== rest) {
      return { condition, selector: rest.trimStart() };
    }
  }
  return { selector };
}

/** The condition of a rule in a block under `block` whose selector carried the scope of `scope`. */
function under(block: string | undefined, scope: string | undefined): string | undefined {
  if (scope === undefined) return block;
  return block === undefined || block === 'all' || block === scope
    ? scope
    : `${block} and ${scope}`;
}

interface FlatRule {
  readonly condition?: string;
  readonly selector: string;
  readonly declarations: readonly Declaration[];
}

/** One rule per selector of each rule, in order; a selector with a scope of the page as its condition and the selector the app has. */
function flatRules(css: string): FlatRule[] {
  return parsed(css).rules.flatMap((rule) =>
    rule.selectors.map((scopedSelector): FlatRule => {
      const { condition: scope, selector } = unscopedSelector(scopedSelector);
      const condition = under(rule.condition, scope);
      return {
        ...(condition === undefined ? {} : { condition }),
        selector,
        declarations: rule.declarations,
      };
    }),
  );
}

export interface CssRule {
  readonly condition?: string;
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
}

/**
 * One rule per selector of each rule of `css`, in order, selectors and values on one line. A
 * selector that starts with a scope of the page is given the condition of that scope and the
 * selector without it (the root form: `:root`), wherever the rule stands; so is a rule in a
 * rewritten media block the condition it had.
 */
export function cssRules(css: string): CssRule[] {
  return flatRules(css).map(({ declarations, ...rule }) => ({
    ...rule,
    declarations: new Map(declarations.map(({ name, value }) => [name, value])),
  }));
}

/** The selectors of every style rule of `css` (media blocks entered), in order, each on one line. */
export function selectorsOf(css: string): string[] {
  return parsed(css).rules.flatMap((rule) => rule.selectors);
}

/** The condition of every media block of `css`, each once, in order; a rewritten block has the condition it was. */
export function mediaConditions(css: string): string[] {
  return [...new Set(parsed(css).conditions)];
}

/** `selector` without its attribute tests, whose values may hold dots and hashes. */
const withoutAttributes = (selector: string): string => selector.replace(/\[[^\]]*\]/g, '');

/** The names `selector` has after `mark`: its classes after a dot, its IDs after a hash. */
const namesOf = (selector: string, mark: '.' | '#'): string[] =>
  [...withoutAttributes(selector).matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)].flatMap((match) =>
    match[1] === mark ? (match[2] ?? []) : [],
  );

const classesOf = (selector: string): string[] => namesOf(selector, '.');

/** The class names in the selectors of `css`. */
export function classNames(css: string): Set<string> {
  return new Set(selectorsOf(css).flatMap(classesOf));
}

/** The IDs in the selectors of `css`. */
export function idNames(css: string): Set<string> {
  return new Set(selectorsOf(css).flatMap((selector) => namesOf(selector, '#')));
}

export interface AttributeTest {
  readonly name: string;
  /** The value of a test for equality (`[name='value']`); absent for any other test. */
  readonly value?: string;
}

/**
 * The attribute tests in the selectors of `css`, each once, in order: `[data-x='v']` with its
 * value, `[hidden]` and a test by another operator (`^=`, `~=` …) by the name alone. A test
 * inside `:not()` is given like any other.
 */
export function attributeTests(css: string): AttributeTest[] {
  const found = new Map<string, AttributeTest>();
  const pattern =
    /\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*(?:[is]\s*)?\]/g;
  for (const selector of selectorsOf(css)) {
    for (const match of selector.matchAll(pattern)) {
      const name = match[1] ?? '';
      const value = match[2] === '=' ? (match[3] ?? match[4] ?? match[5]) : undefined;
      const key = value === undefined ? name : `${name}=${value}`;
      if (!found.has(key)) found.set(key, value === undefined ? { name } : { name, value });
    }
  }
  return [...found.values()];
}

/** The selectors of `css` that still name the page after {@link unscoped}: scoped rules that are no longer where it looks for them. */
export function templateLeft(css: string): string[] {
  return selectorsOf(unscoped(css)).filter((selector) => selector.includes('tpl-'));
}

// --- Custom properties, colours, scales -------------------------------------

type Scheme = 'light' | 'dark';
const SCHEMES: readonly Scheme[] = ['light', 'dark'];

/** The scheme whose values a rule sets on the root element; undefined for any other rule. */
function schemeOf(rule: FlatRule): Scheme | undefined {
  if (rule.selector !== ':root') return undefined;
  if (rule.condition === undefined) return 'light';
  return rule.condition === DARK_CONDITION ? 'dark' : undefined;
}

type RootProperty = Partial<Record<Scheme, Declaration>>;

/** The custom properties declared on `:root`, by name, in the order they are first declared. */
function rootProperties(rules: readonly FlatRule[]): Map<string, RootProperty> {
  const found = new Map<string, RootProperty>();
  for (const rule of rules) {
    const scheme = schemeOf(rule);
    if (scheme === undefined) continue;
    for (const declaration of rule.declarations) {
      if (!declaration.name.startsWith('--')) continue;
      found.set(declaration.name, { ...found.get(declaration.name), [scheme]: declaration });
    }
  }
  return found;
}

export interface CustomProperty {
  readonly name: string;
  /** The value on `:root`; empty for a property that only the dark scheme declares. */
  readonly light: string;
  /** The value on `:root` in the dark scheme, for a property that has one of its own. */
  readonly dark?: string;
  /** The comment it stands under in its `:root` block; empty for none. */
  readonly group: string;
  /** How often the stylesheet reads it with `var()`. */
  readonly uses: number;
}

/** The custom properties `css` declares on `:root`, each once, in the order they are first declared. */
export function customProperties(css: string): CustomProperty[] {
  const uses = new Map<string, number>();
  for (const match of withoutComments(css).matchAll(/var\(\s*(--[\w-]+)/g)) {
    const name = match[1] ?? '';
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  return [...rootProperties(flatRules(css))].map(([name, { light, dark }]) => ({
    name,
    light: light?.value ?? '',
    ...(dark === undefined ? {} : { dark: dark.value }),
    group: (light ?? dark)?.heading ?? '',
    uses: uses.get(name) ?? 0,
  }));
}

export interface ColorLiteral {
  readonly value: string;
  /** The selector list of the rule it stands in. */
  readonly selector: string;
}

/** Colours written out in a declaration that is not a custom property: `#hex`, `rgb()`, `rgba()`, `hsl()`, `hsla()`. `transparent`, `currentColor` and `color-mix()` of tokens are none. */
export function colorLiterals(css: string): ColorLiteral[] {
  const found: ColorLiteral[] = [];
  const pattern = /#(?:[0-9a-fA-F]{3,4}){1,2}(?![\w-])|\b(?:rgba?|hsla?)\((?:[^()]|\([^()]*\))*\)/g;
  for (const rule of parsed(css).rules) {
    const selector = rule.selectors.join(', ');
    for (const { name, value } of rule.declarations) {
      if (name.startsWith('--')) continue;
      // A reference to an element (`url(#id)`) is no colour.
      for (const match of value.replace(/url\([^)]*\)/g, '').matchAll(pattern)) {
        found.push({ value: match[0], selector });
      }
    }
  }
  return found;
}

const SCALES = ['font-size', 'border-radius', 'box-shadow', 'font-weight'] as const;
type Scale = (typeof SCALES)[number];

function isScale(name: string): name is Scale {
  return (SCALES as readonly string[]).includes(name);
}

/**
 * Every distinct value the declarations of `css` give to each of the four properties, as written
 * (`inherit`, `none` and `var()` among them), with the number of declarations: the most used
 * first, equal counts in the order they first occur.
 */
export function scales(css: string): Record<Scale, [value: string, count: number][]> {
  const counts: Record<Scale, Map<string, number>> = {
    'font-size': new Map(),
    'border-radius': new Map(),
    'box-shadow': new Map(),
    'font-weight': new Map(),
  };
  for (const rule of parsed(css).rules) {
    for (const { name, value } of rule.declarations) {
      if (isScale(name)) counts[name].set(value, (counts[name].get(value) ?? 0) + 1);
    }
  }
  const ranked = (scale: Scale): [value: string, count: number][] =>
    [...counts[scale]].sort((a, b) => b[1] - a[1]);
  return {
    'font-size': ranked('font-size'),
    'border-radius': ranked('border-radius'),
    'box-shadow': ranked('box-shadow'),
    'font-weight': ranked('font-weight'),
  };
}

// --- The stylesheet of a page -----------------------------------------------

const BLOCK_BEGIN = /\/\*\s*tpl:app-stylesheet:begin\b[\s\S]*?\*\//;
const BLOCK_END = /\/\*\s*tpl:app-stylesheet:end\s*\*\//;
const NOT_THE_APP = /^\s*\/\*\s*tpl:(?:library|page)\b/;

/**
 * The app's stylesheet as it stands in the page `html`: the text between the comment
 * `tpl:app-stylesheet:begin` and the comment `tpl:app-stylesheet:end`, less the line break after
 * the first and an empty line before the second. Undefined when the two are not found. With
 * `allStyles`, the texts of all style blocks instead, one after the other, less the blocks that
 * start with the comment `tpl:library` or `tpl:page`; undefined when none is left.
 */
export function appStylesheetOf(
  html: string,
  options: { allStyles?: boolean } = {},
): string | undefined {
  if (options.allStyles === true) {
    const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
      .map((match) => match[1] ?? '')
      .filter((text) => !NOT_THE_APP.test(text));
    return blocks.length === 0 ? undefined : blocks.join('\n');
  }
  const begin = BLOCK_BEGIN.exec(html);
  if (!begin) return undefined;
  const from = begin.index + begin[0].length;
  const end = BLOCK_END.exec(html.slice(from));
  if (!end) return undefined;
  const text = html.slice(from, from + end.index).replace(/^\r?\n/, '');
  return /\n\r?\n$/.test(text) ? text.replace(/\r?\n$/, '') : text;
}

// --- What differs between two versions --------------------------------------

/** Classes whose measures the layout computes with, and what each is bound to. */
const BOUND_CLASSES: ReadonlyMap<string, string> = new Map([
  ['arch-leaf', 'LEAF_SIZE (src/core/layout/constants.ts) and the leaf type sizes'],
  ['arch-edge-label', 'EDGE_LABEL (src/core/flow.ts)'],
  ['arch-collapsed', 'COMPACT_GROUP.border (src/core/compactGroup.ts)'],
  ['arch-chevron', 'COMPACT_GROUP.chevron (src/core/compactGroup.ts)'],
  ['arch-compact', 'COMPACT_GROUP (src/core/compactGroup.ts)'],
  ['arch-workitems', 'WORK_ITEM_GEOMETRY (src/core/workItemContent.ts)'],
  ['arch-workitem', 'WORK_ITEM_GEOMETRY (src/core/workItemContent.ts)'],
  ['arch-badge', 'WORK_ITEM_GEOMETRY (src/core/workItemContent.ts)'],
  ['arch-band-gutter', 'ROW_GUTTER_WIDTH (src/core/layout/constants.ts)'],
  ['detail-panel', 'DETAIL_PANEL_WIDTH (src/ui/constants.ts)'],
]);

/** Custom properties that repeat a number of the layout. */
const BOUND_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ['--header-height', 'HEADER_HEIGHT (src/core/layout/constants.ts)'],
  ['--unassigned-header', 'UNASSIGNED_HEADER (src/core/layout/constants.ts)'],
]);

/** What the classes of `selector` are bound to; undefined when the layout depends on none of them. */
function boundTo(selector: string): string | undefined {
  const bound = new Set(classesOf(selector).flatMap((name) => BOUND_CLASSES.get(name) ?? []));
  return bound.size === 0 ? undefined : [...bound].join('; ');
}

/** A value before and after: `from` is absent for what was added, `to` for what was removed. */
export interface ValueChange {
  readonly from?: string;
  readonly to?: string;
}

const moved = (from: string | undefined, to: string | undefined): ValueChange => ({
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
});

/** A custom property of `:root` whose value differs in one scheme. */
export interface PropertyChange extends ValueChange {
  readonly name: string;
  readonly scheme: 'light' | 'dark';
}

export interface DeclarationChange extends ValueChange {
  readonly property: string;
}

/** What differs for one selector under one condition. */
export interface RuleChange {
  /** `added` and `removed`: the other version gives this selector nothing under this condition. */
  readonly kind: 'changed' | 'added' | 'removed';
  readonly condition?: string;
  readonly selector: string;
  readonly declarations: readonly DeclarationChange[];
  /** What the layout computes with the measures of this selector; only where it does. */
  readonly boundTo?: string;
}

export interface StylesheetChanges {
  /** The custom properties of `:root`, per scheme. */
  readonly properties: PropertyChange[];
  /** Every other difference, by selector and condition. */
  readonly rules: RuleChange[];
  /** Those of `rules` and of `properties` that touch what the layout is bound to, each with `boundTo`. */
  readonly bound: RuleChange[];
  /** The selectors of the returned version that name a class the current one does not have. */
  readonly unknownClasses: string[];
}

interface Styled {
  readonly condition?: string;
  readonly selector: string;
  readonly declarations: Map<string, string>;
}

/**
 * What each selector is given under each condition, later declarations over earlier ones. The
 * custom properties of `:root` are not among them: they are compared per scheme.
 */
function styled(rules: readonly FlatRule[]): Map<string, Styled> {
  const found = new Map<string, Styled>();
  for (const rule of rules) {
    const root = schemeOf(rule) !== undefined;
    const key = `${rule.condition ?? ''}\n${rule.selector}`;
    for (const { name, value } of rule.declarations) {
      if (root && name.startsWith('--')) continue;
      let entry = found.get(key);
      if (!entry) {
        entry = { ...rule, declarations: new Map() };
        found.set(key, entry);
      }
      entry.declarations.set(name, value);
    }
  }
  return found;
}

/**
 * What `returned` changes against `current`, both read rule by rule: neither the formatting nor
 * the comments count, nor whether the conditions of `returned` are still scopes of the page.
 */
export function stylesheetChanges(current: string, returned: string): StylesheetChanges {
  const before = flatRules(current);
  const now = flatRules(returned);
  const bound: RuleChange[] = [];

  const properties: PropertyChange[] = [];
  const propertiesBefore = rootProperties(before);
  const propertiesNow = rootProperties(now);
  for (const name of new Set([...propertiesBefore.keys(), ...propertiesNow.keys()])) {
    for (const scheme of SCHEMES) {
      const from = propertiesBefore.get(name)?.[scheme]?.value;
      const to = propertiesNow.get(name)?.[scheme]?.value;
      if (from === to) continue;
      properties.push({ name, scheme, ...moved(from, to) });
      const constant = BOUND_PROPERTIES.get(name);
      if (constant !== undefined) {
        bound.push({
          kind: from === undefined ? 'added' : to === undefined ? 'removed' : 'changed',
          ...(scheme === 'dark' ? { condition: DARK_CONDITION } : {}),
          selector: ':root',
          declarations: [{ property: name, ...moved(from, to) }],
          boundTo: constant,
        });
      }
    }
  }

  const rules: RuleChange[] = [];
  const report = (
    kind: RuleChange['kind'],
    { condition, selector }: Styled,
    declarations: DeclarationChange[],
  ): void => {
    const constant = boundTo(selector);
    const change = {
      kind,
      ...(condition === undefined ? {} : { condition }),
      selector,
      declarations,
      ...(constant === undefined ? {} : { boundTo: constant }),
    };
    rules.push(change);
    if (constant !== undefined) bound.push(change);
  };
  const styledBefore = styled(before);
  const styledNow = styled(now);
  for (const [key, rule] of styledBefore) {
    const other = styledNow.get(key);
    const declarations: DeclarationChange[] = [];
    for (const property of new Set([
      ...rule.declarations.keys(),
      ...(other?.declarations.keys() ?? []),
    ])) {
      const from = rule.declarations.get(property);
      const to = other?.declarations.get(property);
      if (from !== to) declarations.push({ property, ...moved(from, to) });
    }
    if (!other) report('removed', rule, declarations);
    else if (declarations.length > 0) report('changed', rule, declarations);
  }
  for (const [key, rule] of styledNow) {
    if (styledBefore.has(key)) continue;
    report(
      'added',
      rule,
      [...rule.declarations].map(([property, to]) => ({ property, to })),
    );
  }

  const known = new Set(before.flatMap((rule) => classesOf(rule.selector)));
  const unknownClasses = [
    ...new Set(
      now
        .map((rule) => rule.selector)
        .filter((selector) => classesOf(selector).some((name) => !known.has(name))),
    ),
  ];

  return { properties, rules, bound, unknownClasses };
}

const movedText = ({ from, to }: ValueChange): string =>
  from === undefined
    ? `added  ${to ?? ''}`
    : to === undefined
      ? `removed  ${from}`
      : `${from} → ${to}`;

const whereText = ({ condition, selector }: RuleChange): string =>
  condition === undefined ? selector : `@media ${condition}  ${selector}`;

/** `changes` as lines of text, one part for each kind of change that occurs; `No change` for none. */
export function changesText(changes: StylesheetChanges): string {
  const lines: string[] = [];
  if (changes.properties.length > 0) {
    lines.push('Custom properties');
    for (const change of changes.properties) {
      lines.push(`  ${change.name}  ${change.scheme}  ${movedText(change)}`);
    }
  }
  if (changes.rules.length > 0) {
    lines.push('Rules');
    for (const rule of changes.rules) {
      lines.push(`  ${rule.kind}  ${whereText(rule)}`);
      for (const change of rule.declarations) {
        lines.push(`    ${change.property}  ${movedText(change)}`);
      }
    }
  }
  if (changes.bound.length > 0) {
    lines.push('Bound to the layout: change the measure together with the constant');
    for (const rule of changes.bound) {
      for (const change of rule.declarations) {
        lines.push(
          `  ${whereText(rule)}  ${change.property}  ${movedText(change)}  [${rule.boundTo ?? ''}]`,
        );
      }
    }
  }
  if (changes.unknownClasses.length > 0) {
    lines.push('Selectors with classes unknown to the app');
    for (const selector of changes.unknownClasses) lines.push(`  ${selector}`);
  }
  return lines.length === 0 ? 'No change' : lines.join('\n');
}
