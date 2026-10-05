import { describe, expect, it } from 'vitest';
import exampleYaml from '../../examples/architecture.yaml?raw';
import { EDGE_KINDS, parseArchitecture, type ArchitectureModel } from './index';

function parseExample(): ArchitectureModel {
  const result = parseArchitecture(exampleYaml, { sourceName: 'examples/architecture.yaml' });
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  if (!result.model) throw new Error('example did not parse');
  return result.model;
}

describe('examples/architecture.yaml', () => {
  it('parses with no errors or warnings, and is large enough to exercise the viewer', () => {
    const model = parseExample();
    const levels = [0, 0, 0];
    for (const node of model.nodes.values()) levels[node.level] = (levels[node.level] ?? 0) + 1;
    const [domains = 0, components = 0, subcomponents = 0] = levels;
    expect(domains).toBeGreaterThanOrEqual(4);
    expect(domains).toBeLessThanOrEqual(6);
    expect(components).toBeGreaterThanOrEqual(12);
    expect(components).toBeLessThanOrEqual(20);
    expect(subcomponents).toBeGreaterThanOrEqual(18);
    expect(subcomponents).toBeLessThanOrEqual(30);
    expect(model.edges.length).toBeGreaterThanOrEqual(35);
    expect(model.edges.length).toBeLessThanOrEqual(50);
    expect(model.rootIds).toHaveLength(domains);
  });

  it('uses every edge kind and connects nodes at every level', () => {
    const model = parseExample();
    expect(new Set(model.edges.map((e) => e.kind))).toEqual(new Set(EDGE_KINDS));
    const levelPairs = new Set(
      model.edges.map((e) => `${model.nodes.get(e.from)?.level}-${model.nodes.get(e.to)?.level}`),
    );
    expect(levelPairs).toContain('0-0');
    expect(levelPairs).toContain('0-1');
    expect(levelPairs).toContain('1-2');
    expect(levelPairs).toContain('2-2');
    expect(levelPairs).toContain('1-0');
  });

  it('exercises every way a node can relate to the rows', () => {
    const model = parseExample();
    const node = (id: string) => {
      const n = model.nodes.get(id);
      if (!n) throw new Error(`missing ${id}`);
      return n;
    };
    expect(model.rows.map((r) => r.id)).toEqual(['backoffice', 'middle', 'channels']);

    // Domain with an explicit row: everything inside inherits it.
    expect(node('storefront').row).toBe('channels');
    expect(node('storefront.web.checkout').row).toBeUndefined();
    expect(node('storefront.web.checkout').effectiveRow).toBe('channels');
    expect(node('storefront.web.checkout').rowRange).toEqual({ top: 2, bottom: 2 });

    // Domain without a row whose components sit in different rows.
    expect(node('operations').row).toBeUndefined();
    expect(node('operations').rowRange).toEqual({ top: 0, bottom: 2 });

    // Component without a row whose subcomponents are in different rows (nested span).
    expect(node('data.analytics').rowRange).toEqual({ top: 0, bottom: 1 });
    expect(node('data').rowRange).toEqual({ top: 0, bottom: 1 });

    // Row-less children inside spanning groups (placed by connections later).
    expect(node('operations.alerts').rowRange).toBeUndefined();
    expect(node('data.analytics.feature-store').rowRange).toBeUndefined();

    // Nothing assigned anywhere in the subtree.
    const platform = node('platform');
    expect(platform.rowRange).toBeUndefined();
    for (const id of platform.childIds) expect(node(id).rowRange).toBeUndefined();
    const platformIds = new Set([...model.nodes.keys()].filter((id) => id.startsWith('platform')));
    const connected = model.edges.filter((e) => platformIds.has(e.from) || platformIds.has(e.to));
    const otherEnds = connected.map((e) => (platformIds.has(e.from) ? e.to : e.from));
    const rowsReached = new Set(otherEnds.map((id) => node(id).rowRange?.top));
    expect(rowsReached.size).toBeGreaterThanOrEqual(3);
  });
});
