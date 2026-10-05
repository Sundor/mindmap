// Small text helpers shared by the views.

/** `count` with `noun`, plural unless there is exactly one: "1 edge", "0 edges", "3 edges". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// --- Text measurement without a browser -----------------------------------------------------

/**
 * Advance width of a character in em, by class. The core cannot measure text, so boxes that
 * must hold a text are sized from these. Each value is at or above the widest glyph of its class
 * in the bold cuts of the fonts the page asks for (system-ui → Segoe UI, San Francisco, Roboto,
 * and Arial / Helvetica as the fallback), for the Latin, Greek and Cyrillic letters in use
 * today, punctuation, common symbols, CJK and emoji: such a text is never drawn wider than its
 * estimate. For the rest it is a heuristic — the widest glyphs of some other scripts (Tamil,
 * Balinese, ...) and a few rare signs (Ⅷ, ⸻, Ǆ) are wider than `other` / `symbol`.
 */
const CHAR_EM = {
  space: 0.3,
  narrow: 0.36,
  slim: 0.45,
  quote: 0.5,
  digit: 0.62,
  lower: 0.66,
  upper: 0.8,
  wideLower: 0.95,
  wide: 1.05,
  /** Letters and punctuation beyond Latin Extended-A: Щ and Ю are wider than W. */
  other: 1.15,
  /** Letterlike signs, arrows, mathematical and technical symbols, dingbats, emoji. */
  symbol: 1.4,
} as const;

const NARROW = new Set("iljI.,:;'!|");
const SLIM = new Set('frt()[]{}-/\\·`');
const QUOTE = new Set('"*');
const WIDE_LOWER = new Set('mw');
const WIDE = new Set('MW@%&');
/** The wide ones of Latin-1 and Latin Extended-A; the other letters there are no wider than O. */
const WIDE_LATIN = new Set('©®¼½¾ÆæŒœŴ');
/** Signs between the letters and the symbols that are wider than `other`. */
const WIDE_SIGNS = new Set('‰‱₧₯');

function charEm(char: string): number {
  if (char === ' ' || char === ' ') return CHAR_EM.space;
  if (NARROW.has(char)) return CHAR_EM.narrow;
  if (SLIM.has(char)) return CHAR_EM.slim;
  if (QUOTE.has(char)) return CHAR_EM.quote;
  if (WIDE_LOWER.has(char)) return CHAR_EM.wideLower;
  if (WIDE.has(char)) return CHAR_EM.wide;
  if (char >= '0' && char <= '9') return CHAR_EM.digit;
  if (char >= 'a' && char <= 'z') return CHAR_EM.lower;
  if (char >= 'A' && char <= 'Z') return CHAR_EM.upper;
  const code = char.codePointAt(0) ?? 0;
  // The rest of ASCII, and accented Latin letters: Latin capitals at least.
  if (code < 0x180) return WIDE_LATIN.has(char) ? CHAR_EM.wide : CHAR_EM.upper;
  // Further Latin, Greek, Cyrillic and other scripts; dashes, quotes and currency signs.
  if (code < 0x2100) return WIDE_SIGNS.has(char) ? CHAR_EM.symbol : CHAR_EM.other;
  if (code < 0x2e80) return CHAR_EM.symbol;
  // CJK, Hangul and full-width forms are one em wide; pictographs and emoji more.
  return code < 0x1f000 ? CHAR_EM.wide : CHAR_EM.symbol;
}

/**
 * Upper estimate of the width of `text` on one line at `fontSize` pixels, in pixels: the drawn
 * text is at most this wide in the fonts of the page, at any weight (see {@link CHAR_EM} for
 * the characters this holds for). Counted per code point, so a joined emoji sequence is
 * over-estimated.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of text) em += charEm(char);
  return em * fontSize;
}

/**
 * Upper estimate of the number of lines `text` takes in a box `width` pixels wide at `fontSize`
 * pixels, wrapped as a browser does with `overflow-wrap: anywhere`: lines break at spaces
 * (not at no-break spaces), and a word wider than the box is broken wherever it must be. With
 * widths that are upper bounds ({@link estimateTextWidth}) the drawn text never needs more
 * lines. At least 1.
 */
export function estimateLineCount(text: string, fontSize: number, width: number): number {
  const space = charEm(' ') * fontSize;
  let lines = 1;
  /** Width used on the current line. */
  let used = 0;
  for (const word of text.split(' ')) {
    if (word === '') continue;
    const wordWidth = estimateTextWidth(word, fontSize);
    if (used > 0 && used + space + wordWidth <= width) {
      used += space + wordWidth;
      continue;
    }
    if (used > 0) {
      lines += 1;
      used = 0;
    }
    if (wordWidth <= width) {
      used = wordWidth;
      continue;
    }
    // Wider than a whole line: broken between characters.
    for (const char of word) {
      const charWidth = charEm(char) * fontSize;
      if (used > 0 && used + charWidth > width) {
        lines += 1;
        used = 0;
      }
      used += charWidth;
    }
  }
  return lines;
}

/**
 * `text` broken at spaces into at most `lines` lines of about the same length, joined with line
 * breaks. Words are never split, so a text with fewer words has fewer lines; a text that
 * already has line breaks is returned as it is.
 */
export function wrapBalanced(text: string, lines: number): string {
  if (lines <= 1 || text.includes('\n')) return text;
  const words = text.split(' ').filter((word) => word !== '');
  const out: string[] = [];
  let rest = words;
  for (let left = lines; left > 1 && rest.length > 1; left--) {
    // The line takes words for as long as that brings it nearer to its share of what is left.
    const share = (rest.join(' ').length - (left - 1)) / left;
    let count = 1;
    let length = rest[0]?.length ?? 0;
    while (count < rest.length - (left - 1)) {
      const next = length + 1 + (rest[count]?.length ?? 0);
      if (Math.abs(next - share) > Math.abs(length - share)) break;
      length = next;
      count++;
    }
    out.push(rest.slice(0, count).join(' '));
    rest = rest.slice(count);
  }
  out.push(rest.join(' '));
  return out.join('\n');
}

/**
 * True for an address the viewer may link to. The data files are not trusted, and a link is
 * opened by a click: anything but a web address (`javascript:`, `data:`, `file:` …) is no link.
 */
export function isWebUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
