# Architecture Map

A web-based, zoomable map of the project's architecture: domains → components → subcomponents
as collapsible groups, connected by typed edges (`dataflow`, `dependency`, `control`, `config`),
with Azure DevOps work items overlaid on the components they affect.

- **Structure** lives in a versioned YAML file (`architecture.yaml`, see `examples/`), reviewed
  via PR.
- **Work** (stories, tasks, bugs) lives only in ADO and is linked by `comp:<component-id>` tags.

See [CHANGELOG.md](CHANGELOG.md) for what each release contains.

## Structure file

`architecture.yaml` describes domains, components, subcomponents, edges and rows; the complete
reference of the format, with every optional key, is `docs/viewer-README.md` (shipped as
`dist/README.md`). `parseArchitecture` in `src/core` validates it and reports every problem with
its path and line. Node IDs are lowercase dot-separated segments, each child prefixed by its
parent's ID (`ingest.reader.parser`). Node, edge, row and flow IDs are separate namespaces.
Besides name, description and row, a node may carry `owner`, `status` and `tech` (free text,
inherited by everything inside), `links` (`{ label, url }`, http(s) only) and `metrics`
(name → number). A top-level `flows:` list names stories told through the edges (`id`, `name`,
`kind: workflow | dataflow`, `description`, `edges` in step order, `nodes`).

## Requirements

Node.js 20.19+ or 22.12+ (required by Vite 8). On Windows, the [build kit](#the-build-kit)
brings Node.js and the packages along.

## Development

```sh
npm install
npm run dev          # opens http://localhost:5173/viewer.html
```

In dev, the raw structure file `examples/architecture.yaml` is served at `/architecture.yaml`
(re-read on every request; editing it reloads the page): the viewer's loader fetches it, as it
does on any web server (see "Where the viewer gets its data"). The dummy work items,
`fixtures/workitems.json`, are served the same way at `/workitems.json`.

| Script              | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `npm run dev`       | Vite dev server                                                           |
| `npm run build`     | Type-check, build `dist/viewer.html` and its folder                       |
| `npm run preview`   | Serve `dist/` over HTTP                                                   |
| `npm test`          | Unit tests (Vitest), once; `npm run test:watch` to watch                  |
| `npm run typecheck` | `tsc` over the app and the Node-side config/scripts                       |
| `npm run lint`      | ESLint                                                                    |
| `npm run format`    | Prettier (write); `npm run format:check` to only check                    |
| `npm run smoke`     | Browser smoke test of the built viewer (see below)                        |
| `npm run installer` | The two downloads of a release, into `release/` ([below](#the-build-kit)) |

On Windows, `npm test` works from any spelling of the checkout path. If you call Vitest directly
(`npx vitest`), do it from the canonically cased path (`C:…`, not `c:…`), or every suite fails
with "Cannot read properties of undefined (reading 'config')".

`npm run smoke` (after `npm run build`) opens `dist/viewer.html` from `file://` in headless Edge
or Chrome and drives it with real mouse and keyboard input through the DevTools protocol:
selection and dimming (including a click on the line of every single edge and merged edge), the
detail panel and its links, search, the control panel (its tabs, hiding its body, the search
while it is hidden), aggregate → member edge, going to a long edge in a small window, the
edge-kind filter, the focus in both of its modes (Focus and Filter), the work items (loaded,
diagnosed, room reserved per story mode) and persistence across a reload. It uses Node
built-ins only (Node 22+), finds the browser in its usual install location (set `BROWSER` to
the executable to override), and closes the browser when done. The browser profile is one directory in the temp directory,
`arch-map-smoke-profile`, emptied before and after each run and removed when the system allows
it: security software may keep other programs out of a browser profile even after the browser
has exited, and then the directory stays and the next run uses it again (the run clears the
page's storage itself, so it still starts clean). Two runs at the same time each get their own. It expects the shipped example and the dummy work items next to the viewer, and gives them to
the page the way a user would: dropped on it, which also exercises the recent maps (remembered,
offered on the start page after a reload, read again with Reload, forgotten).
The run is offline as well: the browser is started with its own network use switched off and
without name resolution, and the last checks are that the page requested nothing outside its
folder, that nothing violated its Content Security Policy, and that the policy stops what it
must (see [Offline use and security](#offline-use-and-security)).

Layout: `src/core` (pure, unit-tested logic — no React), `src/ui` (React), `src/providers`
(data sources: the structure loader, the work-item source and its mock provider), `fixtures`
(the dummy work items), `examples`, `scripts`.

## Build and share

```sh
npm run build
```

produces:

| File                           | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `dist/viewer.html`             | The whole app in one file (JS and CSS inlined); works offline, `file://`     |
| `dist/architecture.yaml`       | The structure file (the example): opened from disk, fetched over HTTP        |
| `dist/workitems.json`          | The work-items file (the dummy data), likewise                               |
| `dist/README.md`               | Guide to the viewer and to writing both data files (`docs/viewer-README.md`) |
| `dist/THIRD-PARTY-NOTICES.txt` | The open-source software inside `viewer.html` and its licence texts          |

`dist/` is a folder that can be handed on **without the repo**: its `README.md` describes the
viewer, the full format of `architecture.yaml` and `workitems.json`, how to derive them from a
repository and from Azure DevOps, and how to check the result — enough for a person or an agent
to make a map for another project. Nothing is generated from the data files: they are edited
and opened as they are. When the formats or the viewer's behaviour change, update
`docs/viewer-README.md` with them.

The viewer reads data files only (YAML and JSON) and loads no script next to it. To share:

- **As files:** hand on the folder. Opened by double-click, the viewer has to be given the files
  — **Open YAML…** or a drop — because browsers let a page opened from `file://` read only what
  the user opens. In Edge and Chrome it then remembers the map: one click on the start page
  opens it again, read fresh from the disk.
- **Over HTTP:** serve the `dist/` folder with any static server (or `npm run preview`). The
  map opens by itself, in every browser.

Without `workitems.json` the map simply shows no work items.

## Offline use and security

The viewer runs on a computer or a network without internet access. What a user of the built
folder needs to know is in
[`docs/viewer-README.md`](docs/viewer-README.md#offline-use-and-security) (shipped as
`dist/README.md`); this section is how the repository keeps it true.

**The built viewer**

- **One file, nothing fetched.** `scripts/single-file.ts` (a Vite plugin of this repo) puts the
  bundled script and stylesheet into `dist/viewer.html` and fails the build if the page refers
  to another server. No CDN, fonts, analytics, telemetry or update check exist in the code.
- **Content Security Policy.** The same plugin adds a `<meta http-equiv="Content-Security-Policy">`:
  `default-src 'none'`, scripts only by the SHA-256 hash of this build's code — no script
  file at all, not even one next to the page — inline styles, `data:` images,
  `connect-src 'self'`, no `<base>`, no forms. So no `eval`, no injected script, and no
  request to another server — the browser refuses them. The build fails if the page still
  loads a script file. `zod` is configured not to generate code (`src/core/zod.ts`), which the
  policy would forbid. The policy applies to the build only: `npm run dev` needs Vite's inline
  scripts and its WebSocket.
- **Data only from its own place.** `?data=` / `?workitems=` are resolved and compared with
  the page's origin before anything is fetched (`dataFileAddress` in
  `src/providers/structureSource.ts`); requests carry no referrer.
- **Proof in the smoke test.** `npm run smoke` records every request of the page and every
  policy violation during the whole run and fails on any of either; then it tries `eval`, an
  injected script and requests to another server and expects all of them to be blocked.
- **Licences.** `scripts/third-party-notices.ts` writes `dist/THIRD-PARTY-NOTICES.txt` from the
  packages that are really in the bundle and appends the same text to `viewer.html` as a
  comment (minifying drops the libraries' own licence comments). The build fails for a licence
  that is not on its accepted list — MIT, ISC, BSD, 0BSD, Apache-2.0 — or a package reviewed by
  name: `elkjs`, used unmodified under EPL-2.0. Adding a dependency under another licence means
  editing that list on purpose.

**Building it**

- **Packages** come from the npm registry — or from the mirror your `npm` is configured for:
  npm replaces the host recorded in `package-lock.json` with the configured registry — and are
  checked against the integrity hashes of the lock file. Use `npm ci`. `.npmrc` sets
  `ignore-scripts=true`, so nothing a package brings along runs at install time (the project
  needs no install script).
- **After the install nothing needs the network:** `dev`, `build`, `test`, `lint`, `smoke` run
  offline. The dev server listens on `localhost` only. None of the tools sends telemetry.
- **Known vulnerabilities:** `npm audit` reports none (2026-10-05).
- **Using the result needs no Node.js at all** — a browser and the files of `dist/`. The data
  files are plain YAML and JSON, edited in any editor.
- **Files remembered by the browser.** The recent maps are references to files the user opened
  (File System Access API, kept in IndexedDB) — no content, no path. Reading one again needs
  the user's permission, which the browser asks for. A browser policy that switches that API off
  (`DefaultFileSystemReadGuardSetting`) only removes the recent maps: the viewer falls back to
  the plain file dialog.

## Versioning

The project follows Semantic Versioning 2.0.0 (semver.org). The version is written in one
place, the `version` of `package.json`, and everything else takes it from there: the viewer
shows it beside its name at the top of the control panel, the built page names it
(`<meta name="generator" content="architecture-map 0.1.0">`), a release is the git tag
`v<version>` on `main`, and the downloads of a release carry it in their file names.

What the numbers mean here — the "public interface" is what someone who only has the built
folder relies on:

| Part  | Raised when                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MAJOR | A valid `architecture.yaml` or `workitems.json` stops being valid or changes its meaning; a documented way of opening the viewer or an address parameter goes away |
| MINOR | Something is added that leaves existing files and habits working: a feature, a new optional key, a new setting                                                     |
| PATCH | A fix that changes no format and adds no feature                                                                                                                   |

While the version is `0.y.z` the interface is not promised to be stable: a MINOR release may
contain a breaking change, which the changelog marks **Changed behaviour**. `1.0.0` is for the
moment the file formats and the ways of opening the viewer are meant to stay.

The `version: 1` inside the data files is another thing: the version of the file format, which
only a MAJOR release may break.

## The build kit

`npm run installer` makes the two downloads of a release, each with a `.sha256` file:

- `release/architecture-map-<version>-viewer.zip` (under 1 MB): the built folder — the viewer,
  the example data files, the guide and the notices. All that is needed to **use** the map.
- `release/architecture-map-<version>-build-kit-win-x64.zip` (about 66 MB): everything a
  Windows computer needs to **build** the viewer, with no internet access, no administrator
  rights and nothing installed system-wide. The rest of this section is about it.

| In the kit                             | What it is                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `install.cmd`, `installer/install.mjs` | The installer: plain text, to be read before it is run                      |
| `payload/node-v…-win-x64.zip`          | Node.js, the archive published by nodejs.org, unchanged                     |
| `payload/app-source.zip`               | The source as committed (`git archive`)                                     |
| `payload/node_modules.tar.gz`          | The npm packages, as `npm ci` installed them from the lock file             |
| `manifest.json`, `README.txt`          | Size and SHA-256 of every packed file; what a user of the kit needs to know |

**How it is made** (`scripts/make-installer.mjs`). Always from a commit, never from the working
tree — it refuses to run with uncommitted changes. It takes the Node.js archive (downloaded
once into `release/cache/`, accepted only with the SHA-256 pinned in the script), unpacks the
committed source into a staging folder and, _with that same Node.js_, runs `npm ci` (every
package checked against the lock file), the unit tests and the build. Then it packs.
`--verify` unpacks the finished zip and installs it into a scratch folder the way a user would;
the installer builds the viewer there and compares it with the released one — it is the same
file, byte for byte. A kit made from a commit that is not tagged `v<version>` is named
`<version>+<commit>` instead, so it cannot be mistaken for the release.

**What installing does** (`scripts/installer/`). `install.cmd` unpacks Node.js into the folder —
`%LOCALAPPDATA%\Programs\ArchitectureMap`, or the one given — and runs `install.mjs` with it:
every packed file is compared with the manifest, source and packages are unpacked with the
`tar.exe` of Windows, the viewer is built once. It writes `build.cmd`, `test.cmd`, `smoke.cmd`,
`dev.cmd` and `shell.cmd`, which put the kit's Node.js first on the PATH for that one command
and keep npm's cache and logs inside the folder. Nothing outside the folder is touched — no
registry, no PATH, no shortcut — so uninstalling is deleting the folder, and the folder can be
moved. A folder that is not empty, has `&`, `^` or `%` in its name (npm's own command files
break there) or a name over 110 characters is refused before anything is written.

**Limits.** Windows 10 1803 or newer, 64-bit Intel/AMD only: Node.js and two of the build tools
are programs for one system. The kit is a zip with a command file, not a signed `setup.exe`:
an unsigned program is often blocked or warned about, and a command file can be read.
Windows asks before running a command file that came from the internet or by e-mail. To bundle
another Node.js, change `KIT_NODE` in the script (version and SHA-256 from nodejs.org).

## Where the viewer gets its data

Only from data files — `architecture.yaml` and `workitems.json` — never from a script. The
name of the file in use stands at the top of the control panel. In order:

1. **`fetch`** of `viewer.html?data=<path>` if given, otherwise of `architecture.yaml` next to
   the page. Works over HTTP and in `npm run dev`. On `file://` browsers block fetching local
   files, so this step is skipped there. The path must lead to the server the page came from
   (same scheme, host and port): an address on another server, or with another scheme (`data:`,
   `blob:` …), is never loaded. A link must not be able to make the viewer contact another
   server or carry its own map into it — however the address is spelled (`//host/…` is
   resolved the way the browser would before it is compared).
2. Opened from `file://`: **the map opened last**, if the browser lets its files be read
   without asking (Edge and Chrome, when the user has allowed it for every visit).
3. Otherwise the start page: the **recent maps** to open again with a click, an **Open YAML…**
   button, and a drop of a `.yaml`/`.yml` file (with its `.json`) anywhere on the page.

**Recent maps** (`src/core/recentMaps.ts`, `src/providers/recentFiles.ts`, `RecentList.tsx`).
A page cannot learn or use the path of a file, but Edge and Chrome hand out a _reference_ to a
file the user chose in their file dialog (`showOpenFilePicker`) or dropped
(`getAsFileSystemHandle`). The viewer keeps the references of the last 8 maps in IndexedDB — a
structure file with the work items it was opened with — and lists them on the start page and
under **Recent maps** on the **Files** tab of the control panel, by file name with the first
domains and the date as a hint.
Opening one reads the files again from the disk; the browser asks the user first when it has
to, and only a click may make it ask. **Reload**, at the foot of the control panel's rail, does
the same for the map that is shown: the edit loop is edit, Reload. The same file opened again
is the same entry (the browser tells whether two references mean one file). Where there are no
references — Firefox, Safari, the API switched off — files are opened through a plain file
input each time and nothing is remembered.

The **Open YAML…** button (on the **Files** tab) and drag-and-drop stay available at all times,
so a loaded file can be replaced without reloading the page. Nothing is uploaded anywhere: the
file is read in the browser. A structure file and a work-items file can be opened or dropped
together. Files over 50 MB are refused.

Validation problems appear in the **Diagnostics** panel at the bottom (severity, source, line:col,
path, message). With errors there is no map and the panel is open; with only warnings the map
renders and the panel is collapsed to a count badge — click it to expand.

### Work items

Work items (user stories, tasks, bugs, features, epics) live in their own file, separate from
the structure — typically an export from Azure DevOps. `fixtures/workitems.json` is a dummy
data set of about 60 items for the example. They are found
the same way as the structure: `fetch` of `viewer.html?workitems=<path>` (same server only,
like `?data=`) or of `workitems.json` next to the page (skipped on `file://`), else those the
recent map was opened with, else none — which is not an error.
The map is drawn once the work items are known, so the fetch is given up after 4 seconds; a file
that arrives later than that can be loaded by hand.
**Open work items…** on the **Files** tab loads another file at any time, and a dropped `.json`
file is taken as work items (a `.yaml`/`.yml` file as the structure).

The file format (version 1):

```json
{
  "version": 1,
  "items": [
    {
      "id": 1010,
      "type": "User Story",
      "title": "Add trusted-device exemption to the fraud check",
      "state": "Active",
      "assignedTo": "Robin Patel",
      "iteration": "Shop\\Sprint 13",
      "tags": "comp:storefront.web.fraud-check; risk",
      "parentId": 1001,
      "description": "Returning customers on a known device …",
      "url": "https://dev.azure.com/…",
      "fields": { "Story Points": 8, "Priority": 1, "Area": "Storefront" }
    }
  ]
}
```

`id`, `type` (`User Story`, `Task`, `Bug`, `Feature` or `Epic`), `title` and `state` are
required. `tags` is one string as ADO stores it, entries separated by `;`. A tag
`comp:<node-id>` (prefix in any letter case) links the item to a domain, component or
subcomponent; an item may carry several. `fields` holds any further parameters. `url` must be
an `http(s)` address; anything else is reported and the item is kept without its link.

A **Task** belongs to its parent: when the parent is shown on a node, the task is listed under
it there and its own `comp:` tags place nothing. A task without such a parent is listed by its
own tags; a task without tags whose parent is filtered out (by state or iteration) is listed on
that parent's nodes — or, when that parent is itself an untagged task under an item that is
shown, under that item. Everything else is listed on every node it is tagged to.

The **Diagnostics** panel also reports, under the heading **Work items — _file name_**:
problems in the file (a broken item is skipped, the rest still load), every `comp:` tag that
names no node of the structure, and the items without any `comp:` tag, with the **tag
coverage** in a line above them. A task whose parent has a `comp:` tag counts as tagged (for a
task of a task: the first item above it that has one). The untagged items and the coverage are
those of the items the work-item filter shows (**Work items shown**, see
[Work items on the map](#work-items-on-the-map); the line says how many are hidden and not
counted); unknown `comp:` tags and problems of the file are reported for every item. The heading and the coverage line are
there whenever a work-items file with items is loaded, also when there is nothing to report —
the collapsed panel then shows just "_n_% tagged". A file that gave no items (not valid JSON,
for example) has its error and no coverage, and its problems are listed even while the
structure file has errors of its own. The name of the work-items file stands at the top of the
control panel, under that of the structure file; the **Files** tab shows the number of work
items (and how many of them are shown, when the work-item filter hides some) and that coverage.

**Your own work items:** write a `workitems.json` in the format above (the `comp:` tags must
name IDs of your `architecture.yaml`) and either open it with **Open work items…** / drop it on
the page — opened together with the structure it is remembered with it — or put it next to
the viewer as `workitems.json` when it is served over HTTP (or name it with
`?workitems=<path>`).
`fixtures/workitems.json` is the file to copy from. How they are shown is described under
[Work items on the map](#work-items-on-the-map).

The buttons under **Work items on the map** on the **Detail** tab (shown when there are work
items) choose what the map shows of them — the story mode: **Off**, **Stories only** (the
default) or **Stories + Tasks**. The layout reserves room for the lists inside the boxes — a
leaf grows, a group gets a block between its header and its children — so the map is laid out
again when the story mode, the work-item filter or the work items change: zooming and
collapsing still never move anything. In mode Off the layout is exactly the one without work
items.

## Reading the map

- **Row bands** (when the file has `rows:`) are the tinted horizontal stripes with the row name in
  the left gutter; top-level nodes with no row anywhere sit in the **Unassigned** area on the
  right. A node with a **dashed border** has no row of its own and was placed by its connections
  (hover it for the tooltip).
- **Edges** by kind: `dataflow` solid blue, `dependency` dashed grey, `control` dotted red,
  `config` thin dash-dot green; the arrowhead points at `to`. Labels show `label [protocol]`.
  Edges go around the boxes between their ends where they can; several edges between the same
  two nodes run side by side. Hover an edge for its description.
  Known limit: every edge is a single curve drawn below the leaf boxes, so in a very dense map
  (hundreds of edges) the best available curve can still pass behind an unrelated box and look
  like two edges attached to it. The shipped example has none beyond one clipped corner.
- **Groups** (domains and components with children) collapse and expand with the **chevron** in
  their header, or by **double-clicking** the group. A collapsed group keeps its place and size —
  nothing else on the map moves — and shows what it contains ("3 components · 7 subcomponents").
  Edges to or from anything inside it are re-attached to the group; several edges of the same
  kind and direction between the same two boxes merge into one heavier line labelled with their
  number (`×3`), and edges entirely inside the group disappear. Parallel edges (same `from`,
  `to` and `kind`) are drawn as one line too, but while both their ends are drawn themselves the
  line shows all their labels, one above the other, wherever single edges show theirs.
- **Detail panel lists**: in the panel of a node, the lists (sub-objects, incoming, outgoing and
  inside edges, work items) can be folded by clicking their heading and put in another order by
  dragging a heading onto another one or with the ↑ ↓ buttons next to it. The arrangement is
  remembered in the browser.
- **Rows** can be switched off with **Layout → Arrange in rows**: the map is then laid out
  without row bands, the nodes arranged by their connections alone.
- **Moving things by hand**: click **Unlock positions** on the **Layout** tab, then drag a group
  or a node inside a group. A node stays inside its group, a group takes its contents along, and
  nothing else moves; edges are redrawn when you drop. The positions are remembered in the
  browser for that arrangement (rows on or off, each story mode and each map filtered to a focus
  have their own). **Reset positions** undoes all moves of the arrangement on screen; **Lock
  positions** makes dragging pan the view again.
- **Level of detail** is chosen with the buttons at the top of the **Detail** tab. **Auto** (the
  default) follows the zoom; **Domains**, **Components**, **Subcomponents** and **Everything**
  pin that level whatever the zoom. The filled button is the mode you picked; in Auto the level
  the zoom currently selects is outlined. The tab also says on the rail which level is being
  drawn — `Dom`, `Comp`, `Sub` or `All`, highlighted while the level is pinned — so it can be
  read while the body of the panel is hidden. Search and the panel links raise a pinned level
  that is too coarse to draw what they go to. Clicking any of the buttons also opens the groups
  collapsed by hand, so the whole map shows the chosen level. Groups you collapse afterwards
  stay closed at every level until the next click; "_n_ collapsed by hand" next to the buttons
  counts them.

  The three thresholds can be changed with the sliders under **Auto: zoom thresholds** on the
  same tab (the current zoom is shown beside that heading); **Reset thresholds** restores the
  defaults below.
  **Detail → Shrink collapsed groups** draws a closed group as a small box in the middle of its
  area, with its name and the names of its contents, instead of keeping the full box. The small
  box is always large enough for the name and all the names: it grows taller with the list, and
  wider when the list would otherwise be taller than the group's area. Only a group whose whole
  area is too small for its list keeps the full box and ends the list with "+_k_ more"; one with
  no room for even the first name is drawn as an ordinary collapsed group. Text widths are
  estimated, generously for Latin, Greek, Cyrillic, CJK and emoji; names in other scripts may
  still be cut. The settings are kept in the browser.

  | Zoom (Auto) | Level           | Shows                                                                                     |
  | ----------- | --------------- | ----------------------------------------------------------------------------------------- |
  | below 40%   | `domains`       | domain boxes only, drawn like collapsed groups; edges merged per domain                   |
  | 40% – 100%  | `components`    | components (those with subcomponents drawn closed); edge labels hidden, `×n` counts shown |
  | 100% – 160% | `subcomponents` | subcomponents and edge labels; work items as count badges                                 |
  | above 160%  | `detail`        | everything: the work items are listed inside the boxes                                    |

  A level only changes once the zoom is 5% past a threshold (up past 42% / 105% / 168%, down
  below 38% / 95% / 152%), so it does not flicker at a boundary. Changing level never moves anything: boxes
  keep the position and size of the one layout, and the row bands and the Unassigned area are
  always shown. A group **collapsed by hand stays collapsed** at every zoom. A group closed only
  by the level of detail has a disabled chevron — zoom in to open it. At the `domains` level the
  domain and row titles are drawn larger so they stay readable. The thresholds are the
  `LOD_CONFIG` object in `src/core/lod.ts`.

  A view that starts fitted — on load when no viewport is remembered, and a map that has just
  been filtered to a focus — is judged by the plain thresholds of the table. **Fit view** on the
  rail glides to the fitted view, and the level follows the zoom on the way as with any other
  zoom: a fit that ends within 5% of a threshold keeps the level it came from.

  How far a fit zooms depends on the canvas: the page less the rail of the control panel
  (56 px) and, from a width of 1400 px, less its open body (280 px). In a narrower page the
  open body lies over the canvas, and the map is fitted into the part beside it. A fit also
  keeps the boxes clear of the minimap (bottom right): where the plain fit would put a box under
  it, the map is fitted to end beside the minimap or above it, whichever leaves the map larger.
  Measured with the shipped example, whose plain fit leaves the minimap clear at all of these
  sizes (sizes of the page, without the browser's own bars):

  | Page      | Body hidden           | Body open             |
  | --------- | --------------------- | --------------------- |
  | 1024×768  | 37.1%, `domains`      | 26.2%, `domains`      |
  | 1366×768  | 50.2%, `components`   | 39.6%, `domains`      |
  | 1440×900  | 53.1%, `components`   | 42.4%, `components`   |
  | 1920×1080 | 71.5%, `components`   | 60.8%, `components`   |
  | 2560×1440 | 96.1%, `components`   | 85.3%, `components`   |
  | 3440×1440 | 119%, `subcomponents` | 119%, `subcomponents` |

  With the body hidden the fit is in `domains` below a width of about 1100 px and in
  `subcomponents` from about 2660 px (given a height of 1210 px or more); with the body open, in
  `domains` below 1376 px and in `subcomponents` from about 2940 px. Until it has been shown or
  hidden by hand, the body starts hidden in a page narrower than 1400 px, so the example first
  opens at 50% at 1366×768. Where the 5% matter with the body open: at 1366×768 **Fit view**
  pressed at the `components` level ends at 39.6% and stays in `components`, while a fitted load
  shows `domains`; at widths from 1400 to about 1430 px the fit ends between 40.8% and 42%, so a
  fitted load shows `components` and **Fit view** pressed at the `domains` level stays in
  `domains`.

- **Minimap** (bottom right): always the whole map at the same scale, with the part the canvas
  shows as a rectangle. When the view is panned partly or wholly off the map, the rectangle is
  cut off at the edge of the minimap; the minimap itself does not shrink. Press anywhere in it to
  put that point in the middle of the canvas, keep the button down and drag to move the view
  along with the pointer; the mouse wheel over it zooms the canvas about its middle.

- **Work items** are listed inside the boxes at the `detail` level and counted in a badge
  elsewhere — see [Work items on the map](#work-items-on-the-map).

- The layout is computed once per loaded file (and again when the story mode, the work-item
  filter or the work items change, and for a map filtered to a focus) and never changes on pan,
  zoom or collapse; nodes can be dragged only after **Layout → Unlock positions**. **Fit view**
  on the rail of the control panel shows the whole map; a small map is not magnified beyond
  125%. The fit button among the zoom controls at the bottom left is the canvas library's own:
  it fits the map into the whole canvas, without that limit and without leaving room for the
  open body of the control panel or for the minimap.

## Using the map

| Action                                  | How                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Pan / zoom                              | drag the canvas / mouse wheel or pinch; press, drag or wheel in the minimap (bottom right) |
| Show the whole map                      | **Fit view** on the rail of the control panel                                              |
| Choose how much is drawn                | **Detail** tab: Auto (follows the zoom), Domains, Components, Subcomponents, Everything    |
| Collapse / expand a group               | its chevron, or double-click it; **Detail → Collapse all** / **Expand all**                |
| Select a node, an edge or a merged edge | click it                                                                                   |
| Select a story, bug or task             | click its line in a box (zoom in to **Everything** to see the lines)                       |
| Clear the selection                     | click the empty canvas, press **Esc**, or **×** in the panel                               |
| Find a node or a work item              | type in the search box; **/**, **Ctrl+K** or **Search** on the rail puts the cursor there  |
| Show / hide an edge kind                | the four kind buttons under **Visibility → Edges** (the legend is on the canvas, top left) |
| Choose what the map shows of the work   | **Detail → Work items on the map**: Off / Stories only / Stories + Tasks                   |
| Hide work items by state or iteration   | **Visibility → Work items shown** (a path above a sprint, e.g. a PI, covers its sprints)   |
| Follow one story through the map        | **Visibility → Focus**: a flow, an epic or a feature; or **Focus** in a work item's panel  |
| Draw only what a focus involves         | the **Focus / Filter** switch (**Visibility** tab, or in the focus bar above the canvas)   |
| See where the work is                   | **Lenses → Heat by work**, **Progress bars**                                               |
| Colour the boxes                        | **Lenses → Colour by**: owner, status, tech or a metric (legend at the top left)           |
| Calm the overview                       | **Visibility → Edges on demand**                                                           |
| Keep or share an arrangement            | **Views** tab: save under a name, apply, delete, **Copy link**                             |
| Lay out without the row bands           | **Layout → Arrange in rows**                                                               |
| Move boxes by hand                      | **Layout → Unlock positions**, drag, **Lock positions**; **Reset positions** undoes it     |
| Load other data, or a map opened before | **Files** tab: **Open YAML…**, **Open work items…**, **Recent maps**; or drop a file       |
| Read the files of the map again         | **Reload** on the rail (maps opened from disk in Edge and Chrome)                          |
| Get more room for the map               | **Hide** on the rail, or click the tab that is shown; **Show** or any tab brings it back   |

### The control panel

Everything that is chosen or set is in a panel at the left, as tall as the window: a **rail**
that is always there and, beside it, a **body** that can be hidden. In this document
"**Lenses → Colour by**" means the control _Colour by_ on the tab _Lenses_.

The rail holds, from the top: **Search** (puts the cursor in the search box), the six tabs, and
at its foot **Reload** (while the map shown is one the browser can read again from the disk),
**Fit view** and **Hide** / **Show**. The body shows the name and version of the viewer with
the names of the structure file and the work-items file, below them the search box, and then
the tab that is chosen:

| Tab            | Holds                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detail**     | The level of detail; **Groups**: Collapse all, Expand all, Shrink collapsed groups; **Work items on the map**: the story mode; **Auto: zoom thresholds**    |
| **Visibility** | **Focus**: the chooser and the Focus / Filter switch; **Edges**: the four kind buttons, Edges on demand; **Work items shown**: the states and the iteration |
| **Lenses**     | Colour by, Heat by work, Progress bars                                                                                                                      |
| **Layout**     | **Rows**: Arrange in rows; **Positions**: Unlock / Lock positions, Reset positions                                                                          |
| **Views**      | The saved views: save under a name, apply, delete; Copy link, of the current arrangement or of a saved view                                                 |
| **Files**      | **Structure** and **Work items**: what each file holds, with Open YAML… and Open work items…; **Recent maps**                                               |

The **Detail** tab is headed "Level of detail" in the body, so that it is not taken for the
detail panel at the right. A control is offered when it has something to act on: the story
mode, **Work items shown**, Heat by work and Progress bars when work items are loaded, the
focus chooser when the structure has flows or work items are loaded, Colour by when the
structure has attributes or metrics, **Recent maps** when there are any. A tab whose controls
need a map says "Nothing is drawn yet." until one is drawn. While no structure is loaded (the
start page, a file with errors) only **Files** can be chosen; the tab chosen before comes back
with the map.

The tabs say on the rail what is behind them: **Detail** the level being drawn, **Visibility**
a dot while something is hidden, paled or filtered (an edge kind hidden, a focus set, Edges on
demand holding edges back at the Domains or Components level, work items hidden by the
work-item filter), **Views** the number of saved views. The tooltips say it in full ("Level of
detail: Components — follows the zoom"), and that of **Files** names the files in use.

- **Showing and hiding.** A click on a tab shows it. A click on the tab that is shown hides the
  body, as does **Hide**: the rail stays, and **Show** or a click on any tab brings the body
  back. With the keyboard, **↑ / ↓**, **Home** and **End** move among the tabs.
- **Wide and narrow windows.** From a width of 1400 px the open body stands beside the canvas,
  and hiding it gives the canvas its 280 px. In a narrower window the open body lies over the
  left of the map instead. The canvas keeps its size there, so opening a tab moves nothing on
  the map, and the viewer places the view clear of the body: **Fit view**, a map fitted when it
  is drawn (on load, or filtered to a focus), and going to a search result or to a link in a
  panel use the part of the canvas beside it. Everything else at the left begins where the open
  body ends: the notices above the canvas (a file error, the focus bar), the status lines, the
  start page, the legends, the zoom controls and the Diagnostics panel. Until the body has been
  shown or hidden by hand (a click on a tab counts, and so does a key that moves among them), it
  is open while the window is at least 1400 px wide and hidden while it is narrower.
- **Search with the body hidden.** **/**, **Ctrl+K** and **Search** on the rail show the search
  box alone, as a small card beside the rail. It goes when the cursor leaves it: a match
  chosen, **Esc** twice, a click elsewhere.
- **Not on any tab**, so there whichever tab is shown: above the canvas a file error and the
  focus bar; on the canvas the legends (top left), the zoom controls (bottom left) and the
  minimap (bottom right); the detail panel at the right and the Diagnostics panel below the
  map.

The tab shown and whether the body is hidden are remembered in the browser, once for the
viewer.

### Selection and the detail panel

Clicking a node, an edge or a merged (`×n`) edge selects it. The selected element is outlined
(edges are drawn heavier), and everything outside its **neighbourhood** is dimmed — never hidden,
and nothing moves. The neighbourhood of a node is the node, the edges drawn at it and the nodes at
their other ends (plus whatever is drawn inside it, if it is an open group); the neighbourhood of
an edge is the edge and its two ends. Row bands are never dimmed. The selection is kept while you
collapse, expand or zoom: if the selected node gets hidden, the group standing in for it is
highlighted instead; if a selected edge gets rolled into a merged edge, that one is. A selected
merged edge only exists while it is drawn: when its groups are opened (or you zoom in) it
becomes the one edge left on that line, or the selection is cleared.

Edges between the same two boxes run side by side, closer together than their click areas are
wide. A click therefore selects the edge whose **line is nearest** to the pointer (within 10 px
at 100% zoom), not whichever happens to be drawn on top. Where two such lines touch or cross
(the bottom of two parallel arcs, for example) they cannot be told apart — click nearer to
either end, where they run apart.

The **detail panel** opens at the right of the canvas and shows:

- **Node:** name, ID, level, row, description, the **parent path** as a breadcrumb, the list of
  children, and its **incoming** and **outgoing** edges. The row reads as the row's name;
  `spans X–Y` for a group that spans several rows; `<row> — placed by connections` for a node
  without a row of its own inside a spanning group; or `Unassigned`. (No row line when the file
  has no rows.) The edge lists are the original edges from the YAML, never merged ones, and for a
  group they include the edges of everything inside it, marked `via <descendant>`; edges with
  both ends inside the group are listed separately as **Edges inside**. An edge of a kind that is
  currently hidden is marked `hidden`.
- **Edge:** label, from → to, ID, kind, protocol, description.
- **Merged edge:** source → target, kind, count, and the **member edges**.

Everything underlined in the panel is clickable:

- A **node** (breadcrumb, child, edge end) selects that node and brings it on screen: collapsed
  groups around it are expanded, and — only if needed — the view pans and zooms so that the node
  is on screen at a zoom whose level of detail draws it. If it is already visible, the view does
  not move.
- An **edge** (in a node's lists, or a member of a merged edge) selects that original edge: the
  collapsed groups around both of its ends are expanded, its kind is switched back on if it was
  hidden, and the view pans and zooms so that both ends are on screen and drawn. When the
  two ends are too far apart to fit at the zoom their level of detail needs (above 110% for
  subcomponents), drawing them wins and the view shows the edge's **source** end, placed at the
  side of the canvas away from the target so that as much of the edge as possible is visible;
  the **to** link in the edge panel takes you to the other end.

While the map is filtered to a focus (see [Filter mode](#filter-mode)) the panel still lists
the whole structure. A node, an edge, a step of a flow or a work item that the filtered map
does not have is set in italics, and its tooltip ends "— not on the filtered map; click to show
the whole map": the click switches back to Focus mode and goes there. When the selected thing
itself is not on the filtered map — it was selected before the map was filtered — its panel
stays and says "Not on the map: Filter leaves it out." with a **Show it** button that does the
same.

The node panel ends with its **work items**, and a selected work item has a panel of its own:
see the next section.

### Work items on the map

The buttons under **Work items on the map** on the **Detail** tab (shown when work items are
loaded) choose what the canvas shows of them: the story mode. It is remembered.

| Story mode          | On the canvas                                                                          |
| ------------------- | -------------------------------------------------------------------------------------- |
| **Off**             | nothing — no lines, no badges. The panels still list the work items.                   |
| **Stories only**    | every box lists the stories, bugs, features and epics tagged to it: type icon + title  |
| **Stories + Tasks** | under each of them also its tasks, indented: task icon + the first three words and "…" |

- **Icons** (in the Azure Boards colours): blue open book = User Story, yellow clipboard with a
  check = Task, red bug = Bug, purple trophy = Feature, orange crown = Epic.
- The **lines are drawn at the Everything level** only (zoom above 160%, or **Everything**
  pinned), in the room the layout reserved inside the box: below the name of a leaf, between the
  header and the children of a group. A title is one line, cut off with "…"; hover a line for
  the type, ID, state and full title. Closed, done, resolved and removed items are struck
  through. A box lists at most 8 lines; a longer list ends with "+_k_ more" — select the box to
  see them all in the panel.
- **Nothing lies on the lines.** The list of an open group is drawn on a small panel of its own
  above the edges, at the left end of the group's strip, as wide as its lines need: an edge on
  its way to a box inside the group passes behind it (and is routed around it where it can be).
  Edge labels keep clear of names and lines: a label is moved along its edge, broken into up to
  three lines, or — on a very short edge between two boxes side by side — centred over the
  border of the box that has nothing written there. A label that would still lie on a
  work-item line is **not drawn**: hover the edge for its text, or select it for the panel.
- **Everywhere else there is a badge** instead: at the coarser levels, and on a collapsed group
  (full box or shrunk). It counts the work items listed on the box and on everything hidden
  inside it (book icon), and the open bugs among them (bug icon); an open group counts its own
  items only. "Open" means a state other than Closed, Done, Removed or Resolved.
- Description, assignee, iteration and the other parameters are **never on the canvas** — only
  in the panel.

Changing the story mode (or the work-item filter, or loading other work items) lays the map out
again, because the boxes change size; "Computing layout…" shows at the top of the canvas
meanwhile. The view **keeps its place**: the box in the middle of the canvas stays in the
middle, at the same zoom, and that view is the one a reload comes back to (of the whole map: a
map filtered to a focus leaves the remembered view alone). If that should ever leave the canvas
without any of the map, the view is fitted.

**Selecting.** Click a line to select that story, bug, feature, epic or task (the lines are
buttons: **Tab** reaches them, **Enter** selects). Its line is marked, the boxes that list it
stay lit and the rest of the map is dimmed. The selection survives zooming and collapsing like
any other; when the box is closed or the level is too coarse for lines, the box that stands in
for it stays lit. **Esc** clears it. The **work-item panel** shows:

- type icon, title, type and #ID (with a link to Azure DevOps when the data has a URL);
- state, assigned to, iteration, every further parameter (`fields`: Story Points, Priority,
  Area, …) and the other tags;
- the description;
- **Tagged to**: the nodes it is tagged to — click one to go to that node; tags that name no
  node are listed as unknown;
- **Parent**: the item above it — click to go to it;
- **Tasks** (for a feature or epic: **Child items**): each with its **full text**, ID, state
  and assignee — click to go to it.

**Show on the map** in that panel opens the box that lists the item (and the groups around it),
raises a pinned level to Everything — or in Auto zooms in to 176% — and pans to the list (the
name of the box with its list; when that does not fit, the line of the item itself); the same
happens when you click a work item in a panel or choose one in the search. The story mode
is never changed for you, because that lays the whole map out again: an item that has no line
says why in its panel — the story mode is Off, tasks are only listed in Stories + Tasks, the line
is under "+_k_ more", or it has no usable `comp:` tag — and offers the mode that draws it; the
box it belongs to is brought on screen instead.

The **node panel** lists the node's **work items** below its edges: those tagged to the node
itself ("On this node"), then those of every node inside it, each group under the name of its
node (clickable), with the tasks under their story. Each entry shows type, title, ID, state and
assignee, and is clickable. This list is complete at every level, in every story mode.

**Work items shown** (on the **Visibility** tab) is the work-item filter: untick a state (for
example Closed) to hide its items, and pick an iteration to show only that one ("All
iterations" by default). Hidden items leave the lines, the badges, the counts, the panels and
the search, and the map is laid out again without their room; a selected item that gets hidden
is deselected. A task whose story is hidden stays on the map, listed on that story's nodes.
States that differ only in letter case ("Active", "active") are one choice. The tag coverage
and the list of untagged items in the diagnostics follow the work-item filter too: they cover
the items that are shown. The work-item filter is remembered; an iteration that the loaded file
does not have is ignored. It is not the **Filter** of [Filter mode](#filter-mode), which draws
only what a focus involves.

### Search

Type part of a **name or ID** into the search box at the top of the control panel (case does
not matter). Matches are listed with name, level and ID — exact matches first, then names/IDs
starting with the text, then words or ID segments starting with it, then the rest; at most 12
are listed. **↑ / ↓** move through the list, **Enter** takes the highlighted match (the first
one by default), a click takes any; **Esc** closes the list, and a second **Esc** clears the
box. Choosing a match expands the groups around that node, pans and zooms to it (to at least
44% for a component and 110% for a subcomponent, so the level of detail is sure to draw it) and
selects it.

The same box finds **work items**, listed after the nodes with their type icon, #ID and state:
by `#1010` (or just the digits; IDs starting with them match too) and by words of the title, in
any order. When both nodes and work items match, up to five of the twelve places go to work
items. Choosing one selects it and shows it on the map as described above. Only the items the
work-item filter shows are found.

On a map filtered to a focus the search still covers the whole structure. A match that the
filtered map does not have has its name set in italics and is marked "not on the filtered map"
after its ID; choosing it switches back to Focus mode and goes there (see
[Filter mode](#filter-mode)).

### Edge-kind filter

The four buttons `dataflow`, `dependency`, `control`, `config` under **Visibility → Edges**
each show a sample of the kind's line. Clicking one hides or shows all edges of that kind
(hidden kinds are struck through); its tooltip gives the number of edges of that kind on the
map. Hidden kinds are removed before edges are merged, so merged edges and their `×n` counts
cover only what is shown. Hiding a kind does not change the layout.

The **edge legend** at the top left of the canvas shows the same four samples with the names of
the kinds, two to a line, whichever tab is shown and also while the body of the control panel
is hidden; a hidden kind is struck through and dimmed there. It is a key only: the kinds are
switched on the **Visibility** tab. The legend of **Colour by** sits below it.

### Focus, lenses and views

- **Focus** shows what one thing involves: choose a flow, an epic or a feature under
  **Visibility → Focus**, or press **Focus** in the panel of any work item or flow. The nodes
  and edges involved stay lit — for a work item the nodes of everything under it (as far as the
  work-item filter shows it) and the edges among them — and the rest of the map is paled, except
  what is selected: the selected node with what is drawn inside it, the selected edge with its
  two ends, the nodes that show a selected work item, and the groups around them stay readable
  although the focus does not involve them. A bar above the canvas names the focus and counts its nodes and edges; **Show** in it opens the
  panel of the focus and **Clear focus** ends it. Choosing a flow also opens its panel —
  description, the steps in order (each a link to its edge) and the nodes it names — and
  brings what it involves on screen. The panel of a node or an edge lists the flows it is part
  of. The **Focus / Filter** switch, under the chooser and again in the bar, leaves the rest of
  the map out instead of paling it: see [Filter mode](#filter-mode).
- **Heat by work** (**Lenses** tab): a strip up both sides of each box, as tall as the open
  work in it and inside it compared with the hottest box of the same level, coloured from the
  bottom up like a bar of iron being heated — ember, red, yellow, white at the tip of the
  hottest. Hidden items are no work (the work-item filter counts).
- **Progress bars** (**Lenses** tab): the bottom edge of a box as a bar of completed over all
  items in it, for the iteration chosen under **Work items shown** (a parent path covers its
  sprints) or in total. The state filter does not affect them.
- **Colour by** (**Lenses** tab): the boxes tinted by `owner`, `status` or `tech` (one colour
  per value, in the order the values first appear; from the ninth value on "Other") or by a
  metric (light = smallest, dark = largest); its legend sits at the top left of the canvas,
  below the edge legend. The node panel shows the attributes (saying where an inherited one
  comes from), the metrics and the links.
- **Edges on demand** (**Visibility** tab): at the Domains and Components levels the edges are
  hidden except at the box under the pointer, at the selected box or edge, and those of the
  focus.
- **Views** (**Views** tab): the current arrangement — collapsed groups, hidden edge kinds,
  level of detail, focus (and that the map is filtered to it, when it is), colouring, story
  mode and the point in the middle of the view with the zoom — saved under a name, per
  structure, in the browser; applied or deleted from the list. **Copy link** puts
  `viewer.html#view=…` on the clipboard and in the address bar: the link carries the view
  itself and is applied when the page opens with it. The tab shows the number of saved views
  on the rail.
- **Hints** at the end of the Diagnostics panel say what an author could add: nodes without a
  description or without any connection, domains without work items, no flows. They are
  neither errors nor warnings.

### Filter mode

The **Focus / Filter** switch says how a focus is shown. It stands under the focus chooser on
the **Visibility** tab and again in the focus bar above the canvas; both are the one setting,
which is remembered. **Focus** (the default) pales the rest of the map. **Filter** does not
draw it: the map is reduced to what the focus involves and laid out again as a map of its own.
The bar then begins "Filter:" instead of "Focus:" and adds "· the rest of the map is not
drawn", and the line under the switch counts what is left out ("Not drawn: 31 of 45 nodes.").

- **What is kept** is exactly what Focus leaves unpaled: the nodes the focus involves, the
  groups around them, everything inside them, and the edges of the focus among them.
- **The layout.** What is kept is laid out again, so it moves together. Every node stays in
  the row it has on the whole map — one that is placed by its connections there keeps that row
  and its dashed border — and a row left without a node is dropped, so the bands close up;
  when no kept node has a row there are no bands. **Layout → Arrange in rows** applies as on
  the whole map.
- **The view.** A filtered map arrives fitted: when the switch is set to Filter with a focus
  chosen, and when a focus, or another one, is chosen while it stands on Filter. Choosing a
  flow then does not move the view first. A flow that cannot be filtered (see the next point)
  is brought on screen on the whole map as in Focus mode — when a filtered map is on screen,
  once the whole map is back. Leaving the filtered map — the switch back to Focus,
  **Clear focus**, or going to something that is left out — brings the whole map back in the
  view it had before, at the same zoom; if the whole map was laid out anew in between (another
  story mode, for example), the place that was in the middle is in the middle again. Where
  the whole map had not come to rest on screen before (a link that opens filtered), it is shown
  at its remembered viewport, or fitted.
- **Nothing to leave out.** Without a focus the switch only waits: the line under it ends
  "Applies once a focus is chosen." A focus that cannot be filtered leaves the whole map, shown
  as in Focus mode. One that involves every node and every edge leaves nothing out: the bar adds "· nothing to
  leave out: the whole map is shown", and the line under the switch reads "The focus leaves
  nothing out: the whole map is shown." One that involves no node, or is not among the loaded
  data, would leave nothing to draw: the bar adds "· nothing of it is on the map: the whole map
  is shown, paled", and the line reads "The focus involves nothing on the map: the whole map is
  shown, paled." While a filtered map is being laid out, the line reads "The map is being laid
  out again…".
- **Asking for something that is left out.** The search, the detail panel and the Diagnostics
  panel keep covering the whole structure, and the first two mark what the filtered map does
  not have (see [Search](#search) and
  [Selection and the detail panel](#selection-and-the-detail-panel)). Going to such a node,
  edge or work item wins over Filter: the switch goes back to **Focus** — the focus itself
  stays — the whole map returns, and the target is selected and brought on screen. The bar
  says so ("Filter switched off to show _name_."), and its switch turns Filter on again with
  one click. A work item is on the filtered map when at least one of the boxes that list it is.
- **Level of detail and collapsing** work on the filtered map as on the whole one. In Auto the
  level is the one the fitted zoom selects; a small part of the map is fitted closer in than
  the whole. The groups collapsed by hand are one set for the structure, shared by both: a
  group closed on the filtered map is closed on the whole map too, and **Collapse all**,
  **Expand all** and "_n_ collapsed by hand" are about every group of the file. Entering
  Filter in Auto while the Everything level is drawn can fit twice: the fit zooms to 125% at
  most, which with the default thresholds leaves that level; the lists in the boxes then go,
  and the smaller map is fitted once more.
- **Edges.** Hidden edge kinds stay hidden, and the tooltips of the kind buttons count the
  edges of the map on screen. **Edges on demand** holds nothing back on a filtered map: every
  edge there is one of the focus.
- **Positions moved by hand.** Each filtered map has positions of its own
  (**Layout → Unlock positions**): they are kept in the browser and come back with that map,
  the whole map keeps its own, and **Reset positions** undoes those of the map on screen.
- **Work items and lenses** say about a box what they say on the whole map: it lists and
  counts the same work items, the badge of a closed group counts everything inside it, heat is
  measured against the hottest box of its level on the whole map, and progress and colours are
  unchanged.
  Changing the story mode or the work-item filter lays the filtered map out again and keeps
  the place. With a work item as the focus, the work-item filter also changes what the focus
  involves, and so what is kept.
- **Saved views and links.** A view saved, or a link copied, while the map on screen is
  filtered to its focus keeps that: applied, it sets the focus and Filter again and puts the
  view where it was on the filtered map. A view with a focus that was saved on the whole map
  is shown in Focus mode, and sets the switch to Focus when it stood on Filter; a view without
  a focus leaves the switch as it is. If the focus of a view saved on a filtered map cannot be
  filtered with the data that is loaded, the whole map is shown, fitted. Views and links saved
  before the switch existed open as they did. A link copied on a filtered map needs a viewer
  that has Filter mode (0.2.0 or later): an older one shows its focus in Focus mode, with the
  view at the wrong place.
- **Reloading.** The focus is not remembered, the switch is: after a reload of the page, or
  **Reload**, the whole map is shown at its remembered viewport with the switch still on
  Filter. With a `#view=` link in the address bar the view of the link is applied again, its
  focus and its mode included.

### What is remembered

Per structure (identified by its domain IDs), in the browser's `localStorage`:

- which groups are collapsed,
- the last viewport (pan and zoom) of the whole map — restored on the next load **instead of**
  fitting the view, as long as it is valid and still shows a useful part of the map on the
  canvas as it is now (at least about 48 px of it in each direction; otherwise the view is
  fitted); **Fit view** gets you back to the whole map. It is not updated while the map is
  filtered to a focus,
- which edge kinds are hidden.

Per structure as well: the saved views. Per arrangement: the positions moved by hand. Once for
the viewer (not per structure): the display settings — the thresholds, "Shrink collapsed
groups", "Arrange in rows", the story mode, the work-item filter, the lenses (heat, progress,
edges on demand, colour by) and the Focus / Filter switch — and the control panel: the tab
shown and whether its body is hidden.

In IndexedDB, once for the viewer: the recent maps — references to the files of the last 8 maps
opened from disk (Edge and Chrome), not their content.

The selection and the focus are not remembered. If `localStorage` is unavailable or blocked,
the viewer works the same and simply starts fresh every time. Note that a page opened from
`file://` has its own storage per browser, shared by all `file://` pages.
