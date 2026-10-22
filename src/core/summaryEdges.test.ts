// Summary edges, plain edges and the summary of a closed group.

import { describe, expect, it } from 'vitest';
import { closedGroupText, compactGroupBox, compactGroupText, fitsCompact } from './compactGroup';
import { parseOk } from './layout/test-helpers';
import { withPlainEdges } from './navigate';
import { parseArchitecture } from './parse';
import { rollupEdges } from './rollup';
import { visibleNodes } from './visibility';

const YAML = `
version: 1
domains:
  - id: shop
    name: Shop
    summary: Sells to customers
    components:
      - id: shop.web
        name: Web
        subcomponents:
          - { id: shop.web.basket, name: Basket }
          - { id: shop.web.pay, name: Pay }
      - { id: shop.catalog, name: Catalog }
  - id: orders
    name: Orders
    components:
      - { id: orders.api, name: API }
      - { id: orders.jobs, name: Jobs }
edges:
  - { id: pay-api, from: shop.web.pay, to: orders.api, kind: dataflow, label: POST /orders }
  - { id: basket-api, from: shop.web.basket, to: orders.api, kind: dependency }
  - { id: jobs-catalog, from: orders.jobs, to: shop.catalog, kind: control, label: refresh }
  - { id: shop-orders, from: shop, to: orders, kind: dataflow, label: orders, summary: true }
  - { id: pays, from: shop.web, to: orders.api, kind: dataflow, label: pays, replaces: [pay-api, basket-api] }
`;

const model = parseOk(YAML);
const ids = (edges: readonly { id: string }[]): string[] => edges.map((edge) => edge.id);

describe('summary edges in the rollup', () => {
  it('are not drawn while the group at their end is open', () => {
    const all = rollupEdges(withPlainEdges(model, false), visibleNodes(model, new Set(), 'detail'));
    expect(ids(all)).toEqual([
      'shop.web.pay>orders.api:dataflow',
      'shop.web.basket>orders.api:dependency',
      'orders.jobs>shop.catalog:control',
    ]);
  });

  it('stand for the edges inside the closed group that run the same way', () => {
    // The shop closed: its edges to the orders merge — the summary edge takes their place,
    // with its own label and kind; the edge the other way (jobs → catalog) stays merged.
    const visible = visibleNodes(model, new Set(['shop']), 'detail');
    const drawn = rollupEdges(withPlainEdges(model, false), visible);
    expect(ids(drawn)).toEqual(['orders.jobs>shop:control', 'shop>orders:dataflow']);
    const summary = drawn.find((edge) => edge.id === 'shop>orders:dataflow');
    expect(summary?.count).toBe(1);
    expect(summary?.edge?.id).toBe('shop-orders');
    expect(summary?.edge?.label).toBe('orders');
    // Without the summary edge the two inner edges would have made two merged lines.
    const plain = { ...model, edges: model.edges.filter((edge) => edge.summary !== true) };
    expect(ids(rollupEdges(withPlainEdges(plain, false), visible))).toEqual([
      'shop>orders.api:dataflow',
      'shop>orders.api:dependency',
      'orders.jobs>shop:control',
    ]);
  });

  it('are drawn between the closed boxes at the Domains level', () => {
    const drawn = rollupEdges(
      withPlainEdges(model, false),
      visibleNodes(model, new Set(), 'domains'),
    );
    expect(ids(drawn)).toEqual(['orders>shop:control', 'shop>orders:dataflow']);
    expect(drawn[1]?.edge?.id).toBe('shop-orders');
  });
});

describe('plain edges', () => {
  it('are left out unless asked for; asked for, they take the place of the edges they replace', () => {
    expect(ids(withPlainEdges(model, false).edges)).toEqual([
      'pay-api',
      'basket-api',
      'jobs-catalog',
      'shop-orders',
    ]);
    expect(ids(withPlainEdges(model, true).edges)).toEqual(['jobs-catalog', 'shop-orders', 'pays']);
    const visible = visibleNodes(model, new Set(), 'detail');
    expect(ids(rollupEdges(withPlainEdges(model, true), visible))).toEqual([
      'orders.jobs>shop.catalog:control',
      'shop.web>orders.api:dataflow',
    ]);
  });

  it('leave a file without any as it is', () => {
    const plain = { ...model, edges: model.edges.filter((edge) => edge.replaces === undefined) };
    expect(withPlainEdges(plain, true)).toBe(plain);
    expect(withPlainEdges(plain, false)).toBe(plain);
  });
});

describe('the parser', () => {
  const edge = (line: string) =>
    parseArchitecture(`${YAML}  - ${line}\n`, { sourceName: 'test.yaml' });
  const messages = (result: ReturnType<typeof parseArchitecture>) =>
    result.errors.map((error) => `${error.path}: ${error.message}`);

  it('keeps the summary of a node and the summary and the replaced edges of an edge', () => {
    expect(model.nodes.get('shop')?.summary).toBe('Sells to customers');
    expect(model.nodes.get('orders')?.summary).toBeUndefined();
    expect(model.edges.find((e) => e.id === 'shop-orders')?.summary).toBe(true);
    expect(model.edges.find((e) => e.id === 'pay-api')?.summary).toBeUndefined();
    expect(model.edges.find((e) => e.id === 'pays')?.replaces).toEqual(['pay-api', 'basket-api']);
  });

  it('refuses a summary edge with no group at either end', () => {
    const result = edge(
      '{ id: bad, from: shop.catalog, to: orders.api, kind: dataflow, summary: true }',
    );
    expect(messages(result)).toEqual([
      'edges[5].summary: Edge "bad" is a summary edge, but neither end is a group: a summary edge stands for the edges inside the group it ends at',
    ]);
  });

  it('refuses an edge that replaces itself, an unknown edge, or an edge that replaces others', () => {
    expect(
      messages(
        edge('{ id: self, from: shop.catalog, to: orders.api, kind: dataflow, replaces: [self] }'),
      ),
    ).toEqual(['edges[5].replaces[0]: Edge "self" cannot replace itself']);
    expect(
      messages(
        edge('{ id: ghost, from: shop.catalog, to: orders.api, kind: dataflow, replaces: [nope] }'),
      ),
    ).toEqual(['edges[5].replaces[0]: Edge "ghost" replaces unknown edge "nope"']);
    expect(
      messages(
        edge('{ id: deep, from: shop.catalog, to: orders.api, kind: dataflow, replaces: [pays] }'),
      ),
    ).toEqual([
      'edges[5].replaces[0]: Edge "deep" replaces "pays", which replaces edges itself: only edges that stand for nothing can be replaced',
    ]);
  });
});

describe('the summary of a closed group', () => {
  const rect = { x: 0, y: 0, width: 600, height: 300 };
  const names = ['Web', 'Catalog', 'Payments', 'Search', 'Recommendations'];

  it('is what a shrunk box says in place of the names', () => {
    expect(closedGroupText('Sells to customers', names)).toBe('Sells to customers');
    expect(closedGroupText(undefined, names, 2)).toBe(compactGroupText(names, 2));
    const box = compactGroupBox(rect, 'Shop', names, 0, 'Sells to customers');
    expect(box.hidden).toBe(0);
    expect(fitsCompact(box, names)).toBe(true);
    // Sized for the summary: narrower than the box the five names take.
    expect(box.rect.height).toBeLessThanOrEqual(compactGroupBox(rect, 'Shop', names).rect.height);
  });

  it('keeps the full box when even that cannot hold the summary', () => {
    const tiny = { x: 0, y: 0, width: 120, height: 60 };
    const box = compactGroupBox(
      tiny,
      'Shop',
      names,
      0,
      'A summary far too long for a tiny box to hold',
    );
    expect(box.rect).toEqual(tiny);
    expect(fitsCompact(box, names)).toBe(false);
  });
});
