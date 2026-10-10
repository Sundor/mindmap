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
  hiddenSamples,
  LANE_GAP,
  nearestEdgeAt,
  routeCacheSize,
  OPPOSITE_SIDE,
  routeEdge,
  sidePoint,
  sourceHandleId,
  targetHandleId,
  UNASSIGNED_NODE_ID,
  Z_INDEX,
  type ArchFlowNode,
  type BandFlowNode,
  type Curve,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowView,
  type Side,
} from './flow';
import { arrangedLayout } from './arrange';
import {
  clearLayoutCache,
  computeLayout,
  computeLayoutUncached,
  type LayoutResult,
} from './layout';
import { layoutViolations, overlaps, parseOk } from './layout/test-helpers';
import type { Rect } from './layout/types';
import type { ArchitectureModel } from './model';
import { miniMapNodes } from './minimap';
import { groupIds, visibleNodes } from './visibility';
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
