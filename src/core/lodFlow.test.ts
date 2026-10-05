// The flow mapping across levels of detail: zooming changes what is shown,
// never where it is; manual collapse wins; bands are always there.

import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import {
  aggregateCountLabel,
  buildFlow,
  collapseAction,
  edgeLabelsShown,
  edgeLabelText,
  flowEdgeLabel,
  type ArchFlowNode,
  type BandFlowNode,
  type FlowGraph,
  type FlowNode,
} from './flow';
import { computeLayoutUncached, type LayoutResult } from './layout';
import { parseOk } from './layout/test-helpers';
import { createLodTracker } from './lod';
import type { ArchitectureModel } from './model';
import { groupIds, LOD_LEVELS, LOD_MAX_LEVEL, type LodLevel } from './visibility';

function isBand(node: FlowNode): node is BandFlowNode {
  return node.type === 'band';
}
function archNodes(flow: FlowGraph): ArchFlowNode[] {
  return flow.nodes.filter((n): n is ArchFlowNode => !isBand(n));
}
function bands(flow: FlowGraph): BandFlowNode[] {
  return flow.nodes.filter(isBand);
}

/** Everything about a node that a layout would decide. */
function geometry(node: ArchFlowNode) {
  return {
    position: node.position,
    width: node.width,
    height: node.height,
    style: node.style,
    parentId: node.parentId,
    extent: node.extent,
  };
}

function rootOf(id: string): string {
  return id.split('.')[0] ?? id;
}

describe('edgeLabelsShown', () => {
  it('is true from the subcomponents level on', () => {
    expect(LOD_LEVELS.map(edgeLabelsShown)).toEqual([false, false, true, true]);
  });
});

describe('flowEdgeLabel and the level of detail', () => {
  it('hides the label of a single edge, never the count of an aggregate', () => {
    const single = { count: 1, label: 'records', protocol: 'AMQP' };
    expect(flowEdgeLabel(single)).toBe('records [AMQP]');
    expect(flowEdgeLabel({ ...single, labelShown: true })).toBe('records [AMQP]');
    expect(flowEdgeLabel({ ...single, labelShown: false })).toBeUndefined();
    expect(flowEdgeLabel({ count: 3, labelShown: false })).toBe('×3');
    expect(flowEdgeLabel({ count: 3, labelShown: true })).toBe('×3');
  });
});

describe('buildFlow across levels of detail (examples/architecture.yaml)', () => {
  let model: ArchitectureModel;
  let layout: LayoutResult;
  let flows: Record<LodLevel, FlowGraph>;
  beforeAll(async () => {
    model = parseOk(exampleYaml);
    layout = await computeLayoutUncached(model);
    flows = {
      domains: buildFlow(model, layout, { lodLevel: 'domains' }),
      components: buildFlow(model, layout, { lodLevel: 'components' }),
      subcomponents: buildFlow(model, layout, { lodLevel: 'subcomponents' }),
      detail: buildFlow(model, layout, { lodLevel: 'detail' }),
    };
  });

  it('the example exercises every level', () => {
    const counts = LOD_LEVELS.map((lod) => archNodes(flows[lod]).length);
    const [domains = 0, components = 0, subcomponents = 0, detail = 0] = counts;
    expect(domains).toBe(model.rootIds.length);
    expect(components).toBeGreaterThan(domains);
    expect(detail).toBeGreaterThan(components);
    expect(detail).toBe(model.nodes.size);
    expect(subcomponents).toBe(detail);
  });

  it('shows exactly the nodes down to the depth of the level, in document order', () => {
    for (const lod of LOD_LEVELS) {
      const expected = [...model.nodes.values()]
        .filter((node) => node.level <= LOD_MAX_LEVEL[lod])
        .map((node) => node.id);
      expect(archNodes(flows[lod]).map((n) => n.id)).toEqual(expected);
    }
  });

  it('positions and sizes of visible nodes are identical at every level (zoom never lays out)', () => {
    const detail = new Map(archNodes(flows.detail).map((n) => [n.id, n]));
    for (const lod of LOD_LEVELS) {
      for (const node of archNodes(flows[lod])) {
        const full = detail.get(node.id);
        if (!full) throw new Error(`${node.id} is not in the detail mapping`);
        expect(geometry(node), `${lod}: ${node.id}`).toEqual(geometry(full));
        // … and both are the rectangle of the one layout of the fully expanded graph.
        const rect = layout.rects.get(node.id);
        expect({ ...node.position, width: node.width, height: node.height }).toEqual(rect);
      }
    }
  });

  it('row bands and the Unassigned area are the same at every level', () => {
    expect(bands(flows.detail).length).toBe(model.rows.length + (layout.unassignedArea ? 1 : 0));
    expect(bands(flows.detail).length).toBeGreaterThan(0);
    for (const lod of LOD_LEVELS) expect(bands(flows[lod])).toEqual(bands(flows.detail));
  });

  it('domains: domain boxes only, drawn like collapsed groups, with counts', () => {
    const nodes = archNodes(flows.domains);
    expect(nodes.every((n) => n.data.level === 0 && n.parentId === undefined)).toBe(true);
    const allCollapsed = buildFlow(model, layout, { collapsedIds: new Set(model.rootIds) });
    const byHand = new Map(archNodes(allCollapsed).map((n) => [n.id, n]));
    for (const node of nodes) {
      const hand = byHand.get(node.id);
      if (!hand) throw new Error(`${node.id} missing`);
      // Same box as a domain collapsed by hand; only the "manually" flag differs.
      expect({
        ...node,
        data: { ...node.data, manuallyCollapsed: hand.data.manuallyCollapsed },
      }).toEqual(hand);
      expect(node.data.collapsed).toBe(node.data.childCount > 0);
      expect(node.data.manuallyCollapsed).toBe(false);
      expect(node.data.counts.children).toBe(model.nodes.get(node.id)?.childIds.length);
      // Closed by the level of detail, not by hand: no toggle is offered.
      expect(collapseAction(node.data)).toBeUndefined();
    }
  });

  it('domains: edges are aggregated between domains, with count labels', () => {
    const { edges } = flows.domains;
    const roots = new Set(model.rootIds);
    expect(edges.every((e) => roots.has(e.source) && roots.has(e.target))).toBe(true);
    const crossing = model.edges.filter((e) => rootOf(e.from) !== rootOf(e.to));
    expect(edges.flatMap((e) => e.data.memberEdgeIds).sort()).toEqual(
      crossing.map((e) => e.id).sort(),
    );
    const aggregates = edges.filter((e) => e.data.count > 1);
    expect(aggregates.length).toBeGreaterThan(0);
    for (const edge of aggregates) {
      expect(flowEdgeLabel(edge.data)).toBe(aggregateCountLabel(edge.data.count));
    }
    for (const edge of edges.filter((e) => e.data.count === 1)) {
      expect(flowEdgeLabel(edge.data)).toBeUndefined();
    }
  });

  it('components: no subcomponents; components with children look collapsed', () => {
    const nodes = archNodes(flows.components);
    expect(nodes.some((n) => n.data.level === 1)).toBe(true);
    expect(nodes.some((n) => n.data.level === 2)).toBe(false);
    const withChildren = nodes.filter((n) => n.data.level === 1 && n.data.childCount > 0);
    expect(withChildren.length).toBeGreaterThan(0);
    for (const node of nodes) {
      if (node.data.level === 0) {
        expect(node.data.collapsed, node.id).toBe(false);
        expect(collapseAction(node.data)).toBe(node.data.childCount > 0 ? 'collapse' : undefined);
      } else {
        expect(node.data.collapsed, node.id).toBe(node.data.childCount > 0);
        expect(node.type).toBe(node.data.childCount > 0 ? 'group' : 'leaf');
        expect(collapseAction(node.data)).toBeUndefined();
      }
    }
  });

  it('components: labels of single edges hidden, aggregate counts shown', () => {
    const { edges } = flows.components;
    const singles = edges.filter((e) => e.data.count === 1);
    const aggregates = edges.filter((e) => e.data.count > 1);
    // The labels are still in the data (for the detail panel), just not drawn.
    expect(singles.some((e) => edgeLabelText(e.data) !== undefined)).toBe(true);
    for (const edge of singles) {
      expect(edge.data.labelShown).toBe(false);
      expect(flowEdgeLabel(edge.data)).toBeUndefined();
    }
    expect(aggregates.length).toBeGreaterThan(0);
    for (const edge of aggregates) {
      expect(flowEdgeLabel(edge.data)).toBe(aggregateCountLabel(edge.data.count));
    }
    // Every edge ends on a visible node.
    const shown = new Set(archNodes(flows.components).map((n) => n.id));
    expect(edges.every((e) => shown.has(e.source) && shown.has(e.target))).toBe(true);
  });

  it('detail: everything, with edge labels; it is the default view', () => {
    expect(flows.detail).toEqual(buildFlow(model, layout));
    expect(archNodes(flows.detail).some((n) => n.data.collapsed)).toBe(false);
    const labelled = flows.detail.edges.filter((e) => e.data.count === 1);
    expect(labelled.every((e) => e.data.labelShown)).toBe(true);
    expect(labelled.map((e) => flowEdgeLabel(e.data))).toEqual(
      labelled.map((e) => edgeLabelText(e.data)),
    );
    expect(labelled.some((e) => flowEdgeLabel(e.data) !== undefined)).toBe(true);
  });

  it('manual collapse always wins over the level of detail', () => {
    const domain = model.rootIds.find((id) =>
      model.nodes.get(id)?.childIds.some((c) => (model.nodes.get(c)?.childIds.length ?? 0) > 0),
    );
    if (domain === undefined) throw new Error('the example has no three-level domain');
    const collapsedIds = new Set([domain]);
    for (const lod of LOD_LEVELS) {
      const flow = buildFlow(model, layout, { collapsedIds, lodLevel: lod });
      const nodes = archNodes(flow);
      // Zoomed all the way in, the collapsed domain still hides everything inside it …
      expect(
        nodes.some((n) => n.id.startsWith(`${domain}.`)),
        lod,
      ).toBe(false);
      const box = nodes.find((n) => n.id === domain);
      expect(box?.data.collapsed).toBe(true);
      expect(box?.data.manuallyCollapsed).toBe(true);
      expect(box && collapseAction(box.data)).toBe('expand');
      // … and the rest of the map follows the level of detail as usual.
      const others = flows[lod].nodes.filter((n) => rootOf(n.id) !== domain);
      expect(flow.nodes.filter((n) => rootOf(n.id) !== domain)).toEqual(others);
    }
    // A collapsed component stays closed at full detail, next to open siblings.
    const component = groupIds(model).find((id) => model.nodes.get(id)?.level === 1);
    if (component === undefined) throw new Error('the example has no component group');
    const flow = buildFlow(model, layout, { collapsedIds: new Set([component]) });
    expect(archNodes(flow).some((n) => n.parentId === component)).toBe(false);
    expect(archNodes(flow).some((n) => n.data.level === 2)).toBe(true);
  });

  it('a zoom sweep in and out only ever swaps between the mappings of the levels', () => {
    const track = createLodTracker();
    const seen: LodLevel[] = [];
    const zooms: number[] = [];
    for (let z = 0.05; z <= 4; z *= 1.02) zooms.push(z);
    for (const zoom of [...zooms, ...zooms.reverse()]) {
      const lod = track(zoom);
      if (seen[seen.length - 1] !== lod) {
        seen.push(lod);
        // The mapping depends on the level alone, not on the zoom.
        expect(buildFlow(model, layout, { lodLevel: lod })).toEqual(flows[lod]);
      }
    }
    expect(seen).toEqual([
      'domains',
      'components',
      'subcomponents',
      'detail',
      'subcomponents',
      'components',
      'domains',
    ]);
  });
});
