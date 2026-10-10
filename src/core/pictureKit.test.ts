import { describe, expect, it } from 'vitest';
import {
  colorHex,
  ELLIPSIS,
  estimateMeasure,
  fitText,
  textCharacters,
  mixColors,
  parseColor,
  PICTURE_PALETTE,
  pictureNumber,
  wrapText,
  xmlElement,
  xmlText,
  type TextMeasure,
} from './pictureKit';
import { readXml, seeded, unescapeXml } from './pictureTestHelpers';
import { estimateLineCount, estimateTextWidth } from './text';

/** A measure of a font with fixed widths: 6 px a character at 10 px, exact. */
const mono: TextMeasure = Object.assign(
  (text: string, size: number) => [...text].length * size * 0.6,
  { exact: true },
);

const ALPHABET = ['a', 'b', 'W', 'i', ' ', ' ', ' ', '-', '.', 'é', '漢', '😀', '\u00a0', 'm', 'l'];

function randomText(random: () => number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return text;
}

describe('parseColor', () => {
  it('reads the notations of the palette and of the lens colours', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor(' #1A73e8 ')).toEqual({ r: 26, g: 115, b: 232, a: 1 });
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('rgba(37, 99, 235, 0.05)')).toEqual({ r: 37, g: 99, b: 235, a: 0.05 });
    expect(parseColor('rgba(37,99,235,.5)')).toEqual({ r: 37, g: 99, b: 235, a: 0.5 });
  });
  it('holds a channel to 255 and the alpha to 1', () => {
    expect(parseColor('rgba(300, 255.5, 0, 2)')).toEqual({ r: 255, g: 255, b: 0, a: 1 });
    expect(parseColor('rgb(256, 1000, 12)')).toEqual({ r: 255, g: 255, b: 12, a: 1 });
  });
  it('refuses everything else', () => {
    const refused = ['red', '', '#12', '#12345', 'color(srgb 1 0 0)', 'rgb(1 2 3)', 'var(--bg)'];
    for (const text of refused) expect(() => parseColor(text), text).toThrow(/not a colour/);
  });
  it('every entry of both palettes is a colour', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [name, value] of Object.entries(PICTURE_PALETTE[scheme])) {
        expect(() => parseColor(value), `${scheme}.${name}`).not.toThrow();
      }
    }
  });
  it('the light scheme is dark text on a light page, the dark scheme the other way round', () => {
    const brightness = (text: string) => {
      const { r, g, b } = parseColor(text);
      return r + g + b;
    };
    const { light, dark } = PICTURE_PALETTE;
    expect(brightness(light.bg)).toBeGreaterThan(brightness(light.fg));
    expect(brightness(dark.bg)).toBeLessThan(brightness(dark.fg));
    expect(brightness(light.bg)).toBeGreaterThan(brightness(dark.bg));
    expect(brightness(light.leafBg)).toBeGreaterThan(brightness(dark.leafBg));
    expect(brightness(light.leafFg)).toBeLessThan(brightness(dark.leafFg));
  });
});

describe('colorHex', () => {
  it('rounds a channel to the nearest whole number and holds it to 0–255', () => {
    expect(colorHex({ r: 127.5, g: 0.4, b: 254.6, a: 1 })).toBe('#8000ff');
    expect(colorHex({ r: -3, g: 300, b: 15.5, a: 0.2 })).toBe('#00ff10');
  });
});

describe('mixColors', () => {
  it('is color-mix(in srgb) on opaque colours', () => {
    // color-mix(in srgb, #2a78d6 14%, #ffffff): 42 * 0.14 + 255 * 0.86 = 225.18, …
    const mixed = mixColors(parseColor('#2a78d6'), 0.14, parseColor('#ffffff'));
    expect(colorHex(mixed)).toBe('#e1ecf9');
    expect(mixed.a).toBe(1);
  });
  it('interpolates with premultiplied alpha on a translucent colour', () => {
    // color-mix(in srgb, #2a78d6 10%, rgba(255, 255, 255, 0.72)):
    // alpha = 0.1 + 0.9 * 0.72 = 0.748; red = (42 * 0.1 + 255 * 0.72 * 0.9) / 0.748
    const mixed = mixColors(parseColor('#2a78d6'), 0.1, parseColor('rgba(255, 255, 255, 0.72)'));
    expect(mixed.a).toBeCloseTo(0.748, 10);
    expect(mixed.r).toBeCloseTo((42 * 0.1 + 255 * 0.648) / 0.748, 10);
    expect(mixed.g).toBeCloseTo((120 * 0.1 + 255 * 0.648) / 0.748, 10);
    expect(mixed.b).toBeCloseTo((214 * 0.1 + 255 * 0.648) / 0.748, 10);
  });
  it('shares of 0 and 1 give the two colours; two transparent colours stay transparent', () => {
    const a = parseColor('#102030');
    const b = parseColor('rgba(200, 100, 50, 0.5)');
    expect(mixColors(a, 1, b)).toEqual(a);
    expect(mixColors(a, 0, b)).toEqual(b);
    // Nothing is left to divide by: no colour at all, and one that can still be written.
    const none = mixColors({ r: 1, g: 2, b: 3, a: 0 }, 0.5, { r: 4, g: 5, b: 6, a: 0 });
    expect(none).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(colorHex(none)).toBe('#000000');
  });
});

describe('pictureNumber and xmlElement', () => {
  it('rounds to two decimals and never writes -0', () => {
    expect(pictureNumber(1)).toBe('1');
    expect(pictureNumber(1.239)).toBe('1.24');
    expect(pictureNumber(12.3449)).toBe('12.34');
    expect(pictureNumber(-0)).toBe('0');
    expect(pictureNumber(-0.001)).toBe('0');
    expect(pictureNumber(-3.5)).toBe('-3.5');
  });
  it('throws on what is not a number', () => {
    for (const value of [NaN, Infinity, -Infinity, undefined as unknown as number]) {
      expect(() => pictureNumber(value)).toThrow(/not a number/);
    }
  });
  it('throws on a number too large to be rounded, and never writes Infinity', () => {
    for (const value of [1e307, -1e307, Number.MAX_VALUE]) {
      expect(() => pictureNumber(value), String(value)).toThrow(/not a number/);
    }
    expect(() => pictureNumber(1e300)).not.toThrow();
    expect(() => xmlElement('rect', { x: 1e307 })).toThrow(/not a number/);
  });
  it('an element escapes its attributes and cannot hold such a number', () => {
    expect(() => xmlElement('rect', { x: NaN })).toThrow();
    expect(xmlElement('rect', { x: 1.239, fill: 'a"b', skip: undefined })).toBe(
      '<rect x="1.24" fill="a&quot;b"/>',
    );
    expect(xmlElement('g', {}, '')).toBe('<g></g>');
  });
});

describe('xmlText', () => {
  it('escapes the five characters and leaves out what XML forbids', () => {
    expect(xmlText('a<b>&"c\'')).toBe('a&lt;b&gt;&amp;&quot;c&#39;');
    expect(xmlText('a\u0000b\u0008c\u000bd\ufffee\uffff')).toBe('abcde');
    expect(xmlText('tab\tline\nret\r')).toBe('tab\tline\nret\r');
    expect(xmlText('\ud83d\ude00')).toBe('\ud83d\ude00');
    expect(xmlText('lone \ud83d here')).toBe('lone  here');
    expect(xmlText('lone \ude00 here')).toBe('lone  here');
  });
  it('property: any string becomes content and an attribute of a well-formed document', () => {
    const random = seeded(11);
    const pool = [
      '<',
      '>',
      '&',
      '"',
      "'",
      ']]>',
      '<!--',
      '</svg>',
      '<script>',
      '\u0001',
      '\ud800',
      '\udc00',
      '\ufffe',
      'a',
      ' ',
      'é',
      '😀',
      '&amp;',
      '\n',
    ];
    // eslint-disable-next-line no-control-regex
    const forbidden = /^[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]$/;
    for (let run = 0; run < 400; run++) {
      let text = '';
      const length = Math.floor(random() * 12);
      for (let i = 0; i < length; i++) text += pool[Math.floor(random() * pool.length)];
      const doc = xmlElement('a', { t: text }, xmlText(text));
      const [root] = readXml(doc);
      // What is left is the text without the characters XML does not allow.
      const kept = [...text].filter((c) => !forbidden.test(c)).join('');
      expect(unescapeXml(root?.attrs.get('t') ?? ''), JSON.stringify(text)).toBe(kept);
      expect(doc).not.toContain('<script');
    }
  });
});

describe('fitText', () => {
  it('leaves a text that fits, cuts one that does not, the ellipsis alone when nothing fits', () => {
    expect(fitText('Message Broker', 14 * 6, 10, 400, mono)).toBe('Message Broker');
    expect(fitText('Message Broker', 60, 10, 400, mono)).toBe(`Message B${ELLIPSIS}`);
    // The space at the cut goes: it would only take the room of a letter.
    expect(fitText('Message Broker', 54, 10, 400, mono)).toBe(`Message${ELLIPSIS}`);
    expect(fitText('Message Broker', 3, 10, 400, mono)).toBe(ELLIPSIS);
    expect(fitText('', 0, 10, 400, mono)).toBe('');
    // By code points: an emoji is never cut in half.
    expect(fitText('😀😀😀😀', 18, 10, 400, mono)).toBe(`😀😀${ELLIPSIS}`);
  });
  it('cuts between the characters a reader sees: a flag, a joined emoji, a letter with its accent', () => {
    // Widths by UTF-16 unit, so that a cut by code points would fit half a character.
    const units: TextMeasure = Object.assign((text: string) => text.length, { exact: true });
    expect(textCharacters('a👨‍👩‍👧🇩🇪éx')).toEqual(['a', '👨‍👩‍👧', '🇩🇪', 'é', 'x']);
    // Three flags of four units each: 7 units hold one flag and the ellipsis, not one and a half.
    expect(fitText('🇩🇪🇫🇷🇮🇹', 7, 10, 400, units)).toBe(`🇩🇪${ELLIPSIS}`);
    expect(fitText('🇩🇪🇫🇷🇮🇹', 9, 10, 400, units)).toBe(`🇩🇪🇫🇷${ELLIPSIS}`);
    // A family is one character of eight units: it is in or out, never a parent and a joiner.
    expect(fitText('👨‍👩‍👧👨‍👩‍👧', 12, 10, 400, units)).toBe(`👨‍👩‍👧${ELLIPSIS}`);
    // An accent stays on its letter.
    expect(fitText('aéé', 3, 10, 400, units)).toBe(`a${ELLIPSIS}`);
    // Right-to-left text is cut at its end, like any other.
    expect(fitText('שלום עולם', 6, 10, 400, units)).toBe(`שלום${ELLIPSIS}`);
  });
  it('property: the result fits (or is the ellipsis alone) and starts like the text', () => {
    const random = seeded(5);
    for (let run = 0; run < 500; run++) {
      const text = randomText(random, Math.floor(random() * 30));
      const width = random() * 200;
      const size = 9 + Math.floor(random() * 20);
      for (const measure of [mono, estimateMeasure]) {
        const out = fitText(text, width, size, 400, measure);
        if (out === text) {
          expect(measure(text, size, 400)).toBeLessThanOrEqual(width);
          continue;
        }
        expect(out.endsWith(ELLIPSIS)).toBe(true);
        if (out !== ELLIPSIS) expect(measure(out, size, 400)).toBeLessThanOrEqual(width);
        expect(text.startsWith(out.slice(0, -1))).toBe(true);
      }
    }
  });
});

describe('wrapText', () => {
  it('breaks at spaces, inside a word wider than a line, and not at no-break spaces', () => {
    expect(wrapText('aa bb cc', 30, 10, 400, mono)).toEqual(['aa bb', 'cc']);
    expect(wrapText('abcdefgh', 18, 10, 400, mono)).toEqual(['abc', 'def', 'gh']);
    expect(wrapText('aa\u00a0bb cc', 36, 10, 400, mono)).toEqual(['aa\u00a0bb', 'cc']);
    expect(wrapText('  a   b  ', 60, 10, 400, mono)).toEqual(['a b']);
    expect(wrapText('', 60, 10, 400, mono)).toEqual(['']);
  });
  it('keeps to maxLines and says that text was left out', () => {
    expect(wrapText('aa bb cc dd ee', 30, 10, 400, mono, 2)).toEqual(['aa bb', `cc d${ELLIPSIS}`]);
    expect(wrapText('aa bb', 30, 10, 400, mono, 2)).toEqual(['aa bb']);
  });
  it('keeps a word that measures nothing, also at the start of a line', () => {
    // A combining accent and a zero-width space have no width of their own.
    const accent = String.fromCodePoint(0x301);
    const gap = String.fromCodePoint(0x200b);
    const marks: TextMeasure = Object.assign(
      (text: string, size: number) =>
        [...text].filter((char) => char !== accent && char !== gap).length * size * 0.6,
      { exact: true },
    );
    expect(wrapText(`${accent} Orders`, 500, 10, 400, marks)).toEqual([`${accent} Orders`]);
    expect(wrapText(`${gap} Orders and Billing`, 60, 10, 400, marks)).toEqual([
      `${gap} Orders`,
      'and',
      'Billing',
    ]);
    expect(wrapText(`aa ${gap} bb`, 18, 10, 400, marks)).toEqual([`aa ${gap}`, 'bb']);
    expect(wrapText(`aa ${gap} bb`, 12, 10, 400, marks)).toEqual(['aa', gap, 'bb']);
    expect(wrapText(gap.repeat(3), 5, 10, 400, marks)).toEqual([gap.repeat(3)]);
    // Inside a word that is broken, what measures nothing stays with the letter after it.
    expect(wrapText(`${gap}WWW`, 5, 10, 400, marks)).toEqual([`${gap}W`, 'W', 'W']);
    expect(wrapText(`e${accent}e${accent}`, 6, 10, 400, marks)).toEqual([
      `e${accent}`,
      `e${accent}`,
    ]);
    // A measure that measures nothing loses no word either.
    const nothing: TextMeasure = Object.assign(() => 0, { exact: true });
    expect(wrapText('alpha beta gamma', 50, 12, 400, nothing)).toEqual(['alpha beta gamma']);
    // Property: whatever measures nothing, the words of the text are the words of its lines.
    const random = seeded(13);
    const pool = ['a', 'W', ' ', ' ', accent, gap, 'é'];
    const lost: string[] = [];
    for (let run = 0; run < 1500; run++) {
      let text = '';
      const length = Math.floor(random() * 40);
      for (let i = 0; i < length; i++) text += pool[Math.floor(random() * pool.length)];
      const lines = wrapText(text, 1 + random() * 80, 10, 400, marks);
      if (lines.join('').replace(/ /g, '') !== text.replace(/ /g, '')) lost.push(text);
    }
    expect(lost).toEqual([]);
  });
  it('property: with the estimate the lines are those estimateLineCount counts', () => {
    const random = seeded(3);
    for (let run = 0; run < 3000; run++) {
      const text = randomText(random, Math.floor(random() * 60));
      const size = [11, 12, 15, 16, 22, 28][Math.floor(random() * 6)] ?? 16;
      const width = 1 + random() * 400;
      const lines = wrapText(text, width, size, 400, estimateMeasure);
      expect(lines.length, JSON.stringify({ text, size, width })).toBe(
        estimateLineCount(text, size, width),
      );
      for (const line of lines) {
        // A line is within the width, unless it is one character that is wider than a line.
        if ([...line].length > 1) {
          expect(estimateTextWidth(line, size)).toBeLessThanOrEqual(width + 1e-6);
        }
      }
      // Nothing is lost: the characters are those of the text, in order.
      expect(lines.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''));
    }
  });
  it('property: an exact measure never wider than the estimate never needs more lines', () => {
    const random = seeded(8);
    // Every character between 60 % and 100 % of its estimate, each by its own share.
    const narrower: TextMeasure = Object.assign(
      (text: string, size: number) => {
        let width = 0;
        for (const char of text) {
          const share = 0.6 + (((char.codePointAt(0) ?? 0) * 37) % 41) / 100;
          width += estimateTextWidth(char, size) * share;
        }
        return width;
      },
      { exact: true },
    );
    for (let run = 0; run < 1500; run++) {
      const text = randomText(random, Math.floor(random() * 60));
      const width = 20 + random() * 300;
      expect(wrapText(text, width, 16, 400, narrower).length).toBeLessThanOrEqual(
        estimateLineCount(text, 16, width),
      );
    }
  });
});
