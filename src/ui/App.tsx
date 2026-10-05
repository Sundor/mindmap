import { ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  availableIterations,
  availableStates,
  applyPositionOverrides,
  buildFlow,
  buildWorkItemOverlay,
  computeLayout,
  NO_POSITION_OVERRIDES,
  readPositions,
  withNodeMoved,
  withoutRows,
  writePositions,
  type Position,
  type PositionOverrides,
  EDGE_KINDS,
  effectiveLod,
  expandToOpen,
  expandToReveal,
  groupIds,
  highlightFlow,
  LOD_LEVELS,
  LOD_MODES,
  lodModeToDraw,
  lodRevealZoom,
  minLodForNode,
  NODE_LEVEL_NAMES,
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
  renderedSelection,
  resolveSelection,
  revealZoomForNodes,
  sameSelection,
  STORY_MODE_LABELS,
  STORY_MODES,
  toggleEdgeKind,
  unionRect,
  usableWorkItemFilter,
  viewportKeepingPlace,
  viewportToReveal,
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
  type DisplaySettings,
  type EdgeKind,
  type FlowGraph,
  type LayoutResult,
  type LodConfig,
  type LodMode,
  type NodeContent,
  type Rect,
  type Selection,
  type StoryMode,
  type Viewport,
  type WorkItemOverlay,
  type WorkItemSummary,
  authoringHints,
  centerToViewport,
  colorByOptions,
  focusFlow,
  focusSet,
  heatByWork,
  nodeColoring,
  progressByNode,
  quietEdges,
  readSavedViews,
  usableColorBy,
  viewFromLinkHash,
  viewLinkHash,
  viewportToCenter,
  withoutSavedView,
  withSavedView,
  writeSavedViews,
  type Focus,
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
import { ColorLegend } from './ColorLegend';
import { DETAIL_PANEL_WIDTH, FIT_VIEW_OPTIONS } from './constants';
import { DetailPanel } from './DetailPanel';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { KindFilters } from './KindFilters';
import { MapCanvas } from './MapCanvas';
import type { NodeLenses } from './nodeLensContext';
import { RecentList, RecentMenu } from './RecentMenu';
import { SearchBox } from './SearchBox';
import { SettingsPanel, type WorkItemFilterChoices } from './SettingsPanel';
import { useLodLevel } from './useLodLevel';
import { APP_VERSION } from './version';
import { ViewsMenu } from './ViewsMenu';
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
}

type LayoutState =
  | {
      readonly model: ArchitectureModel;
      readonly workItems: WorkItemView;
      readonly layout: LayoutResult;
      /**
       * Where the view starts on this layout when it replaces another one of the same model: the
       * place the user was looking at (`viewportKeepingPlace`).
       */
      readonly startViewport?: Viewport;
      readonly error?: undefined;
    }
  | {
      readonly model: ArchitectureModel;
      readonly workItems: WorkItemView;
      readonly layout?: undefined;
      readonly startViewport?: undefined;
      readonly error: string;
    };

/** The collapsed set as changed by the user, for the model it belongs to. */
interface CollapsedEdit {
  readonly model: ArchitectureModel;
  readonly ids: ReadonlySet<string>;
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

const NOTHING_COLLAPSED: ReadonlySet<string> = new Set();
const NO_KINDS_HIDDEN: ReadonlySet<EdgeKind> = new Set();
const NO_WORK_ITEMS: readonly WorkItemSummary[] = [];

const STORY_MODE_HINTS: Readonly<Record<StoryMode, string>> = {
  off: 'Show nothing about work items on the map (the detail panel still lists them).',
  stories: 'List the stories, bugs, features and epics of each node; counts when zoomed out.',
  tasks: 'Also list the tasks under each story (first words; the full text is in the panel).',
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

const LOD_LABELS: Readonly<Record<LodMode, string>> = {
  auto: 'Auto',
  domains: 'Domains',
  components: 'Components',
  subcomponents: 'Subcomponents',
  detail: 'Everything',
};

function percent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** Tooltips of the level-of-detail buttons: what each mode shows. */
function lodHint(mode: LodMode, config: LodConfig): string {
  switch (mode) {
    case 'auto':
      return `Follow the zoom: domains below ${percent(config.componentsZoom)}, components up to ${percent(config.subcomponentsZoom)}, subcomponents up to ${percent(config.detailZoom)}, everything beyond (adjustable under Settings).`;
    case 'domains':
      return 'Always show domains only, with the edges merged between domains.';
    case 'components':
      return 'Always show components; subcomponents and edge labels stay hidden.';
    case 'subcomponents':
      return 'Always show subcomponents and edge labels; what is inside the boxes (work items) stays hidden.';
    case 'detail':
      return 'Always show everything, including what is inside the boxes (work items).';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const changeSettings = useCallback((next: DisplaySettings) => {
    setSettings(next);
    writeDisplaySettings(browserStorage(), next);
  }, []);
  const lodConfig = settings.lod;
  const zoomLod = useLodLevel(lodConfig);
  // 'auto' follows the zoom; any other mode pins that level whatever the zoom.
  const [lodMode, setLodMode] = useState<LodMode>('auto');
  const lodLevel = effectiveLod(lodMode, zoomLod);

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
  // level therefore lays the map out again, keeping the place in view.
  const linesWanted = lodLevel === 'detail';
  const [linesDrawn, setLinesDrawn] = useState(linesWanted);
  /** Until when (performance.now()) an animated move of the view started by the app is under way. */
  const movingUntil = useRef(0);
  /** Where that move is going. */
  const movingTo = useRef<Viewport>(undefined);
  useEffect(() => {
    if (linesWanted === linesDrawn) return;
    let timer: ReturnType<typeof setTimeout>;
    // Not while the app is moving the view: the move may well end on the other side again.
    const settle = () => {
      const wait = movingUntil.current - performance.now();
      if (wait > 0) timer = setTimeout(settle, wait + 50);
      else setLinesDrawn(linesWanted);
    };
    // A pinned level is the user's click: at once. The zoom has to come to rest first.
    timer = setTimeout(settle, lodMode === 'auto' ? LINES_SETTLE_MS : 0);
    return () => clearTimeout(timer);
  }, [linesWanted, linesDrawn, lodMode]);
  const workItemView = useMemo((): WorkItemView | undefined => {
    if (!model || work.status !== 'done') return undefined;
    const overlay = buildWorkItemOverlay(model, workItems, workFilter);
    return {
      overlay,
      mode: storyMode,
      content: workItemContent(overlay, linesDrawn ? storyMode : 'off'),
    };
  }, [model, work.status, workItems, storyMode, workFilter, linesDrawn]);
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

  // Layout: once per loaded model and per work-item content (new data, another story mode or
  // filter: an explicit action), never on zoom or collapse. When it replaces
  // another layout of the same model, the view keeps the place the user was looking at: the node
  // in the middle of the canvas stays there, at the same zoom.
  const shownLayout = useRef<{ model: ArchitectureModel; layout: LayoutResult }>(undefined);
  const { showRows } = settings;
  useEffect(() => {
    if (!model || !workItemView) return;
    let cancelled = false;
    const compute = async (): Promise<LayoutState> => {
      // ELK runs on the main thread and takes seconds on a large model: show the status first.
      await afterNextPaint();
      if (cancelled) return { model, workItems: workItemView, error: 'cancelled' };
      try {
        // Rows hidden: the same model without its rows, arranged by the connections alone.
        const computed = await computeLayout(showRows ? model : withoutRows(model), {
          content: workItemView.content,
        });
        return { model, workItems: workItemView, layout: computed };
      } catch (err: unknown) {
        return { model, workItems: workItemView, error: errorMessage(err) };
      }
    };
    void compute().then((state) => {
      if (cancelled) return;
      const previous = shownLayout.current;
      if (state.layout && previous?.model === model && previous.layout !== state.layout) {
        const { width, height } = flowStore.getState();
        // A move of the view that is still under way ends with the canvas it runs on. The new
        // canvas starts where the move was going, not at the point it happened to have reached
        // — a zoom towards the Everything level would stop short of it, and stay there.
        const moving = performance.now() < movingUntil.current ? movingTo.current : undefined;
        const startViewport = viewportKeepingPlace(
          moving ?? getViewport(),
          { width, height },
          previous.layout.absolute,
          state.layout.absolute,
        );
        setLayoutState({ ...state, startViewport });
      } else {
        setLayoutState(state);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [model, workItemView, showRows, flowStore, getViewport]);

  // While a layout for other work-item content is on its way, the previous one of this model
  // stays on screen, drawn with the content it was computed for.
  const current = layoutState?.model === model ? layoutState : undefined;
  const computedLayout = current?.layout;

  // Positions set by hand: while unlocked, groups and nodes can be dragged. The
  // moved positions are overrides on top of the computed layout, kept in the browser per layout
  // (rows shown or hidden and each story mode have their own); nothing else moves.
  const [positionsUnlocked, setPositionsUnlocked] = useState(false);
  const [positionEdit, setPositionEdit] = useState<{
    readonly key: string;
    readonly positions: PositionOverrides;
  }>();
  const positionsKey = computedLayout?.key;
  const storedPositions = useMemo(
    () =>
      positionsKey === undefined
        ? NO_POSITION_OVERRIDES
        : readPositions(browserStorage(), positionsKey),
    [positionsKey],
  );
  const positions =
    positionEdit !== undefined && positionEdit.key === positionsKey
      ? positionEdit.positions
      : storedPositions;
  const layout = useMemo(
    () =>
      model && computedLayout
        ? applyPositionOverrides(model, computedLayout, positions)
        : computedLayout,
    [model, computedLayout, positions],
  );
  const changePositions = useCallback(
    (next: PositionOverrides) => {
      if (positionsKey === undefined) return;
      setPositionEdit({ key: positionsKey, positions: next });
      writePositions(browserStorage(), positionsKey, next);
    },
    [positionsKey],
  );
  const moveNode = useCallback(
    (id: string, delta: Position) => {
      if (!layout) return;
      const next = withNodeMoved(positions, layout, id, delta);
      if (next !== positions) changePositions(next);
    },
    [layout, positions, changePositions],
  );
  const resetPositions = () => changePositions(NO_POSITION_OVERRIDES);
  useEffect(() => {
    shownLayout.current = model && layout ? { model, layout } : undefined;
  }, [model, layout]);
  // Another story mode, filter or work-items file: its layout is being computed.
  const layoutPending =
    current !== undefined && workItemView !== undefined && current.workItems !== workItemView;
  const shownWorkItems = current?.workItems;
  const overlay = shownWorkItems?.overlay;

  // The lenses. Focus: what a flow or a work item involves, from the overlay the
  // canvas shows. Heat: the open work in each box, from the same overlay (so the filter counts).
  // Progress: done over all, from an overlay with the iteration alone — a state filter must
  // not make a box look untouched. Colour: by an attribute or a metric of the structure.
  const focus = focusEdit !== undefined && focusEdit.model === model ? focusEdit.focus : undefined;
  const focused = useMemo(
    () => (model ? focusSet(model, focus, overlay) : undefined),
    [model, focus, overlay],
  );
  const heat = useMemo(
    () => (settings.heat && model && overlay ? heatByWork(model, overlay) : undefined),
    [settings.heat, model, overlay],
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
  const colorBy = model ? usableColorBy(model, settings.colorBy) : 'none';
  const coloring = useMemo(
    () => (model ? nodeColoring(model, colorBy) : undefined),
    [model, colorBy],
  );
  const colorChoices = useMemo(() => (model ? colorByOptions(model) : []), [model]);
  const lenses = useMemo(
    (): NodeLenses => ({
      heat,
      progress,
      colors: coloring && coloring.byNode.size > 0 ? coloring.byNode : undefined,
    }),
    [heat, progress, coloring],
  );
  const hints = useMemo(() => (model ? authoringHints(model, overlay) : []), [model, overlay]);
  // A valid file may declare no domains at all: say so instead of showing a blank canvas.
  const isEmptyModel = model !== undefined && model.nodes.size === 0;

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
  const changeCollapsed = useCallback(
    (change: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
      if (!model) return;
      setCollapsedEdit((previous) => ({
        model,
        ids: change(previous?.model === model ? previous.ids : storedCollapsed),
      }));
    },
    [model, storedCollapsed],
  );
  useEffect(() => {
    if (collapsedEdit) writeCollapsed(browserStorage(), collapsedEdit.model, collapsedEdit.ids);
  }, [collapsedEdit]);

  const toggleCollapsed = useCallback(
    (id: string) => {
      changeCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      });
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
  // the model's edges *before* the rollup, so aggregates and their counts cover what is shown.
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
    () => (model ? withoutEdgeKinds(model, hiddenKinds) : undefined),
    [model, hiddenKinds],
  );
  const kindCounts = useMemo(() => {
    const counts: Record<EdgeKind, number> = { dataflow: 0, dependency: 0, control: 0, config: 0 };
    for (const edge of model?.edges ?? []) counts[edge.kind] += 1;
    return counts;
  }, [model]);

  // Nodes and edges for the current view. Only visibility and the edge rollup depend on the
  // collapsed set and the level of detail: positions and sizes always come from the one layout,
  // which the effect above computes per model alone, so zooming never lays anything out.
  const flowState = useMemo((): FlowState | undefined => {
    if (!shownModel || !layout || shownModel.nodes.size === 0) return undefined;
    try {
      return {
        flow: buildFlow(shownModel, layout, {
          collapsedIds: collapsed,
          lodLevel,
          compactCollapsed: settings.compactCollapsed,
          draggable: positionsUnlocked,
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
    lodLevel,
    settings.compactCollapsed,
    positionsUnlocked,
    shownWorkItems,
  ]);
  const flow = flowState?.flow;
  const renderError = current?.error ?? flowState?.error;

  // Selection. A node or an edge is held in model terms, so it survives
  // collapsing and zooming. An aggregate only means something while it is drawn: once its groups
  // are opened (or a filter leaves one member) it becomes that single edge or nothing, for good —
  // the state is adjusted while rendering, so it does not come back by itself later. Likewise a
  // work item that the filter now hides (or that another file does not have) is no longer selected.
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
  const select = useCallback(
    (next: Selection | undefined) => {
      if (!model) return;
      const pending = pendingWorkItemReveal.current;
      if (pending && !(next?.type === 'workitem' && next.id === pending.itemId)) {
        pendingWorkItemReveal.current = undefined;
      }
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
      if (model) setFocusEdit({ model, focus: next });
    },
    [model],
  );
  // Edges on demand holds at the coarse levels, where the edges are the clutter.
  const edgesQuiet =
    settings.edgesOnDemand && (lodLevel === 'domains' || lodLevel === 'components');
  // The flow as drawn: the selected element marked and everything outside its neighbourhood
  // dimmed; then what the focus does not involve paled; then, with edges on demand, every edge
  // hidden but those at the hovered or selected box and those of the focus.
  const shownFlow = useMemo(() => {
    if (!model || !flow) return flow;
    const rendered = renderedSelection(model, flow, selection, overlay);
    let shown = highlightFlow(flow, rendered);
    if (focused) shown = focusFlow(model, shown, focused);
    if (edgesQuiet) {
      const loud = new Set<string>();
      if (hoveredNode !== undefined) loud.add(hoveredNode);
      if (rendered?.type === 'node') loud.add(rendered.id);
      if (rendered?.type === 'workitem') for (const id of rendered.nodeIds) loud.add(id);
      shown = quietEdges(shown, loud, focused, rendered?.type === 'edge' ? rendered.id : undefined);
    }
    return shown;
  }, [model, flow, selection, overlay, focused, edgesQuiet, hoveredNode]);

  const toggleKind = (kind: EdgeKind) => {
    if (!model) return;
    const kinds = toggleEdgeKind(hiddenKinds, kind);
    setHiddenKindsEdit({ model, kinds });
    // A selected edge of a kind that is now hidden has nothing left to show.
    const selectedEdge =
      selection?.type === 'edge' ? model.edges.find((edge) => edge.id === selection.id) : undefined;
    if (selectedEdge && kinds.has(selectedEdge.kind)) clearSelection();
  };

  // Moves the view, only if needed, so that `target` (canvas coordinates) is on screen at a zoom
  // of at least `minZoom`; `primary` is the part kept on screen when not all of it fits.
  const panelOpen = selection !== undefined;
  const bringOnScreen = useCallback(
    (target: Rect, primary: Rect | undefined, minZoom: number) => {
      // The canvas as it will be once the detail panel is open beside it (the panel never takes
      // more than half the row, see `.detail-panel` in styles.css).
      const { width, height } = flowStore.getState();
      const size = {
        width: panelOpen ? width : Math.max(width - DETAIL_PANEL_WIDTH, width / 2),
        height,
      };
      const from = getViewport();
      const to = viewportToReveal(from, target, size, { minZoom, ...(primary ? { primary } : {}) });
      if (to === from) return;
      movingUntil.current = performance.now() + REVEAL_DURATION_MS + 100;
      movingTo.current = to;
      void setViewport(to, { duration: REVEAL_DURATION_MS });
    },
    [flowStore, panelOpen, getViewport, setViewport],
  );
  // Brings the given nodes on screen: opens the groups around them and, only if needed, pans
  // and zooms — at least far enough in for the level of detail to draw them.
  const reveal = useCallback(
    (ids: readonly string[]) => {
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
      const target = unionRect(
        ids.map((id) => layout.absolute.get(id)).filter((rect) => rect !== undefined),
      );
      if (!target) return;
      // When not everything fits at the zoom that draws it, the first node (the source of an
      // edge) is the one kept on screen.
      const [first] = ids;
      const primary = first === undefined ? undefined : layout.absolute.get(first);
      // Only the zoom-driven mode needs a zoom that draws the nodes.
      bringOnScreen(
        target,
        primary,
        mode === 'auto' ? revealZoomForNodes(model, ids, lodConfig) : 0,
      );
    },
    [model, layout, lodMode, lodConfig, changeCollapsed, bringOnScreen],
  );
  // Brings the work-item list of a node on screen, drawn: the node and the groups around it are
  // opened (a closed group shows a badge instead), a pinned level coarser than Everything is
  // raised to it, and in Auto mode the view zooms in to where Everything is shown — or, when the
  // Everything threshold is set beyond the zoom range, Everything is pinned.
  const revealWorkItems = useCallback(
    (nodeId: string, itemId: number) => {
      const box = layout?.absolute.get(nodeId);
      if (!model || !layout || !box || !shownWorkItems) return;
      // No room reserved yet (a coarser level is shown): come back once the layout with the
      // lists has arrived.
      pendingWorkItemReveal.current = layout.content.has(nodeId) ? undefined : { nodeId, itemId };
      changeCollapsed((collapsedNow) => {
        const next = expandToOpen(model, collapsedNow, [nodeId]);
        return next.size === collapsedNow.size ? collapsedNow : next;
      });
      const mode = lodModeToDraw(lodMode, 'detail', lodConfig);
      setLodMode(mode);
      // The name of the node with the list below it — not all of a large group, whose header
      // strip may be many times wider than the list at its left end — and, when even that does
      // not fit, the line of the item itself.
      const block = layout.content.get(nodeId);
      const lines = workItemLines(shownWorkItems.overlay, nodeId, shownWorkItems.mode);
      const list = block ? workItemLinesRect(block, lines) : undefined;
      const line = block ? workItemLineRect(block, lines, itemId) : undefined;
      const inCanvas = (rect: Rect): Rect => ({ ...rect, x: box.x + rect.x, y: box.y + rect.y });
      const target = list
        ? { x: box.x, y: box.y, width: list.x + list.width, height: list.y + list.height }
        : box;
      bringOnScreen(
        target,
        line ? inCanvas(line) : target,
        mode === 'auto' ? lodRevealZoom('detail', lodConfig) : 0,
      );
    },
    [model, layout, shownWorkItems, lodMode, lodConfig, changeCollapsed, bringOnScreen],
  );
  useEffect(() => {
    const pending = pendingWorkItemReveal.current;
    if (!pending || !layout?.content.has(pending.nodeId)) return;
    let cancelled = false;
    // Once the canvas for the new layout is up: it has its pan/zoom, its size, and the viewport
    // it starts from. Moving the view before that would be computed for a canvas of no size.
    let tries = 0;
    const run = () => {
      if (cancelled || pendingWorkItemReveal.current !== pending) return;
      const { panZoom, width, height, fitViewQueued } = flowStore.getState();
      if (panZoom === null || !(width > 0 && height > 0) || fitViewQueued) {
        tries += 1;
        if (tries < 120) requestAnimationFrame(run);
        return;
      }
      revealWorkItems(pending.nodeId, pending.itemId);
    };
    void afterNextPaint().then(run);
    return () => {
      cancelled = true;
    };
  }, [layout, revealWorkItems, flowStore]);
  const goToNode = useCallback(
    (id: string) => {
      pendingWorkItemReveal.current = undefined;
      reveal([id]);
      select({ type: 'node', id });
    },
    [reveal, select],
  );
  // A work item chosen in the panel or the search: selected, and the first node that draws its
  // line is opened and zoomed to. One that is not drawn (story mode Off, a task in Stories only,
  // a line under "+k more") shows the node it belongs to; the panel says why there is no line and
  // offers the mode that draws it — the story mode itself is only ever changed by the user,
  // because it lays the whole map out again.
  const goToWorkItem = useCallback(
    (id: number) => {
      select({ type: 'workitem', id });
      if (!shownWorkItems) return;
      const place = workItemPlace(shownWorkItems.overlay, shownWorkItems.mode, id);
      const [drawnOn] = place.drawnOn;
      const [listedOn] = place.nodeIds;
      if (drawnOn !== undefined) revealWorkItems(drawnOn, id);
      else if (listedOn !== undefined) reveal([listedOn]);
    },
    [shownWorkItems, select, reveal, revealWorkItems],
  );
  const selectWorkItem = useCallback((id: number) => select({ type: 'workitem', id }), [select]);
  // A flow chosen in a panel or the Focus selector: the map is focused on it, its panel opens,
  // and what it involves is brought on screen.
  const goToFlow = useCallback(
    (id: string) => {
      if (!model) return;
      const set = focusSet(model, { type: 'flow', id });
      if (!set) return;
      setFocus({ type: 'flow', id });
      select({ type: 'flow', id });
      reveal([...set.nodes]);
    },
    [model, setFocus, select, reveal],
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
    [model, storedHiddenKinds, reveal, select],
  );

  // Last viewport: restored on mount instead of fitting (the canvas checks that it
  // still shows some of the map, see MapCanvas); stored whenever the view comes to rest.
  // Read again for every layout of the model: a layout for other work-item content remounts the
  // canvas, which then starts from where the view was left.
  // A layout that replaces another one of the same model (another story mode, filter or
  // work-items file) starts from the place the user was looking at instead; should that show
  // nothing of the new map, the canvas fits the view like for any useless viewport.
  const layoutKey = layout?.key;
  const startViewport = current?.startViewport;
  const initialViewport = useMemo(
    () =>
      startViewport ??
      (model && layoutKey !== undefined ? readViewport(browserStorage(), model) : undefined),
    [model, layoutKey, startViewport],
  );
  const storeViewport = useCallback(
    (viewport: Viewport) => {
      if (model) writeViewport(browserStorage(), model, viewport);
    },
    [model],
  );

  // Shortcuts: "/" or Ctrl+K focuses the search box, Escape clears the selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const ctrlK =
        (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k';
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (ctrlK || (slash && !isTextEntry(event.target))) {
        if (!searchInput.current) return;
        event.preventDefault();
        searchInput.current.focus();
        searchInput.current.select();
      } else if (event.key === 'Escape' && !isTextEntry(event.target)) {
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection]);

  // What the diagnostics panel adds about the work items: problems of the file, tags
  // naming unknown nodes, and — of the items the filter shows — those without a comp: tag with
  // the tag coverage.
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
  /** The arrangement as it is now, under `name`. */
  const currentView = (name: string): SavedView => {
    const { width, height } = flowStore.getState();
    return {
      name,
      collapsed: [...collapsed].sort(),
      hiddenKinds: EDGE_KINDS.filter((kind) => hiddenKinds.has(kind)),
      lodMode,
      center: viewportToCenter(getViewport(), { width, height }),
      ...(focus ? { focus } : {}),
      ...(colorBy !== 'none' ? { colorBy } : {}),
      storyMode: settings.storyMode,
    };
  };
  // Moving the view waits for a canvas with a size: on load, the linked view arrives before it.
  const moveViewTo = useCallback(
    (center: ViewCenter) => {
      let tries = 0;
      const run = () => {
        const { panZoom, width, height, fitViewQueued } = flowStore.getState();
        if (panZoom === null || !(width > 0 && height > 0) || fitViewQueued) {
          tries += 1;
          if (tries < 120) requestAnimationFrame(run);
          return;
        }
        const to = centerToViewport(center, { width, height });
        movingUntil.current = performance.now() + REVEAL_DURATION_MS + 100;
        movingTo.current = to;
        void setViewport(to, { duration: REVEAL_DURATION_MS });
      };
      void afterNextPaint().then(run);
    },
    [flowStore, setViewport],
  );
  const applyView = useCallback(
    (view: SavedView) => {
      if (!model) return;
      setCollapsedEdit({ model, ids: new Set(view.collapsed) });
      setHiddenKindsEdit({ model, kinds: new Set(view.hiddenKinds) });
      setLodMode(view.lodMode);
      setFocusEdit({ model, focus: view.focus });
      const nextColor = view.colorBy === undefined ? 'none' : usableColorBy(model, view.colorBy);
      const nextStory = view.storyMode ?? settings.storyMode;
      if (nextColor !== settings.colorBy || nextStory !== settings.storyMode) {
        changeSettings({ ...settings, colorBy: nextColor, storyMode: nextStory });
      }
      moveViewTo(view.center);
    },
    [model, settings, changeSettings, moveViewTo],
  );
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

  return (
    <div
      className="app"
      data-version={APP_VERSION}
      data-load={load.status}
      data-workitems={work.status === 'done' ? workItems.length : undefined}
      data-story-mode={flow && shownWorkItems ? shownWorkItems.mode : undefined}
      data-collapsed-count={collapsed.size}
      data-lod={flow ? lodLevel : undefined}
      data-lod-mode={flow ? lodMode : undefined}
      data-zoom-lod={flow ? zoomLod : undefined}
      data-lines-laid-out={
        flow ? linesDrawn === linesWanted && current?.workItems === workItemView : undefined
      }
      data-compact-collapsed={settings.compactCollapsed}
      data-show-rows={settings.showRows}
      data-positions-unlocked={positionsUnlocked}
      data-moved-count={positions.size}
      data-selection={selection ? `${selection.type}:${selection.id}` : undefined}
      data-hidden-kinds={EDGE_KINDS.filter((kind) => hiddenKinds.has(kind)).join(' ')}
      data-focus={focus ? `${focus.type}:${focus.id}` : undefined}
      data-color-by={flow ? colorBy : undefined}
      data-heat={flow ? settings.heat : undefined}
      data-progress={flow ? settings.progress : undefined}
      data-edges-on-demand={flow ? settings.edgesOnDemand : undefined}
      data-edges-quiet={flow ? edgesQuiet : undefined}
    >
      <header className="toolbar">
        <h1>Architecture Map</h1>
        <span
          id="app-version"
          className="app-version"
          title={`Architecture Map, version ${APP_VERSION}`}
        >
          {APP_VERSION}
        </span>
        {source && (
          <span id="source-name" className="source-name" data-origin={source.origin}>
            {source.name}
          </span>
        )}
        {model && <ModelSummary model={model} />}
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
        {workLoad?.source && (
          <span
            id="workitems-summary"
            className="model-summary"
            data-origin={workLoad.source.origin}
            data-items={workItems.length}
            data-coverage={coverage?.percent}
            data-covered={coverage?.total}
            title={`Work items from ${workLoad.source.name}`}
          >
            {plural(workItems.length, 'work item')}
            {coverage && coverage.hidden > 0 ? ` (${coverage.total} shown)` : ''}
            {coverage && coverage.total > 0 ? ` · ${coverage.percent}% tagged` : ''}
          </span>
        )}
        {/* With the names of the files: reading them again, and the maps opened before. */}
        {currentEntry && (
          <button
            type="button"
            id="reload-files"
            className="reload-files"
            title={`Read ${recentMapLabel(currentEntry)} again from the disk`}
            onClick={() => void openRecent(currentEntry, true)}
          >
            ↻ Reload
          </button>
        )}
        {recents.length > 0 && (
          <RecentMenu
            recents={recents}
            current={currentRecent}
            onOpen={openRecentById}
            onForget={forgetRecent}
          />
        )}
        <span className="toolbar-spacer" />
        {model && flow && (
          <SearchBox
            key={loadId}
            model={model}
            workItems={overlay?.shown}
            onChoose={goToNode}
            onChooseWorkItem={goToWorkItem}
            inputRef={searchInput}
          />
        )}
        {flow && (
          <KindFilters hiddenKinds={hiddenKinds} counts={kindCounts} onToggle={toggleKind} />
        )}
        {flow && (
          <span
            id="lod-indicator"
            className="lod-indicator"
            role="group"
            aria-label="Level of detail"
            data-lod={lodLevel}
            data-lod-mode={lodMode}
          >
            <span className="lod-indicator-caption">Detail</span>
            {LOD_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`lod-step${mode === lodLevel ? ' lod-step-current' : ''}`}
                data-lod-option={mode}
                aria-pressed={mode === lodMode}
                aria-current={mode === lodLevel ? 'true' : undefined}
                title={lodHint(mode, lodConfig)}
                onClick={() => chooseLod(mode)}
              >
                {LOD_LABELS[mode]}
              </button>
            ))}
            {collapsed.size > 0 && (
              <span
                id="collapsed-note"
                className="lod-collapsed-note"
                title="Groups collapsed by hand stay closed at every level of detail. Expand all opens them."
              >
                {collapsed.size} collapsed by hand
              </span>
            )}
          </span>
        )}
        {flow && workItems.length > 0 && (
          <span
            id="story-mode"
            className="lod-indicator"
            role="group"
            aria-label="Work items on the map"
            data-story-mode={storyMode}
          >
            <span className="lod-indicator-caption">Stories</span>
            {STORY_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`lod-step${mode === storyMode ? ' lod-step-current' : ''}`}
                data-story-option={mode}
                aria-pressed={mode === storyMode}
                title={STORY_MODE_HINTS[mode]}
                onClick={() => chooseStoryMode(mode)}
              >
                {STORY_MODE_LABELS[mode]}
              </button>
            ))}
          </span>
        )}
        {flow && model && (model.flows.length > 0 || workItems.length > 0) && (
          <label
            className="toolbar-select"
            id="focus-control"
            title="Focus the map on a flow, an epic or a feature: what it involves stays lit, the rest is paled"
          >
            <span className="lod-indicator-caption">Focus</span>
            <select
              id="focus-select"
              value={focus ? `${focus.type}:${focus.id}` : ''}
              onChange={(event) => {
                const [type, ...rest] = event.target.value.split(':');
                const id = rest.join(':');
                if (type === 'flow') chooseFocus({ type: 'flow', id });
                else if (type === 'workitem') chooseFocus({ type: 'workitem', id: Number(id) });
                else chooseFocus(undefined);
              }}
            >
              <option value="">None</option>
              {(['workflow', 'dataflow'] as const).map((kind) => {
                const flows = model.flows.filter((f) => f.kind === kind);
                return flows.length > 0 ? (
                  <optgroup key={kind} label={kind === 'dataflow' ? 'Data flows' : 'Workflows'}>
                    {flows.map((f) => (
                      <option key={f.id} value={`flow:${f.id}`}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
              {(['Epic', 'Feature'] as const).map((type) => {
                const items = (overlay?.shown ?? []).filter((item) => item.type === type);
                return items.length > 0 ? (
                  <optgroup key={type} label={`${type}s`}>
                    {items.map((item) => (
                      <option key={item.id} value={`workitem:${item.id}`}>
                        #{item.id} {item.title}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
              {focus?.type === 'workitem' &&
                !(overlay?.shown ?? []).some(
                  (item) =>
                    item.id === focus.id && (item.type === 'Epic' || item.type === 'Feature'),
                ) && <option value={`workitem:${focus.id}`}>{focusName()}</option>}
            </select>
          </label>
        )}
        {flow && (
          <SettingsPanel
            settings={settings}
            onChange={changeSettings}
            workItems={filterChoices}
            colorChoices={colorChoices}
          />
        )}
        {flow && (
          <ViewsMenu
            views={savedViews}
            onSave={(name) => changeSavedViews(withSavedView(savedViews, currentView(name)))}
            onApply={applyView}
            onDelete={(name) => changeSavedViews(withoutSavedView(savedViews, name))}
            onCopyLink={copyViewLink}
          />
        )}
        <button
          type="button"
          id="open-yaml"
          title="Open a structure file (architecture.yaml) — together with its work items (workitems.json) if you choose both; files can also be dropped on the page"
          onClick={() => pick('map')}
        >
          Open YAML…
        </button>
        <button
          type="button"
          id="open-workitems"
          title="Load a work-items file (workitems.json); a .json file can also be dropped on the page"
          onClick={() => pick('workitems')}
        >
          Open work items…
        </button>
        <button
          type="button"
          id="unlock-positions"
          disabled={!flow}
          aria-pressed={positionsUnlocked}
          title={
            positionsUnlocked
              ? 'Positions are unlocked: drag groups and nodes to move them. Click to lock.'
              : 'Positions are locked. Click to unlock and move groups and nodes by hand.'
          }
          onClick={() => setPositionsUnlocked((unlocked) => !unlocked)}
        >
          {positionsUnlocked ? 'Lock positions' : 'Unlock positions'}
        </button>
        <button
          type="button"
          id="reset-positions"
          disabled={!flow || positions.size === 0}
          title="Put every node moved by hand back where the layout placed it"
          onClick={resetPositions}
        >
          Reset positions
        </button>
        <button
          type="button"
          id="collapse-all"
          disabled={!flow || groups.length === 0 || allCollapsed}
          onClick={collapseAll}
        >
          Collapse all
        </button>
        <button
          type="button"
          id="expand-all"
          disabled={!flow || collapsed.size === 0}
          onClick={expandAll}
        >
          Expand all
        </button>
        <button
          type="button"
          id="fit-view"
          disabled={!flow}
          onClick={() => void fitView({ ...FIT_VIEW_OPTIONS, duration: 200 })}
        >
          Fit view
        </button>
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
      </header>

      {fileError !== undefined && (
        <p id="file-error" className="notice notice-error" role="alert">
          {fileError}
        </p>
      )}
      {focus && flow && (
        <p id="focus-bar" className="notice notice-focus" role="status">
          Focus: <strong>{focusName() ?? '—'}</strong>
          {focused
            ? ` · ${plural(focused.nodes.size, 'node')} · ${plural(focused.edges.size, 'edge')}`
            : ' · not among the loaded data'}
          {focus.type === 'flow' && !sameSelection(selection, { type: 'flow', id: focus.id }) && (
            <button type="button" id="focus-show" onClick={() => select(focus)}>
              Show
            </button>
          )}
          {focus.type === 'workitem' &&
            !sameSelection(selection, { type: 'workitem', id: focus.id }) && (
              <button type="button" id="focus-show" onClick={() => goToWorkItem(focus.id)}>
                Show
              </button>
            )}
          <button type="button" id="focus-clear" onClick={() => setFocus(undefined)}>
            Clear focus
          </button>
        </p>
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
              key={`${loadId}:${layout.key}`}
              flow={shownFlow}
              onToggleCollapse={toggleCollapsed}
              workItemCanvas={workItemCanvas}
              onSelect={select}
              initialViewport={initialViewport}
              contentBounds={layout.bounds}
              onViewportSettled={storeViewport}
              positionsUnlocked={positionsUnlocked}
              onNodeMoved={moveNode}
              lenses={lenses}
              onHoverNode={edgesQuiet ? setHoveredNode : undefined}
            />
            <ColorLegend coloring={coloring} />
            {selection && (
              <DetailPanel
                model={model}
                layout={layout}
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
                onClose={clearSelection}
              />
            )}
          </div>
        )}
        {dragging && (
          <div id="drop-overlay" className="drop-overlay">
            Drop a YAML file (structure) or a JSON file (work items) to load it
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
  );
}

function ModelSummary({ model }: { model: ArchitectureModel }) {
  const counts = [0, 0, 0];
  for (const node of model.nodes.values()) counts[node.level] = (counts[node.level] ?? 0) + 1;
  const parts = NODE_LEVEL_NAMES.map((name, level) => plural(counts[level] ?? 0, name));
  parts.push(plural(model.edges.length, 'edge'));
  if (model.rows.length > 0) parts.push(plural(model.rows.length, 'row'));
  return (
    <span
      id="model-summary"
      className="model-summary"
      data-nodes={model.nodes.size}
      data-edges={model.edges.length}
      data-rows={model.rows.length}
    >
      {parts.join(' · ')}
    </span>
  );
}
