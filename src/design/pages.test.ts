import { beforeAll, describe, expect, it } from 'vitest';
import css from '../ui/styles.css?raw';
import { lodForZoom } from '../core';
import { startTags, staticProblems, type StartTag } from './markup';
import { designPages, type DesignPage } from './pages';
import { KIT_SPECIMENS, SCREENS } from './specimens';
import { appStylesheetOf, attributeTests, classNames, idNames, unscoped } from './stylesheet';

// Sources of src/ui, read as text: what the components write as ids has to be on the pages.
const sources = import.meta.glob<string>('../ui/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const byName = new Map(
  Object.entries(sources).map(([path, text]) => [
    path.slice(path.lastIndexOf('/') + 1).replace('.tsx', ''),
    text,
  ]),
);

/** Ids the components write that no page can carry, each with its reason. */
const ID_EXCEPTIONS: Readonly<Record<string, string>> = {
  'views-note': 'shown only after a view was saved or a link copied: component state',
  'export-status': 'shown only after an export was made: component state',
};
/** Class names the stylesheet selects that no page can carry, each with its reason. */
const CLASS_EXCEPTIONS: Readonly<Record<string, string>> = {
  dragging: 'set by React Flow while a box is dragged',
  'detail-section-drop': 'set while a section of the detail panel is dragged over another',
};

let pages: DesignPage[];
let tags: StartTag[];
const classesOf = (tag: StartTag): string[] => (tag.attributes.get('class') ?? '').split(' ');

beforeAll(async () => {
  pages = await designPages();
  tags = pages.flatMap((page) => startTags(page.html));
}, 120_000);

const page = (fileName: DesignPage['fileName']): string => {
  const found = pages.find((candidate) => candidate.fileName === fileName);
  if (!found) throw new Error(`No page ${fileName}`);
  return found.html;
};

describe('the design pages', () => {
  it('are nothing but markup and styles', () => {
    for (const { fileName, html } of pages) expect(staticProblems(html), fileName).toEqual([]);
  });

  it('carry the app stylesheet unchanged', () => {
    for (const { fileName, html } of pages) {
      const found = appStylesheetOf(html);
      expect(found, fileName).toBeDefined();
      expect(unscoped(found ?? ''), fileName).toBe(css);
    }
  });

  it('show every specimen and every screen once, with a label and a note', () => {
    const ids = tags
      .filter(
        (tag) =>
          classesOf(tag).includes('tpl-specimen') || classesOf(tag).includes('tpl-screen-section'),
      )
      .map((tag) => tag.attributes.get('id'));
    expect(new Set(ids).size).toBe(ids.length);
    for (const info of [...KIT_SPECIMENS, ...SCREENS]) expect(ids).toContain(`tpl-${info.id}`);
    expect(tags.filter((tag) => classesOf(tag).includes('tpl-note')).length).toBe(ids.length);
  });

  it('carry every id the components write, and no exception that is not needed', () => {
    const written = new Set<string>();
    for (const text of byName.values()) {
      for (const match of text.matchAll(/\bid="([^"]+)"/g)) written.add(match[1] ?? '');
    }
    expect(written.size).toBeGreaterThan(90);
    const present = new Set(tags.map((tag) => tag.attributes.get('id')));
    const missing = [...written].filter((id) => !present.has(id) && !(id in ID_EXCEPTIONS));
    expect(missing).toEqual([]);
    const unneeded = Object.keys(ID_EXCEPTIONS).filter((id) => present.has(id));
    expect(unneeded).toEqual([]);
  });

  it('carry every class, id and attribute the stylesheet selects', () => {
    const present = new Set(tags.flatMap(classesOf));
    const missing = [...classNames(css)].filter(
      (name) => !name.startsWith('tpl-') && !present.has(name) && !(name in CLASS_EXCEPTIONS),
    );
    expect(missing).toEqual([]);
    const unneeded = Object.keys(CLASS_EXCEPTIONS).filter((name) => present.has(name));
    expect(unneeded).toEqual([]);
    const ids = new Set(tags.map((tag) => tag.attributes.get('id')));
    expect(
      [...idNames(css)].filter((id) => id !== 'root' && !id.startsWith('tpl-') && !ids.has(id)),
    ).toEqual([]);
    const attributes = new Set(tags.flatMap((tag) => [...tag.attributes.keys()]));
    expect(
      attributeTests(css)
        .filter((test) => !attributes.has(test.name))
        .map((test) => test.name),
    ).toEqual([]);
  });

  it('reach every component of src/ui from the generator, except App', () => {
    const reached = new Set<string>();
    const walk = (name: string): void => {
      const text = byName.get(name);
      if (text === undefined || reached.has(name)) return;
      reached.add(name);
      for (const match of text.matchAll(/from '\.\/(\w+)'/g)) walk(match[1] ?? '');
    };
    const design = import.meta.glob<string>(['./*.ts', './*.tsx', '!./*.test.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    for (const text of Object.values(design)) {
      for (const match of text.matchAll(/from '\.\.\/ui\/(\w+)'/g)) walk(match[1] ?? '');
    }
    expect([...byName.keys()].filter((name) => !reached.has(name))).toEqual(['App']);
  });

  it('give the same text twice, and the dark pages differ only at their start', async () => {
    const again = await designPages();
    const darkPages = await designPages({ dark: true });
    for (const [index, { fileName, html }] of pages.entries()) {
      expect(again[index]?.html, fileName).toBe(html);
      const dark = darkPages[index]?.html ?? '';
      expect(dark).toContain('<html lang="en" class="tpl-dark">');
      expect(dark).not.toContain('id="tpl-dark"');
      const tail = (text: string): string => text.slice(text.indexOf('<header class="tpl-intro">'));
      expect(tail(dark)).toBe(tail(html));
    }
  }, 120_000);

  it('draw the example at the level Auto gives for the zoom of the fitted view', () => {
    const html = page('screens.html');
    const at = html.indexOf('id="tpl-screen-map"');
    const section = html.slice(at, html.indexOf('id="tpl-screen-everything"'));
    const zoom = /scale\(([0-9.]+)\)/.exec(section)?.[1];
    expect(zoom).toBeDefined();
    const level = lodForZoom(Number(zoom));
    expect(section).toContain(`data-lod="${level}"`);
    expect(section).toContain(`data-zoom-lod="${level}"`);
    expect(html.slice(html.indexOf('id="tpl-screen-everything"'))).toContain('data-lod="detail"');
  });

  it('keep the kit within its size', () => {
    expect(page('kit.html').length).toBeLessThan(1_400_000);
  });
});
