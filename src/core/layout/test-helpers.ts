// Shared helpers for the layout tests (not used by the app).

import { expect } from 'vitest';
import type { ArchitectureModel } from '../model';
import { parseArchitecture } from '../parse';
import { BAND_PADDING_Y, HEADER_HEIGHT } from './constants';
import type { LayoutResult, Rect } from './types';

export function parseOk(yaml: string): ArchitectureModel {
  const result = parseArchitecture(yaml, { sourceName: 'test.yaml' });
  expect(result.errors).toEqual([]);
  if (!result.model) throw new Error('model did not parse');
  return result.model;
}

export function rectOf(layout: LayoutResult, id: string): Rect {
  const rect = layout.absolute.get(id);
  if (!rect) throw new Error(`no rect for ${id}`);
  return rect;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function centreY(rect: Rect): number {
  return rect.y + rect.height / 2;
}

const EPS = 1e-6;

/** Invariants every layout must satisfy. Returns a list of violations. */
export function layoutViolations(model: ArchitectureModel, layout: LayoutResult): string[] {
  const problems: string[] = [];
  const abs = (id: string): Rect | undefined => layout.absolute.get(id);

  // Every node has a rect; relative rects agree with absolute ones; iteration in model order.
  expect([...layout.rects.keys()]).toEqual([...model.nodes.keys()]);
  expect([...layout.absolute.keys()]).toEqual([...model.nodes.keys()]);
  for (const node of model.nodes.values()) {
    const rel = layout.rects.get(node.id);
    const a = abs(node.id);
    if (!rel || !a) {
      problems.push(`${node.id}: missing rect`);
      continue;
    }
    if (!(rel.width > 0 && rel.height > 0)) problems.push(`${node.id}: empty rect`);
    const parent = node.parentId === undefined ? undefined : abs(node.parentId);
    const ox = parent?.x ?? 0;
    const oy = parent?.y ?? 0;
    if (Math.abs(a.x - ox - rel.x) > EPS || Math.abs(a.y - oy - rel.y) > EPS) {
      problems.push(`${node.id}: relative rect disagrees with absolute`);
    }
    // Containment below the parent's header.
    if (parent) {
      if (
        a.x < parent.x - EPS ||
        a.x + a.width > parent.x + parent.width + EPS ||
        a.y < parent.y + HEADER_HEIGHT - EPS ||
        a.y + a.height > parent.y + parent.height + EPS
      ) {
        problems.push(`${node.id}: not inside ${node.parentId} below its header`);
      }
    }
  }

  // Siblings never overlap, at every level.
  const siblingGroups: (readonly string[])[] = [
    model.rootIds,
    ...[...model.nodes.values()].map((n) => n.childIds),
  ];
  for (const ids of siblingGroups) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = abs(ids[i] ?? '');
        const b = abs(ids[j] ?? '');
        if (a && b && overlaps(a, b)) problems.push(`${ids[i]} overlaps ${ids[j]}`);
      }
    }
  }

  if (model.rows.length === 0) {
    if (layout.rows.length > 0 || layout.unassignedArea) problems.push('rows without rows');
    return problems;
  }

  // Bands: in YAML order, contiguous from 0, full width.
  let y = 0;
  layout.rows.forEach((band, i) => {
    if (band.id !== model.rows[i]?.id) problems.push(`band ${i} is ${band.id}`);
    if (Math.abs(band.y - y) > EPS) problems.push(`band ${band.id} not contiguous`);
    if (!(band.height > 0)) problems.push(`band ${band.id} empty`);
    y = band.y + band.height;
  });
  const bandIndex = new Map(layout.rows.map((b, i) => [b.id, i]));
  const bandsRight = Math.max(...layout.rows.map((b) => b.x + b.width));

  // Single-row nodes lie inside their band minus its padding; nothing else but spanning groups
  // and unassigned nodes crosses a band boundary.
  const unassigned = new Set<string>();
  for (const node of model.nodes.values()) {
    let top: string | undefined = node.id;
    while (model.nodes.get(top ?? '')?.parentId !== undefined)
      top = model.nodes.get(top ?? '')?.parentId;
    if (top !== undefined && model.nodes.get(top)?.rowRange === undefined) unassigned.add(node.id);
  }
  for (const node of model.nodes.values()) {
    const a = abs(node.id);
    if (!a) continue;
    if (unassigned.has(node.id)) {
      const area = layout.unassignedArea;
      if (
        !area ||
        a.x < area.x - EPS ||
        a.x + a.width > area.x + area.width + EPS ||
        a.y < area.y - EPS ||
        a.y + a.height > area.y + area.height + EPS
      ) {
        problems.push(`${node.id}: not inside the Unassigned area`);
      }
      continue;
    }
    if (a.x + a.width > bandsRight + EPS) problems.push(`${node.id}: right of the bands`);
    const rowId = layout.rowOf.get(node.id);
    if (rowId === undefined) {
      if (node.rowRange === undefined || node.effectiveRow !== undefined) {
        problems.push(`${node.id}: has no row but is not a spanning group`);
      }
      continue;
    }
    if (node.effectiveRow !== undefined && node.effectiveRow !== rowId) {
      problems.push(`${node.id}: rowOf ${rowId} but effective row ${node.effectiveRow}`);
    }
    const band = layout.rows[bandIndex.get(rowId) ?? -1];
    if (
      !band ||
      a.y < band.y + BAND_PADDING_Y - EPS ||
      a.y + a.height > band.y + band.height - BAND_PADDING_Y + EPS
    ) {
      problems.push(`${node.id}: outside its band ${rowId}`);
    }
  }
  if (layout.unassignedArea && layout.unassignedArea.x < bandsRight - EPS) {
    problems.push('Unassigned area overlaps the bands');
  }
  return problems;
}
