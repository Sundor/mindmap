import { describe, expect, it } from 'vitest';
import { estimateLineCount, estimateTextWidth, plural, wrapBalanced } from './text';

describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'component')).toBe('1 component');
    expect(plural(1, 'edge')).toBe('1 edge');
  });

  it('uses the plural otherwise, zero included', () => {
    expect(plural(0, 'subcomponent')).toBe('0 subcomponents');
    expect(plural(2, 'domain')).toBe('2 domains');
    expect(plural(44, 'row')).toBe('44 rows');
  });
});

describe('estimateTextWidth', () => {
  it('scales with the font size and adds up over the characters', () => {
    expect(estimateTextWidth('', 16)).toBe(0);
    expect(estimateTextWidth('abc', 32)).toBeCloseTo(2 * estimateTextWidth('abc', 16));
    expect(estimateTextWidth('ab cd', 16)).toBeCloseTo(
      estimateTextWidth('ab', 16) + estimateTextWidth(' ', 16) + estimateTextWidth('cd', 16),
    );
  });

  it('is an upper bound: no character class is narrower than its widest common glyph', () => {
    // Advance widths in em of Arial Bold, the widest of the fallback fonts for these glyphs.
    const arialBold: Readonly<Record<string, number>> = {
      ' ': 0.278,
      i: 0.278,
      l: 0.278,
      I: 0.278,
      '.': 0.278,
      t: 0.333,
      r: 0.389,
      '-': 0.333,
      '·': 0.333,
      a: 0.556,
      o: 0.611,
      g: 0.611,
      m: 0.889,
      w: 0.778,
      A: 0.722,
      O: 0.778,
      M: 0.833,
      W: 0.944,
      '0': 0.556,
      '8': 0.556,
      '&': 0.722,
      '+': 0.584,
    };
    for (const [char, em] of Object.entries(arialBold)) {
      expect(estimateTextWidth(char, 100), char).toBeGreaterThanOrEqual(em * 100);
    }
    // Segoe UI Bold (what system-ui is on Windows), where it is wider than Arial or has glyphs
    // Arial lacks: quotes, dashes, ligatures, fractions, Cyrillic capitals, arrows, emoji.
    const segoeBold: Readonly<Record<string, number>> = {
      '"': 0.493,
      '*': 0.455,
      '@': 0.96,
      M: 0.96,
      W: 1.005,
      m: 0.92,
      '—': 1.0,
      '…': 0.912,
      Æ: 0.935,
      æ: 0.832,
      Œ: 0.94,
      œ: 0.928,
      '©': 0.89,
      '®': 0.89,
      '½': 0.965,
      '¾': 0.979,
      '‰': 1.256,
      '™': 0.773,
      Ж: 0.993,
      Ш: 1.011,
      Щ: 1.066,
      Ю: 1.064,
      Ω: 0.766,
      '→': 0.863,
      '🚀': 1.373,
    };
    for (const [char, em] of Object.entries(segoeBold)) {
      expect(estimateTextWidth(char, 100), char).toBeGreaterThanOrEqual(em * 100);
    }
    // A run of em dashes is not taken for narrower than it is drawn.
    expect(estimateTextWidth('—'.repeat(16), 22)).toBeGreaterThanOrEqual(16 * 22);
    expect(estimateTextWidth('W', 10)).toBeGreaterThan(estimateTextWidth('i', 10));
    // A no-break space is as wide as a space; anything unknown counts as a capital at least.
    expect(estimateTextWidth('\u00a0', 10)).toBe(estimateTextWidth(' ', 10));
    expect(estimateTextWidth('é', 10)).toBeGreaterThanOrEqual(estimateTextWidth('E', 10));
    expect(estimateTextWidth('図', 10)).toBeGreaterThanOrEqual(10);
  });
});

describe('estimateLineCount', () => {
  const word = estimateTextWidth('word', 10);
  const space = estimateTextWidth(' ', 10);

  it('is one line for an empty or a fitting text', () => {
    expect(estimateLineCount('', 10, 100)).toBe(1);
    expect(estimateLineCount('word word', 10, 2 * word + space)).toBe(1);
  });

  it('breaks at spaces when the next word does not fit', () => {
    expect(estimateLineCount('word word', 10, 2 * word + space - 0.5)).toBe(2);
    expect(estimateLineCount('word word word word word', 10, 2 * word + space)).toBe(3);
  });

  it('does not break at a no-break space', () => {
    const width = estimateTextWidth('word\u00a0·', 10);
    expect(estimateLineCount('word\u00a0· word\u00a0· word', 10, width)).toBe(3);
    // Room for two words but not for the dot as well: the dot takes its word down with it.
    expect(estimateLineCount('word word\u00a0· word', 10, 2 * word + space)).toBe(3);
    expect(estimateLineCount('word word · word', 10, 2 * word + space)).toBe(2);
  });

  it('breaks a word wider than the box between characters', () => {
    const char = estimateTextWidth('a', 10);
    expect(estimateLineCount('aaaaaaaaaa', 10, 4 * char)).toBe(3);
    expect(estimateLineCount('bb aaaaaaaaaa b', 10, 4 * char)).toBe(4);
    expect(estimateLineCount('aaa', 10, 1)).toBe(3);
  });

  it('never needs fewer lines in a narrower box', () => {
    const text =
      'Rule Editor\u00a0· Config Manager\u00a0· Simulation Workbench\u00a0· Tag Database';
    let previous = 1;
    for (let width = 600; width >= 40; width -= 20) {
      const lines = estimateLineCount(text, 16, width);
      expect(lines).toBeGreaterThanOrEqual(previous);
      previous = lines;
    }
    expect(previous).toBeGreaterThan(4);
  });
});

describe('wrapBalanced', () => {
  it('breaks a text at spaces into lines of about the same length', () => {
    expect(wrapBalanced('saves drafts and releases', 1)).toBe('saves drafts and releases');
    expect(wrapBalanced('saves drafts and releases', 2)).toBe('saves drafts\nand releases');
    expect(wrapBalanced('saves drafts and releases', 3)).toBe('saves\ndrafts and\nreleases');
    expect(wrapBalanced('tag changes', 2)).toBe('tag\nchanges');
  });

  it('never splits a word, and keeps a text that has line breaks as it is', () => {
    expect(wrapBalanced('tag changes', 3)).toBe('tag\nchanges');
    expect(wrapBalanced('telemetry', 3)).toBe('telemetry');
    expect(wrapBalanced('one two\nthree four five', 3)).toBe('one two\nthree four five');
    expect(wrapBalanced('', 2)).toBe('');
  });
});
