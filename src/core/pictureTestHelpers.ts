// Shared helpers for the tests of the picture and of the page (not used by the app): a strict
// little XML reader, a seeded random source, and a map built into a flow.

import { arrangedLayout } from './arrange';
import { buildFlow, closedGroupSize, type FlowGraph } from './flow';
import { computeLayoutUncached } from './layout';
import type { LayoutResult } from './layout/types';
import type { ArchitectureModel } from './model';
import { parseArchitecture } from './parse';
import { visibleNodes, type LodLevel } from './visibility';
import { workItemContent } from './workItemContent';
import { buildWorkItemOverlay, type WorkItemOverlay } from './workItemOverlay';
import { parseWorkItems, type StoryMode } from './workitems';

export interface XmlElement {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly depth: number;
  /** Index of the element in document order. */
  readonly index: number;
  /** Index of the parent element; -1 for the root. */
  readonly parent: number;
  /** The text directly inside the element (not that of its children), entities undone. */
  readonly text: string;
}

/**
 * The elements of `text` in document order. Throws on anything that is not well-formed XML:
 * tags that do not nest, an attribute twice or unquoted, a bare `&`, `<` or `>`, text outside
 * the root, more than one root, a character XML 1.0 does not allow.
 */
export function readXml(text: string): XmlElement[] {
  const elements: (XmlElement & { text: string })[] = [];
  const stack: { name: string; index: number }[] = [];
  const entity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  let at = 0;
  let roots = 0;
  while (at < text.length) {
    const open = text.indexOf('<', at);
    const chunk = text.slice(at, open < 0 ? text.length : open);
    if (entity.test(chunk)) throw new Error(`bare & in text near ${at}`);
    if (chunk.includes('>')) throw new Error(`bare > in text near ${at}: ${chunk.slice(0, 60)}`);
    if (stack.length === 0 && chunk.trim() !== '')
      throw new Error(`text outside the root at ${at}`);
    const inside = elements[stack.at(-1)?.index ?? -1];
    if (inside) inside.text += unescapeXml(chunk);
    if (open < 0) break;
    const close = text.indexOf('>', open);
    if (close < 0) throw new Error('unclosed tag');
    const tag = text.slice(open + 1, close);
    at = close + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1);
      if (stack.pop()?.name !== name) throw new Error(`</${name}> does not close the open element`);
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const inner = selfClosing ? tag.slice(0, -1) : tag;
    const match = /^([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*="[^"<]*")*)\s*$/.exec(inner);
    if (!match?.[1]) throw new Error(`bad tag <${tag.slice(0, 80)}>`);
    const attrs = new Map<string, string>();
    for (const a of (match[2] ?? '').matchAll(/\s+([A-Za-z_:][\w:.-]*)="([^"<]*)"/g)) {
      if (attrs.has(a[1] ?? '')) throw new Error(`attribute ${a[1]} twice in <${match[1]}>`);
      if (entity.test(a[2] ?? '')) throw new Error(`bare & in attribute ${a[1]}`);
      attrs.set(a[1] ?? '', a[2] ?? '');
    }
    if (stack.length === 0) roots += 1;
    const index = elements.length;
    elements.push({
      name: match[1],
      attrs,
      depth: stack.length,
      index,
      parent: stack.at(-1)?.index ?? -1,
      text: '',
    });
    if (!selfClosing) stack.push({ name: match[1], index });
  }
  if (stack.length > 0) throw new Error(`unclosed <${stack.at(-1)?.name}>`);
  if (roots !== 1) throw new Error(`${roots} root elements`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) {
    throw new Error('a character XML does not allow');
  }
  // A surrogate without its other half.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) {
    throw new Error('a lone surrogate');
  }
  return elements;
}

/** The text of an XML attribute or of content, with the five entities of `xmlText` undone. */
export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A seeded source of numbers in [0, 1) (mulberry32): the same run every time. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseModel(yaml: string): ArchitectureModel {
  const result = parseArchitecture(yaml, { sourceName: 'test.yaml' });
  if (!result.model) throw new Error(JSON.stringify(result.errors.slice(0, 3)));
  return result.model;
}

export interface Built {
  readonly model: ArchitectureModel;
  readonly overlay: WorkItemOverlay;
  readonly layout: LayoutResult;
  readonly flow: FlowGraph;
}

/** The flow of `yaml` (with the work items of `itemsJson`) at `level`, as the app builds it. */
export async function buildMap(
  yaml: string,
  itemsJson: string | undefined,
  level: LodLevel,
  options: {
    compact?: boolean;
    closeGaps?: boolean;
    mode?: StoryMode;
    collapsed?: readonly string[];
  } = {},
): Promise<Built> {
  const model = parseModel(yaml);
  const items = itemsJson ? parseWorkItems(itemsJson).items : [];
  const mode = options.mode ?? (items.length > 0 ? 'tasks' : 'off');
  const overlay = buildWorkItemOverlay(model, items);
  const content = workItemContent(overlay, level === 'detail' ? mode : 'off');
  const reference = await computeLayoutUncached(model, undefined, content);
  const workItems = items.length > 0 && mode !== 'off' ? { overlay, mode } : undefined;
  const collapsed = new Set(options.collapsed ?? []);
  const visible = visibleNodes(model, collapsed, level);
  const layout = options.closeGaps
    ? arrangedLayout(model, reference, {
        visible,
        closedSize: (node, full) =>
          closedGroupSize(model, node, full, {
            compactCollapsed: true,
            ...(workItems ? { workItems } : {}),
          }),
        content,
      })
    : reference;
  const flow = buildFlow(model, layout, {
    lodLevel: level,
    collapsedIds: collapsed,
    compactCollapsed: options.compact === true || options.closeGaps === true,
    ...(workItems ? { workItems } : {}),
  });
  return { model, overlay, layout, flow };
}
