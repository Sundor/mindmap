// Hierarchy helpers, edges of a node, the edge-kind filter, revealing and viewport maths.

import { beforeAll, describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import { buildFlow } from './flow';
import { focusSet } from './focus';
import { filterToFocus } from './focusFilter';
import { computeLayoutUncached, type LayoutResult } from './layout';
import { parseOk } from './layout/test-helpers';
import { LOD_CONFIG, lodForZoom } from './lod';
import { EDGE_KINDS, type ArchitectureModel, type EdgeKind } from './model';
import {
  ancestorsOf,
  expandToReveal,
  filterEdgesByKind,
  isFullyOnScreen,
  isSelfOrDescendant,
  isValidViewport,
  lodModeToDraw,
  lodRevealZoom,
  minLodForNode,
  nodeEdges,
  nodePath,
  nodeRowInfo,
  revealZoomForNodes,
  rowInfoText,
  showsEnoughOf,
  toggleEdgeKind,
  toScreen,
  unionRect,
  viewportKeepingPlace,
  viewportToReveal,
  withoutEdgeKinds,
  FIT_MAX_ZOOM,
  ZOOM_RANGE,
} from './navigate';
import type { Rect, Size } from './layout/types';
import type { Viewport } from './navigate';
import { rollupEdges } from './rollup';
import { LOD_LEVELS, LOD_MAX_LEVEL, visibleNodes } from './visibility';

const model = parseOk(`
version: 1
domains:
  - id: a
    name: Alpha
    components:
      - id: a.x
        name: X
        subcomponents:
          - id: a.x.one
            name: One
          - id: a.x.two
            name: Two
      - id: a.y
        name: Y
  - id: b
    name: Beta
    components:
      - id: b.p
        name: P
edges:
  - id: one-p
    from: a.x.one
    to: b.p
    kind: dataflow
  - id: two-p
    from: a.x.two
    to: b.p
    kind: dataflow
  - id: p-x
    from: b.p
    to: a.x
    kind: control
  - id: one-two
    from: a.x.one
    to: a.x.two
    kind: dependency
  - id: y-one
    from: a.y
    to: a.x.one
    kind: config
  - id: x-b
    from: a.x
    to: b
    kind: dependency
`);

describe('hierarchy', () => {
  it('ancestorsOf lists the ancestors, outermost first', () => {
    expect(ancestorsOf(model, 'a.x.one')).toEqual(['a', 'a.x']);
    expect(ancestorsOf(model, 'a.x')).toEqual(['a']);
    expect(ancestorsOf(model, 'a')).toEqual([]);
    expect(ancestorsOf(model, 'unknown')).toEqual([]);
  });

  it('nodePath is the breadcrumb ending at the node itself', () => {
    expect(nodePath(model, 'a.x.one').map((n) => n.name)).toEqual(['Alpha', 'X', 'One']);
    expect(nodePath(model, 'b').map((n) => n.id)).toEqual(['b']);
    expect(nodePath(model, 'unknown')).toEqual([]);
  });

  it('isSelfOrDescendant follows the parent chain, not the spelling of the ID', () => {
    expect(isSelfOrDescendant(model, 'a.x.one', 'a')).toBe(true);
    expect(isSelfOrDescendant(model, 'a.x', 'a.x')).toBe(true);
    expect(isSelfOrDescendant(model, 'a', 'a.x')).toBe(false);
    expect(isSelfOrDescendant(model, 'b.p', 'a')).toBe(false);
  });
});

describe('nodeEdges', () => {
  it('of a leaf: its own incoming and outgoing edges', () => {
    const edges = nodeEdges(model, 'a.x.one');
    expect(edges.outgoing.map((r) => [r.edge.id, r.otherId, r.own])).toEqual([
      ['one-p', 'b.p', true],
      ['one-two', 'a.x.two', true],
    ]);
    expect(edges.incoming.map((r) => [r.edge.id, r.otherId, r.own])).toEqual([
      ['y-one', 'a.y', true],
    ]);
    expect(edges.internal).toEqual([]);
  });

  it('of a group: also the edges of its descendants, labelled as not its own', () => {
    const edges = nodeEdges(model, 'a.x');
    expect(edges.outgoing.map((r) => [r.edge.id, r.endId, r.otherId, r.own])).toEqual([
      ['one-p', 'a.x.one', 'b.p', false],
      ['two-p', 'a.x.two', 'b.p', false],
      ['x-b', 'a.x', 'b', true],
    ]);
    expect(edges.incoming.map((r) => [r.edge.id, r.endId, r.otherId, r.own])).toEqual([
      ['p-x', 'a.x', 'b.p', true],
      ['y-one', 'a.x.one', 'a.y', false],
    ]);
    // Both ends inside the group: neither incoming nor outgoing.
    expect(edges.internal.map((e) => e.id)).toEqual(['one-two']);
  });

  it('of a domain: every edge is accounted for exactly once', () => {
    const edges = nodeEdges(model, 'a');
    expect(edges.outgoing.map((r) => r.edge.id)).toEqual(['one-p', 'two-p', 'x-b']);
    expect(edges.incoming.map((r) => r.edge.id)).toEqual(['p-x']);
    expect(edges.internal.map((e) => e.id)).toEqual(['one-two', 'y-one']);
    expect(edges.outgoing.every((r) => !r.own)).toBe(true);
  });

  it('of an unknown node: nothing', () => {
    expect(nodeEdges(model, 'nope')).toEqual({ incoming: [], outgoing: [], internal: [] });
  });
});

describe('edge-kind filter', () => {
  const hidden = (...kinds: EdgeKind[]): Set<EdgeKind> => new Set(kinds);

  it('drops the hidden kinds and keeps the order of the rest', () => {
    expect(filterEdgesByKind(model.edges, hidden()).map((e) => e.id)).toEqual(
      model.edges.map((e) => e.id),
    );
    expect(filterEdgesByKind(model.edges, hidden('dataflow', 'config')).map((e) => e.id)).toEqual([
      'p-x',
      'one-two',
      'x-b',
    ]);
    expect(filterEdgesByKind(model.edges, hidden(...EDGE_KINDS))).toEqual([]);
  });

  it('withoutEdgeKinds returns the model itself when nothing is hidden', () => {
    expect(withoutEdgeKinds(model, hidden())).toBe(model);
    const filtered = withoutEdgeKinds(model, hidden('control'));
    expect(filtered).not.toBe(model);
    expect(filtered.nodes).toBe(model.nodes);
    expect(filtered.edges.some((e) => e.kind === 'control')).toBe(false);
    expect(model.edges.some((e) => e.kind === 'control')).toBe(true);
  });

  it('is applied before the rollup: aggregates and counts are recomputed', () => {
    const example = parseOk(exampleYaml);
    const visible = visibleNodes(example, new Set(), 'domains');
    const all = rollupEdges(example, visible);
    const total = (aggregates: typeof all): number =>
      aggregates.reduce((sum, aggregate) => sum + aggregate.count, 0);
    for (const kind of EDGE_KINDS) {
      const filtered = rollupEdges(withoutEdgeKinds(example, hidden(kind)), visible);
      expect(filtered.some((aggregate) => aggregate.kind === kind)).toBe(false);
      // Aggregates of the other kinds are exactly what they were.
      expect(filtered).toEqual(all.filter((aggregate) => aggregate.kind !== kind));
      expect(total(filtered)).toBeLessThan(total(all));
    }
    expect(rollupEdges(withoutEdgeKinds(example, hidden(...EDGE_KINDS)), visible)).toEqual([]);
  });

  it('toggleEdgeKind adds or removes without touching its input', () => {
    const start = hidden('control');
    expect([...toggleEdgeKind(start, 'config')].sort()).toEqual(['config', 'control']);
    expect([...toggleEdgeKind(start, 'control')]).toEqual([]);
    expect([...start]).toEqual(['control']);
  });
});

describe('revealing', () => {
  it('expandToReveal expands every ancestor of the given nodes, and nothing else', () => {
    const collapsed = new Set(['a', 'a.x', 'b']);
    const next = expandToReveal(model, collapsed, ['a.x.one']);
    expect([...next]).toEqual(['b']);
    expect([...collapsed].sort()).toEqual(['a', 'a.x', 'b']); // input untouched
    expect(next).not.toBe(collapsed);
  });

  it('expandToReveal leaves a revealed group itself collapsed', () => {
    expect([...expandToReveal(model, new Set(['a', 'a.x']), ['a.x'])]).toEqual(['a.x']);
  });

  it('expandToReveal handles several nodes, domains and unknown IDs', () => {
    const collapsed = new Set(['a', 'a.x', 'b']);
    expect([...expandToReveal(model, collapsed, ['a.x.one', 'b.p'])]).toEqual([]);
    expect([...expandToReveal(model, collapsed, ['a', 'nope'])].sort()).toEqual(['a', 'a.x', 'b']);
    expect([...expandToReveal(model, collapsed, [])].sort()).toEqual(['a', 'a.x', 'b']);
  });

  it('after expandToReveal the nodes are visible at their level of detail', () => {
    const collapsed = new Set(['a', 'a.x', 'b']);
    for (const id of model.nodes.keys()) {
      const level = minLodForNode(model, id);
      if (!level) throw new Error('no level');
      expect(visibleNodes(model, collapsed, level).has(id)).toBe(
        ancestorsOf(model, id).length === 0,
      );
      expect(visibleNodes(model, expandToReveal(model, collapsed, [id]), level).has(id)).toBe(true);
    }
  });

  it('minLodForNode is the coarsest level that draws the node', () => {
    expect(minLodForNode(model, 'a')).toBe('domains');
    expect(minLodForNode(model, 'a.x')).toBe('components');
    expect(minLodForNode(model, 'a.x.one')).toBe('subcomponents');
    expect(minLodForNode(model, 'nope')).toBeUndefined();
    for (const node of model.nodes.values()) {
      const level = minLodForNode(model, node.id);
      if (!level) throw new Error('no level');
      const index = LOD_LEVELS.indexOf(level);
      expect(LOD_MAX_LEVEL[level]).toBeGreaterThanOrEqual(node.level);
      const coarser = LOD_LEVELS[index - 1];
      if (coarser) expect(LOD_MAX_LEVEL[coarser]).toBeLessThan(node.level);
    }
  });

  it('lodRevealZoom shows the level whatever level was shown before', () => {
    expect(lodRevealZoom('domains')).toBe(0);
    for (const level of ['components', 'detail'] as const) {
      const zoom = lodRevealZoom(level);
      const wanted = LOD_LEVELS.indexOf(level);
      for (const previous of [undefined, ...LOD_LEVELS]) {
        expect(LOD_LEVELS.indexOf(lodForZoom(zoom, previous))).toBeGreaterThanOrEqual(wanted);
      }
      // Beyond the hysteresis band, with a margin on top.
      const threshold = level === 'components' ? LOD_CONFIG.componentsZoom : LOD_CONFIG.detailZoom;
      expect(zoom).toBeGreaterThan(threshold * (1 + LOD_CONFIG.hysteresis) * 1.01);
    }
    expect(
      lodRevealZoom('detail', { ...LOD_CONFIG, detailZoom: 2, hysteresis: 0.1 }, 0),
    ).toBeCloseTo(2.2);
  });

  it('lodModeToDraw pins the level when no zoom of the canvas reaches it', () => {
    // Within the zoom range: as lodModeToReveal.
    expect(lodModeToDraw('auto', 'detail')).toBe('auto');
    expect(lodModeToDraw('components', 'detail')).toBe('detail');
    expect(lodModeToDraw('detail', 'components')).toBe('detail');
    // The Everything threshold at the top of its slider: zooming in cannot show the level.
    const top = { ...LOD_CONFIG, detailZoom: ZOOM_RANGE.max };
    expect(lodRevealZoom('detail', top)).toBeGreaterThan(ZOOM_RANGE.max);
    expect(lodModeToDraw('auto', 'detail', top)).toBe('detail');
    expect(lodModeToDraw('auto', 'components', top)).toBe('auto');
    expect(lodModeToDraw('subcomponents', 'detail', top)).toBe('detail');
    // Exactly reachable is reachable.
    const edge = { ...LOD_CONFIG, detailZoom: 2, hysteresis: 0 };
    const reach = lodRevealZoom('detail', edge);
    expect(lodModeToDraw('auto', 'detail', edge, { min: 0.05, max: reach })).toBe('auto');
    expect(lodModeToDraw('auto', 'detail', edge, { min: 0.05, max: reach - 0.01 })).toBe('detail');
  });

  it('revealZoomForNodes takes the deepest of the nodes', () => {
    expect(revealZoomForNodes(model, ['a', 'b'])).toBe(0);
    expect(revealZoomForNodes(model, ['a', 'b.p'])).toBe(lodRevealZoom('components'));
    expect(revealZoomForNodes(model, ['a.x.one', 'b.p'])).toBe(lodRevealZoom('subcomponents'));
    expect(revealZoomForNodes(model, ['nope'])).toBe(0);
  });
});

describe('viewport', () => {
  const size = { width: 1000, height: 600 };

  it('unionRect covers all rectangles', () => {
    expect(unionRect([])).toBeUndefined();
    expect(
      unionRect([
        { x: 10, y: 20, width: 30, height: 40 },
        { x: -5, y: 50, width: 10, height: 100 },
      ]),
    ).toEqual({ x: -5, y: 20, width: 45, height: 130 });
  });

  /** True when some part of `rect` (canvas coordinates) is on a screen of `screen`. */
  function isOnScreen(rect: Rect, viewport: Viewport, screen: Size): boolean {
    const s = toScreen(rect, viewport);
    return s.x < screen.width && s.x + s.width > 0 && s.y < screen.height && s.y + s.height > 0;
  }

  it('fits no further in than just past the subcomponents threshold', () => {
    expect(FIT_MAX_ZOOM).toBeGreaterThan(
      LOD_CONFIG.subcomponentsZoom * (1 + LOD_CONFIG.hysteresis),
    );
    expect(lodForZoom(FIT_MAX_ZOOM)).toBe('subcomponents');
    expect(FIT_MAX_ZOOM).toBeLessThanOrEqual(1.5);
    expect(FIT_MAX_ZOOM).toBeLessThan(ZOOM_RANGE.max);
  });

  it('toScreen applies the viewport', () => {
    const rect = { x: 100, y: 50, width: 40, height: 20 };
    expect(toScreen(rect, { x: 10, y: -5, zoom: 2 })).toEqual({
      x: 210,
      y: 95,
      width: 80,
      height: 40,
    });
    expect(isOnScreen(rect, { x: 0, y: 0, zoom: 1 }, size)).toBe(true);
    expect(isOnScreen(rect, { x: -500, y: 0, zoom: 1 }, size)).toBe(false);
    expect(isOnScreen(rect, { x: 0, y: 700, zoom: 1 }, size)).toBe(false);
  });

  it('isValidViewport wants finite numbers and a zoom within range', () => {
    expect(isValidViewport({ x: 0, y: 0, zoom: 1 })).toBe(true);
    expect(isValidViewport({ x: NaN, y: 0, zoom: 1 })).toBe(false);
    expect(isValidViewport({ x: 0, y: Infinity, zoom: 1 })).toBe(false);
    expect(isValidViewport({ x: 0, y: 0, zoom: 0 })).toBe(false);
    expect(isValidViewport({ x: 0, y: 0, zoom: ZOOM_RANGE.max + 1 })).toBe(false);
  });

  it('does not move when the target is on screen at a sufficient zoom', () => {
    const current = { x: 0, y: 0, zoom: 1.2 };
    const target = { x: 100, y: 100, width: 200, height: 100 };
    expect(viewportToReveal(current, target, size, { minZoom: 1.1 })).toBe(current);
    expect(viewportToReveal(current, target, size)).toBe(current);
  });

  it('centres an off-screen target, keeping the zoom', () => {
    const current = { x: 0, y: 0, zoom: 1 };
    const target = { x: 3000, y: 2000, width: 200, height: 100 };
    const next = viewportToReveal(current, target, size);
    expect(next.zoom).toBe(1);
    const screen = toScreen(target, next);
    expect(screen.x + screen.width / 2).toBeCloseTo(size.width / 2);
    expect(screen.y + screen.height / 2).toBeCloseTo(size.height / 2);
  });

  it('zooms in to the minimum zoom and centres', () => {
    const current = { x: 0, y: 0, zoom: 0.3 };
    const target = { x: 100, y: 100, width: 200, height: 100 };
    const next = viewportToReveal(current, target, size, { minZoom: 1.1 });
    expect(next.zoom).toBe(1.1);
    const screen = toScreen(target, next);
    expect(screen.x + screen.width / 2).toBeCloseTo(500);
    expect(screen.y + screen.height / 2).toBeCloseTo(300);
  });

  it('zooms out so that a large target fits with padding around it', () => {
    const current = { x: 0, y: 0, zoom: 2 };
    const target = { x: 0, y: 0, width: 2000, height: 400 };
    const next = viewportToReveal(current, target, size, { padding: 50 });
    expect(next.zoom).toBeCloseTo(0.45); // (1000 - 2 * 50) / 2000
    const screen = toScreen(target, next);
    expect(screen.x).toBeGreaterThanOrEqual(50 - 1e-6);
    expect(screen.x + screen.width).toBeLessThanOrEqual(950 + 1e-6);
    expect(screen.y).toBeGreaterThanOrEqual(0);
    expect(screen.y + screen.height).toBeLessThanOrEqual(600);
  });

  it('prefers the minimum zoom over fitting the whole target', () => {
    const current = { x: 0, y: 0, zoom: 0.5 };
    const target = { x: 0, y: 0, width: 5000, height: 100 };
    const next = viewportToReveal(current, target, size, { minZoom: 1.1 });
    expect(next.zoom).toBe(1.1);
    // Centred on the middle of the target.
    expect(toScreen(target, next).x + (5000 * 1.1) / 2).toBeCloseTo(500);
  });

  it('stays within the zoom range and survives a screen without size', () => {
    const current = { x: 0, y: 0, zoom: 1 };
    const target = { x: 0, y: 0, width: 10, height: 10 };
    expect(viewportToReveal(current, target, size, { minZoom: 99 }).zoom).toBe(ZOOM_RANGE.max);
    const huge = { x: 0, y: 0, width: 1e7, height: 1e7 };
    expect(viewportToReveal(current, huge, size).zoom).toBe(ZOOM_RANGE.min);
    expect(viewportToReveal(current, target, { width: 0, height: 0 }, { minZoom: 2 })).toBe(
      current,
    );
  });

  it('keeps the primary part on screen when the target does not fit at the minimum zoom', () => {
    const current = { x: 0, y: 0, zoom: 0.3 };
    const source = { x: 0, y: 0, width: 200, height: 100 };
    const far = { x: 4800, y: 3000, width: 200, height: 100 };
    const target = unionRect([source, far]);
    if (!target) throw new Error('no target');
    const padding = 40;
    // Without a primary part the view lands on the empty middle: neither end is on screen.
    const centred = viewportToReveal(current, target, size, { minZoom: 1.1, padding });
    expect(isOnScreen(source, centred, size) || isOnScreen(far, centred, size)).toBe(false);

    const next = viewportToReveal(current, target, size, {
      minZoom: 1.1,
      padding,
      primary: source,
    });
    expect(next.zoom).toBe(1.1);
    expect(isFullyOnScreen(source, next, size)).toBe(true);
    // Pulled as far toward the other end as the padding allows: the source sits in the corner
    // facing away from it.
    const s = toScreen(source, next);
    expect(s.x).toBeCloseTo(padding);
    expect(s.y).toBeCloseTo(padding);

    // The other way round, the far end is kept, in the opposite corner.
    const other = viewportToReveal(current, target, size, { minZoom: 1.1, padding, primary: far });
    expect(isFullyOnScreen(far, other, size)).toBe(true);
    const f = toScreen(far, other);
    expect(f.x + f.width).toBeCloseTo(size.width - padding);
    expect(f.y + f.height).toBeCloseTo(size.height - padding);
  });

  it('a primary part changes nothing when the whole target fits', () => {
    const current = { x: 0, y: 0, zoom: 0.3 };
    const source = { x: 2000, y: 2000, width: 100, height: 50 };
    const near = { x: 2300, y: 2100, width: 100, height: 50 };
    const target = unionRect([source, near]);
    if (!target) throw new Error('no target');
    const plain = viewportToReveal(current, target, size, { minZoom: 1.1 });
    const withPrimary = viewportToReveal(current, target, size, { minZoom: 1.1, primary: source });
    expect(withPrimary).toEqual(plain);
    expect(isFullyOnScreen(target, withPrimary, size)).toBe(true);
    // Already on screen: not moved at all.
    expect(viewportToReveal(plain, target, size, { minZoom: 1.1, primary: source })).toBe(plain);
  });

  it('a primary part does not push a target that only just fits off screen', () => {
    // Fits at the minimum zoom with less than the padding to spare on each side.
    const screen = { width: 1000, height: 800 };
    const target = { x: 0, y: 0, width: 900, height: 100 };
    const source = { x: 0, y: 0, width: 100, height: 100 };
    const current = { x: 5000, y: 5000, zoom: 0.5 };
    const options = { minZoom: 1.1025 };
    const plain = viewportToReveal(current, target, screen, options);
    const withPrimary = viewportToReveal(current, target, screen, { ...options, primary: source });
    expect(withPrimary).toEqual(plain);
    expect(withPrimary.zoom).toBeCloseTo(1.1025);
    expect(isFullyOnScreen(target, withPrimary, screen)).toBe(true);
  });

  it('centres a primary part that is itself larger than the screen', () => {
    const current = { x: 0, y: 0, zoom: 1 };
    const big = { x: 0, y: 0, width: 3000, height: 2000 };
    const target = { x: 0, y: 0, width: 9000, height: 2000 };
    const next = viewportToReveal(current, target, size, { minZoom: 1, primary: big });
    const s = toScreen(big, next);
    expect(s.x + s.width / 2).toBeCloseTo(size.width / 2);
    expect(s.y + s.height / 2).toBeCloseTo(size.height / 2);
  });

  it('showsEnoughOf wants a useful part on screen, not a sliver', () => {
    const map = { x: 0, y: 0, width: 2000, height: 1000 };
    expect(showsEnoughOf(map, { x: 0, y: 0, zoom: 1 }, size)).toBe(true);
    expect(showsEnoughOf(map, { x: size.width - 2, y: 0, zoom: 1 }, size)).toBe(false);
    expect(showsEnoughOf(map, { x: 0, y: size.height - 2, zoom: 1 }, size)).toBe(false);
    expect(showsEnoughOf(map, { x: size.width - 60, y: size.height - 60, zoom: 1 }, size)).toBe(
      true,
    );
    expect(showsEnoughOf(map, { x: size.width - 60, y: 0, zoom: 1 }, size, 100)).toBe(false);
    expect(showsEnoughOf(map, { x: -5000, y: 0, zoom: 1 }, size)).toBe(false);
    // Smaller than the margin but all of it on screen.
    expect(
      showsEnoughOf({ x: 0, y: 0, width: 20, height: 20 }, { x: 5, y: 5, zoom: 1 }, size),
    ).toBe(true);
  });

  it('reveals every edge of the example with its source on screen, on any canvas size', async () => {
    const example = parseOk(exampleYaml);
    const layout = await computeLayoutUncached(example);
    let both = 0;
    for (const screen of [
      { width: 1026, height: 700 },
      { width: 940, height: 640 },
      { width: 600, height: 420 },
    ]) {
      for (const edge of example.edges) {
        const source = layout.absolute.get(edge.from);
        const end = layout.absolute.get(edge.to);
        if (!source || !end) throw new Error('missing rect');
        const target = unionRect([source, end]);
        if (!target) throw new Error('no target');
        const minZoom = revealZoomForNodes(example, [edge.from, edge.to]);
        const next = viewportToReveal({ x: 0, y: 0, zoom: 0.3 }, target, screen, {
          minZoom,
          primary: source,
        });
        expect(next.zoom).toBeGreaterThanOrEqual(minZoom);
        const fits =
          source.width * next.zoom <= screen.width && source.height * next.zoom <= screen.height;
        if (fits) {
          expect(isFullyOnScreen(source, next, screen), `${edge.id} source`).toBe(true);
        } else {
          expect(isOnScreen(source, next, screen), `${edge.id} source`).toBe(true);
        }
        if (isFullyOnScreen(target, next, screen)) both++;
      }
    }
    // Most edges are short enough for both ends to be shown.
    expect(both).toBeGreaterThan(example.edges.length);
  });

  it('reveals both ends of every edge of the example at a zoom that draws them', async () => {
    const example = parseOk(exampleYaml);
    const layout = await computeLayoutUncached(example);
    const screen = { width: 1026, height: 700 };
    for (const edge of example.edges) {
      const ends = [edge.from, edge.to];
      const rects = ends.map((id) => layout.absolute.get(id)).filter((r) => r !== undefined);
      const target = unionRect(rects);
      if (!target) throw new Error('no target');
      const minZoom = revealZoomForNodes(example, ends);
      const next = viewportToReveal({ x: 0, y: 0, zoom: 0.2 }, target, screen, { minZoom });
      expect(next.zoom).toBeGreaterThanOrEqual(minZoom);
      // The level of detail at that zoom draws both ends once their groups are expanded …
      const level = lodForZoom(next.zoom, 'domains');
      const collapsed = expandToReveal(example, new Set(example.nodes.keys()), ends);
      const flow = buildFlow(example, layout, { collapsedIds: collapsed, lodLevel: level });
      const drawn = new Set(flow.nodes.map((n) => n.id));
      expect(drawn.has(edge.from) && drawn.has(edge.to)).toBe(true);
      // … and the edge is then drawn as itself.
      expect(flow.edges.some((e) => e.data.memberEdgeIds.includes(edge.id))).toBe(true);
    }
  });
});

describe('viewportKeepingPlace between layouts of different sets of nodes', () => {
  const size = { width: 1000, height: 600 };
  const rect = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });
  const whole = new Map([
    ['a', rect(0, 0, 400, 300)],
    ['a.x', rect(20, 60, 200, 100)],
    ['b', rect(600, 0, 200, 300)],
    ['c', rect(900, 0, 200, 300)],
  ]);
  /** Another arrangement, of `a` and `a.x` only. */
  const part = new Map([
    ['a', rect(0, 0, 260, 200)],
    ['a.x', rect(30, 50, 200, 100)],
  ]);
  /** The canvas point in the middle of the screen. */
  const centre = (viewport: Viewport) => ({
    x: (size.width / 2 - viewport.x) / viewport.zoom,
    y: (size.height / 2 - viewport.y) / viewport.zoom,
  });
  /** A viewport with canvas point (x, y) in the middle of the screen. */
  const lookingAt = (x: number, y: number, zoom: number): Viewport => ({
    x: size.width / 2 - x * zoom,
    y: size.height / 2 - y * zoom,
    zoom,
  });

  it('holds on to the node under the middle when both layouts have it', () => {
    // The middle of a.x, there and back.
    const next = viewportKeepingPlace(lookingAt(120, 110, 2), size, whole, part);
    expect(next.zoom).toBe(2);
    expect(centre(next)).toEqual({ x: 130, y: 100 });
    expect(centre(viewportKeepingPlace(next, size, part, whole))).toEqual({ x: 120, y: 110 });
  });

  it('holds on to the nearest node both have when the one under the middle is in one only', () => {
    // The middle of b, which `part` lacks: `a` is nearest, 500 left of it at the same height.
    const next = viewportKeepingPlace(lookingAt(700, 150, 1), size, whole, part);
    expect(centre(next)).toEqual({ x: 630, y: 100 });
    // Back again the middle is on no node of `part`; `a` is still the nearest.
    expect(centre(viewportKeepingPlace(next, size, part, whole))).toEqual({ x: 700, y: 150 });
  });

  it('returns the given viewport when the layouts share no node', () => {
    const current = lookingAt(700, 150, 1.5);
    const other = new Map([
      ['b', rect(0, 0, 200, 300)],
      ['c', rect(300, 0, 200, 300)],
    ]);
    expect(viewportKeepingPlace(current, size, part, other)).toBe(current);
    expect(viewportKeepingPlace(current, size, other, part)).toBe(current);
  });

  it('keeps a node of the example in view when the map is reduced to a flow, and back', async () => {
    const example = parseOk(exampleYaml);
    const set = focusSet(example, { type: 'flow', id: 'rule-release' });
    const reduced = set && filterToFocus(example, set)?.model;
    if (!reduced) throw new Error('nothing to filter');
    const kept = 'backoffice.config-manager.rule-editor';
    const before = (await computeLayoutUncached(example)).absolute;
    const after = (await computeLayoutUncached(reduced)).absolute;
    const from = before.get(kept);
    const to = after.get(kept);
    if (!from || !to) throw new Error('no rectangle');
    const current = lookingAt(from.x + from.width / 2, from.y + from.height / 2, 1.2);
    const next = viewportKeepingPlace(current, size, before, after);
    expect(centre(next).x).toBeCloseTo(to.x + to.width / 2, 6);
    expect(centre(next).y).toBeCloseTo(to.y + to.height / 2, 6);
    const back = viewportKeepingPlace(next, size, after, before);
    expect(centre(back).x).toBeCloseTo(from.x + from.width / 2, 6);
    expect(centre(back).y).toBeCloseTo(from.y + from.height / 2, 6);
  });
});

describe('nodeRowInfo', () => {
  let example: ArchitectureModel;
  let layout: LayoutResult;
  beforeAll(async () => {
    example = parseOk(exampleYaml);
    layout = await computeLayoutUncached(example);
  });
  const text = (id: string): string | undefined => {
    const info = nodeRowInfo(example, layout, id);
    return info && rowInfoText(info);
  };

  it('names the row of a node with a row of its own or an inherited one', () => {
    expect(text('backoffice')).toBe('Back-office level');
    expect(text('backoffice.studio.preview')).toBe('Back-office level');
    expect(text('operations.oms')).toBe('Middle level');
  });

  it('says which rows a spanning group spans', () => {
    expect(nodeRowInfo(example, layout, 'operations')).toEqual({
      kind: 'spans',
      from: 'Back-office level',
      to: 'Customer level',
    });
    expect(text('operations')).toBe('spans Back-office level–Customer level');
  });

  it('marks nodes placed by their connections', () => {
    expect([...layout.placedRow.keys()]).toContain('operations.alerts');
    expect(nodeRowInfo(example, layout, 'operations.alerts')?.kind).toBe('placed');
    expect(text('operations.alerts')).toMatch(/ level — placed by connections$/);
  });

  it('says Unassigned for nodes with no row anywhere in their subtree, and below them', () => {
    expect(text('platform')).toBe('Unassigned');
    expect(text('platform.identity.cert-authority')).toBe('Unassigned');
  });

  it('gives every node of the example some row text', () => {
    for (const id of example.nodes.keys()) expect(text(id)).toBeTruthy();
  });

  it('is undefined when the model has no rows, or the node is unknown', () => {
    expect(nodeRowInfo(model, { placedRow: new Map(), rowOf: new Map() }, 'a')).toBeUndefined();
    expect(nodeRowInfo(example, layout, 'nope')).toBeUndefined();
  });

  it('a row-less node below a placed node is in that row', () => {
    const rows = parseOk(`
version: 1
rows:
  - id: top
    name: Top
  - id: low
    name: Low
domains:
  - id: d
    name: D
    components:
      - id: d.a
        name: A
        row: top
      - id: d.b
        name: B
        row: low
      - id: d.c
        name: C
        subcomponents:
          - id: d.c.k
            name: K
edges:
  - id: c-b
    from: d.c
    to: d.b
    kind: dataflow
`);
    const placed = {
      placedRow: new Map([['d.c', 'low']]),
      rowOf: new Map([
        ['d.c', 'low'],
        ['d.c.k', 'low'],
      ]),
    };
    expect(nodeRowInfo(rows, placed, 'd.c')).toEqual({ kind: 'placed', name: 'Low' });
    expect(nodeRowInfo(rows, placed, 'd.c.k')).toEqual({ kind: 'row', name: 'Low' });
    expect(nodeRowInfo(rows, placed, 'd')).toEqual({ kind: 'spans', from: 'Top', to: 'Low' });
  });
});
