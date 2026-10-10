#!/usr/bin/env node
// Writes the design pages — kit.html and screens.html, the viewer's interface as static markup
// around its real stylesheet — or reads a restyled page back and says what changed in the
// stylesheet.
//
//   node scripts/make-design-template.mjs [--dark] [--out <dir>]                  npm run design
//   node scripts/make-design-template.mjs --extract <page> [--write] [--all-styles]   npm run design:extract
//
// The generator is TypeScript and React: Vite loads it as source, without the app's config.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => args.includes(name);
/** @param {string} name */
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'warn',
  appType: 'custom',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const extract = value('--extract');
  if (extract !== undefined) {
    const { appStylesheetOf, unscoped, stylesheetChanges, changesText } =
      await server.ssrLoadModule('/src/design/stylesheet.ts');
    const current = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8');
    const found = appStylesheetOf(await readFile(extract, 'utf8'), {
      allStyles: flag('--all-styles'),
    });
    if (found === undefined) throw new Error(`${extract} carries no app stylesheet`);
    const returned = unscoped(found);
    const changes = stylesheetChanges(current, returned);
    console.log(changesText(changes));
    if (flag('--write')) {
      await writeFile(path.join(root, 'src/ui/styles.css'), returned);
      console.log('written to src/ui/styles.css');
    }
  } else {
    const out = path.resolve(root, value('--out') ?? 'design-template');
    await mkdir(out, { recursive: true });
    const { designPages } = await server.ssrLoadModule('/src/design/pages.ts');
    const { staticProblems } = await server.ssrLoadModule('/src/design/markup.ts');
    let problems = 0;
    for (const page of await designPages({ dark: flag('--dark') })) {
      const file = path.join(out, page.fileName);
      await writeFile(file, page.html);
      const found = staticProblems(page.html);
      problems += found.length;
      console.log(
        `${file}  ${page.html.length} bytes${found.length ? `  PROBLEMS: ${found.join('; ')}` : ''}`,
      );
    }
    if (problems > 0) process.exitCode = 1;
  }
} finally {
  await server.close();
}
