import { ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  availableIterations,
  availableStates,
  allResizeLimits,
  appliedGrowth,
  applyHandOverrides,
  arrangedLayout,
  arrangedSourceNodes,
  buildFlow,
  buildWorkItemOverlay,
  drawnNodeRects,
  closedGroupSize,
  computeLayout,
  CONTROL_PANEL_DOCK_WIDTH,
  CONTROL_TABS,
  controlPanelCollapsed,
  movedByHand,
  NO_HAND_OVERRIDES,
  readControlPanel,
  readHandOverrides,
  resizedByHand,
  shownControlTab,
  sizeResetByHand,
  withoutRows,
  writeControlPanel,
  writeHandOverrides,
  type ControlPanelState,
  type ControlTab,
  type EdgeGrowth,
  type HandOverrides,
  type Position,
  EDGE_KINDS,
  effectiveLod,
  expandToOpen,
  expandToReveal,
  fitAmongLevels,
  groupIds,
  highlightFlow,
  LOD_LEVELS,
  lodForZoom,
  lodModeToDraw,
  miniMapNodes,
  lodRevealZoom,
  minLodForNode,
  parseArchitecture,
  recentMapHint,
  recentMapLabel,
  withRecentMap,
  withoutRecentMap,
  withRecentWorkItems,
  type RecentMap,
  plural,
  readCollapsed,
  readDisplaySettings,
  readHiddenKinds,
  readViewport,
  readViewportPlace,
  renderedSelection,
  resolveSelection,
  revealZoomForNodes,
  sameSelection,
  toggleEdgeKind,
  unionRect,
  usableWorkItemFilter,
  viewportKeepingPlace,
  viewportToReveal,
  visibleNodes,
  visibleRects,
  withoutEdgeKinds,
  workItemContent,
  workItemDiagnostics,
  workItemLineRect,
  workItemLines,
  workItemLinesRect,
  workItemPlace,
  workItemTagReport,
  writeCollapsed,
  writeDisplaySettings,
  writeHiddenKinds,
  writeViewport,
  type ArchitectureModel,
  type ArrangeView,
  type DisplaySettings,
  type EdgeKind,
  type FlowGraph,
  type FlowResize,
  type FlowWorkItems,
  type LayoutResult,
  type LodLevel,
  type LodMode,
  type NodeContent,
  type Rect,
  type Selection,
  type Size,
  type StoryMode,
  type Viewport,
  type WorkItemOverlay,
  type WorkItemSummary,
  authoringHints,
  centerToViewport,
  colorByOptions,
  filterToFocus,
  focusFlow,
  focusMoveTiming,
  focusSet,
  goToTiming,
  heatByWork,
  heatOfDrawn,
  heldRects,
  modelShows,
  nodeColoring,
  progressByNode,
  progressOfDrawn,
  boxesAsked,
  onDemandIndex,
  quietEdges,
  revealEdges,
  readSavedViews,
  rowPlacement,
  sameFocus,
  TEMPLATE_NOTE,
  usableColorBy,
  viewColorBy,
  viewFromLinkHash,
  viewLinkHash,
  viewportToCenter,
  withoutSavedView,
  withPlacedRows,
  withSavedView,
  writeSavedViews,
  type Focus,
  type FocusMode,
  type RowPlacement,
  type SavedView,
  type ViewCenter,
} from '../core';
import {
  browserRecentStore,
  droppedHandles,
  openRecentMap,
  pickFiles,
  rememberMap,
  type DataFile,
  type DroppedItem,
  type FileHandleLike,
  type FilePickerHost,
  type PickKind,
} from '../providers/recentFiles';
import {
  browserLoaderEnv,
  loadInitialStructure,
  readStructureFile,
  type StructureSource,
} from '../providers/structureSource';
import {
  browserWorkItemEnv,
  isWorkItemFileName,
  loadInitialWorkItems,
  mockWorkItemProvider,
  readWorkItemFile,
  type WorkItemLoad,
} from '../providers/workItemSource';
import { afterNextPaint } from './afterNextPaint';
import { browserStorage } from './browserStorage';
import { canvasIsUp, whenCanvasReady } from './canvasReady';
import { ColorLegend } from './ColorLegend';
import { DETAIL_PANEL_WIDTH, fitOptions, fitRoom, fittedViewport, fitWithRoom } from './constants';
import { ControlPanel, type ControlTabMarks } from './ControlPanel';
import { coveredCanvasLeft } from './coveredCanvas';
import { DetailPanel } from './DetailPanel';
import { DetailTab } from './DetailTab';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { EdgeLegend } from './EdgeLegend';
import { ErrorBoundary } from './ErrorBoundary';
import { FilesTab } from './FilesTab';
import { FilterContext, type FilteredMap } from './filterContext';
import { FocusBar } from './FocusBar';
import { LayoutTab } from './LayoutTab';
import { LensesTab } from './LensesTab';
import { MapCanvas } from './MapCanvas';
import type { NodeLenses } from './nodeLensContext';
import { PanelIcon } from './PanelIcons';
import { RecentList } from './RecentList';
import { SearchBox, type SearchOutside } from './SearchBox';
import { useLevelAtRest, useLodLevel } from './useLodLevel';
import { APP_VERSION } from './version';
import { ViewsTab } from './ViewsTab';
import { VisibilityTab, type WorkItemFilterChoices } from './VisibilityTab';
import type { WorkItemCanvas } from './workItemContext';
import '@xyflow/react/dist/style.css';
import './styles.css';

type LoadState =
  | { readonly status: 'loading' }
  /** `loadId` distinguishes successive loads, even of identical text. */
  | { readonly status: 'ready'; readonly source: StructureSource; readonly loadId: number }
  | { readonly status: 'empty'; readonly reason: string };

/** A map opened from disk before, with the browser's references to its files. */
type RememberedMap = RecentMap<FileHandleLike<File>>;

/** `loadId` distinguishes successive loads, like the structure's. */
type WorkItemState =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly load: WorkItemLoad; readonly loadId: number };

/**
 * The work items as laid over one model: what the layout reserved room for (`content`) and what
 * the canvas then draws in it. Kept together with the layout computed from it, so the two never
 * disagree while a new layout is on its way.
 */
interface WorkItemView {
  readonly overlay: WorkItemOverlay;
  readonly mode: StoryMode;
  readonly content: ReadonlyMap<string, NodeContent>;
  /** Whether `content` has the room of the lists (the Everything level), or none. */
  readonly lines: boolean;
}

/** What a layout is computed for and the canvas draws: the whole model or what a focus involves. */
interface DrawnModel {
  readonly model: ArchitectureModel;
  /** The focus the model is reduced to; absent for the whole model. */
  readonly filteredTo?: Focus;
  /** `Submodel.placedRow` of the reduced model. */
  readonly placedRow?: ReadonlyMap<string, string>;
}

type LayoutState =
  | {
      /** The whole model: everything but the drawing is about it. `drawn` is what is laid out. */
      readonly model: ArchitectureModel;
      readonly workItems: WorkItemView;
      readonly drawn: DrawnModel;
      readonly layout: LayoutResult;
      /**
       * Where the view starts on this layout when it replaces another one of the same model: the
       * place the user was looking at (`viewportKeepingPlace`), where the whole map was before it
       * was filtered, or the place of a saved view.
       */
      readonly startViewport?: Viewport;
      /** The view starts fitted instead: a map reduced to another focus than the one before. */
      readonly startFitted?: true;
      readonly error?: undefined;
    }
  | {
      readonly model: ArchitectureModel;
      readonly workItems: WorkItemView;
      readonly drawn: DrawnModel;
      readonly layout?: undefined;
      readonly startViewport?: undefined;
      readonly startFitted?: undefined;
      readonly error: string;
    };

/** The collapsed set as changed by the user, for the model it belongs to. */
interface CollapsedEdit {
  readonly model: ArchitectureModel;
  readonly ids: ReadonlySet<string>;
  /**
   * The group opened or closed on the canvas (its chevron, or a double-click): it keeps its place
   * on the screen.
   */
  readonly anchor?: string;
}

/** The hidden edge kinds as changed by the user, for the model they belong to. */
interface HiddenKindsEdit {
  readonly model: ArchitectureModel;
  readonly kinds: ReadonlySet<EdgeKind>;
}

/** The selection, for the model it belongs to (a newly loaded file starts with none). */
interface SelectionEdit {
  readonly model: ArchitectureModel;
  readonly selection: Selection | undefined;
}

type FlowState =
  | { readonly flow: FlowGraph; readonly error?: undefined }
  | { readonly flow?: undefined; readonly error: string };

/** A move of the view still to be worked out on the layout that will be on screen. */
interface PendingMove {
  /** Where to go on `layout`, and how; undefined: nowhere. */
  readonly move: (
    layout: LayoutResult,
  ) => { readonly to: Viewport; readonly duration: number; readonly fit?: true } | undefined;
  /** 2: worked out once more at most — on the arrangement of the level it ends on. */
  readonly pass: 1 | 2;
  /** A fit of the map: the level of detail is not judged until it is made. */
  readonly fit?: true;
}

const NOTHING_COLLAPSED: ReadonlySet<string> = new Set();
const NO_IDS: ReadonlySet<string> = new Set();
const NO_KINDS_HIDDEN: ReadonlySet<EdgeKind> = new Set();
const NO_WORK_ITEMS: readonly WorkItemSummary[] = [];
const NO_PLACED_ROWS: ReadonlyMap<string, string> = new Map();
/** The rows of the nodes while the map is not arranged in rows: none. */
const NO_ROW_PLACEMENT: RowPlacement = { placedRow: new Map(), rowOf: new Map() };

/** The tabs of the control panel that can be chosen while no structure is loaded. */
const FILES_ONLY: readonly ControlTab[] = ['files'];

/**
 * The level being drawn, as the Detail tab says it on the rail of the control panel: in short
 * on the tab, by its name in the tooltip.
 */
const LOD_MARKS: Readonly<Record<LodLevel, { readonly text: string; readonly name: string }>> = {
  domains: { text: 'Dom', name: 'Domains' },
  components: { text: 'Comp', name: 'Components' },
  subcomponents: { text: 'Sub', name: 'Subcomponents' },
  detail: { text: 'All', name: 'Everything' },
};

/** Duration of the animated move that brings a search result or an edge on screen. */
const REVEAL_DURATION_MS = 300;
/**
 * How long the zoom-driven level must have been on one side of the Everything level before the
 * map is laid out for it: longer than an animated move, whose flight zooms out on the way and
 * would otherwise lay the map out (and cut the move short) in mid-air.
 */
const LINES_SETTLE_MS = REVEAL_DURATION_MS + 200;

/** True when keystrokes in `target` are text input, so single-key shortcuts must not fire. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What of the map `model` closes up around (`arrangedLayout`): the `visible` nodes, closed groups
 * drawn shrunk — with the line of their badge when `workItems` give them one —, and the content
 * blocks the layout was computed with.
 */
function arrangeView(
  model: ArchitectureModel,
  workItems: WorkItemView | undefined,
  visible: ReadonlySet<string>,
): ArrangeView {
  const drawnItems: FlowWorkItems | undefined = workItems
    ? { overlay: workItems.overlay, mode: workItems.mode }
    : undefined;
  return {
    visible,
    closedSize: (node, full) =>
      closedGroupSize(model, node, full, {
        compactCollapsed: true,
        ...(drawnItems ? { workItems: drawnItems } : {}),
      }),
    content: workItems?.content,
  };
}

/**
 * The absolute rectangles of the model nodes as `flow` draws them: a closed group that spans
 * rows is drawn shrunk in the middle of its column, which is its box in the layout.
 */
function drawnRects(flow: FlowGraph): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  for (const node of miniMapNodes(flow.nodes))
    if (node.type !== 'band') rects.set(node.id, node.rect);
  return rects;
}

/** True when two viewports show the same: within a pixel and a thousandth of the zoom. */
function sameView(a: Viewport, b: Viewport): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 0.001;
}

/** What a node, an edge or a work item is called in a notice: as its panel is headed. */
function targetName(
  model: ArchitectureModel,
  target: Selection,
  overlay: WorkItemOverlay | undefined,
): string {
  switch (target.type) {
    case 'node':
      return model.nodes.get(target.id)?.name ?? target.id;
    case 'edge':
      return model.edges.find((edge) => edge.id === target.id)?.label ?? target.id;
    case 'workitem': {
      const item = overlay?.byId.get(target.id);
      return item ? `#${item.id} ${item.title}` : `#${target.id}`;
    }
    default:
      return target.id;
  }
}

/** Which of the two content files a picked or dropped file is. */
type ContentKind = 'structure' | 'workitems';

/** What a file is: as said, else by its name — a `.json` file is work items, the rest structure. */
function contentKind(name: string, kind?: ContentKind): ContentKind {
  return kind ?? (isWorkItemFileName(name) ? 'workitems' : 'structure');
}

let recentIds = 0;
/** A new ID for a remembered map: unique in this browser for all practical purposes. */
function newRecentId(): string {
  return `${Date.now().toString(36)}-${(recentIds += 1)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Largest file the picker and drag-and-drop take: far above any real structure or export. */
const MAX_DATA_FILE_BYTES = 50 * 2 ** 20;

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

export function App() {
  return (
    <ErrorBoundary>
      <ReactFlowProvider>
        <Viewer />
      </ReactFlowProvider>
    </ErrorBoundary>
  );
}

function Viewer() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [fileError, setFileError] = useState<string>();
  // The maps opened from disk before: the browser's references to their files,
  // so that a map is opened again with a click. `currentRecent` is the one that is shown now.
  const recentStore = useMemo(() => browserRecentStore(), []);
  const [recents, setRecents] = useState<readonly RememberedMap[]>([]);
  const [currentRecent, setCurrentRecent] = useState<string>();
  const recentsRef = useRef<readonly RememberedMap[]>([]);
  const currentRecentRef = useRef<string | undefined>(undefined);
  // Changes to the list happen one after the other, the first being the read of what is stored.
  const recentQueue = useRef<Promise<void>>(Promise.resolve());
  const [dragging, setDragging] = useState(false);
  const [work, setWork] = useState<WorkItemState>({ status: 'loading' });
  const [layoutState, setLayoutState] = useState<LayoutState>();
  const [collapsedEdit, setCollapsedEdit] = useState<CollapsedEdit>();
  const [hiddenKindsEdit, setHiddenKindsEdit] = useState<HiddenKindsEdit>();
  const [selectionEdit, setSelectionEdit] = useState<SelectionEdit>();
  // The focus: per model, like the selection; not remembered (a saved view is).
  const [focusEdit, setFocusEdit] = useState<{
    readonly model: ArchitectureModel;
    readonly focus: Focus | undefined;
  }>();
  // The model node under the pointer, tracked only while edges are shown on demand.
  const [hoveredNode, setHoveredNode] = useState<string>();
  const [savedViewsEdit, setSavedViewsEdit] = useState<{
    readonly model: ArchitectureModel;
    readonly views: readonly SavedView[];
  }>();
  const loadCounter = useRef(0);
  const workCounter = useRef(0);
  // The files opened by hand so far, per kind (see `openFile`).
  const structureOpened = useRef(0);
  const workItemsOpened = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const workItemInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const { fitView, getViewport, setViewport } = useReactFlow();
  const flowStore = useStoreApi();
  // Changes (and re-renders this component) only when the zoom moves to another level of detail.
  // Display settings (thresholds of the automatic level of detail, shrunk collapsed groups):
  // one set for the viewer, kept in the browser.
  const [settings, setSettings] = useState<DisplaySettings>(() =>
    readDisplaySettings(browserStorage()),
  );
  // The settings as changed last: what a callback made in an earlier render changes one of.
  const settingsNow = useRef(settings);
  const changeSettings = useCallback((next: DisplaySettings) => {
    settingsNow.current = next;
    setSettings(next);
    writeDisplaySettings(browserStorage(), next);
  }, []);
  /** Focus / Filter: how a focus is shown. Every other setting stays as it is now. */
  const setFocusMode = useCallback(
    (mode: FocusMode) => {
      const now = settingsNow.current;
      if (now.focusMode !== mode) changeSettings({ ...now, focusMode: mode });
    },
    [changeSettings],
  );
  const lodConfig = settings.lod;
  // Moves of the view started by the viewer (see `moveOnArrangement`). A fit among them — asked
  // for, or under way — is judged like a fit of the canvas itself: the level of detail holds
  // until the view is there, and is then the one the plain thresholds give for it.
  const [pendingMove, setPendingMove] = useState<PendingMove>();
  const [fitMoving, setFitMoving] = useState<number>();
  const fitting = pendingMove?.fit === true || fitMoving !== undefined;
  const zoomLod = useLodLevel(lodConfig, fitting);
  // 'auto' follows the zoom; any other mode pins that level whatever the zoom.
  const [lodMode, setLodMode] = useState<LodMode>('auto');
  const lodLevel = effectiveLod(lodMode, zoomLod);
  // The level that is drawn. With the map closed up, Auto draws the level of the zoom once the
  // view has come to rest: another level is another arrangement, whose place can only be kept
  // between gestures (in the middle of one the gesture would put the view back).
  const [arrangedLevel, setArrangedLevel] = useLevelAtRest(zoomLod, fitting);
  const drawnLevel = settings.closeGaps && lodMode === 'auto' ? arrangedLevel : lodLevel;

  /** Queues a change to the list of recent maps; resolves when it is done. Never rejects. */
  const queueRecent = useCallback((task: () => void | Promise<void>): Promise<void> => {
    const next = recentQueue.current.then(task).catch(() => undefined);
    recentQueue.current = next;
    return next;
  }, []);
  /** Makes `list` the list of recent maps (shown and stored) and `current` the map shown now. */
  const keepRecents = useCallback(
    (list: readonly RememberedMap[], current: string | undefined) => {
      const changed = list !== recentsRef.current;
      recentsRef.current = list;
      currentRecentRef.current = current;
      setRecents(list);
      setCurrentRecent(current);
      if (changed) void recentStore.write(list);
    },
    [recentStore],
  );
  // The stored list, read once. Declared before the loader below, which waits for it.
  useEffect(() => {
    void queueRecent(async () => {
      const stored = await recentStore.read();
      recentsRef.current = stored;
      setRecents(stored);
    });
  }, [queueRecent, recentStore]);

  /**
   * Reads `file` and shows it: as the work items when it is a `.json` file (or `kind` says so),
   * else as the structure. Resolves to its text once it is shown, and to undefined when it is
   * not — too large, unreadable, or another file of its kind was opened meanwhile.
   */
  const showFile = useCallback(
    async (file: DataFile | undefined, kind?: ContentKind): Promise<string | undefined> => {
      if (!file) return undefined;
      // The file is read and parsed in one piece on the main thread: something far too large to
      // be a data file (a video dropped by mistake) would only freeze the page.
      if (file.size > MAX_DATA_FILE_BYTES) {
        setFileError(
          `${file.name} is too large to be a data file (${Math.round(file.size / 2 ** 20)} MB; the limit is ${MAX_DATA_FILE_BYTES / 2 ** 20} MB).`,
        );
        return undefined;
      }
      // Reading takes time, and a small file is read sooner than a large one opened before it:
      // only the file opened last (of its kind) is taken.
      const isWorkItems = contentKind(file.name, kind) === 'workitems';
      const opened = isWorkItems ? workItemsOpened : structureOpened;
      const request = ++opened.current;
      if (isWorkItems) {
        const provider = mockWorkItemProvider(async () => ({
          source: await readWorkItemFile(file),
        }));
        const loaded = await provider.load();
        if (request !== opened.current) return undefined;
        setFileError(
          loaded.source
            ? undefined
            : `Could not read ${file.name} (${loaded.reason ?? 'unknown'}).`,
        );
        if (!loaded.source) return undefined;
        setWork({ status: 'done', load: loaded, loadId: ++workCounter.current });
        return loaded.source.text;
      }
      try {
        const source = await readStructureFile(file);
        if (request !== opened.current) return undefined;
        setFileError(undefined);
        setLoad({ status: 'ready', source, loadId: ++loadCounter.current });
        return source.text;
      } catch (err) {
        if (request === opened.current) {
          setFileError(`Could not read ${file.name} (${errorMessage(err)}).`);
        }
        return undefined;
      }
    },
    [],
  );

  /**
   * Opens a remembered map again, read fresh from the disk: its structure and the work items it
   * was last opened with. `ask` lets the browser ask the user for permission, which it only does
   * while a click is being handled; without it a map that needs asking is left alone. Resolves
   * to whether the map was opened.
   */
  const openRecent = useCallback(
    async (entry: RememberedMap, ask: boolean): Promise<boolean> => {
      const result = await openRecentMap(entry, ask);
      if (result.status !== 'opened') {
        if (result.status === 'failed') setFileError(result.reason);
        else if (ask) {
          setFileError(
            `${recentMapLabel(entry)} was not opened: the browser needs your permission to read it again.`,
          );
        }
        return false;
      }
      const [text] = await Promise.all([
        showFile(result.structure, 'structure'),
        result.workItems ? showFile(result.workItems, 'workitems') : undefined,
      ]);
      if (text === undefined) return false;
      if (!result.workItems) {
        // The map is shown as it was remembered: without work items, not with those of the map
        // shown before. A work-items file still being read belongs to that other map.
        workItemsOpened.current += 1;
        setWork({
          status: 'done',
          load: {
            reason:
              result.workItemsProblem ??
              `${entry.structure.name} was last opened without work items.`,
            items: [],
            errors: [],
            warnings: [],
          },
          loadId: ++workCounter.current,
        });
        if (result.workItemsProblem !== undefined) setFileError(result.workItemsProblem);
      }
      await queueRecent(() => {
        const known = recentsRef.current.find((other) => other.id === entry.id) ?? entry;
        const hint = recentMapHint(parseArchitecture(text).model ?? undefined);
        keepRecents(
          withRecentMap(recentsRef.current, { ...known, hint, openedAt: Date.now() }),
          entry.id,
        );
      });
      return true;
    },
    [keepRecents, queueRecent, showFile],
  );

  // The map the page finds by itself (only while nothing is loaded yet): the file next to it on
  // its server, else — opened from disk — the map opened last, when the browser lets it be read
  // without asking. Otherwise the start page, with the recent maps to click.
  useEffect(() => {
    if (load.status !== 'loading') return;
    let cancelled = false;
    void (async () => {
      const result = await loadInitialStructure(browserLoaderEnv());
      if (cancelled) return;
      if (result.source) {
        setLoad({ status: 'ready', source: result.source, loadId: ++loadCounter.current });
        return;
      }
      if (result.local === true) {
        await recentQueue.current;
        const [latest] = recentsRef.current;
        if (cancelled) return;
        if (latest && (await openRecent(latest, false))) return;
        if (cancelled) return;
      }
      setLoad((previous) =>
        previous.status === 'loading' ? { status: 'empty', reason: result.reason } : previous,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [load.status, openRecent]);

  // Work items: the data file next to the viewer, through the mock provider. A map
  // without any is normal, so finding none is not an error. A file opened meanwhile wins. The
  // loader gives up after a few seconds, so a server that does not answer cannot hold the map back.
  useEffect(() => {
    let cancelled = false;
    const provider = mockWorkItemProvider(() => loadInitialWorkItems(browserWorkItemEnv()));
    void provider.load().then((loaded) => {
      if (cancelled) return;
      setWork((previous) =>
        previous.status === 'loading'
          ? { status: 'done', load: loaded, loadId: ++workCounter.current }
          : previous,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Picker and drag-and-drop, available at all times to replace the loaded file. A `.json` file
  // is the work items, anything else the structure.
  //
  // A file that comes without a reference to remember: from a file input, or from a browser
  // that gives none. A structure opened like this is not one of the recent maps.
  const openFile = useCallback(
    (file: DataFile | undefined, kind?: ContentKind) => {
      void showFile(file, kind).then((text) => {
        if (text === undefined || !file || contentKind(file.name, kind) === 'workitems') return;
        void queueRecent(() => keepRecents(recentsRef.current, undefined));
      });
    },
    [keepRecents, queueRecent, showFile],
  );

  /**
   * Files that come with references — from the browser's file dialog, or dropped in Edge or
   * Chrome: shown, then remembered. One of each kind is taken. A structure makes (or brings
   * back) an entry of the recent maps; work items opened on their own join the map shown.
   */
  const openHandles = useCallback(
    async (handles: readonly FileHandleLike<File>[], kind?: ContentKind) => {
      const read = await Promise.all(
        handles.map(async (handle) => {
          try {
            return { handle, file: await handle.getFile() };
          } catch (err) {
            setFileError(`Could not read ${handle.name} (${errorMessage(err)}).`);
            return undefined;
          }
        }),
      );
      const files = read.filter((entry) => entry !== undefined);
      const structure = files.find((entry) => contentKind(entry.file.name, kind) === 'structure');
      const workItems = files.find((entry) => contentKind(entry.file.name, kind) === 'workitems');
      const [structureText, workItemsText] = await Promise.all([
        showFile(structure?.file, 'structure'),
        showFile(workItems?.file, 'workitems'),
      ]);
      const shownStructure =
        structure && structureText !== undefined
          ? { name: structure.file.name, handle: structure.handle }
          : undefined;
      const shownWorkItems =
        workItems && workItemsText !== undefined
          ? { name: workItems.file.name, handle: workItems.handle }
          : undefined;
      await queueRecent(async () => {
        if (shownStructure) {
          const remembered = await rememberMap(
            recentsRef.current,
            {
              structure: shownStructure,
              ...(shownWorkItems ? { workItems: shownWorkItems } : {}),
              hint: recentMapHint(parseArchitecture(structureText ?? '').model ?? undefined),
            },
            Date.now(),
            newRecentId,
          );
          keepRecents(remembered.list, remembered.entry.id);
        } else if (shownWorkItems && currentRecentRef.current !== undefined) {
          keepRecents(
            withRecentWorkItems(recentsRef.current, currentRecentRef.current, shownWorkItems),
            currentRecentRef.current,
          );
        }
      });
    },
    [keepRecents, queueRecent, showFile],
  );

  /**
   * The Open buttons: the browser's own file dialog where there is one, since what it gives can
   * be remembered; else the plain file input. For a map, the structure and its work items may be
   * chosen together.
   */
  const pick = useCallback(
    (kind: PickKind) => {
      void pickFiles(window as unknown as FilePickerHost<File>, kind).then((handles) => {
        if (handles === undefined) {
          (kind === 'map' ? fileInput : workItemInput).current?.click();
        } else if (handles.length > 0) {
          void openHandles(handles, kind === 'workitems' ? 'workitems' : undefined);
        }
      });
    },
    [openHandles],
  );

  const openRecentById = useCallback(
    (id: string) => {
      const entry = recentsRef.current.find((other) => other.id === id);
      if (entry) void openRecent(entry, true);
    },
    [openRecent],
  );
  const forgetRecent = useCallback(
    (id: string) => {
      void queueRecent(() =>
        keepRecents(
          withoutRecentMap(recentsRef.current, id),
          currentRecentRef.current === id ? undefined : currentRecentRef.current,
        ),
      );
    },
    [keepRecents, queueRecent],
  );

  const onPick = (kind: ContentKind) => (event: ChangeEvent<HTMLInputElement>) => {
    openFile(event.target.files?.[0], kind);
    event.target.value = ''; // picking the same file again must fire `change`
  };

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      // A structure file and its work items may be dropped together: one of each kind is taken.
      // References to the files (to remember them) have to be asked for now, while the drop is
      // being handled; where the browser gives none, the files are read as they are.
      const files = [...(event.dataTransfer?.files ?? [])];
      const items = [...(event.dataTransfer?.items ?? [])] as unknown as DroppedItem<File>[];
      void droppedHandles(items).then((handles) => {
        if (handles) {
          void openHandles(handles);
          return;
        }
        openFile(files.find((file) => !isWorkItemFileName(file.name)));
        openFile(files.find((file) => isWorkItemFileName(file.name)));
      });
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [openFile, openHandles]);

  const source = load.status === 'ready' ? load.source : undefined;
  const loadId = load.status === 'ready' ? load.loadId : -1;
  // The recent map that is shown now, while it is shown: what Reload reads again.
  const currentEntry = source ? recents.find((entry) => entry.id === currentRecent) : undefined;
  const parsed = useMemo(
    () =>
      source ? parseArchitecture(source.text, { sourceName: source.diagnosticsName }) : undefined,
    [source],
  );
  const model = parsed?.model ?? undefined;

  // The control panel: the tab shown and whether the body is collapsed to the rail — one choice
  // for the viewer, kept in the browser. Until the user has chosen, the body is open while the
  // window is wide enough for it to stand beside the canvas, and collapsed while it would lie
  // over the canvas: the width is read again whenever the window crosses that mark.
  const [panel, setPanel] = useState(() => readControlPanel(browserStorage()));
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const dock = window.matchMedia(`(min-width: ${CONTROL_PANEL_DOCK_WIDTH}px)`);
    const onChange = () => setWindowWidth(window.innerWidth);
    dock.addEventListener('change', onChange);
    return () => dock.removeEventListener('change', onChange);
  }, []);
  const panelCollapsed = controlPanelCollapsed(panel, windowWidth);
  const panelTab = shownControlTab(panel.tab, model !== undefined);
  // Collapsed, the search box is shown beside the rail while it is in use.
  const [searchOpen, setSearchOpen] = useState(false);
  // What had the cursor when the box was shown there: it gets the cursor back when the search
  // is left by a key, since the box goes then.
  const beforeSearch = useRef<Element | null>(null);
  const changePanel = (next: { readonly tab: ControlTab; readonly collapsed: boolean }) => {
    // Without a structure the panel shows Files whatever was chosen, and the chosen tab is kept.
    const state: ControlPanelState = {
      tab: model ? next.tab : panel.tab,
      collapsed: next.collapsed,
    };
    setPanel(state);
    writeControlPanel(browserStorage(), state);
    if (!next.collapsed) setSearchOpen(false);
  };
  /**
   * Puts the cursor in the search box, showing the box first when the body of the panel is
   * collapsed. Returns whether there is a search box.
   */
  const focusSearch = useCallback((): boolean => {
    const input = searchInput.current;
    if (!input) return false;
    if (panelCollapsed) {
      if (document.activeElement !== input) beforeSearch.current = document.activeElement;
      // Rendered at once: the box has to be on screen to take the focus.
      flushSync(() => setSearchOpen(true));
    }
    input.focus();
    input.select();
    return true;
  }, [panelCollapsed, setSearchOpen]);
  /**
   * The search was left by a key. With the body of the panel collapsed the box is no longer on
   * screen, so the cursor goes back to where it came from — to the Search button of the rail
   * when that was nowhere — and the Tab key goes on from there.
   */
  const leaveSearch = useCallback(() => {
    if (!panelCollapsed) return;
    const before = beforeSearch.current;
    beforeSearch.current = null;
    const back =
      before instanceof HTMLElement && before !== document.body && before.isConnected
        ? before
        : document.querySelector<HTMLElement>('#search-open');
    back?.focus();
  }, [panelCollapsed]);

  // The work items laid over the model: filtered, mapped onto the nodes, and sized
  // for the chosen story mode. Waits for the work items, so the map is laid out once.
  const workLoad = work.status === 'done' ? work.load : undefined;
  const workItems = workLoad?.items ?? NO_WORK_ITEMS;
  const { storyMode, hiddenStates, iteration, showCompleted } = settings;
  const workFilter = useMemo(
    () => usableWorkItemFilter(workItems, hiddenStates, iteration, !showCompleted),
    [workItems, hiddenStates, iteration, showCompleted],
  );
  // Room for the lists is reserved only while they are drawn — at the Everything level. At the
  // coarser levels the boxes are as small as without work items (a badge needs no room), so
  // switching the story mode there changes nothing on screen. Reaching or leaving the Everything
  // level therefore lays the map out again, keeping the place in view. It is the level drawn
  // that counts: closed up in Auto, the lists come and go like every other level, once the view
  // rests.
  const linesWanted = drawnLevel === 'detail';
  const [linesDrawn, setLinesDrawn] = useState(linesWanted);
  // A map that is not drawn yet is laid out for the level it starts at: that of the view kept
  // in the browser for it, which is a place on that very layout.
  const [linesModel, setLinesModel] = useState<ArchitectureModel>();
  if (model !== linesModel) {
    setLinesModel(model);
    const stored = model ? readViewport(browserStorage(), model) : undefined;
    if (stored) {
      const level = effectiveLod(lodMode, lodForZoom(stored.zoom, undefined, lodConfig));
      setLinesDrawn(level === 'detail');
    }
  }
  /** Until when (performance.now()) an animated move of the view started by the app is under way. */
  const movingUntil = useRef(0);
  /** Where that move is going, or where a place kept on its way ended it. */
  const movingTo = useRef<Viewport>(undefined);
  /**
   * The place of a saved view that is still to be shown (see `applyView`). It waits for the map
   * of that view only: whatever the reader chooses next for the focus or its mode drops it.
   */
  const pendingCentre = useRef<{
    model: ArchitectureModel;
    center: ViewCenter;
    /** The view was saved on a map reduced to its focus: its place means nothing elsewhere. */
    filtered: boolean;
  }>(undefined);
  // Only once the map is drawn: until then the level is not that of its view.
  const laidOut = layoutState?.model === model && layoutState?.layout !== undefined;
  const levelAtRest = settings.closeGaps && lodMode === 'auto';
  useEffect(() => {
    if (linesWanted === linesDrawn || !laidOut) return;
    let timer: ReturnType<typeof setTimeout>;
    // Not while the app is moving the view: the move may well end on the other side again. Nor
    // while the place of a saved view waits for its map, which is laid out for the level of
    // that view: the level is judged again once the map is there.
    const settle = () => {
      const wait = movingUntil.current - performance.now();
      if (wait > 0) timer = setTimeout(settle, wait + 50);
      else if (pendingCentre.current) timer = setTimeout(settle, LINES_SETTLE_MS);
      else setLinesDrawn(linesWanted);
    };
    // A pinned level is the user's click: at once, like a level that waited for the view to
    // rest already. Else the zoom has to come to rest first.
    timer = setTimeout(settle, lodMode === 'auto' && !levelAtRest ? LINES_SETTLE_MS : 0);
    return () => clearTimeout(timer);
  }, [linesWanted, linesDrawn, lodMode, levelAtRest, laidOut]);
  // One overlay, over the whole model, whatever of the map is drawn.
  const wantedOverlay = useMemo(
    () =>
      model && work.status === 'done'
        ? buildWorkItemOverlay(model, workItems, workFilter)
        : undefined,
    [model, work.status, workItems, workFilter],
  );
  const workItemView = useMemo(
    (): WorkItemView | undefined =>
      wantedOverlay
        ? {
            overlay: wantedOverlay,
            mode: storyMode,
            content: workItemContent(wantedOverlay, linesDrawn ? storyMode : 'off'),
            lines: linesDrawn,
          }
        : undefined,
    [wantedOverlay, storyMode, linesDrawn],
  );
  const filterChoices = useMemo(
    (): WorkItemFilterChoices | undefined =>
      workItemView
        ? {
            states: availableStates(workItems),
            iterations: availableIterations(workItems),
            shown: workItemView.overlay.shown.length,
            total: workItems.length,
          }
        : undefined,
    [workItems, workItemView],
  );

  // The focus: what a flow or a work item involves. In Filter mode the map is reduced to it: the
  // rest is not drawn, and what remains is laid out as a model of its own. Only laying out and
  // drawing see the reduced model; everything said about a box, and everything kept in the
  // browser, is about the whole one.
  const focus = focusEdit !== undefined && focusEdit.model === model ? focusEdit.focus : undefined;
  // What it involves, for the map that is drawn next: from the overlay the next layout is for
  // (the overlay on screen comes with its layout, which would then depend on itself), and only
  // for a work item — a flow involves the same whatever the work items are.
  const focusOverlay = focus?.type === 'workitem' ? wantedOverlay : undefined;
  const wantedFocused = useMemo(
    () => (model ? focusSet(model, focus, focusOverlay) : undefined),
    [model, focus, focusOverlay],
  );
  const wholePlacement = useMemo(() => (model ? rowPlacement(model) : undefined), [model]);
  // One object per model: choosing a focus that pales the rest lays nothing out.
  const whole = useMemo((): DrawnModel | undefined => (model ? { model } : undefined), [model]);
  const wantedDrawn = useMemo((): DrawnModel | undefined => {
    if (!model || settings.focusMode !== 'filter' || !focus || !wantedFocused) return whole;
    // Nothing to leave out, or nothing involved: the whole map stays, paled like in Focus mode.
    const filtered = filterToFocus(model, wantedFocused, wholePlacement);
    return filtered
      ? { model: filtered.model, filteredTo: focus, placedRow: filtered.placedRow }
      : whole;
  }, [model, whole, settings.focusMode, focus, wantedFocused, wholePlacement]);

  // Layout: once per drawn model and per work-item content (new data, another story mode or
  // filter, a map reduced to a focus: an explicit action), never on zoom or collapse — with Close
  // up the gaps on, the boxes of that one layout close up instead (`arrangedLayout`, below). When
  // it replaces another layout of the same model, the view keeps the place the user was looking at:
  // the node in the middle of the canvas stays there, at the same zoom. A map reduced to a focus
  // is fitted instead, and leaving it brings back the view the whole map had before.
  const shownLayout = useRef<{
    model: ArchitectureModel;
    /** As drawn: the reference, or that closed up, with the positions and sizes set by hand. */
    layout: LayoutResult;
    filteredTo: Focus | undefined;
    /** Key of the layout computed for the drawn model (`computeLayout`). */
    referenceKey: string;
    /** Key of the arrangement of it that is drawn (the reference's own when not closed up). */
    arrangedKey: string;
    /**
     * What the place is kept on: closed up, the rectangles of the boxes as they are drawn; else
     * every rectangle of the layout.
     */
    rects: ReadonlyMap<string, Rect>;
    /** The collapsed set it was drawn with. */
    collapsed: ReadonlySet<string>;
  }>(undefined);
  /** Where the whole map was when a filtered one replaced it. */
  const viewBeforeFilter = useRef<{
    model: ArchitectureModel;
    key: string;
    viewport: Viewport;
    absolute: ReadonlyMap<string, Rect>;
  }>(undefined);
  /**
   * The key and the rectangles of what will be drawn of a layout that arrives (`computed` for
   * `drawn` and `workItems`) at `zoom`, as the place is kept on (see `shownLayout`).
   */
  const arriving = useRef<
    (
      drawn: DrawnModel,
      computed: LayoutResult,
      workItems: WorkItemView,
      zoom: number,
    ) => { key: string; rects: ReadonlyMap<string, Rect> }
  >(() => ({ key: '', rects: new Map() }));
  /**
   * The layout that was fitted — a filtered one when it arrived, the whole map with Fit view —
   * and, once known, where that fit rested. `lines`, for the whole map: whether the lists were
   * laid out then.
   */
  const refit = useRef<{ key: string; viewport?: Viewport; lines?: boolean }>(undefined);
  const { showRows } = settings;
  useEffect(() => {
    if (!model || !workItemView || !wantedDrawn) return;
    let cancelled = false;
    const compute = async (): Promise<LayoutState> => {
      const wanted = { model, workItems: workItemView, drawn: wantedDrawn };
      // ELK runs on the main thread and takes seconds on a large model: show the status first.
      await afterNextPaint();
      if (cancelled) return { ...wanted, error: 'cancelled' };
      try {
        // Rows hidden: the same model without its rows, arranged by the connections alone.
        const computed = await computeLayout(
          showRows ? wantedDrawn.model : withoutRows(wantedDrawn.model),
          { content: workItemView.content },
        );
        return { ...wanted, layout: computed };
      } catch (err: unknown) {
        return { ...wanted, error: errorMessage(err) };
      }
    };
    void compute().then((state) => {
      if (cancelled) return;
      const previous = shownLayout.current;
      // A layout that failed takes no saved place.
      if (!state.layout) pendingCentre.current = undefined;
      // An error, or the canvas that is on screen already (only another key mounts a new one).
      if (
        !state.layout ||
        (previous?.model === model && previous.referenceKey === state.layout.key)
      ) {
        setLayoutState(state);
        return;
      }
      const computed = state.layout;
      const arrivingAt = (zoom: number) =>
        arriving.current(state.drawn, computed, state.workItems, zoom);
      /**
       * Where the view kept in the browser starts on this layout when it was taken on a map
       * drawn otherwise (another level of detail, closed up otherwise, with or without the
       * lists): at the place it showed. Nothing when it is a view of what is drawn now, which
       * the canvas takes as it is, or when there is none.
       */
      const storedStart = (): { startViewport?: Viewport } => {
        const stored = readViewport(browserStorage(), model);
        const place = stored ? readViewportPlace(browserStorage(), model) : undefined;
        if (!stored || !place) return {};
        const drawnNow = arrivingAt(stored.zoom);
        if (drawnNow.key === place.key) return {};
        const startViewport = viewportKeepingPlace(stored, place.size, place.rects, drawnNow.rects);
        return startViewport === stored ? {} : { startViewport };
      };
      // The first layout of the model: the whole map, at the view kept for it.
      if (previous?.model !== model) {
        setLayoutState(state.drawn.filteredTo ? state : { ...state, ...storedStart() });
        return;
      }
      const { width, height, panZoom, fitViewQueued } = flowStore.getState();
      const size = { width, height };
      // A move of the view that is still under way ends with the canvas it runs on. The new
      // canvas starts where the move was going, not at the point it happened to have reached
      // — a zoom towards the Everything level would stop short of it, and stay there.
      const moving = performance.now() < movingUntil.current ? movingTo.current : undefined;
      const now = moving ?? getViewport();
      const from = previous.filteredTo;
      const to = state.drawn.filteredTo;
      const centre = pendingCentre.current;
      // Where the whole map was when a filtered one replaces it, given back when Filter is left
      // — unless its canvas had not come to its own view yet.
      if (to && !from) {
        const settled = panZoom !== null && width > 0 && height > 0 && !fitViewQueued;
        viewBeforeFilter.current = settled
          ? { model, key: previous.arrangedKey, viewport: now, absolute: previous.rects }
          : undefined;
      }
      const before = from && !to ? viewBeforeFilter.current : undefined;
      if (!to) viewBeforeFilter.current = undefined;
      const fitted = refit.current;
      refit.current = undefined;
      let start: { startViewport?: Viewport; startFitted?: true };
      if (
        centre?.model === model &&
        width > 0 &&
        height > 0 &&
        centre.filtered === (to !== undefined)
      ) {
        // A saved view: its place, on the kind of map it was saved on. A place on the whole map
        // is none on a reduced one, nor the other way round.
        pendingCentre.current = undefined;
        start = { startViewport: centerToViewport(centre.center, size) };
      } else if (to && !sameFocus(from, to)) {
        // Filter entered, or another focus while filtering: the reduced map is another map.
        refit.current = { key: state.layout.key };
        start = { startFitted: true };
      } else if (to) {
        // Filtered to the same focus, with other content. The place is kept — but a view that
        // still rests where the fit put it is fitted again, once: the first layout after the fit
        // may be one nobody asked for (fitting moved the zoom out of the Everything level, so the
        // lists went), and the fit was made for a map of another size.
        start =
          fitted?.key === previous.referenceKey && fitted.viewport && sameView(fitted.viewport, now)
            ? { startFitted: true }
            : {
                startViewport: viewportKeepingPlace(
                  now,
                  size,
                  previous.rects,
                  arrivingAt(now.zoom).rects,
                ),
              };
      } else if (from) {
        // Filter left: back to where the whole map was — the very view when it is the same
        // arrangement, else the place that was in the middle. Without such a view (the whole map
        // was not on screen before, or had not come to rest) the stored viewport or a fit, like
        // on load.
        if (before?.model === model) {
          const back = arrivingAt(before.viewport.zoom);
          start = {
            startViewport:
              before.key === back.key
                ? before.viewport
                : viewportKeepingPlace(before.viewport, size, before.absolute, back.rects),
          };
        } else {
          start = storedStart();
        }
      } else {
        // The whole map with other content. The place is kept — but a view that still rests
        // where Fit view put it is fitted again, once, when the lists have come or gone since:
        // the fit itself took the zoom to another side of the Everything level, and was made
        // for a map of another size.
        start =
          fitted?.key === previous.referenceKey &&
          fitted.viewport &&
          fitted.lines !== undefined &&
          fitted.lines !== state.workItems.lines &&
          sameView(fitted.viewport, now)
            ? { startFitted: true }
            : {
                startViewport: viewportKeepingPlace(
                  now,
                  size,
                  previous.rects,
                  arrivingAt(now.zoom).rects,
                ),
              };
      }
      setLayoutState({ ...state, ...start });
    });
    return () => {
      cancelled = true;
    };
  }, [model, workItemView, wantedDrawn, showRows, flowStore, getViewport]);

  // While another layout is on its way (other work-item content, the map reduced to a focus or
  // whole again), the previous one of this model stays on screen, drawn with what it was computed
  // for. Everything that draws uses this state, never what is wanted next.
  const current = layoutState?.model === model ? layoutState : undefined;
  const computedLayout = current?.layout;
  const drawn = current?.drawn;
  const drawnModel = drawn?.model;
  const filteredTo = drawn?.filteredTo;

  // Collapsed groups: restored from localStorage per structure, then whatever the
  // user changes for this model. A newly loaded file starts again from its own stored set.
  const storedCollapsed = useMemo(
    () => (model ? readCollapsed(browserStorage(), model) : NOTHING_COLLAPSED),
    [model],
  );
  const collapsed =
    collapsedEdit !== undefined && collapsedEdit.model === model
      ? collapsedEdit.ids
      : storedCollapsed;

  // Positions and sizes set by hand: while unlocked, groups and nodes can be dragged and open
  // groups resized. The moved positions and the sizes are overrides on top of the layout drawn,
  // kept in the browser per layout (rows shown or hidden, each story mode, each map reduced to a
  // focus and each arrangement of a map closed up have their own); nothing else moves.
  const [positionsUnlocked, setPositionsUnlocked] = useState(false);
  const [handEdit, setHandEdit] = useState<{
    readonly key: string;
    readonly by: HandOverrides;
  }>();
  // A reduced model carries the rows its nodes have on the whole map, so its own layout places
  // none by their connections: the marks of those the whole map places so are put back. This is
  // the reference: the layout of the fully expanded map, one object for as long as it is drawn
  // (the arrangements of it are remembered per object).
  const reference = useMemo(
    () =>
      drawn && computedLayout
        ? withPlacedRows(computedLayout, drawn.placedRow ?? NO_PLACED_ROWS)
        : computedLayout,
    [drawn, computedLayout],
  );
  // Last viewport: restored on mount instead of fitting (the canvas checks that it
  // still shows some of the map, see MapCanvas); stored whenever the view comes to rest.
  // Read again for every layout of the model: a layout for other work-item content remounts the
  // canvas, which then starts from where the view was left.
  // A layout that replaces another one of the same model (another story mode, filter or
  // work-items file) starts from the place the user was looking at instead; should that show
  // nothing of the new map, the canvas fits the view like for any useless viewport.
  // The stored viewport is that of the whole map: a map reduced to a focus neither starts from it
  // (it is fitted, unless the layout effect gave it a place) nor is stored.
  const layoutKey = reference?.key;
  const startViewport = current?.startViewport;
  const startFitted = current?.startFitted;
  const initialViewport = useMemo(() => {
    if (startViewport) return startViewport;
    if (startFitted || filteredTo) return undefined;
    return model && layoutKey !== undefined ? readViewport(browserStorage(), model) : undefined;
  }, [model, layoutKey, startViewport, startFitted, filteredTo]);
  // Only another layout mounts another canvas. One that starts from a viewport draws the level
  // that viewport shows from its first frame, judged by the plain thresholds like the new canvas
  // judges it (see `useLodLevel`).
  const canvasKey = layoutKey !== undefined ? `${loadId}:${layoutKey}` : undefined;
  const [levelCanvas, setLevelCanvas] = useState<string>();
  if (canvasKey !== levelCanvas) {
    setLevelCanvas(canvasKey);
    if (canvasKey !== undefined && initialViewport) {
      setArrangedLevel(lodForZoom(initialViewport.zoom, undefined, lodConfig));
    }
  }
  // Whether the canvas of the layout on screen is up (`canvasIsUp`). From the render that mounts
  // a canvas until that canvas has started, the store still says what the one before it did.
  const startedCanvas = useRef<string>(undefined);
  const canvasStarted = useCallback(() => {
    startedCanvas.current = canvasKey;
  }, [canvasKey]);
  const canvasUp = useCallback(
    () => startedCanvas.current === canvasKey && canvasIsUp(flowStore),
    [canvasKey, flowStore],
  );
  const shownWorkItems = current?.workItems;
  // With Close up the gaps, what is drawn is the reference closed up around the boxes that are
  // visible: closed groups shrunk, the rest moved together, each box on its side of every other.
  const arrangeViewFor = useCallback(
    (visible: ReadonlySet<string>): ArrangeView | undefined =>
      drawnModel ? arrangeView(drawnModel, shownWorkItems, visible) : undefined,
    [drawnModel, shownWorkItems],
  );
  const visible = useMemo(
    () => (drawnModel ? visibleNodes(drawnModel, collapsed, drawnLevel) : undefined),
    [drawnModel, collapsed, drawnLevel],
  );
  const arranged = useMemo(() => {
    const view = visible && settings.closeGaps ? arrangeViewFor(visible) : undefined;
    return drawnModel && reference && view
      ? arrangedLayout(drawnModel, reference, view)
      : reference;
  }, [settings.closeGaps, drawnModel, reference, visible, arrangeViewFor]);
  const positionsKey = arranged?.key;
  const storedByHand = useMemo(
    () =>
      positionsKey === undefined
        ? NO_HAND_OVERRIDES
        : readHandOverrides(browserStorage(), positionsKey),
    [positionsKey],
  );
  const byHand =
    handEdit !== undefined && handEdit.key === positionsKey ? handEdit.by : storedByHand;
  const layout = useMemo(
    () => (drawn && arranged ? applyHandOverrides(drawn.model, arranged, byHand) : arranged),
    [drawn, arranged, byHand],
  );
  const changeByHand = useCallback(
    (next: HandOverrides) => {
      if (positionsKey === undefined) return;
      setHandEdit({ key: positionsKey, by: next });
      writeHandOverrides(browserStorage(), positionsKey, next, byHand);
    },
    [positionsKey, byHand],
  );
  // What a change by hand starts from is the arrangement itself, not the layout as drawn: the
  // overrides say where a box is and how far its edges were moved, whatever else was changed.
  const moveNode = useCallback(
    (id: string, delta: Position) => {
      if (!drawn || !arranged) return;
      const next = movedByHand(byHand, drawn.model, arranged, id, delta);
      if (next !== byHand) changeByHand(next);
    },
    [drawn, arranged, byHand, changeByHand],
  );
  // The work-item blocks the layout was computed with: a group is never made narrower than its own.
  const blocks = shownWorkItems?.content;
  const resizeNode = useCallback(
    (id: string, delta: Partial<EdgeGrowth>) => {
      if (!drawn || !arranged) return;
      const next = resizedByHand(byHand, drawn.model, arranged, id, delta, blocks);
      if (next !== byHand) changeByHand(next);
    },
    [drawn, arranged, byHand, changeByHand, blocks],
  );
  const resetNodeSize = useCallback(
    (id: string) => {
      if (!drawn || !arranged) return;
      const next = sizeResetByHand(byHand, drawn.model, arranged, id, blocks);
      if (next !== byHand) changeByHand(next);
    },
    [drawn, arranged, byHand, changeByHand, blocks],
  );
  // The groups drawn at another size than the arrangement's.
  const resizedIds = useMemo(
    () =>
      drawn && arranged ? new Set(appliedGrowth(drawn.model, arranged, byHand).keys()) : NO_IDS,
    [drawn, arranged, byHand],
  );
  // While unlocked, the open groups get their handles: how far each edge of a group can go.
  const flowResize = useMemo(
    (): FlowResize | undefined =>
      positionsUnlocked && drawn && arranged
        ? { limits: allResizeLimits(drawn.model, arranged, byHand, blocks), resized: resizedIds }
        : undefined,
    [positionsUnlocked, drawn, arranged, byHand, blocks, resizedIds],
  );
  const resetPositions = () => changeByHand(NO_HAND_OVERRIDES);
  // Another story mode, filter or work-items file, or the map reduced to another focus (or whole
  // again): its layout is being computed.
  const layoutPending =
    current !== undefined &&
    workItemView !== undefined &&
    wantedDrawn !== undefined &&
    (current.workItems !== workItemView || current.drawn !== wantedDrawn);
  const overlay = shownWorkItems?.overlay;

  // The lenses. Focus and colour are of the whole model: a box says the same whether or not the
  // rest is drawn. Heat and progress are counted twice: per node with everything inside it (what
  // the detail panel states, and the scale of the heat), and per box on the map for what that box
  // stands for — its own work and that of the nodes inside it that are not drawn —, so that no
  // item shows on a group and again on a box drawn inside it.
  // Focus: what a flow or a work item involves, from the overlay the canvas shows. Heat: the open
  // work, from the same overlay (so the work-item filter counts).
  // Progress: done over all, from an overlay with the iteration alone — a state filter must
  // not make a box look untouched. Colour: by an attribute or a metric of the structure.
  const focused = useMemo(
    () => (model ? focusSet(model, focus, overlay) : undefined),
    [model, focus, overlay],
  );
  const heat = useMemo(
    () => (settings.heat && model && overlay ? heatByWork(model, overlay) : undefined),
    [settings.heat, model, overlay],
  );
  const drawnHeat = useMemo(
    () =>
      settings.heat && model && overlay && visible
        ? heatOfDrawn(model, overlay, visible)
        : undefined,
    [settings.heat, model, overlay, visible],
  );
  const progressIteration = workFilter.iteration;
  const progressOverlay = useMemo(
    () =>
      settings.progress && model && work.status === 'done'
        ? buildWorkItemOverlay(
            model,
            workItems,
            progressIteration === undefined ? {} : { iteration: progressIteration },
          )
        : undefined,
    [settings.progress, model, work.status, workItems, progressIteration],
  );
  const progress = useMemo(
    () => (model && progressOverlay ? progressByNode(model, progressOverlay) : undefined),
    [model, progressOverlay],
  );
  const drawnProgress = useMemo(
    () =>
      model && progressOverlay && visible
        ? progressOfDrawn(model, progressOverlay, visible)
        : undefined,
    [model, progressOverlay, visible],
  );
  const colorBy = model ? usableColorBy(model, settings.colorBy) : 'none';
  const coloring = useMemo(
    () => (model ? nodeColoring(model, colorBy) : undefined),
    [model, colorBy],
  );
  const colorChoices = useMemo(() => (model ? colorByOptions(model) : []), [model]);
  const lenses = useMemo(
    (): NodeLenses => ({
      heat: drawnHeat,
      progress: drawnProgress,
      colors: coloring && coloring.byNode.size > 0 ? coloring.byNode : undefined,
    }),
    [drawnHeat, drawnProgress, coloring],
  );
  const hints = useMemo(() => (model ? authoringHints(model, overlay) : []), [model, overlay]);
  // A valid file may declare no domains at all: say so instead of showing a blank canvas.
  const isEmptyModel = model !== undefined && model.nodes.size === 0;

  /** Changes the collapsed set; `anchor`: the group opened or closed on the canvas. */
  const changeCollapsed = useCallback(
    (change: (current: ReadonlySet<string>) => ReadonlySet<string>, anchor?: string) => {
      if (!model) return;
      setCollapsedEdit((previous) => ({
        model,
        ids: change(previous?.model === model ? previous.ids : storedCollapsed),
        ...(anchor !== undefined ? { anchor } : {}),
      }));
    },
    [model, storedCollapsed],
  );
  useEffect(() => {
    if (collapsedEdit) writeCollapsed(browserStorage(), collapsedEdit.model, collapsedEdit.ids);
  }, [collapsedEdit]);

  // A group opened or closed on the canvas stays where it is on the screen, should the map close
  // up otherwise around it.
  const toggleCollapsed = useCallback(
    (id: string) => {
      changeCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }, id);
    },
    [changeCollapsed],
  );
  const groups = useMemo(() => (model ? groupIds(model) : []), [model]);
  const collapseAll = () => changeCollapsed(() => new Set(groups));
  const expandAll = () => changeCollapsed(() => NOTHING_COLLAPSED);
  const allCollapsed = groups.every((id) => collapsed.has(id));
  // Picking a level of detail (Auto included) shows that level for the whole map: groups
  // collapsed by hand are opened, so that nothing stays closed against the chosen level.
  const chooseLod = (mode: LodMode) => {
    setLodMode(mode);
    expandAll();
  };

  // Edge-kind filter: stored per structure like the collapsed set, and applied to
  // the drawn model's edges *before* the rollup, so aggregates and their counts cover what is
  // shown. It never changes the layout.
  const storedHiddenKinds = useMemo(
    () => (model ? readHiddenKinds(browserStorage(), model) : NO_KINDS_HIDDEN),
    [model],
  );
  const hiddenKinds =
    hiddenKindsEdit !== undefined && hiddenKindsEdit.model === model
      ? hiddenKindsEdit.kinds
      : storedHiddenKinds;
  useEffect(() => {
    if (hiddenKindsEdit) {
      writeHiddenKinds(browserStorage(), hiddenKindsEdit.model, hiddenKindsEdit.kinds);
    }
  }, [hiddenKindsEdit]);
  const shownModel = useMemo(
    () => (drawnModel ? withoutEdgeKinds(drawnModel, hiddenKinds) : undefined),
    [drawnModel, hiddenKinds],
  );
  // Of the edges on the map: what a click on a kind hides or shows.
  const kindCounts = useMemo(() => {
    const counts: Record<EdgeKind, number> = { dataflow: 0, dependency: 0, control: 0, config: 0 };
    for (const edge of drawnModel?.edges ?? []) counts[edge.kind] += 1;
    return counts;
  }, [drawnModel]);

  // Nodes and edges for the current view. Only visibility and the edge rollup depend on the
  // collapsed set and the level of detail: positions and sizes always come from the one layout,
  // which the effect above computes per drawn model alone — closed up for what is drawn when
  // Close up the gaps is on —, so zooming never lays anything out. Closing up implies shrunk
  // closed groups. The model and the layout both come from the state on screen: a model with a
  // node the layout lacks cannot be drawn. The collapsed set is that of the whole model; groups
  // that are not drawn have no effect.
  const shrinkClosed = settings.compactCollapsed || settings.closeGaps;
  const flowState = useMemo((): FlowState | undefined => {
    if (!shownModel || !layout || shownModel.nodes.size === 0) return undefined;
    try {
      return {
        flow: buildFlow(shownModel, layout, {
          collapsedIds: collapsed,
          lodLevel: drawnLevel,
          compactCollapsed: shrinkClosed,
          draggable: positionsUnlocked,
          ...(flowResize ? { resize: flowResize } : {}),
          ...(shownWorkItems
            ? { workItems: { overlay: shownWorkItems.overlay, mode: shownWorkItems.mode } }
            : {}),
        }),
      };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    }
  }, [
    shownModel,
    layout,
    collapsed,
    drawnLevel,
    shrinkClosed,
    positionsUnlocked,
    flowResize,
    shownWorkItems,
  ]);
  const flow = flowState?.flow;
  const renderError = current?.error ?? flowState?.error;

  // The layout on screen, for what follows it. When another arrangement of the same layout
  // replaces the one drawn (the map closed up otherwise), the place is kept: the group opened or
  // closed on the canvas stays where it is, or else the box under the middle of the canvas, at
  // the same zoom — as they are drawn. A passive effect: React Flow has put the new nodes into
  // its store by now, so nodes and viewport change in the same frame.
  useEffect(() => {
    const before = shownLayout.current;
    let rects: ReadonlyMap<string, Rect> | undefined;
    if (layout && visible) {
      if (!settings.closeGaps) rects = layout.absolute;
      else rects = flow ? drawnRects(flow) : visibleRects(layout, visible);
    }
    const now =
      model && layout && drawn && reference && arranged && rects
        ? {
            model,
            layout,
            filteredTo: drawn.filteredTo,
            referenceKey: reference.key,
            arrangedKey: arranged.key,
            rects,
            collapsed,
          }
        : undefined;
    shownLayout.current = now;
    if (
      !before ||
      !now ||
      before.model !== now.model ||
      before.referenceKey !== now.referenceKey ||
      before.arrangedKey === now.arrangedKey
    ) {
      return;
    }
    const { width, height } = flowStore.getState();
    const moving = performance.now() < movingUntil.current ? movingTo.current : undefined;
    const from = moving ?? getViewport();
    const anchor =
      collapsedEdit !== undefined &&
      collapsedEdit.model === now.model &&
      collapsedEdit.ids === collapsed &&
      before.collapsed !== collapsed
        ? collapsedEdit.anchor
        : undefined;
    const next = viewportKeepingPlace(from, { width, height }, before.rects, now.rects, anchor);
    if (next !== from || moving) void setViewport(next);
    // That ends the move under way, here: whatever keeps a place before the time of the move is
    // up starts from this view, not from where the move was going.
    if (moving) movingTo.current = next;
  }, [
    model,
    layout,
    drawn,
    reference,
    arranged,
    visible,
    collapsed,
    collapsedEdit,
    flow,
    settings.closeGaps,
    flowStore,
    getViewport,
    setViewport,
  ]);

  // What a layout that arrives will draw, with what the viewer has chosen now: the level the
  // zoom shows (judged by the plain thresholds, as a new canvas judges it) or the pinned one.
  const { closeGaps } = settings;
  useEffect(() => {
    arriving.current = (arrivingDrawn, computed, workItems, zoom) => {
      const placed = withPlacedRows(computed, arrivingDrawn.placedRow ?? NO_PLACED_ROWS);
      if (!closeGaps) return { key: placed.key, rects: placed.absolute };
      const level = lodMode === 'auto' ? lodForZoom(zoom, undefined, lodConfig) : lodMode;
      const shown = visibleNodes(arrivingDrawn.model, collapsed, level);
      const at = arrangedLayout(
        arrivingDrawn.model,
        placed,
        arrangeView(arrivingDrawn.model, workItems, shown),
      );
      // As they will be drawn, like the rectangles of the map on screen they are held against:
      // a closed group that spans rows shrunk in its column.
      return {
        key: at.key,
        rects: drawnNodeRects(arrivingDrawn.model, at, {
          collapsedIds: collapsed,
          lodLevel: level,
          compactCollapsed: true,
          workItems: { overlay: workItems.overlay, mode: workItems.mode },
        }),
      };
    };
  }, [closeGaps, collapsed, lodMode, lodConfig]);

  // Moves of the view started by the viewer. With the map closed up, a move worked out on one
  // arrangement must not run while another arrives: it is worked out on the arrangement the
  // change that asked for it gives (the effect below, after the place has been kept), and again
  // on that of the level it ends on when that is another one.
  const fitMoves = useRef(0);
  const startMove = useCallback(
    (to: Viewport, duration: number, fit?: true) => {
      movingUntil.current = performance.now() + duration + 100;
      movingTo.current = to;
      // The view goes somewhere on purpose: it no longer rests where a fit put it.
      if (!fit) refit.current = undefined;
      const moved = setViewport(to, duration > 0 ? { duration } : undefined);
      if (!fit || !(duration > 0)) {
        setFitMoving(undefined);
        return;
      }
      // An animated fit is under way until it is there — or until its time is up: a move that
      // is cut short (a gesture, a place kept on its way) never says that it ended.
      const move = (fitMoves.current += 1);
      const over = () => setFitMoving((now) => (now === move ? undefined : now));
      setFitMoving(move);
      void moved.then(over);
      setTimeout(over, duration + 100);
    },
    [setViewport],
  );
  /** Moves the view by `move`, on the layout drawn; `level`: the level it ends on, when known. */
  const moveOnArrangement = useCallback(
    (level: LodLevel | undefined, move: PendingMove['move']) => {
      if (!settingsNow.current.closeGaps) {
        const step = layout ? move(layout) : undefined;
        if (step) startMove(step.to, step.duration, step.fit);
        return;
      }
      if (level !== undefined) setArrangedLevel(level);
      setPendingMove({ move, pass: 1 });
    },
    [layout, startMove, setArrangedLevel],
  );
  useEffect(() => {
    if (!pendingMove) return;
    const shown = shownLayout.current;
    const step = shown ? pendingMove.move(shown.layout) : undefined;
    if (step && pendingMove.pass === 1 && lodMode === 'auto') {
      // What the tracker will say there: when it is another level, the move is worked out again
      // on the arrangement of that level.
      const end = lodForZoom(step.to.zoom, zoomLod, lodConfig);
      if (end !== arrangedLevel) {
        setArrangedLevel(end);
        setPendingMove((asked) =>
          asked === pendingMove ? { move: pendingMove.move, pass: 2 } : asked,
        );
        return;
      }
    }
    // Only this move is done with: one asked for since it was (by something that waited for the
    // canvas, between two renders) is still to be made, from where this one ends.
    setPendingMove((asked) => (asked === pendingMove ? undefined : asked));
    if (step) startMove(step.to, step.duration, step.fit);
  }, [pendingMove, lodMode, zoomLod, lodConfig, arrangedLevel, setArrangedLevel, startMove]);

  // Selection. A node or an edge is held in terms of the whole model, so it survives
  // collapsing and zooming, and a map reduced to a focus that leaves it out: its panel stays
  // open. An aggregate only means something while it is drawn: once its groups are opened (or
  // only one member is left drawn) it becomes that single edge or nothing, for good — the state
  // is adjusted while rendering, so it does not come back by itself later. Likewise a work item
  // that the work-item filter now hides (or that another file does not have) is no longer
  // selected.
  const requested =
    selectionEdit !== undefined && selectionEdit.model === model
      ? selectionEdit.selection
      : undefined;
  const selection =
    model && flow ? resolveSelection(model, flow.edges, requested, overlay?.shownIds) : undefined;
  if (
    model &&
    flow &&
    (requested?.type === 'aggregate' || requested?.type === 'workitem') &&
    selection !== requested
  ) {
    setSelectionEdit({ model, selection });
  }
  // A work item still to be brought on screen, once the layout with its line has arrived (see
  // `revealWorkItems`). It lasts only as long as that item is the selection: left behind, it
  // would move the view much later, when such a layout arrives for another reason.
  const pendingWorkItemReveal = useRef<{ nodeId: string; itemId: number }>(undefined);
  // Something to go to once the map that has it is on screen (see `deferGoTo`, and `goToFlow`
  // for a flow): selected already, still to be brought on screen. Like the reveal above it lasts
  // only while it is the selection.
  const [pendingGoTo, setPendingGoTo] = useState<{
    readonly model: ArchitectureModel;
    readonly target: Selection;
  }>();
  // What the viewer said when it left Filter by itself, shown in the focus bar.
  const [filterNote, setFilterNote] = useState<{
    readonly model: ArchitectureModel;
    readonly text: string;
  }>();
  // A view coloured by a preset or label this file does not have: the note says so until a
  // colouring is chosen.
  const [colorNote, setColorNote] = useState<{
    readonly model: ArchitectureModel;
    readonly text: string;
  }>();
  const select = useCallback(
    (next: Selection | undefined) => {
      if (!model) return;
      const pending = pendingWorkItemReveal.current;
      if (pending && !(next?.type === 'workitem' && next.id === pending.itemId)) {
        pendingWorkItemReveal.current = undefined;
      }
      setPendingGoTo((request) =>
        request && !sameSelection(request.target, next) ? undefined : request,
      );
      setSelectionEdit((previous) =>
        previous?.model === model && sameSelection(previous.selection, next)
          ? previous
          : { model, selection: next },
      );
    },
    [model],
  );
  const clearSelection = useCallback(() => select(undefined), [select]);
  const setFocus = useCallback(
    (next: Focus | undefined) => {
      if (!model) return;
      // Another focus is another map: what was asked of the one before no longer holds, and the
      // place of a view that was applied is not taken there.
      setPendingGoTo(undefined);
      setFilterNote(undefined);
      pendingCentre.current = undefined;
      // The same focus chosen again keeps its object: nothing that follows from it starts anew.
      setFocusEdit((previous) =>
        previous?.model === model && sameFocus(previous.focus, next)
          ? previous
          : { model, focus: next },
      );
    },
    [model],
  );
  /**
   * Navigation wins over Filter. Whether `target` cannot be shown on the map as it is or as it is
   * about to be: it is then selected (its panel opens at once) and gone to later, on the map
   * that has it. When that is not the map wanted now — it is filtered to a focus that leaves the
   * target out — the mode goes back to Focus, with the focus kept, and the focus bar says so.
   * Later too on a canvas that is not up yet: one just mounted for another layout still has its
   * own fit to make, which would undo the move.
   */
  const deferGoTo = useCallback(
    (target: Selection): boolean => {
      if (!model) return false;
      // Judged by the map wanted first, so that this also holds while a filtered one is on its
      // way; then by the one on screen: the target may be on the wanted map, which has not
      // arrived yet, and there is only to wait. Something the structure does not have is handled
      // as on the whole map.
      const timing = goToTiming(model, wantedDrawn?.model, drawnModel, target, wantedOverlay);
      if (timing === 'now' && (!laidOut || canvasUp())) return false;
      select(target);
      setPendingGoTo({ model, target });
      if (timing === 'leave') {
        // The place of a view applied just before is one of the map that is left.
        pendingCentre.current = undefined;
        setFocusMode('focus');
        setFilterNote({
          model,
          text: `Filter switched off to show ${targetName(model, target, wantedOverlay)}.`,
        });
      }
      return true;
    },
    [model, wantedOverlay, wantedDrawn, drawnModel, laidOut, canvasUp, select, setFocusMode],
  );
  // Edges on demand holds at every level of detail; on a map reduced to its focus every edge is
  // one of the focus, and none is held back.
  const edgesHeldBack = settings.edgesOnDemand && !filteredTo;
  // The selection where the drawn model has it (the whole model would mark the nearest group
  // around a node that is left out, as if the node were inside it).
  const drawnSelection = useMemo(
    () =>
      drawnModel && flow ? renderedSelection(drawnModel, flow, selection, overlay) : undefined,
    [drawnModel, flow, selection, overlay],
  );
  // The flow as drawn: the selected element marked and everything outside its neighbourhood
  // dimmed; then what the focus does not involve paled, but for what the selection is on (gone
  // to from the search or a panel, it has to be readable). A map reduced to its focus has
  // nothing to pale; a whole map with a filtered one on its way is paled meanwhile.
  const markedFlow = useMemo(() => {
    if (!model || !drawnModel || !flow) return flow;
    const shown = highlightFlow(flow, drawnSelection);
    return focused && !filteredTo ? focusFlow(model, shown, focused, drawnSelection) : shown;
  }, [model, drawnModel, filteredTo, flow, drawnSelection, focused]);
  // With edges on demand, every edge hidden but those at the selected box (with what is drawn
  // inside it), the selected edge and those of the focus; then the edges at the box under the
  // pointer shown again. The pointer only reveals: the work it costs is that of the box, on an
  // index built once per flow.
  const onDemand = useMemo(
    () => (edgesHeldBack && flow ? onDemandIndex(flow) : undefined),
    [edgesHeldBack, flow],
  );
  // The box under the pointer only counts while edges are held back and the box is drawn. A box
  // hovered before the setting was switched on must not bring its edges back on its own; neither
  // must one that was taken away under the pointer (another level of detail, a group closed
  // around it: an element that goes gets no leave event) when it is drawn again.
  if (hoveredNode !== undefined && !onDemand?.boxes.has(hoveredNode)) setHoveredNode(undefined);
  const quietFlow = useMemo(() => {
    if (!markedFlow || !onDemand) return markedFlow;
    let asked: readonly string[] = [];
    if (drawnSelection?.type === 'node') asked = [drawnSelection.id];
    else if (drawnSelection?.type === 'workitem') asked = drawnSelection.nodeIds;
    const edgeId = drawnSelection?.type === 'edge' ? drawnSelection.id : undefined;
    return quietEdges(markedFlow, boxesAsked(onDemand, asked), focused, edgeId);
  }, [markedFlow, onDemand, drawnSelection, focused]);
  const shownFlow = useMemo(() => {
    if (!quietFlow || !markedFlow || !onDemand || hoveredNode === undefined) return quietFlow;
    return revealEdges(quietFlow, markedFlow, onDemand, boxesAsked(onDemand, [hoveredNode]));
  }, [quietFlow, markedFlow, onDemand, hoveredNode]);
  // The fit of a map closed up in Auto, into a canvas of `size`: each level is closed up
  // otherwise, so the fit is that of the arrangement of the level its zoom shows by the plain
  // thresholds (`fitAmongLevels`) — whatever level the view comes from, so that fitting again
  // changes nothing. Undefined when the map is not closed up, a level is pinned (the arrangement
  // does not depend on the zoom), or no level holds.
  const arrangedFit = useCallback(
    (size: Size) => {
      if (!settings.closeGaps || lodMode !== 'auto' || !drawnModel || !reference) return undefined;
      if (!(size.width > 0 && size.height > 0)) return undefined;
      const plain = fitOptions(coveredCanvasLeft());
      return fitAmongLevels(
        (level, maxZoom) => {
          const shown = visibleNodes(drawnModel, collapsed, level);
          const at = arrangedLayout(
            drawnModel,
            reference,
            arrangeView(drawnModel, shownWorkItems, shown),
          );
          // As it is drawn there: with the positions and sizes set by hand in that arrangement.
          const there =
            at.key === positionsKey ? byHand : readHandOverrides(browserStorage(), at.key);
          return fittedViewport(
            { ...plain, maxZoom: Math.min(plain.maxZoom, maxZoom) },
            arrangedSourceNodes(drawnModel, applyHandOverrides(drawnModel, at, there), shown),
            size,
          );
        },
        undefined,
        lodConfig,
      );
    },
    [
      settings.closeGaps,
      lodMode,
      drawnModel,
      reference,
      collapsed,
      shownWorkItems,
      positionsKey,
      byHand,
      lodConfig,
    ],
  );
  // Fits the map into the canvas, clear of what lies over it: the body of the control panel in a
  // narrow window, and the minimap where the map would have a box under it. A map closed up in
  // Auto is fitted as it is drawn at the level the fit ends on.
  const fitMap = useCallback(
    (duration?: number) => {
      const { width, height } = flowStore.getState();
      // Of the whole map: should the lists come or go because of where the fit ends, the map
      // that arrives then is fitted once more (see the layout effect).
      const fitted =
        layoutKey !== undefined && !filteredTo ? { key: layoutKey, lines: linesDrawn } : undefined;
      if (!filteredTo) refit.current = fitted;
      const rested = (viewport: Viewport) => {
        if (fitted && refit.current === fitted) refit.current = { ...fitted, viewport };
      };
      const arrangedAt = arrangedFit({ width, height });
      if (arrangedAt) {
        rested(arrangedAt.viewport);
        setArrangedLevel(arrangedAt.level);
        setPendingMove({
          move: () => ({ to: arrangedAt.viewport, duration: duration ?? 0, fit: true }),
          pass: 2,
          fit: true,
        });
        return;
      }
      const plain = fitOptions(coveredCanvasLeft());
      const fit = fitWithRoom(plain, fitRoom(plain, flow?.nodes ?? [], { width, height }));
      void fitView(duration === undefined ? fit : { ...fit, duration }).then(() =>
        rested(getViewport()),
      );
    },
    [
      flow,
      flowStore,
      fitView,
      getViewport,
      arrangedFit,
      setArrangedLevel,
      layoutKey,
      filteredTo,
      linesDrawn,
    ],
  );
  const fitToNow = useRef<(size: Size) => boolean>(() => false);
  useEffect(() => {
    fitToNow.current = (size) => {
      const arrangedAt = arrangedFit(size);
      if (!arrangedAt) return false;
      // This fit takes the place of the one a canvas just mounted may still have to make on its
      // own: that one comes with the first measurement of the nodes, fits whatever is drawn then
      // without the ceiling of its level, and would undo this one. While it is still to come,
      // the view goes to the fit at once — the canvas may be painted before the arrangement of
      // that level is drawn — and only then is the fit of the canvas dropped: the level tracker
      // judges the zoom it finds then by the plain thresholds, as the fit was worked out. The
      // move below puts the view there exactly, after the place has been kept for that
      // arrangement; it is the whole of the fit when the canvas has made its own already.
      if (flowStore.getState().fitViewQueued) {
        void setViewport(arrangedAt.viewport);
        flowStore.setState({ fitViewQueued: false, fitViewOptions: undefined });
      }
      setArrangedLevel(arrangedAt.level);
      setPendingMove({
        move: () => ({ to: arrangedAt.viewport, duration: 0, fit: true }),
        pass: 2,
        fit: true,
      });
      return true;
    };
  }, [arrangedFit, flowStore, setViewport, setArrangedLevel]);
  /** The fit of a canvas that is mounted: one function for the canvas, whatever it does. */
  const fitCanvas = useCallback((size: Size) => fitToNow.current(size), []);
  const fitFromControls = useCallback(() => fitMap(), [fitMap]);

  const toggleKind = (kind: EdgeKind) => {
    if (!model) return;
    const kinds = toggleEdgeKind(hiddenKinds, kind);
    setHiddenKindsEdit({ model, kinds });
    // A selected edge of a kind that is now hidden has nothing left to show.
    const selectedEdge =
      selection?.type === 'edge' ? model.edges.find((edge) => edge.id === selection.id) : undefined;
    if (selectedEdge && kinds.has(selectedEdge.kind)) clearSelection();
  };

  // The viewport that shows `target` (canvas coordinates) at a zoom of at least `minZoom`, moving
  // the view only if needed (undefined: no need); `primary` is the part kept on screen when not
  // all of it fits.
  const panelOpen = selection !== undefined;
  const viewportShowing = useCallback(
    (target: Rect, primary: Rect | undefined, minZoom: number): Viewport | undefined => {
      // The canvas as it will be once the detail panel is open beside it (the panel never takes
      // more than half the row, see `.detail-panel` in styles.css).
      const { width, height } = flowStore.getState();
      // What the control panel covers at the left of the canvas is left out: the target is
      // brought on screen in the part beside it, as if the canvas began there.
      const inset = coveredCanvasLeft();
      const size = {
        width: (panelOpen ? width : Math.max(width - DETAIL_PANEL_WIDTH, width / 2)) - inset,
        height,
      };
      const from = getViewport();
      const shifted = { ...from, x: from.x - inset };
      const to = viewportToReveal(shifted, target, size, {
        minZoom,
        ...(primary ? { primary } : {}),
      });
      return to === shifted ? undefined : { ...to, x: to.x + inset };
    },
    [flowStore, panelOpen, getViewport],
  );
  // Brings the given nodes on screen: opens the groups around them and, only if needed, pans
  // and zooms — at least far enough in for the level of detail to draw them. Without `move` the
  // view is left alone: for a map that is about to be replaced by one that is fitted.
  const reveal = useCallback(
    (ids: readonly string[], options?: { readonly move?: boolean }) => {
      if (!model || !layout) return;
      changeCollapsed((collapsedNow) => {
        const next = expandToReveal(model, collapsedNow, ids);
        return next.size === collapsedNow.size ? collapsedNow : next;
      });
      // A pinned level too coarse to draw the nodes is raised to the one that does; so is Auto
      // when its threshold for that level is beyond the zoom range.
      const needed = LOD_LEVELS.findLast((level) =>
        ids.some((id) => minLodForNode(model, id) === level),
      );
      const mode = needed ? lodModeToDraw(lodMode, needed, lodConfig) : lodMode;
      setLodMode(mode);
      if (options?.move === false) return;
      // Only the zoom-driven mode needs a zoom that draws the nodes.
      const minZoom = mode === 'auto' ? revealZoomForNodes(model, ids, lodConfig) : 0;
      moveOnArrangement(undefined, (on) => {
        const target = unionRect(
          ids.map((id) => on.absolute.get(id)).filter((rect) => rect !== undefined),
        );
        if (!target) return undefined;
        // When not everything fits at the zoom that draws it, the first node (the source of an
        // edge) is the one kept on screen.
        const [first] = ids;
        const primary = first === undefined ? undefined : on.absolute.get(first);
        const to = viewportShowing(target, primary, minZoom);
        return to && { to, duration: REVEAL_DURATION_MS };
      });
    },
    [model, layout, lodMode, lodConfig, changeCollapsed, moveOnArrangement, viewportShowing],
  );
  // Brings the work-item list of a node on screen, drawn: the node and the groups around it are
  // opened (a closed group shows a badge instead), a pinned level coarser than Everything is
  // raised to it, and in Auto mode the view zooms in to where Everything is shown — or, when the
  // Everything threshold is set beyond the zoom range, Everything is pinned.
  const revealWorkItems = useCallback(
    (nodeId: string, itemId: number) => {
      if (!model || !layout?.absolute.has(nodeId) || !shownWorkItems) return;
      // No room reserved yet (a coarser level is shown): come back once the layout with the
      // lists has arrived.
      pendingWorkItemReveal.current = layout.content.has(nodeId) ? undefined : { nodeId, itemId };
      changeCollapsed((collapsedNow) => {
        const next = expandToOpen(model, collapsedNow, [nodeId]);
        return next.size === collapsedNow.size ? collapsedNow : next;
      });
      const mode = lodModeToDraw(lodMode, 'detail', lodConfig);
      setLodMode(mode);
      const minZoom = mode === 'auto' ? lodRevealZoom('detail', lodConfig) : 0;
      const lines = workItemLines(shownWorkItems.overlay, nodeId, shownWorkItems.mode);
      moveOnArrangement(undefined, (on) => {
        const box = on.absolute.get(nodeId);
        if (!box) return undefined;
        // The name of the node with the list below it — not all of a large group, whose header
        // strip may be many times wider than the list at its left end — and, when even that
        // does not fit, the line of the item itself.
        const block = on.content.get(nodeId);
        const list = block ? workItemLinesRect(block, lines) : undefined;
        const line = block ? workItemLineRect(block, lines, itemId) : undefined;
        const inCanvas = (rect: Rect): Rect => ({ ...rect, x: box.x + rect.x, y: box.y + rect.y });
        const target = list
          ? { x: box.x, y: box.y, width: list.x + list.width, height: list.y + list.height }
          : box;
        const to = viewportShowing(target, line ? inCanvas(line) : target, minZoom);
        return to && { to, duration: REVEAL_DURATION_MS };
      });
    },
    [
      model,
      layout,
      shownWorkItems,
      lodMode,
      lodConfig,
      changeCollapsed,
      moveOnArrangement,
      viewportShowing,
    ],
  );
  useEffect(() => {
    const pending = pendingWorkItemReveal.current;
    if (!pending || !layout?.content.has(pending.nodeId)) return;
    // Once the canvas for the new layout is up, and only if the item is still waited for.
    return whenCanvasReady(flowStore, () => {
      if (pendingWorkItemReveal.current !== pending) return;
      revealWorkItems(pending.nodeId, pending.itemId);
    });
  }, [layout, revealWorkItems, flowStore]);
  const goToNode = useCallback(
    (id: string) => {
      if (deferGoTo({ type: 'node', id })) return;
      pendingWorkItemReveal.current = undefined;
      reveal([id]);
      select({ type: 'node', id });
    },
    [deferGoTo, reveal, select],
  );
  // A work item chosen in the panel or the search: selected, and the first node that draws its
  // line is opened and zoomed to. One that is not drawn (story mode Off, a task in Stories only,
  // a line under "+k more") shows the node it belongs to; the panel says why there is no line and
  // offers the mode that draws it — the story mode itself is only ever changed by the user,
  // because it lays the whole map out again. On a filtered map it is the first such node the map
  // has; an item none of whose nodes it has is gone to on the whole map (`deferGoTo`).
  const goToWorkItem = useCallback(
    (id: number) => {
      if (deferGoTo({ type: 'workitem', id })) return;
      select({ type: 'workitem', id });
      if (!shownWorkItems || !drawnModel) return;
      const place = workItemPlace(shownWorkItems.overlay, shownWorkItems.mode, id);
      const onMap = (nodeId: string) => drawnModel.nodes.has(nodeId);
      const drawnOn = place.drawnOn.find(onMap);
      const listedOn = place.nodeIds.find(onMap);
      if (drawnOn !== undefined) revealWorkItems(drawnOn, id);
      else if (listedOn !== undefined) reveal([listedOn]);
    },
    [shownWorkItems, drawnModel, deferGoTo, select, reveal, revealWorkItems],
  );
  const selectWorkItem = useCallback((id: number) => select({ type: 'workitem', id }), [select]);
  // A flow chosen in a panel or the Focus selector: the map is focused on it, its panel opens,
  // and what it involves is brought on screen — on the map that shows it. In Filter mode that is
  // the map reduced to the flow, which arrives fitted: the view of the map it replaces is not
  // moved first. A flow that leaves nothing out is shown on the whole map in either mode; when a
  // reduced map is on screen instead, the view moves once the whole one is back.
  const goToFlow = useCallback(
    (id: string) => {
      if (!model) return;
      const next: Focus = { type: 'flow', id };
      const set = focusSet(model, next);
      if (!set) return;
      setFocus(next);
      select(next);
      const reduced =
        settings.focusMode === 'filter' && filterToFocus(model, set, wholePlacement) !== undefined;
      const timing = focusMoveTiming(next, reduced, filteredTo);
      // On a canvas that is not up yet (see `deferGoTo`) the view moves once it is.
      const move = timing === 'now' && (!laidOut || canvasUp());
      if (timing === 'wait' || (timing === 'now' && !move)) {
        setPendingGoTo({ model, target: next });
      }
      reveal([...set.nodes], { move });
    },
    [
      model,
      settings.focusMode,
      wholePlacement,
      filteredTo,
      laidOut,
      canvasUp,
      setFocus,
      select,
      reveal,
    ],
  );
  const chooseFocus = useCallback(
    (next: Focus | undefined) => {
      if (next?.type === 'flow') goToFlow(next.id);
      else setFocus(next);
    },
    [goToFlow, setFocus],
  );
  // What the lines on the canvas need: the selected item (and the item a selected task is
  // listed under), and what a click on a line does.
  const selectedWorkItem = selection?.type === 'workitem' ? selection.id : undefined;
  const selectedParent =
    selectedWorkItem === undefined ? undefined : overlay?.listedUnder.get(selectedWorkItem);
  const workItemCanvas = useMemo(
    (): WorkItemCanvas => ({
      selectedId: selectedWorkItem,
      parentId: selectedParent,
      select: selectWorkItem,
    }),
    [selectedWorkItem, selectedParent, selectWorkItem],
  );
  const goToEdge = useCallback(
    (id: string) => {
      if (deferGoTo({ type: 'edge', id })) return;
      const edge = model?.edges.find((candidate) => candidate.id === id);
      if (!model || !edge) return;
      // A hidden kind is switched back on: the edge is to be seen.
      setHiddenKindsEdit((previous) => {
        const kinds = previous?.model === model ? previous.kinds : storedHiddenKinds;
        if (!kinds.has(edge.kind)) return previous;
        return { model, kinds: toggleEdgeKind(kinds, edge.kind) };
      });
      reveal([edge.from, edge.to]);
      select({ type: 'edge', id });
    },
    [model, storedHiddenKinds, deferGoTo, reveal, select],
  );
  // What was asked for on a map that did not have it is gone to once the map that has it is on
  // screen, on a canvas that can be moved.
  useEffect(() => {
    if (!pendingGoTo || pendingGoTo.model !== model || layoutPending || !layout) return;
    const { target } = pendingGoTo;
    return whenCanvasReady(flowStore, () => {
      setPendingGoTo(undefined);
      if (target.type === 'node') goToNode(target.id);
      else if (target.type === 'edge') goToEdge(target.id);
      else if (target.type === 'workitem') goToWorkItem(target.id);
      else if (target.type === 'flow') goToFlow(target.id);
    });
  }, [
    pendingGoTo,
    model,
    layoutPending,
    layout,
    flowStore,
    goToNode,
    goToEdge,
    goToWorkItem,
    goToFlow,
  ]);

  // The view is kept with what it was taken on — the arrangement drawn and the boxes around the
  // middle of the canvas —, so that it can be given the same place on a map drawn otherwise.
  const storeViewport = useCallback(
    (viewport: Viewport) => {
      if (!model) return;
      const shown = shownLayout.current;
      const { width, height } = flowStore.getState();
      const size = { width, height };
      const rects =
        shown?.model === model && !shown.filteredTo
          ? heldRects(viewport, size, shown.rects)
          : undefined;
      writeViewport(
        browserStorage(),
        model,
        viewport,
        shown && rects && rects.size > 0 ? { key: shown.arrangedKey, size, rects } : undefined,
      );
    },
    [model, flowStore],
  );
  /** Where a filtered canvas reports its view instead: only the rest of its first fit is noted. */
  const noteFilteredView = useCallback(
    (viewport: Viewport) => {
      const fitted = refit.current;
      if (fitted && fitted.key === layoutKey && !fitted.viewport) {
        refit.current = { key: fitted.key, viewport };
      }
    },
    [layoutKey],
  );

  // Shortcuts: "/" or Ctrl+K focuses the search box, Escape clears the selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const ctrlK =
        (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k';
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (ctrlK || (slash && !isTextEntry(event.target))) {
        if (focusSearch()) event.preventDefault();
      } else if (event.key === 'Escape' && !isTextEntry(event.target)) {
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, focusSearch]);

  // What the diagnostics panel adds about the work items: problems of the file, tags
  // naming unknown nodes, and — of the items the work-item filter shows — those without a comp:
  // tag with the tag coverage.
  const workDiagnosticsName = workLoad?.source?.diagnosticsName;
  const tagWarnings = useMemo(
    () => (model ? workItemDiagnostics(model, workItems, workDiagnosticsName, workFilter) : []),
    [model, workItems, workDiagnosticsName, workFilter],
  );
  const coverage = useMemo(
    () => (model ? workItemTagReport(model, workItems, workFilter).coverage : undefined),
    [model, workItems, workFilter],
  );
  const workDiagnostics = useMemo(
    () =>
      // Whenever a work-items file is loaded: its own problems are reported even when the
      // structure has errors (no model, so no tags to check and no coverage).
      workLoad?.source
        ? {
            sourceName: workLoad.source.name,
            coverage,
            errors: workLoad.errors,
            warnings: [...workLoad.warnings, ...tagWarnings],
          }
        : undefined,
    [workLoad, coverage, tagWarnings],
  );
  const chooseStoryMode = (mode: StoryMode) => changeSettings({ ...settings, storyMode: mode });
  // Choosing a colouring answers what a view could not show: its notice goes.
  const changeLenses = (next: DisplaySettings) => {
    if (next.colorBy !== settings.colorBy) setColorNote(undefined);
    changeSettings(next);
  };

  // Saved views: per structure in the browser; a link carries one in its fragment.
  const storedViews = useMemo(
    () => (model ? readSavedViews(browserStorage(), model) : []),
    [model],
  );
  const savedViews =
    savedViewsEdit !== undefined && savedViewsEdit.model === model
      ? savedViewsEdit.views
      : storedViews;
  const changeSavedViews = (views: readonly SavedView[]) => {
    if (!model) return;
    setSavedViewsEdit({ model, views });
    writeSavedViews(browserStorage(), model, views);
  };
  /**
   * The arrangement as it is now, under `name`. Its place is one on the map on screen, so focus
   * and mode are those of that map: Filter and the focus it is reduced to, whatever is wanted
   * next (another focus, or none, whose map has not arrived); on the whole map the focus that is
   * chosen, which pales the rest there.
   */
  const currentView = (name: string): SavedView => {
    const { width, height } = flowStore.getState();
    const shownFocus = filteredTo ?? focus;
    return {
      name,
      collapsed: [...collapsed].sort(),
      hiddenKinds: EDGE_KINDS.filter((kind) => hiddenKinds.has(kind)),
      lodMode,
      center: viewportToCenter(getViewport(), { width, height }),
      ...(shownFocus ? { focus: shownFocus } : {}),
      ...(filteredTo ? { focusMode: 'filter' as const } : {}),
      ...(settings.closeGaps ? { closeGaps: true as const } : {}),
      ...(colorBy !== 'none' ? { colorBy } : {}),
      storyMode: settings.storyMode,
    };
  };
  // Moving the view waits for a canvas with a size: on load, the linked view arrives before it.
  const moveViewTo = useCallback(
    (center: ViewCenter) => {
      whenCanvasReady(flowStore, () => {
        const { width, height } = flowStore.getState();
        const to = centerToViewport(center, { width, height });
        moveOnArrangement(
          lodMode === 'auto' ? lodForZoom(center.zoom, zoomLod, lodConfig) : undefined,
          () => ({ to, duration: REVEAL_DURATION_MS }),
        );
      });
    },
    [flowStore, moveOnArrangement, lodMode, zoomLod, lodConfig],
  );
  // A view that was applied: its place is still to be shown (`pendingCentre`).
  const [viewRequest, setViewRequest] = useState(0);
  const applyView = useCallback(
    (view: SavedView) => {
      if (!model) return;
      setCollapsedEdit({ model, ids: new Set(view.collapsed) });
      setHiddenKindsEdit({ model, kinds: new Set(view.hiddenKinds) });
      setLodMode(view.lodMode);
      // The view says what is focused and how: what was asked of the map before no longer holds.
      setPendingGoTo(undefined);
      setFilterNote(undefined);
      setFocusEdit((previous) =>
        previous?.model === model && sameFocus(previous.focus, view.focus)
          ? previous
          : { model, focus: view.focus },
      );
      const viewColor = viewColorBy(model, view.colorBy);
      const nextColor = viewColor.colorBy;
      setColorNote(viewColor.note === undefined ? undefined : { model, text: viewColor.note });
      const nextStory = view.storyMode ?? settings.storyMode;
      // A view with a focus says how it is shown: one without the mode was saved on the whole
      // map, and its place only means something there. Without a focus the mode is left alone.
      const nextMode = view.focus ? (view.focusMode ?? 'focus') : settings.focusMode;
      // The map closed up or not, as it was saved: the place is one of that arrangement.
      const nextClose = view.closeGaps === true;
      // Laid out with or without the lists, as the level of the view has it: the place is one
      // of that layout, which the view then starts on.
      const level =
        view.lodMode === 'auto' ? lodForZoom(view.center.zoom, undefined, lodConfig) : view.lodMode;
      setLinesDrawn(level === 'detail');
      if (
        nextColor !== settings.colorBy ||
        nextStory !== settings.storyMode ||
        nextMode !== settings.focusMode ||
        nextClose !== settings.closeGaps
      ) {
        changeSettings({
          ...settings,
          colorBy: nextColor,
          storyMode: nextStory,
          focusMode: nextMode,
          closeGaps: nextClose,
        });
      }
      // The place: taken by the layout that arrives for the view as the place it starts from —
      // or, when the view needs no other layout, moved to (the effect below). A view saved on a
      // filtered map says so even when its focus is gone: its place is none on the whole map.
      pendingCentre.current = {
        model,
        center: view.center,
        filtered: view.focusMode === 'filter',
      };
      setViewRequest((count) => count + 1);
    },
    [model, settings, changeSettings, lodConfig],
  );
  useEffect(() => {
    const centre = pendingCentre.current;
    if (!centre || centre.model !== model || layoutPending || !layout) return;
    pendingCentre.current = undefined;
    // The view goes somewhere on purpose: it no longer rests where a fit put it.
    refit.current = undefined;
    // Saved on a map reduced to its focus, which cannot be shown (the focus is not among the
    // loaded data, is gone from the structure, or leaves nothing out): the place is one of
    // another arrangement.
    if (centre.filtered && !filteredTo) fitMap();
    else moveViewTo(centre.center);
  }, [viewRequest, layoutPending, layout, filteredTo, model, moveViewTo, fitMap]);
  const copyViewLink = async (view: SavedView | undefined): Promise<boolean> => {
    const hash = viewLinkHash(view ?? currentView(''));
    const url = `${window.location.href.split('#')[0]}${hash}`;
    // The address bar shows the link as well (and a reload comes back to the view); the
    // clipboard is not available everywhere (file://, or denied).
    window.history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  };
  // A link with a view (`#view=…`) is applied once the model it was made for is drawn.
  const linkedViewApplied = useRef<ArchitectureModel>(undefined);
  useEffect(() => {
    if (!model || !flow || linkedViewApplied.current === model) return;
    const linked = viewFromLinkHash(window.location.hash, model);
    if (!linked) {
      linkedViewApplied.current = model;
      return;
    }
    // The flow changes often while the page settles; a run that is cut short is scheduled again.
    let cancelled = false;
    void afterNextPaint().then(() => {
      if (cancelled || linkedViewApplied.current === model) return;
      linkedViewApplied.current = model;
      applyView(linked);
    });
    return () => {
      cancelled = true;
    };
  }, [model, flow, applyView]);
  const focusName = (): string | undefined => {
    if (!focus || !model) return undefined;
    if (focus.type === 'flow') return model.flows.find((f) => f.id === focus.id)?.name;
    const item = overlay?.byId.get(focus.id);
    return item ? `#${item.id} ${item.title}` : `#${focus.id}`;
  };

  // Focus / Filter: the switch is the remembered choice of how a focus is shown, with or without
  // one. What it means for the map is said beside it, of the map that is on screen.
  const filterOn = settings.focusMode === 'filter';
  const switchFilter = (on: boolean) => {
    // The reader's own choice: nothing waits for another map any more — no place of a view
    // either —, and nothing is left to say.
    setPendingGoTo(undefined);
    setFilterNote(undefined);
    pendingCentre.current = undefined;
    setFocusMode(on ? 'filter' : 'focus');
  };
  // A focus that Filter cannot reduce the map to: it involves every node, so there is nothing to
  // leave out, or none (or is not among the loaded data), so there would be nothing to draw.
  const focusInvolvesNothing = wantedFocused === undefined || wantedFocused.nodes.size === 0;
  const filterHint = (): string => {
    if (!filterOn) return 'The rest of the map is paled.';
    const rule = 'The rest is not drawn and what remains is laid out again.';
    if (!focus) return `${rule} Applies once a focus is chosen.`;
    if (model && flow && drawnModel && filteredTo) {
      return `Not drawn: ${model.nodes.size - drawnModel.nodes.size} of ${model.nodes.size} nodes.`;
    }
    // On its way: one line, like the texts before and after it, so that nothing below it moves.
    if (flow && layoutPending) return 'The map is being laid out again…';
    if (!flow) return rule;
    return focusInvolvesNothing
      ? 'The focus involves nothing on the map: the whole map is shown, paled.'
      : 'The focus leaves nothing out: the whole map is shown.';
  };
  const focusBarState = (): string | undefined => {
    if (!filterOn || !flow) return undefined;
    if (filteredTo) {
      return sameFocus(focus, filteredTo) ? ' · the rest of the map is not drawn' : undefined;
    }
    if (layoutPending) return undefined;
    return focusInvolvesNothing
      ? ' · nothing of it is on the map: the whole map is shown, paled'
      : ' · nothing to leave out: the whole map is shown';
  };
  // The search and the detail panel list the whole model. What the filtered map on screen leaves
  // out is marked there before it is clicked: going to it switches Filter off.
  const filteredMap = useMemo((): FilteredMap | undefined => {
    if (!filteredTo || !drawnModel) return undefined;
    const edgeIds = new Set(drawnModel.edges.map((edge) => edge.id));
    return {
      showsNode: (id) => drawnModel.nodes.has(id),
      showsEdge: (id) => edgeIds.has(id),
    };
  }, [filteredTo, drawnModel]);
  const searchOutside = useMemo(
    (): SearchOutside | undefined =>
      filteredTo && drawnModel
        ? {
            node: (id) => !drawnModel.nodes.has(id),
            workItem: (id) => !modelShows(drawnModel, { type: 'workitem', id }, overlay),
          }
        : undefined,
    [filteredTo, drawnModel, overlay],
  );
  // The selected thing itself may be one of those (selected before the map was filtered): its
  // panel stays, says so and offers the way to it — unless the map that has it is on its way
  // already (Filter was just left, or another focus chosen).
  const selectionOutside =
    selection !== undefined &&
    filteredTo !== undefined &&
    drawnModel !== undefined &&
    !modelShows(drawnModel, selection, overlay) &&
    wantedDrawn !== undefined &&
    !modelShows(wantedDrawn.model, selection, wantedOverlay);
  const showSelectionOnMap = () => {
    if (selection?.type === 'node') goToNode(selection.id);
    else if (selection?.type === 'edge') goToEdge(selection.id);
    else if (selection?.type === 'workitem') goToWorkItem(selection.id);
  };

  const mapDrawn = flow !== undefined;
  // The level the zoom has reached while the map is still drawn at another one: closed up in
  // Auto, the level follows once the view rests. A fit of the app is not such a wait.
  const pendingLevel =
    lodMode === 'auto' && !fitting && zoomLod !== drawnLevel ? zoomLod : undefined;
  // What the tabs of the control panel say on the rail, where the controls themselves may be
  // out of sight: the level drawn (and the one to come), that something is hidden or paled, how
  // many views are kept.
  const fileNames = [source?.name, workLoad?.source?.name].filter((name) => name !== undefined);
  const marks: ControlTabMarks = {
    level: mapDrawn
      ? {
          ...LOD_MARKS[drawnLevel],
          pinned: lodMode !== 'auto',
          pending: pendingLevel && LOD_MARKS[pendingLevel].name,
        }
      : undefined,
    hiding:
      hiddenKinds.size > 0 ||
      focus !== undefined ||
      (mapDrawn && edgesHeldBack) ||
      (filterChoices !== undefined && filterChoices.shown < filterChoices.total),
    views: savedViews.length,
    files: fileNames.length > 0 ? fileNames.join(', ') : undefined,
  };

  return (
    <div
      className="app"
      data-version={APP_VERSION}
      data-load={load.status}
      data-workitems={work.status === 'done' ? workItems.length : undefined}
      data-story-mode={flow && shownWorkItems ? shownWorkItems.mode : undefined}
      data-collapsed-count={collapsed.size}
      data-lod={flow ? drawnLevel : undefined}
      data-lod-mode={flow ? lodMode : undefined}
      data-zoom-lod={flow ? zoomLod : undefined}
      data-lines-laid-out={
        flow
          ? linesDrawn === linesWanted &&
            current?.workItems === workItemView &&
            current?.drawn === wantedDrawn
          : undefined
      }
      data-level-settled={flow ? drawnLevel === lodLevel : undefined}
      data-compact-collapsed={settings.compactCollapsed}
      data-close-gaps={flow ? settings.closeGaps : undefined}
      data-arrangement={
        flow && arranged
          ? arranged === reference
            ? 'full'
            : arranged.key.split('~')[1]
          : undefined
      }
      data-layout-size={
        flow && layout
          ? `${Math.round(layout.bounds.width)}x${Math.round(layout.bounds.height)}`
          : undefined
      }
      data-show-rows={settings.showRows}
      data-positions-unlocked={positionsUnlocked}
      data-moved-count={byHand.positions.size}
      data-resized-count={resizedIds.size}
      data-selection={selection ? `${selection.type}:${selection.id}` : undefined}
      data-hidden-kinds={EDGE_KINDS.filter((kind) => hiddenKinds.has(kind)).join(' ')}
      data-focus={focus ? `${focus.type}:${focus.id}` : undefined}
      data-focus-mode={model ? settings.focusMode : undefined}
      data-filtered={flow && filteredTo ? `${filteredTo.type}:${filteredTo.id}` : undefined}
      data-drawn-nodes={flow ? drawnModel?.nodes.size : undefined}
      data-drawn-edges={flow ? drawnModel?.edges.length : undefined}
      data-layout-pending={flow ? layoutPending : undefined}
      data-color-by={flow ? colorBy : undefined}
      data-heat={flow ? settings.heat : undefined}
      data-progress={flow ? settings.progress : undefined}
      data-edges-on-demand={flow ? settings.edgesOnDemand : undefined}
      data-edges-held-back={flow ? edgesHeldBack : undefined}
      data-panel-tab={panelTab}
      data-panel-collapsed={panelCollapsed}
    >
      {/* The heading of the page: the one in the head of the control panel goes with its body. */}
      {panelCollapsed && <h1 className="visually-hidden">Architecture Map</h1>}
      <ControlPanel
        tab={panelTab}
        collapsed={panelCollapsed}
        available={model ? CONTROL_TABS : FILES_ONLY}
        onChange={changePanel}
        marks={marks}
        head={
          <>
            <h1>Architecture Map</h1>
            <span
              id="app-version"
              className="app-version"
              title={`Architecture Map, version ${APP_VERSION}`}
            >
              {APP_VERSION}
            </span>
            {(source || workLoad?.source) && (
              <div className="cp-files">
                {source && (
                  <span
                    id="source-name"
                    className="source-name"
                    data-origin={source.origin}
                    title={`Structure from ${source.name}`}
                  >
                    {source.name}
                  </span>
                )}
                {workLoad?.source && (
                  <span
                    id="workitems-source"
                    className="source-name"
                    data-origin={workLoad.source.origin}
                    title={`Work items from ${workLoad.source.name}`}
                  >
                    {workLoad.source.name}
                  </span>
                )}
              </div>
            )}
          </>
        }
        search={
          model && flow ? (
            <SearchBox
              key={loadId}
              model={model}
              workItems={overlay?.shown}
              onChoose={goToNode}
              onChooseWorkItem={goToWorkItem}
              inputRef={searchInput}
              outside={searchOutside}
              onLeave={leaveSearch}
            />
          ) : undefined
        }
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        onSearch={focusSearch}
        actions={
          <>
            {/* Always at hand, whatever the panel shows: the files read again, the whole map. */}
            {currentEntry && (
              <button
                type="button"
                id="reload-files"
                className="cp-rail-button"
                title={`Read ${recentMapLabel(currentEntry)} again from the disk`}
                onClick={() => void openRecent(currentEntry, true)}
              >
                <PanelIcon name="reload" />
                <span className="cp-tab-label">Reload</span>
              </button>
            )}
            <button
              type="button"
              id="fit-view"
              className="cp-rail-button"
              disabled={!flow}
              title="Fit the whole map into the view"
              onClick={() => fitMap(200)}
            >
              <PanelIcon name="fit" />
              <span className="cp-tab-label">Fit view</span>
            </button>
          </>
        }
        panels={{
          detail: (
            <DetailTab
              drawn={mapDrawn}
              lodMode={lodMode}
              lodLevel={drawnLevel}
              pendingLevel={pendingLevel}
              lodConfig={lodConfig}
              onChooseLod={chooseLod}
              collapsedCount={collapsed.size}
              canCollapseAll={groups.length > 0 && !allCollapsed}
              onCollapseAll={collapseAll}
              onExpandAll={expandAll}
              settings={settings}
              onChange={changeSettings}
              hasWorkItems={workItems.length > 0}
              onChooseStoryMode={chooseStoryMode}
            />
          ),
          visibility: (
            <VisibilityTab
              drawn={mapDrawn}
              focusChooser={
                // Offered as soon as there is a structure, not only once it is drawn.
                model && (model.flows.length > 0 || workItems.length > 0)
                  ? {
                      flows: model.flows,
                      items: overlay?.shown ?? NO_WORK_ITEMS,
                      focus,
                      focusName: focusName(),
                      onChoose: chooseFocus,
                    }
                  : undefined
              }
              filterOn={filterOn}
              onFilterChange={switchFilter}
              filterHint={filterHint()}
              hiddenKinds={hiddenKinds}
              kindCounts={kindCounts}
              onToggleKind={toggleKind}
              settings={settings}
              onChange={changeSettings}
              workItems={filterChoices}
            />
          ),
          lenses: (
            <LensesTab
              drawn={mapDrawn}
              settings={settings}
              onChange={changeLenses}
              colorChoices={colorChoices}
              hasWorkItems={workItems.length > 0}
            />
          ),
          layout: (
            <LayoutTab
              drawn={mapDrawn}
              settings={settings}
              onChange={changeSettings}
              positionsUnlocked={positionsUnlocked}
              onToggleUnlocked={() => setPositionsUnlocked((unlocked) => !unlocked)}
              movedCount={byHand.positions.size}
              resizedCount={resizedIds.size}
              onResetPositions={resetPositions}
            />
          ),
          views: (
            <ViewsTab
              drawn={mapDrawn}
              active={panelTab === 'views' && !panelCollapsed}
              views={savedViews}
              onSave={(name) => changeSavedViews(withSavedView(savedViews, currentView(name)))}
              onApply={applyView}
              onDelete={(name) => changeSavedViews(withoutSavedView(savedViews, name))}
              onCopyLink={copyViewLink}
            />
          ),
          files: (
            <FilesTab
              model={model}
              workItems={
                workLoad?.source
                  ? {
                      origin: workLoad.source.origin,
                      name: workLoad.source.name,
                      count: workItems.length,
                      coverage,
                    }
                  : undefined
              }
              onOpen={pick}
              recents={recents}
              currentRecent={currentRecent}
              onOpenRecent={openRecentById}
              onForgetRecent={forgetRecent}
            />
          ),
        }}
      />
      <div className="app-column">
        {fileError !== undefined && (
          <p id="file-error" className="notice notice-error" role="alert">
            {fileError}
          </p>
        )}
        {model && colorNote?.model === model && colorBy === 'none' && (
          <p id="view-note" className="notice" role="status">
            {colorNote.text}
          </p>
        )}
        {focus && model && (
          <FocusBar
            filterOn={filterOn}
            onFilterChange={switchFilter}
            name={focusName() ?? '—'}
            counts={
              focused
                ? ` · ${plural(focused.nodes.size, 'node')} · ${plural(focused.edges.size, 'edge')}`
                : ' · not among the loaded data'
            }
            state={focusBarState()}
            note={filterNote?.model === model ? filterNote.text : undefined}
            showVisible={!sameSelection(selection, focus)}
            onShow={() => (focus.type === 'flow' ? select(focus) : goToWorkItem(focus.id))}
            onClear={() => setFocus(undefined)}
          />
        )}

        <main className="app-main">
          {load.status === 'loading' && (
            <p id="load-status" className="status">
              Loading architecture…
            </p>
          )}
          {load.status === 'empty' && (
            <div id="empty-state" className="empty-state">
              <h2>No architecture loaded</h2>
              <p id="load-status">{load.reason}</p>
              {recents.length > 0 && (
                <div className="recent-start">
                  <h3>Open again</h3>
                  <RecentList
                    id="recent-start"
                    recents={recents}
                    onOpen={openRecentById}
                    onForget={forgetRecent}
                  />
                </div>
              )}
              <p>
                <button type="button" className="primary" onClick={() => pick('map')}>
                  Open YAML…
                </button>
              </p>
              <p className="hint">
                or drop an architecture.yaml file — with its workitems.json — anywhere on this page.
              </p>
              <p className="hint" id="template-hint">
                {TEMPLATE_NOTE}
              </p>
            </div>
          )}
          {parsed && !model && (
            <p id="load-status" className="status">
              {source?.name} has errors — see the diagnostics below.
            </p>
          )}
          {isEmptyModel && (
            <p id="load-status" className="status">
              {source?.name} contains no domains — nothing to draw.
            </p>
          )}
          {model && !isEmptyModel && !current && (
            <p id="layout-status" className="status">
              Computing layout…
            </p>
          )}
          {layoutPending && renderError === undefined && (
            <p id="layout-status" className="status layout-pending" role="status">
              Computing layout…
            </p>
          )}
          {renderError !== undefined && (
            <p id="layout-status" className="status notice-error" role="alert">
              Layout failed: {renderError}
            </p>
          )}
          {model && flow && shownFlow && layout && (
            <div className="map-row">
              <MapCanvas
                key={canvasKey}
                flow={shownFlow}
                onToggleCollapse={toggleCollapsed}
                workItemCanvas={workItemCanvas}
                onSelect={select}
                initialViewport={initialViewport}
                contentBounds={layout.bounds}
                onViewportSettled={filteredTo ? noteFilteredView : storeViewport}
                positionsUnlocked={positionsUnlocked}
                onNodeMoved={moveNode}
                onNodeResized={resizeNode}
                onNodeSizeReset={resetNodeSize}
                lenses={lenses}
                onHoverNode={edgesHeldBack ? setHoveredNode : undefined}
                onStarted={canvasStarted}
                fitTo={fitCanvas}
                onFit={fitFromControls}
              />
              <div className="map-legends">
                <EdgeLegend hiddenKinds={hiddenKinds} />
                <ColorLegend coloring={coloring} />
              </div>
              {selection && (
                <FilterContext.Provider value={filteredMap}>
                  <DetailPanel
                    model={model}
                    rows={showRows && wholePlacement ? wholePlacement : NO_ROW_PLACEMENT}
                    selection={selection}
                    edges={flow.edges}
                    hiddenKinds={hiddenKinds}
                    onGoToNode={goToNode}
                    onGoToEdge={goToEdge}
                    overlay={overlay}
                    storyMode={shownWorkItems?.mode ?? 'off'}
                    onGoToWorkItem={goToWorkItem}
                    onChooseStoryMode={chooseStoryMode}
                    onGoToFlow={goToFlow}
                    focus={focus}
                    onFocus={setFocus}
                    heat={heat}
                    progress={progress}
                    drawnHeat={drawnHeat}
                    drawnProgress={drawnProgress}
                    drawnIds={visible}
                    outside={selectionOutside}
                    onShowOnMap={showSelectionOnMap}
                    onClose={clearSelection}
                  />
                </FilterContext.Provider>
              )}
            </div>
          )}
        </main>

        {parsed && (
          <DiagnosticsPanel
            key={`${loadId}:${work.status === 'done' ? work.loadId : 'loading'}`}
            errors={parsed.errors}
            warnings={parsed.warnings}
            workItems={workDiagnostics}
            hints={hints}
          />
        )}
      </div>
      <input
        ref={fileInput}
        id="yaml-file"
        type="file"
        accept=".yaml,.yml"
        hidden
        onChange={onPick('structure')}
      />
      <input
        ref={workItemInput}
        id="workitems-file"
        type="file"
        accept=".json"
        hidden
        onChange={onPick('workitems')}
      />
      {dragging && (
        <div id="drop-overlay" className="drop-overlay">
          Drop a YAML file (structure) or a JSON file (work items) to load it
        </div>
      )}
    </div>
  );
}
