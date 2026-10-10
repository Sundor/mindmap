import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import exampleWorkItems from '../../fixtures/workitems.json?raw';
import {
  EDGE_KINDS,
  effectiveAttribute,
  FLOW_KINDS,
  isOpenState,
  parseArchitecture,
  parseWorkItems,
  SIDES,
  sourceHandleId,
  targetHandleId,
  UNASSIGNED_NODE_ID,
  WORK_ITEM_TYPES,
  workItemTagReport,
  type ArchFlowNode,
  type ArchNode,
  type FlowGraph,
  type LayoutResult,
} from '../core';
import mapCanvasSource from '../ui/MapCanvas.tsx?raw';
import {
  HANDLE_BOX,
  loadFixtures,
  SPECIMEN_WORK_ITEMS,
  SPECIMEN_YAML,
  storeSettings,
  withSideHandles,
  type Fixtures,
  type MapFixture,
} from './fixtures';

interface Drawn {
  readonly layout: LayoutResult;
  readonly flow: FlowGraph;
}

let fixtures: Fixtures;
let specimen: MapFixture;
/** The specimen at the Everything level, and at the Components level. */
let everything: Drawn;
let components: Drawn;

beforeAll(async () => {
  fixtures = await loadFixtures();
  ({ specimen } = fixtures);
  everything = await specimen.flow({ mode: 'stories', lod: 'detail' });
  components = await specimen.flow({ mode: 'stories', lod: 'components' });
}, 60_000);

const boxesOf = (flow: FlowGraph): ArchFlowNode[] =>
  flow.nodes.filter((node): node is ArchFlowNode => node.type !== 'band');
const nodesOf = (fixture: MapFixture): ArchNode[] => [...fixture.model.nodes.values()];
const boxOf = (flow: FlowGraph, id: string): ArchFlowNode | undefined =>
  boxesOf(flow).find((node) => node.id === id);

describe('loadFixtures', () => {
  it('reads both maps without an error or a warning', () => {
    for (const fixture of [fixtures.specimen, fixtures.example]) {
      expect(fixture.parsed.errors).toEqual([]);
      expect(fixture.parsed.warnings).toEqual([]);
      expect(fixture.work.errors).toEqual([]);
      expect(fixture.work.warnings).toEqual([]);
      expect(fixture.parsed.model).toBe(fixture.model);
      expect(fixture.items).toBe(fixture.work.items);
      expect(fixture.overlay.shown.length).toBe(fixture.items.length);
    }
  });

  it('reads the shipped example and the specimen model', () => {
    const shipped = parseArchitecture(exampleYaml, { sourceName: 'architecture.yaml' }).model;
    expect([...fixtures.example.model.nodes.keys()]).toEqual([...(shipped?.nodes.keys() ?? [])]);
    expect(fixtures.example.items).toEqual(
      parseWorkItems(exampleWorkItems, { sourceName: 'workitems.json' }).items,
    );
    const written = parseArchitecture(SPECIMEN_YAML, { sourceName: 'architecture.yaml' }).model;
    expect([...specimen.model.nodes.keys()]).toEqual([...(written?.nodes.keys() ?? [])]);
    expect(specimen.model.nodes.size).toBeGreaterThan(0);
    expect(specimen.items).toEqual(
      parseWorkItems(SPECIMEN_WORK_ITEMS, { sourceName: 'workitems.json' }).items,
    );
  });
});

describe('the specimen model', () => {
  it('has three rows, and a domain in none of them that stands in the Unassigned area', () => {
    expect(specimen.model.rows.length).toBe(3);
    const unassigned = specimen.model.rootIds.filter(
      (id) => specimen.model.nodes.get(id)?.rowRange === undefined,
    );
    expect(unassigned.length).toBe(1);
    expect(everything.layout.unassignedArea).toBeDefined();
    expect(everything.flow.nodes.some((node) => node.id === UNASSIGNED_NODE_ID)).toBe(true);
    const connected = specimen.model.edges.flatMap((edge) => [edge.from, edge.to]);
    expect(connected.filter((id) => unassigned.some((root) => id.startsWith(root)))).toEqual([]);
  });

  it('has a component whose row comes from its connections', () => {
    const placed = [...everything.layout.placedRow.keys()];
    expect(placed.length).toBeGreaterThan(0);
    for (const id of placed) {
      expect(specimen.model.nodes.get(id)?.effectiveRow).toBeUndefined();
      expect(boxOf(everything.flow, id)?.data.placedRowName).toBeDefined();
    }
  });

  it('has leaves of all three levels, and components with three and with five children', () => {
    const nodes = nodesOf(specimen);
    const leafLevels = nodes.filter((node) => node.childIds.length === 0).map((node) => node.level);
    expect(new Set(leafLevels)).toEqual(new Set([0, 1, 2]));
    const childCounts = nodes
      .filter((node) => node.level === 1)
      .map((node) => node.childIds.length);
    expect(childCounts).toContain(3);
    expect(childCounts).toContain(5);
    const domains = nodes.filter((node) => node.level === 0).map((node) => node.childIds.length);
    expect(domains).toContain(2);
  });

  it('has attributes of its own and inherited ones, metrics, links, a description of several lines', () => {
    const nodes = nodesOf(specimen);
    for (const key of ['owner', 'status', 'tech'] as const) {
      const from = nodes.map((node) => effectiveAttribute(specimen.model, node.id, key)?.from);
      expect(nodes.some((node, index) => from[index] === node.id)).toBe(true);
      expect(
        nodes.some((node, index) => from[index] !== undefined && from[index] !== node.id),
      ).toBe(true);
      expect(from).toContain(undefined);
    }
    expect(nodes.some((node) => (node.metrics?.size ?? 0) >= 2)).toBe(true);
    expect(nodes.some((node) => (node.links?.length ?? 0) >= 2)).toBe(true);
    expect(nodes.some((node) => node.description?.trim().includes('\n') === true)).toBe(true);
    // A group with all of it: what the detail panel shows of a node at its fullest.
    expect(
      nodes.some(
        (node) =>
          node.childIds.length > 0 &&
          node.description !== undefined &&
          (node.links?.length ?? 0) > 0 &&
          (node.metrics?.size ?? 0) > 0 &&
          effectiveAttribute(specimen.model, node.id, 'owner') !== undefined,
      ),
    ).toBe(true);
  });

  it('has edges of all four kinds with a label and a protocol, and one with a description', () => {
    const { edges } = specimen.model;
    for (const kind of EDGE_KINDS) {
      expect(
        edges.some(
          (edge) => edge.kind === kind && edge.label !== undefined && edge.protocol !== undefined,
        ),
        kind,
      ).toBe(true);
    }
    expect(edges.some((edge) => edge.description !== undefined)).toBe(true);
    expect(edges.some((edge) => edge.protocol === undefined)).toBe(true);
  });

  it('has an edge inside a component', () => {
    const parentOf = (id: string): ArchNode | undefined => {
      const parent = specimen.model.nodes.get(id)?.parentId;
      return parent === undefined ? undefined : specimen.model.nodes.get(parent);
    };
    expect(
      specimen.model.edges.some(
        (edge) => parentOf(edge.from)?.level === 1 && parentOf(edge.from) === parentOf(edge.to),
      ),
    ).toBe(true);
  });

  it('has two edges between two components, drawn as one when both are closed', () => {
    expect(everything.flow.edges.filter((edge) => edge.data.count > 1)).toEqual([]);
    const merged = components.flow.edges.filter((edge) => edge.data.count > 1);
    expect(merged.map((edge) => edge.data.count)).toEqual([2]);
    expect(merged[0]?.className).toContain('arch-edge-aggregate');
    for (const end of [merged[0]?.source, merged[0]?.target]) {
      expect(boxOf(components.flow, end ?? '')?.data.collapsed).toBe(true);
    }
  });

  it('has a workflow and a data flow over its edges', () => {
    const { flows, edges } = specimen.model;
    expect(new Set(flows.map((flow) => flow.kind))).toEqual(new Set(FLOW_KINDS));
    const edgeIds = new Set(edges.map((edge) => edge.id));
    for (const flow of flows) {
      expect(flow.edgeIds.length).toBeGreaterThan(1);
      expect(flow.edgeIds.filter((id) => !edgeIds.has(id))).toEqual([]);
      expect(flow.description).toBeDefined();
    }
    expect(flows.some((flow) => flow.nodeIds.length > 0)).toBe(true);
  });
});

describe('the specimen work items', () => {
  const ofType = (type: string) => specimen.items.filter((item) => item.type === type);

  it('hold an item of each type: one epic, two features, three bugs of which two are open', () => {
    for (const type of WORK_ITEM_TYPES) expect(ofType(type).length, type).toBeGreaterThan(0);
    expect(ofType('Epic').length).toBe(1);
    expect(ofType('Feature').length).toBe(2);
    expect(ofType('Bug').length).toBe(3);
    expect(ofType('Bug').filter((bug) => isOpenState(bug.state)).length).toBe(2);
  });

  it('hold stories in the four states and in two iterations', () => {
    const stories = ofType('User Story');
    expect(new Set(stories.map((story) => story.state))).toEqual(
      new Set(['New', 'Active', 'Resolved', 'Closed']),
    );
    const iterations = new Set(specimen.items.map((item) => item.iteration));
    iterations.delete(undefined);
    expect(iterations.size).toBe(2);
    expect(specimen.items.some((item) => item.iteration === undefined)).toBe(true);
  });

  it('hold tasks under two stories, one of them with a link and a tag that names no node', () => {
    const parents = new Set(ofType('Task').map((task) => task.parentId));
    expect(parents.size).toBe(2);
    const report = workItemTagReport(specimen.model, specimen.items);
    expect(report.unknown.length).toBe(1);
    const story = report.unknown[0]?.item;
    expect(story?.type).toBe('User Story');
    expect(story?.url).toBeDefined();
    expect(parents.has(story?.id)).toBe(true);
    // Drawn all the same: its other tags name nodes.
    expect(specimen.overlay.nodesOf.get(story?.id ?? 0)?.length).toBe(2);
    expect(specimen.items.filter((item) => item.url !== undefined).length).toBe(1);
  });

  it('hold one story without a tag', () => {
    const { untagged } = workItemTagReport(specimen.model, specimen.items);
    expect(untagged.map((item) => item.type)).toEqual(['User Story']);
  });

  it('put eleven items on one leaf, more than its box lists', () => {
    const [crowded, ...others] = [...specimen.overlay.rows].filter(([, rows]) => rows.length > 8);
    expect(others).toEqual([]);
    expect(crowded?.[1].length).toBe(11);
    const box = boxOf(everything.flow, crowded?.[0] ?? '');
    expect(box?.type).toBe('leaf');
    const kinds = box?.data.workItems?.lines.map((line) => line.kind) ?? [];
    expect(kinds.at(-1)).toBe('more');
    expect(kinds.filter((kind) => kind === 'more').length).toBe(1);
  });
});

describe('the flow of a fixture', () => {
  it('is computed once for a view', async () => {
    const view = { mode: 'stories', lod: 'detail', collapsed: ['desk', 'routing'] } as const;
    const first = specimen.flow(view);
    expect(specimen.flow({ ...view, collapsed: ['routing', 'desk'] })).toBe(first);
    expect(specimen.flow({ ...view, compact: false, draggable: false, lines: true })).toBe(first);
    expect(specimen.flow({ ...view, collapsed: ['desk'] })).not.toBe(first);
    expect((await first).flow).toBe((await specimen.flow(view)).flow);
  });

  it('lists the work items at the Everything level, and counts them in badges below it', () => {
    const listed = boxesOf(everything.flow).filter((node) => node.data.workItems !== undefined);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((node) => node.data.contentRect !== undefined)).toBe(true);
    expect(listed.some((node) => node.data.workItems?.above !== undefined)).toBe(true);
    const boxes = boxesOf(components.flow);
    expect(boxes.filter((node) => node.data.workItems ?? node.data.contentRect)).toEqual([]);
    expect(boxes.some((node) => node.data.badge !== undefined && !node.data.collapsed)).toBe(true);
    expect(boxes.some((node) => node.data.badge !== undefined && node.data.collapsed)).toBe(true);
    // Without the lists the map needs less room.
    expect(components.layout.bounds.height).toBeLessThan(everything.layout.bounds.height);
  });

  it('keeps the room of the lists below the Everything level when asked, and drops it there', async () => {
    const kept = await specimen.flow({ mode: 'stories', lod: 'components', lines: true });
    expect(kept.layout).toBe(everything.layout);
    const inBlock = boxesOf(kept.flow).filter(
      (node) => node.data.contentRect !== undefined && node.data.badge !== undefined,
    );
    expect(inBlock.length).toBeGreaterThan(0);
    expect(boxesOf(kept.flow).filter((node) => node.data.workItems)).toEqual([]);
    const dropped = await specimen.flow({ mode: 'stories', lod: 'detail', lines: false });
    expect(dropped.layout).toBe(components.layout);
    expect(boxesOf(dropped.flow).filter((node) => node.data.contentRect)).toEqual([]);
    expect(boxesOf(dropped.flow).some((node) => node.data.badge !== undefined)).toBe(true);
  });

  it('lists the tasks in the Tasks mode and nothing when the work items are off', async () => {
    const kindsOf = (flow: FlowGraph): string[] =>
      boxesOf(flow).flatMap((node) => node.data.workItems?.lines.map((line) => line.kind) ?? []);
    expect(kindsOf(everything.flow)).not.toContain('task');
    const tasks = await specimen.flow({ mode: 'tasks', lod: 'detail' });
    expect(kindsOf(tasks.flow)).toContain('task');
    const off = await specimen.flow({ mode: 'off', lod: 'detail' });
    expect(boxesOf(off.flow).filter((node) => node.data.workItems ?? node.data.badge)).toEqual([]);
    expect(off.layout).toBe(components.layout);
  });

  it('closes the groups collapsed by hand', async () => {
    const group = boxesOf(everything.flow).find(
      (node) => node.type === 'group' && node.data.level === 1,
    );
    if (!group) throw new Error('The specimen has no open component');
    const { flow, layout } = await specimen.flow({
      mode: 'stories',
      lod: 'detail',
      collapsed: [group.id],
    });
    expect(layout).toBe(everything.layout);
    const closed = boxOf(flow, group.id);
    expect(closed?.data.collapsed).toBe(true);
    expect(closed?.data.manuallyCollapsed).toBe(true);
    expect(closed?.data.compact).toBe(false);
    expect(closed?.data.badge).toBeDefined();
    expect([closed?.width, closed?.height]).toEqual([group.width, group.height]);
    expect(boxesOf(flow).length).toBe(boxesOf(everything.flow).length - group.data.childCount);
  });

  it('draws the closed groups shrunk when asked, with their names and the line of a badge', async () => {
    expect(boxesOf(components.flow).filter((node) => node.data.compact)).toEqual([]);
    const { flow, layout } = await specimen.flow({
      mode: 'stories',
      lod: 'components',
      compact: true,
    });
    expect(layout).toBe(components.layout);
    const closed = boxesOf(flow).filter((node) => node.data.collapsed);
    expect(closed.length).toBeGreaterThan(1);
    for (const node of closed) {
      const full = layout.absolute.get(node.id);
      expect(node.data.compact, node.id).toBe(true);
      expect(node.data.badge, node.id).toBeDefined();
      expect(node.data.childNames.length, node.id).toBe(node.data.childCount);
      expect((node.width ?? 0) * (node.height ?? 0), node.id).toBeLessThan(
        (full?.width ?? 0) * (full?.height ?? 0),
      );
    }
    expect(closed.map((node) => node.data.childCount)).toContain(5);
  });

  it('closes the map up around what is drawn when asked, the closed groups shrunk', async () => {
    const { flow, layout } = await specimen.flow({
      mode: 'stories',
      lod: 'components',
      closeGaps: true,
    });
    expect(layout).not.toBe(components.layout);
    expect(layout.bounds.width).toBeLessThan(components.layout.bounds.width);
    expect(layout.bounds.height).toBeLessThan(components.layout.bounds.height);
    const closed = boxesOf(flow).filter((node) => node.data.collapsed);
    expect(closed.length).toBeGreaterThan(1);
    for (const node of closed) {
      const box = layout.absolute.get(node.id);
      expect(node.data.compact, node.id).toBe(true);
      expect([node.width, node.height], node.id).toEqual([box?.width, box?.height]);
    }
  });

  it('lets the boxes be dragged when asked', async () => {
    expect(boxesOf(everything.flow).filter((node) => node.draggable)).toEqual([]);
    const { flow } = await specimen.flow({ mode: 'stories', lod: 'detail', draggable: true });
    expect(boxesOf(flow).filter((node) => !node.draggable)).toEqual([]);
    expect(flow.nodes.filter((node) => node.type === 'band' && node.draggable)).toEqual([]);
  });

  it('draws the Domains level of the example with merged edges', async () => {
    const { flow } = await fixtures.example.flow({ mode: 'stories', lod: 'domains' });
    expect(boxesOf(flow).every((node) => node.data.level === 0)).toBe(true);
    expect(flow.edges.some((edge) => edge.data.count > 1)).toBe(true);
  });
});

describe('withSideHandles', () => {
  it('returns a row band as it is', () => {
    const band = everything.flow.nodes.find((node) => node.type === 'band');
    if (!band) throw new Error('The specimen has no row band');
    expect(withSideHandles(band)).toBe(band);
  });

  it('gives a box a source and a target handle centred on the middle of each side', () => {
    const box = boxesOf(everything.flow).find((node) => node.type === 'leaf');
    if (!box) throw new Error('The specimen has no leaf');
    const { width, height } = box;
    const { handles, ...rest } = withSideHandles(box);
    expect(rest).toEqual(box);
    const half = HANDLE_BOX / 2;
    const middles = {
      top: [width / 2, 0],
      right: [width, height / 2],
      bottom: [width / 2, height],
      left: [0, height / 2],
    } as const;
    expect(handles).toEqual(
      SIDES.flatMap((side) => {
        const [x, y] = middles[side];
        const at = {
          position: side,
          x: x - half,
          y: y - half,
          width: HANDLE_BOX,
          height: HANDLE_BOX,
        };
        return [
          { ...at, id: sourceHandleId(side), type: 'source' },
          { ...at, id: targetHandleId(side), type: 'target' },
        ];
      }),
    );
    expect(handles?.length).toBe(8);
  });

  it('takes one argument, so that it can be given to map', () => {
    expect(withSideHandles.length).toBe(1);
    const nodes = everything.flow.nodes.map(withSideHandles);
    expect(nodes.filter((node) => node.handles !== undefined).length).toBe(
      boxesOf(everything.flow).length,
    );
  });
});

describe('storeSettings', () => {
  it('holds the view as the transform of the store', () => {
    expect(storeSettings(false, { x: 12, y: -7.5, zoom: 0.4 }).transform).toEqual([12, -7.5, 0.4]);
  });

  it('lets the boxes be dragged only when the positions are unlocked', () => {
    expect(storeSettings(false, { x: 0, y: 0, zoom: 1 }).nodesDraggable).toBe(false);
    expect(storeSettings(true, { x: 0, y: 0, zoom: 1 }).nodesDraggable).toBe(true);
  });

  it('repeats what MapCanvas gives React Flow', () => {
    const { transform, nodesDraggable, ...fixed } = storeSettings(false, { x: 0, y: 0, zoom: 1 });
    expect(transform).toEqual([0, 0, 1]);
    expect(nodesDraggable).toBe(false);
    expect(mapCanvasSource).toContain('nodesDraggable={positionsUnlocked}');
    expect(Object.keys(fixed).length).toBe(7);
    for (const [name, value] of Object.entries(fixed)) {
      expect(value, name).toBe(false);
      expect(mapCanvasSource, name).toContain(`${name}={false}`);
    }
  });
});
