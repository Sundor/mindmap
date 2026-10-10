import libraryCss from '@xyflow/react/dist/style.css?raw';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import css from '../ui/styles.css?raw';
import {
  darkLibraryRule,
  fillContainer,
  markElement,
  pageDocument,
  specimenSection,
  startTags,
  staticProblems,
  withoutHandles,
} from './markup';
import { appStylesheetOf, DARK_ROOT, DARK_SCOPE, scoped, unscoped } from './stylesheet';

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** The tags of `html` as `name` and plain attribute objects. */
function tags(html: string): { name: string; attributes: Record<string, string> }[] {
  return startTags(html).map((tag) => ({
    name: tag.name,
    attributes: Object.fromEntries(tag.attributes),
  }));
}

describe('startTags', () => {
  it('gives the start tags in document order with their attributes', () => {
    expect(tags('<div class="a b" id="x"><span hidden="">text</span><br/></div>')).toEqual([
      { name: 'div', attributes: { class: 'a b', id: 'x' } },
      { name: 'span', attributes: { hidden: '' } },
      { name: 'br', attributes: {} },
    ]);
  });

  it('resolves the entities of a value', () => {
    const [tag] = startTags(
      '<a title="say &quot;a &gt; b&quot; &amp; &lt;c&gt; it&#x27;s &#39;so&#39;" data-id="a&gt;b:c">x</a>',
    );
    expect(tag?.attributes.get('title')).toBe("say \"a > b\" & <c> it's 'so'");
    expect(tag?.attributes.get('data-id')).toBe('a>b:c');
  });

  it('reads what React writes for a value with quotes and angle brackets', () => {
    const title = 'a "b" > c & <d> \'e\'';
    const html = renderToStaticMarkup(
      createElement('div', { title, className: 'x' }, 'if a < b then <not a tag>'),
    );
    expect(tags(html)).toEqual([{ name: 'div', attributes: { title, class: 'x' } }]);
  });

  it('reads values in single quotes, without quotes and without a value', () => {
    expect(tags('<input type=checkbox checked class=\'a b\' value = "1" />')).toEqual([
      { name: 'input', attributes: { type: 'checkbox', checked: '', class: 'a b', value: '1' } },
    ]);
  });

  it('takes the first of an attribute written twice', () => {
    expect(startTags('<p class="a" class="b"></p>')[0]?.attributes.get('class')).toBe('a');
  });

  it('takes nothing from inside a style block, but the tag of the block', () => {
    const html =
      '<style media="all">.a > .b::after { content: "<div class=\'c\'>"; } /* <i id="no"> */</style><p class="d"></p>';
    expect(tags(html)).toEqual([
      { name: 'style', attributes: { media: 'all' } },
      { name: 'p', attributes: { class: 'd' } },
    ]);
  });

  it('takes nothing from a title, a comment, the doctype, an end tag or a `<` of the text', () => {
    const html =
      '<!doctype html><title>a <b class="no"> title</title><!-- <i class="no"> --><p>1 < 2 and a <b</p></div >';
    expect(tags(html).map((tag) => tag.name)).toEqual(['title', 'p']);
  });

  it('keeps the names of SVG elements and attributes as written', () => {
    expect(tags('<svg viewBox="0 0 1 1"><linearGradient id="g"/></svg>')).toEqual([
      { name: 'svg', attributes: { viewBox: '0 0 1 1' } },
      { name: 'linearGradient', attributes: { id: 'g' } },
    ]);
  });
});

describe('fillContainer', () => {
  it('puts the content into the one empty container', () => {
    expect(fillContainer('<i></i><div class="box"></div><b></b>', 'box', '<p>in</p>')).toBe(
      '<i></i><div class="box"><p>in</p></div><b></b>',
    );
  });

  it('puts the content in as it is', () => {
    expect(fillContainer('<div class="box"></div>', 'box', "$& $1 $' $$")).toBe(
      '<div class="box">$& $1 $\' $$</div>',
    );
  });

  it('throws when there is no empty container', () => {
    expect(() => fillContainer('<div class="other"></div>', 'box', 'x')).toThrow(/found 0/);
    expect(() => fillContainer('<div class="box">full</div>', 'box', 'x')).toThrow(/found 0/);
    expect(() => fillContainer('<div class="box big"></div>', 'box', 'x')).toThrow(/found 0/);
  });

  it('throws when there are two', () => {
    const html = '<div class="box"></div><p></p><div class="box"></div>';
    expect(() => fillContainer(html, 'box', 'x')).toThrow(/found 2/);
  });
});

describe('withoutHandles', () => {
  const handle = (id: string): string =>
    `<div data-handleid="${id}" data-nodeid="a&gt;b" data-handlepos="top" data-id="1-a-${id}-source" class="react-flow__handle arch-handle source"></div>`;

  it('removes every handle and nothing else', () => {
    const box = '<div class="arch-leaf" data-node-id="a"><span>A</span></div>';
    const html = `<div class="react-flow__node">${box}${handle('s-top')}${handle('t-top')}</div><div data-x="1"></div>`;
    expect(withoutHandles(html)).toBe(
      `<div class="react-flow__node">${box}</div><div data-x="1"></div>`,
    );
  });

  it('leaves markup without handles as it is', () => {
    const html = '<div class="a"><div data-handle="no"></div></div>';
    expect(withoutHandles(html)).toBe(html);
  });
});

describe('markElement', () => {
  const html =
    '<form><input id="view-name" class="field" value="" placeholder="a &quot;name&quot;"/><button id="save-view" type="button" disabled="">Save</button><p id="plain">x</p></form>';

  it('adds a class to those the element has', () => {
    expect(markElement(html, 'view-name', { addClass: 'marked' })).toBe(
      html.replace('class="field"', 'class="field marked"'),
    );
  });

  it('adds the class attribute where there is none', () => {
    expect(markElement(html, 'plain', { addClass: 'marked' })).toBe(
      html.replace('<p id="plain">', '<p id="plain" class="marked">'),
    );
  });

  it('sets an attribute the element has, and one it has not', () => {
    const marked = markElement(html, 'view-name', {
      set: { value: 'Release "A" & <B>', 'data-state': 'typed' },
    });
    expect(marked).toBe(
      html.replace(
        'value="" placeholder="a &quot;name&quot;"/>',
        'value="Release &quot;A&quot; &amp; &lt;B&gt;" placeholder="a &quot;name&quot;" data-state="typed"/>',
      ),
    );
    const input = startTags(marked).find((tag) => tag.attributes.get('id') === 'view-name');
    expect(input?.attributes.get('value')).toBe('Release "A" & <B>');
    expect(input?.attributes.get('placeholder')).toBe('a "name"');
  });

  it('removes an attribute', () => {
    expect(markElement(html, 'save-view', { remove: ['disabled'] })).toBe(
      html.replace(' disabled=""', ''),
    );
  });

  it('does all three at once and leaves the rest of the markup as it is', () => {
    const marked = markElement(html, 'save-view', {
      addClass: 'primary',
      set: { type: 'submit' },
      remove: ['disabled'],
    });
    expect(marked).toBe(
      html.replace(
        '<button id="save-view" type="button" disabled="">',
        '<button id="save-view" type="submit" class="primary">',
      ),
    );
  });

  it('throws when the ID is not there', () => {
    expect(() => markElement(html, 'missing', { addClass: 'x' })).toThrow(/"missing", found 0/);
  });

  it('throws when the ID is there twice', () => {
    expect(() => markElement(`${html}<i id="plain"></i>`, 'plain', { addClass: 'x' })).toThrow(
      /"plain", found 2/,
    );
  });

  it('does not take an ID written in a style block or a text for an element', () => {
    const page = `<style>#plain::after { content: '<p id="plain">' }</style>${html}`;
    expect(markElement(page, 'plain', { addClass: 'marked' })).toBe(
      page.replace('<p id="plain">x', '<p id="plain" class="marked">x'),
    );
  });
});

describe('specimenSection', () => {
  it('wraps the markup of a specimen in its section, label, note and stage', () => {
    const section = specimenSection({
      id: 'map-plain',
      kind: 'canvas',
      title: 'The map',
      states: 'states by pointer: hover, focus',
      note: 'What the app draws once a structure is loaded.',
      width: 900,
      height: 560,
      html: '<div class="app"></div>',
    });
    expect(section).toBe(
      [
        '<section class="tpl-specimen" id="tpl-map-plain" data-kind="canvas">',
        '<h3 class="tpl-label">The map <span class="tpl-states">states by pointer: hover, focus</span></h3>',
        '<p class="tpl-note">What the app draws once a structure is loaded.</p>',
        '<div class="tpl-stage" style="width:900px;height:560px"><div class="app"></div></div>',
        '</section>',
      ].join('\n'),
    );
  });

  it('leaves out the states and the sides that are not given', () => {
    const section = specimenSection({
      id: 'icons',
      kind: 'block',
      title: 'Icons',
      note: 'Every icon.',
      width: 340,
      html: '<i></i>',
    });
    expect(section).toContain('<h3 class="tpl-label">Icons</h3>');
    expect(section).toContain('<div class="tpl-stage" style="width:340px"><i></i></div>');
    expect(specimenSection({ id: 'a', kind: 'block', title: 'A', note: 'B', html: '' })).toContain(
      '<div class="tpl-stage"></div>',
    );
  });

  it('writes title, states and note as text', () => {
    const section = specimenSection({
      id: 'a',
      kind: 'panel',
      title: 'Focus & <Filter>',
      states: 'a "b"',
      note: '1 < 2',
      html: '<b>kept</b>',
    });
    expect(tags(section).map((tag) => tag.name)).toEqual([
      'section',
      'h3',
      'span',
      'p',
      'div',
      'b',
    ]);
    expect(section).toContain(
      'Focus &amp; &lt;Filter&gt; <span class="tpl-states">a &quot;b&quot;',
    );
    expect(section).toContain('<p class="tpl-note">1 &lt; 2</p>');
  });

  it('marks a stage that stands for a narrow window', () => {
    const section = specimenSection({
      id: 'panel-flyout-narrow',
      kind: 'panel',
      title: 'A',
      note: 'B',
      narrow: true,
      html: '',
    });
    expect(section).toContain('<div class="tpl-stage tpl-narrow">');
  });

  it('gives a screen its own section and frame', () => {
    const section = specimenSection({
      id: 'screen-narrow',
      kind: 'screen',
      title: 'Narrow',
      note: 'The panel over the map.',
      width: 1000,
      height: 720,
      narrow: true,
      html: '<div class="app"></div>',
    });
    expect(section).toContain(
      '<section class="tpl-screen-section" id="tpl-screen-narrow" data-kind="screen">',
    );
    expect(section).toContain(
      '<div class="tpl-screen tpl-narrow" style="width:1000px;height:720px"><div class="app"></div></div>',
    );
  });

  it('refuses an ID that is no slug', () => {
    const specimen = { kind: 'block', title: 'A', note: 'B', html: '' } as const;
    expect(() => specimenSection({ ...specimen, id: 'tpl map' })).toThrow(/Not a specimen ID/);
    expect(() => specimenSection({ ...specimen, id: '' })).toThrow(/Not a specimen ID/);
  });
});

describe('darkLibraryRule', () => {
  it('gives the dark values of the library to .react-flow in the dark scope', () => {
    const rule = darkLibraryRule(libraryCss);
    expect(rule.startsWith(`${DARK_SCOPE} .react-flow {\n`)).toBe(true);
    expect(rule.endsWith(';\n}')).toBe(true);
    expect(rule).toContain('--xy-background-color-default:');
    expect(count(rule, '{')).toBe(1);
  });

  it('takes every declaration of the rule and no other', () => {
    const library =
      '.react-flow { --xy-a: white; }\n/* .react-flow.dark { --xy-no: 1 } */\n' +
      '.react-flow.dark {\n  --xy-a: #141414;\n\n  --xy-b: rgba(60, 60, 60, 0.6)\n}\n' +
      '.react-flow.dark .react-flow__node { color: red }\n' +
      '@media (min-width: 1px) { .x .react-flow.dark { color: blue } }';
    expect(darkLibraryRule(library)).toBe(
      `${DARK_SCOPE} .react-flow {\n  --xy-a: #141414;\n  --xy-b: rgba(60, 60, 60, 0.6);\n}`,
    );
  });

  it('throws when the library has no such rule, or two', () => {
    expect(() => darkLibraryRule('.react-flow { --xy-a: white }')).toThrow(/found 0/);
    const once = '.react-flow.dark { --xy-a: black }';
    expect(() => darkLibraryRule(`${once}\n${once}`)).toThrow(/found 2/);
    expect(() => darkLibraryRule('.react-flow.dark { }')).toThrow(/declares nothing/);
  });
});

describe('pageDocument', () => {
  const parts = {
    title: 'Kit & <screens>',
    libraryCss,
    appCss: scoped(css),
    pageCss: '.tpl-stage { position: relative }\n',
    body: '<header class="tpl-intro">Intro</header><div class="app"></div>',
  };
  const page = pageDocument(parts);

  it('is one document that starts with the doctype and names its language', () => {
    expect(page.startsWith('<!doctype html>\n<html lang="en">\n<head>\n')).toBe(true);
    expect(page.endsWith('</body>\n</html>\n')).toBe(true);
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('<link rel="icon" href="data:,">');
    expect(page).toContain('<title>Kit &amp; &lt;screens&gt;</title>');
  });

  it('has the three style blocks in the order the app loads its styles', () => {
    const blocks = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '');
    expect(blocks.map((block) => /^\/\* (tpl:[a-z:-]+)/.exec(block)?.[1])).toEqual([
      'tpl:library',
      'tpl:app-stylesheet:begin',
      'tpl:page',
    ]);
    expect(blocks[0]).toContain(libraryCss);
    expect(blocks[1]?.endsWith('/* tpl:app-stylesheet:end */')).toBe(true);
    expect(blocks[2]).toContain(parts.pageCss);
  });

  it('ends the block of the page with the three rules of the schemes, in their order', () => {
    const own = page.slice(page.indexOf('/* tpl:page'), page.indexOf('</style>\n</head>'));
    const light = own.indexOf('\n:root { color-scheme: light }\n');
    const dark = own.indexOf(
      `\n${DARK_ROOT} { color-scheme: dark; background: var(--bg); color: var(--fg) }\n`,
    );
    const library = own.indexOf(`\n${darkLibraryRule(libraryCss)}\n`);
    expect(light).toBeGreaterThan(own.indexOf(parts.pageCss));
    expect(dark).toBeGreaterThan(light);
    expect(library).toBeGreaterThan(dark);
    expect(own.endsWith(`${darkLibraryRule(libraryCss)}\n`)).toBe(true);
  });

  it('gives the stylesheet of the app back as it was put in', () => {
    expect(appStylesheetOf(page)).toBe(parts.appCss);
    expect(unscoped(appStylesheetOf(page) ?? '')).toBe(css);
    for (const appCss of ['.a { color: red }', '.a { color: red }\n', '.a { color: red }\n\n']) {
      expect(appStylesheetOf(pageDocument({ ...parts, appCss }))).toBe(appCss);
    }
  });

  it('marks the two other blocks as not the stylesheet of the app', () => {
    const others = appStylesheetOf(page, { allStyles: true }) ?? '';
    expect(others).toContain(parts.appCss);
    expect(others).not.toContain('tpl:library');
    expect(others).not.toContain('tpl:page');
    expect(others).not.toContain(parts.pageCss);
  });

  it('starts the body with the scheme switch', () => {
    expect(page).toContain(
      '<body>\n' +
        '<input type="checkbox" id="tpl-dark" class="tpl-switch" aria-label="Dark scheme" />\n' +
        '<label for="tpl-dark" class="tpl-switch-label">Dark scheme</label>\n' +
        '<header class="tpl-intro">',
    );
    const body = startTags(page.slice(page.indexOf('<body>')));
    expect(body.map((tag) => tag.name)).toEqual(['body', 'input', 'label', 'header', 'div']);
  });

  it('is dark by a class on the root and has no switch when asked', () => {
    const dark = pageDocument({ ...parts, dark: true });
    expect(dark).toContain('<html lang="en" class="tpl-dark">');
    expect(startTags(dark).some((tag) => tag.attributes.get('id') === 'tpl-dark')).toBe(false);
    expect(startTags(dark).some((tag) => tag.name === 'label')).toBe(false);
    const withSwitch = page
      .replace('<html lang="en">', '<html lang="en" class="tpl-dark">')
      .replace(/<input [^>]*id="tpl-dark"[^>]*>\n<label [^>]*>[^<]*<\/label>\n/, '');
    expect(dark).toBe(withSwitch);
  });

  it('is nothing but markup and styles', () => {
    expect(staticProblems(page)).toEqual([]);
    expect(startTags(page).map((tag) => tag.name)).toEqual([
      'html',
      'head',
      'meta',
      'meta',
      'link',
      'title',
      'style',
      'style',
      'style',
      'body',
      'input',
      'label',
      'header',
      'div',
    ]);
  });

  it('refuses a stylesheet that would end its block', () => {
    expect(() =>
      pageDocument({ ...parts, pageCss: '.tpl-a::after { content: "</style>" }' }),
    ).toThrow(/<\/style/);
  });
});

describe('staticProblems', () => {
  const problemsOf = (html: string): number => staticProblems(html).length;

  it('finds nothing in markup with styles, links to follow and references into the page', () => {
    const html =
      '<meta charset="utf-8"><link rel="icon" href="data:,">' +
      "<style>/* not url(https://example.com/a.png) and no @import */ .a { fill: url(#p); mask: url('#m') }</style>" +
      '<a href="https://example.com/docs" class="detail-external">Docs</a>' +
      '<svg><path marker-end="url(#arch-arrow-dataflow)" style="fill:url(&quot;#pattern-1&quot;)"></path></svg>' +
      '<button type="button" class="on" data-on="1" aria-label="one">On</button>';
    expect(staticProblems(html)).toEqual([]);
  });

  it.each([
    ['a script', '<script>let a = 1;</script>'],
    ['a script that is loaded', '<script src="a.js"></script>'],
    ['a stylesheet link', '<link rel="stylesheet" href="a.css">'],
    ['an icon that is loaded', '<link rel="icon" href="favicon.ico">'],
    ['an image', '<img alt="">'],
    ['an SVG image', '<svg><image href="a.png"/></svg>'],
    ['a frame', '<iframe></iframe>'],
    ['an object', '<object data="a.svg"></object>'],
    ['an embed', '<embed type="image/png">'],
    ['a base address', '<base href="https://example.com/">'],
    ['a video', '<video></video>'],
    ['a handler', '<button onclick="go()">Go</button>'],
    ['a handler in capitals', '<BUTTON ONCLICK="go()">Go</BUTTON>'],
    ['a refresh', '<meta http-equiv="refresh" content="1">'],
    ['a policy', '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">'],
    ['a script address', '<a href="javascript:go()">Go</a>'],
    ['an import in a style block', '<style>@import "a.css";</style>'],
    ['an address in a style block', '<style>.a { background: url(a.png) }</style>'],
    [
      'a quoted address in a style block',
      '<style>.a { background: url("https://e.com/a") }</style>',
    ],
    ['an address in a style attribute', '<p style="background:url(&quot;a.png&quot;)"></p>'],
    ['an import in a style attribute', '<p style="@import url(#a)"></p>'],
  ])('finds %s', (_what, html) => {
    expect(staticProblems(`<div class="app">${html}</div>`).length).toBeGreaterThan(0);
    expect(problemsOf('<div class="app"></div>')).toBe(0);
  });

  it('names each problem once per place', () => {
    const problems = staticProblems(
      '<img onload="a()"><style>.a { background: url(a.png) } .b { background: url(b.png) }</style>',
    );
    expect(problems).toEqual([
      '<img> element',
      'Handler onload on <img>',
      'url(a.png) in a style block',
      'url(b.png) in a style block',
    ]);
  });
});
