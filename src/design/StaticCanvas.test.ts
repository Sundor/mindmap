import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  curvePath,
  DEFAULT_DISPLAY_SETTINGS,
  flowEdgeLabel,
  highlightFlow,
  labelPoint,
  progressOfDrawn,
  type FlowGraph,
  type LayoutResult,
  type Viewport,
} from '../core';
import { fitOptions, fittedViewport } from '../ui/constants';
import { DetailTab } from '../ui/DetailTab';
import { GroupWorkItemLists } from '../ui/WorkItemBlock';
import { HANDLE_BOX, loadFixtures, type MapFixture } from './fixtures';
import { fillContainer, startTags, withoutHandles, type StartTag } from './markup';
import { EdgeLabelLayer, FlowStore, StaticCanvas, type StaticCanvasProps } from './StaticCanvas';

const SIZE = { width: 1100, height: 700 };
const noop = (): undefined => undefined;

interface Drawn {
  readonly layout: LayoutResult;
  readonly flow: FlowGraph;
}

let example: MapFixture;
let specimen: MapFixture;
let everything: Drawn;
let domains: Drawn;
let unlocked: Drawn;

beforeAll(async () => {
  ({ example, specimen } = await loadFixtures());
  everything = await example.flow({ mode: 'stories', lod: 'detail' });
  domains = await example.flow({ mode: 'stories', lod: 'domains' });
  unlocked = await example.flow({ mode: 'stories', lod: 'detail', draggable: true });
}, 60_000);

/** The view the app fits for `flow` in a canvas of `SIZE`. */
function fitted(flow: FlowGraph): Viewport {
  const view = fittedViewport(fitOptions(0), flow.nodes, SIZE);
  if (!view) throw new Error('Nothing to fit');
  return view;
}

/** The markup of the canvas of `flow` below a store of its own, in the view the app fits. */
function canvas(
  { layout, flow }: Drawn,
  options: Partial<Pick<StaticCanvasProps, 'unlocked' | 'lenses' | 'workItemCanvas'>> = {},
): string {
  return renderToStaticMarkup(
    createElement(FlowStore, {
      flow,
      size: SIZE,
      view: fitted(flow),
      unlocked: options.unlocked,
      children: createElement(StaticCanvas, { flow, bounds: layout.bounds, ...options }),
    }),
  );
}

const classesOf = (tag: StartTag): string[] => (tag.attributes.get('class') ?? '').split(' ');
const withClass = (html: string, name: string): StartTag[] =>
  startTags(html).filter((tag) => classesOf(tag).includes(name));
const boxesOf = (flow: FlowGraph): number =>
  flow.nodes.filter((node) => node.type !== 'band').length;
const numbersOf = (path: string | undefined): number[] =>
  (path?.match(/-?[0-9]+(?:[.][0-9]+)?/g) ?? []).map(Number);

describe('FlowStore', () => {
  it('renders no element of its own', () => {
    const html = renderToStaticMarkup(
      createElement(FlowStore, {
        size: SIZE,
        view: { x: 0, y: 0, zoom: 1 },
        children: createElement('i', { className: 'below' }),
      }),
    );
    expect(html).toBe('<i class="below"></i>');
  });

  it('gives the Detail tab the zoom it reads, which throws without a store', () => {
    const tab = createElement(DetailTab, {
      drawn: true,
      lodMode: 'auto',
      lodLevel: 'components',
      lodConfig: DEFAULT_DISPLAY_SETTINGS.lod,
      onChooseLod: noop,
      collapsedCount: 0,
      canCollapseAll: true,
      onCollapseAll: noop,
      onExpandAll: noop,
      settings: DEFAULT_DISPLAY_SETTINGS,
      onChange: noop,
      hasWorkItems: true,
      onChooseStoryMode: noop,
    });
    expect(() => renderToStaticMarkup(tab)).toThrow();
    const html = renderToStaticMarkup(
      createElement(FlowStore, { size: SIZE, view: { x: 0, y: 0, zoom: 0.85 }, children: tab }),
    );
    expect(html).toMatch(/id="zoom-readout"[^>]*>[^<]*85/);
  });
});

describe('StaticCanvas with the shipped example', () => {
  it('draws every node and every edge', () => {
    const html = canvas(everything);
    const { flow } = everything;
    expect(flow.nodes.length).toBeGreaterThan(40);
    expect(flow.edges.length).toBeGreaterThan(40);
    expect(withClass(html, 'react-flow__node').map((tag) => tag.attributes.get('data-id'))).toEqual(
      flow.nodes.map((node) => node.id),
    );
    expect(
      withClass(html, 'react-flow__edge')
        .map((tag) => tag.attributes.get('data-id'))
        .sort(),
    ).toEqual(flow.edges.map((edge) => edge.id).sort());
  });

  it('draws each edge along the curve it has in the flow, ending at the outer side of a handle', () => {
    const html = canvas(everything);
    const drawn = new Map(
      withClass(html, 'react-flow__edge-path').map((tag) => [
        tag.attributes.get('id'),
        tag.attributes.get('d'),
      ]),
    );
    expect(drawn.size).toBe(everything.flow.edges.length);
    let furthest = 0;
    for (const edge of everything.flow.edges) {
      const got = numbersOf(drawn.get(edge.id));
      const wanted = numbersOf(curvePath(edge.data.curve));
      expect(got.length, edge.id).toBe(wanted.length);
      expect(got.length, edge.id).toBeGreaterThanOrEqual(8);
      got.forEach((value, index) => {
        furthest = Math.max(furthest, Math.abs(value - (wanted[index] ?? NaN)));
      });
    }
    expect(furthest).toBeLessThanOrEqual(HANDLE_BOX / 2 + 0.25);
    // The curve of the flow ends on the sides of the boxes, a drawn edge half a handle outside.
    expect(furthest).toBeGreaterThanOrEqual(HANDLE_BOX / 2 - 0.01);
  });

  it('gives the wrappers what the app gives them: not selectable, no Tab stop', () => {
    const leaf = everything.flow.nodes.find((node) => node.type === 'leaf');
    if (!leaf) throw new Error('The example has no leaf');
    const html = canvas({
      layout: everything.layout,
      flow: highlightFlow(everything.flow, { type: 'node', id: leaf.id }),
    });
    const wrappers = [
      ...withClass(html, 'react-flow__node'),
      ...withClass(html, 'react-flow__edge'),
    ];
    expect(wrappers.filter((tag) => classesOf(tag).includes('selectable'))).toEqual([]);
    expect(wrappers.filter((tag) => classesOf(tag).includes('draggable'))).toEqual([]);
    expect(startTags(html).filter((tag) => tag.attributes.get('tabindex') === '0')).toEqual([]);
    for (const tag of withClass(html, 'react-flow__edge')) {
      expect(tag.attributes.get('role')).toBe('img');
    }
    const selected = withClass(html, 'react-flow__node').filter((tag) =>
      classesOf(tag).includes('selected'),
    );
    expect(selected.map((tag) => tag.attributes.get('data-id'))).toEqual([leaf.id]);
    expect(selected[0]?.attributes.get('class')).toBe(
      'react-flow__node react-flow__node-leaf selected',
    );
    // Not raised above the other leaves for being selected.
    expect(selected[0]?.attributes.get('style')).toMatch(/^z-index:10;/);
  });

  it('lets the boxes be dragged when the positions are unlocked', () => {
    const html = canvas(unlocked, { unlocked: true });
    const boxes = withClass(html, 'react-flow__node').filter(
      (tag) => !classesOf(tag).includes('react-flow__node-band'),
    );
    expect(boxes.length).toBe(boxesOf(unlocked.flow));
    for (const tag of boxes) {
      expect(classesOf(tag), tag.attributes.get('data-id')).toEqual(
        expect.arrayContaining(['nopan', 'draggable']),
      );
    }
    expect(html).toContain('class="react-flow__node react-flow__node-leaf nopan draggable"');
  });

  it('shows the view it is given, at the Everything and at the Domains level', () => {
    for (const drawn of [everything, domains]) {
      const view = fitted(drawn.flow);
      const [viewport] = withClass(canvas(drawn), 'react-flow__viewport');
      expect(viewport?.attributes.get('style')).toContain(
        `transform:translate(${String(view.x)}px,${String(view.y)}px) scale(${String(view.zoom)})`,
      );
    }
    expect(fitted(everything.flow)).not.toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('leaves one empty container for the edge labels and one for the lists of open groups', () => {
    const html = canvas(everything);
    expect(html.split('<div class="react-flow__edgelabel-renderer"></div>').length - 1).toBe(1);
    expect(html.split('<div class="react-flow__viewport-portal"></div>').length - 1).toBe(1);
    expect(withClass(html, 'arch-edge-label')).toEqual([]);
    expect(withClass(html, 'arch-workitems-above')).toEqual([]);
  });

  it('draws eight handles per box, which can be taken out', () => {
    const html = canvas(everything);
    const handles = startTags(html).filter((tag) => tag.attributes.has('data-handleid'));
    expect(handles.length).toBe(boxesOf(everything.flow) * 8);
    const without = withoutHandles(html);
    expect(startTags(without).filter((tag) => tag.attributes.has('data-handleid'))).toEqual([]);
    expect(startTags(without).length).toBe(startTags(html).length - handles.length);
    expect(withClass(without, 'react-flow__node').length).toBe(everything.flow.nodes.length);
  });

  it('draws the Domains level with its closed groups', () => {
    const html = canvas(domains);
    expect(withClass(html, 'react-flow__node').length).toBe(domains.flow.nodes.length);
    expect(withClass(html, 'react-flow__edge').length).toBe(domains.flow.edges.length);
    expect(domains.flow.nodes.length).toBeLessThan(everything.flow.nodes.length);
    expect(withClass(html, 'arch-collapsed').length).toBeGreaterThan(0);
  });
});

describe('StaticCanvas with the specimen model', () => {
  it('passes the lenses on to the boxes', async () => {
    const drawn = await specimen.flow({ mode: 'stories', lod: 'detail' });
    expect(withClass(canvas(drawn), 'arch-progress')).toEqual([]);
    const drawnIds = new Set(drawn.flow.nodes.map((node) => node.id));
    const progress = progressOfDrawn(specimen.model, specimen.overlay, drawnIds);
    const html = canvas(drawn, { lenses: { progress } });
    expect(withClass(html, 'arch-progress').length).toBeGreaterThan(0);
  });

  it('passes the selected work item on to the lines', async () => {
    const drawn = await specimen.flow({ mode: 'stories', lod: 'detail' });
    const line = drawn.flow.nodes
      .flatMap((node) => (node.type === 'leaf' ? (node.data.workItems?.lines ?? []) : []))
      .find((found) => found.kind !== 'more');
    if (!line) throw new Error('No leaf of the specimen lists a work item');
    expect(withClass(canvas(drawn), 'arch-workitem-selected')).toEqual([]);
    const html = canvas(drawn, { workItemCanvas: { selectedId: line.item.id, select: noop } });
    expect(withClass(html, 'arch-workitem-selected').length).toBeGreaterThan(0);
  });
});

describe('EdgeLabelLayer', () => {
  it('draws the label of every edge that has one to draw, where its curve has it', () => {
    const { flow } = everything;
    const html = renderToStaticMarkup(createElement(EdgeLabelLayer, { flow }));
    const labelled = flow.edges.filter(
      (edge) => flowEdgeLabel(edge.data) !== undefined && edge.data.labelHidden !== true,
    );
    expect(labelled.length).toBeGreaterThan(0);
    const labels = withClass(html, 'arch-edge-label');
    expect(labels.map((tag) => tag.attributes.get('data-edge-id'))).toEqual(
      labelled.map((edge) => edge.id),
    );
    labelled.forEach((edge, index) => {
      const at = labelPoint(edge.data.curve, edge.data.route.labelT);
      expect(labels[index]?.attributes.get('style'), edge.id).toBe(
        `transform:translate(-50%, -50%) translate(${String(at.x)}px, ${String(at.y)}px)`,
      );
      expect(classesOf(labels[index] ?? { name: '', attributes: new Map() })).toContain(
        `arch-edge-label-${edge.data.kind}`,
      );
    });
  });

  it('fills, with the lists of the open groups, the two containers of a canvas', () => {
    const { flow } = everything;
    const labels = renderToStaticMarkup(createElement(EdgeLabelLayer, { flow }));
    const lists = renderToStaticMarkup(
      createElement(GroupWorkItemLists, { nodes: flow.nodes, onSelectNode: noop }),
    );
    expect(withClass(lists, 'arch-workitems-above').length).toBeGreaterThan(0);
    const html = fillContainer(
      fillContainer(canvas(everything), 'react-flow__edgelabel-renderer', labels),
      'react-flow__viewport-portal',
      lists,
    );
    expect(withClass(html, 'arch-edge-label').length).toBe(
      withClass(labels, 'arch-edge-label').length,
    );
    expect(withClass(html, 'arch-workitems-above').length).toBe(
      withClass(lists, 'arch-workitems-above').length,
    );
  });
});
