import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import { nodeColoring } from './colorBy';
import type { SchemeColor } from './model';
import { COMPACT_GROUP, compactGroupText } from './compactGroup';
import { quietEdges } from './edgesOnDemand';
import {
  aggregateCountLabel,
  EDGE_LABEL,
  flowEdgeLabel,
  type FlowGraph,
  type FlowNode,
} from './flow';
import { focusFlow, focusSet } from './focus';
import type { Rect } from './layout/types';
import {
  coloringTitle,
  curveBounds,
  drawnExtent,
  EDGE_OPACITY,
  edgeLineStyle,
  heatPercent,
  heatShare,
  heatStripTitle,
  KEY_TEXTS,
  mapSvg,
  NODE_OPACITY,
  nodeElementId,
  PICTURE_MARGIN,
  PICTURE_MIN_TEXT_WIDTH,
  PICTURE_STYLE,
  progressBarTitle,
  svgAtSize,
  type MapPicture,
  type PictureColoring,
} from './mapPicture';
import { EDGE_KINDS, NODE_LEVEL_NAMES, type EdgeKind } from './model';
import {
  colorHex,
  ELLIPSIS,
  estimateMeasure,
  mixColors,
  parseColor,
  PICTURE_PALETTE,
  xmlText,
  type TextMeasure,
} from './pictureKit';
import { buildMap, readXml, seeded, unescapeXml, type XmlElement } from './pictureTestHelpers';
import { curvePoint, labelPoint, type Curve } from './route';
import { highlightFlow } from './selection';
import { plural } from './text';
import { WORK_ITEM_GEOMETRY, type WorkItemLine } from './workItemContent';
import type { WorkItemCounts } from './workItemOverlay';
import { heatByWork, progressByNode } from './workload';

const BASE = { scheme: 'light', title: 't', description: 'd' } as const;

/** Real widths of a font with fixed widths, narrower than every estimate. */
const mono: TextMeasure = Object.assign(
  (text: string, size: number) => [...text].length * size * 0.45,
  { exact: true },
);

/**
 * What every picture must be: well-formed, without a number that is none, without anything a
 * policy or an image forbids, every reference defined, every `id` once — and, for a picture of
 * the whole flow, every box once, the shown edges in order and one label per edge that has one.
 */
function check(svg: string, flow: FlowGraph, whole = true): XmlElement[] {
  const elements = readXml(svg);
  expect(svg).not.toMatch(/NaN|undefined|Infinity|\[object/);
  expect(svg).not.toMatch(
    /<style|\sstyle=|<script|<image|<use|<marker|<foreignObject|<filter|<a[\s>]|href=|\son[a-z]+=|url\((?!#am-)/,
  );
  const ids = elements.map((e) => e.attrs.get('id')).filter((id) => id !== undefined);
  expect(new Set(ids).size).toBe(ids.length);
  for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(ref[1]);
  expect(elements[0]?.name).toBe('svg');
  expect(elements[0]?.attrs.get('xmlns')).toBe('http://www.w3.org/2000/svg');
  if (whole) {
    const boxes = flow.nodes.filter((n) => n.type !== 'band');
    const count = new Map<string, number>();
    for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
    for (const node of boxes) expect(count.get(nodeElementId(node.id)), node.id).toBe(1);
    expect(elements.filter((e) => e.attrs.has('data-node'))).toHaveLength(boxes.length);
    const shown = flow.edges.filter((e) => e.data.quiet !== true);
    const drawn = elements
      .filter((e) => e.attrs.has('data-edge'))
      .map((e) => e.attrs.get('data-edge'));
    expect(drawn.map((id) => unescapeXml(id ?? ''))).toEqual(shown.map((e) => e.id));
    expect(elements.filter((e) => e.attrs.has('data-edge-label'))).toHaveLength(
      shown.filter((e) => flowEdgeLabel(e.data) !== undefined && e.data.labelHidden !== true)
        .length,
    );
    expect(elements.filter((e) => e.attrs.has('data-band'))).toHaveLength(
      flow.nodes.filter((n) => n.type === 'band').length,
    );
  }
  return elements;
}

function group(elements: XmlElement[], attribute: string, value: string): XmlElement {
  const found = elements.find((e) => e.attrs.get(attribute) === value);
  if (!found) throw new Error(`no element with ${attribute}="${value}"`);
  return found;
}

function childrenOf(elements: XmlElement[], parent: XmlElement): XmlElement[] {
  return elements.filter((e) => e.parent === parent.index);
}

function translateOf(element: XmlElement): { x: number; y: number } {
  const match = /^translate\((-?[\d.]+) (-?[\d.]+)\)$/.exec(element.attrs.get('transform') ?? '');
  if (!match) throw new Error(`no translate on <${element.name}>`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A part of a parsed structure file with `prefix` before every ID: those a node or an edge is
 * given, the ends of an edge, and the lists of IDs a flow names.
 */
function withPrefix(value: unknown, prefix: string): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown) => withPrefix(entry, prefix));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && ['id', 'from', 'to'].includes(key)) {
      out[key] = `${prefix}${entry}`;
    } else if (isStrings(entry) && ['nodes', 'edges', 'steps'].includes(key)) {
      out[key] = entry.map((id) => `${prefix}${id}`);
    } else {
      out[key] = withPrefix(entry, prefix);
    }
  }
  return out;
}

describe('the example at every level, in both schemes, with every lens', () => {
  it('is well-formed, complete, and free of what a policy or an image forbids', async () => {
    for (const level of ['domains', 'components', 'subcomponents', 'detail'] as const) {
      const { model, overlay, flow } = await buildMap(exampleYaml, fixtureJson, level, {
        compact: level !== 'detail',
      });
      const coloring = nodeColoring(model, 'owner');
      for (const scheme of ['light', 'dark'] as const) {
        const picture: MapPicture = {
          flow,
          scheme,
          largeTitles: level === 'domains',
          lenses: {
            heat: heatByWork(model, overlay),
            progress: progressByNode(model, overlay),
            colors: coloring.byNode,
          },
          title: 'architecture.yaml',
          description: 'd',
          heading: {
            title: 'architecture.yaml',
            note: 'Level: Components · Exported 2026-10-10 09:30',
          },
          legend: { coloring },
        };
        const out = mapSvg(picture);
        const elements = check(out.svg, flow);
        expect(out.nodeIds).toEqual(flow.nodes.filter((n) => n.type !== 'band').map((n) => n.id));
        expect(out.description).toBe('d');
        expect(out.edgeIds).toEqual(flow.edges.map((e) => e.id));
        const root = elements[0];
        expect(Number(root?.attrs.get('width'))).toBe(out.width);
        expect(Number(root?.attrs.get('height'))).toBe(out.height);
        expect(root?.attrs.get('viewBox')).toBe(`0 0 ${out.width} ${out.height}`);
        expect(root?.attrs.get('role')).toBe('img');
        expect(root?.attrs.get('aria-labelledby')).toBe('am-title am-desc');
        // The background is the page colour of the scheme, over the whole picture.
        const background = group(elements, 'data-part', 'background');
        expect(background.attrs.get('fill')).toBe(PICTURE_PALETTE[scheme].bg);
        expect(Number(background.attrs.get('width'))).toBe(out.width);
        // Same input, same text.
        expect(mapSvg(picture).svg).toBe(out.svg);
      }
    }
  }, 60_000);
});

describe('a plain map', () => {
  it('has no heading, no key and no definitions it does not use; every leaf name is text', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    const out = mapSvg({ ...BASE, flow });
    const elements = check(out.svg, flow);
    expect(elements.some((e) => e.attrs.get('data-part') === 'heading')).toBe(false);
    expect(elements.some((e) => e.attrs.get('data-part') === 'legend')).toBe(false);
    expect(out.svg).not.toContain('am-heat-');
    expect(out.svg).not.toContain('am-hatch');
    expect(out.svg).not.toContain('textLength');
    for (const node of flow.nodes) {
      if (node.type === 'leaf')
        expect(out.svg, node.data.name).toContain(`>${xmlText(node.data.name)}</text>`);
    }
    // The picture is the extent of what is drawn.
    const extent = drawnExtent(flow);
    expect(out.width).toBe(extent.width);
    expect(out.height).toBe(extent.height);
    // A description may be made from what the picture holds.
    const counted = mapSvg({
      ...BASE,
      flow,
      description: (c) => `${c.nodes} boxes & ${c.edges} edges`,
    });
    expect(counted.description).toBe(`${out.nodeIds.length} boxes & ${out.edgeIds.length} edges`);
    expect(counted.svg).toContain(
      `<desc id="am-desc">${out.nodeIds.length} boxes &amp; ${out.edgeIds.length} edges</desc>`,
    );
  });
});

describe('marks of the selection, the focus and edges on demand', () => {
  it('a selected box has its ring, the rest is dimmed; a focus pales; held-back edges are absent', async () => {
    const { model, flow } = await buildMap(exampleYaml, fixtureJson, 'components', {
      closeGaps: true,
    });
    const first = flow.nodes.find((n) => n.type !== 'band');
    if (!first) throw new Error('no box');
    const selected = highlightFlow(flow, { type: 'node', id: first.id });
    const out = mapSvg({ ...BASE, flow: selected });
    const elements = check(out.svg, selected);
    const box = group(elements, 'data-node', first.id);
    expect(
      childrenOf(elements, box).filter((e) => e.attrs.get('data-part') === 'selected'),
    ).toHaveLength(1);
    expect(box.attrs.has('opacity')).toBe(false);
    const dimmedNode = selected.nodes.find(
      (n) => n.type !== 'band' && n.className?.includes('arch-dimmed'),
    );
    const dimmedEdge = selected.edges.find((e) => e.className.includes('arch-dimmed'));
    if (!dimmedNode || !dimmedEdge) throw new Error('nothing is dimmed');
    expect(group(elements, 'data-node', dimmedNode.id).attrs.get('opacity')).toBe(
      String(NODE_OPACITY.dimmed),
    );
    expect(group(elements, 'data-edge', xmlText(dimmedEdge.id)).attrs.get('opacity')).toBe(
      String(EDGE_OPACITY.dimmed),
    );
    expect(elements.filter((e) => e.attrs.get('data-part') === 'selected')).toHaveLength(1);

    const set = focusSet(model, { type: 'flow', id: model.flows[0]?.id ?? '' });
    if (!set) throw new Error('no focus');
    const faded = focusFlow(model, selected, set);
    const out2 = mapSvg({ ...BASE, scheme: 'dark', flow: faded });
    const elements2 = check(out2.svg, faded);
    // Paled wins over dimmed where a box is both.
    const both = faded.nodes.find(
      (n) =>
        n.type !== 'band' &&
        n.className?.includes('arch-dimmed') &&
        n.className.includes('arch-faded'),
    );
    const fadedEdge = faded.edges.find((e) => e.className.includes('arch-faded'));
    if (!both || !fadedEdge) throw new Error('nothing is paled');
    expect(group(elements2, 'data-node', both.id).attrs.get('opacity')).toBe(
      String(NODE_OPACITY.faded),
    );
    expect(group(elements2, 'data-edge', xmlText(fadedEdge.id)).attrs.get('opacity')).toBe(
      String(EDGE_OPACITY.faded),
    );

    // Edges on demand: what is held back is in the picture neither as a line nor as a label.
    const quiet = quietEdges(flow, new Set([first.id]), undefined);
    const held = quiet.edges.filter((e) => e.data.quiet === true);
    expect(held.length).toBeGreaterThan(0);
    const out3 = mapSvg({ ...BASE, flow: quiet });
    const elements3 = check(out3.svg, quiet);
    for (const edge of held) {
      expect(elements3.some((e) => unescapeXml(e.attrs.get('data-edge') ?? '') === edge.id)).toBe(
        false,
      );
      expect(
        elements3.some((e) => unescapeXml(e.attrs.get('data-edge-label') ?? '') === edge.id),
      ).toBe(false);
    }
    expect(out3.edgeIds).toEqual(quiet.edges.filter((e) => e.data.quiet !== true).map((e) => e.id));
  });

  it('a label that has no place is the tooltip of its line; a dimmed label has the opacity of a box', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    const labelled = flow.edges.find(
      (e) => flowEdgeLabel(e.data) !== undefined && e.data.count === 1,
    );
    if (!labelled) throw new Error('no labelled edge');
    const hidden: FlowGraph = {
      nodes: flow.nodes,
      edges: flow.edges.map((e) =>
        e === labelled
          ? { ...e, data: { ...e.data, labelHidden: true } }
          : { ...e, data: { ...e.data, dimmed: true } },
      ),
    };
    const out = mapSvg({ ...BASE, flow: hidden });
    const elements = check(out.svg, hidden);
    const line = group(elements, 'data-edge', xmlText(labelled.id));
    expect(
      elements.some((e) => unescapeXml(e.attrs.get('data-edge-label') ?? '') === labelled.id),
    ).toBe(false);
    expect(childrenOf(elements, line)[0]?.name).toBe('title');
    expect(out.svg).toContain(`<title>${xmlText(flowEdgeLabel(labelled.data) ?? '')}`);
    const label = elements.find((e) => e.attrs.has('data-edge-label'));
    expect(label?.attrs.get('opacity')).toBe(String(NODE_OPACITY.dimmed));

    // The focus pales a label as it pales a box, and paled wins where a label is dimmed as well.
    const [paled, both] = flow.edges.filter(
      (e) => e !== labelled && flowEdgeLabel(e.data) !== undefined && e.data.labelHidden !== true,
    );
    if (!paled || !both) throw new Error('two more labels');
    const focused: FlowGraph = {
      nodes: flow.nodes,
      edges: flow.edges.map((e) =>
        e === paled
          ? { ...e, data: { ...e.data, faded: true } }
          : e === both
            ? { ...e, data: { ...e.data, faded: true, dimmed: true } }
            : e,
      ),
    };
    const focusedElements = check(mapSvg({ ...BASE, flow: focused }).svg, focused);
    for (const edge of [paled, both]) {
      expect(group(focusedElements, 'data-edge-label', xmlText(edge.id)).attrs.get('opacity')).toBe(
        String(NODE_OPACITY.faded),
      );
    }
    expect(
      focusedElements.filter((e) => e.attrs.has('data-edge-label') && e.attrs.has('opacity')),
    ).toHaveLength(2);
  });

  it('several edges drawn as one say how many: on the line, on the label, and on the line where the label has no place', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const elements = check(mapSvg({ ...BASE, flow }).svg, flow);
    const titleOf = (all: XmlElement[], parent: XmlElement) =>
      childrenOf(all, parent)
        .filter((e) => e.name === 'title')
        .map((e) => e.text);
    let several = 0;
    let single = 0;
    for (const edge of flow.edges) {
      const { count, kind } = edge.data;
      const line = group(elements, 'data-edge', xmlText(edge.id));
      expect(line.attrs.get('data-count'), edge.id).toBe(count > 1 ? String(count) : undefined);
      if (count > 1) several += 1;
      else single += 1;
      if (flowEdgeLabel(edge.data) === undefined || edge.data.labelHidden === true) continue;
      const label = group(elements, 'data-edge-label', xmlText(edge.id));
      expect(titleOf(elements, label), edge.id).toEqual(
        count > 1 ? [`${count} ${kind} edges`] : [],
      );
    }
    expect(several).toBeGreaterThan(0);
    expect(single).toBeGreaterThan(0);

    // The count that has no place is not the tooltip as "×3": the line says it in words.
    const counted = flow.edges.find(
      (e) => e.data.count > 1 && flowEdgeLabel(e.data) === aggregateCountLabel(e.data.count),
    );
    if (!counted) throw new Error('an edge with a count');
    const hidden: FlowGraph = {
      nodes: flow.nodes,
      edges: flow.edges.map((e) =>
        e === counted ? { ...e, data: { ...e.data, labelHidden: true } } : e,
      ),
    };
    const hiddenElements = check(mapSvg({ ...BASE, flow: hidden }).svg, hidden);
    const [tip] = titleOf(hiddenElements, group(hiddenElements, 'data-edge', xmlText(counted.id)));
    expect(tip?.split('\n')[0]).toBe(`${counted.data.count} ${counted.data.kind} edges`);
  });
});

describe('a part of the canvas', () => {
  it('has the size of the extent, holds only what touches it, and clips the rest', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'components');
    const whole = mapSvg({ ...BASE, flow });
    const extent: Rect = { x: 200, y: 100, width: 800, height: 500 };
    const out = mapSvg({ ...BASE, flow, extent });
    const elements = check(out.svg, flow, false);
    expect(out.width).toBe(800);
    expect(out.height).toBe(500);
    expect(out.nodeIds.length).toBeGreaterThan(0);
    expect(out.nodeIds.length).toBeLessThan(whole.nodeIds.length);
    expect(out.edgeIds.length).toBeLessThan(whole.edgeIds.length);
    const map = group(elements, 'data-part', 'map');
    expect(map.attrs.get('clip-path')).toBe('url(#am-extent)');
    expect(translateOf(map)).toEqual({ x: -200, y: -100 });
    // A box far outside is not written at all.
    const absolute = new Map<string, Rect>();
    for (const node of flow.nodes) {
      if (node.type === 'band') continue;
      const parent = node.parentId ? absolute.get(node.parentId) : undefined;
      absolute.set(node.id, {
        x: (parent?.x ?? 0) + node.position.x,
        y: (parent?.y ?? 0) + node.position.y,
        width: node.width,
        height: node.height,
      });
    }
    for (const [id, rect] of absolute) {
      const outside =
        rect.x > extent.x + extent.width + 20 ||
        rect.x + rect.width < extent.x - 20 ||
        rect.y > extent.y + extent.height + 20 ||
        rect.y + rect.height < extent.y - 20;
      const inside =
        rect.x < extent.x + extent.width &&
        rect.x + rect.width > extent.x &&
        rect.y < extent.y + extent.height &&
        rect.y + rect.height > extent.y;
      if (outside) expect(out.nodeIds, id).not.toContain(id);
      if (inside) expect(out.nodeIds, id).toContain(id);
    }
    // With a heading and a key the map lies between them, and the picture is wide enough for both.
    const narrow = mapSvg({
      ...BASE,
      flow,
      extent: { x: 200, y: 100, width: 120, height: 90 },
      heading: { title: 'A title', note: 'a note' },
      legend: {},
    });
    check(narrow.svg, flow, false);
    expect(narrow.width).toBe(PICTURE_MIN_TEXT_WIDTH);
    expect(narrow.height).toBeGreaterThan(90);
    expect(() => mapSvg({ ...BASE, flow, extent: { x: 0, y: 0, width: 0, height: 10 } })).toThrow(
      /empty/,
    );
  });

  it('a box, a line, a label and a list are each in it when they themselves reach into it', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const whole = readXml(mapSvg({ ...BASE, flow }).svg);
    const part = (extent: Rect) => mapSvg({ ...BASE, flow, extent });

    // A box paints a little beyond its rectangle (its ring, its glow, a badge on its corner): it
    // is in a picture that ends 5 px from it, and not in one that ends 20 px from it.
    const box = flow.nodes.find((n) => n.type !== 'band' && n.parentId === undefined);
    if (!box) throw new Error('a box of the top level');
    const { x, y } = box.position;
    const { width, height } = box;
    const beside = (gap: number): Rect[] => [
      { x: x + width + gap, y, width: 30, height },
      { x: x - gap - 30, y, width: 30, height },
      { x, y: y - gap - 30, width, height: 30 },
      { x, y: y + height + gap, width, height: 30 },
    ];
    for (const extent of beside(5)) expect(part(extent).nodeIds).toContain(box.id);
    for (const extent of beside(20)) expect(part(extent).nodeIds).not.toContain(box.id);

    // So does a line: half its heaviest stroke, and its arrowhead.
    const edge = flow.edges[0];
    if (!edge) throw new Error('an edge');
    const bounds = curveBounds(edge.data.curve);
    const rightOf = (gap: number): Rect => ({
      x: bounds.x + bounds.width + gap,
      y: bounds.y - 10,
      width: 30,
      height: bounds.height + 20,
    });
    expect(part(rightOf(5)).edgeIds).toContain(edge.id);
    expect(part(rightOf(20)).edgeIds).not.toContain(edge.id);

    // A label is in the picture when its own box is, not because its line is.
    const labelRect = (id: string): Rect => {
      const g = group(whole, 'data-edge-label', xmlText(id));
      const frame = childrenOf(whole, g).find((e) => e.attrs.get('data-part') === 'label-box');
      return {
        ...translateOf(g),
        width: Number(frame?.attrs.get('width')) + 1,
        height: Number(frame?.attrs.get('height')) + 1,
      };
    };
    const apart = flow.edges.find((e) => {
      if (flowEdgeLabel(e.data) === undefined || e.data.labelHidden === true) return false;
      const rect = labelRect(e.id);
      const { p0 } = e.data.curve;
      return (
        p0.x < rect.x - 20 ||
        p0.x > rect.x + rect.width + 20 ||
        p0.y < rect.y - 20 ||
        p0.y > rect.y + rect.height + 20
      );
    });
    if (!apart) throw new Error('a label away from the start of its line');
    const start = apart.data.curve.p0;
    const atStart = part({ x: start.x - 2, y: start.y - 2, width: 4, height: 4 });
    expect(atStart.edgeIds).toContain(apart.id);
    expect(atStart.labelIds).not.toContain(apart.id);
    expect(readXml(atStart.svg).some((e) => e.attrs.has('data-edge-label'))).toBe(false);
    expect(part(labelRect(apart.id)).labelIds).toContain(apart.id);

    // The list of an open group is in the picture when its own block is, not because the box is.
    const holder = flow.nodes.find((n) => n.type === 'group' && n.data.workItems?.above);
    if (!holder || holder.type === 'band') throw new Error('an open group with a list');
    const list = holder.data.workItems?.above;
    if (!list) throw new Error('a list');
    const corner = translateOf(group(whole, 'data-node', holder.id));
    expect(list.y).toBeGreaterThan(corner.y + 10);
    const atCorner = part({ x: corner.x + 1, y: corner.y + 1, width: 4, height: 4 });
    expect(atCorner.nodeIds).toContain(holder.id);
    expect(readXml(atCorner.svg).some((e) => e.attrs.has('data-list'))).toBe(false);
    const onList = part({ x: list.x + 2, y: list.y + 2, width: 4, height: 4 });
    expect(readXml(onList.svg).some((e) => e.attrs.get('data-list') === holder.id)).toBe(true);

    // An extent between pixels is grown to whole ones: the size of a picture is whole.
    const between = part({ x: 200.4, y: 100.6, width: 300.3, height: 200.2 });
    expect([between.width, between.height]).toEqual([301, 201]);
    const elements = readXml(between.svg);
    expect(translateOf(group(elements, 'data-part', 'map'))).toEqual({ x: -200, y: -100 });
    const clip = childrenOf(elements, group(elements, 'id', 'am-extent'))[0];
    expect(['x', 'y', 'width', 'height'].map((name) => clip?.attrs.get(name))).toEqual([
      '200',
      '100',
      '301',
      '201',
    ]);
  });
});

describe('names that are hostile to XML', () => {
  it('stay text', async () => {
    const yaml = [
      'version: 1',
      'domains:',
      '  - id: a',
      '    name: "A <b>&amp; \\"x\\" ]]> \\u0001\\u000b </svg><script>alert(1)</script>"',
      '    description: "it\'s <!-- -->"',
      '    components:',
      '      - { id: a.x, name: "\\U0001D4B3 emoji \\U0001F600 \\uFFFE", owner: "<o>" }',
      '      - { id: a.y, name: "y" }',
      'edges:',
      '  - { id: e, from: a.x, to: a.y, kind: control, label: "<&>", protocol: "\\"" }',
      '',
    ].join('\n');
    const { model, flow } = await buildMap(yaml, undefined, 'detail');
    const coloring = nodeColoring(model, 'owner');
    const out = mapSvg({
      ...BASE,
      flow,
      title: '<t>&</title><script>',
      description: '"d" ]]>',
      heading: { title: '</text><script>x</script>', note: '<n>' },
      legend: { coloring },
      lenses: { colors: coloring.byNode },
    });
    const elements = check(out.svg, flow);
    expect(out.svg).not.toContain('<script');
    expect(out.svg).not.toContain('<b>');
    expect(elements.filter((e) => e.name === 'script')).toHaveLength(0);
    expect(out.svg).toContain('&lt;o&gt;');
  });
});

describe('back to front as on the canvas', () => {
  it('bands, open groups, edges, leaves and closed groups, lists, labels', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const out = mapSvg({ ...BASE, flow });
    const elements = check(out.svg, flow);
    const at = (attribute: string, value?: string) => {
      const found = elements.filter((e) =>
        value === undefined ? e.attrs.has(attribute) : e.attrs.get(attribute) === value,
      );
      return { first: found[0]?.index ?? -1, last: found.at(-1)?.index ?? -1 };
    };
    const openGroup = flow.nodes.find((n) => n.type === 'group' && !n.data.collapsed);
    const leaf = flow.nodes.find((n) => n.type === 'leaf');
    if (!openGroup || !leaf) throw new Error('the example has groups and leaves');
    const lastBand = at('data-band').last;
    const group0 = at('data-node', openGroup.id).first;
    const edges = at('data-edge');
    const leaf0 = at('data-node', leaf.id).first;
    const lists = at('data-list');
    const labels = at('data-edge-label');
    expect(lastBand).toBeGreaterThan(-1);
    expect(lists.first).toBeGreaterThan(-1);
    expect(lastBand).toBeLessThan(group0);
    expect(group0).toBeLessThan(edges.first);
    expect(edges.last).toBeLessThan(leaf0);
    // Every list is above every box, every label above every list.
    expect(at('data-node').last).toBeLessThan(lists.first);
    expect(lists.last).toBeLessThan(labels.first);
    // All open groups are below all edges; all leaves above.
    for (const node of flow.nodes) {
      if (node.type === 'band') continue;
      const index = at('data-node', node.id).first;
      if (node.type === 'group' && !node.data.collapsed) expect(index).toBeLessThan(edges.first);
      else expect(index).toBeGreaterThan(edges.last);
    }
    // A box is written after the group it lies in — a box written first would be painted over —
    // and the boxes as a whole in the order of their height on the canvas.
    let nested = 0;
    for (const node of flow.nodes) {
      if (node.type === 'band' || node.parentId === undefined) continue;
      expect(at('data-node', node.id).first, node.id).toBeGreaterThan(
        at('data-node', node.parentId).first,
      );
      if (node.type === 'group' && !node.data.collapsed) nested += 1;
    }
    expect(nested).toBeGreaterThan(1);
    const heightOf = new Map(flow.nodes.map((n) => [n.id, n.zIndex]));
    const written = elements
      .filter((e) => e.attrs.has('data-node'))
      .map((e) => heightOf.get(e.attrs.get('data-node') ?? '') ?? NaN);
    expect(written).toEqual([...written].sort((a, b) => a - b));
    // The order of the flow is not that order: sorting is what the picture does.
    const listed = flow.nodes.filter((n) => n.type !== 'band').map((n) => n.zIndex);
    expect(listed).not.toEqual([...listed].sort((a, b) => a - b));
  });
});

describe('where a box is, and what it is made of', () => {
  it('a nested box is at the sum of the positions up its parents, with the size of the flow', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    const out = mapSvg({ ...BASE, flow });
    const elements = check(out.svg, flow);
    const extent = drawnExtent(flow);
    const map = group(elements, 'data-part', 'map');
    expect(translateOf(map)).toEqual({ x: -extent.x, y: -extent.y });
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    for (const node of flow.nodes) {
      if (node.type === 'band') continue;
      let x = 0;
      let y = 0;
      let at: FlowNode | undefined = node;
      while (at) {
        x += at.position.x;
        y += at.position.y;
        at = at.type === 'band' || at.parentId === undefined ? undefined : byId.get(at.parentId);
      }
      const g = group(elements, 'data-node', node.id);
      expect(translateOf(g), node.id).toEqual({ x, y });
      expect(g.attrs.get('data-level')).toBe(node.data.levelName);
      const box = childrenOf(elements, g).find((e) => e.attrs.get('data-part') === 'box');
      expect(Number(box?.attrs.get('width'))).toBe(node.width);
      expect(Number(box?.attrs.get('height'))).toBe(node.height);
      // A description is the tooltip, first in the group.
      if (node.data.description !== undefined)
        expect(childrenOf(elements, g)[0]?.name).toBe('title');
    }
    // The line of an edge is the path of the canvas.
    const edge = flow.edges[0];
    if (!edge) throw new Error('no edge');
    const { p0, c1, c2, p3 } = edge.data.curve;
    const line = childrenOf(elements, group(elements, 'data-edge', xmlText(edge.id))).find(
      (e) => e.attrs.get('data-part') === 'line',
    );
    expect(line?.attrs.get('d')).toBe(
      `M${p0.x},${p0.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p3.x},${p3.y}`,
    );
    expect(line?.attrs.get('fill')).toBe('none');
  });

  it('closed groups are hatched with a double border; a box placed by its connections is dashed', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'domains');
    const closed = flow.nodes.find((n) => n.type === 'group' && n.data.collapsed);
    if (!closed || closed.type === 'band')
      throw new Error('nothing is closed at the domains level');
    const placed: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n.type !== 'band' && n.id !== closed.id && n.type === 'group'
          ? { ...n, data: { ...n.data, placedRowName: 'Core' } }
          : n,
      ),
    };
    const out = mapSvg({ ...BASE, flow: placed });
    const elements = check(out.svg, placed);
    expect(out.svg).toContain('id="am-hatch"');
    const parts = childrenOf(elements, group(elements, 'data-node', closed.id));
    expect(parts.filter((e) => e.attrs.get('fill') === 'url(#am-hatch)')).toHaveLength(1);
    // 4 px double: two lines of a third each.
    expect(parts.filter((e) => e.attrs.get('stroke-width') === '1.33')).toHaveLength(2);
    const other = placed.nodes.find((n) => n.type === 'group' && n.id !== closed.id);
    if (!other) throw new Error('one group');
    const dashed = childrenOf(elements, group(elements, 'data-node', other.id));
    expect(dashed.some((e) => e.attrs.has('stroke-dasharray'))).toBe(true);
    expect(out.svg).toContain('placed by connections (Core)');
    // A closed group placed by its connections: one dashed line of 2 px in place of the double
    // border, and still hatched.
    const placedClosed: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n.type !== 'band' && n.id === closed.id
          ? { ...n, data: { ...n.data, placedRowName: 'Core' } }
          : n,
      ),
    };
    const closedElements = check(mapSvg({ ...BASE, flow: placedClosed }).svg, placedClosed);
    const closedParts = childrenOf(closedElements, group(closedElements, 'data-node', closed.id));
    expect(
      closedParts
        .filter((e) => e.name === 'rect' && e.attrs.get('fill') === 'none')
        .map((e) => [e.attrs.get('stroke-width'), e.attrs.get('stroke-dasharray')]),
    ).toEqual([['2', '6 4']]);
    expect(closedParts.filter((e) => e.attrs.get('data-part') === 'hatch')).toHaveLength(1);
  });
});

describe('boxes moved and resized by hand', () => {
  it('are drawn with the size and the place the flow gives them, and the picture holds them', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const before = drawnExtent(flow);
    const target = flow.nodes.find((n) => n.type === 'group' && n.parentId === undefined);
    if (!target || target.type === 'band') throw new Error('a top-level group');
    // Grown by 300 to the left and 200 upwards, beyond the bounds of the layout, and 120 wider.
    const resized: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n === target
          ? {
              ...n,
              position: { x: before.x - 300, y: before.y - 200 },
              width: n.width + 120,
              height: n.height + 40,
              style: { width: n.width + 120, height: n.height + 40 },
            }
          : n,
      ),
    };
    const extent = drawnExtent(resized);
    expect(extent.x).toBe(before.x - 300 - PICTURE_MARGIN);
    expect(extent.y).toBe(before.y - 200 - PICTURE_MARGIN);
    expect(extent.width).toBeGreaterThan(before.width);
    const out = mapSvg({ ...BASE, flow: resized });
    const elements = check(out.svg, resized);
    expect(out.width).toBe(extent.width);
    expect(out.height).toBe(extent.height);
    const g = group(elements, 'data-node', target.id);
    expect(translateOf(g)).toEqual({ x: before.x - 300, y: before.y - 200 });
    const box = childrenOf(elements, g).find((e) => e.attrs.get('data-part') === 'box');
    expect(Number(box?.attrs.get('width'))).toBe(target.width + 120);
    expect(Number(box?.attrs.get('height'))).toBe(target.height + 40);
    // The header spans the new width.
    const header = childrenOf(elements, g).find((e) => e.attrs.get('data-part') === 'header');
    expect(header?.attrs.get('d')).toContain(`H${target.width + 120 - 2 - 6}`);
    // No coordinate of the picture is negative: the map is shifted into it.
    const map = group(elements, 'data-part', 'map');
    expect(translateOf(map)).toEqual({ x: -extent.x, y: -extent.y });
  });

  it('the extent holds every box, every curve and every label of any flow', async () => {
    const random = seeded(21);
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    for (let run = 0; run < 40; run++) {
      const moved: FlowGraph = {
        edges: flow.edges,
        nodes: flow.nodes.map((n) =>
          n.type !== 'band' && random() < 0.3
            ? {
                ...n,
                position: {
                  x: n.position.x + (random() - 0.5) * 900,
                  y: n.position.y + (random() - 0.5) * 900,
                },
                width: n.width + Math.floor(random() * 200),
              }
            : n,
        ),
      };
      const extent = drawnExtent(moved);
      const out = mapSvg({ ...BASE, flow: moved });
      const elements = readXml(out.svg);
      expect(out.width).toBe(extent.width);
      for (const g of elements.filter((e) => e.attrs.has('data-node'))) {
        const at = translateOf(g);
        const box = childrenOf(elements, g).find((e) => e.attrs.get('data-part') === 'box');
        expect(at.x).toBeGreaterThanOrEqual(extent.x + PICTURE_MARGIN - 0.01);
        expect(at.y).toBeGreaterThanOrEqual(extent.y + PICTURE_MARGIN - 0.01);
        expect(at.x + Number(box?.attrs.get('width'))).toBeLessThanOrEqual(
          extent.x + extent.width - PICTURE_MARGIN + 0.01,
        );
      }
      for (const g of elements.filter((e) => e.attrs.has('data-edge-label'))) {
        const at = translateOf(g);
        expect(at.x).toBeGreaterThanOrEqual(extent.x + PICTURE_MARGIN - 0.01);
        expect(at.y).toBeGreaterThanOrEqual(extent.y + PICTURE_MARGIN - 0.01);
      }
    }
  });

  it('the extent holds the row bands and the lists of open groups, not an edge that is held back, and moves with the map', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const extent = drawnExtent(flow);
    const right = extent.x + extent.width;

    // A row band that reaches beyond every box.
    const band = flow.nodes.find((n) => n.type === 'band');
    if (!band) throw new Error('a row band');
    const wideBand: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n === band ? { ...n, position: { x: extent.x - 500, y: n.position.y } } : n,
      ),
    };
    expect(drawnExtent(wideBand).x).toBe(extent.x - 500 - PICTURE_MARGIN);

    // The list of an open group that reaches beyond every box.
    const holder = flow.nodes.find((n) => n.type === 'group' && n.data.workItems?.above);
    if (!holder || holder.type === 'band') throw new Error('an open group with a list');
    const items = holder.data.workItems;
    const above = items?.above;
    if (!items || !above) throw new Error('a list');
    const farList = {
      ...holder,
      data: { ...holder.data, workItems: { ...items, above: { ...above, x: right + 300 } } },
    };
    const withFarList = drawnExtent({
      edges: flow.edges,
      nodes: flow.nodes.map((n) => (n === holder ? farList : n)),
    });
    expect(withFarList.x + withFarList.width).toBe(
      Math.ceil(right + 300 + above.width + PICTURE_MARGIN),
    );

    // An edge that edges on demand holds back is not drawn, wherever it leads.
    const edge = flow.edges[0];
    if (!edge) throw new Error('an edge');
    const away = { x: right + 4000, y: extent.y - 4000 };
    const leadingAway = (quiet: boolean, curve = edge.data.curve): FlowGraph => ({
      nodes: flow.nodes,
      edges: flow.edges.map((e) => (e === edge ? { ...e, data: { ...e.data, quiet, curve } } : e)),
    });
    const far = { ...edge.data.curve, p3: away };
    expect(drawnExtent(leadingAway(false, far)).width).toBeGreaterThan(extent.width + 3000);
    expect(drawnExtent(leadingAway(true, far))).toEqual(drawnExtent(leadingAway(true)));

    // Moved as a whole, the map takes its extent with it: nothing ties it to the origin.
    const shift = (point: { x: number; y: number }) => ({ x: point.x + 5000, y: point.y + 3000 });
    const moved: FlowGraph = {
      nodes: flow.nodes.map((n) => {
        if (n.type === 'band') return { ...n, position: shift(n.position) };
        const lines = n.data.workItems;
        const data = lines?.above
          ? { ...n.data, workItems: { ...lines, above: { ...lines.above, ...shift(lines.above) } } }
          : n.data;
        return { ...n, data, position: n.parentId === undefined ? shift(n.position) : n.position };
      }),
      edges: flow.edges.map((e) => {
        const { p0, c1, c2, p3 } = e.data.curve;
        const curve = {
          ...e.data.curve,
          p0: shift(p0),
          c1: shift(c1),
          c2: shift(c2),
          p3: shift(p3),
        };
        return { ...e, data: { ...e.data, curve } };
      }),
    };
    expect(drawnExtent(moved)).toEqual({ ...extent, x: extent.x + 5000, y: extent.y + 3000 });
  });
});

describe('Colour by', () => {
  it('tints a box with the mix the style sheet asks for, and draws the stripe', async () => {
    const { model, flow } = await buildMap(exampleYaml, undefined, 'detail');
    const coloring = nodeColoring(model, 'owner');
    for (const scheme of ['light', 'dark'] as const) {
      const p = PICTURE_PALETTE[scheme];
      const out = mapSvg({
        ...BASE,
        scheme,
        flow,
        lenses: { colors: coloring.byNode },
        legend: { coloring },
      });
      const elements = check(out.svg, flow);
      let leaves = 0;
      let groups = 0;
      for (const node of flow.nodes) {
        if (node.type === 'band') continue;
        const parts = childrenOf(elements, group(elements, 'data-node', node.id));
        const box = parts.find((e) => e.attrs.get('data-part') === 'box');
        const tint = coloring.byNode.get(node.id)?.[scheme];
        if (!tint) {
          expect(parts.some((e) => e.attrs.get('data-part') === 'tint')).toBe(false);
          continue;
        }
        const base =
          node.type === 'leaf' ? p.leafBg : node.data.level === 0 ? p.domainBg : p.componentBg;
        const mixed = mixColors(
          parseColor(tint),
          node.type === 'leaf' ? 0.14 : 0.1,
          parseColor(base),
        );
        expect(box?.attrs.get('fill'), node.id).toBe(colorHex(mixed));
        if (mixed.a < 1) expect(Number(box?.attrs.get('fill-opacity'))).toBeCloseTo(mixed.a, 3);
        const stripe = parts.find((e) => e.attrs.get('data-part') === 'tint');
        expect(stripe?.attrs.get('fill')).toBe(tint);
        // The stripe lies over the border, one pixel short of the edge of the box on each side.
        const edge = (node.data.level === 0 ? 2 : 1) - 1;
        const d = stripe?.attrs.get('d') ?? '';
        expect(d.startsWith(`M${edge} `), node.id).toBe(true);
        expect(d, node.id).toContain(`Q${node.width - edge} ${edge} `);
        if (node.type === 'leaf') leaves += 1;
        else groups += 1;
      }
      expect(leaves).toBeGreaterThan(0);
      expect(groups).toBeGreaterThan(0);
      // The key: one chip per value, in the order of the legend, in the colours of the scheme.
      const chips = elements.filter((e) => e.attrs.has('data-key-value'));
      expect(chips.map((e) => unescapeXml(e.attrs.get('data-key-value') ?? ''))).toEqual(
        coloring.legend.map((entry) => entry.label),
      );
      expect(chips.map((e) => e.attrs.get('fill'))).toEqual(
        coloring.legend.map((entry) => entry.color[scheme]),
      );
      expect(group(elements, 'data-key', 'colour').attrs.get('data-color-by')).toBe('owner');
      expect(out.svg).toContain('>Owner</text>');
    }
  });

  it('a metric has a ramp between its two ends', async () => {
    const { model, flow } = await buildMap(exampleYaml, undefined, 'detail');
    const metric = [...model.nodes.values()].flatMap((n) => [...(n.metrics?.keys() ?? [])])[0];
    if (metric === undefined) throw new Error('the example has a metric');
    const coloring = nodeColoring(model, `metric:${metric}`);
    const out = mapSvg({
      ...BASE,
      flow,
      lenses: { colors: coloring.byNode },
      legend: { coloring },
    });
    const elements = check(out.svg, flow);
    const stops = elements.filter(
      (e) => e.name === 'stop' && elements[e.parent]?.attrs.get('id') === 'am-ramp',
    );
    expect(stops.map((e) => e.attrs.get('stop-color'))).toEqual([
      coloring.legend[0]?.color.light,
      coloring.legend[1]?.color.light,
    ]);
    expect(out.svg).toContain(`>${xmlText(metric)}</text>`);
    expect(elements.some((e) => e.attrs.has('data-key-value'))).toBe(false);
    // The ramp goes by the range, whatever the choice is called.
    const renamed = mapSvg({
      ...BASE,
      flow,
      legend: { coloring: { ...coloring, colorBy: 'preset:Size', title: 'Size' } },
    });
    expect(renamed.svg).toContain('id="am-ramp"');
    expect(renamed.svg).toContain('>Size</text>');
  });

  it('any colouring with a legend has a key: a title of its own, many values, colours of a file', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const ids = flow.nodes.filter((n) => n.type !== 'band').map((n) => n.id);
    const legend = Array.from({ length: 40 }, (_, i) => ({
      label: `value number ${i} of a label`,
      color: {
        light: `#${(i * 6 + 16).toString(16)}3366`,
        dark: `#33${(i * 6 + 16).toString(16)}99`,
      },
      kind: 'value',
      count: i,
    }));
    legend.push({
      label: 'Other',
      color: { light: '#898781', dark: '#898781' },
      kind: 'other',
      count: 3,
    });
    const coloring: PictureColoring & { withoutValue: number; byNode: Map<string, unknown> } = {
      colorBy: 'preset:Risk',
      title: 'Risk',
      subtitle: 'by zone',
      legend,
      withoutValue: 2,
      byNode: new Map(),
    };
    const colors = new Map<string, SchemeColor>();
    ids.forEach((id, i) => {
      const entry = legend[i % legend.length];
      if (entry) colors.set(id, entry.color);
    });
    const plain = mapSvg({ ...BASE, flow });
    const out = mapSvg({ ...BASE, flow, lenses: { colors }, legend: { coloring } });
    const elements = check(out.svg, flow);
    expect(coloringTitle(coloring)).toBe('Risk (by zone)');
    expect(out.svg).toContain('>Risk (by zone)</text>');
    expect(elements.filter((e) => e.attrs.has('data-key-value'))).toHaveLength(41);
    // Counts follow their labels; the nodes without a value have an entry of their own.
    expect(out.svg).toMatch(/>value number 7 of a label<\/text><text[^>]*fill="#5f6368">7<\/text>/);
    expect(elements.filter((e) => e.attrs.get('data-key-none') === 'true')).toHaveLength(1);
    expect(out.svg).toMatch(/font-style="italic"[^>]*>No value<\/text><text[^>]*>2<\/text>/);
    const without = mapSvg({
      ...BASE,
      flow,
      legend: { coloring: { ...coloring, withoutValue: 0 } },
    });
    expect(without.svg).not.toContain('No value');
    // The key wraps: it makes the picture taller, never wider than the map.
    expect(out.width).toBe(plain.width);
    expect(out.height).toBeGreaterThan(plain.height + 40);
    // The shared entry is set in italics.
    expect(out.svg).toMatch(/font-style="italic"[^>]*>Other<\/text>/);
    // Without a title: the name after the prefix, or the attribute with a capital.
    expect(coloringTitle({ colorBy: 'label:team', legend })).toBe('team');
    expect(coloringTitle({ colorBy: 'metric:loc', legend })).toBe('loc');
    expect(coloringTitle({ colorBy: 'status', legend, title: '  ' })).toBe('Status');
    // Nothing to colour by: no key of colours, whatever legend comes with it — and none for a
    // colouring without a legend.
    for (const nothing of [
      { colorBy: 'none', legend },
      { colorBy: 'none', legend: [] },
      { colorBy: 'owner', legend: [] },
    ]) {
      const none = readXml(mapSvg({ ...BASE, flow, legend: { coloring: nothing } }).svg);
      expect(none.some((e) => e.attrs.get('data-key') === 'colour')).toBe(false);
      expect(none.some((e) => e.attrs.has('data-key-value'))).toBe(false);
    }
    // A colour that is none is an error, not a guess.
    expect(() =>
      mapSvg({
        ...BASE,
        flow,
        lenses: { colors: new Map([[ids[0] ?? '', { light: 'red', dark: 'red' }]]) },
      }),
    ).toThrow(/not a colour/);
  });
});

describe('heat and progress', () => {
  it('a strip is as tall as the fraction, with the lower part of the gradient; the bar as long as what is done', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    const [leaf, overdone] = flow.nodes.filter((n) => n.type === 'leaf');
    const domain = flow.nodes.find((n) => n.type === 'group' && n.data.level === 0);
    if (!leaf || !overdone || !domain) throw new Error('boxes');
    const out = mapSvg({
      ...BASE,
      flow,
      lenses: {
        heat: new Map([
          [leaf.id, { open: 3, fraction: 0.5 }],
          [domain.id, { open: 2, fraction: 0.01, inAll: 14 }],
        ]),
        progress: new Map([
          [leaf.id, { done: 1, total: 4 }],
          [overdone.id, { done: 9, total: 4 }],
          [domain.id, { done: 0, total: 3, inAll: { done: 5, total: 12 } }],
        ]),
      },
      legend: {},
    });
    const elements = check(out.svg, flow);
    const strips = (id: string) =>
      childrenOf(elements, group(elements, 'data-node', id)).filter(
        (e) => e.attrs.get('data-part') === 'heat',
      );
    // A leaf has a border of 1: the strip is half of what is inside it.
    const [left, right] = strips(leaf.id);
    if (!left || !right) throw new Error('two strips');
    expect(left.attrs.get('data-side')).toBe('left');
    expect(right.attrs.get('data-side')).toBe('right');
    const strip = childrenOf(elements, left).find(
      (e) => e.attrs.get('fill') === 'url(#am-heat-50)',
    );
    expect(Number(strip?.attrs.get('height'))).toBe((leaf.height - 2) / 2);
    expect(Number(strip?.attrs.get('y'))).toBe(leaf.height - 1 - (leaf.height - 2) / 2);
    expect(Number(strip?.attrs.get('x'))).toBe(0);
    const rightStrip = childrenOf(elements, right).find(
      (e) => e.attrs.get('fill') === 'url(#am-heat-50)',
    );
    expect(Number(rightStrip?.attrs.get('x'))).toBe(leaf.width - 5);
    // The glow behind a strip: the colour of the glow of the style sheet at half its strength,
    // for it lies under the strip as a shape, not around it as a shadow.
    const glow = parseColor(PICTURE_PALETTE.light.heatGlow);
    const [halo] = childrenOf(elements, left).filter((e) => e.name === 'rect');
    expect(halo?.attrs.get('fill')).toBe(colorHex(glow));
    expect(Number(halo?.attrs.get('fill-opacity'))).toBeCloseTo(glow.a / 2, 3);
    // Half of the gradient: its first stop, the second (at 1/3 of the whole) at 2/3, and the
    // colour at the half.
    const stops = elements.filter(
      (e) => e.name === 'stop' && elements[e.parent]?.attrs.get('id') === 'am-heat-50',
    );
    expect(stops.map((e) => [e.attrs.get('offset'), e.attrs.get('stop-color')])).toEqual([
      ['0', '#5a1a0a'],
      ['0.667', '#d93025'],
      ['1', colorHex(mixColors(parseColor('#f9ab00'), 0.5, parseColor('#d93025')))],
    ]);
    // Never shorter than 8 %.
    expect(heatPercent(0.01)).toBe(8);
    expect(heatPercent(7)).toBe(100);
    expect(out.svg).toContain('id="am-heat-8"');
    // The bar: 6 in from the inside of the border on both sides, a quarter of it done.
    const bar = childrenOf(elements, group(elements, 'data-node', leaf.id)).find(
      (e) => e.attrs.get('data-part') === 'progress',
    );
    if (!bar) throw new Error('a bar');
    const [, track, done] = childrenOf(elements, bar);
    expect(Number(track?.attrs.get('x'))).toBe(7);
    expect(Number(track?.attrs.get('width'))).toBe(leaf.width - 14);
    expect(Number(done?.attrs.get('width'))).toBe((leaf.width - 14) / 4);
    expect(done?.attrs.get('fill')).toBe(PICTURE_PALETTE.light.progressDone);
    // It lies on the lower border of the box, down to its outer edge.
    expect(Number(track?.attrs.get('y')) + Number(track?.attrs.get('height'))).toBe(leaf.height);
    expect(Number(done?.attrs.get('y'))).toBe(Number(track?.attrs.get('y')));
    // More done than there is: the done part ends with the track.
    const full = childrenOf(elements, group(elements, 'data-node', overdone.id)).find(
      (e) => e.attrs.get('data-part') === 'progress',
    );
    if (!full) throw new Error('a bar with more done than there is');
    const [, fullTrack, fullDone] = childrenOf(elements, full);
    expect(Number(fullTrack?.attrs.get('width'))).toBeGreaterThan(0);
    expect(fullDone?.attrs.get('width')).toBe(fullTrack?.attrs.get('width'));
    // Nothing done: no done part.
    const none = childrenOf(elements, group(elements, 'data-node', domain.id)).find(
      (e) => e.attrs.get('data-part') === 'progress',
    );
    if (!none) throw new Error('a bar with nothing done');
    expect(childrenOf(elements, none)).toHaveLength(2);
    // The key says how to read both.
    expect(out.svg).toContain(`>${xmlText(KEY_TEXTS.heat)}</text>`);
    expect(out.svg).toContain(`>${xmlText(KEY_TEXTS.progress)}</text>`);
    expect(out.svg).toContain('id="am-heat-100"');
  });

  it('the tooltips say what the box shows, and the total where that is more', () => {
    expect(heatStripTitle({ open: 3, fraction: 1 })).toBe('3 open work items in here');
    expect(heatStripTitle({ open: 1, fraction: 1, inAll: 1 })).toBe('1 open work item in here');
    expect(heatStripTitle({ open: 2, fraction: 0.1, inAll: 14 })).toBe(
      '2 open work items here that no box inside shows (14 in here in all)',
    );
    expect(progressBarTitle({ done: 3, total: 8 })).toBe('3 of 8 done (38%)');
    expect(progressBarTitle({ done: 1, total: 3, inAll: { done: 5, total: 12 } })).toBe(
      '1 of 3 done (33%) of what no box inside shows (5 of 12 in here in all)',
    );
    expect(progressBarTitle({ done: 1, total: 3, inAll: { done: 1, total: 3 } })).toBe(
      '1 of 3 done (33%)',
    );
    // What decides is how much work there is in all, not how much of it is done.
    expect(progressBarTitle({ done: 1, total: 3, inAll: { done: 1, total: 5 } })).toBe(
      '1 of 3 done (33%) of what no box inside shows (1 of 5 in here in all)',
    );
  });
});

describe('the larger titles of the domains level', () => {
  it('a domain has its name at 28 px on two lines at most and no level tag', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'domains');
    const small = mapSvg({ ...BASE, flow });
    const large = mapSvg({ ...BASE, flow, largeTitles: true });
    check(large.svg, flow);
    expect(small.svg).toContain('>DOMAIN</text>');
    expect(small.svg).not.toContain('font-size="28"');
    expect(large.svg).not.toContain('>DOMAIN</text>');
    expect(large.svg).toContain('font-size="28"');
    // Same boxes: only text sizes change.
    expect(large.width).toBe(small.width);
    expect(large.height).toBe(small.height);
    // Row names grow too.
    if (flow.nodes.some((n) => n.type === 'band' && n.data.variant === 'row')) {
      expect(large.svg).toContain('font-size="20"');
      expect(small.svg).toContain('font-size="15"');
    }
  });

  it('only a domain has the larger title — a leaf on two lines at most — and the Unassigned area its own', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'domains');
    const [lower, leaf, kept] = flow.nodes.filter((n) => n.type !== 'band');
    if (!lower || !leaf || !kept) throw new Error('three domains');
    const long =
      'A domain whose name is far too long for the two lines that its box has room for. ';
    // One domain drawn as a box of the next level, one as a domain without children.
    const mixed: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) => {
        if (n.type === 'band') return n;
        if (n.id === lower.id) {
          return { ...n, data: { ...n.data, level: 1, levelName: NODE_LEVEL_NAMES[1] } };
        }
        if (n.id === leaf.id) {
          return {
            ...n,
            type: 'leaf',
            data: { ...n.data, collapsed: false, name: long.repeat(4) },
          };
        }
        return n;
      }),
    };
    const title = String(PICTURE_STYLE.largeTitle.size);
    const elements = check(mapSvg({ ...BASE, flow: mixed, largeTitles: true }).svg, mixed);
    const titled = (id: string) =>
      inside(elements, group(elements, 'data-node', id)).filter(
        (e) => e.name === 'text' && e.attrs.get('font-size') === title,
      );
    expect(titled(lower.id)).toHaveLength(0);
    expect(titled(kept.id).length).toBeGreaterThan(0);
    const lines = titled(leaf.id).map((e) => e.text);
    expect(lines).toHaveLength(PICTURE_STYLE.largeTitle.maxLines);
    expect(lines.at(-1)?.endsWith(ELLIPSIS)).toBe(true);
    expect(long.startsWith(lines[0] ?? '?')).toBe(true);

    const area = flow.nodes.find((n) => n.type === 'band' && n.data.variant === 'unassigned');
    if (!area) throw new Error('the Unassigned area');
    const areaTitle = (largeTitles: boolean) => {
      const all = readXml(mapSvg({ ...BASE, flow, largeTitles }).svg);
      return inside(all, group(all, 'data-band', xmlText(area.id))).find((e) => e.name === 'text');
    };
    expect(areaTitle(true)?.attrs.get('font-size')).toBe(
      String(PICTURE_STYLE.largeTitle.unassigned),
    );
    expect(areaTitle(false)?.attrs.get('font-size')).toBe(String(PICTURE_STYLE.band.unassigned));
  });
});

describe('text with real widths', () => {
  it('is cut where it does not fit and pinned to its width; with the estimate it is neither', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const leaf = flow.nodes.find((n) => n.type === 'leaf');
    if (!leaf || leaf.type === 'band') throw new Error('a leaf');
    const long: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n === leaf
          ? { ...n, data: { ...n.data, name: 'A name that is much too long for the box it is in' } }
          : n,
      ),
    };
    const estimated = mapSvg({ ...BASE, flow: long });
    expect(estimated.svg).toContain('>A name that is much too long for the box it is in</text>');
    expect(estimated.svg).not.toContain('textLength');
    const exact = mapSvg({ ...BASE, flow: long, measure: mono });
    const elements = check(exact.svg, long);
    expect(exact.svg).not.toContain('>A name that is much too long for the box it is in</text>');
    const texts = elements.filter((e) => e.name === 'text');
    expect(texts.length).toBeGreaterThan(50);
    for (const text of texts) expect(Number(text.attrs.get('textLength'))).toBeGreaterThan(0);
    // A text with letter spacing is as long as its letters and the room after each of them.
    const spaced = texts.filter((e) => e.attrs.has('letter-spacing'));
    expect(spaced.length).toBeGreaterThan(0);
    for (const text of spaced) {
      const letters = mono(text.text, Number(text.attrs.get('font-size')), 400);
      const spacing = Number(text.attrs.get('letter-spacing'));
      expect(spacing).toBeGreaterThan(0);
      expect(Number(text.attrs.get('textLength')), text.text).toBeCloseTo(
        letters + spacing * [...text.text].length,
        1,
      );
    }
    // The cut name fits the room of the leaf: its width less the border and 12 px on each side.
    const g = group(elements, 'data-node', leaf.id);
    const name = childrenOf(elements, g).find((e) => e.name === 'text');
    expect(Number(name?.attrs.get('textLength'))).toBeLessThanOrEqual(leaf.width - 2 - 24);
    expect(exact.svg).toContain(`${ELLIPSIS}</text>`);
    // Work-item titles are cut by any measure: they are longer than their room as a rule.
    expect(estimated.svg).toContain(`${ELLIPSIS}</text>`);
  });
});

describe('curveBounds', () => {
  it('property: holds the curve, tightly, inside the box of its four points', () => {
    const random = seeded(7);
    const point = () => ({ x: (random() - 0.5) * 2000, y: (random() - 0.5) * 2000 });
    for (let run = 0; run < 2000; run++) {
      const curve: Curve = { p0: point(), c1: point(), c2: point(), p3: point() };
      if (run % 10 === 0) Object.assign(curve, { c1: curve.p0, c2: curve.p3 });
      if (run % 17 === 0) Object.assign(curve, { p3: curve.p0 });
      const box = curveBounds(curve);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i <= 400; i++) {
        const at = curvePoint(curve, i / 400);
        minX = Math.min(minX, at.x);
        maxX = Math.max(maxX, at.x);
        minY = Math.min(minY, at.y);
        maxY = Math.max(maxY, at.y);
      }
      // Every sample is inside: the outermost ones are.
      expect(minX).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(maxX).toBeLessThanOrEqual(box.x + box.width + 1e-6);
      expect(minY).toBeGreaterThanOrEqual(box.y - 1e-6);
      expect(maxY).toBeLessThanOrEqual(box.y + box.height + 1e-6);
      // Tight: the samples come within a pixel of every side (the curve moves at most 15 px a
      // step).
      expect(minX - box.x).toBeLessThan(1);
      expect(box.x + box.width - maxX).toBeLessThan(1);
      expect(minY - box.y).toBeLessThan(1);
      expect(box.y + box.height - maxY).toBeLessThan(1);
      const xs = [curve.p0.x, curve.c1.x, curve.c2.x, curve.p3.x];
      expect(box.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6);
      expect(box.x + box.width).toBeLessThanOrEqual(Math.max(...xs) + 1e-6);
    }
  });
});

describe('a broken flow', () => {
  it('is an error, never a picture with NaN in it', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const edge = flow.edges[0];
    const node = flow.nodes.find((n) => n.type !== 'band');
    if (!edge || !node) throw new Error('an edge and a box');
    const brokenCurve: FlowGraph = {
      nodes: flow.nodes,
      edges: [
        { ...edge, data: { ...edge.data, curve: { ...edge.data.curve, c1: { x: NaN, y: 0 } } } },
      ],
    };
    expect(() =>
      mapSvg({ ...BASE, flow: brokenCurve, extent: { x: 0, y: 0, width: 5000, height: 5000 } }),
    ).toThrow();
    expect(() => mapSvg({ ...BASE, flow: brokenCurve })).toThrow();
    const brokenBox: FlowGraph = {
      edges: [],
      nodes: flow.nodes.map((n) => (n === node ? { ...n, width: Infinity } : n)),
    };
    expect(() => mapSvg({ ...BASE, flow: brokenBox })).toThrow();
    // A place that is a number, and too far away to be written as one.
    const farBox: FlowGraph = {
      edges: [],
      nodes: flow.nodes.map((n) =>
        n === node ? { ...n, position: { x: 1e307, y: n.position.y } } : n,
      ),
    };
    expect(() => mapSvg({ ...BASE, flow: farBox })).toThrow(/not a number/);
    const orphan: FlowGraph = {
      edges: [],
      nodes: flow.nodes.filter((n) => n.type === 'band' || n.parentId !== undefined),
    };
    expect(() => mapSvg({ ...BASE, flow: orphan })).toThrow(/before its parent/);
    // Nothing at all is still a picture: the margin around nothing.
    const empty = mapSvg({ ...BASE, flow: { nodes: [], edges: [] } });
    expect(empty.width).toBe(2 * PICTURE_MARGIN);
    readXml(empty.svg);
  });
});

describe('svgAtSize', () => {
  it('gives the root the pixel size and keeps the view box', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'domains');
    const out = mapSvg({ ...BASE, flow });
    const sized = svgAtSize(out.svg, 1000, 521);
    const [root] = readXml(sized);
    expect(root?.attrs.get('width')).toBe('1000');
    expect(root?.attrs.get('height')).toBe('521');
    expect(root?.attrs.get('viewBox')).toBe(`0 0 ${out.width} ${out.height}`);
    expect(root?.attrs.get('preserveAspectRatio')).toBe('none');
    expect(sized.slice(sized.indexOf('>'))).toBe(out.svg.slice(out.svg.indexOf('>')));
    expect(() => svgAtSize('<svg><rect width="1" height="2"/></svg>', 1, 1)).toThrow(/mapSvg/);
    expect(() => svgAtSize(out.svg, NaN, 1)).toThrow();
  });

  it('sizes a picture it has sized before, and refuses a size below one pixel', () => {
    const out = mapSvg({ ...BASE, flow: { nodes: [], edges: [] } });
    const again = svgAtSize(svgAtSize(out.svg, 96, 96), 48, 25);
    const [root] = readXml(again);
    expect(root?.attrs.get('width')).toBe('48');
    expect(root?.attrs.get('height')).toBe('25');
    expect(root?.attrs.get('preserveAspectRatio')).toBe('none');
    expect(root?.attrs.get('viewBox')).toBe(`0 0 ${out.width} ${out.height}`);
    expect(again).toBe(svgAtSize(out.svg, 48, 25));
    const sizes = [
      [0, 10],
      [10, 0],
      [-5, 10],
      [10, 0.5],
      [NaN, 10],
      [10, NaN],
    ] as const;
    for (const [width, height] of sizes) {
      expect(() => svgAtSize(out.svg, width, height), `${width} × ${height}`).toThrow(/not a size/);
    }
    expect(() => svgAtSize(out.svg, 1, 1)).not.toThrow();
  });
});

describe('work items', () => {
  it('lists the lines of a leaf in its box and of an open group above the edges; marks the selected line', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const withList = flow.nodes.find((n) => n.type === 'leaf' && n.data.workItems);
    const above = flow.nodes.find((n) => n.type === 'group' && n.data.workItems?.above);
    if (!withList || withList.type === 'band' || !above) throw new Error('the fixture has both');
    const item = withList.data.workItems?.lines.find((line) => line.kind === 'item');
    if (!item || item.kind !== 'item') throw new Error('an item');
    const out = mapSvg({ ...BASE, flow, workItem: { selectedId: item.item.id } });
    const elements = check(out.svg, flow);
    const lines = elements.filter((e) => e.attrs.has('data-workitem'));
    const total = flow.nodes.reduce(
      (sum, n) =>
        sum +
        (n.type === 'band'
          ? 0
          : (n.data.workItems?.lines.filter((l) => l.kind !== 'more').length ?? 0)),
      0,
    );
    expect(lines).toHaveLength(total);
    const marked = lines.filter((e) => e.attrs.get('data-selected') === 'true');
    expect(marked.length).toBeGreaterThan(0);
    for (const line of marked) expect(line.attrs.get('data-workitem')).toBe(String(item.item.id));
    expect(group(elements, 'data-list', above.id)).toBeDefined();
    // Without a selection no line is marked.
    expect(mapSvg({ ...BASE, flow }).svg).not.toContain('data-selected');
    // A dimmed group dims its list; a paled one does not (as the canvas draws it).
    const dimmed: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) => (n === above ? { ...n, className: 'arch-dimmed' } : n)),
    };
    expect(
      group(readXml(mapSvg({ ...BASE, flow: dimmed }).svg), 'data-list', above.id).attrs.get(
        'opacity',
      ),
    ).toBe('0.3');
    const paled: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) => (n === above ? { ...n, className: 'arch-faded' } : n)),
    };
    expect(
      group(readXml(mapSvg({ ...BASE, flow: paled }).svg), 'data-list', above.id).attrs.has(
        'opacity',
      ),
    ).toBe(false);
  });

  it('below the Everything level a box has its badge with the counts', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'components');
    const out = mapSvg({ ...BASE, flow });
    const elements = check(out.svg, flow);
    const badges = elements.filter((e) => e.attrs.get('data-part') === 'badge');
    expect(badges).toHaveLength(flow.nodes.filter((n) => n.type !== 'band' && n.data.badge).length);
    expect(badges.length).toBeGreaterThan(0);
  });
});

describe('a large map', () => {
  it('eight times the example is written in well under a second', async () => {
    const copies = 8;
    // The example side by side: every ID gets a prefix per copy.
    const doc: unknown = parse(exampleYaml);
    if (!isRecord(doc)) throw new Error('the example is a mapping');
    const domains: unknown[] = [];
    const edges: unknown[] = [];
    for (let copy = 0; copy < copies; copy++) {
      const prefix = `c${copy}x`;
      domains.push(...listOf(withPrefix(doc['domains'], prefix)));
      edges.push(...listOf(withPrefix(doc['edges'], prefix)));
    }
    const big = stringify({ ...doc, domains, edges, flows: [] });
    const { flow } = await buildMap(big, undefined, 'detail');
    const boxes = flow.nodes.filter((n) => n.type !== 'band').length;
    expect(boxes).toBeGreaterThan(300);
    const started = performance.now();
    const out = mapSvg({ ...BASE, flow, heading: { title: 'big', note: 'n' }, legend: {} });
    const took = performance.now() - started;
    check(out.svg, flow);
    expect(took).toBeLessThan(1000);
  }, 60_000);
});

// --- What the picture says, part by part ------------------------------------------------------
// The tests above find a box or an edge that is missing. These find one that is there and says
// nothing, or is drawn in another way than the canvas draws it.

/** The elements below `ancestor`, at any depth, in document order. */
function inside(elements: XmlElement[], ancestor: XmlElement): XmlElement[] {
  return elements.filter((e) => {
    for (let up = e.parent; up >= 0; up = elements[up]?.parent ?? -1) {
      if (up === ancestor.index) return true;
    }
    return false;
  });
}

/** The texts written below `ancestor`, one entry per `<text>`. */
function textsOf(elements: XmlElement[], ancestor: XmlElement): string[] {
  return inside(elements, ancestor)
    .filter((e) => e.name === 'text')
    .map((e) => e.text);
}

const tight = (text: string): string => text.replace(/\s+/g, '');

/** The dashes of the border of a label, by the kind of its edge. */
const LABEL_DASHES: Readonly<Record<EdgeKind, string | undefined>> = {
  dataflow: undefined,
  dependency: '3 2',
  control: '1 2',
  config: undefined,
};

/** "M x y L x y L x y Z" as three points. */
function trianglePoints(d: string): { x: number; y: number }[] {
  const numbers = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  expect(numbers).toHaveLength(6);
  return [0, 2, 4].map((i) => ({ x: numbers[i] ?? NaN, y: numbers[i + 1] ?? NaN }));
}

describe('what a box says', () => {
  it('every box has its name, its border, and — a group — its chevron, tag, summary or list', async () => {
    let leaves = 0;
    let open = 0;
    let closed = 0;
    let shrunk = 0;
    for (const compact of [false, true]) {
      const { flow } = await buildMap(exampleYaml, undefined, 'components', { compact });
      for (const scheme of ['light', 'dark'] as const) {
        const p = PICTURE_PALETTE[scheme];
        const elements = check(mapSvg({ ...BASE, scheme, flow }).svg, flow);
        for (const node of flow.nodes) {
          if (node.type === 'band') continue;
          const g = group(elements, 'data-node', node.id);
          const parts = childrenOf(elements, g);
          const texts = textsOf(elements, g);
          const d = node.data;
          const isClosed = node.type === 'group' && d.collapsed;
          // The border: the colour of the level, 2 px for a domain, 1 px otherwise; a closed
          // group has the two lines of its double border instead.
          const borderColor =
            d.level === 0 ? p.domainBorder : d.level === 1 ? p.componentBorder : p.leafBorder;
          const borders = parts.filter((e) => e.name === 'rect' && e.attrs.get('fill') === 'none');
          expect(
            borders.map((e) => e.attrs.get('stroke')),
            node.id,
          ).toEqual(isClosed ? [borderColor, borderColor] : [borderColor]);
          expect(
            borders.map((e) => e.attrs.get('stroke-width')),
            node.id,
          ).toEqual(isClosed ? ['1.33', '1.33'] : [d.level === 0 ? '2' : '1']);
          if (node.type === 'leaf') {
            expect(texts, node.id).toEqual([d.name]);
            leaves += 1;
            continue;
          }
          // A group: the chevron (turned when closed), then what its header and body say.
          const chevrons = parts.filter((e) => e.attrs.get('d') === 'M-3.6 -1.8L0 1.8L3.6 -1.8');
          expect(chevrons, node.id).toHaveLength(1);
          expect((chevrons[0]?.attrs.get('transform') ?? '').includes('rotate(-90)'), node.id).toBe(
            d.collapsed,
          );
          // Closed by the level of detail, a group has no toggle: its chevron is paler.
          expect(chevrons[0]?.attrs.get('opacity'), node.id).toBe(
            d.collapsed ? String(PICTURE_STYLE.chevron.disabledOpacity) : undefined,
          );
          expect(
            parts.filter((e) => e.attrs.get('data-part') === 'header'),
            node.id,
          ).toHaveLength(1);
          if (d.compact) {
            // The name on as many lines as it needs, then the names of what is inside.
            expect(tight(texts.join('')), node.id).toBe(
              tight(d.name + compactGroupText(d.childNames, d.compactHidden)),
            );
            expect(texts).not.toContain(d.levelName.toUpperCase());
            shrunk += 1;
          } else if (isClosed) {
            const { children, descendants } = d.counts;
            const summary = [
              plural(children, NODE_LEVEL_NAMES[d.level + 1] ?? 'node'),
              ...(descendants > children
                ? [plural(descendants - children, NODE_LEVEL_NAMES[d.level + 2] ?? 'node')]
                : []),
            ].join(' · ');
            expect(texts, node.id).toEqual([d.name, d.levelName.toUpperCase(), summary]);
            closed += 1;
          } else {
            expect(texts, node.id).toEqual([d.name, d.levelName.toUpperCase()]);
            open += 1;
          }
        }
      }
    }
    expect([leaves, open, closed, shrunk].every((count) => count > 0)).toBe(true);
  });

  it('the hatch of a closed group starts at the inside of its border, as on the canvas', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const closed = flow.nodes.find((n) => n.type === 'group' && n.data.collapsed);
    if (!closed) throw new Error('a closed group');
    const elements = check(mapSvg({ ...BASE, flow }).svg, flow);
    const hatch = childrenOf(elements, group(elements, 'data-node', closed.id)).find(
      (e) => e.attrs.get('data-part') === 'hatch',
    );
    // A 4 px double border: the pattern is laid from (4, 4) of the box, over the whole box.
    expect(hatch?.attrs.get('transform')).toBe('translate(4 4)');
    expect([hatch?.attrs.get('x'), hatch?.attrs.get('y')]).toEqual(['-4', '-4']);
    expect(Number(hatch?.attrs.get('width'))).toBe(closed.width);
    expect(Number(hatch?.attrs.get('height'))).toBe(closed.height);
    const pattern = group(elements, 'id', 'am-hatch');
    expect(pattern.attrs.get('patternTransform')).toBe('rotate(45)');
    expect([pattern.attrs.get('width'), pattern.attrs.get('patternUnits')]).toEqual([
      '12',
      'userSpaceOnUse',
    ]);
  });

  it('a shrunk group has a header as tall as its name, its badge, and the names it has room for; closed by hand it keeps its toggle', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'components', { compact: true });
    const c = COMPACT_GROUP;
    const elements = check(mapSvg({ ...BASE, flow }).svg, flow);
    let badged = 0;
    let shrunk = 0;
    for (const node of flow.nodes) {
      if (node.type !== 'group' || !node.data.compact) continue;
      const g = group(elements, 'data-node', node.id);
      const parts = childrenOf(elements, g);
      // The header: the lines of the name with what is above and below them, inside the border.
      const nameLines = parts.filter(
        (e) => e.name === 'text' && e.attrs.get('font-weight') === '700',
      );
      expect(nameLines.length, node.id).toBeGreaterThan(0);
      const border = node.data.placedRowName === undefined ? PICTURE_STYLE.closedBorder : 2;
      const bottom = border + c.headerTop + nameLines.length * c.nameLine + c.headerBottom;
      const header = parts.find((e) => e.attrs.get('data-part') === 'header');
      expect(header?.attrs.get('d')?.startsWith(`M${border} ${bottom}V`), node.id).toBe(true);
      // Its badge, where it holds work items.
      const badge = inside(elements, g).filter((e) => e.attrs.get('data-part') === 'badge');
      expect(badge, node.id).toHaveLength(node.data.badge ? 1 : 0);
      if (node.data.badge) badged += 1;
      shrunk += 1;
    }
    expect(shrunk).toBeGreaterThan(0);
    expect(badged).toBeGreaterThan(0);

    // What a shrunk group has no room for is left out and counted; and a group that was closed
    // by hand — not only by the level of detail — has a chevron that opens it.
    const many = flow.nodes.find(
      (n) => n.type === 'group' && n.data.compact && n.data.childNames.length > 1,
    );
    if (!many || many.type === 'band') throw new Error('a shrunk group with two children');
    expect(many.data.compactHidden).toBe(0);
    expect(many.data.manuallyCollapsed).toBe(false);
    const byHand: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n.type !== 'band' && n.id === many.id
          ? { ...n, data: { ...n.data, compactHidden: 1, manuallyCollapsed: true } }
          : n,
      ),
    };
    const changed = check(mapSvg({ ...BASE, flow: byHand }).svg, byHand);
    const partsOf = (all: XmlElement[]) => childrenOf(all, group(all, 'data-node', many.id));
    const said = (all: XmlElement[]) =>
      tight(
        partsOf(all)
          .filter((e) => e.name === 'text')
          .map((e) => e.text)
          .join(''),
      );
    expect(said(elements)).toBe(tight(many.data.name + compactGroupText(many.data.childNames, 0)));
    expect(said(changed)).toBe(tight(many.data.name + compactGroupText(many.data.childNames, 1)));
    expect(said(changed)).not.toBe(said(elements));
    const chevronOf = (all: XmlElement[]) =>
      partsOf(all).find((e) => e.attrs.get('d') === 'M-3.6 -1.8L0 1.8L3.6 -1.8');
    expect(chevronOf(elements)?.attrs.get('opacity')).toBe(
      String(PICTURE_STYLE.chevron.disabledOpacity),
    );
    expect(chevronOf(changed)?.name).toBe('path');
    expect(chevronOf(changed)?.attrs.has('opacity')).toBe(false);
  });

  it('the summary of a closed group wraps where real widths say so, and never by the estimate', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const closed = flow.nodes.find(
      (n) => n.type === 'group' && n.data.collapsed && !n.data.compact,
    );
    if (!closed || closed.type === 'band') throw new Error('a closed group');
    const narrow: FlowGraph = {
      edges: [],
      nodes: flow.nodes.map((n) => (n === closed ? { ...n, width: 110 } : n)),
    };
    const lines = (measure?: TextMeasure) => {
      const elements = readXml(
        mapSvg({ ...BASE, flow: narrow, ...(measure ? { measure } : {}) }).svg,
      );
      // Without the name and the level tag: the first two texts of a closed group.
      return textsOf(elements, group(elements, 'data-node', closed.id)).slice(2);
    };
    expect(lines()).toHaveLength(1);
    const wrapped = lines(mono);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(tight(wrapped.join(''))).toBe(tight(lines()[0] ?? ''));
  });

  it('with real widths every leaf still has its name, and a name that fits is written whole', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    const elements = check(mapSvg({ ...BASE, flow, measure: mono }).svg, flow);
    let whole = 0;
    for (const node of flow.nodes) {
      if (node.type !== 'leaf') continue;
      const [name, ...rest] = textsOf(elements, group(elements, 'data-node', node.id));
      expect(rest).toEqual([]);
      const size = node.data.level === 0 ? 18 : node.data.level === 1 ? 16 : 15;
      const room = node.width - 2 * (node.data.level === 0 ? 2 : 1) - 24;
      if (mono(node.data.name, size, 400) <= room) {
        expect(name, node.id).toBe(node.data.name);
        whole += 1;
      } else {
        expect(name?.endsWith(ELLIPSIS), node.id).toBe(true);
      }
    }
    expect(whole).toBeGreaterThan(5);
  });

  it('a strip is exactly as tall as the fraction says, whatever percent its gradient is rounded to', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    const leaf = flow.nodes.find((n) => n.type === 'leaf');
    if (!leaf) throw new Error('a leaf');
    expect(heatShare(1 / 3)).toBeCloseTo(1 / 3, 12);
    expect(heatShare(0.001)).toBe(0.08);
    expect(heatShare(4)).toBe(1);
    const out = mapSvg({
      ...BASE,
      flow,
      lenses: { heat: new Map([[leaf.id, { open: 1, fraction: 1 / 3 }]]) },
    });
    const elements = check(out.svg, flow);
    const strip = inside(elements, group(elements, 'data-node', leaf.id)).find(
      (e) => e.attrs.get('fill') === 'url(#am-heat-33)',
    );
    // A third of the inside, to the hundredth of a pixel — not 33 % of it.
    expect(Number(strip?.attrs.get('height'))).toBeCloseTo((leaf.height - 2) / 3, 2);
    expect(Math.abs(Number(strip?.attrs.get('height')) - (leaf.height - 2) * 0.33)).toBeGreaterThan(
      0.1,
    );
  });
});

describe('what an edge and its label say', () => {
  it('the line has the colour and the style of its kind, and an arrowhead that arrives with it', async () => {
    expect(edgeLineStyle('dataflow', false, false)).toEqual({ width: 1.75 });
    expect(edgeLineStyle('dependency', false, false)).toEqual({ width: 1.75, dash: '7 4' });
    expect(edgeLineStyle('control', false, false)).toEqual({
      width: 1.75,
      dash: '1.5 4',
      cap: 'round',
    });
    expect(edgeLineStyle('config', false, false)).toEqual({ width: 1.1, dash: '8 3 1.5 3' });
    expect(edgeLineStyle('dataflow', false, true).width).toBe(3);
    expect(edgeLineStyle('config', false, true).width).toBe(2.2);
    expect(edgeLineStyle('config', true, false).width).toBe(3);
    expect(edgeLineStyle('control', true, true).width).toBe(4.5);

    const kinds = new Set<string>();
    let aggregates = 0;
    for (const level of ['components', 'detail'] as const) {
      const { flow } = await buildMap(exampleYaml, undefined, level);
      const some = flow.edges[2];
      if (!some) throw new Error('edges');
      // A rendered edge is selected by its ID, an aggregate as well.
      const selected = highlightFlow(flow, { type: 'edge', id: some.id });
      // The selected edge is the heavier one, and the only one.
      expect(selected.edges.filter((e) => e.selected === true).map((e) => e.id)).toEqual([some.id]);
      for (const scheme of ['light', 'dark'] as const) {
        const p = PICTURE_PALETTE[scheme];
        const colors = {
          dataflow: p.edgeDataflow,
          dependency: p.edgeDependency,
          control: p.edgeControl,
          config: p.edgeConfig,
        };
        const elements = check(mapSvg({ ...BASE, scheme, flow: selected }).svg, selected);
        for (const edge of selected.edges) {
          const g = group(elements, 'data-edge', xmlText(edge.id));
          expect(g.attrs.get('data-kind')).toBe(edge.data.kind);
          const parts = childrenOf(elements, g).filter((e) => e.name === 'path');
          expect(
            parts.map((e) => e.attrs.get('data-part')),
            edge.id,
          ).toEqual(['line', 'head']);
          const [line, head] = parts;
          const style = edgeLineStyle(edge.data.kind, edge.data.count > 1, edge.selected === true);
          expect(line?.attrs.get('stroke'), edge.id).toBe(colors[edge.data.kind]);
          expect(line?.attrs.get('stroke-width'), edge.id).toBe(String(style.width));
          expect(line?.attrs.get('stroke-dasharray'), edge.id).toBe(style.dash);
          expect(line?.attrs.get('stroke-linecap'), edge.id).toBe(style.cap);
          expect(head?.attrs.get('fill'), edge.id).toBe(colors[edge.data.kind]);
          // The head: its tip on the end of the line, 11 long along the way the curve arrives
          // (from its second control point), 9.9 wide.
          const { c2, p3 } = edge.data.curve;
          const [tip, a, b] = trianglePoints(head?.attrs.get('d') ?? '');
          if (!tip || !a || !b) throw new Error('a triangle');
          const length = Math.hypot(p3.x - c2.x, p3.y - c2.y);
          expect(length, edge.id).toBeGreaterThan(0);
          const u = { x: (p3.x - c2.x) / length, y: (p3.y - c2.y) / length };
          expect(tip.x).toBeCloseTo(p3.x, 1);
          expect(tip.y).toBeCloseTo(p3.y, 1);
          expect((a.x + b.x) / 2).toBeCloseTo(p3.x - 11 * u.x, 1);
          expect((a.y + b.y) / 2).toBeCloseTo(p3.y - 11 * u.y, 1);
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(9.9, 1);
          kinds.add(edge.data.kind);
          if (edge.data.count > 1) aggregates += 1;
        }
      }
    }
    expect(kinds.size).toBeGreaterThan(2);
    expect(aggregates).toBeGreaterThan(0);
  });

  it('a label lies where the canvas puts it and says what the canvas says', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    const first = flow.edges.find(
      (e) => flowEdgeLabel(e.data) !== undefined && e.data.labelHidden !== true,
    );
    if (!first) throw new Error('a labelled edge');
    // One label moved along its curve, as `placeLabel` moves one that would cover a name.
    const moved: FlowGraph = {
      nodes: flow.nodes,
      edges: flow.edges.map((e) =>
        e === first ? { ...e, data: { ...e.data, route: { ...e.data.route, labelT: 0.2 } } } : e,
      ),
    };
    const elements = check(mapSvg({ ...BASE, flow: moved }).svg, moved);
    const strokes = {
      dataflow: PICTURE_PALETTE.light.edgeDataflow,
      dependency: PICTURE_PALETTE.light.edgeDependency,
      control: PICTURE_PALETTE.light.edgeControl,
      config: PICTURE_PALETTE.light.edgeConfig,
    };
    let labels = 0;
    const dashed = new Set<EdgeKind>();
    for (const edge of moved.edges) {
      const text = flowEdgeLabel(edge.data);
      if (text === undefined || edge.data.labelHidden === true) continue;
      const g = group(elements, 'data-edge-label', xmlText(edge.id));
      expect(textsOf(elements, g), edge.id).toEqual((edge.data.labelText ?? text).split('\n'));
      const box = childrenOf(elements, g).find((e) => e.attrs.get('data-part') === 'label-box');
      // The border is drawn half a pixel inside the box of the label.
      const width = Number(box?.attrs.get('width')) + 1;
      const height = Number(box?.attrs.get('height')) + 1;
      const at = translateOf(g);
      const middle = labelPoint(edge.data.curve, edge.data.route.labelT);
      expect(at.x + width / 2, edge.id).toBeCloseTo(middle.x, 1);
      expect(at.y + height / 2, edge.id).toBeCloseTo(middle.y, 1);
      expect(box?.attrs.get('stroke')).toBe(strokes[edge.data.kind]);
      // Its lines, with the padding and the border above and below them.
      const lines = (edge.data.labelText ?? text).split('\n').length;
      expect(height - lines * EDGE_LABEL.fontSize * PICTURE_STYLE.label.line, edge.id).toBeCloseTo(
        4,
        1,
      );
      // The border goes by the kind as the line does: dashed for a dependency, dotted for
      // control; the count of several edges has a plain one.
      const counts = edge.data.count > 1 && text === aggregateCountLabel(edge.data.count);
      const dash = counts ? undefined : LABEL_DASHES[edge.data.kind];
      expect(box?.attrs.get('stroke-dasharray'), edge.id).toBe(dash);
      if (dash !== undefined) dashed.add(edge.data.kind);
      labels += 1;
    }
    expect(labels).toBeGreaterThan(3);
    expect([...dashed].sort()).toEqual(['control', 'dependency']);
    const half = labelPoint(first.data.curve, 0.5);
    const there = labelPoint(first.data.curve, 0.2);
    expect(Math.hypot(half.x - there.x, half.y - there.y)).toBeGreaterThan(5);
  });
});

describe('what the heading, the bands and the key say', () => {
  it('the heading is the title and the note; a row and the Unassigned area have their names', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'components');
    const out = mapSvg({
      ...BASE,
      flow,
      heading: {
        title: 'architecture.yaml — Campaign run',
        note: 'Level: Components · Part of the map',
      },
    });
    const elements = check(out.svg, flow);
    expect(textsOf(elements, group(elements, 'data-part', 'heading'))).toEqual([
      'architecture.yaml — Campaign run',
      'Level: Components · Part of the map',
    ]);
    let rows = 0;
    let areas = 0;
    const parities = new Set<number>();
    for (const node of flow.nodes) {
      if (node.type !== 'band') continue;
      const texts = textsOf(elements, group(elements, 'data-band', xmlText(node.id)));
      if (node.data.variant === 'unassigned') {
        expect(texts).toEqual([node.data.name.toUpperCase()]);
        areas += 1;
      } else {
        // On as many lines as the gutter needs.
        expect(tight(texts.join(''))).toBe(tight(node.data.name));
        // The rows alternate between the two band colours, the first with the even one.
        const [ground] = childrenOf(elements, group(elements, 'data-band', xmlText(node.id)));
        const color = parseColor(
          node.data.index % 2 === 0
            ? PICTURE_PALETTE.light.bandEven
            : PICTURE_PALETTE.light.bandOdd,
        );
        expect(ground?.name).toBe('rect');
        expect(ground?.attrs.get('fill'), node.id).toBe(colorHex(color));
        expect(Number(ground?.attrs.get('fill-opacity') ?? 1), node.id).toBeCloseTo(color.a, 3);
        parities.add(node.data.index % 2);
        rows += 1;
      }
    }
    expect(rows).toBeGreaterThan(1);
    expect(areas).toBe(1);
    expect(parities.size).toBe(2);
    expect(PICTURE_PALETTE.light.bandEven).not.toBe(PICTURE_PALETTE.light.bandOdd);
  });

  it('a long title takes two lines at most, an empty note none, and an entry of the key no more room than the key has', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'domains');
    const plain = mapSvg({ ...BASE, flow });
    expect(plain.width).toBeGreaterThan(PICTURE_MIN_TEXT_WIDTH);
    const headed = (title: string, note: string) => {
      const out = mapSvg({ ...BASE, flow, heading: { title, note } });
      const elements = check(out.svg, flow);
      return {
        height: out.height - plain.height,
        texts: textsOf(elements, group(elements, 'data-part', 'heading')),
      };
    };
    const long = 'the map of a structure file with a very long name, '.repeat(12).trim();
    const two = headed(long, 'a note');
    expect(two.texts).toHaveLength(3);
    expect(long.startsWith(two.texts[0] ?? '?')).toBe(true);
    expect(two.texts[1]?.endsWith(ELLIPSIS)).toBe(true);
    expect(two.texts[2]).toBe('a note');
    const one = headed('A title', 'a note');
    const bare = headed('A title', '');
    expect(one.texts).toEqual(['A title', 'a note']);
    expect(bare.texts).toEqual(['A title']);
    // A note that is not there takes no line; a second line of the title takes one.
    expect(bare.height).toBeGreaterThan(0);
    expect(bare.height).toBeLessThan(one.height);
    expect(two.height).toBeGreaterThan(one.height);

    // One value with a name longer than the picture is wide: cut, so that the key stays inside.
    const label = 'a value with a name that goes on and on '.repeat(40).trim();
    const coloring: PictureColoring = {
      colorBy: 'owner',
      legend: [{ label, color: { light: '#336699', dark: '#6699cc' }, count: 3 }],
    };
    const keyed = mapSvg({ ...BASE, flow, legend: { coloring } });
    expect(keyed.width).toBe(plain.width);
    const elements = check(keyed.svg, flow);
    const [heading, entry, count] = textsOf(elements, group(elements, 'data-key', 'colour'));
    expect(heading).toBe('Owner');
    expect(entry?.endsWith(ELLIPSIS)).toBe(true);
    expect(label.startsWith((entry ?? '?').slice(0, -1).trimEnd())).toBe(true);
    expect((entry ?? '').length).toBeGreaterThan(20);
    expect(count).toBe('3');
    expect(estimateMeasure(entry ?? '', 12, 400)).toBeLessThanOrEqual(
      keyed.width - 2 * PICTURE_MARGIN,
    );
  });

  it('the key lists the edge kinds that are in the picture, and no other', async () => {
    const { flow } = await buildMap(exampleYaml, undefined, 'detail');
    const all = [...new Set(flow.edges.map((e) => e.data.kind))];
    expect(all.length).toBeGreaterThan(2);
    const gone = all[0];
    const fewer: FlowGraph = {
      nodes: flow.nodes,
      edges: flow.edges.filter((e) => e.data.kind !== gone),
    };
    const elements = check(mapSvg({ ...BASE, flow: fewer, legend: {} }).svg, fewer);
    const key = group(elements, 'data-key', 'edges');
    const listed = inside(elements, key)
      .map((e) => e.attrs.get('data-key-kind'))
      .filter((kind) => kind !== undefined);
    expect(listed).toEqual(EDGE_KINDS.filter((kind) => kind !== gone && all.includes(kind)));
    const words = textsOf(elements, key);
    expect(words[0]).toBe(KEY_TEXTS.edges);
    expect(words.slice(1, 1 + listed.length)).toEqual(listed);
    // The heavy line of an aggregate is explained only where there is one.
    expect(words.includes(KEY_TEXTS.aggregate)).toBe(fewer.edges.some((e) => e.data.count > 1));
    const rolled = (await buildMap(exampleYaml, undefined, 'components')).flow;
    expect(rolled.edges.some((e) => e.data.count > 1)).toBe(true);
    expect(mapSvg({ ...BASE, flow: rolled, legend: {} }).svg).toContain(
      `>${xmlText(KEY_TEXTS.aggregate)}</text>`,
    );
    // No edge in the picture: no key of edges.
    const none = readXml(
      mapSvg({ ...BASE, flow: { nodes: flow.nodes, edges: [] }, legend: {} }).svg,
    );
    expect(none.some((e) => e.attrs.get('data-key') === 'edges')).toBe(false);
  });
});

describe('what a work-item line and a badge say', () => {
  it('a line has its glyph and its title; a completed one is struck through; the marks of the selection', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const holder = flow.nodes.find(
      (n) =>
        n.type === 'leaf' &&
        (n.data.workItems?.lines.filter((l) => l.kind === 'item').length ?? 0) > 1,
    );
    if (!holder || holder.type === 'band' || !holder.data.workItems) {
      throw new Error('a leaf with two items');
    }
    const [done, parent] = holder.data.workItems.lines.filter((l) => l.kind === 'item');
    if (!done || done.kind !== 'item' || !parent || parent.kind !== 'item')
      throw new Error('two items');
    // The first item of that leaf completed, the second the item a selected task is listed under.
    const flowDone: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n === holder && n.data.workItems
          ? {
              ...n,
              data: {
                ...n.data,
                workItems: {
                  ...n.data.workItems,
                  lines: n.data.workItems.lines.map((l) =>
                    l === done ? { ...l, item: { ...l.item, state: 'Closed' } } : l,
                  ),
                },
              },
            }
          : n,
      ),
    };
    const p = PICTURE_PALETTE.light;
    const out = mapSvg({
      ...BASE,
      flow: flowDone,
      workItem: { selectedId: -1, parentId: parent.item.id },
    });
    const elements = check(out.svg, flowDone);
    const linesOf = (id: number) => {
      const found = elements.filter((e) => e.attrs.get('data-workitem') === String(id));
      expect(found.length).toBeGreaterThan(0);
      return found;
    };
    for (const g of elements.filter((e) => e.attrs.has('data-workitem'))) {
      const texts = inside(elements, g).filter((e) => e.name === 'text');
      expect(texts).toHaveLength(1);
      expect(texts[0]?.text.length).toBeGreaterThan(0);
      // The glyph of its type: a group that is scaled, with a shape in it.
      const glyph = childrenOf(elements, g).find((e) => e.name === 'g');
      if (!glyph) throw new Error('a line without its glyph');
      expect(glyph.attrs.get('transform')).toMatch(/scale\(/);
      expect(childrenOf(elements, glyph).length).toBeGreaterThan(0);
    }
    // (The same item may be listed in another box too: only the line of this leaf was completed.)
    const inHolder = inside(elements, group(elements, 'data-node', holder.id));
    const doneLines = linesOf(done.item.id).filter((g) => inHolder.includes(g));
    expect(doneLines).toHaveLength(1);
    for (const g of doneLines) {
      const text = inside(elements, g).find((e) => e.name === 'text');
      expect(text?.attrs.get('text-decoration')).toBe('line-through');
      expect(text?.attrs.get('opacity')).toBe('0.6');
      expect(
        childrenOf(elements, g)
          .find((e) => e.name === 'g')
          ?.attrs.get('opacity'),
      ).toBe('0.55');
      // What is written is the beginning of the title.
      expect(done.item.title.startsWith((text?.text ?? '').replace(ELLIPSIS, '').trimEnd())).toBe(
        true,
      );
    }
    const open = elements.find(
      (e) =>
        e.attrs.has('data-workitem') && e.attrs.get('data-workitem') === String(parent.item.id),
    );
    if (!open) throw new Error('an open item');
    expect(inside(elements, open).some((e) => e.attrs.has('text-decoration'))).toBe(false);
    // The item a selected task is under: the hover colour behind its line, and no underline.
    const hover = parseColor(p.wiHover);
    for (const g of linesOf(parent.item.id)) {
      expect(g.attrs.has('data-selected')).toBe(false);
      const marks = childrenOf(elements, g).filter((e) => e.name === 'rect');
      expect(marks.map((e) => e.attrs.get('fill'))).toEqual([colorHex(hover)]);
      expect(Number(marks[0]?.attrs.get('fill-opacity'))).toBeCloseTo(hover.a, 3);
    }
    // The selected item: its own colour and the line under it.
    const chosen = readXml(
      mapSvg({ ...BASE, flow: flowDone, workItem: { selectedId: parent.item.id } }).svg,
    );
    const selected = chosen.filter((e) => e.attrs.get('data-workitem') === String(parent.item.id));
    expect(selected.length).toBeGreaterThan(0);
    for (const g of selected) {
      expect(g.attrs.get('data-selected')).toBe('true');
      expect(
        childrenOf(chosen, g)
          .filter((e) => e.name === 'rect')
          .map((e) => e.attrs.get('fill')),
      ).toEqual([colorHex(parseColor(p.wiSelected)), p.nodeSelected]);
    }
    // Without a selection no line carries a mark.
    const plain = readXml(mapSvg({ ...BASE, flow: flowDone }).svg);
    for (const g of plain.filter((e) => e.attrs.has('data-workitem'))) {
      expect(childrenOf(plain, g).some((e) => e.name === 'rect')).toBe(false);
    }
  });

  it('an item shows its title, a task its first words under its item, and what is left out is said in italics', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const holder = flow.nodes.find(
      (n) =>
        n.type === 'leaf' &&
        (n.data.workItems?.lines.filter((l) => l.kind === 'item').length ?? 0) > 1,
    );
    if (!holder || holder.type === 'band') throw new Error('a leaf with two items');
    const items = holder.data.workItems;
    const [first, second] = items?.lines.filter((l) => l.kind === 'item') ?? [];
    if (!items || first?.kind !== 'item' || second?.kind !== 'item') throw new Error('two items');
    // An item whose reserved text differs from its title, a task under it, and a line for the rest.
    const lines: WorkItemLine[] = [
      { ...first, text: 'reserved' },
      { kind: 'task', item: second.item, parentId: first.item.id, text: 'first words' },
      { kind: 'more', count: 2, text: '+2 more' },
    ];
    const listed: FlowGraph = {
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n.type !== 'band' && n.id === holder.id
          ? { ...n, data: { ...n.data, workItems: { ...items, lines } } }
          : n,
      ),
    };
    const elements = check(mapSvg({ ...BASE, flow: listed }).svg, listed);
    const parts = childrenOf(elements, group(elements, 'data-node', holder.id));
    const [item, task] = parts.filter((e) => e.attrs.has('data-workitem'));
    if (!item || !task) throw new Error('two lines');
    const textOf = (line: XmlElement) => childrenOf(elements, line).find((e) => e.name === 'text');
    const glyphX = (line: XmlElement) => {
      const glyph = childrenOf(elements, line).find((e) => e.name === 'g');
      const at = /^translate\((-?[\d.]+) /.exec(glyph?.attrs.get('transform') ?? '');
      if (!at) throw new Error('a glyph that is placed');
      return Number(at[1]);
    };
    const g = WORK_ITEM_GEOMETRY;
    // The title, as much of it as there is room for — not the text the block was sized by.
    const shown = textOf(item)?.text ?? '';
    expect(shown).not.toBe('reserved');
    expect(shown.length).toBeGreaterThan(3);
    expect(first.item.title.startsWith(shown.replace(ELLIPSIS, '').trimEnd())).toBe(true);
    expect(textOf(item)?.attrs.get('font-size')).toBe(String(g.fontSize));
    // The task: its first words, smaller, glyph and text indented under the item.
    expect(textOf(task)?.text).toBe('first words');
    expect(textOf(task)?.attrs.get('font-size')).toBe(String(g.taskFontSize));
    expect(glyphX(task) - glyphX(item)).toBe(g.taskIndent);
    expect(Number(textOf(task)?.attrs.get('x')) - Number(textOf(item)?.attrs.get('x'))).toBe(
      g.taskIndent,
    );
    // What is left out: one line of secondary text in italics, not a work item.
    const more = parts.find((e) => e.name === 'text' && e.text === '+2 more');
    expect(more?.attrs.get('font-style')).toBe('italic');
    expect(more?.attrs.get('fill')).toBe(PICTURE_PALETTE.light.muted);
    expect(parts.filter((e) => e.attrs.has('data-workitem'))).toHaveLength(2);
  });

  it('the name of a leaf is centred above its block; a badge without a block ends at the same place whatever it counts', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'detail');
    const leaf = flow.nodes.find((n) => n.type === 'leaf' && n.data.contentRect);
    if (!leaf || leaf.type === 'band') throw new Error('a leaf with a block');
    const reserved = leaf.data.contentRect?.height ?? 0;
    expect(reserved).toBeGreaterThan(0);
    const read = (changed: FlowGraph) => {
      const elements = check(mapSvg({ ...BASE, flow: changed }).svg, changed);
      const g = group(elements, 'data-node', leaf.id);
      const name = childrenOf(elements, g).find((e) => e.name === 'text');
      const badge = inside(elements, g).find((e) => e.attrs.get('data-part') === 'badge');
      const frame = badge ? childrenOf(elements, badge).find((e) => e.name === 'rect') : undefined;
      // The border of the badge is drawn half a pixel inside its box.
      const left = Number(frame?.attrs.get('x')) - 0.5;
      const width = Number(frame?.attrs.get('width')) + 1;
      return { nameY: Number(name?.attrs.get('y')), right: left + width, width };
    };
    const without = (counts: WorkItemCounts): FlowGraph => ({
      edges: flow.edges,
      nodes: flow.nodes.map((n) =>
        n.type !== 'band' && n.id === leaf.id
          ? {
              ...n,
              data: { ...n.data, contentRect: undefined, workItems: undefined, badge: counts },
            }
          : n,
      ),
    });
    const few = read(without({ stories: 3, openBugs: 0 }));
    const many = read(without({ stories: 12345, openBugs: 77 }));
    // Without a block the name is in the middle of the box: half the block lower.
    expect(few.nameY - read(flow).nameY).toBeCloseTo(reserved / 2, 2);
    // The badge on the upper edge grows to the left: its right end stays, inside the box.
    expect(many.width).toBeGreaterThan(few.width + 20);
    expect(many.right).toBeCloseTo(few.right, 2);
    expect(few.right).toBeLessThan(leaf.width);
    expect(few.right).toBeGreaterThan(leaf.width / 2);
  });

  it('a badge says how many work items its box holds', async () => {
    const { flow } = await buildMap(exampleYaml, fixtureJson, 'components');
    const elements = check(mapSvg({ ...BASE, flow }).svg, flow);
    let badges = 0;
    for (const node of flow.nodes) {
      if (node.type === 'band' || !node.data.badge) continue;
      const badge = inside(elements, group(elements, 'data-node', node.id)).find(
        (e) => e.attrs.get('data-part') === 'badge',
      );
      if (!badge) throw new Error(`no badge in ${node.id}`);
      const counts = node.data.badge;
      expect(textsOf(elements, badge), node.id).toEqual(
        counts.openBugs > 0
          ? [String(counts.stories), String(counts.openBugs)]
          : [String(counts.stories)],
      );
      badges += 1;
    }
    expect(badges).toBeGreaterThan(0);
  });
});
