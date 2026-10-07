// A closed group drawn shrunk (Detail tab → Shrink collapsed groups): a small box in the middle of
// the group's full box, with the group name and the names of its children.

import type { Rect } from './layout/types';
import { estimateLineCount, estimateTextWidth } from './text';

/**
 * Geometry of a closed group drawn shrunk (`FlowView.compactCollapsed`), in canvas pixels. The
 * one place for these numbers: the box is sized from them here, and the style sheet gets the
 * type sizes and paddings as custom properties (`--compact-*`, set in src/ui/nodes.tsx).
 * `border` and `chevron` mirror the general group rules in src/ui/styles.css.
 */
export const COMPACT_GROUP = {
  /** Preferred width of the box; it gets wider for a long name or when the list needs it. */
  width: 340,
  /** Step in which the box is widened until the list fits the height of the full box. */
  widthStep: 20,
  /** Border on each side (`.arch-group.arch-collapsed`: 4px double). */
  border: 4,
  /** Left and right padding of the header and of the list. */
  paddingX: 12,
  /** What the chevron takes of the header line: 22px wide, −4px margin, 8px gap. */
  chevron: 26,
  /** Font size and line height of the group name (bold). */
  nameSize: 22,
  nameLine: 30,
  headerTop: 6,
  headerBottom: 2,
  /** Font size and line height of the list of child names. */
  textSize: 16,
  textLine: 22,
  bodyTop: 2,
  bodyBottom: 6,
  /** Height of the line with the work-item badge below the list, when the group has one. */
  badgeLine: 26,
  /** Between two child names: the dot stays with the name before it when a line breaks. */
  separator: ' · ',
} as const;

export interface CompactGroupBox {
  /** The box, centred on the middle of the full box and never larger than it. */
  readonly rect: Rect;
  /**
   * How many of the child names (from the end) are not listed because even the full box cannot
   * hold them all; the list then ends with "+k more". 0 when every name is listed. When it is
   * all of them (the full box has no room for even the first name), there is nothing to gain
   * from the shrunk style: the group is drawn as an ordinary collapsed one ({@link fitsCompact}).
   */
  readonly hidden: number;
}

/**
 * The list a shrunk group shows: the child names, or all but the last `hidden` of them followed
 * by "+k more".
 */
export function compactGroupText(childNames: readonly string[], hidden = 0): string {
  if (hidden <= 0) return childNames.join(COMPACT_GROUP.separator);
  const shown = childNames.slice(0, Math.max(0, childNames.length - hidden));
  return [...shown, `+${childNames.length - shown.length} more`].join(COMPACT_GROUP.separator);
}

/** Height a shrunk box `width` wide needs for `name`, the list `text` and `extra` below it. */
function neededHeight(width: number, name: string, text: string, extra: number): number {
  const c = COMPACT_GROUP;
  const inner = width - 2 * c.border - 2 * c.paddingX;
  const nameLines = estimateLineCount(name, c.nameSize, Math.max(1, inner - c.chevron));
  const textLines = estimateLineCount(text, c.textSize, Math.max(1, inner));
  return (
    2 * c.border +
    c.headerTop +
    nameLines * c.nameLine +
    c.headerBottom +
    c.bodyTop +
    textLines * c.textLine +
    extra +
    c.bodyBottom
  );
}

/**
 * The box of a closed group drawn shrunk: centred on the middle of its full box `rect`, never
 * larger than it, and large enough for `name` and all of `childNames` (the estimates of
 * src/core/text.ts are upper bounds for the usual scripts, so the drawn text fits).
 *
 * The box is `COMPACT_GROUP.width` wide, or as wide as the name needs to stay on one line; when
 * the list would then be taller than the full box, it is widened until it fits. Only when the
 * full box itself is too small for everything is the full box used, listing as many names as it
 * holds followed by "+k more" — or none (`hidden` = all of them) when not even the first name
 * fits beside it.
 *
 * `extra` is further height the box needs below the list (the work-item badge of a group that
 * has one: `COMPACT_GROUP.badgeLine`).
 */
export function compactGroupBox(
  rect: Rect,
  name: string,
  childNames: readonly string[],
  extra = 0,
): CompactGroupBox {
  const c = COMPACT_GROUP;
  const centred = (width: number, height: number): Rect => ({
    x: Math.round(rect.x + (rect.width - width) / 2),
    y: Math.round(rect.y + (rect.height - height) / 2),
    width,
    height,
  });
  const text = compactGroupText(childNames);
  const nameWidth =
    Math.ceil(estimateTextWidth(name, c.nameSize)) + 2 * c.border + 2 * c.paddingX + c.chevron;
  let width = Math.min(rect.width, Math.max(c.width, nameWidth));
  for (;;) {
    const height = neededHeight(width, name, text, extra);
    if (height <= rect.height) return { rect: centred(width, height), hidden: 0 };
    if (width >= rect.width) break;
    width = Math.min(rect.width, width + c.widthStep);
  }
  // Not even the full box holds everything: list what fits.
  for (let hidden = 1; hidden < childNames.length; hidden++) {
    const shorter = compactGroupText(childNames, hidden);
    if (neededHeight(rect.width, name, shorter, extra) <= rect.height) return { rect, hidden };
  }
  return { rect, hidden: childNames.length };
}

/**
 * Whether a closed group is worth drawing shrunk: its box lists at least one child by name. A
 * list of nothing but "+3 more" says less than the summary of an ordinary collapsed group
 * ("3 subcomponents"), which is drawn instead.
 */
export function fitsCompact(box: CompactGroupBox, childNames: readonly string[]): boolean {
  return box.hidden < childNames.length;
}

/** The rectangle of {@link compactGroupBox}. */
export function compactGroupRect(
  rect: Rect,
  name: string,
  childNames: readonly string[],
  extra = 0,
): Rect {
  return compactGroupBox(rect, name, childNames, extra).rect;
}
