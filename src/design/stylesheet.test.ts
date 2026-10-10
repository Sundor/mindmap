import { describe, expect, it } from 'vitest';
import css from '../ui/styles.css?raw';
import {
  appStylesheetOf,
  attributeTests,
  changesText,
  classNames,
  colorLiterals,
  cssRules,
  customProperties,
  DARK_ROOT,
  DARK_SCOPE,
  DEVICE_CONDITIONS,
  idNames,
  mediaConditions,
  NARROW_SCOPE,
  scales,
  scoped,
  SCOPED_CONDITIONS,
  selectorsOf,
  stylesheetChanges,
  templateLeft,
  unscoped,
  withoutComments,
} from './stylesheet';

const DARK = '(prefers-color-scheme: dark)';
const NARROW = '(max-width: 1399.98px)';

const count = (text: string, needle: string | RegExp): number => text.split(needle).length - 1;

/** `text` with `from` replaced by `to`; fails when `from` is not there. */
function replaced(text: string, from: string, to: string): string {
  expect(text, from).toContain(from);
  return text.replace(from, to);
}

describe('the stylesheet as text', () => {
  it('is read verbatim by ?raw', () => {
    expect(css.length).toBeGreaterThan(40000);
    expect(css).toContain('.arch-leaf');
    expect(css).not.toContain('\r');
  });
});

describe('cssRules', () => {
  it('reads the real stylesheet', () => {
    const rules = cssRules(css);
    const leaf = rules.find(
      (rule) =>
        rule.selector === '.arch-leaf' &&
        rule.condition === undefined &&
        rule.declarations.has('font-size'),
    );
    expect(leaf?.declarations.get('font-size')).toBe('15px');
    expect(rules.length).toBe(selectorsOf(css).length);
  });

  it('gives one rule per selector, with the condition of its media block', () => {
    const rules = cssRules(
      '.a,\n.b > .c {\n  top: 0;\n  color: red;\n}\n@media (pointer: coarse) {\n  .a {\n    top: 1px;\n  }\n}\n',
    );
    expect(rules.map(({ condition, selector }) => [condition, selector])).toEqual([
      [undefined, '.a'],
      [undefined, '.b > .c'],
      ['(pointer: coarse)', '.a'],
    ]);
    expect([...(rules[1]?.declarations ?? [])]).toEqual([
      ['top', '0'],
      ['color', 'red'],
    ]);
    expect(rules[2]?.declarations.get('top')).toBe('1px');
  });

  it('puts a selector and a value on one line, without their comments', () => {
    const [rule] = cssRules(
      ".app[data-lod='domains']\n  .a /* why */ {\n  font-family:\n    system-ui,\n    'Segoe UI'; /* which */\n  top : 0\n}\n",
    );
    expect(rule?.selector).toBe(".app[data-lod='domains'] .a");
    expect([...(rule?.declarations ?? [])]).toEqual([
      ['font-family', "system-ui, 'Segoe UI'"],
      ['top', '0'],
    ]);
  });

  it('is not misled by a brace, a semicolon or a comment mark in a string', () => {
    const rules = cssRules(
      '.a::before {\n  content: "}; /*";\n  top: 0;\n}\n.b[title=\'{\'] {\n  top: 1px;\n}\n',
    );
    expect(rules.map((rule) => rule.selector)).toEqual(['.a::before', ".b[title='{']"]);
    expect(rules[0]?.declarations.get('content')).toBe('"}; /*"');
    expect(rules[0]?.declarations.get('top')).toBe('0');
  });

  it('throws for what it does not read, with the offset', () => {
    expect(() => cssRules('.a {\n  top: 0;\n  .b {\n    top: 1px;\n  }\n}\n')).toThrow(
      'rule inside a rule at 20: .a',
    );
    expect(() => cssRules('@keyframes turn {\n  from {\n    top: 0;\n  }\n}\n')).toThrow(
      'at-rule not handled at 16: @keyframes turn',
    );
    expect(() => cssRules("@import 'other.css';\n.a {\n  top: 0;\n}\n")).toThrow(
      'at-rule not handled at 24',
    );
    expect(() =>
      cssRules(`@media ${DARK} {\n  @media ${NARROW} {\n    .a {\n      top: 0;\n    }\n  }\n}\n`),
    ).toThrow('media block inside a media block at');
    expect(() => cssRules('.a {\n  top: 0;\n}\n}\n')).toThrow('text outside a rule after 16');
    expect(() => cssRules('.a {\n  top: 0;\n')).toThrow('block not closed at 3');
    expect(() => cssRules('.a {\n  top: 0;\n}\n/* open')).toThrow('comment not closed at 17');
    expect(() => cssRules('.a {\n  top 0;\n}\n')).toThrow('not a declaration before 12: top 0');
  });

  it('reads the scoped stylesheet as the rules of the app', () => {
    expect(cssRules(scoped(css))).toEqual(cssRules(css));
  });
});

describe('scoped / unscoped on the real stylesheet', () => {
  const page = scoped(css);
  const bare = withoutComments(page);

  it('leaves no condition a static page cannot meet', () => {
    expect(bare).not.toContain('prefers-color-scheme');
    expect(bare).not.toContain('max-width: 1399');
  });

  it('puts the scope in front of the selectors, and the root form where :root stood', () => {
    expect(page).toContain(`${DARK_ROOT} {`);
    expect(page).toContain(`${DARK_SCOPE} .arch-tinted,`);
    expect(page).toContain(`${NARROW_SCOPE} .cp-body {`);
    expect(selectorsOf(page).length).toBe(selectorsOf(css).length);
    for (const block of bare.split('@media all').slice(1)) {
      expect(block.slice(0, block.indexOf('\n}\n'))).not.toMatch(/(^|[\s,]):root\s*[,{]/);
    }
  });

  it('adds no specificity: every scope is a :where(), the root form weighs what :root weighs', () => {
    let scopedSelectors = 0;
    for (const selector of selectorsOf(page)) {
      if (!selector.includes('tpl-')) continue;
      scopedSelectors += 1;
      const rest =
        selector === DARK_ROOT
          ? ''
          : selector.startsWith(`${DARK_SCOPE} `)
            ? selector.slice(DARK_SCOPE.length + 1)
            : selector.startsWith(`${NARROW_SCOPE} `)
              ? selector.slice(NARROW_SCOPE.length + 1)
              : undefined;
      expect(rest, selector).toBeDefined();
      expect(rest).not.toContain('tpl-');
    }
    expect(scopedSelectors).toBeGreaterThan(10);
    for (const scope of [DARK_SCOPE, NARROW_SCOPE]) expect(scope).toMatch(/^:where\(.*\)$/);
    expect(DARK_ROOT).toBe(`:is(:root, .tpl-dark)${DARK_SCOPE}`);
  });

  it('comes back byte for byte', () => {
    expect(unscoped(page)).toBe(css);
  });

  it('keeps the class names of the selectors', () => {
    const app = classNames(css);
    const inPage = classNames(page);
    for (const name of app) expect(inPage.has(name), name).toBe(true);
    expect([...inPage].filter((name) => !app.has(name)).sort()).toEqual(['tpl-dark', 'tpl-narrow']);
  });
});

describe('scoped / unscoped on small inputs', () => {
  it('splits a selector list at the commas outside parentheses and brackets only', () => {
    const input =
      '@media (prefers-color-scheme: dark) {\n  a:not(.b, .c),\n  d[title="x,y"] /* why */ {\n    color: red;\n  }\n}\n';
    const out = scoped(input);
    expect(out).toContain(`${DARK_SCOPE} a:not(.b, .c),`);
    expect(out).toContain(`${DARK_SCOPE} d[title="x,y"] /* why */ {`);
    expect(unscoped(out)).toBe(input);
  });

  it('keeps a comment between two selectors, and one inside a selector, where it is', () => {
    const input =
      '@media (prefers-color-scheme: dark) {\n  /* first */\n  .a,\n  /* second */ .b /* inside */ .c {\n    color: red;\n  }\n}\n';
    const out = scoped(input);
    expect(out).toContain(`  /* first */\n  ${DARK_SCOPE} .a,`);
    expect(out).toContain(`  /* second */ ${DARK_SCOPE} .b /* inside */ .c {`);
    expect(count(out, DARK_SCOPE)).toBe(2);
    expect(unscoped(out)).toBe(input);
  });

  it('is not misled by a brace in a comment', () => {
    const input =
      '@media (prefers-color-scheme: dark) /* { */ {\n  /* } */\n  .a {\n    color: red;\n  }\n}\n.b {\n  top: 0;\n}\n';
    const out = scoped(input);
    expect(out).toContain(`${DARK_SCOPE} .a {`);
    expect(out).toContain('\n.b {');
    expect(unscoped(out)).toBe(input);
  });

  it('is not misled by a brace or a comma in a string', () => {
    const input =
      '@media (max-width: 1399.98px) {\n  .a[title=\'}\'],\n  .b[title="],"]::after {\n    content: "{";\n  }\n}\n.c {\n  top: 0;\n}\n';
    const out = scoped(input);
    expect(out).toContain(`${NARROW_SCOPE} .a[title='}'],`);
    expect(out).toContain(`${NARROW_SCOPE} .b[title="],"]::after {`);
    expect(out).toContain('\n.c {');
    expect(unscoped(out)).toBe(input);
  });

  it('leaves a condition that a comment names as it is', () => {
    const input =
      '/* Below @media (max-width: 1399.98px) the body lies over the canvas. */\n.a {\n  top: 0;\n}\n';
    expect(scoped(input)).toBe(input);
  });

  it('makes :root the root form only where the condition has one', () => {
    const dark = scoped('@media (prefers-color-scheme: dark) {\n  :root {\n    --a: 1;\n  }\n}\n');
    expect(dark).toContain(`\n  ${DARK_ROOT} {`);
    expect(dark).not.toContain(`${DARK_SCOPE} :root`);
    const narrow = scoped('@media (max-width: 1399.98px) {\n  :root {\n    --a: 1;\n  }\n}\n');
    expect(narrow).toContain(`\n  ${NARROW_SCOPE} :root {`);
  });

  it('leaves a rule that was added without the scope as it is', () => {
    const page = scoped('@media (max-width: 1399.98px) {\n  .a {\n    top: 0;\n  }\n}\n').replace(
      '\n}\n',
      '\n  .added {\n    top: 1px;\n  }\n}\n',
    );
    expect(unscoped(page)).toBe(
      '@media (max-width: 1399.98px) {\n  .a {\n    top: 0;\n  }\n  .added {\n    top: 1px;\n  }\n}\n',
    );
    expect(cssRules(page).map(({ condition, selector }) => [condition, selector])).toEqual([
      [NARROW, '.a'],
      [NARROW, '.added'],
    ]);
  });

  it('does not touch a media block with another condition', () => {
    const input = '@media (pointer: coarse) {\n  .a {\n    top: 0;\n  }\n}\n';
    expect(scoped(input)).toBe(input);
    expect(unscoped(input)).toBe(input);
  });
});

describe('templateLeft', () => {
  const input =
    '@media (prefers-color-scheme: dark) {\n  :root {\n    --a: 1;\n  }\n\n  .a,\n  .b {\n    color: red;\n  }\n}\n';
  const page = scoped(input);

  it('is empty for a stylesheet that came back whole', () => {
    expect(templateLeft(page)).toEqual([]);
    expect(templateLeft(unscoped(page))).toEqual([]);
    expect(templateLeft(unscoped(scoped(css)))).toEqual([]);
  });

  it('names the selector of a scoped rule that was moved out of its block', () => {
    const moved = `${page}${DARK_SCOPE} .c {\n  color: blue;\n}\n`;
    expect(templateLeft(moved)).toEqual([`${DARK_SCOPE} .c`]);
    expect(templateLeft(unscoped(moved))).toEqual([`${DARK_SCOPE} .c`]);
    expect(cssRules(moved).at(-1)).toEqual({
      condition: DARK,
      selector: '.c',
      declarations: new Map([['color', 'blue']]),
    });
  });

  it('names the selectors of a block whose mark was removed', () => {
    const unmarked = withoutComments(page);
    expect(unmarked).toContain('@media all  {');
    expect(templateLeft(unmarked)).toEqual([DARK_ROOT, `${DARK_SCOPE} .a`, `${DARK_SCOPE} .b`]);
    expect(cssRules(unmarked)).toEqual(cssRules(input));
  });

  it('reads a scope whatever its white space, and nothing else as one', () => {
    const tight = DARK_SCOPE.replace(', ', ',');
    const rules = cssRules(
      `${tight}\n  .a {\n  top: 0;\n}\n${DARK_ROOT.replace(/, /g, ',')} {\n  --a: 1;\n}\n${NARROW_SCOPE}.b {\n  top: 0;\n}\n.tpl-dark .c {\n  top: 0;\n}\n`,
    );
    expect(rules.map(({ condition, selector }) => [condition, selector])).toEqual([
      [DARK, '.a'],
      [DARK, ':root'],
      [undefined, `${NARROW_SCOPE}.b`],
      [undefined, '.tpl-dark .c'],
    ]);
  });
});

describe('the names in selectors', () => {
  const input =
    '.a.b-c > #one:not(.d, [data-x=\'.e #f\']),\n#two[hidden][data-n="1"] .a[lang|=en] {\n  color: #abc;\n  background: url(img.png);\n}\n@media (pointer: coarse) {\n  .g[data-x=\'v\'][data-x="w"] {\n    top: 0.5rem;\n  }\n}\n';

  it('are the classes, not what an attribute value or a declaration holds', () => {
    expect([...classNames(input)]).toEqual(['a', 'b-c', 'd', 'g']);
  });

  it('are the IDs', () => {
    expect([...idNames(input)]).toEqual(['one', 'two']);
    expect(idNames(css).has('unlock-positions')).toBe(true);
    expect(idNames(scoped(css)).has('tpl-dark')).toBe(true);
  });

  it('are the attribute tests, each once, a value only for equality', () => {
    expect(attributeTests(input)).toEqual([
      { name: 'data-x', value: '.e #f' },
      { name: 'hidden' },
      { name: 'data-n', value: '1' },
      { name: 'lang' },
      { name: 'data-x', value: 'v' },
      { name: 'data-x', value: 'w' },
    ]);
    expect(attributeTests(`${input}.h[data-x='v'][hidden] {\n  top: 0;\n}\n`)).toHaveLength(6);
  });

  it('are found in the real stylesheet', () => {
    const tests = attributeTests(css);
    for (const test of [
      { name: 'aria-pressed', value: 'true' },
      { name: 'data-lod', value: 'domains' },
      { name: 'data-errors' },
      { name: 'data-errors', value: '0' },
      { name: 'type', value: 'range' },
    ]) {
      expect(tests, JSON.stringify(test)).toContainEqual(test);
    }
    const literal = count(withoutComments(css), /\[[\w-]+(?:=|\])/);
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.length).toBeLessThanOrEqual(literal);
  });
});

describe('mediaConditions', () => {
  it('gives each condition once, and a rewritten block the condition it was', () => {
    const input = `@media ${DARK} {\n  .a {\n    top: 0;\n  }\n}\n@media (pointer: coarse) {\n}\n@media ${DARK} {\n  .b {\n    top: 0;\n  }\n}\n`;
    expect(mediaConditions(input)).toEqual([DARK, '(pointer: coarse)']);
    expect(mediaConditions(scoped(input))).toEqual([DARK, '(pointer: coarse)']);
    expect(mediaConditions(withoutComments(scoped(input)))).toEqual(['all', '(pointer: coarse)']);
  });

  it('finds in the real stylesheet only conditions that are rewritten or left to the device', () => {
    const known = [...SCOPED_CONDITIONS.map((entry) => entry.condition), ...DEVICE_CONDITIONS];
    const conditions = mediaConditions(css);
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) expect(known, condition).toContain(condition);
    expect(conditions.length).toBeLessThanOrEqual(count(withoutComments(css), '@media'));
  });
});

describe('customProperties', () => {
  const properties = customProperties(css);
  const named = (name: string) => properties.find((property) => property.name === name);

  it('has one entry for every name declared in a :root rule', () => {
    const declared = new Set<string>();
    for (const block of withoutComments(css).matchAll(/:root\s*\{([^}]*)\}/g)) {
      for (const match of (block[1] ?? '').matchAll(/(--[\w-]+)\s*:/g))
        declared.add(match[1] ?? '');
    }
    expect(declared.size).toBeGreaterThan(0);
    expect(properties.map((property) => property.name).sort()).toEqual([...declared].sort());
  });

  it('gives the light value, and the dark one where the dark scheme has its own', () => {
    const bg = named('--bg');
    expect(bg?.light).toMatch(/^#/);
    expect(bg?.dark).toMatch(/^#/);
    expect(bg?.dark).not.toBe(bg?.light);
    const story = named('--wi-story');
    expect(story?.light).toMatch(/^#/);
    expect(story?.dark).toBeUndefined();
    expect(story && 'dark' in story).toBe(false);
  });

  it('counts the uses', () => {
    expect(named('--accent')?.uses).toBe(count(withoutComments(css), 'var(--accent)'));
    expect(named('--accent')?.uses).toBeGreaterThan(0);
  });

  it('reads the same from the scoped stylesheet', () => {
    expect(customProperties(scoped(css))).toEqual(properties);
  });

  it('groups by the comment a property stands under', () => {
    const found = customProperties(
      '/* The file. */\n\n:root {\n  --a: 1;\n\n  /* Second */\n  --b: 2; /* not a heading */\n  --c: var(--a);\n  color-scheme: light dark;\n}\n\n/* Third, in a block\n   of its own. */\n:root {\n  --d: var(--a, 0);\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --b: 3;\n    --e: 4;\n  }\n}\n\n.x {\n  --local: var(--a);\n  top: var(--b);\n}\n',
    );
    expect(found).toEqual([
      { name: '--a', light: '1', group: '', uses: 3 },
      { name: '--b', light: '2', dark: '3', group: 'Second', uses: 1 },
      { name: '--c', light: 'var(--a)', group: 'Second', uses: 0 },
      { name: '--d', light: 'var(--a, 0)', group: 'Third, in a block of its own.', uses: 0 },
      { name: '--e', light: '', dark: '4', group: '', uses: 0 },
    ]);
  });
});

describe('colorLiterals', () => {
  it('finds the colours written out, not the tokens, keywords and references', () => {
    const input =
      ':root {\n  --a: #123456;\n}\n.a,\n.b {\n  color: #fff;\n  border: 1px solid #1a2b3c4d;\n  box-shadow:\n    0 1px 2px rgba(0, 0, 0, 0.3),\n    0 0 0 1px hsl(210 50% 40% / 0.5);\n  background: color-mix(in srgb, var(--a) 14%, transparent);\n  outline-color: currentColor;\n  fill: url(#fade);\n  --local: rgb(1, 2, 3);\n}\n#abc {\n  stroke: rgb(calc(1 + 2) 0 0);\n}\n';
    expect(colorLiterals(input)).toEqual([
      { value: '#fff', selector: '.a, .b' },
      { value: '#1a2b3c4d', selector: '.a, .b' },
      { value: 'rgba(0, 0, 0, 0.3)', selector: '.a, .b' },
      { value: 'hsl(210 50% 40% / 0.5)', selector: '.a, .b' },
      { value: 'rgb(calc(1 + 2) 0 0)', selector: '#abc' },
    ]);
  });

  // The colours of the real stylesheet that are not custom properties.
  const WRITTEN_OUT = [
    '#0ca30c',
    '#ffffff',
    'rgba(0, 0, 0, 0.12)',
    'rgba(0, 0, 0, 0.12)',
    'rgba(0, 0, 0, 0.18)',
    'rgba(0, 0, 0, 0.18)',
    'rgba(0, 0, 0, 0.18)',
    'rgba(0, 0, 0, 0.18)',
    'rgba(0, 0, 0, 0.18)',
    'rgba(0, 0, 0, 0.3)',
    'rgba(127, 127, 127, 0.3)',
    'rgba(255, 120, 30, 0.45)',
  ];

  it('finds in the real stylesheet the colours its rules write out', () => {
    const found = colorLiterals(css);
    expect(found.map((literal) => literal.value).sort()).toEqual(WRITTEN_OUT);
    const selectors = new Set(selectorsOf(css));
    for (const { selector } of found) {
      for (const one of selector.split(', ')) expect(selectors.has(one), one).toBe(true);
    }
  });
});

describe('scales', () => {
  it('counts the declarations of each value, the most used first', () => {
    const input =
      '.a {\n  font-size: 12px;\n  font-weight: 600;\n  border-radius: 4px;\n}\n.b,\n.c {\n  font-size: 0.8rem;\n  box-shadow:\n    0 1px 2px red,\n    0 0 0 1px blue;\n}\n@media (pointer: coarse) {\n  .a {\n    font-size: 0.8rem;\n    box-shadow: none;\n    border-top-left-radius: 2px;\n  }\n}\n';
    expect(scales(input)).toEqual({
      'font-size': [
        ['0.8rem', 2],
        ['12px', 1],
      ],
      'border-radius': [['4px', 1]],
      'box-shadow': [
        ['0 1px 2px red, 0 0 0 1px blue', 1],
        ['none', 1],
      ],
      'font-weight': [['600', 1]],
    });
  });

  it('counts every declaration of the real stylesheet', () => {
    const found = scales(css);
    const bare = withoutComments(css);
    for (const [property, values] of Object.entries(found)) {
      const total = values.reduce((sum, [, uses]) => sum + uses, 0);
      expect(total, property).toBe(count(bare, new RegExp(`[\\s;{]${property}\\s*:`)));
      expect(total, property).toBeGreaterThan(0);
      expect(new Set(values.map(([value]) => value)).size, property).toBe(values.length);
      const uses = values.map(([, number]) => number);
      expect(uses, property).toEqual([...uses].sort((a, b) => b - a));
    }
  });
});

describe('appStylesheetOf', () => {
  const sheet = scoped(
    '.a {\n  top: 0;\n}\n\n@media (max-width: 1399.98px) {\n  .a {\n    top: 1px;\n  }\n}\n',
  );
  const library =
    '/* tpl:library @xyflow/react dist/style.css — as shipped, not to be changed */\n.react-flow {\n  top: 0;\n}\n';
  const own =
    "/* tpl:page — the page's own; every selector starts with .tpl- or #tpl- */\n.tpl-stage {\n  top: 0;\n}\n";
  const begin = '/* tpl:app-stylesheet:begin — src/ui/styles.css; the block to restyle */';
  const end = '/* tpl:app-stylesheet:end */';
  const page = (app: string): string =>
    `<!doctype html><html lang="en"><head><style>${library}</style>\n<style>${app}</style>\n<style>${own}</style></head><body><p class="a">.b { }</p></body></html>`;

  it('is the text between the two marks', () => {
    expect(appStylesheetOf(page(`${begin}\n${sheet}${end}`))).toBe(sheet);
    expect(appStylesheetOf(page(`${begin}\n${sheet}\n${end}`))).toBe(sheet);
    expect(appStylesheetOf(page(`${begin}\r\n${sheet}${end}`))).toBe(sheet);
    expect(appStylesheetOf(page(`${begin}${sheet}${end}`))).toBe(sheet);
  });

  it('comes back as the stylesheet of the app', () => {
    const html = page(`${begin}\n${scoped(css)}${end}`);
    expect(unscoped(appStylesheetOf(html) ?? '')).toBe(css);
  });

  it('is undefined without the marks', () => {
    expect(appStylesheetOf(page(sheet))).toBeUndefined();
    expect(appStylesheetOf(page(`${begin}\n${sheet}`))).toBeUndefined();
    expect(appStylesheetOf(page(`${sheet}${end}`))).toBeUndefined();
    expect(appStylesheetOf('')).toBeUndefined();
  });

  it('is every style block but the two of the page with allStyles', () => {
    expect(appStylesheetOf(page(sheet), { allStyles: true })).toBe(sheet);
    expect(appStylesheetOf(page(sheet), { allStyles: false })).toBeUndefined();
    const split = `<style>${library}</style><STYLE media="all">.a {\n  top: 0;\n}\n</STYLE><p>text</p><style>\n  ${own}</style><style>.b {\n  top: 1px;\n}\n</style>`;
    expect(appStylesheetOf(split, { allStyles: true })).toBe(
      '.a {\n  top: 0;\n}\n\n.b {\n  top: 1px;\n}\n',
    );
    expect(
      appStylesheetOf(`<style>${library}</style><style>${own}</style>`, { allStyles: true }),
    ).toBeUndefined();
    expect(appStylesheetOf('<p>no style</p>', { allStyles: true })).toBeUndefined();
  });
});

describe('stylesheetChanges', () => {
  const current =
    ':root {\n  --accent: #2563eb;\n  --bg: #f7f7f8;\n  --header-height: 40px;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --accent: #8ab4f8;\n    --bg: #17181a;\n  }\n\n  .card {\n    border-color: #34363b;\n  }\n}\n\n/* The box of a node. */\n.arch-leaf {\n  padding: 0 12px;\n  font-size: 15px;\n}\n\n.card,\n.sheet {\n  border-radius: 6px;\n}\n\n.gone {\n  top: 0;\n}\n';

  /** The page's stylesheet after a restyle: two tokens, a new one, three rules and a new class. */
  function restyled(page: string): string {
    let out = replaced(page, '--accent: #2563eb;', '--accent: #1d4ed8;');
    out = replaced(out, '--bg: #17181a;', '--bg: #000000;');
    out = replaced(
      out,
      '--header-height: 40px;',
      '--header-height: 40px;\n  --shadow: rgba(0, 0, 0, 0.18);',
    );
    out = replaced(out, 'border-color: #34363b;', 'border-color: #444444;');
    out = replaced(out, 'font-size: 15px;', 'font-size: 14px;');
    out = replaced(out, '.gone {\n  top: 0;\n}\n', '.tool-card {\n  margin: 0;\n}\n');
    return out;
  }

  const tightScope = DARK_SCOPE.replace(', ', ',');
  const tightRoot = DARK_ROOT.replace(/, /g, ',');
  /** The same restyle as a tool may write it: a line per rule, no comment, the dark rules outside any block. */
  const reformatted = [
    ':root{--accent:#1d4ed8;--bg:#f7f7f8;--header-height:40px;--shadow:rgba(0, 0, 0, 0.18)}',
    `${tightRoot}{--accent:#8ab4f8;--bg:#000000}`,
    '.arch-leaf{padding:0 12px;font-size:14px}',
    '.card,.sheet{border-radius:6px}',
    `${tightScope} .card{border-color:#444444}`,
    '.tool-card{margin:0}',
    '',
  ].join('\n');

  const leafConstant = 'LEAF_SIZE (src/core/layout/constants.ts) and the leaf type sizes';
  const expected = {
    properties: [
      { name: '--accent', scheme: 'light', from: '#2563eb', to: '#1d4ed8' },
      { name: '--bg', scheme: 'dark', from: '#17181a', to: '#000000' },
      { name: '--shadow', scheme: 'light', to: 'rgba(0, 0, 0, 0.18)' },
    ],
    rules: [
      {
        kind: 'changed',
        condition: DARK,
        selector: '.card',
        declarations: [{ property: 'border-color', from: '#34363b', to: '#444444' }],
      },
      {
        kind: 'changed',
        selector: '.arch-leaf',
        declarations: [{ property: 'font-size', from: '15px', to: '14px' }],
        boundTo: leafConstant,
      },
      { kind: 'removed', selector: '.gone', declarations: [{ property: 'top', from: '0' }] },
      { kind: 'added', selector: '.tool-card', declarations: [{ property: 'margin', to: '0' }] },
    ],
    bound: [
      {
        kind: 'changed',
        selector: '.arch-leaf',
        declarations: [{ property: 'font-size', from: '15px', to: '14px' }],
        boundTo: leafConstant,
      },
    ],
    unknownClasses: ['.tool-card'],
  };

  it('finds a changed token per scheme, an added and a removed rule, what is bound, an unknown class', () => {
    const page = restyled(scoped(current));
    expect(stylesheetChanges(current, unscoped(page))).toStrictEqual(expected);
    expect(stylesheetChanges(current, page)).toStrictEqual(expected);
  });

  it('finds the same in a text that was reformatted', () => {
    expect(templateLeft(reformatted)).toEqual([tightRoot, `${tightScope} .card`]);
    expect(stylesheetChanges(current, reformatted)).toStrictEqual(expected);
  });

  it('writes the changes as text', () => {
    expect(changesText(stylesheetChanges(current, reformatted)).split('\n')).toEqual([
      'Custom properties',
      '  --accent  light  #2563eb → #1d4ed8',
      '  --bg  dark  #17181a → #000000',
      '  --shadow  light  added  rgba(0, 0, 0, 0.18)',
      'Rules',
      '  changed  @media (prefers-color-scheme: dark)  .card',
      '    border-color  #34363b → #444444',
      '  changed  .arch-leaf',
      '    font-size  15px → 14px',
      '  removed  .gone',
      '    top  removed  0',
      '  added  .tool-card',
      '    margin  added  0',
      'Bound to the layout: change the measure together with the constant',
      `  .arch-leaf  font-size  15px → 14px  [${leafConstant}]`,
      'Selectors with classes unknown to the app',
      '  .tool-card',
    ]);
  });

  it('finds none between a stylesheet and itself, scoped or not', () => {
    const none = { properties: [], rules: [], bound: [], unknownClasses: [] };
    expect(stylesheetChanges(current, current)).toStrictEqual(none);
    expect(stylesheetChanges(css, css)).toStrictEqual(none);
    expect(stylesheetChanges(css, scoped(css))).toStrictEqual(none);
    expect(stylesheetChanges(css, withoutComments(scoped(css)))).toStrictEqual(none);
    expect(changesText(none)).toBe('No change');
  });

  it('finds exactly the one custom property that was edited in the real stylesheet', () => {
    const accent = customProperties(css).find((property) => property.name === '--accent');
    const page = replaced(scoped(css), `--accent: ${accent?.dark ?? ''};`, '--accent: #010203;');
    expect(stylesheetChanges(css, unscoped(page))).toStrictEqual({
      properties: [{ name: '--accent', scheme: 'dark', from: accent?.dark, to: '#010203' }],
      rules: [],
      bound: [],
      unknownClasses: [],
    });
  });

  it('compares what a selector is given in all its rules together', () => {
    const before = '.a {\n  top: 0;\n  left: 0;\n}\n.b {\n  top: 0;\n}\n.a {\n  top: 1px;\n}\n';
    const merged = '.a {\n  left: 0;\n  top: 1px;\n}\n.b {\n  top: 0;\n}\n';
    expect(stylesheetChanges(before, merged).rules).toEqual([]);
    expect(stylesheetChanges(before, replaced(merged, 'left: 0;', 'right: 0;')).rules).toEqual([
      {
        kind: 'changed',
        selector: '.a',
        declarations: [
          { property: 'left', from: '0' },
          { property: 'right', to: '0' },
        ],
      },
    ]);
  });

  it('lists a custom property of the layout under bound, and a local one under rules', () => {
    const changes = stylesheetChanges(
      current,
      replaced(current, '--header-height: 40px;', '--header-height: 44px;') +
        '.card {\n  --tint: red;\n}\n',
    );
    expect(changes.properties).toEqual([
      { name: '--header-height', scheme: 'light', from: '40px', to: '44px' },
    ]);
    expect(changes.rules).toEqual([
      { kind: 'changed', selector: '.card', declarations: [{ property: '--tint', to: 'red' }] },
    ]);
    expect(changes.bound).toEqual([
      {
        kind: 'changed',
        selector: ':root',
        declarations: [{ property: '--header-height', from: '40px', to: '44px' }],
        boundTo: 'HEADER_HEIGHT (src/core/layout/constants.ts)',
      },
    ]);
  });

  it('lists a change to any selector of the real stylesheet the layout computes with under bound', () => {
    const classes = classNames(css);
    const properties = customProperties(css).map((property) => property.name);
    for (const selector of [
      '.arch-leaf',
      '.arch-edge-label',
      '.arch-group.arch-collapsed',
      '.arch-chevron',
      '.arch-group.arch-compact .arch-group-header',
      '.arch-workitems',
      '.arch-workitem',
      '.arch-badge',
      '.arch-band-gutter',
      '.detail-panel',
    ]) {
      for (const name of classNames(`${selector} {\n}\n`))
        expect(classes.has(name), name).toBe(true);
      const changes = stylesheetChanges(css, `${css}\n${selector} {\n  outline-offset: 7px;\n}\n`);
      expect(changes.rules, selector).toHaveLength(1);
      expect(changes.bound, selector).toEqual(changes.rules);
      expect(changes.bound[0]?.boundTo, selector).toMatch(/^[A-Z_]+/);
    }
    for (const name of ['--header-height', '--unassigned-header']) {
      expect(properties, name).toContain(name);
      const changes = stylesheetChanges(css, `${css}\n:root {\n  ${name}: 1px;\n}\n`);
      expect(changes.properties, name).toHaveLength(1);
      expect(
        changes.bound.map((change) => change.declarations),
        name,
      ).toEqual([[expect.objectContaining({ property: name, to: '1px' })]]);
    }
    const free = stylesheetChanges(css, `${css}\n.cp-tab {\n  outline-offset: 7px;\n}\n`);
    expect(free.rules).toHaveLength(1);
    expect(free.bound).toEqual([]);
  });
});
