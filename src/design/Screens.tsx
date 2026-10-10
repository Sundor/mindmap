// The screens of screens.html: the whole app as `Viewer` composes it, in a few situations, with
// the shipped example. The frame is the mirror in Frame.tsx; the panels, the canvas and the
// detail panel are the app's own components.

import { DiagnosticsPanel } from '../ui/DiagnosticsPanel';
import { ColorLegend } from '../ui/ColorLegend';
import { DetailPanel } from '../ui/DetailPanel';
import { EdgeLegend } from '../ui/EdgeLegend';
import { FocusBar } from '../ui/FocusBar';
import { heatByWork, progressByNode, workItemTagReport, type EdgeKind } from '../core';
import { AppFrame, HiddenInputs, StartScreen } from './Frame';
import { PanelElement } from './Kit';
import {
  canvasData,
  DIAGNOSTICS_BAR,
  FILES_ONLY,
  SCREEN,
  type Canvas,
  type Prepared,
} from './specimens';
import { FlowStore, StaticCanvas } from './StaticCanvas';

const noop = (): undefined => undefined;
const NO_KINDS: ReadonlySet<EdgeKind> = new Set();
const MARK = {
  domains: { text: 'Dom', name: 'Domains' },
  components: { text: 'Comp', name: 'Components' },
  subcomponents: { text: 'Sub', name: 'Subcomponents' },
  detail: { text: 'All', name: 'Everything' },
} as const;

function canvasOf(prepared: Prepared, id: string): Canvas {
  const canvas = prepared.canvases.get(id);
  if (!canvas) throw new Error(`No canvas was prepared for ${id}`);
  return canvas;
}

function Diagnostics({ prepared }: { readonly prepared: Prepared }) {
  const { parsed, work, model, items } = prepared.example;
  return (
    <DiagnosticsPanel
      errors={parsed.errors}
      warnings={parsed.warnings}
      workItems={{
        sourceName: 'workitems.json',
        coverage: workItemTagReport(model, items).coverage,
        errors: work.errors,
        warnings: work.warnings,
      }}
      hints={prepared.hints}
    />
  );
}

/** The app with the example on the canvas `id`, the panel on `tab`, and what the caller puts beside the map. */
function MapScreen({
  prepared,
  id,
  tab,
  pinned,
  lenses,
  beside,
  above,
}: {
  readonly prepared: Prepared;
  readonly id: string;
  readonly tab: 'detail' | 'lenses';
  readonly pinned: boolean;
  readonly lenses?: boolean | undefined;
  readonly beside?: React.ReactNode;
  readonly above?: React.ReactNode;
}) {
  const canvas = canvasOf(prepared, id);
  return (
    <FlowStore flow={canvas.flow} size={canvas.size} view={canvas.view}>
      <AppFrame
        data={canvasData(canvas, {
          'lod-mode': pinned ? canvas.level : 'auto',
          'panel-tab': tab,
          'color-by': lenses ? 'owner' : 'none',
          heat: lenses === true,
          progress: lenses === true,
          workitems: prepared.example.items.length,
        })}
      >
        <PanelElement
          prepared={prepared}
          tab={tab}
          marks={{ level: { ...MARK[canvas.level], pinned }, views: 0 }}
        />
        <div className="app-column">
          {above}
          <main className="app-main">
            <div className="map-row">
              <StaticCanvas
                flow={canvas.flow}
                bounds={canvas.layout.bounds}
                lenses={canvas.lenses}
              />
              <div className="map-legends">
                <EdgeLegend hiddenKinds={NO_KINDS} />
                <ColorLegend coloring={lenses ? prepared.owner : undefined} />
              </div>
              {beside}
            </div>
          </main>
          <Diagnostics prepared={prepared} />
        </div>
        <HiddenInputs />
      </AppFrame>
    </FlowStore>
  );
}

/** The mirrored app of one screen, by its id. */
export function Screen({ id, prepared }: { readonly id: string; readonly prepared: Prepared }) {
  switch (id) {
    case 'screen-start':
      return (
        <FlowStore
          size={{ width: SCREEN.width, height: SCREEN.height - DIAGNOSTICS_BAR }}
          view={{ x: 0, y: 0, zoom: 1 }}
        >
          <AppFrame data={{ load: 'empty', 'panel-tab': 'files', 'panel-collapsed': false }}>
            <PanelElement
              prepared={prepared}
              tab="files"
              variant="start"
              available={FILES_ONLY}
              files={false}
              reload={false}
              fitDisabled
              marks={{}}
            />
            <div className="app-column">
              <main className="app-main">
                <StartScreen reason="Open a structure file to draw its map." />
              </main>
            </div>
            <HiddenInputs />
          </AppFrame>
        </FlowStore>
      );
    case 'screen-map':
      return <MapScreen prepared={prepared} id="screen-map" tab="detail" pinned={false} />;
    case 'screen-everything':
      return <MapScreen prepared={prepared} id="screen-everything" tab="detail" pinned />;
    case 'screen-selected': {
      const { model, overlay } = prepared.example;
      const canvas = canvasOf(prepared, 'screen-selected');
      const flowName = model.flows.find((flow) => flow.id === prepared.exampleIds.flow)?.name ?? '';
      return (
        <MapScreen
          prepared={prepared}
          id="screen-selected"
          tab="lenses"
          pinned
          lenses
          above={
            <FocusBar
              filterOn={false}
              onFilterChange={noop}
              name={flowName}
              counts=" · 6 nodes · 5 edges"
              showVisible
              onShow={noop}
              onClear={noop}
            />
          }
          beside={
            <DetailPanel
              model={model}
              rows={canvas.layout}
              selection={{ type: 'node', id: prepared.exampleIds.component }}
              edges={canvas.flow.edges}
              hiddenKinds={NO_KINDS}
              onGoToNode={noop}
              onGoToEdge={noop}
              overlay={overlay}
              storyMode="stories"
              onGoToWorkItem={noop}
              onChooseStoryMode={noop}
              onGoToFlow={noop}
              focus={{ type: 'flow', id: prepared.exampleIds.flow }}
              onFocus={noop}
              heat={heatByWork(model, overlay)}
              progress={progressByNode(model, overlay)}
              drawnHeat={canvas.lenses?.heat}
              drawnProgress={canvas.lenses?.progress}
              drawnIds={new Set(canvas.flow.nodes.map((node) => node.id))}
              onClose={noop}
            />
          }
        />
      );
    }
    default:
      throw new Error(`No screen is called ${id}`);
  }
}
