// The picture of the map (src/core/mapPicture.ts) repeats colours and numbers of the style
// sheet. This test reads the style sheet and fails when one of them is no longer the same.

import { describe, expect, it } from 'vitest';
import {
  COLOR_SCHEMES,
  EDGE_LABEL,
  EDGE_OPACITY,
  edgeLineStyle,
  HEADER_HEIGHT,
  NODE_OPACITY,
  PALETTE_DECLARATIONS,
  PALETTE_PROPERTIES,
  parseColor,
  PICTURE_FONT_FAMILY,
  PICTURE_PALETTE,
  PICTURE_STYLE,
  type ColorScheme,
} from '../core';
import css from './styles.css?raw';

interface Rule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
  /** Inside `@media (prefers-color-scheme: dark)`. */
  readonly dark: boolean;
  /** Inside another `@media` (a width, a pointer): not what the picture repeats. */
  readonly conditional: boolean;
}

const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The rules of a style sheet, with the media condition they stand under. */
function readRules(text: string): Rule[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const walk = (from: number, to: number, dark: boolean, conditional: boolean): void => {
    let at = from;
    while (at < to) {
      const open = source.indexOf('{', at);
      if (open < 0 || open >= to) return;
      let depth = 1;
      let close = open + 1;
      while (close < to && depth > 0) {
        if (source[close] === '{') depth += 1;
        else if (source[close] === '}') depth -= 1;
        close += 1;
      }
      const prelude = squeeze(source.slice(at, open));
      const body = source.slice(open + 1, close - 1);
      if (prelude.startsWith('@media')) {
        const isDark = /prefers-color-scheme:\s*dark/.test(prelude);
        walk(open + 1, close - 1, dark || isDark, conditional || !isDark);
      } else if (!prelude.startsWith('@')) {
        const declarations = new Map<string, string>();
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon > 0) {
            declarations.set(squeeze(part.slice(0, colon)), squeeze(part.slice(colon + 1)));
          }
        }
        rules.push({ selectors: prelude.split(',').map(squeeze), declarations, dark, conditional });
      }
      at = close;
    }
  };
  walk(0, source.length, false, false);
  return rules;
}

const RULES = readRules(css);

/** The value `property` has under `selector` in `scheme`: the last rule that sets it wins. */
function declared(selector: string, property: string, scheme: ColorScheme = 'light'): string {
  let value: string | undefined;
  for (const rule of RULES) {
    if (rule.conditional || (rule.dark && scheme !== 'dark')) continue;
    if (!rule.selectors.includes(squeeze(selector))) continue;
    value = rule.declarations.get(property) ?? value;
  }
  if (value === undefined) throw new Error(`styles.css has no ${property} under ${selector}`);
  return value;
}

/** As {@link declared}, undefined where the style sheet has no such declaration. */
function declaredIfAny(selector: string, property: string): string | undefined {
  try {
    return declared(selector, property);
  } catch {
    return undefined;
  }
}

/** `value` with every `var(--name)` replaced by what `:root` gives it in `scheme`. */
function resolved(value: string, scheme: ColorScheme): string {
  return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) =>
    resolved(declared(':root', name, scheme), scheme),
  );
}

/** The colour the picture has under the name `entry` in `scheme`. */
function paletteColor(scheme: ColorScheme, entry: string): string {
  const color = new Map(Object.entries(PICTURE_PALETTE[scheme])).get(entry);
  if (color === undefined) throw new Error(`the palette has no ${entry}`);
  return color;
}

const px = (value: string): number => {
  const match = /^(-?[\d.]+)px$/.exec(value);
  if (!match) throw new Error(`not a length in pixels: ${value}`);
  return Number(match[1]);
};

describe('the style sheet is read', () => {
  it('has content (vitest runs with css: true), rules, and a block for the dark scheme', () => {
    expect(css.length).toBeGreaterThan(20000);
    expect(RULES.length).toBeGreaterThan(200);
    expect(RULES.some((rule) => rule.dark)).toBe(true);
  });
});

describe('the palette is the style sheet', () => {
  it('every entry with a custom property has the value of that property, in both schemes', () => {
    for (const scheme of COLOR_SCHEMES) {
      for (const [entry, property] of Object.entries(PALETTE_PROPERTIES)) {
        expect(paletteColor(scheme, entry), `${scheme} ${property}`).toBe(
          declared(':root', property, scheme),
        );
      }
    }
  });

  it('the two entries read from a declaration are the first colour of its value', () => {
    for (const scheme of COLOR_SCHEMES) {
      for (const [entry, at] of Object.entries(PALETTE_DECLARATIONS)) {
        const value = resolved(declared(at.selector, at.property, scheme), scheme);
        const colour = /#[0-9a-f]{3,6}\b|rgba?\([^)]*\)/i.exec(value)?.[0];
        expect(colour, `${at.selector} { ${at.property}: ${value} }`).toBeDefined();
        expect(parseColor(paletteColor(scheme, entry)), `${scheme} ${entry}`).toEqual(
          parseColor(colour ?? ''),
        );
      }
    }
  });

  it('every entry is in one of the two tables, and the font is that of the page', () => {
    const listed = [...Object.keys(PALETTE_PROPERTIES), ...Object.keys(PALETTE_DECLARATIONS)];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.keys(PICTURE_PALETTE.light).sort());
    expect(Object.keys(PICTURE_PALETTE.dark).sort()).toEqual(
      Object.keys(PICTURE_PALETTE.light).sort(),
    );
    expect(squeeze(declared(':root', 'font-family')).replace(/, /g, ',')).toBe(
      PICTURE_FONT_FAMILY.replace(/, /g, ','),
    );
  });
});

describe('the numbers of the picture are those of the rules', () => {
  const s = PICTURE_STYLE;

  it('marks: dimmed, paled, held back', () => {
    expect(Number(declared('.react-flow__node.arch-dimmed', 'opacity'))).toBe(NODE_OPACITY.dimmed);
    expect(Number(declared('.arch-edge-label.arch-dimmed', 'opacity'))).toBe(NODE_OPACITY.dimmed);
    expect(Number(declared('.arch-workitems-above.arch-dimmed', 'opacity'))).toBe(
      NODE_OPACITY.dimmed,
    );
    expect(Number(declared('.react-flow__edge.arch-dimmed', 'opacity'))).toBe(EDGE_OPACITY.dimmed);
    expect(Number(declared('.react-flow__node.arch-faded', 'opacity'))).toBe(NODE_OPACITY.faded);
    expect(Number(declared('.arch-edge-label.arch-faded', 'opacity'))).toBe(NODE_OPACITY.faded);
    expect(Number(declared('.react-flow__edge.arch-faded', 'opacity'))).toBe(EDGE_OPACITY.faded);
    // What is held back is not drawn at all.
    expect(declared('.react-flow__edge.arch-quiet', 'opacity')).toBe('0');
    expect(declared('.arch-edge-label.arch-quiet', 'display')).toBe('none');
  });

  it('edges: widths, dashes and caps by kind, aggregate and selection', () => {
    const path = (edge: string) => `.react-flow__edge${edge} .react-flow__edge-path`;
    const width = (edge: string) => Number(declared(path(edge), 'stroke-width'));
    const dash = (edge: string) => declared(path(edge), 'stroke-dasharray');
    expect(width('')).toBe(edgeLineStyle('dataflow', false, false).width);
    expect(edgeLineStyle('dataflow', false, false).dash).toBeUndefined();
    expect(dash('.arch-edge-dependency')).toBe(edgeLineStyle('dependency', false, false).dash);
    expect(dash('.arch-edge-control')).toBe(edgeLineStyle('control', false, false).dash);
    expect(declared(path('.arch-edge-control'), 'stroke-linecap')).toBe(
      edgeLineStyle('control', false, false).cap,
    );
    expect(dash('.arch-edge-config')).toBe(edgeLineStyle('config', false, false).dash);
    expect(width('.arch-edge-config')).toBe(edgeLineStyle('config', false, false).width);
    expect(width('.selected')).toBe(edgeLineStyle('dependency', false, true).width);
    expect(width('.arch-edge-config.selected')).toBe(edgeLineStyle('config', false, true).width);
    expect(width('.arch-edge-aggregate')).toBe(edgeLineStyle('control', true, false).width);
    expect(width('.arch-edge-aggregate.selected')).toBe(edgeLineStyle('config', true, true).width);
  });

  it('boxes: radius, borders, header, level tag, chevron, selection', () => {
    expect(px(declared('.arch-node', 'border-radius'))).toBe(s.radius);
    expect(declared('.arch-node', 'border')).toBe('1px solid var(--leaf-border)');
    expect(declared('.arch-group.arch-level-domain', 'border')).toBe(
      `${s.domainBorder}px solid var(--domain-border)`,
    );
    expect(px(declared('.arch-group.arch-collapsed', 'border-width'))).toBe(s.closedBorder);
    expect(declared('.arch-group.arch-collapsed', 'border-style')).toBe('double');
    expect(declared('.arch-node.arch-node-placed', 'border-style')).toBe('dashed');
    expect(px(declared(':root', '--header-height'))).toBe(HEADER_HEIGHT);
    expect(declared('.arch-group-header', 'padding')).toBe(`0 ${s.headerPaddingX}px`);
    expect(px(declared('.arch-group-header', 'gap'))).toBe(s.headerGap);
    expect(Number(declared('.arch-group-header', 'font-weight'))).toBe(s.headerWeight);
    expect(px(declared('.arch-group.arch-level-domain > .arch-group-header', 'font-size'))).toBe(
      s.headerFontSize[0],
    );
    expect(px(declared('.arch-group.arch-level-component > .arch-group-header', 'font-size'))).toBe(
      s.headerFontSize[1],
    );
    expect(px(declared('.arch-chevron', 'width'))).toBe(s.chevron.size);
    expect(px(declared('.arch-chevron', 'margin-left'))).toBe(-s.chevron.pull);
    expect(Number(declared('.arch-chevron:disabled', 'opacity'))).toBe(s.chevron.disabledOpacity);
    expect(px(declared('.arch-level-tag', 'font-size'))).toBe(s.levelTag.size);
    expect(Number(declared('.arch-level-tag', 'font-weight'))).toBe(s.levelTag.weight);
    expect(declared('.arch-level-tag', 'letter-spacing')).toBe(`${s.levelTag.spacing}em`);
    expect(Number(declared('.arch-level-tag', 'opacity'))).toBe(s.levelTag.opacity);
    expect(declared('.arch-level-tag', 'text-transform')).toBe('uppercase');
    expect(px(declared('.arch-collapsed-body', 'font-size'))).toBe(s.closedBody.size);
    expect(Number(declared('.arch-collapsed-body', 'font-weight'))).toBe(s.closedBody.weight);
    expect(declared('.react-flow__node.selected > .arch-node', 'outline')).toBe(
      `${s.selected.width}px solid var(--node-selected)`,
    );
    expect(px(declared('.react-flow__node.selected > .arch-node', 'outline-offset'))).toBe(
      s.selected.offset,
    );
  });

  it('the hatch of a closed group: its direction, its stripe and its distance; and that a closed group clips', () => {
    const h = s.hatch;
    // 135deg draws the stripes from the lower left to the upper right: a pattern turned by 45°.
    const hatch = `repeating-linear-gradient(${90 + h.turn}deg, var(--collapsed-hatch) 0 ${h.stripe}px, transparent ${h.stripe}px ${h.every}px)`;
    expect(declared('.arch-group.arch-collapsed', 'background').startsWith(`${hatch},`)).toBe(true);
    expect(
      declared('.arch-group.arch-collapsed.arch-tinted', 'background').startsWith(`${hatch},`),
    ).toBe(true);
    // The gradient starts at the inside of the border (the default origin), and what a lens
    // draws outside the inside of the border is cut there.
    expect(declaredIfAny('.arch-group.arch-collapsed', 'background-origin')).toBeUndefined();
    expect(declared('.arch-group.arch-collapsed', 'overflow')).toBe('hidden');
    expect(px(declared('.arch-group.arch-collapsed', 'border-width'))).toBe(s.closedBorder);
  });

  it('leaves: the type of a name by level', () => {
    expect(px(declared('.arch-leaf.arch-level-domain', 'font-size'))).toBe(s.leafFont[0].size);
    expect(Number(declared('.arch-leaf.arch-level-domain', 'font-weight'))).toBe(
      s.leafFont[0].weight,
    );
    expect(px(declared('.arch-leaf.arch-level-component', 'font-size'))).toBe(s.leafFont[1].size);
    expect(Number(declared('.arch-leaf.arch-level-component', 'font-weight'))).toBe(
      s.leafFont[1].weight,
    );
    expect(px(declared('.arch-leaf', 'font-size'))).toBe(s.leafFont[2].size);
    expect(declared('.arch-leaf', 'padding')).toBe(`0 ${s.leafPaddingX}px`);
    expect(declared('.arch-node-name', 'text-overflow')).toBe('ellipsis');
  });

  it('the larger titles of the domains level', () => {
    const far = ".app[data-lod='domains'][data-zoom-lod='domains']";
    const domain = `${far} .arch-level-domain:not(.arch-compact)`;
    expect(px(declared(`${domain} .arch-node-name`, 'font-size'))).toBe(s.largeTitle.size);
    expect(Number(declared(`${domain} .arch-node-name`, 'line-height')) * s.largeTitle.size).toBe(
      s.largeTitle.line,
    );
    expect(Number(declared(`${domain} .arch-node-name`, 'line-clamp'))).toBe(s.largeTitle.maxLines);
    expect(px(declared(`${domain} > .arch-group-header`, 'padding-top'))).toBe(
      s.largeTitle.padding,
    );
    expect(declared(`${domain} .arch-level-tag`, 'display')).toBe('none');
    expect(px(declared(`${domain} .arch-collapsed-body`, 'font-size'))).toBe(s.largeTitle.body);
    expect(px(declared(`${far} .arch-band-gutter`, 'font-size'))).toBe(s.largeTitle.band);
    expect(px(declared(`${far} .arch-band-title`, 'font-size'))).toBe(s.largeTitle.unassigned);
    expect(Number(declared(`${domain} .arch-badge`, '--badge-scale'))).toBe(s.largeTitle.badge);
    expect(px(declared('.arch-band-gutter', 'font-size'))).toBe(s.band.size);
    expect(px(declared('.arch-band-title', 'font-size'))).toBe(s.band.unassigned);
  });

  it('lenses: the tint, the strips, the bar', () => {
    expect(px(declared('.arch-tinted::before', 'height'))).toBe(s.tint.stripe);
    const share = (selector: string) =>
      Number(/var\(--tint\) (\d+)%/.exec(declared(selector, 'background'))?.[1]) / 100;
    expect(share('.arch-leaf.arch-tinted')).toBe(s.tint.leaf);
    expect(share('.arch-group.arch-tinted')).toBe(s.tint.group);
    expect(share('.arch-group.arch-level-domain.arch-tinted')).toBe(s.tint.group);
    expect(share('.arch-group.arch-collapsed.arch-tinted')).toBe(s.tint.closed);
    // The summary of a closed, tinted group: mixed towards the text colour once the style sheet
    // has the rule, plain secondary text until then.
    const summary = declaredIfAny(
      '.arch-group.arch-collapsed.arch-tinted .arch-collapsed-body',
      'color',
    );
    expect(s.tint.closedText).toBe(
      summary === undefined
        ? 0
        : Number(/var\(--fg\) (\d+)%, var\(--muted\)/.exec(summary)?.[1]) / 100,
    );
    expect(px(declared('.arch-heat', 'width'))).toBe(s.heat.width);
    expect(px(declared('.arch-heat-left', 'left'))).toBe(-1);
    expect(px(declared('.arch-progress', 'height'))).toBe(s.progress.height);
    expect(px(declared('.arch-progress', 'left'))).toBe(s.progress.inset);
    expect(px(declared('.arch-progress', 'right'))).toBe(s.progress.inset);
    expect(
      Number(/var\(--fg\) (\d+)%/.exec(declared('.arch-progress', 'background'))?.[1]) / 100,
    ).toBe(s.progress.track);
  });

  it('edge labels and work-item lines', () => {
    expect(px(declared('.arch-edge-label', 'font-size'))).toBe(EDGE_LABEL.fontSize);
    expect(Number(declared('.arch-edge-label', 'line-height'))).toBe(s.label.line);
    expect(declared('.arch-edge-label', 'padding')).toBe(`1px ${s.label.paddingX}px`);
    expect(declared('.arch-edge-label.arch-edge-label-count', 'padding')).toBe(
      `1px ${s.label.countPaddingX}px`,
    );
    expect(Number(declared('.arch-edge-label.arch-edge-label-count', 'font-weight'))).toBe(
      s.label.countWeight,
    );
    expect(declared('.arch-edge-label-dependency', 'border')).toBe(
      '1px dashed var(--edge-dependency)',
    );
    expect(declared('.arch-edge-label-control', 'border')).toBe('1px dotted var(--edge-control)');
    expect(Number(declared('.arch-workitem-closed .arch-workitem-text', 'opacity'))).toBe(
      s.closedItem.text,
    );
    expect(declared('.arch-workitem-closed .arch-workitem-text', 'text-decoration')).toBe(
      'line-through',
    );
    expect(Number(declared('.arch-workitem-closed .wi-icon', 'opacity'))).toBe(s.closedItem.icon);
  });
});
