import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  htmlElements,
  inlineScript,
  inlineScriptText,
  inlineStyle,
  outsideReferences,
  scriptFiles,
  scriptHash,
  withNotices,
  withPolicy,
} from './single-file.ts';

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="data:," />
    <title>Map <b></title>
    <!-- a classic <script src="https://commented.example/x.js"></script> in a comment -->
    <script src="./other.js"></script>
    <script type="module" crossorigin src="./viewer-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./viewer-abc.css">
  </head>
  <body>
    <div id="root" data-note="a > b"></div>
  </body>
</html>
`;

describe('htmlElements', () => {
  it('finds the start tags with their attributes, skipping comments and text content', () => {
    const elements = htmlElements(PAGE);
    expect(elements.map((element) => element.name)).toEqual([
      'html',
      'head',
      'meta',
      'link',
      'title',
      'script',
      'script',
      'link',
      'body',
      'div',
    ]);
    expect(elements[2]?.attributes.get('charset')).toBe('UTF-8');
    expect(elements[4]?.text).toBe('Map <b>');
    expect(elements[6]?.attributes.get('src')).toBe('./viewer-abc.js');
    expect(elements[6]?.attributes.get('crossorigin')).toBe('');
    // A `>` inside a quoted value does not end the tag.
    expect(elements[9]?.attributes.get('data-note')).toBe('a > b');
  });

  it('reads what is inside a script as text, up to its end tag in any spelling', () => {
    const html = `<script>if (a<b) x = "<div class='y'>";</SCRIPT ><p id=after>`;
    const elements = htmlElements(html);
    expect(elements).toHaveLength(2);
    expect(elements[0]?.text).toBe(`if (a<b) x = "<div class='y'>";`);
    expect(elements[1]?.attributes.get('id')).toBe('after');
  });

  it('survives markup that is cut off', () => {
    expect(htmlElements('<p><!-- never closed')).toHaveLength(1);
    expect(htmlElements('<script>never closed')).toEqual([
      { name: 'script', attributes: new Map(), text: 'never closed' },
    ]);
    expect(htmlElements('<div class="x')).toEqual([]);
    expect(htmlElements('a < b')).toEqual([]);
  });
});

describe('inlineScript', () => {
  it('replaces the module script by its code', () => {
    const html = inlineScript(PAGE, 'viewer-abc.js', '\nconsole.log(1);\n');
    expect(html).toContain('<script type="module">console.log(1);</script>');
    expect(html).not.toContain('viewer-abc.js');
    // Another script of the page is left alone.
    expect(html).toContain('<script src="./other.js"></script>');
  });

  it('keeps the code from ending the script element or opening a comment', () => {
    const code = 'const a = "</script>", b = "</SCRIPT x", c = "<!-- <script>";';
    expect(inlineScriptText(code)).toBe(
      'const a = "\\x3C/script>", b = "\\x3C/SCRIPT x", c = "\\x3C!-- <script>";',
    );
    const html = inlineScript(PAGE, 'viewer-abc.js', code) ?? '';
    const scripts = htmlElements(html).filter((element) => element.name === 'script');
    expect(scripts).toHaveLength(2);
    expect(scripts[1]?.text).toBe(inlineScriptText(code));
    // The escape means the same character to JavaScript.
    expect(new Function(`${inlineScriptText(code)} return a + b + c;`)()).toBe(
      '</script></SCRIPT x<!-- <script>',
    );
  });

  it('does not read replacement patterns into the code', () => {
    const html = inlineScript(PAGE, 'viewer-abc.js', "x.replace(/a/, '$&$1$`');");
    expect(html).toContain("x.replace(/a/, '$&$1$`');");
  });

  it('is undefined when the page does not load the file as a module script', () => {
    expect(inlineScript(PAGE, 'other.js', 'x')).toBeUndefined();
    expect(inlineScript(PAGE, 'other.js', 'x')).toBeUndefined();
    // The dot of the name is a dot.
    expect(inlineScript(PAGE, 'viewer-abcXjs', 'x')).toBeUndefined();
  });
});

describe('inlineStyle', () => {
  it('replaces the stylesheet link by the styles', () => {
    const html = inlineStyle(PAGE, 'viewer-abc.css', '@charset "UTF-8";.a{color:red}\n');
    expect(html).toContain('<style>.a{color:red}</style>');
    expect(html).not.toContain('viewer-abc.css');
    expect(html).toContain('<link rel="icon" href="data:," />');
  });

  it('is undefined without such a link, and refuses styles that would end the element', () => {
    expect(inlineStyle(PAGE, 'other.css', '.a{}')).toBeUndefined();
    expect(() => inlineStyle(PAGE, 'viewer-abc.css', '.a{content:"</style>"}')).toThrow(/<\/style/);
  });
});

describe('scriptHash', () => {
  it('is the SHA-256 of the text, as a policy source', () => {
    expect(scriptHash('')).toBe('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    const text = 'const greeting = "héllo";';
    expect(scriptHash(text)).toBe(
      `sha256-${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('base64')}`,
    );
  });

  it('does not depend on the line endings of the file', () => {
    expect(scriptHash('a\r\nb\rc\n')).toBe(scriptHash('a\nb\nc\n'));
    expect(scriptHash('a\nb')).not.toBe(scriptHash('a b'));
  });
});

describe('contentSecurityPolicy', () => {
  it('forbids everything, then allows the own code, inline styles and the own server', () => {
    expect(contentSecurityPolicy(['sha256-AAA=', 'sha256-BBB='])).toBe(
      "default-src 'none'; script-src 'sha256-AAA=' 'sha256-BBB='; " +
        "style-src 'unsafe-inline'; img-src data:; connect-src 'self'; " +
        "base-uri 'none'; form-action 'none'",
    );
  });

  it('never allows code from strings, any inline script, a script file, or another server', () => {
    const policy = contentSecurityPolicy(['sha256-AAA=']);
    expect(policy).not.toMatch(/unsafe-eval|https?:|\*/);
    expect(policy).not.toMatch(/script-src[^;]*(unsafe-inline|'self'|file:)/);
  });

  it('allows no script at all for a page without code', () => {
    expect(contentSecurityPolicy([])).toMatch(/^default-src 'none'; script-src 'none'; /);
  });
});

describe('withPolicy', () => {
  const built =
    inlineStyle(inlineScript(PAGE, 'viewer-abc.js', 'run();') ?? '', 'viewer-abc.css', '.a{}') ??
    '';

  it('puts the policy right after the charset, ahead of every script and style', () => {
    const html = withPolicy(built);
    const elements = htmlElements(html);
    const names = elements.map((element) => element.name);
    expect(names.slice(0, 4)).toEqual(['html', 'head', 'meta', 'meta']);
    expect(elements[3]?.attributes.get('http-equiv')).toBe('Content-Security-Policy');
    expect(elements[3]?.attributes.get('content')).toBe(
      contentSecurityPolicy([scriptHash('run();')]),
    );
    // Nothing else changed.
    expect(html.replace(/\n {4}<meta http-equiv=[^>]*>/, '')).toBe(built);
  });

  it('allows every inline script of the page, each once, and no data block', () => {
    const html = withPolicy(
      built.replace(
        '</head>',
        '<script>run();</script><script>other();</script>' +
          '<script type="application/json">{"not":"code"}</script></head>',
      ),
    );
    const policy = htmlElements(html)[3]?.attributes.get('content') ?? '';
    expect(policy.match(/'sha256-[^']+'/g)).toEqual([
      `'${scriptHash('run();')}'`,
      `'${scriptHash('other();')}'`,
    ]);
  });

  it('refuses a page without the charset first, or with a policy of its own', () => {
    expect(() => withPolicy('<html><head><title>x</title></head></html>')).toThrow(/charset/);
    expect(() =>
      withPolicy('<html><head><title>x</title><meta charset="UTF-8" /></head></html>'),
    ).toThrow(/charset/);
    expect(() => withPolicy(withPolicy(built))).toThrow(/already declares/);
  });
});

describe('scriptFiles', () => {
  it('lists the script files a page loads, and none for inline code', () => {
    expect(scriptFiles(PAGE)).toEqual(['./other.js', './viewer-abc.js']);
    expect(scriptFiles('<script>run();</script><script type="module">more();</script>')).toEqual(
      [],
    );
    // A script tag inside the code or in a comment is no script of the page.
    expect(
      scriptFiles('<script>x = "<script src=a.js>";</script><!-- <script src="b.js"> -->'),
    ).toEqual([]);
  });
});

describe('outsideReferences', () => {
  it('finds nothing in a page that is on its own', () => {
    const built =
      inlineStyle(
        inlineScript(PAGE, 'viewer-abc.js', 'fetch("https://in-code.example")') ?? '',
        'viewer-abc.css',
        '.a{fill:url(#arrow);background:url("data:image/png;base64,AAAA")}',
      ) ?? '';
    expect(outsideReferences(built)).toEqual([]);
  });

  it('finds what points to another server, in every spelling', () => {
    const html = `<head>
      <script src="https://cdn.example/lib.js"></script>
      <link rel="stylesheet" href="//fonts.example/css">
      <link rel="preconnect" href="\\\\tracker.example">
      <img src=" HTTP://pixel.example/p.gif" srcset="a.png 1x, https://img.example/b.png 2x">
      <iframe src="./local.html"></iframe>
      <form action="mailto:someone@mail.example"></form>
      <meta http-equiv="Refresh" content="0; url=https://away.example/">
      <style>@import url(https://fonts.example/a.css); .a{background:url( 'http://img.example/x.png' )} .b{fill:url(#ok)}</style>
    </head>`;
    expect(outsideReferences(html)).toEqual([
      '<script src="https://cdn.example/lib.js">',
      '<link href="//fonts.example/css">',
      '<link href="\\\\tracker.example">',
      '<img src=" HTTP://pixel.example/p.gif">',
      '<img srcset="https://img.example/b.png 2x">',
      '<form action="mailto:someone@mail.example">',
      '<meta http-equiv="refresh">',
      'style: @import url(https://fonts.example/a.css)',
      "style: url( 'http://img.example/x.png' )",
    ]);
  });
});

describe('withNotices', () => {
  it('appends the text as a comment after the document', () => {
    const html = withNotices('<html><body></body></html>\n\n', '\nMIT License\nCopyright (c) X\n');
    expect(html).toBe('<html><body></body></html>\n<!--\nMIT License\nCopyright (c) X\n-->\n');
    expect(htmlElements(html).map((element) => element.name)).toEqual(['html', 'body']);
  });

  it('keeps the text from ending the comment early', () => {
    const html = withNotices('<html></html>', 'a --> <script>alert(1)</script> b --!> c');
    expect(html.match(/--!?>/g)).toEqual(['-->']);
    expect(htmlElements(html).map((element) => element.name)).toEqual(['html']);
  });
});
