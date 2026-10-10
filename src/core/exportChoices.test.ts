import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_CHOICES,
  EXPORT_AREAS,
  EXPORT_BASE_FALLBACK,
  EXPORT_CHOICES_KEY,
  EXPORT_FORMATS,
  EXPORT_MIME,
  EXPORT_SCHEMES,
  EXPORT_TEXTS,
  exportBlocked,
  exportFileName,
  exportGenerator,
  exportStamp,
  outcomeText,
  parseExportChoices,
  PICTURE_LEVEL_NAMES,
  pictureDescription,
  pictureNote,
  pictureScheme,
  pictureTitle,
  PNG_LIMITS,
  PNG_SCALES,
  pngSize,
  readExportChoices,
  savedText,
  serializeExportChoices,
  structureFileName,
  viewExtent,
  writeExportChoices,
  type ExportChoices,
  type PictureFacts,
} from './exportChoices';
import { seeded } from './pictureTestHelpers';
import { LOD_LEVELS } from './visibility';

describe('the stored choices', () => {
  it('nothing stored, or text that is no object, gives the defaults', () => {
    for (const text of [null, undefined, '', 'x', '[]', '"a"', '3', 'null', '{']) {
      expect(parseExportChoices(text), String(text)).toEqual(DEFAULT_EXPORT_CHOICES);
    }
    expect(parseExportChoices('{}')).toEqual(DEFAULT_EXPORT_CHOICES);
    expect(DEFAULT_EXPORT_CHOICES).toEqual({
      area: 'map',
      scheme: 'screen',
      caption: true,
      scale: 2,
    });
    expect(EXPORT_CHOICES_KEY).toBe('architecture-map.export');
    expect(EXPORT_AREAS).toEqual(['map', 'view']);
    expect(EXPORT_SCHEMES).toEqual(['screen', 'light', 'dark']);
    expect(PNG_SCALES).toEqual([1, 2, 3]);
    expect(EXPORT_FORMATS).toEqual(['png', 'svg', 'html']);
  });

  it('each choice is read by itself: an invalid one is its default, the others are kept', () => {
    const stored = { area: 'view', scheme: 'dark', caption: false, scale: 3 };
    expect(parseExportChoices(JSON.stringify(stored))).toEqual(stored);
    const invalid = {
      area: ['screen', 1, null, ['view']],
      scheme: ['system', true, '', 'Light'],
      caption: ['false', 0, null],
      scale: [4, '1', '2', 2.5, 0, null, [1]],
    };
    for (const key of ['area', 'scheme', 'caption', 'scale'] as const) {
      for (const value of invalid[key]) {
        const parsed = parseExportChoices(JSON.stringify({ ...stored, [key]: value }));
        expect(parsed, `${key}=${JSON.stringify(value)}`).toEqual({
          ...stored,
          [key]: DEFAULT_EXPORT_CHOICES[key],
        });
      }
      const without: Record<string, unknown> = { ...stored };
      delete without[key];
      expect(parseExportChoices(JSON.stringify(without))).toEqual({
        ...stored,
        [key]: DEFAULT_EXPORT_CHOICES[key],
      });
    }
    // Entries it does not know are ignored, and are not written again.
    const more = parseExportChoices(
      '{"area":"view","scheme":"dark","caption":false,"scale":3,"format":"pdf","__proto__":1}',
    );
    expect(more).toEqual(stored);
    expect(serializeExportChoices(more)).toBe(
      '{"area":"view","scheme":"dark","caption":false,"scale":3}',
    );
    // The four choices are what is written, in one order, whatever else an object carries.
    const wide = { format: 'pdf', scale: 1, caption: true, scheme: 'light', area: 'map' } as const;
    expect(serializeExportChoices(wide)).toBe(
      '{"area":"map","scheme":"light","caption":true,"scale":1}',
    );
    expect(serializeExportChoices(DEFAULT_EXPORT_CHOICES)).toBe(
      '{"area":"map","scheme":"screen","caption":true,"scale":2}',
    );
  });

  it('property: every combination survives a round trip, and no stored text throws', () => {
    let combinations = 0;
    for (const area of EXPORT_AREAS) {
      for (const scheme of EXPORT_SCHEMES) {
        for (const caption of [true, false]) {
          for (const scale of PNG_SCALES) {
            const choices = { area, scheme, caption, scale };
            expect(parseExportChoices(serializeExportChoices(choices))).toEqual(choices);
            combinations += 1;
          }
        }
      }
    }
    expect(combinations).toBe(36);
    const random = seeded(4);
    const values = [
      'map',
      'view',
      'screen',
      'light',
      'dark',
      true,
      false,
      1,
      2,
      3,
      9,
      null,
      {},
      [],
      'x',
      -1,
      1e99,
    ];
    const pick = () => values[Math.floor(random() * values.length)];
    for (let run = 0; run < 500; run++) {
      const text = JSON.stringify({
        area: pick(),
        scheme: pick(),
        caption: pick(),
        scale: pick(),
        more: pick(),
      });
      const parsed = parseExportChoices(
        random() < 0.1 ? text.slice(0, Math.floor(random() * text.length)) : text,
      );
      expect(EXPORT_AREAS).toContain(parsed.area);
      expect(EXPORT_SCHEMES).toContain(parsed.scheme);
      expect(typeof parsed.caption).toBe('boolean');
      expect(PNG_SCALES).toContain(parsed.scale);
    }
  });
});

describe('storage', () => {
  it('reads what was written, and works without storage or with one that throws', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    };
    expect(readExportChoices(storage)).toEqual(DEFAULT_EXPORT_CHOICES);
    const choices: ExportChoices = { area: 'view', scheme: 'light', caption: false, scale: 1 };
    writeExportChoices(storage, choices);
    expect([...map]).toEqual([
      ['architecture-map.export', '{"area":"view","scheme":"light","caption":false,"scale":1}'],
    ]);
    expect(readExportChoices(storage)).toEqual(choices);
    // Only its own entry is read.
    map.set('architecture-map.settings', serializeExportChoices(DEFAULT_EXPORT_CHOICES));
    expect(readExportChoices(storage)).toEqual(choices);
    expect(readExportChoices(undefined)).toEqual(DEFAULT_EXPORT_CHOICES);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(readExportChoices(broken)).toEqual(DEFAULT_EXPORT_CHOICES);
    expect(() => writeExportChoices(broken, choices)).not.toThrow();
    expect(() => writeExportChoices(undefined, choices)).not.toThrow();
  });

  it('the scheme of a file is the chosen one, or the one on screen', () => {
    expect(pictureScheme('screen', true)).toBe('dark');
    expect(pictureScheme('screen', false)).toBe('light');
    expect(pictureScheme('light', true)).toBe('light');
    expect(pictureScheme('dark', false)).toBe('dark');
  });
});

describe('pngSize', () => {
  it('is the picture times the scale while that fits', () => {
    expect(pngSize(3364, 1983, 2)).toEqual({ width: 6728, height: 3966, scale: 2, reduced: false });
    expect(pngSize(3364, 1983, 3)).toEqual({
      width: 10092,
      height: 5949,
      scale: 3,
      reduced: false,
    });
    expect(pngSize(100.4, 50.6, 1)).toEqual({ width: 100, height: 50, scale: 1, reduced: false });
    expect(PNG_LIMITS).toEqual({ side: 16384, area: 64_000_000 });
  });

  it('is reduced by the longer side and by the area', () => {
    const wide = pngSize(68757, 6940, 2);
    expect(wide.reduced).toBe(true);
    expect(wide.width).toBe(16384);
    expect(wide.height).toBe(1653);
    expect(wide.scale).toBeCloseTo(0.2383, 4);
    const tall = pngSize(6940, 68757, 2);
    expect([tall.width, tall.height, tall.reduced]).toEqual([1653, 16384, true]);
    const area = pngSize(6000, 6000, 3);
    expect(area.reduced).toBe(true);
    expect(area.width).toBe(8000);
    expect(area.height).toBe(8000);
    expect(pngSize(10, 10, 2, { side: 15, area: 1e9 })).toEqual({
      width: 15,
      height: 15,
      scale: 1.5,
      reduced: true,
    });
    // A side that the division leaves a hair below its limit is at the limit.
    expect(pngSize(16661, 100, 1).width).toBe(16384);
    expect(pngSize(1013, 1013, 10)).toMatchObject({ width: 8000, height: 8000 });
    // A picture far thinner than a pixel at its reduced size still has one.
    expect(pngSize(100000, 1, 1)).toMatchObject({ width: 16384, height: 1, reduced: true });
  });

  it('what is no size gives one pixel', () => {
    const none = [
      [0, 10, 1],
      [10, -1, 1],
      [NaN, 1, 1],
      [1, 1, 0],
      [Infinity, 1, 1],
      [1, 1, NaN],
      [1, NaN, 1],
      [1, 1, -2],
    ] as const;
    for (const [width, height, scale] of none) {
      expect(pngSize(width, height, scale)).toEqual({
        width: 1,
        height: 1,
        scale: 1,
        reduced: false,
      });
    }
  });

  it('property: within the limits, never above the scale asked for, in the proportions of the picture', () => {
    const random = seeded(9);
    const failures: string[] = [];
    let reduced = 0;
    for (let run = 0; run < 3000; run++) {
      const width = 1 + random() * (random() < 0.3 ? 200000 : 6000);
      const height = 1 + random() * (random() < 0.3 ? 200000 : 6000);
      const scale = PNG_SCALES[Math.floor(random() * 3)] ?? 1;
      const size = pngSize(width, height, scale);
      const holds =
        Number.isInteger(size.width) &&
        Number.isInteger(size.height) &&
        size.width >= 1 &&
        size.height >= 1 &&
        size.width <= PNG_LIMITS.side &&
        size.height <= PNG_LIMITS.side &&
        size.width * size.height <= PNG_LIMITS.area &&
        size.scale <= scale &&
        size.reduced === size.scale < scale &&
        // Less than a pixel is lost on each side.
        width * size.scale - size.width < 1 + 1e-6 &&
        height * size.scale - size.height < 1 + 1e-6 &&
        // Not reduced further than needed: one of the limits is reached.
        (!size.reduced ||
          width * size.scale > PNG_LIMITS.side - 1 ||
          height * size.scale > PNG_LIMITS.side - 1 ||
          width * height * size.scale * size.scale > PNG_LIMITS.area * 0.999);
      if (!holds) failures.push(`${width} × ${height} at ${scale}: ${JSON.stringify(size)}`);
      if (size.reduced) reduced += 1;
    }
    expect(failures).toEqual([]);
    expect(reduced).toBeGreaterThan(500);
    expect(reduced).toBeLessThan(2500);
  });
});

describe('viewExtent', () => {
  it('is what the canvas shows, less what the control panel lies over', () => {
    const screen = { width: 800, height: 600 };
    expect(viewExtent({ x: 0, y: 0, zoom: 1 }, screen)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    expect(viewExtent({ x: -200, y: 100, zoom: 0.5 }, screen)).toEqual({
      x: 400,
      y: -200,
      width: 1600,
      height: 1200,
    });
    expect(viewExtent({ x: -200, y: 100, zoom: 0.5 }, screen, 300)).toEqual({
      x: 1000,
      y: -200,
      width: 1000,
      height: 1200,
    });
    // A panel cannot cover less than nothing.
    expect(viewExtent({ x: 0, y: 0, zoom: 2 }, screen, -50)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });

  it('is nothing when nothing is on screen', () => {
    const screen = { width: 800, height: 600 };
    expect(viewExtent({ x: 0, y: 0, zoom: 1 }, { width: 0, height: 600 })).toBeUndefined();
    expect(viewExtent({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 0 })).toBeUndefined();
    expect(viewExtent({ x: 0, y: 0, zoom: 1 }, screen, 800)).toBeUndefined();
    expect(viewExtent({ x: 0, y: 0, zoom: 1 }, screen, 5000)).toBeUndefined();
    expect(viewExtent({ x: 0, y: 0, zoom: 0 }, screen)).toBeUndefined();
    expect(viewExtent({ x: 0, y: 0, zoom: -1 }, screen)).toBeUndefined();
    expect(viewExtent({ x: NaN, y: 0, zoom: 1 }, screen)).toBeUndefined();
    expect(viewExtent({ x: 0, y: Infinity, zoom: 1 }, screen)).toBeUndefined();
    expect(viewExtent({ x: 0, y: 0, zoom: 1 }, screen, NaN)).toBeUndefined();
  });
});

describe('exportFileName', () => {
  it('is the name of the structure file without folders and extension, then -map and the format', () => {
    expect(exportFileName('architecture.yaml', 'png')).toBe('architecture-map.png');
    expect(exportFileName('data/shop.v2.yml', 'svg')).toBe('shop.v2-map.svg');
    expect(exportFileName('C:\\maps\\Shop Floor.yaml', 'html')).toBe('Shop Floor-map.html');
    expect(exportFileName('maps/shop.yaml?v=3#x', 'png')).toBe('shop-map.png');
    expect(exportFileName('data/shop.yaml?v=3', 'html')).toBe('shop-map.html');
    expect(exportFileName('.hidden', 'png')).toBe('hidden-map.png');
    expect(exportFileName('a:b*c?.yaml', 'png')).toBe('a-b-c--map.png');
    // In the name of a file opened from disk `#` and `?` are characters, not the end of it.
    expect(exportFileName('c#-services.yaml', 'svg')).toBe('c#-services-map.svg');
    expect(exportFileName('team #2 (draft).yaml', 'png')).toBe('team #2 (draft)-map.png');
    expect(exportFileName('what?.yaml', 'html')).toBe('what--map.html');
    // An address ends at its query, wherever a folder is named in it.
    expect(exportFileName('shop.yaml?from=a/b.yaml', 'png')).toBe('shop-map.png');
    expect(exportFileName('a<b>c"d|e.yaml', 'png')).toBe('a-b-c-d-e-map.png');
    expect(exportFileName('x'.repeat(200) + '.yaml', 'png')).toBe(`${'x'.repeat(80)}-map.png`);
    // Cut between characters, and what the cut leaves at the end goes too.
    expect(exportFileName('😀'.repeat(100) + '.yaml', 'png')).toBe(`${'😀'.repeat(80)}-map.png`);
    expect(exportFileName(`${'x'.repeat(79)}. y.yaml`, 'png')).toBe(`${'x'.repeat(79)}-map.png`);
    expect(exportFileName(' plan .yaml', 'svg')).toBe('plan-map.svg');
  });

  it('falls back to architecture', () => {
    const unusable = [
      undefined,
      '',
      '   ',
      '...',
      'folder/',
      'CON.yaml',
      'nul',
      'data/?x=1',
      'maps\\#top',
      'LPT1.yml',
    ];
    for (const name of unusable) {
      expect(exportFileName(name, 'svg'), String(name)).toBe('architecture-map.svg');
    }
    expect(EXPORT_BASE_FALLBACK).toBe('architecture');
    expect(exportFileName('console.yaml', 'svg')).toBe('console-map.svg');
    expect(structureFileName('a/b/c.yaml')).toBe('c.yaml');
    expect(structureFileName('a\\b\\c.yaml#top')).toBe('c.yaml');
    expect(structureFileName('data/shop.yaml?v=3')).toBe('shop.yaml');
    expect(structureFileName('maps/shop.yaml#x?y')).toBe('shop.yaml');
    expect(structureFileName('c#-services.yaml')).toBe('c#-services.yaml');
    expect(structureFileName(' what? #1.yaml ')).toBe('what? #1.yaml');
    expect(structureFileName('  ')).toBeUndefined();
    expect(structureFileName(undefined)).toBeUndefined();
  });

  it('property: a name every file system takes', () => {
    const random = seeded(2);
    const pool = [
      'a',
      'B',
      '1',
      '.',
      ' ',
      '/',
      '\\',
      ':',
      '*',
      '?',
      '"',
      '<',
      '>',
      '|',
      '\u0000',
      '\u001f',
      'é',
      '漢',
      '😀',
      '-',
      '_',
      '#',
    ];
    const failures: string[] = [];
    for (let run = 0; run < 2000; run++) {
      let name = '';
      const length = Math.floor(random() * 30);
      for (let i = 0; i < length; i++) name += pool[Math.floor(random() * pool.length)];
      for (const format of EXPORT_FORMATS) {
        const out = exportFileName(name, format);
        const base = out.slice(0, -`-map.${format}`.length);
        const holds =
          out.endsWith(`-map.${format}`) &&
          // eslint-disable-next-line no-control-regex
          !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(out) &&
          base.length > 0 &&
          [...base].length <= 80 &&
          !/^[.\s]|[.\s]$/.test(base);
        if (!holds) failures.push(`${JSON.stringify(name)} → ${JSON.stringify(out)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('each file has its type', () => {
    expect(EXPORT_MIME).toEqual({
      png: 'image/png',
      svg: 'image/svg+xml;charset=utf-8',
      html: 'text/html;charset=utf-8',
    });
  });
});

describe('exportStamp', () => {
  it('is the date and the time on the clock of the place', () => {
    const noon = Date.UTC(2026, 9, 10, 12, 5, 59);
    expect(exportStamp(noon, 0)).toBe('2026-10-10 12:05');
    expect(exportStamp(noon, 120)).toBe('2026-10-10 14:05');
    expect(exportStamp(noon, -13 * 60)).toBe('2026-10-09 23:05');
    expect(exportStamp(Date.UTC(2026, 11, 31, 23, 30), 60)).toBe('2027-01-01 00:30');
    expect(exportStamp(Date.UTC(2026, 0, 5, 3, 7), 0)).toBe('2026-01-05 03:07');
    expect(exportStamp(NaN, 0)).toBe('');
    expect(exportStamp(noon, NaN)).toBe('');
    expect(exportStamp(Infinity, 0)).toBe('');
  });
});

describe('what a picture says about itself', () => {
  const plain: PictureFacts = { level: 'components', area: 'map', exportedAt: '2026-10-10 09:30' };

  it('the title is the structure file, and the focus while one is set', () => {
    expect(pictureTitle({ structureName: 'data/architecture.yaml' })).toBe('architecture.yaml');
    expect(pictureTitle({ structureName: 'a.yaml', focusName: ' Campaign run ' })).toBe(
      'a.yaml — Campaign run',
    );
    expect(pictureTitle({})).toBe('Architecture map');
    expect(pictureTitle({ focusName: 'Campaign run' })).toBe('Architecture map — Campaign run');
    expect(pictureTitle({ structureName: 'a.yaml', focusName: '  ' })).toBe('a.yaml');
    // A file opened from disk keeps its whole name; a fetched one loses its query.
    expect(pictureTitle({ structureName: 'c#-services.yaml' })).toBe('c#-services.yaml');
    expect(pictureTitle({ structureName: 'team #2 (draft).yaml' })).toBe('team #2 (draft).yaml');
    expect(pictureTitle({ structureName: 'data/shop.yaml?v=3' })).toBe('shop.yaml');
  });

  it('the note has the level and the time, and every part that says something', () => {
    expect(pictureNote(plain)).toBe('Level: Components · Exported 2026-10-10 09:30');
    expect(LOD_LEVELS.map((level) => pictureNote({ ...plain, level, exportedAt: '' }))).toEqual([
      'Level: Domains',
      'Level: Components',
      'Level: Subcomponents',
      'Level: Everything',
    ]);
    expect(Object.keys(PICTURE_LEVEL_NAMES)).toEqual([...LOD_LEVELS]);
    expect(
      pictureNote({
        ...plain,
        structureName: 'a.yaml',
        workItemsName: 'data/workitems.json',
        focusName: 'Campaign run',
        filtered: true,
        colorBy: 'Owner',
        heat: true,
        progress: true,
        storyMode: 'tasks',
        iteration: 'PI 3',
        hiddenKinds: ['config', 'control'],
        edgesOnDemand: true,
        selection: true,
        area: 'view',
      }),
    ).toBe(
      'Level: Components · Filtered to the focus · Colour by Owner · Heat by work · Progress · Work items: Stories + Tasks · Iteration PI 3 · Work items from workitems.json · Without config, control edges · Edges on demand: only the edges shown · With the selection · Part of the map · Exported 2026-10-10 09:30',
    );
  });

  it('each part of the note is said by itself', () => {
    const said = (facts: Partial<PictureFacts>) =>
      pictureNote({ ...plain, exportedAt: '', ...facts }).split(' · ');
    expect(said({ focusName: 'X' })).toEqual(['Level: Components', 'Focus: the rest is paled']);
    expect(said({ focusName: 'X', filtered: true })).toEqual([
      'Level: Components',
      'Filtered to the focus',
    ]);
    expect(said({ colorBy: ' Owner (teams) ' })).toEqual([
      'Level: Components',
      'Colour by Owner (teams)',
    ]);
    expect(said({ heat: true })).toEqual(['Level: Components', 'Heat by work']);
    expect(said({ progress: true })).toEqual(['Level: Components', 'Progress']);
    expect(said({ storyMode: 'stories' })).toEqual([
      'Level: Components',
      'Work items: Stories only',
    ]);
    expect(said({ iteration: ' PI 3 ' })).toEqual(['Level: Components', 'Iteration PI 3']);
    expect(said({ workItemsName: 'C:\\data\\items.json' })).toEqual([
      'Level: Components',
      'Work items from items.json',
    ]);
    expect(said({ hiddenKinds: ['config'] })).toEqual([
      'Level: Components',
      'Without config edges',
    ]);
    expect(said({ edgesOnDemand: true })).toEqual([
      'Level: Components',
      'Edges on demand: only the edges shown',
    ]);
    expect(said({ selection: true })).toEqual(['Level: Components', 'With the selection']);
    expect(said({ area: 'view' })).toEqual(['Level: Components', 'Part of the map']);
    // What says nothing is left out.
    expect(
      said({
        focusName: ' ',
        filtered: true,
        colorBy: ' ',
        heat: false,
        progress: false,
        storyMode: 'off',
        iteration: '',
        workItemsName: 'data/',
        hiddenKinds: [],
        edgesOnDemand: false,
        selection: false,
      }),
    ).toEqual(['Level: Components']);
  });

  it('the description counts what is in the picture and names the viewer', () => {
    expect(
      pictureDescription({ ...plain, structureName: 'a.yaml' }, { nodes: 21, edges: 1 }, '0.3.0'),
    ).toBe(
      'Architecture map of a.yaml: 21 boxes and 1 edge. Level: Components · Exported 2026-10-10 09:30. Made with Architecture Map 0.3.0.',
    );
    expect(pictureDescription(plain, { nodes: 1, edges: 0 }, 'dev')).toBe(
      'Architecture map of Architecture map: 1 box and 0 edges. Level: Components · Exported 2026-10-10 09:30. Made with Architecture Map dev.',
    );
    expect(
      pictureDescription(
        { ...plain, structureName: 'a.yaml', focusName: 'Campaign run', area: 'view' },
        { nodes: 0, edges: 2 },
        '1.0.0',
      ),
    ).toBe(
      'Architecture map of a.yaml — Campaign run: 0 boxes and 2 edges. Level: Components · Focus: the rest is paled · Part of the map · Exported 2026-10-10 09:30. Made with Architecture Map 1.0.0.',
    );
    expect(exportGenerator('0.3.0')).toBe('Architecture Map 0.3.0');
  });
});

describe('when the buttons wait', () => {
  it('an export that is running, or a layout on its way, blocks them and says why', () => {
    expect(exportBlocked({ pending: false, busy: false })).toBeUndefined();
    expect(exportBlocked({ pending: true, busy: false })).toBe(EXPORT_TEXTS.pending);
    expect(exportBlocked({ pending: false, busy: true })).toBe(EXPORT_TEXTS.working);
    expect(exportBlocked({ pending: true, busy: true })).toBe(EXPORT_TEXTS.working);
    expect(EXPORT_TEXTS.pending).toBe('The map is still being laid out');
    expect(EXPORT_TEXTS.working).toBe('Making the picture…');
  });

  it('the status of an outcome is the sentence of its file', () => {
    const base = { name: 'a-map.svg', bytes: 10, width: 100, height: 50, nodes: 1, edges: 0 };
    expect(outcomeText({ ...base, format: 'svg' })).toBe('Saved a-map.svg.');
    expect(outcomeText({ ...base, format: 'html', name: 'a-map.html' })).toBe('Saved a-map.html.');
    expect(
      outcomeText({
        ...base,
        format: 'png',
        name: 'a-map.png',
        png: { width: 200, height: 100, scale: 2, reduced: false },
      }),
    ).toBe('Saved a-map.png (200 × 100 px).');
  });

  it('the section says what its controls and its lines say', () => {
    expect(EXPORT_TEXTS).toEqual({
      heading: 'Export',
      area: 'Area',
      areaMap: 'Whole map',
      areaView: 'What is on screen',
      scheme: 'Colours',
      schemeScreen: 'As on screen',
      schemeLight: 'Light',
      schemeDark: 'Dark',
      caption: 'Title and legend',
      scale: 'PNG size',
      pngTitle: 'Save a picture of the map (PNG)',
      svgTitle: 'Save the map as a vector drawing: shapes and text, sharp at any size (SVG)',
      htmlTitle:
        'Save the map as a web page that needs nothing else and lists the boxes as text (HTML)',
      scaleTitle: 'Pixels of the PNG per pixel of the map',
      pending: 'The map is still being laid out',
      working: 'Making the picture…',
      note: 'The map as it is drawn now: level of detail, focus, colours, work items and what is selected. A PNG is a fixed picture; SVG stays sharp at any size; the HTML page opens in any browser.',
      selection:
        'The selection is part of the picture: click the empty canvas first for one without it.',
      onDemand: 'Edges on demand: only the edges shown now are in the picture.',
      tooLarge:
        'Could not make the PNG: the picture is too large for this browser. SVG has no such limit.',
      nothingInView: 'Nothing of the map is on screen.',
      nothingDrawn: 'Nothing is drawn.',
      failed: 'Could not export: ',
    });
  });
});

describe('savedText', () => {
  it('says the name, the size of a PNG, and that it was reduced', () => {
    expect(savedText('architecture-map.svg')).toBe('Saved architecture-map.svg.');
    expect(savedText('a-map.png', { width: 6728, height: 3966, scale: 2, reduced: false })).toBe(
      'Saved a-map.png (6728 × 3966 px).',
    );
    expect(savedText('a-map.png', pngSize(68757, 6940, 2))).toBe(
      'Saved a-map.png (16384 × 1653 px — reduced to 24 % to fit a picture; a smaller part of the map, or SVG, keeps every detail).',
    );
    // A share below one percent is not said as nothing.
    expect(savedText('a-map.png', { width: 10, height: 1, scale: 0.001, reduced: true })).toContain(
      'reduced to 1 % to',
    );
  });

  it('never says a reduced picture has the scale that was asked for', () => {
    // A hair over a limit: reduced by less than half a percent.
    const cases = [
      { width: 16385, height: 3000, scale: 1, says: 99 },
      { width: 16466, height: 3000, scale: 1, says: 99 },
      { width: 8193, height: 1000, scale: 2, says: 199 },
      { width: 5462, height: 1200, scale: 3, says: 299 },
    ];
    for (const { width, height, scale, says } of cases) {
      const size = pngSize(width, height, scale);
      expect(size.reduced, `${width} at ${scale}`).toBe(true);
      expect(Math.round(size.scale * 100), `${width} at ${scale}`).toBe(scale * 100);
      expect(savedText('a-map.png', size), `${width} at ${scale}`).toContain(
        `reduced to ${says} % to`,
      );
    }
    // Further down the percent is the nearest one, and a whole scale below the one asked for
    // is said as it is.
    expect(savedText('a-map.png', pngSize(16467, 3000, 1))).toContain('reduced to 99 % to');
    expect(savedText('a-map.png', pngSize(16384, 1000, 2))).toContain('reduced to 100 % to');
    expect(
      savedText('a-map.png', { width: 100, height: 100, scale: 1.004, reduced: true }),
    ).toContain('reduced to 100 % to');
  });
});
