import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { singleOfflineFile } from './scripts/single-file.ts';
import { NOTICES_FILE, thirdPartyNotices } from './scripts/third-party-notices.ts';
import { TEMPLATE_FILES } from './src/core/template.ts';

/**
 * The version of the viewer: the one of package.json, the single place it is written down
 * (README.md, "Versioning"). The viewer shows it and the built page names it.
 */
const APP_VERSION = String(
  (
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      version: unknown;
    }
  ).version,
);

/** Names the program and its version in the page: `<meta name="generator" …>`. */
function versionTag(): Plugin {
  return {
    name: 'version-tag',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { name: 'generator', content: `architecture-map ${APP_VERSION}` },
        injectTo: 'head',
      },
    ],
  };
}

/** HTML entry; its name is also the name of the built file (dist/viewer.html). */
const ENTRY_HTML = 'viewer.html';
/** Structure file served in dev and copied next to the built viewer. */
const EXAMPLE_YAML = 'examples/architecture.yaml';
const YAML_ROUTE = '/architecture.yaml';
/** Work-items data (the mock "database") served in dev and copied next to the built viewer. */
const WORK_ITEMS_JSON = 'fixtures/workitems.json';
const WORK_ITEMS_ROUTE = '/workitems.json';

/** Redirects `/` to the viewer page, since there is no index.html. */
const redirectRootToViewer: Connect.NextHandleFunction = (req, res, next) => {
  const url = req.url ?? '';
  if (url === '/' || url.startsWith('/?')) {
    res.statusCode = 302;
    res.setHeader('Location', `/${ENTRY_HTML}${url.slice(1)}`);
    res.end();
    return;
  }
  next();
};

/** The content files delivered next to the viewer: where they are served and what they are. */
const DATA_FILES = [
  { route: YAML_ROUTE, file: EXAMPLE_YAML, contentType: 'text/yaml; charset=utf-8' },
  {
    route: WORK_ITEMS_ROUTE,
    file: WORK_ITEMS_JSON,
    contentType: 'application/json; charset=utf-8',
  },
] as const;

/**
 * What makes dist/ a folder that can be handed on without the repo: the guide to the viewer and
 * to writing its data files, and the template files to start a map from (dist/template/, each
 * from the same path under examples/).
 */
const HANDOVER_FILES = [
  { fileName: 'README.md', file: 'docs/viewer-README.md' },
  ...TEMPLATE_FILES.map((fileName) => ({ fileName, file: `examples/${fileName}` })),
];

/**
 * Makes the raw content files (architecture YAML, work-items JSON) available next to the viewer:
 * - dev: served at /architecture.yaml and /workitems.json (read fresh on each request; edits
 *   trigger a reload);
 * - build: emitted as dist/architecture.yaml and dist/workitems.json, with the handover files
 *   (dist/README.md, dist/template/architecture.yaml and dist/template/workitems.json).
 * The viewer reads these data files themselves — fetched from a server, opened from disk — and
 * loads no script next to it.
 */
function contentFiles(): Plugin {
  let root = path.resolve('.');
  const resolved = (file: string): string => path.resolve(root, file);
  return {
    name: 'content-files',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      const watched = DATA_FILES.map((data) => resolved(data.file));
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        if (watched.includes(path.resolve(file))) server.ws.send({ type: 'full-reload' });
      });
      server.middlewares.use(redirectRootToViewer);
      for (const data of DATA_FILES) {
        server.middlewares.use(data.route, (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            next();
            return;
          }
          readFile(resolved(data.file))
            .then((body) => {
              res.setHeader('Content-Type', data.contentType);
              res.setHeader('Cache-Control', 'no-store');
              res.end(req.method === 'HEAD' ? undefined : body);
            })
            .catch(next);
        });
      }
    },
    configurePreviewServer(server) {
      server.middlewares.use(redirectRootToViewer);
    },
    async generateBundle() {
      for (const data of DATA_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: path.basename(data.route),
          source: await readFile(resolved(data.file), 'utf8'),
        });
      }
      for (const { fileName, file } of HANDOVER_FILES) {
        this.emitFile({ type: 'asset', fileName, source: await readFile(resolved(file), 'utf8') });
      }
    },
  };
}

export default defineConfig({
  base: './',
  // The last two make dist/viewer.html a single file that stays offline, with the notices of the
  // software in it (dist/THIRD-PARTY-NOTICES.txt, repeated at the end of the page).
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    versionTag(),
    contentFiles(),
    thirdPartyNotices(),
    singleOfflineFile({ noticesFile: NOTICES_FILE }),
  ],
  server: { open: `/${ENTRY_HTML}` },
  preview: { open: `/${ENTRY_HTML}` },
  build: {
    rolldownOptions: { input: ENTRY_HTML },
  },
});
