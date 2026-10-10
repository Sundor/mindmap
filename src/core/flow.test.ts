import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import fixtureJson from '../../fixtures/workitems.json?raw';
import {
  bandNodeId,
  buildFlow,
  closedGroupBadge,
  closedGroupSize,
  COMPACT_GROUP,
  compactGroupBox,
  curvePath,
  curvePoint,
  drawnNodeRects,
  distanceToCurve,
  EDGE_INTERACTION_WIDTH,
  edgeCurve,
  edgeLabelText,
  facingSides,
  GROUP_DRAG_HANDLE,
  hiddenSamples,
  LANE_GAP,
  nearestEdgeAt,
  openGroupAt,
  routeCacheSize,
  OPPOSITE_SIDE,
  routeEdge,
  sidePoint,
  sourceHandleId,
  targetHandleId,
  TITLE_DRAG_CLASS,
  UNASSIGNED_NODE_ID,
  Z_INDEX,
  type ArchFlowNode,
  type BandFlowNode,
  type Curve,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowView,
  type Point,
  type Side,
} from './flow';
import { arrangedLayout } from './arrange';
import { FADED_CLASS, focusFlow } from './focus';
import {
  clearLayoutCache,
  computeLayout,
  computeLayoutUncached,
  type LayoutResult,
} from './layout';
import { layoutViolations, overlaps, parseOk, rectOf } from './layout/test-helpers';
import type { Rect } from './layout/types';
import type { ArchitectureModel } from './model';
import { miniMapNodes } from './minimap';
import {
  allResizeLimits,
  applyHandOverrides,
  EDGES,
  movedByHand,
  NO_HAND_OVERRIDES,
  resizedByHand,
  type EdgeName,
} from './positions';
import { DIMMED_CLASS, highlightFlow } from './selection';
import { groupIds, LOD_LEVELS, visibleNodes } from './visibility';
import { buildWorkItemOverlay, subtreeWorkItemCounts } from './workItemOverlay';
import { parseWorkItems } from './workitems';

const rect = (x: number, y: number, width = 100, height = 50): Rect => ({ x, y, width, height });

function isBand(node: FlowNode): node is BandFlowNode {
  return node.type === 'band';
}
function archNodes(flow: FlowGraph): ArchFlowNode[] {
  return flow.nodes.filter((n): n is ArchFlowNode => !isBand(n));
}

/** The curve an edge is drawn along (what `ArchEdgeView` renders), in canvas coordinates. */
function curveOf(edge: FlowEdge, layout: LayoutResult): Curve {
  const source = layout.absolute.get(edge.source);
  const target = layout.absolute.get(edge.target);
  if (!source || !target) throw new Error('missing rect');
  const { route } = edge.data;
  return edgeCurve(
    sidePoint(source, route.sourceSide, route.offset),
    route.sourceDir,
    sidePoint(target, route.targetSide, route.offset),
    route.targetDir,
  );
}

function leafRects(model: ArchitectureModel, layout: LayoutResult, except: string[] = []): Rect[] {
  const rects: Rect[] = [];
  for (const node of model.nodes.values()) {
    const r = layout.absolute.get(node.id);
    if (r && node.childIds.length === 0 && !except.includes(node.id)) rects.push(r);
  }
  return rects;
}

describe('facingSides', () => {
  it('uses the horizontal sides for rectangles side by side', () => {
    expect(facingSides(rect(0, 0), rect(300, 10))).toEqual({ source: 'right', target: 'left' });
    expect(facingSides(rect(300, 10), rect(0, 0))).toEqual({ source: 'left', target: 'right' });
  });

  it('uses the vertical sides for rectangles above each other', () => {
    expect(facingSides(rect(0, 0), rect(20, 200))).toEqual({ source: 'bottom', target: 'top' });
    expect(facingSides(rect(20, 200), rect(0, 0))).toEqual({ source: 'top', target: 'bottom' });
  });

  it('separated on both axes: the larger gap wins, unless vertical is preferred', () => {
    // gap x = 400, gap y = 50
    const a = rect(0, 0);
    const b = rect(500, 100);
    expect(facingSides(a, b)).toEqual({ source: 'right', target: 'left' });
    expect(facingSides(a, b, true)).toEqual({ source: 'bottom', target: 'top' });
    expect(facingSides(b, a, true)).toEqual({ source: 'top', target: 'bottom' });
    // gap x = 50, gap y = 400
    expect(facingSides(a, rect(150, 450))).toEqual({ source: 'bottom', target: 'top' });
  });

  it('preferring vertical has no effect when there is no vertical gap', () => {
    expect(facingSides(rect(0, 0), rect(300, 10), true)).toEqual({
      source: 'right',
      target: 'left',
    });
  });

  it('nested or overlapping rectangles fall back to the direction between the centres', () => {
    const outer = rect(0, 0, 400, 300);
    expect(facingSides(outer, rect(300, 130, 60, 40))).toEqual({ source: 'right', target: 'left' });
    expect(facingSides(outer, rect(170, 240, 60, 40))).toEqual({ source: 'bottom', target: 'top' });
    expect(facingSides(outer, rect(170, 20, 60, 40))).toEqual({ source: 'top', target: 'bottom' });
    expect(facingSides(outer, rect(10, 130, 60, 40))).toEqual({ source: 'left', target: 'right' });
  });

  it('touching rectangles count as separated', () => {
    expect(facingSides(rect(0, 0), rect(100, 0))).toEqual({ source: 'right', target: 'left' });
    expect(facingSides(rect(0, 0), rect(0, 50))).toEqual({ source: 'bottom', target: 'top' });
  });
});

describe('edgeLabelText', () => {
  it('combines label and protocol', () => {
    expect(edgeLabelText({ label: 'records', protocol: 'AMQP' })).toBe('records [AMQP]');
    expect(edgeLabelText({ label: 'records' })).toBe('records');
    expect(edgeLabelText({ protocol: 'AMQP' })).toBe('AMQP');
    expect(edgeLabelText({})).toBeUndefined();
  });
});

describe('buildFlow without rows', () => {
  const yaml = `
version: 1
domains:
  - id: a
    name: Alpha
    description: First
    components:
      - id: a.x
        name: X
        subcomponents:
          - id: a.x.p
            name: P
      - id: a.y
        name: Y
  - id: b
    name: Beta
edges:
  - { id: e1, from: a.x.p, to: a.y, kind: dataflow, label: stuff, protocol: HTTP }
  - { id: e2, from: a, to: b, kind: config, description: why }
`;
  let model: ArchitectureModel;
  let layout: LayoutResult;
  let flow: FlowGraph;
  beforeAll(async () => {
    model = parseOk(yaml);
    layout = await computeLayoutUncached(model);
    flow = buildFlow(model, layout);
  });

  it('has one node per model node, in document order, and no bands', () => {
    expect(flow.nodes.map((n) => n.id)).toEqual(['a', 'a.x', 'a.x.p', 'a.y', 'b']);
  });

  it('uses group nodes for nodes with children and leaf nodes otherwise', () => {
    expect(Object.fromEntries(flow.nodes.map((n) => [n.id, n.type]))).toEqual({
      a: 'group',
      'a.x': 'group',
      'a.x.p': 'leaf',
      'a.y': 'leaf',
      b: 'leaf',
    });
  });

  it('nests children with parentId + extent and positions relative to the parent', () => {
    const byId = new Map(archNodes(flow).map((n) => [n.id, n]));
    expect(byId.get('a')?.parentId).toBeUndefined();
    expect(byId.get('a')?.extent).toBeUndefined();
    expect(byId.get('a.x')?.parentId).toBe('a');
    expect(byId.get('a.x.p')?.parentId).toBe('a.x');
    expect(byId.get('a.x.p')?.extent).toBe('parent');
    for (const node of archNodes(flow)) {
      const rel = layout.rects.get(node.id);
      expect(node.position).toEqual({ x: rel?.x, y: rel?.y });
      expect(node.style).toEqual({ width: rel?.width, height: rel?.height });
      expect({ width: node.width, height: node.height }).toEqual(node.style);
      expect(node.draggable).toBe(false);
      expect(node.connectable).toBe(false);
    }
  });

  it('carries name, level and description in the node data', () => {
    const a = archNodes(flow).find((n) => n.id === 'a');
    expect(a?.data).toEqual({
      name: 'Alpha',
      level: 0,
      levelName: 'domain',
      description: 'First',
      childCount: 2,
      counts: { children: 2, descendants: 3 },
      collapsed: false,
      manuallyCollapsed: false,
      compact: false,
      childNames: a?.data.childCount === 2 ? a.data.childNames : [],
      compactHidden: 0,
    });
    expect(a?.data.childNames).toHaveLength(2);
  });

  it('stacks groups below edges below leaves, nested groups above their parents', () => {
    const z = new Map(flow.nodes.map((n) => [n.id, n.zIndex]));
    expect(z.get('a')).toBe(Z_INDEX.group);
    expect(z.get('a.x')).toBe(Z_INDEX.group + 1);
    expect(z.get('a.x.p')).toBe(Z_INDEX.leaf);
    expect(z.get('b')).toBe(Z_INDEX.leaf);
    for (const edge of flow.edges) {
      expect(edge.zIndex).toBe(Z_INDEX.edge);
      expect(edge.zIndex).toBeGreaterThan(Z_INDEX.group + 1);
      expect(edge.zIndex).toBeLessThan(Z_INDEX.leaf);
    }
  });

  it('maps edges with kind, label, protocol and handles on facing sides', () => {
    expect(flow.edges.map((e) => e.data.memberEdgeIds)).toEqual([['e1'], ['e2']]);
    expect(flow.edges.map((e) => e.id)).toEqual(['a.x.p>a.y:dataflow', 'a>b:config']);
    const [e1, e2] = flow.edges;
    expect(e1).toMatchObject({
      type: 'arch',
      source: 'a.x.p',
      target: 'a.y',
      data: { kind: 'dataflow', label: 'stuff', protocol: 'HTTP' },
      className: 'arch-edge-dataflow',
      interactionWidth: 20,
    });
    expect(e2?.data).toEqual({
      kind: 'config',
      count: 1,
      memberEdgeIds: ['e2'],
      description: 'why',
      labelShown: true,
      route: {
        sourceSide: 'right',
        targetSide: 'left',
        sourceDir: 'right',
        targetDir: 'left',
        lane: 0,
        lanes: 1,
        offset: 0,
        labelT: 0.5,
      },
      curve: e2 ? curveOf(e2, layout) : undefined,
    });
    for (const edge of flow.edges) {
      const source = layout.absolute.get(edge.source);
      const target = layout.absolute.get(edge.target);
      if (!source || !target) throw new Error('missing rect');
      const sides = facingSides(source, target);
      expect(edge.sourceHandle).toBe(sourceHandleId(sides.source));
      expect(edge.targetHandle).toBe(targetHandleId(sides.target));
    }
  });
});

describe('buildFlow: edges joining the same two nodes', () => {
  const yaml = `
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - { id: a.x, name: X }
      - { id: a.y, name: Y }
      - { id: a.z, name: Z }
edges:
  - { id: e1, from: a.x, to: a.y, kind: dataflow, label: there }
  - { id: e2, from: a.y, to: a.z, kind: dataflow }
  - { id: e3, from: a.y, to: a.x, kind: control, label: back }
  - { id: e4, from: a.x, to: a.y, kind: config }
`;
  let layout: LayoutResult;
  let flow: FlowGraph;
  const edge = (id: string): FlowEdge => {
    const found = flow.edges.find((e) => e.data.memberEdgeIds.includes(id));
    if (!found) throw new Error(`no edge ${id}`);
    return found;
  };
  beforeAll(async () => {
    const model = parseOk(yaml);
    layout = await computeLayoutUncached(model);
    flow = buildFlow(model, layout);
  });

  it('gives each of them its own lane, in document order, whatever direction and kind', () => {
    expect(['e1', 'e3', 'e4'].map((id) => edge(id).data.route.lane)).toEqual([0, 1, 2]);
    for (const id of ['e1', 'e3', 'e4']) expect(edge(id).data.route.lanes).toBe(3);
    expect(edge('e2').data.route).toMatchObject({ lane: 0, lanes: 1, offset: 0, labelT: 0.5 });
  });

  it('attaches them to the same pair of sides, mirrored for the opposite direction', () => {
    const there = edge('e1').data.route;
    const back = edge('e3').data.route;
    expect(edge('e4').data.route).toMatchObject({
      sourceSide: there.sourceSide,
      targetSide: there.targetSide,
    });
    expect(back).toMatchObject({
      sourceSide: there.targetSide,
      targetSide: there.sourceSide,
      sourceDir: there.targetDir,
      targetDir: there.sourceDir,
    });
    expect(edge('e3').sourceHandle).toBe(sourceHandleId(there.targetSide));
    expect(edge('e3').targetHandle).toBe(targetHandleId(there.sourceSide));
  });

  it('draws them side by side: distinct offsets, ends, paths and label positions', () => {
    const ids = ['e1', 'e3', 'e4'];
    const offsets = ids.map((id) => edge(id).data.route.offset);
    expect(new Set(offsets).size).toBe(3);
    expect(offsets[0]).toBe(-(offsets[2] ?? 0)); // centred on the middle of the side
    expect(offsets[1]).toBe(0);
    const curves = ids.map((id) => curveOf(edge(id), layout));
    // No end of one edge coincides with an end of another, in either direction.
    const ends = curves.flatMap((c) => [c.p0, c.p3]).map((p) => `${p.x},${p.y}`);
    expect(new Set(ends).size).toBe(6);
    expect(new Set(curves.map(curvePath)).size).toBe(3);
    const labels = ids.map((id, i) => {
      const curve = curves[i];
      if (!curve) throw new Error('missing curve');
      const p = curvePoint(curve, edge(id).data.route.labelT);
      return `${p.x},${p.y}`;
    });
    expect(new Set(labels).size).toBe(3);
    // The lanes stay on the side they attach to.
    const x = layout.absolute.get('a.x');
    if (!x) throw new Error('missing rect');
    for (const curve of [curves[0], curves[2]]) {
      const p = curve?.p0;
      if (!p) throw new Error('missing curve');
      expect(p.x).toBeGreaterThanOrEqual(x.x);
      expect(p.x).toBeLessThanOrEqual(x.x + x.width);
      expect(p.y).toBeGreaterThanOrEqual(x.y);
      expect(p.y).toBeLessThanOrEqual(x.y + x.height);
    }
  });

  it('carries the curve each edge is drawn along', () => {
    for (const e of flow.edges) expect(e.data.curve).toEqual(curveOf(e, layout));
  });

  it('resolves a click to the nearest line, although the hit areas of the lanes overlap', () => {
    // The lanes are closer together than a hit area is wide: what is on top says nothing.
    expect(LANE_GAP).toBeLessThan(EDGE_INTERACTION_WIDTH);
    for (const id of ['e1', 'e3', 'e4']) {
      const self = edge(id);
      for (let i = 1; i < 20; i++) {
        const on = curvePoint(self.data.curve, i / 20);
        expect(nearestEdgeAt(on, flow.edges)?.id).toBe(self.id);
        // Also a few pixels off the line, on either side.
        for (const d of [-4, 4]) {
          expect(nearestEdgeAt({ x: on.x + d, y: on.y + d }, flow.edges)?.id).toBe(self.id);
        }
      }
    }
  });

  it('gives no edge for a click away from every line', () => {
    const middle = curvePoint(edge('e2').data.curve, 0.5);
    expect(nearestEdgeAt(middle, flow.edges)?.id).toBe(edge('e2').id);
    expect(nearestEdgeAt({ x: -500, y: -500 }, flow.edges)).toBeUndefined();
    expect(nearestEdgeAt(middle, flow.edges, 0)?.id).toBe(edge('e2').id);
    expect(nearestEdgeAt(middle, [])).toBeUndefined();
    // Just outside the hit area.
    const curve = edge('e2').data.curve;
    const reach = EDGE_INTERACTION_WIDTH / 2;
    const away = [
      { x: middle.x + reach + 2, y: middle.y },
      { x: middle.x, y: middle.y + reach + 2 },
    ].filter((p) => distanceToCurve(p, curve) > reach);
    expect(away.length).toBeGreaterThan(0);
    for (const p of away) expect(nearestEdgeAt(p, [edge('e2')])).toBeUndefined();
  });

  it('of lines at the same distance takes the one drawn last', () => {
    const [first] = flow.edges;
    if (!first) throw new Error('no edge');
    const twin = { ...first, id: 'twin' };
    const on = curvePoint(first.data.curve, 0.5);
    expect(nearestEdgeAt(on, [first, twin])?.id).toBe('twin');
    expect(nearestEdgeAt(on, [twin, first])?.id).toBe(first.id);
  });

  it('passes over a line that edges on demand keeps out of sight', () => {
    const [first] = flow.edges;
    if (!first) throw new Error('no edge');
    const hidden = { ...first, id: 'hidden', data: { ...first.data, quiet: true } };
    const on = curvePoint(first.data.curve, 0.5);
    expect(nearestEdgeAt(on, [first, hidden])?.id).toBe(first.id);
    expect(nearestEdgeAt(on, [hidden])).toBeUndefined();
  });
});

describe('buildFlow: edges between a node and its own ancestor or descendant', () => {
  const yaml = `
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - { id: a.x, name: X }
      - { id: a.y, name: Y }
  - id: b
    name: Beta
    components:
      - id: b.c
        name: C
        subcomponents:
          - { id: b.c.d, name: D }
          - { id: b.c.e, name: E }
edges:
  - { id: down, from: a, to: a.x, kind: control }
  - { id: up, from: b.c.d, to: b, kind: dependency }
`;
  it('stay inside the container, on one side of both nodes', async () => {
    const model = parseOk(yaml);
    const layout = await computeLayoutUncached(model);
    const flow = buildFlow(model, layout);
    for (const edge of flow.edges) {
      const { route } = edge.data;
      expect(route.targetSide, edge.id).toBe(route.sourceSide);
      const containerIsSource = edge.data.memberEdgeIds.includes('down');
      // The end on the container's border points inwards, the other one outwards.
      expect(route.sourceDir).toBe(
        containerIsSource ? OPPOSITE_SIDE[route.sourceSide] : route.sourceSide,
      );
      expect(route.targetDir).toBe(
        containerIsSource ? route.targetSide : OPPOSITE_SIDE[route.targetSide],
      );
      const container = layout.absolute.get(containerIsSource ? edge.source : edge.target);
      if (!container) throw new Error('missing rect');
      const curve = curveOf(edge, layout);
      for (let i = 0; i <= 50; i++) {
        const p = curvePoint(curve, i / 50);
        expect(p.x).toBeGreaterThanOrEqual(container.x - 1e-6);
        expect(p.x).toBeLessThanOrEqual(container.x + container.width + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(container.y - 1e-6);
        expect(p.y).toBeLessThanOrEqual(container.y + container.height + 1e-6);
      }
      expect(hiddenSamples(curve, leafRects(model, layout))).toBe(0);
    }
  });
});

describe('buildFlow for examples/architecture.yaml', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  let flow: FlowGraph;
  beforeAll(async () => {
    model = parseOk(exampleYaml);
    layout = await computeLayoutUncached(model);
    flow = buildFlow(model, layout);
  });

  it('lays out with no overlapping boxes', () => {
    expect(layoutViolations(model, layout)).toEqual([]);
    // Independently of the layout's own invariants: no two leaves overlap anywhere.
    const leaves = [...model.nodes.values()].filter((n) => n.childIds.length === 0);
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = layout.absolute.get(leaves[i]?.id ?? '');
        const b = layout.absolute.get(leaves[j]?.id ?? '');
        if (!a || !b) throw new Error('missing rect');
        expect(overlaps(a, b), `${leaves[i]?.id} overlaps ${leaves[j]?.id}`).toBe(false);
      }
    }
  });

  it('is deterministic across reloads', async () => {
    clearLayoutCache();
    const again = await computeLayoutUncached(parseOk(exampleYaml));
    expect([...again.rects]).toEqual([...layout.rects]);
    expect(again.rows).toEqual(layout.rows);
    expect(again.unassignedArea).toEqual(layout.unassignedArea);
    expect(buildFlow(parseOk(exampleYaml), again)).toEqual(flow);
    // And the cached entry point agrees with the uncached one.
    expect(buildFlow(model, await computeLayout(model))).toEqual(flow);
  });

  it('renders every model node and edge exactly once', () => {
    expect(archNodes(flow).map((n) => n.id)).toEqual([...model.nodes.keys()]);
    expect(flow.edges.map((e) => e.data.memberEdgeIds)).toEqual(model.edges.map((e) => [e.id]));
    expect(new Set(flow.edges.map((e) => e.id)).size).toBe(flow.edges.length);
    expect(new Set(flow.nodes.map((n) => n.id)).size).toBe(flow.nodes.length);
  });

  it('lists every parent before its children', () => {
    const seen = new Set<string>();
    for (const node of archNodes(flow)) {
      if (node.parentId !== undefined) expect(seen.has(node.parentId)).toBe(true);
      seen.add(node.id);
    }
  });

  it('puts one non-interactive band per row, plus the Unassigned area, behind everything', () => {
    const bands = flow.nodes.filter(isBand);
    expect(bands.map((b) => b.id)).toEqual([
      ...model.rows.map((r) => bandNodeId(r.id)),
      UNASSIGNED_NODE_ID,
    ]);
    // Bands come first so they are also first in DOM order.
    expect(flow.nodes.slice(0, bands.length)).toEqual(bands);
    const minOther = Math.min(...archNodes(flow).map((n) => n.zIndex));
    bands.forEach((band, i) => {
      expect(band.selectable).toBe(false);
      expect(band.draggable).toBe(false);
      expect(band.focusable).toBe(false);
      expect(band.zIndex).toBeLessThan(minOther);
      const row = layout.rows[i];
      if (row) {
        expect(band.data).toEqual({
          variant: 'row',
          name: model.rows[i]?.name,
          index: i,
          gutterWidth: layout.gutterWidth,
        });
        expect(band.position).toEqual({ x: row.x, y: row.y });
        expect(band.style).toEqual({ width: row.width, height: row.height });
      } else {
        expect(band.data).toMatchObject({ variant: 'unassigned', name: 'Unassigned' });
        expect(band.position).toEqual({
          x: layout.unassignedArea?.x,
          y: layout.unassignedArea?.y,
        });
      }
    });
    // Row bands span the whole width of the banded part of the canvas, gutter included.
    for (const row of layout.rows) {
      expect(row.x).toBe(0);
      expect(row.width).toBe(layout.rows[0]?.width);
      expect(row.width).toBeGreaterThan(layout.gutterWidth);
    }
  });

  it('marks nodes whose row was derived from their connections', () => {
    expect(layout.placedRow.size).toBeGreaterThan(0);
    const rowNames = new Map(model.rows.map((r) => [r.id, r.name]));
    for (const node of archNodes(flow)) {
      const placed = layout.placedRow.get(node.id);
      expect(node.data.placedRowName).toBe(placed === undefined ? undefined : rowNames.get(placed));
      // The dashed border comes from the inner element's class, set from `placedRowName`.
      expect(node).not.toHaveProperty('className');
    }
  });

  it('connects nodes on the sides facing each other (vertically between rows) when nothing is in the way', () => {
    const bandIndex = new Map(layout.rows.map((b, i) => [b.id, i]));
    const obstacles = leafRects(model, layout);
    let crossRow = 0;
    let horizontal = 0;
    let rerouted = 0;
    for (const edge of flow.edges) {
      const source = layout.absolute.get(edge.source);
      const target = layout.absolute.get(edge.target);
      if (!source || !target) throw new Error('missing rect');
      const { route } = edge.data;
      expect(edge.sourceHandle).toBe(sourceHandleId(route.sourceSide));
      expect(edge.targetHandle).toBe(targetHandleId(route.targetSide));

      const from = bandIndex.get(layout.rowOf.get(edge.source) ?? '');
      const to = bandIndex.get(layout.rowOf.get(edge.target) ?? '');
      const acrossRows = from !== undefined && to !== undefined && from !== to;
      const facing = facingSides(source, target, acrossRows);
      const direct = edgeCurve(
        sidePoint(source, facing.source),
        facing.source,
        sidePoint(target, facing.target),
        facing.target,
      );
      const others = leafRects(model, layout, [edge.source, edge.target]);
      if (hiddenSamples(direct, others) > 0) {
        // Something stands between the two nodes: the edge goes around it instead.
        rerouted++;
        expect([route.sourceSide, route.targetSide], edge.id).not.toEqual([
          facing.source,
          facing.target,
        ]);
        continue;
      }
      if ([route.sourceSide, route.targetSide].join() !== [facing.source, facing.target].join()) {
        // Only allowed when the direct curve passes too close to a box (routing keeps a margin).
        expect(routeEdge(source, target, obstacles, acrossRows), edge.id).toMatchObject({
          sourceSide: route.sourceSide,
          targetSide: route.targetSide,
        });
        continue;
      }
      if (route.sourceSide === 'left' || route.sourceSide === 'right') horizontal++;
      if (!acrossRows || from === undefined || to === undefined) continue;
      crossRow++;
      const expected: [Side, Side] = from < to ? ['bottom', 'top'] : ['top', 'bottom'];
      expect([route.sourceSide, route.targetSide], edge.id).toEqual(expected);
    }
    expect(crossRow).toBeGreaterThan(0);
    expect(horizontal).toBeGreaterThan(0);
    expect(rerouted).toBeGreaterThan(0);
  });

  it('routes edges around the leaf nodes standing between their ends', () => {
    // Edges are drawn below leaf nodes: whatever passes behind one is invisible. With the plain
    // facing-sides choice 14 of the 44 edges did (one for 75% of its length).
    const SAMPLES = 400;
    const hidden = flow.edges.map((edge) => ({
      id: edge.id,
      samples: hiddenSamples(
        curveOf(edge, layout),
        leafRects(model, layout, [edge.source, edge.target]),
        SAMPLES,
      ),
    }));
    for (const { id, samples } of hidden) {
      // At most a corner clipped, never a stretch of the edge.
      expect(samples / SAMPLES, id).toBeLessThan(0.03);
    }
    expect(hidden.filter((h) => h.samples > 0).length).toBeLessThanOrEqual(3);
    // And no edge doubles back through its own end nodes.
    for (const edge of flow.edges) {
      const own = leafRects(model, layout).filter(
        (r) => r === layout.absolute.get(edge.source) || r === layout.absolute.get(edge.target),
      );
      expect(hiddenSamples(curveOf(edge, layout), own, SAMPLES), edge.id).toBe(0);
    }
  });

  it('lets every edge be selected on its own line, in every view', () => {
    const views = [
      {},
      { collapsedIds: new Set(model.nodes.keys()) },
      { lodLevel: 'domains' },
      { lodLevel: 'components' },
    ] as const;
    for (const view of views) {
      const shown = buildFlow(model, layout, view);
      expect(shown.edges.length).toBeGreaterThan(0);
      for (const e of shown.edges) {
        let own = 0;
        for (let i = 1; i <= 37; i++) {
          if (nearestEdgeAt(curvePoint(e.data.curve, i / 38), shown.edges)?.id === e.id) own++;
        }
        // All of its line but where another edge crosses it.
        expect(own, `${e.id} in ${JSON.stringify(view)}`).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('separates the two edges between the event store and the dashboards', () => {
    const there = flow.edges.find((e) => e.data.memberEdgeIds.includes('store-to-dashboards'));
    const back = flow.edges.find((e) => e.data.memberEdgeIds.includes('dashboards-query-store'));
    if (!there || !back) throw new Error('example edges renamed');
    expect([there.source, there.target]).toEqual([back.target, back.source]);
    expect([there.data.route.lane, back.data.route.lane]).toEqual([0, 1]);
    expect(there.data.route.lanes).toBe(2);
    expect(back.data.route.lanes).toBe(2);
    expect(Math.abs(there.data.route.offset - back.data.route.offset)).toBeGreaterThanOrEqual(12);
    const a = curveOf(there, layout);
    const b = curveOf(back, layout);
    expect(Math.hypot(a.p0.x - b.p3.x, a.p0.y - b.p3.y)).toBeGreaterThanOrEqual(12);
    expect(Math.hypot(a.p3.x - b.p0.x, a.p3.y - b.p0.y)).toBeGreaterThanOrEqual(12);
    const labelA = curvePoint(a, there.data.route.labelT);
    const labelB = curvePoint(b, back.data.route.labelT);
    // Labels are about 16px high: staggered far enough along the curve not to cover each other.
    expect(Math.abs(labelA.y - labelB.y)).toBeGreaterThan(24);
    // Every pair of nodes joined by several edges gets as many lanes.
    const byPair = new Map<string, FlowEdge[]>();
    for (const edge of flow.edges) {
      const key = [edge.source, edge.target].sort().join(' ');
      byPair.set(key, [...(byPair.get(key) ?? []), edge]);
    }
    for (const group of byPair.values()) {
      expect(group.map((e) => e.data.route.lane)).toEqual(group.map((_, i) => i));
      expect(new Set(group.map((e) => e.data.route.offset)).size).toBe(group.length);
    }
  });
});

describe('buildFlow: routes are kept across rebuilds of the same layout', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  beforeAll(async () => {
    model = parseOk(exampleYaml);
    layout = await computeLayoutUncached(model);
  });

  /** The same layout as a new object: nothing is cached for it yet. */
  const fresh = (): LayoutResult => structuredClone(layout);
  const pairCount = (flow: FlowGraph): number =>
    new Set(flow.edges.map((edge) => [edge.source, edge.target].sort().join('\n'))).size;

  it('routes nothing again for a view it has built before, nor for a hidden edge kind', () => {
    const first = buildFlow(model, layout);
    const size = routeCacheSize(layout);
    expect(size).toBe(pairCount(first));
    expect(buildFlow(model, layout)).toEqual(first);
    // Edges of one kind left out: the remaining ones run between the same boxes as before.
    const withoutConfig = {
      ...model,
      edges: model.edges.filter((edge) => edge.kind !== 'config'),
    };
    const filtered = buildFlow(withoutConfig, layout);
    expect(filtered.edges.length).toBeLessThan(first.edges.length);
    expect(routeCacheSize(layout)).toBe(size);
    expect(filtered).toEqual(buildFlow(withoutConfig, fresh()));
  });

  it('reroutes only part of the edges when a group is collapsed', () => {
    buildFlow(model, layout);
    const group = [...model.nodes.values()].find(
      (node) => node.level === 1 && node.childIds.length > 0,
    );
    if (!group) throw new Error('the example has no component with subcomponents');
    const before = routeCacheSize(layout);
    const collapsed = buildFlow(model, layout, { collapsedIds: new Set([group.id]) });
    const added = routeCacheSize(layout) - before;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(pairCount(collapsed));
  });

  it('gives the same flow as an unshared layout in every view, whatever was built before', () => {
    const groups = [...model.nodes.values()].filter((node) => node.childIds.length > 0);
    const views: FlowView[] = [
      {},
      { lodLevel: 'components' },
      { lodLevel: 'domains' },
      ...groups.map((node) => ({ collapsedIds: new Set([node.id]) })),
      { collapsedIds: new Set(groups.map((node) => node.id)) },
      {},
    ];
    for (const view of views) {
      expect(buildFlow(model, layout, view)).toEqual(buildFlow(model, fresh(), view));
    }
  });
});

describe('closedGroupSize', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  beforeAll(async () => {
    model = parseOk(exampleYaml);
    layout = await computeLayoutUncached(model);
  });
  const overlay = () => buildWorkItemOverlay(model, parseWorkItems(fixtureJson).items);

  it('gives a closed group the badge line when stories are hidden inside it', () => {
    const workItems = { overlay: overlay(), mode: 'stories' as const };
    const none = { overlay: buildWorkItemOverlay(model, []), mode: 'stories' as const };
    for (const id of groupIds(model)) {
      const stories = subtreeWorkItemCounts(workItems.overlay, id).stories > 0;
      expect(closedGroupBadge(workItems, id)).toBe(stories);
      expect(closedGroupBadge({ ...workItems, mode: 'tasks' }, id)).toBe(stories);
      expect(closedGroupBadge({ ...workItems, mode: 'off' }, id)).toBe(false);
      expect(closedGroupBadge(undefined, id)).toBe(false);
      expect(closedGroupBadge(none, id)).toBe(false);
    }
    expect(groupIds(model).some((id) => closedGroupBadge(workItems, id))).toBe(true);
  });

  it('is the size buildFlow draws every closed group at', () => {
    const [first] = model.rootIds;
    const whole = first === undefined ? undefined : layout.absolute.get(first);
    if (first === undefined || !whole) throw new Error('no root');
    // The first domain squeezed too small to list a single child: drawn at its full box.
    const tiny = { ...whole, width: 120, height: 40 };
    const squeezed: LayoutResult = {
      ...layout,
      rects: new Map(layout.rects).set(first, tiny),
      absolute: new Map(layout.absolute).set(first, tiny),
    };
    const workItems = { overlay: overlay(), mode: 'stories' as const };
    const collapsedSets = [new Set(model.rootIds), new Set(groupIds(model))];
    let checked = 0;
    let badged = 0;
    for (const compactCollapsed of [true, false]) {
      for (const items of [undefined, workItems]) {
        for (const base of [layout, squeezed]) {
          for (const collapsedIds of collapsedSets) {
            const view: FlowView = {
              collapsedIds,
              compactCollapsed,
              lodLevel: 'subcomponents',
              ...(items ? { workItems: items } : {}),
            };
            for (const node of archNodes(buildFlow(model, base, view))) {
              const arch = model.nodes.get(node.id);
              const full = base.absolute.get(node.id);
              if (!arch || !full || !node.data.collapsed) continue;
              expect(closedGroupSize(model, arch, full, view)).toEqual({
                width: node.width,
                height: node.height,
              });
              checked += 1;
              if (node.data.badge && node.data.compact) badged += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(badged).toBeGreaterThan(0);
  });

  it('is the full size with groups not drawn shrunk', () => {
    for (const id of groupIds(model)) {
      const node = model.nodes.get(id);
      const full = layout.absolute.get(id);
      if (!node || !full) throw new Error(id);
      expect(closedGroupSize(model, node, full, {})).toEqual({
        width: full.width,
        height: full.height,
      });
    }
  });

  it('gives a box of the shrunk size that very size again', () => {
    const items = overlay();
    let shrunk = 0;
    for (const id of groupIds(model)) {
      const node = model.nodes.get(id);
      const full = layout.absolute.get(id);
      if (!node || !full) throw new Error(id);
      const names = node.childIds.map((child) => model.nodes.get(child)?.name ?? child);
      for (const workItems of [undefined, { overlay: items, mode: 'stories' as const }]) {
        const view = { compactCollapsed: true, ...(workItems ? { workItems } : {}) };
        const size = closedGroupSize(model, node, full, view);
        const at = { x: 17, y: 230, ...size };
        expect(closedGroupSize(model, node, at, view)).toEqual(size);
        if (size.width < full.width || size.height < full.height) shrunk += 1;
        // The box drawn inside a rectangle of that size is that rectangle.
        for (const extra of [0, COMPACT_GROUP.badgeLine]) {
          const box = compactGroupBox(full, node.name, names, extra).rect;
          const again = compactGroupBox({ ...box, x: 3, y: 5 }, node.name, names, extra).rect;
          expect(again).toEqual({ ...box, x: 3, y: 5 });
        }
      }
    }
    expect(shrunk).toBeGreaterThan(10);
  });
});

describe('drawnNodeRects', () => {
  it('gives every box where buildFlow draws it, a closed group that spans rows shrunk in its column', async () => {
    const model = parseOk(exampleYaml);
    const reference = await computeLayoutUncached(model);
    const workItems = {
      overlay: buildWorkItemOverlay(model, parseWorkItems(fixtureJson).items),
      mode: 'stories' as const,
    };
    let inColumn = 0;
    for (const lodLevel of ['domains', 'components', 'subcomponents', 'detail'] as const) {
      for (const collapsedIds of [new Set<string>(), new Set(['data.analytics', 'storefront'])]) {
        for (const view of [
          { collapsedIds, lodLevel },
          { collapsedIds, lodLevel, compactCollapsed: true },
          { collapsedIds, lodLevel, compactCollapsed: true, workItems },
        ]) {
          // The layout as it is, and closed up around what is drawn.
          const closedUp = arrangedLayout(model, reference, {
            visible: visibleNodes(model, collapsedIds, lodLevel),
            closedSize: (node, full) => closedGroupSize(model, node, full, view),
          });
          for (const layout of [reference, closedUp]) {
            const drawn = new Map(
              miniMapNodes(buildFlow(model, layout, view).nodes)
                .filter((node) => node.type !== 'band')
                .map((node) => [node.id, node.rect]),
            );
            const rects = drawnNodeRects(model, layout, view);
            expect([...rects.keys()]).toEqual([...drawn.keys()]);
            for (const [id, rect] of rects) {
              const at = drawn.get(id);
              expect(at, id).toBeDefined();
              if (!at) continue;
              expect(rect.x, id).toBeCloseTo(at.x, 6);
              expect(rect.y, id).toBeCloseTo(at.y, 6);
              expect(rect.width, id).toBeCloseTo(at.width, 6);
              expect(rect.height, id).toBeCloseTo(at.height, 6);
              const full = layout.absolute.get(id);
              if (layout === closedUp && full && rect.height < full.height - 1) inColumn += 1;
            }
          }
        }
      }
    }
    // Closed up, a closed group that spans rows is smaller than the column the layout gives it.
    expect(inColumn).toBeGreaterThan(0);
  });
});

describe('buildFlow with the positions unlocked', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  beforeAll(async () => {
    model = parseOk(exampleYaml);
    layout = await computeLayoutUncached(model);
  });

  const classesOf = (node: FlowNode): string[] => (node.className ?? '').split(' ').filter(Boolean);
  /** The groups drawn with a child: the open ones. */
  const openGroups = (flow: FlowGraph): string[] => {
    const parents = new Set(archNodes(flow).map((node) => node.parentId));
    return archNodes(flow)
      .filter((node) => parents.has(node.id))
      .map((node) => node.id);
  };
  /** The nodes that only a part of them picks up, and the nodes whose class says so. */
  const byTitle = (flow: FlowGraph): string[] =>
    archNodes(flow)
      .filter((node) => node.dragHandle !== undefined)
      .map((node) => node.id);
  const marked = (flow: FlowGraph): string[] =>
    flow.nodes.filter((node) => classesOf(node).includes(TITLE_DRAG_CLASS)).map((node) => node.id);
  const resizable = (flow: FlowGraph): string[] =>
    archNodes(flow)
      .filter((node) => node.data.resize !== undefined)
      .map((node) => node.id);
  const within = (id: string, group: string): boolean => id === group || id.startsWith(`${group}.`);

  it('lets an open group be picked up by its title bar only, and every other box anywhere', () => {
    expect(GROUP_DRAG_HANDLE).toBe('.arch-group-header');
    expect(TITLE_DRAG_CLASS).toBe('arch-title-drag');
    const flow = buildFlow(model, layout, { draggable: true, lodLevel: 'subcomponents' });
    const open = openGroups(flow);
    expect(open).toEqual(groupIds(model));
    expect(open.length).toBeGreaterThan(10);
    for (const node of archNodes(flow)) {
      const isOpen = open.includes(node.id);
      expect(node.draggable, node.id).toBe(true);
      expect(node.dragHandle, node.id).toBe(isOpen ? GROUP_DRAG_HANDLE : undefined);
      expect(node.className, node.id).toBe(isOpen ? TITLE_DRAG_CLASS : undefined);
      expect(Object.keys(node).includes('dragHandle'), node.id).toBe(isOpen);
    }
    const bands = flow.nodes.filter(isBand);
    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) {
      expect(Object.keys(band)).not.toContain('dragHandle');
      expect(band.className).toBe('arch-band-node');
    }
  });

  it('picks a closed group up anywhere: collapsed by hand, closed by the level, or drawn shrunk', () => {
    const view = { draggable: true, lodLevel: 'subcomponents' } as const;
    const all = groupIds(model);
    const component = [...model.nodes.values()].find(
      (node) => node.level === 1 && node.childIds.length > 0,
    );
    const [domain] = model.rootIds;
    if (!component || domain === undefined) throw new Error('no domain, no component');
    for (const id of [domain, component.id]) {
      const closed = buildFlow(model, layout, { ...view, collapsedIds: new Set([id]) });
      expect(byTitle(closed)).toEqual(all.filter((other) => !within(other, id)));
      expect(marked(closed)).toEqual(byTitle(closed));
      // Opened again, it has both again.
      const opened = buildFlow(model, layout, { ...view, collapsedIds: new Set() });
      expect(byTitle(opened)).toEqual(all);
      expect(marked(opened)).toEqual(all);
    }
    // Closed by the level: no group at Domains, only the domains at Components.
    const domains = buildFlow(model, layout, { draggable: true, lodLevel: 'domains' });
    expect(byTitle(domains)).toEqual([]);
    expect(marked(domains)).toEqual([]);
    const components = buildFlow(model, layout, { draggable: true, lodLevel: 'components' });
    expect(byTitle(components)).toEqual(all.filter((id) => model.rootIds.includes(id)));
    expect(marked(components)).toEqual(byTitle(components));
    expect(archNodes(components).some((node) => node.data.collapsed)).toBe(true);
    // Drawn shrunk.
    const shrunk = buildFlow(model, layout, {
      ...view,
      lodLevel: 'components',
      compactCollapsed: true,
    });
    const small = archNodes(shrunk).filter((node) => node.data.compact);
    expect(small.length).toBeGreaterThan(0);
    for (const node of archNodes(shrunk).filter((other) => other.data.collapsed)) {
      expect(node.dragHandle, node.id).toBeUndefined();
      expect(node.className, node.id).toBeUndefined();
      expect(node.draggable, node.id).toBe(true);
    }
    // Locked: no node has either, at any level.
    for (const lodLevel of LOD_LEVELS) {
      const locked = buildFlow(model, layout, { lodLevel });
      expect(byTitle(locked)).toEqual([]);
      expect(marked(locked)).toEqual([]);
    }
  });

  it('keeps the title bar as the grip of an open group that a selection dims or a focus pales', () => {
    const flow = buildFlow(model, layout, { draggable: true });
    const leaf = archNodes(flow).find((node) => node.type === 'leaf' && node.data.level === 2);
    if (!leaf || leaf.parentId === undefined) throw new Error('no subcomponent');
    // The component selected: it stays lit with what is in it, the other groups are dimmed.
    const dimmed = highlightFlow(flow, { type: 'node', id: leaf.parentId });
    const paled = focusFlow(model, flow, {
      nodes: new Set([leaf.id]),
      edges: new Set(),
      itemIds: new Set(),
    });
    const before = new Map(archNodes(flow).map((node) => [node.id, node]));
    for (const [shown, extra] of [
      [dimmed, DIMMED_CLASS],
      [paled, FADED_CLASS],
    ] as const) {
      let both = 0;
      let untouched = 0;
      for (const node of archNodes(shown)) {
        const was = before.get(node.id);
        expect(node.dragHandle, node.id).toBe(was?.dragHandle);
        if (was?.dragHandle === undefined) continue;
        if (classesOf(node).includes(extra)) {
          both += 1;
          expect(node.className, node.id).toBe(`${TITLE_DRAG_CLASS} ${extra}`);
        } else {
          untouched += 1;
          expect(node.className, node.id).toBe(TITLE_DRAG_CLASS);
        }
      }
      expect(both, extra).toBeGreaterThan(0);
      expect(untouched, extra).toBeGreaterThan(0);
    }
  });

  it('gives the resize limits to exactly the open groups, and only while unlocked', () => {
    const limits = allResizeLimits(model, layout, NO_HAND_OVERRIDES);
    const [first, second] = [...limits.keys()];
    if (first === undefined || second === undefined) throw new Error('no two groups');
    const resize = { limits, resized: new Set([first]) };
    const flow = buildFlow(model, layout, { draggable: true, resize });
    expect(resizable(flow)).toEqual(groupIds(model));
    expect(resizable(flow)).toEqual(openGroups(flow));
    for (const node of archNodes(flow)) {
      const own = limits.get(node.id);
      expect(node.data.resize, node.id).toEqual(
        node.type === 'group' && own ? { ...own, resized: node.id === first } : undefined,
      );
    }
    for (const band of flow.nodes.filter(isBand)) {
      expect(Object.keys(band.data)).not.toContain('resize');
    }
    // Only with both: unlocked, and limits handed in; and only for a group that has limits.
    expect(resizable(buildFlow(model, layout, { resize }))).toEqual([]);
    expect(resizable(buildFlow(model, layout, { draggable: true }))).toEqual([]);
    const one = {
      limits: new Map([...limits].filter(([id]) => id === second)),
      resized: new Set<string>(),
    };
    const single = buildFlow(model, layout, { draggable: true, resize: one });
    expect(resizable(single)).toEqual([second]);
    expect(archNodes(single).find((node) => node.id === second)?.data.resize?.resized).toBe(false);
    // Never on a closed group: collapsed by hand, closed by the level, drawn shrunk.
    const collapsed = buildFlow(model, layout, {
      draggable: true,
      resize,
      collapsedIds: new Set([first]),
    });
    expect(resizable(collapsed)).toEqual(groupIds(model).filter((id) => !within(id, first)));
    expect(resizable(collapsed)).toEqual(openGroups(collapsed));
    const domains = buildFlow(model, layout, { draggable: true, resize, lodLevel: 'domains' });
    expect(resizable(domains)).toEqual([]);
    for (const compactCollapsed of [false, true]) {
      const components = buildFlow(model, layout, {
        draggable: true,
        resize,
        lodLevel: 'components',
        compactCollapsed,
      });
      expect(resizable(components)).toEqual(openGroups(components));
      expect(resizable(components)).toEqual(
        groupIds(model).filter((id) => model.rootIds.includes(id)),
      );
      expect(archNodes(components).some((node) => node.data.compact)).toBe(compactCollapsed);
    }
  });

  it('draws a resized group as the layout has it: open, closed in the resized box, shrunk in its middle', () => {
    const plain = buildFlow(model, layout, { lodLevel: 'domains' });
    const id = model.rootIds.find((root) =>
      plain.edges.some((edge) => edge.source === root || edge.target === root),
    );
    const was = id === undefined ? undefined : layout.absolute.get(id);
    if (id === undefined || !was) throw new Error('no domain with an edge');
    const routed = routeCacheSize(layout);
    const by = resizedByHand(NO_HAND_OVERRIDES, model, layout, id, {
      left: 60,
      right: 120,
      bottom: 40,
    });
    const resized = applyHandOverrides(model, layout, by);
    const box = { x: was.x - 60, y: was.y, width: was.width + 180, height: was.height + 40 };
    expect(resized.absolute.get(id)).toEqual(box);

    // Open: every node where the layout has it, at the size the layout has it.
    for (const lodLevel of LOD_LEVELS) {
      for (const node of archNodes(buildFlow(model, resized, { lodLevel }))) {
        const placed = resized.rects.get(node.id);
        expect({ ...node.position, width: node.width, height: node.height }, node.id).toEqual(
          placed,
        );
        expect(node.style, node.id).toEqual({ width: node.width, height: node.height });
      }
    }

    // Closed: the box is the resized one, and every edge ends on its border.
    const closed = buildFlow(model, resized, { lodLevel: 'domains' });
    const ends = closed.edges.flatMap((edge) => [
      ...(edge.source === id ? [edge.data.curve.p0] : []),
      ...(edge.target === id ? [edge.data.curve.p3] : []),
    ]);
    expect(ends.length).toBeGreaterThan(0);
    for (const end of ends) {
      const onSide =
        Math.abs(end.x - box.x) < 1e-6 ||
        Math.abs(end.x - box.x - box.width) < 1e-6 ||
        Math.abs(end.y - box.y) < 1e-6 ||
        Math.abs(end.y - box.y - box.height) < 1e-6;
      expect(onSide, JSON.stringify(end)).toBe(true);
      expect(end.x).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(end.x).toBeLessThanOrEqual(box.x + box.width + 1e-6);
      expect(end.y).toBeGreaterThanOrEqual(box.y - 1e-6);
      expect(end.y).toBeLessThanOrEqual(box.y + box.height + 1e-6);
    }

    // Shrunk: the small box sits in the middle of the resized one.
    const shrunk = buildFlow(model, resized, { lodLevel: 'domains', compactCollapsed: true });
    const small = archNodes(shrunk).find((node) => node.id === id);
    if (!small) throw new Error('not drawn');
    expect(small.data.compact).toBe(true);
    expect(small.width).toBeLessThan(box.width);
    expect(
      Math.abs(small.position.x + small.width / 2 - (box.x + box.width / 2)),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(small.position.y + small.height / 2 - (box.y + box.height / 2)),
    ).toBeLessThanOrEqual(0.5);

    // The routes worked out for the layout before the resize are those it had.
    expect(routeCacheSize(layout)).toBe(routed);
    expect(routeCacheSize(resized)).toBeGreaterThan(0);
  });
});

describe('openGroupAt', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  beforeAll(async () => {
    model = parseOk(exampleYaml);
    layout = await computeLayoutUncached(model);
  });

  const centre = (box: Rect): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  /** A point in the padding of a group: beside every child. */
  const inPadding = (box: Rect): Point => ({ x: box.x + 4, y: box.y + box.height - 4 });

  it('finds the innermost group drawn open that holds the point', () => {
    const flow = buildFlow(model, layout);
    const leaf = [...model.nodes.values()].find((node) => node.level === 2);
    const component = [...model.nodes.values()].find(
      (node) => node.level === 1 && node.childIds.length > 0,
    );
    const [domain] = model.rootIds;
    if (!leaf || !component || domain === undefined) throw new Error('no nested nodes');
    // In a leaf of a component: the component, not the domain around it.
    expect(openGroupAt(centre(rectOf(layout, leaf.id)), flow.nodes)).toBe(leaf.parentId);
    // In the padding of a group: that group. Its border belongs to it.
    for (const id of groupIds(model)) {
      const box = rectOf(layout, id);
      expect(openGroupAt(inPadding(box), flow.nodes), id).toBe(id);
    }
    const box = rectOf(layout, domain);
    const corner = { x: box.x + box.width, y: box.y + box.height };
    expect(openGroupAt(corner, flow.nodes)).toBe(domain);
    expect(openGroupAt({ x: corner.x + 1, y: corner.y }, flow.nodes)).toBeUndefined();
    expect(openGroupAt({ x: corner.x, y: corner.y + 1 }, flow.nodes)).toBeUndefined();
    // Outside every group, and in the label gutter of a row band.
    expect(openGroupAt({ x: -50, y: -50 }, flow.nodes)).toBeUndefined();
    const beyond = { x: layout.bounds.width + 50, y: layout.bounds.height + 50 };
    expect(openGroupAt(beyond, flow.nodes)).toBeUndefined();
    const [band] = layout.rows;
    if (!band) throw new Error('no rows');
    expect(layout.gutterWidth).toBeGreaterThan(8);
    const inBand = { x: band.x + 4, y: band.y + band.height / 2 };
    expect(openGroupAt(inBand, flow.nodes)).toBeUndefined();
    expect(openGroupAt(inBand, [])).toBeUndefined();
  });

  it('never gives a closed group: the open group around it, or none', () => {
    const [domain] = model.rootIds;
    const component = [...model.nodes.values()].find(
      (node) => node.level === 1 && node.childIds.length > 0,
    );
    if (domain === undefined || !component) throw new Error('no domain, no component');
    const closedDomain = buildFlow(model, layout, { collapsedIds: new Set([domain]) });
    expect(openGroupAt(centre(rectOf(layout, domain)), closedDomain.nodes)).toBeUndefined();
    const closedComponent = buildFlow(model, layout, { collapsedIds: new Set([component.id]) });
    const inComponent = inPadding(rectOf(layout, component.id));
    expect(openGroupAt(inComponent, buildFlow(model, layout).nodes)).toBe(component.id);
    expect(openGroupAt(inComponent, closedComponent.nodes)).toBe(component.parentId);
    for (const compactCollapsed of [false, true]) {
      const domains = buildFlow(model, layout, { lodLevel: 'domains', compactCollapsed });
      for (const id of groupIds(model)) {
        expect(openGroupAt(centre(rectOf(layout, id)), domains.nodes), id).toBeUndefined();
      }
    }
  });

  it('of two open groups at the same depth takes the later one, which is drawn on top', () => {
    const [first, second] = model.rootIds;
    if (first === undefined || second === undefined) throw new Error('no two domains');
    // Each domain in turn moved onto the corner of the other: the title bars lie on each other.
    for (const [movedId, ontoId] of [
      [first, second],
      [second, first],
    ] as const) {
      const from = rectOf(layout, movedId);
      const onto = rectOf(layout, ontoId);
      const by = movedByHand(NO_HAND_OVERRIDES, model, layout, movedId, {
        x: onto.x - from.x,
        y: onto.y - from.y,
      });
      const stacked = applyHandOverrides(model, layout, by);
      expect(rectOf(stacked, movedId)).toMatchObject({ x: onto.x, y: onto.y });
      const inBoth = { x: onto.x + 4, y: onto.y + 4 };
      expect(openGroupAt(inBoth, buildFlow(model, stacked).nodes)).toBe(second);
    }
  });

  it('follows a group moved by hand and a group resized by hand', () => {
    const [domain] = model.rootIds;
    if (domain === undefined) throw new Error('no domain');
    const was = rectOf(layout, domain);
    const moved = applyHandOverrides(
      model,
      layout,
      movedByHand(NO_HAND_OVERRIDES, model, layout, domain, {
        x: layout.bounds.width + 500 - was.x,
        y: 0,
      }),
    );
    const now = rectOf(moved, domain);
    expect(now.x).toBe(layout.bounds.width + 500);
    const movedFlow = buildFlow(model, moved);
    expect(openGroupAt(inPadding(was), buildFlow(model, layout).nodes)).toBe(domain);
    expect(openGroupAt(inPadding(was), movedFlow.nodes)).toBeUndefined();
    expect(openGroupAt(inPadding(now), movedFlow.nodes)).toBe(domain);

    // A group grown into free room of its parent: the middle of the strip it gained.
    const gained = (box: Rect, edge: EdgeName, room: number): Point => {
      const middle = centre(box);
      if (edge === 'left') return { x: box.x - room / 2, y: middle.y };
      if (edge === 'right') return { x: box.x + box.width + room / 2, y: middle.y };
      if (edge === 'top') return { x: middle.x, y: box.y - room / 2 };
      return { x: middle.x, y: box.y + box.height + room / 2 };
    };
    const before = buildFlow(model, layout).nodes;
    let followed = 0;
    for (const [id, limits] of allResizeLimits(model, layout, NO_HAND_OVERRIDES)) {
      const parentId = model.nodes.get(id)?.parentId;
      if (parentId === undefined) continue;
      for (const edge of EDGES) {
        const room = limits.outward[edge];
        const point = gained(rectOf(layout, id), edge, room);
        // Room that no other group lies in.
        if (room < 8 || openGroupAt(point, before) !== parentId) continue;
        const by = resizedByHand(NO_HAND_OVERRIDES, model, layout, id, { [edge]: room });
        const resized = applyHandOverrides(model, layout, by);
        expect(openGroupAt(point, buildFlow(model, resized).nodes), `${id} ${edge}`).toBe(id);
        followed += 1;
      }
    }
    expect(followed).toBeGreaterThan(5);
  });
});
