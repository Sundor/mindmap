// What the design pages draw, prepared before anything renders: the specimen and the example map
// laid out, their flows in every state a page shows, the views the app would fit for them, and
// the lists of specimens and screens in page order.

import type { Viewport } from '@xyflow/react';
import {
  authoringHints,
  colorByOptions,
  EDGE_KINDS,
  focusFlow,
  focusSet,
  heatOfDrawn,
  highlightFlow,
  lodForZoom,
  nodeColoring,
  progressOfDrawn,
  quietEdges,
  type ArchitectureModel,
  type AuthoringHint,
  type ColorByOption,
  type ControlTab,
  type EdgeKind,
  type Focus,
  type FlowGraph,
  type LayoutResult,
  type LodLevel,
  type NodeColoring,
  type Size,
  type StoryMode,
  type WorkItemSummary,
} from '../core';
import { fitOptions, fittedViewport } from '../ui/constants';
import type { NodeLenses } from '../ui/nodeLensContext';
import type { WorkItemCanvas } from '../ui/workItemContext';
import type { Fixtures, MapFixture } from './fixtures';
import type { AppData } from './Frame';

/** Pixels of the control panel's rail and body at a root font size of 16 px (`--cp-rail-width`, `--cp-body-width`). */
export const RAIL_WIDTH = 56;
export const BODY_WIDTH = 280;
/** The closed diagnostics line below the map; its height is the browser's, this is an estimate. */
export const DIAGNOSTICS_BAR = 34;
export const DETAIL_PANEL_WIDTH = 340;
export const KIT_CANVAS: Size = { width: 900, height: 560 };
export const SCREEN: Size = { width: 1440, height: 900 };
export const NARROW_SCREEN: Size = { width: 1000, height: 720 };

export type SpecimenKind = 'panel' | 'canvas' | 'block' | 'screen';

export interface SpecimenInfo {
  readonly id: string;
  readonly section: string;
  readonly kind: SpecimenKind;
  readonly title: string;
  readonly states?: string | undefined;
  readonly note: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly narrow?: boolean | undefined;
}

/** A canvas as a page draws it: the flow after what the state does to it, in the view the app fits. */
export interface Canvas {
  readonly flow: FlowGraph;
  readonly layout: LayoutResult;
  readonly size: Size;
  readonly view: Viewport;
  readonly level: LodLevel;
  readonly storyMode: StoryMode;
  readonly unlocked?: boolean | undefined;
  readonly lenses?: NodeLenses | undefined;
  readonly workItemCanvas?: WorkItemCanvas | undefined;
  /** The handles of the boxes stay in the markup. */
  readonly handles?: boolean | undefined;
  readonly shrunk?: boolean | undefined;
  readonly closeGaps?: boolean | undefined;
  readonly collapsedCount?: number | undefined;
}

export interface Prepared {
  readonly specimen: MapFixture;
  readonly example: MapFixture;
  /** The canvases of the kit and of the screens, by the id of their specimen or screen. */
  readonly canvases: ReadonlyMap<string, Canvas>;
  readonly owner: NodeColoring;
  readonly metric: NodeColoring | undefined;
  readonly colorChoices: readonly ColorByOption[];
  /** The choices of the example, which has colour presets; and the colouring of one of them. */
  readonly exampleColorChoices: readonly ColorByOption[];
  readonly preset: NodeColoring | undefined;
  readonly hints: readonly AuthoringHint[];
  readonly kindCounts: Readonly<Record<EdgeKind, number>>;
  /** Ids of the specimen model the detail panel and the canvases select. */
  readonly ids: {
    readonly group: string;
    readonly leaf: string;
    readonly edge: string;
    readonly story: number;
    readonly task: number;
    readonly flow: string;
    /** A merged edge of the Domains level, when the model has one. */
    readonly aggregate: string | undefined;
  };
  readonly focus: Focus;
  readonly exampleIds: { readonly component: string; readonly flow: string };
}

const noop = (): undefined => undefined;
/** Before a structure is loaded only the Files tab can be chosen. */
export const FILES_ONLY: readonly ControlTab[] = ['files'];

/** The `data-*` of the app for a canvas in a given state. */
export function canvasData(canvas: Canvas, more: AppData = {}): AppData {
  return {
    load: 'done',
    lod: canvas.level,
    'zoom-lod': canvas.level,
    'lod-mode': 'auto',
    'show-rows': true,
    'compact-collapsed': canvas.shrunk === true,
    'close-gaps': canvas.closeGaps === true,
    'positions-unlocked': canvas.unlocked === true,
    'story-mode': canvas.storyMode,
    'collapsed-count': canvas.collapsedCount ?? 0,
    'color-by': canvas.lenses?.colors ? 'owner' : 'none',
    heat: canvas.lenses?.heat !== undefined,
    progress: canvas.lenses?.progress !== undefined,
    'panel-tab': 'detail',
    'panel-collapsed': false,
    ...more,
  };
}

const PANEL = { width: RAIL_WIDTH + BODY_WIDTH, height: 560 };
const DETAIL = { width: DETAIL_PANEL_WIDTH, height: 560 };

export const KIT_SPECIMENS: readonly SpecimenInfo[] = [
  {
    id: 'tokens',
    section: 'Tokens',
    kind: 'block',
    title: 'Custom properties',
    note: 'Every custom property declared on :root of the app stylesheet, with its light and dark value; the colours of the heat scale and of Colour by are set in src/core.',
  },
  {
    id: 'icons',
    section: 'Icons and small parts',
    kind: 'block',
    title: 'Icons of the rail, work-item icons, the switch',
    note: 'The eleven icons of the control panel, the icons of the work-item types, and the two-sided switch in both positions.',
  },
  {
    id: 'panel-detail',
    section: 'Control panel',
    kind: 'panel',
    title: 'Detail tab, level by zoom',
    states: 'hover, focus',
    note: 'Auto: the level the zoom chooses is marked; two groups closed by hand; the story mode and the zoom thresholds.',
    ...PANEL,
  },
  {
    id: 'panel-detail-pinned',
    section: 'Control panel',
    kind: 'panel',
    title: 'Detail tab, a level pinned',
    note: 'A pinned level, Close up the gaps on (Shrink collapsed groups checked and disabled), thresholds changed.',
    ...PANEL,
  },
  {
    id: 'panel-visibility',
    section: 'Control panel',
    kind: 'panel',
    title: 'Visibility tab, a focus in Focus mode',
    note: 'A flow chosen as focus, the switch on Focus, one edge kind hidden, the work-item filter.',
    ...PANEL,
  },
  {
    id: 'panel-visibility-filter',
    section: 'Control panel',
    kind: 'panel',
    title: 'Visibility tab, Filter mode',
    note: 'The switch on Filter, Edges on demand on, an iteration chosen.',
    ...PANEL,
  },
  {
    id: 'panel-lenses',
    section: 'Control panel',
    kind: 'panel',
    title: 'Lenses tab',
    note: 'Colour by a preset with its note, Heat by work and Progress bars on.',
    ...PANEL,
  },
  {
    id: 'panel-lenses-empty',
    section: 'Control panel',
    kind: 'panel',
    title: 'Lenses tab, nothing drawn',
    note: 'The tab while no map is drawn.',
    ...PANEL,
  },
  {
    id: 'panel-layout',
    section: 'Control panel',
    kind: 'panel',
    title: 'Layout tab, positions locked',
    note: 'Rows on, nothing moved: Reset positions disabled.',
    ...PANEL,
  },
  {
    id: 'panel-layout-unlocked',
    section: 'Control panel',
    kind: 'panel',
    title: 'Layout tab, positions unlocked',
    note: 'Three boxes moved and two groups resized by hand.',
    ...PANEL,
  },
  {
    id: 'panel-views',
    section: 'Control panel',
    kind: 'panel',
    title: 'Views tab',
    note: 'Two saved views and the name of a third typed.',
    ...PANEL,
  },
  {
    id: 'panel-views-empty',
    section: 'Control panel',
    kind: 'panel',
    title: 'Views tab, no view saved',
    note: 'The tab before a view was saved.',
    ...PANEL,
  },
  {
    id: 'panel-files',
    section: 'Control panel',
    kind: 'panel',
    title: 'Files tab',
    note: 'Both files loaded, the export section, two recent maps with the current one marked.',
    ...PANEL,
  },
  {
    id: 'panel-start',
    section: 'Control panel',
    kind: 'panel',
    title: 'Files tab before a map is loaded',
    note: 'Only the Files tab can be chosen; the search and Fit view are disabled.',
    ...PANEL,
  },
  {
    id: 'panel-collapsed',
    section: 'Control panel',
    kind: 'panel',
    title: 'The rail alone',
    note: 'The body hidden: the tabs still carry their marks.',
    width: RAIL_WIDTH,
    height: 560,
  },
  {
    id: 'panel-flyout',
    section: 'Control panel',
    kind: 'panel',
    title: 'The search card beside the rail',
    note: 'The body hidden and the search opened: hits for nodes and work items, the first active.',
    width: RAIL_WIDTH + BODY_WIDTH,
    height: 560,
  },
  {
    id: 'panel-flyout-narrow',
    section: 'Control panel',
    kind: 'panel',
    title: 'The search card in a narrow window',
    note: 'The same card where the window is narrower than the dock width: it stays a card over the map.',
    width: RAIL_WIDTH + BODY_WIDTH,
    height: 560,
    narrow: true,
  },
  {
    id: 'search-none',
    section: 'Control panel',
    kind: 'panel',
    title: 'Search without a hit',
    note: 'The search card with a query nothing matches.',
    width: RAIL_WIDTH + BODY_WIDTH,
    height: 300,
  },
  {
    id: 'search-filtered',
    section: 'Control panel',
    kind: 'panel',
    title: 'Search on a filtered map',
    note: 'Hits that the filtered map leaves out are marked as outside.',
    width: RAIL_WIDTH + BODY_WIDTH,
    height: 360,
  },
  {
    id: 'map-plain',
    section: 'Map',
    kind: 'canvas',
    title: 'The map at the Everything level',
    states: 'hover on boxes and edges',
    note: 'Row bands, open groups, leaves of three levels, a group closed by hand, the four edge kinds with their labels, work-item lines, badges, minimap and controls.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-selected-node',
    section: 'Map',
    kind: 'canvas',
    title: 'A box selected',
    note: 'The selected box ringed, its neighbours lit and the rest dimmed.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-selected-edge',
    section: 'Map',
    kind: 'canvas',
    title: 'An edge selected',
    note: 'The selected edge drawn heavier, the rest dimmed.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-selected-workitem',
    section: 'Map',
    kind: 'canvas',
    title: 'A work item selected',
    note: 'Story mode Tasks: the line of the selected item marked, related lines lighter.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-focus',
    section: 'Map',
    kind: 'canvas',
    title: 'A flow in focus',
    note: 'What the flow involves stays, the rest is paled.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-lenses',
    section: 'Map',
    kind: 'canvas',
    title: 'The lenses',
    note: 'Colour by owner tints the boxes; heat strips and progress bars on the boxes that have work.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-domains',
    section: 'Map',
    kind: 'canvas',
    title: 'The Domains level',
    note: 'Large titles, aggregated edges with counts, larger badges and band labels.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-shrunk',
    section: 'Map',
    kind: 'canvas',
    title: 'Closed groups drawn shrunk',
    note: 'Shrink collapsed groups: a closed group is its small box with a badge.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-on-demand',
    section: 'Map',
    kind: 'canvas',
    title: 'Edges on demand',
    note: 'Only the edges at one box are shown; the others are held back.',
    ...KIT_CANVAS,
  },
  {
    id: 'map-unlocked',
    section: 'Map',
    kind: 'canvas',
    title: 'Positions unlocked',
    note: 'The boxes can be dragged; open groups show the grip in their title bar and the resize handles.',
    ...KIT_CANVAS,
  },
  {
    id: 'legends',
    section: 'Map',
    kind: 'block',
    title: 'The legends',
    note: 'The edge legend with one kind hidden, the legend of a preset with its counts, and the ramp of a metric.',
  },
  {
    id: 'detail-group',
    section: 'Detail panel',
    kind: 'panel',
    title: 'A group',
    note: 'A node with children, its row, an inherited attribute, labels, metrics, work, description, links, flows and the lists of edges.',
    ...DETAIL,
  },
  {
    id: 'detail-leaf',
    section: 'Detail panel',
    kind: 'panel',
    title: 'A leaf',
    note: 'A subcomponent with its edges and work items.',
    ...DETAIL,
  },
  {
    id: 'detail-edge',
    section: 'Detail panel',
    kind: 'panel',
    title: 'An edge',
    note: 'From, to, kind, label and the flows it is part of.',
    ...DETAIL,
  },
  {
    id: 'detail-merged',
    section: 'Detail panel',
    kind: 'panel',
    title: 'A merged edge',
    note: 'An edge of the Domains level that stands for several: its kind and count, and the member edges.',
    ...DETAIL,
  },
  {
    id: 'detail-story',
    section: 'Detail panel',
    kind: 'panel',
    title: 'A story',
    note: 'A work item with its tasks, state and link.',
    ...DETAIL,
  },
  {
    id: 'detail-task',
    section: 'Detail panel',
    kind: 'panel',
    title: 'A task',
    note: 'A task under its story.',
    ...DETAIL,
  },
  {
    id: 'detail-flow',
    section: 'Detail panel',
    kind: 'panel',
    title: 'A flow',
    note: 'The steps of a flow, with the focus set on it.',
    ...DETAIL,
  },
  {
    id: 'detail-outside',
    section: 'Detail panel',
    kind: 'panel',
    title: 'A node outside the filtered map',
    note: 'The selected node is not drawn: the panel says so and offers to show it.',
    ...DETAIL,
  },
  {
    id: 'focus-bar',
    section: 'Notices',
    kind: 'block',
    title: 'The focus bar, Focus mode',
    note: 'Above the map while a focus is set: its name, counts, the mode switch, Show and Clear.',
  },
  {
    id: 'focus-bar-filter',
    section: 'Notices',
    kind: 'block',
    title: 'The focus bar, Filter mode',
    note: 'The same with Filter on and a note.',
  },
  {
    id: 'file-error',
    section: 'Notices',
    kind: 'block',
    title: 'A file error',
    note: 'A file that could not be read.',
  },
  {
    id: 'view-note',
    section: 'Notices',
    kind: 'block',
    title: 'A view without its colouring',
    note: 'A saved view or link coloured by something the file does not have.',
  },
  {
    id: 'status-lines',
    section: 'Notices',
    kind: 'block',
    title: 'The status lines',
    note: 'Loading, a file with errors, nothing to draw, the layout being computed, a layout that failed.',
  },
  {
    id: 'diagnostics-closed',
    section: 'Notices',
    kind: 'block',
    title: 'Diagnostics, closed',
    note: 'Warnings, tag coverage and hints as badges on the closed line.',
  },
  {
    id: 'diagnostics-open',
    section: 'Notices',
    kind: 'block',
    title: 'Diagnostics, open',
    note: 'Errors open the panel: both tables, the coverage and the hints.',
  },
  {
    id: 'start',
    section: 'Notices',
    kind: 'block',
    title: 'The start page',
    note: 'Nothing loaded: the button, the hint and the note on the template files.',
  },
  {
    id: 'start-recent',
    section: 'Notices',
    kind: 'block',
    title: 'The start page with recent maps',
    note: 'The maps opened before, offered to open again.',
  },
  {
    id: 'drop-overlay',
    section: 'Notices',
    kind: 'block',
    title: 'The drop overlay',
    note: 'Shown over the page while a file is dragged across it.',
    height: 160,
  },
  {
    id: 'viewer-stopped',
    section: 'Notices',
    kind: 'block',
    title: 'The viewer stopped',
    note: 'What the page shows when the viewer threw.',
  },
];

export const SCREENS: readonly SpecimenInfo[] = [
  {
    id: 'screen-start',
    section: 'Screens',
    kind: 'screen',
    title: 'The app as it starts',
    note: 'Nothing loaded: the panel on Files, the start page.',
    ...SCREEN,
  },
  {
    id: 'screen-map',
    section: 'Screens',
    kind: 'screen',
    title: 'The example loaded',
    note: 'The whole map fitted, the level Auto gives at that zoom, the diagnostics closed.',
    ...SCREEN,
  },
  {
    id: 'screen-everything',
    section: 'Screens',
    kind: 'screen',
    title: 'The example pinned to Everything',
    note: 'Every box and edge with its label, the work items in the boxes.',
    ...SCREEN,
  },
  {
    id: 'screen-selected',
    section: 'Screens',
    kind: 'screen',
    title: 'A component selected',
    note: 'The detail panel open, Colour by owner with its legend, heat and progress, a flow in focus.',
    ...SCREEN,
  },
];

function first<T>(list: readonly T[], what: string): T {
  const [head] = list;
  if (head === undefined) throw new Error(`The specimen has no ${what}`);
  return head;
}

function fit(flow: FlowGraph, size: Size): Viewport {
  const view = fittedViewport(fitOptions(0), flow.nodes, size);
  if (!view) throw new Error('Nothing to fit');
  return view;
}

const boxIds = (flow: FlowGraph): Set<string> =>
  new Set(flow.nodes.filter((node) => node.type !== 'band').map((node) => node.id));

function lensesOf(
  model: ArchitectureModel,
  fixture: MapFixture,
  flow: FlowGraph,
  owner: NodeColoring,
): NodeLenses {
  const drawn = boxIds(flow);
  return {
    heat: heatOfDrawn(model, fixture.overlay, drawn),
    progress: progressOfDrawn(model, fixture.overlay, drawn),
    colors: owner.byNode,
  };
}

function itemOfType(
  items: readonly WorkItemSummary[],
  type: WorkItemSummary['type'],
): WorkItemSummary {
  const item = items.find((candidate) => candidate.type === type);
  if (!item) throw new Error(`The specimen has no work item of type ${type}`);
  return item;
}

/** Everything that has to be awaited, so that the components only render. */
export async function prepare({ specimen, example }: Fixtures): Promise<Prepared> {
  const model = specimen.model;
  const nodes = [...model.nodes.values()];
  const group = first(
    nodes.filter((node) => node.level === 1),
    'component',
  );
  const leaf = first(
    nodes.filter((node) => node.level === 2),
    'subcomponent',
  );
  const edge =
    model.edges.find((candidate) => candidate.kind === 'config') ?? first(model.edges, 'edge');
  const flowId = (model.flows.find((flow) => flow.nodeIds.length > 0) ?? first(model.flows, 'flow'))
    .id;
  const story = itemOfType(specimen.items, 'User Story');
  const task = itemOfType(specimen.items, 'Task');
  const focus: Focus = { type: 'flow', id: flowId };
  const owner = nodeColoring(model, 'owner');
  const metricChoice = colorByOptions(model).find((choice) => choice.group === 'metric');
  const metric = metricChoice ? nodeColoring(model, metricChoice.value) : undefined;

  const canvases = new Map<string, Canvas>();
  const kit = async (
    id: string,
    view: Parameters<MapFixture['flow']>[0],
    change: (drawn: {
      layout: LayoutResult;
      flow: FlowGraph;
    }) => Partial<Canvas> & { flow?: FlowGraph },
  ): Promise<void> => {
    const drawn = await specimen.flow(view);
    const extra = change(drawn);
    const flow = extra.flow ?? drawn.flow;
    canvases.set(id, {
      layout: drawn.layout,
      size: KIT_CANVAS,
      view: fit(drawn.flow, KIT_CANVAS),
      level: view.lod,
      storyMode: view.mode,
      collapsedCount: view.collapsed?.length ?? 0,
      ...extra,
      flow,
    });
  };
  const closed = [group.id];
  const everything = { mode: 'stories' as const, lod: 'detail' as const, collapsed: closed };
  await kit('map-plain', everything, () => ({ handles: true }));
  await kit('map-selected-node', everything, ({ flow }) => ({
    flow: highlightFlow(flow, { type: 'node', id: leaf.id }),
  }));
  await kit('map-selected-edge', everything, ({ flow }) => ({
    flow: highlightFlow(flow, { type: 'edge', id: edge.id }),
  }));
  await kit('map-selected-workitem', { mode: 'tasks', lod: 'detail' }, () => ({
    workItemCanvas: { selectedId: task.id, parentId: story.id, select: noop },
  }));
  await kit('map-focus', everything, ({ flow }) => {
    const set = focusSet(model, focus, specimen.overlay);
    if (!set) throw new Error('The focus names nothing');
    return { flow: focusFlow(model, flow, set) };
  });
  await kit('map-lenses', { mode: 'stories', lod: 'detail' }, ({ flow }) => ({
    lenses: lensesOf(model, specimen, flow, owner),
  }));
  await kit('map-domains', { mode: 'stories', lod: 'domains', lines: true }, () => ({}));
  await kit(
    'map-shrunk',
    { mode: 'stories', lod: 'components', collapsed: closed, compact: true },
    () => ({
      shrunk: true,
    }),
  );
  await kit('map-on-demand', everything, ({ flow }) => ({
    flow: quietEdges(flow, new Set([leaf.id]), undefined),
  }));
  await kit('map-unlocked', { ...everything, draggable: true }, () => ({ unlocked: true }));

  // The screens draw the example in the canvas the frame leaves: the level is the one Auto gives
  // at the zoom of the fit, found by fitting the Everything flow first.
  const mapSize = {
    width: SCREEN.width - RAIL_WIDTH - BODY_WIDTH,
    height: SCREEN.height - DIAGNOSTICS_BAR,
  };
  const exampleEverything = await example.flow({ mode: 'stories', lod: 'detail' });
  // The level and the view belong together: the level is the one Auto gives at the zoom of the
  // fit of the flow drawn at that level — found by fitting the Everything flow first, then the
  // flow of each level the zoom names, until the two agree.
  let autoLevel = lodForZoom(fit(exampleEverything.flow, mapSize).zoom);
  let autoDrawn = await example.flow({ mode: 'stories', lod: autoLevel });
  let autoView = fit(autoDrawn.flow, mapSize);
  for (let step = 0; step < 4 && lodForZoom(autoView.zoom) !== autoLevel; step += 1) {
    autoLevel = lodForZoom(autoView.zoom);
    autoDrawn = await example.flow({ mode: 'stories', lod: autoLevel });
    autoView = fit(autoDrawn.flow, mapSize);
  }
  if (lodForZoom(autoView.zoom) !== autoLevel) {
    throw new Error(
      `The fitted zoom ${String(autoView.zoom)} does not give the level ${autoLevel}`,
    );
  }
  canvases.set('screen-map', {
    ...autoDrawn,
    size: mapSize,
    view: autoView,
    level: autoLevel,
    storyMode: 'stories',
  });
  canvases.set('screen-everything', {
    ...exampleEverything,
    size: mapSize,
    view: fit(exampleEverything.flow, mapSize),
    level: 'detail',
    storyMode: 'stories',
  });
  const exampleNodes = [...example.model.nodes.values()];
  const exampleComponent = first(
    exampleNodes.filter((node) => node.level === 1),
    'component',
  );
  const exampleFlow = first(example.model.flows, 'flow');
  const selectedSize = { width: mapSize.width - DETAIL_PANEL_WIDTH, height: mapSize.height };
  const components = await example.flow({ mode: 'stories', lod: 'components' });
  const exampleSet = focusSet(example.model, { type: 'flow', id: exampleFlow.id }, example.overlay);
  const exampleOwner = nodeColoring(example.model, 'owner');
  canvases.set('screen-selected', {
    layout: components.layout,
    flow: highlightFlow(
      exampleSet ? focusFlow(example.model, components.flow, exampleSet) : components.flow,
      { type: 'node', id: exampleComponent.id },
    ),
    size: selectedSize,
    view: fit(components.flow, selectedSize),
    level: 'components',
    storyMode: 'stories',
    lenses: lensesOf(example.model, example, components.flow, exampleOwner),
  });

  const exampleColorChoices = colorByOptions(example.model);
  const presetChoice = exampleColorChoices.find(
    (choice) => choice.group === 'preset' && choice.description !== undefined,
  );
  const preset = presetChoice ? nodeColoring(example.model, presetChoice.value) : undefined;
  const aggregate = canvases
    .get('map-domains')
    ?.flow.edges.find((candidate) => candidate.data.count > 1)?.id;

  const kindCounts = Object.fromEntries(
    EDGE_KINDS.map((kind) => [
      kind,
      model.edges.filter((candidate) => candidate.kind === kind).length,
    ]),
  ) as Record<EdgeKind, number>;

  return {
    specimen,
    example,
    canvases,
    owner,
    metric,
    colorChoices: colorByOptions(model),
    exampleColorChoices,
    preset,
    hints: authoringHints(model, specimen.overlay),
    kindCounts,
    ids: {
      group: group.id,
      leaf: leaf.id,
      edge: edge.id,
      story: story.id,
      task: task.id,
      flow: flowId,
      aggregate,
    },
    focus,
    exampleIds: { component: exampleComponent.id, flow: exampleFlow.id },
  };
}
