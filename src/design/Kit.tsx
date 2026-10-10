// The specimens of kit.html: the app's own components, each with the props that put it into one
// state, below a FlowStore where a component reads the store. Nothing here is a copy of the
// app's markup except what Frame.tsx mirrors.

import { createRef, type ReactNode } from 'react';
import {
  CONTROL_TABS,
  DEFAULT_DISPLAY_SETTINGS,
  EDGE_KINDS,
  heatByWork,
  progressByNode,
  WORK_ITEM_TYPES,
  workItemTagReport,
  type ControlTab,
  type Diagnostic,
  type DisplaySettings,
  type EdgeKind,
  type LodLevel,
  type RecentMap,
  type SavedView,
  type Selection,
  type ViewCenter,
} from '../core';
import { ColorLegend } from '../ui/ColorLegend';
import { ControlPanel, type ControlTabMarks } from '../ui/ControlPanel';
import { DetailPanel } from '../ui/DetailPanel';
import { DetailTab } from '../ui/DetailTab';
import { DiagnosticsPanel } from '../ui/DiagnosticsPanel';
import { EdgeLegend } from '../ui/EdgeLegend';
import { FilesTab } from '../ui/FilesTab';
import { FilterContext, type FilteredMap } from '../ui/filterContext';
import { FocusBar } from '../ui/FocusBar';
import { LayoutTab } from '../ui/LayoutTab';
import { LensesTab } from '../ui/LensesTab';
import { PanelIcon, type PanelIconName } from '../ui/PanelIcons';
import { SearchBox, type SearchOutside } from '../ui/SearchBox';
import { Switch } from '../ui/Switch';
import { ViewsTab } from '../ui/ViewsTab';
import { VisibilityTab } from '../ui/VisibilityTab';
import { WorkItemIcon } from '../ui/WorkItemIcon';
import {
  AppFrame,
  DropOverlay,
  FileError,
  PanelHead,
  RailActions,
  StartScreen,
  StatusLine,
  ViewerStopped,
  ViewNote,
  type AppData,
} from './Frame';
import { canvasData, FILES_ONLY, KIT_CANVAS, type Canvas, type Prepared } from './specimens';
import { FlowStore, StaticCanvas } from './StaticCanvas';
import type { CustomProperty } from './stylesheet';

const noop = (): undefined => undefined;
const done = (): Promise<boolean> => Promise.resolve(true);
const VERSION = 'design';
const NO_KINDS: ReadonlySet<EdgeKind> = new Set();
/** A filtered map that shows nothing: every link of the detail panel then points outside it. */
const NOTHING_SHOWN: FilteredMap = { showsNode: () => false, showsEdge: () => false };
const PANEL_ICONS: readonly PanelIconName[] = [
  'detail',
  'visibility',
  'lenses',
  'layout',
  'views',
  'files',
  'search',
  'reload',
  'fit',
  'hide',
  'show',
];
const LEVEL_NAMES: Readonly<Record<LodLevel, { readonly text: string; readonly name: string }>> = {
  domains: { text: 'Dom', name: 'Domains' },
  components: { text: 'Comp', name: 'Components' },
  subcomponents: { text: 'Sub', name: 'Subcomponents' },
  detail: { text: 'All', name: 'Everything' },
};
const CENTER: ViewCenter = { x: 0, y: 0, zoom: 1 };
const VIEWS: readonly SavedView[] = [
  { name: 'Overview', collapsed: [], hiddenKinds: [], lodMode: 'auto', center: CENTER },
  {
    name: 'Checkout, by owner',
    collapsed: [],
    hiddenKinds: ['config'],
    lodMode: 'components',
    center: CENTER,
    colorBy: 'owner',
  },
];
const RECENTS: readonly RecentMap<unknown>[] = [
  {
    id: 'shop',
    structure: { name: 'architecture.yaml', handle: undefined },
    workItems: { name: 'workitems.json', handle: undefined },
    hint: 'Storefront, Back office, Platform',
    openedAt: 1_760_000_000_000,
  },
  {
    id: 'billing',
    structure: { name: 'billing.yaml', handle: undefined },
    hint: 'Invoicing, Payments, Ledger',
    openedAt: 1_759_900_000_000,
  },
];
const WARNINGS: readonly Diagnostic[] = [
  { severity: 'warning', path: 'edges[3].label', message: 'The label repeats the kind', line: 41 },
];
const ERRORS: readonly Diagnostic[] = [
  {
    severity: 'error',
    path: 'domains[1].components[0].id',
    message: 'Duplicate id "shop.cart"',
    line: 27,
  },
  { severity: 'error', path: 'edges[0].to', message: 'Unknown node "shop.search"', line: 50 },
];

function canvasOf(prepared: Prepared, id: string): Canvas {
  const canvas = prepared.canvases.get(id);
  if (!canvas) throw new Error(`No canvas was prepared for ${id}`);
  return canvas;
}

function panelsWith(tab: ControlTab, content: ReactNode): Readonly<Record<ControlTab, ReactNode>> {
  const panels: Record<ControlTab, ReactNode> = {
    detail: null,
    visibility: null,
    lenses: null,
    layout: null,
    views: null,
    files: null,
  };
  panels[tab] = content;
  return panels;
}

/** The content of one tab of the control panel, in the state `variant` names. */
export function TabContent({
  prepared,
  tab,
  variant = 'default',
}: {
  readonly prepared: Prepared;
  readonly tab: ControlTab;
  readonly variant?: string | undefined;
}) {
  const { model, items } = prepared.specimen;
  const settings: DisplaySettings = DEFAULT_DISPLAY_SETTINGS;
  const presetValue = prepared.exampleColorChoices.find(
    (choice) => choice.group === 'preset' && choice.description !== undefined,
  )?.value;
  switch (tab) {
    case 'detail': {
      const pinned = variant === 'pinned';
      const shown: DisplaySettings = pinned
        ? {
            ...settings,
            closeGaps: true,
            compactCollapsed: true,
            lod: { ...settings.lod, componentsZoom: settings.lod.componentsZoom * 1.2 },
          }
        : settings;
      return (
        <DetailTab
          drawn
          lodMode={pinned ? 'components' : 'auto'}
          lodLevel="components"
          pendingLevel={pinned ? undefined : 'subcomponents'}
          lodConfig={shown.lod}
          onChooseLod={noop}
          collapsedCount={2}
          canCollapseAll
          onCollapseAll={noop}
          onExpandAll={noop}
          settings={shown}
          onChange={noop}
          hasWorkItems
          onChooseStoryMode={noop}
        />
      );
    }
    case 'visibility': {
      const filter = variant === 'filter';
      const states = [...new Set(items.map((item) => item.state))];
      const iterations = [
        ...new Set(items.flatMap((item) => (item.iteration ? [item.iteration] : []))),
      ];
      return (
        <VisibilityTab
          drawn
          focusChooser={{
            flows: model.flows,
            items,
            focus: prepared.focus,
            focusName: model.flows[0]?.name,
            onChoose: noop,
          }}
          filterOn={filter}
          onFilterChange={noop}
          filterHint="The rest of the map is left out and the map is laid out again."
          hiddenKinds={new Set<EdgeKind>(EDGE_KINDS.slice(1, 2))}
          kindCounts={prepared.kindCounts}
          onToggleKind={noop}
          settings={
            filter
              ? { ...settings, focusMode: 'filter', edgesOnDemand: true, iteration: iterations[0] }
              : { ...settings, hiddenStates: states.slice(-1) }
          }
          onChange={noop}
          workItems={{
            states,
            iterations,
            shown: Math.max(0, items.length - 1),
            total: items.length,
          }}
        />
      );
    }
    case 'lenses':
      return (
        <LensesTab
          drawn={variant !== 'empty'}
          settings={{ ...settings, colorBy: presetValue ?? 'owner', heat: true, progress: true }}
          onChange={noop}
          colorChoices={prepared.exampleColorChoices}
          hasWorkItems
        />
      );
    case 'layout': {
      const unlocked = variant === 'unlocked';
      return (
        <LayoutTab
          drawn
          settings={settings}
          onChange={noop}
          positionsUnlocked={unlocked}
          onToggleUnlocked={noop}
          movedCount={unlocked ? 3 : 0}
          resizedCount={unlocked ? 2 : 0}
          onResetPositions={noop}
        />
      );
    }
    case 'views':
      return (
        <ViewsTab
          drawn
          active
          views={variant === 'empty' ? [] : VIEWS}
          onSave={noop}
          onApply={noop}
          onDelete={noop}
          onCopyLink={done}
        />
      );
    case 'files': {
      const start = variant === 'start';
      return (
        <FilesTab
          model={start ? undefined : model}
          workItems={
            start
              ? undefined
              : {
                  origin: 'file',
                  name: 'workitems.json',
                  count: items.length,
                  coverage: workItemTagReport(model, items).coverage,
                }
          }
          onOpen={noop}
          recents={start ? [] : RECENTS}
          currentRecent={start ? undefined : 'shop'}
          onOpenRecent={noop}
          onForgetRecent={noop}
          exportMap={
            start
              ? undefined
              : {
                  pending: false,
                  selection: true,
                  edgesHeldBack: false,
                  active: true,
                  onExport: () => Promise.reject(new Error('A design page exports nothing')),
                }
          }
        />
      );
    }
    default:
      return null;
  }
}

/** The search card of the control panel with a query typed. */
export function Search({
  prepared,
  query,
  outside,
}: {
  readonly prepared: Prepared;
  readonly query: string;
  readonly outside?: SearchOutside | undefined;
}) {
  return (
    <SearchBox
      model={prepared.specimen.model}
      workItems={prepared.specimen.items}
      onChoose={noop}
      onChooseWorkItem={noop}
      inputRef={createRef<HTMLInputElement>()}
      outside={outside}
      initialQuery={query}
    />
  );
}

export interface PanelElementProps {
  readonly prepared: Prepared;
  readonly tab: ControlTab;
  readonly variant?: string | undefined;
  readonly collapsed?: boolean | undefined;
  readonly searchOpen?: boolean | undefined;
  readonly search?: ReactNode | undefined;
  readonly available?: readonly ControlTab[] | undefined;
  readonly marks?: ControlTabMarks | undefined;
  /** The names of the files shown in the head; none before a map is loaded. */
  readonly files?: boolean | undefined;
  readonly reload?: boolean | undefined;
  readonly fitDisabled?: boolean | undefined;
}

/** The control panel itself, to stand in a frame of the caller's. */
export function PanelElement({
  prepared,
  tab,
  variant,
  collapsed = false,
  searchOpen = false,
  search,
  available = CONTROL_TABS,
  marks,
  files = true,
  reload = true,
  fitDisabled = false,
}: PanelElementProps) {
  return (
    <ControlPanel
      tab={tab}
      collapsed={collapsed}
      available={available}
      onChange={noop}
      marks={marks ?? { level: { ...LEVEL_NAMES.components, pinned: false }, views: VIEWS.length }}
      head={
        <PanelHead
          version={VERSION}
          structureName={files ? 'architecture.yaml' : undefined}
          workItemsName={files ? 'workitems.json' : undefined}
        />
      }
      search={search}
      searchOpen={searchOpen}
      onSearchOpenChange={noop}
      onSearch={noop}
      actions={
        <RailActions reload={reload ? 'architecture.yaml' : undefined} fitDisabled={fitDisabled} />
      }
      panels={panelsWith(tab, <TabContent prepared={prepared} tab={tab} variant={variant} />)}
    />
  );
}

/** A control panel specimen: the panel in a frame of its own, below a store with a zoom. */
function Panel(props: PanelElementProps & { readonly zoom?: number | undefined }) {
  const { zoom = 0.85, ...panel } = props;
  return (
    <FlowStore size={KIT_CANVAS} view={{ x: 0, y: 0, zoom }}>
      <AppFrame
        data={{
          load: panel.files === false ? 'empty' : 'done',
          lod: 'components',
          'zoom-lod': 'components',
          'panel-tab': panel.tab,
          'panel-collapsed': panel.collapsed === true,
          'positions-unlocked': panel.variant === 'unlocked',
        }}
      >
        {panel.collapsed === true && <h1 className="visually-hidden">Architecture Map</h1>}
        <PanelElement {...panel} />
      </AppFrame>
    </FlowStore>
  );
}

/** A canvas specimen: the static canvas of a prepared flow in the mirrored `.app`. */
export function CanvasSpecimen({
  canvas,
  data,
}: {
  readonly canvas: Canvas;
  readonly data?: AppData;
}) {
  return (
    <FlowStore flow={canvas.flow} size={canvas.size} view={canvas.view} unlocked={canvas.unlocked}>
      <AppFrame data={canvasData(canvas, data)}>
        <StaticCanvas
          flow={canvas.flow}
          bounds={canvas.layout.bounds}
          unlocked={canvas.unlocked}
          lenses={canvas.lenses}
          workItemCanvas={canvas.workItemCanvas}
        />
      </AppFrame>
    </FlowStore>
  );
}

/** The detail panel for a selection of the specimen model. */
export function Detail({
  prepared,
  selection,
  outside = false,
  canvasId = 'map-lenses',
}: {
  readonly prepared: Prepared;
  readonly selection: Selection;
  readonly outside?: boolean | undefined;
  /** The canvas whose edges and layout the panel reads. */
  readonly canvasId?: string | undefined;
}) {
  const { model, overlay } = prepared.specimen;
  const canvas = canvasOf(prepared, canvasId);
  const drawnIds = new Set(canvas.flow.nodes.map((node) => node.id));
  return (
    <AppFrame data={canvasData(canvas)}>
      <FilterContext.Provider value={outside ? NOTHING_SHOWN : undefined}>
        <DetailPanel
          model={model}
          rows={canvas.layout}
          selection={selection}
          edges={canvas.flow.edges}
          hiddenKinds={NO_KINDS}
          onGoToNode={noop}
          onGoToEdge={noop}
          overlay={overlay}
          storyMode={
            selection.type === 'workitem' && selection.id === prepared.ids.task
              ? 'stories'
              : 'tasks'
          }
          onGoToWorkItem={noop}
          onChooseStoryMode={noop}
          onGoToFlow={noop}
          focus={selection.type === 'flow' ? prepared.focus : undefined}
          onFocus={noop}
          heat={heatByWork(model, overlay)}
          progress={progressByNode(model, overlay)}
          drawnHeat={canvas.lenses?.heat}
          drawnProgress={canvas.lenses?.progress}
          drawnIds={drawnIds}
          outside={outside}
          onShowOnMap={outside ? noop : undefined}
          onClose={noop}
        />
      </FilterContext.Provider>
    </AppFrame>
  );
}

function TokenTable({ properties }: { readonly properties: readonly CustomProperty[] }) {
  return (
    <table className="tpl-tokens">
      <thead>
        <tr>
          <th>Property</th>
          <th>Light</th>
          <th>Dark</th>
          <th>Uses</th>
        </tr>
      </thead>
      <tbody>
        {properties.map((property) => (
          <tr key={property.name}>
            <td>
              <span className="tpl-swatch" style={{ background: `var(${property.name})` }} />{' '}
              {property.name}
            </td>
            <td>{property.light}</td>
            <td>{property.dark ?? '—'}</td>
            <td>{property.uses}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Icons() {
  return (
    <div className="tpl-icons">
      {PANEL_ICONS.map((name) => (
        <figure key={name}>
          <span className="cp-rail-button">
            <PanelIcon name={name} />
          </span>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
      {WORK_ITEM_TYPES.map((type) => (
        <figure key={type}>
          <WorkItemIcon type={type} labelled />
          <figcaption>{type}</figcaption>
        </figure>
      ))}
      <figure>
        <Switch
          id="tpl-switch-off"
          checked={false}
          onChange={noop}
          offLabel="Focus"
          onLabel="Filter"
          label="Focus or Filter"
        />
        <figcaption>switch, off</figcaption>
      </figure>
      <figure>
        <Switch
          id="tpl-switch-on"
          checked
          onChange={noop}
          offLabel="Focus"
          onLabel="Filter"
          label="Focus or Filter"
        />
        <figcaption>switch, on</figcaption>
      </figure>
    </div>
  );
}

function Legends({ prepared }: { readonly prepared: Prepared }) {
  return (
    <div className="map-legends" style={{ position: 'static', display: 'flex', gap: '1rem' }}>
      <EdgeLegend hiddenKinds={new Set<EdgeKind>(EDGE_KINDS.slice(1, 2))} />
      <ColorLegend coloring={prepared.owner} />
      <ColorLegend coloring={prepared.preset} />
      <ColorLegend coloring={prepared.metric} />
    </div>
  );
}

function Diagnostics({ prepared, open }: { readonly prepared: Prepared; readonly open: boolean }) {
  const { model, items } = prepared.specimen;
  return (
    <DiagnosticsPanel
      errors={open ? ERRORS : []}
      warnings={WARNINGS}
      workItems={{
        sourceName: 'workitems.json',
        coverage: workItemTagReport(model, items).coverage,
        errors: [],
        warnings: [],
      }}
      hints={prepared.hints}
    />
  );
}

/** The app's markup of one specimen of the kit, by its id. */
export function KitSpecimen({
  id,
  prepared,
  properties,
}: {
  readonly id: string;
  readonly prepared: Prepared;
  readonly properties: readonly CustomProperty[];
}) {
  const { model } = prepared.specimen;
  const firstName = [...model.nodes.values()][0]?.name ?? '';
  const hit = firstName.slice(0, 3);
  const all: SearchOutside = { node: () => true, workItem: () => true };
  switch (id) {
    case 'tokens':
      return <TokenTable properties={properties} />;
    case 'icons':
      return <Icons />;
    case 'panel-detail':
      return (
        <Panel
          prepared={prepared}
          tab="detail"
          marks={{
            level: { ...LEVEL_NAMES.components, pinned: false, pending: 'Sub' },
            hiding: true,
            views: 2,
          }}
        />
      );
    case 'panel-detail-pinned':
      return (
        <Panel
          prepared={prepared}
          tab="detail"
          variant="pinned"
          marks={{ level: { ...LEVEL_NAMES.components, pinned: true }, views: 2 }}
        />
      );
    case 'panel-visibility':
      return <Panel prepared={prepared} tab="visibility" marks={{ hiding: true }} />;
    case 'panel-visibility-filter':
      return (
        <Panel prepared={prepared} tab="visibility" variant="filter" marks={{ hiding: true }} />
      );
    case 'panel-lenses':
      return <Panel prepared={prepared} tab="lenses" />;
    case 'panel-lenses-empty':
      return <Panel prepared={prepared} tab="lenses" variant="empty" />;
    case 'panel-layout':
      return <Panel prepared={prepared} tab="layout" />;
    case 'panel-layout-unlocked':
      return <Panel prepared={prepared} tab="layout" variant="unlocked" />;
    case 'panel-views':
      return <Panel prepared={prepared} tab="views" />;
    case 'panel-views-empty':
      return <Panel prepared={prepared} tab="views" variant="empty" marks={{ views: 0 }} />;
    case 'panel-files':
      return (
        <Panel
          prepared={prepared}
          tab="files"
          marks={{ files: 'architecture.yaml, workitems.json' }}
        />
      );
    case 'panel-start':
      return (
        <Panel
          prepared={prepared}
          tab="files"
          variant="start"
          available={FILES_ONLY}
          files={false}
          reload={false}
          fitDisabled
          marks={{}}
        />
      );
    case 'panel-collapsed':
      return <Panel prepared={prepared} tab="detail" collapsed />;
    case 'panel-flyout':
    case 'panel-flyout-narrow':
      return (
        <Panel
          prepared={prepared}
          tab="detail"
          collapsed
          searchOpen
          search={<Search prepared={prepared} query={hit} />}
        />
      );
    case 'search-none':
      return (
        <Panel
          prepared={prepared}
          tab="detail"
          collapsed
          searchOpen
          search={<Search prepared={prepared} query="qzx" />}
        />
      );
    case 'search-filtered':
      return (
        <Panel
          prepared={prepared}
          tab="detail"
          collapsed
          searchOpen
          search={<Search prepared={prepared} query={hit} outside={all} />}
        />
      );
    case 'legends':
      return <Legends prepared={prepared} />;
    case 'detail-group':
      return <Detail prepared={prepared} selection={{ type: 'node', id: prepared.ids.group }} />;
    case 'detail-leaf':
      return <Detail prepared={prepared} selection={{ type: 'node', id: prepared.ids.leaf }} />;
    case 'detail-merged':
      return (
        <Detail
          prepared={prepared}
          selection={{ type: 'aggregate', id: prepared.ids.aggregate ?? prepared.ids.edge }}
          canvasId="map-domains"
        />
      );
    case 'detail-edge':
      return <Detail prepared={prepared} selection={{ type: 'edge', id: prepared.ids.edge }} />;
    case 'detail-story':
      return (
        <Detail prepared={prepared} selection={{ type: 'workitem', id: prepared.ids.story }} />
      );
    case 'detail-task':
      return <Detail prepared={prepared} selection={{ type: 'workitem', id: prepared.ids.task }} />;
    case 'detail-flow':
      return <Detail prepared={prepared} selection={{ type: 'flow', id: prepared.ids.flow }} />;
    case 'detail-outside':
      return (
        <Detail prepared={prepared} selection={{ type: 'node', id: prepared.ids.leaf }} outside />
      );
    case 'focus-bar':
      return (
        <FocusBar
          filterOn={false}
          onFilterChange={noop}
          name={model.flows[0]?.name ?? ''}
          counts=" · 5 nodes · 4 edges"
          showVisible
          onShow={noop}
          onClear={noop}
        />
      );
    case 'focus-bar-filter':
      return (
        <FocusBar
          filterOn
          onFilterChange={noop}
          name={model.flows[0]?.name ?? ''}
          counts=" · 5 nodes · 4 edges"
          state="Not drawn: 12 of 17 nodes"
          note="The view of the whole map is kept for when the filter goes."
          showVisible={false}
          onShow={noop}
          onClear={noop}
        />
      );
    case 'file-error':
      return <FileError text="Could not read architecture.yaml: the file was moved or renamed." />;
    case 'view-note':
      return (
        <ViewNote text='This view is coloured by preset "Risk", which this file does not have: the boxes are not coloured.' />
      );
    case 'status-lines':
      return (
        <>
          <StatusLine id="load-status" text="Loading architecture…" />
          <StatusLine
            id="load-status"
            text="architecture.yaml has errors — see the diagnostics below."
          />
          <StatusLine
            id="load-status"
            text="architecture.yaml contains no domains — nothing to draw."
          />
          <StatusLine id="layout-status" text="Computing layout…" pending />
          <StatusLine
            id="layout-status"
            text="Layout failed: the layout engine ran out of memory"
            error
          />
        </>
      );
    case 'diagnostics-closed':
      return <Diagnostics prepared={prepared} open={false} />;
    case 'diagnostics-open':
      return <Diagnostics prepared={prepared} open />;
    case 'start':
      return <StartScreen reason="Open a structure file to draw its map." />;
    case 'start-recent':
      return <StartScreen reason="Open a structure file to draw its map." recents={RECENTS} />;
    case 'drop-overlay':
      return <DropOverlay />;
    case 'viewer-stopped':
      return <ViewerStopped message="Cannot read properties of undefined (reading 'nodes')" />;
    default: {
      const canvas = prepared.canvases.get(id);
      if (!canvas) throw new Error(`No specimen is called ${id}`);
      return (
        <CanvasSpecimen
          canvas={canvas}
          data={id === 'map-on-demand' ? { 'edges-on-demand': true, 'edges-held-back': true } : {}}
        />
      );
    }
  }
}
