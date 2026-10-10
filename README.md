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
inherited by everything inside), `labels` (name → value, under names the file chooses;
inherited the same way), `links` (`{ label, url }`, http(s) only) and `metrics`
(name → number). A top-level `flows:` list names stories told through the edges (`id`, `name`,
`kind: workflow | dataflow`, `description`, `edges` in step order, `nodes`). A top-level
`presets:` list names colourings, offered under **Lenses → Colour by** (`name`, the `label`
whose values it colours, `description`, `values`: a colour for a value). `examples/template/`
holds a short structure file and its work items in which every key occurs once, with what it
does.

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
`fixtures/workitems.json`, are served the same way at `/workitems.json`. The template files
(`examples/template/`) are not served in dev: the build copies them beside the viewer.

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
edge-kind filter, the focus in both of its modes (Focus and Filter), edges on demand, the map
closed up around its closed groups (what keeps its place, the level of detail, fitting), open
groups resized and dragged by their title bar while positions are unlocked, the heat and
progress of open groups, Colour by with labels and presets (the legend on both colour schemes,
a view whose colouring the file lacks, the template files), the work items (loaded, diagnosed,
room reserved per story mode) and persistence across a reload.
It uses Node built-ins only (Node 22+), finds the browser in its usual install location (set
`BROWSER` to the executable to override), and closes the browser when done. The browser
profile is one directory in the temp directory,
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
(the dummy work items), `examples` (the shipped example; in `examples/template/` the template
files), `scripts`.

## Build and share

```sh
npm run build
```

produces:

| File                              | Purpose                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `dist/viewer.html`                | The whole app in one file (JS and CSS inlined); works offline, `file://`                     |
| `dist/architecture.yaml`          | The structure file (the example): opened from disk, fetched over HTTP                        |
| `dist/workitems.json`             | The work-items file (the dummy data), likewise                                               |
| `dist/template/architecture.yaml` | A short structure file with every key once and what it does: the file to copy and start from |
| `dist/template/workitems.json`    | The matching work items: one of each type                                                    |
| `dist/README.md`                  | Guide to the viewer and to writing both data files (`docs/viewer-README.md`)                 |
| `dist/THIRD-PARTY-NOTICES.txt`    | The open-source software inside `viewer.html` and its licence texts                          |

`dist/` is a folder that can be handed on **without the repo**: its `README.md` describes the
viewer, the full format of `architecture.yaml` and `workitems.json`, how to derive them from a
repository and from Azure DevOps, and how to check the result — enough for a person or an agent
to make a map for another project. Nothing is generated from the data files: they are edited
and opened as they are. When the formats or the viewer's behaviour change, update
`docs/viewer-README.md` with them.

`dist/template/` holds the files to start a map from: every key the viewer reads occurs in
them once — in the structure file with a comment that says what it does, in the work items
with a title that says it. The build copies them from `examples/template/` (the list is
`TEMPLATE_FILES` in `src/core/template.ts`); the viewer names them on the **Files** tab and on
the start page, and neither links to them nor fetches them. Two unit tests keep them true:
`src/core/template.test.ts` fails when a key the viewer reads is missing from them, and
`src/core/docs.test.ts` when the two complete files shown in `docs/viewer-README.md` are not
these files word for word.

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
  the example data files, the template files, the guide and the notices. All that is needed to
  **use** the map.
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
   button, and a drop of a `.yaml`/`.yml` file (with its `.json`) anywhere on the page. The
   page also says where the template files are (`template/` in the viewer's folder), as the
   **Files** tab does under **Open YAML…**.

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
`examples/template/workitems.json` is the short file to copy from — one item of each type, one
of them with every key; `fixtures/workitems.json` is the dummy set of the example. How they are
shown is described under [Work items on the map](#work-items-on-the-map).

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
  their header, or by **double-clicking** the group (an open group, while the positions are
  unlocked, at its title bar: see "Moving things by hand" below). A collapsed group keeps its
  place and size —
  nothing else on the map moves, unless **Layout → Close up the gaps** is on (see below) — and
  shows what it contains ("3 components · 7 subcomponents").
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
- **Closing up the gaps**: **Layout → Close up the gaps** (off by default) moves the boxes that
  are drawn closer together whenever groups are closed — by hand, by **Collapse all**, by a
  pinned level, or in Auto by the zoom — and apart again when they open.
  - **What moves.** A closed group is drawn shrunk (as **Detail → Shrink collapsed groups**
    draws it) and takes only the room of its small box; an open group closes up around what is
    drawn inside it and shrinks to it; a leaf keeps its size. The row bands and the Unassigned
    area close up too: with rows, the items of each band are placed again from their new sizes,
    in the same order, each band is as tall as what it now holds, and a closed group that spans
    rows keeps its column over those rows.
  - **What stays.** The order, among the boxes of one group and among the domains: a box that
    is left or right of another box stays on that side, and so does one above or below it. The
    space between two such boxes is never less than on the full map — or, where it is wider
    there, than the usual spacing (48 px side by side, 32 px between the items of the row
    bands, 24 px one above the other): a wide gap may close down to that. One exception: a
    box of the Unassigned area follows its connections, as it does on the full map — it stays
    right of the row bands and above or below the other boxes of the area, but it may come to
    stand beside a box in the bands that it stood above or below. The map never becomes wider
    or taller than the full one. Nothing is laid out again — the map is still laid out once,
    fully expanded, and closing up only moves those boxes — so it happens at once, and the same
    groups closed at the same level give the same map: zooming across a level and back shows
    the map as it was. With every group open at the Subcomponents or Everything level the map
    is the full one.
  - **What changes it.** A group opened or closed by hand, **Collapse all** and **Expand all**,
    pinning a level (or going back to Auto), switching the option, a work-item badge appearing
    on or leaving a closed group (another story mode or work-item filter), and in Auto a zoom
    that crosses a level. Pan, zoom within a level, selection, the lenses, the edge kinds and
    dragging or resizing a box do not.
  - **What keeps its place.** When a group is opened or closed with its chevron or by
    double-clicking it, that group stays where it is on the screen — its top left corner, with
    the header and the chevron — and the rest of the map closes up or opens out around it. For
    every other change the box in the middle of the canvas stays where it is, at the same zoom
    (the innermost box drawn there both before and after: a subcomponent that is no longer
    drawn hands over to its component; with no box in the middle, the nearest one keeps its
    distance to it). The map and the view change in the same frame.
  - **Auto.** With the option on, the level follows the zoom once the view has come to rest —
    0.2 s after it last moved, and not while a finger is on the screen or the canvas is being
    dragged — not in the middle of a zoom; the **Detail** tab shows the level that is drawn.
    While the zoom has passed a threshold and the view has not come to rest yet, the button of
    the level to come has a dashed outline, and so has the level shown on the rail (its tooltip
    names the level to come). The work-item lists of the Everything level come and go with that
    level, when the view rests.
    Going somewhere — a search result, a link in the detail panel, a work item, a saved view —
    first closes up the map for the level the move ends on, then moves the view.
  - **Shrink collapsed groups** is implied: while the option is on, closed groups are drawn
    shrunk whatever that setting says, and its checkbox on the **Detail** tab shows checked and
    disabled, with "(on with Layout → Close up the gaps)". The setting itself is kept and
    applies again when the option is switched off.
  - **Positions and sizes set by hand** belong to one arrangement, and each closed-up
    arrangement has its own: a box dragged, or an open group resized, while the map is closed up
    for one set of closed groups is back as the layout made it when another set is drawn, and as
    it was left when that set is drawn again. In Auto every level that closes other groups is
    such a set: a group resized at the Subcomponents level has its computed size at Components
    and is resized again back at Subcomponents. What was moved or resized on the full map is not
    carried into the closed-up arrangements; it shows again with the option off, or with every
    group open. **Reset positions** undoes the moves and the sizes of the arrangement on screen.
  - **Limits.** Without rows, keeping the boxes on their sides of each other costs room: a gap
    stays open where a box further along still needs it, so the map closes up less than it
    could if boxes were allowed to pass each other. With rows the items of each band are packed
    again, which costs less; but an item also stays right of the items of other rows that it
    was right of, so a gap can stay open in one row where a box of another row needs it.
    Positions and sizes set by hand do not carry over from one arrangement to another (see above). The
    shipped example without work items (map size in canvas pixels):

    | Rows | Full map  | Closed up at Domains | Closed up at Components |
    | ---- | --------- | -------------------- | ----------------------- |
    | on   | 2484×1120 | 1608×378             | 2352×778                |
    | off  | 4020×1092 | 1923×290             | 3377×656                |

- **Moving things by hand**: click **Unlock positions** on the **Layout** tab, then drag a box. A
  leaf or a closed group is picked up anywhere on it. An **open group** — one drawn with its
  children — is picked up by its **title bar** only: the bar shows six dots at its right end,
  the pointer is the move cursor on it, and its tooltip begins "Drag the title bar to move
  _name_". A node stays inside its group, a group takes its contents along, and nothing else
  moves; edges are redrawn when you drop. **Lock positions** makes dragging pan the view again.
  - **Inside an open group.** While the positions are unlocked, the rest of an open group is
    canvas: a drag there pans the map, the wheel and a pinch zoom it, and a drag from a box
    inside the group moves that box. On a touch screen a finger inside an open group pans and
    pinches in the same way. A click there still selects the group. The chevron stays a button:
    it collapses the group and never drags it. A double-click collapses an open group at its
    title bar (and on its heat strip, its progress bar or its badge), not anywhere inside it; a
    closed group still opens with a double-click anywhere on it. The tooltip with the
    description of an open group shows at its title bar. With **Edges on demand**, an open group
    shows its edges while the pointer is on its title bar, a heat strip, the progress bar, the
    badge or a resize handle, not while it is inside the box. With the positions locked none of
    this applies: the whole box of an open group takes the double-click and the pointer.
  - **Resizing an open group.** While the positions are unlocked, every open group — at any
    level — has a handle on each of its four edges and each of its four corners, on its border
    and just outside it, and a grip mark in its bottom-right corner. Drag a handle: that edge
    (at a corner, both edges) follows the pointer in whole pixels, and the other edges stay.
    Everything inside the group stays where it is on the canvas, whichever edge moves; it is
    never laid out again and never scaled. The group's own work-item list stays under its title
    bar. Neighbours, row bands and the Unassigned area do not move: a resized group may overlap
    them and may leave its band, as a moved box may. While you drag, only the box follows;
    edges, the minimap and the group's work-item list are redrawn when you drop. A box inside
    can then be moved anywhere in the resized group.
  - **How far.** A nested group grows up to the border of its parent, and upward up to the
    parent's title bar and the parent's own work items. The parent does not grow along: for
    more room, grow the outer group first, then the inner one. A top-level group grows at each
    edge by at most the size of the map as the layout made it — its width to the left and to
    the right, its height upward and downward. Shrinking, an edge stops 16 px from the nearest
    box inside (at the top: under the title bar, the group's own work items and 8 px), or at
    the smaller distance the layout itself left there, and a group never gets narrower than its
    title needs. A box that was moved nearer to an edge holds that edge; it is not pushed. The
    layout is tight, so shrinking mostly takes back what was grown.
  - **What has no handles.** Leaves, closed groups, row bands and the Unassigned area are not
    resized, and with the positions locked no group has handles: it keeps the size set by hand.
    A closed group is drawn in the box of the open one, resized if that was; drawn shrunk, its
    small box sits in the middle of that box. (With **Close up the gaps** on, closing a group
    gives another arrangement, which has sizes of its own.)
  - **Undoing.** Double-click any handle of a group, or press **Delete** or **Backspace** on
    its grip, to give that group back the size the layout made — as far as what is inside it
    and around it allows: an edge that was moved outward stops at a box moved into the room
    that was gained, and an edge that was moved inward stops at the parent's border when the
    group was moved there since. **Reset positions** puts back every box moved and every group
    resized in the arrangement on screen.
  - **Keyboard.** The grip in the bottom-right corner of an open group is a button named
    "Resize _name_"; **Tab** reaches it. The arrow keys move the right and the bottom edge by
    8 px the way the arrow points; with **Shift** they move the left and the top edge instead.
    **Delete** or **Backspace** gives back the size the layout made. The grip of a resized
    group is drawn in the accent colour. Boxes cannot be moved with the keyboard.
  - **What is kept, and where.** Positions and sizes set by hand are remembered in the browser
    for the arrangement they were made in: rows on or off, each story mode, each map filtered to
    a focus and each arrangement closed up by **Close up the gaps** have their own. The
    **Layout** tab counts those of the arrangement on screen ("2 moved · 1 resized"). Saved
    views and copied links carry neither positions nor sizes, and after a change to the
    structure file the map starts from the arrangement the layout computes.
  - **When the map is small.** The title bar is 40 px of the canvas high — 16 px on the screen
    at 40%, 8 px at 20% — and the handles, about 8 px thick on the screen at 100%, stay near
    that down to a zoom of about a third and shrink with the map below it. In Auto, with the
    default thresholds, every group is closed below 40% and is picked up anywhere. At a pinned
    level the groups stay open at any zoom, and below about 25% an open group can hardly be
    picked up or resized: zoom in, or close the group to move it.
  - **Beyond the map.** A group grown to the right or downward makes the map larger, and the
    minimap shows it. What is grown, or moved, left of or above the top-left corner of the map
    is not on the minimap; **Fit view** shows it.
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
  below 38% / 95% / 152%), so it does not flicker at a boundary. Changing level never moves
  anything: boxes keep the position and size of the one layout, and the row bands and the
  Unassigned area are always shown. (With **Layout → Close up the gaps** a change of level does
  move boxes, as described above.) A group **collapsed by hand stays collapsed** at every zoom.
  A group closed only by the level of detail has a disabled chevron — zoom in to open it. At
  the `domains` level the domain and row titles are drawn larger so they stay readable. The
  thresholds are the `LOD_CONFIG` object in `src/core/lod.ts`.

  A view that starts fitted — on load when no viewport is remembered, and a map that has just
  been filtered to a focus — is judged by the plain thresholds of the table. **Fit view** on the
  rail glides to the fitted view, and the level follows the zoom on the way as with any other
  zoom: a fit that ends within 5% of a threshold keeps the level it came from. Pressed at the
  Everything level, the fit takes the zoom out of that level: the map is laid out again without
  the work-item lists and fitted once more, so that one press gives the fitted view.

  With **Layout → Close up the gaps** on, the map that is fitted is the one drawn at the level
  the fit ends on, closed up. In Auto that level depends on the zoom of the fit, so the fit is
  worked out for each level, and of the fits whose zoom draws that very level — by the plain
  thresholds of the table, whatever level the view comes from — the one zoomed in furthest is
  taken: the map is closed up for that level and the view then goes there. The level does not
  change after the fit, the fit is the same wherever it is pressed, and pressing **Fit view**
  again leaves the view as it is; where no level qualifies (thresholds moved to the edge of the
  zoom range), the map on screen is fitted as with the option off. A map fitted when it is
  drawn (on load, or filtered to a focus) is fitted the same way. With a pinned level the
  closed-up map of that level is fitted. The measurements below are with the option off.

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

- **Minimap** (bottom right): always the whole map, at a scale that the size of the map alone
  gives it — never the view —, with the part the canvas shows as a rectangle. When the view is
  panned partly or wholly off the map, the rectangle is cut off at the edge of the minimap; the
  minimap itself does not shrink. Press anywhere in it to put that point in the middle of the
  canvas, keep the button down and drag to move the view along with the pointer; the mouse
  wheel over it zooms the canvas about its middle. With **Layout → Close up the gaps** it shows
  the map as it is drawn, closed up, and takes a new scale when the map closes up or opens out.

- **Work items** are listed inside the boxes at the `detail` level and counted in a badge
  elsewhere — see [Work items on the map](#work-items-on-the-map).

- The layout is computed once per loaded file (and again when the story mode, the work-item
  filter or the work items change, and for a map filtered to a focus) and is never computed
  again on pan, zoom or collapse; with **Layout → Close up the gaps** on, the boxes of that one
  layout close up instead. Boxes can be dragged, and open groups resized, only after
  **Layout → Unlock positions**.
  **Fit view** on the rail of the control panel shows the whole map; a small map is not
  magnified beyond 125%. The fit button among the zoom controls at the bottom left fits the map
  the same way.

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
| Colour the boxes                        | **Lenses → Colour by**: a preset, a label, owner, status, tech or a metric, with a legend  |
| Calm the overview                       | **Visibility → Edges on demand**                                                           |
| Keep or share an arrangement            | **Views** tab: save under a name, apply, delete, **Copy link**                             |
| Lay out without the row bands           | **Layout → Arrange in rows**                                                               |
| Close up the room of closed groups      | **Layout → Close up the gaps**                                                             |
| Move and resize boxes by hand           | **Layout → Unlock positions**, drag a box or a group's edge; **Reset positions** undoes it |
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

| Tab            | Holds                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detail**     | The level of detail; **Groups**: Collapse all, Expand all, Shrink collapsed groups (on while Close up the gaps is); **Work items on the map**: the story mode; **Auto: zoom thresholds** |
| **Visibility** | **Focus**: the chooser and the Focus / Filter switch; **Edges**: the four kind buttons, Edges on demand; **Work items shown**: the states and the iteration                              |
| **Lenses**     | Colour by, Heat by work, Progress bars                                                                                                                                                   |
| **Layout**     | **Rows**: Arrange in rows; **Closed groups**: Close up the gaps; **Positions**: Unlock / Lock positions (to move boxes and resize open groups), Reset positions                          |
| **Views**      | The saved views: save under a name, apply, delete; Copy link, of the current arrangement or of a saved view                                                                              |
| **Files**      | **Structure** and **Work items**: what each file holds, with Open YAML… and Open work items…; **Recent maps**                                                                            |

The **Detail** tab is headed "Level of detail" in the body, so that it is not taken for the
detail panel at the right. A control is offered when it has something to act on: the story
mode, **Work items shown**, Heat by work and Progress bars when work items are loaded, the
focus chooser when the structure has flows or work items are loaded, Colour by when the
structure has presets, labels, attributes or metrics, **Recent maps** when there are any. A
tab whose controls need a map says "Nothing is drawn yet." until one is drawn. While no
structure is loaded (the start page, a file with errors) only **Files** can be chosen; the tab
chosen before comes back with the map.

The tabs say on the rail what is behind them: **Detail** the level being drawn, **Visibility**
a dot while something is hidden, paled or filtered (an edge kind hidden, a focus set, Edges on
demand holding edges back, work items hidden by the work-item filter), **Views** the number of
saved views. The tooltips say it in full ("Level of
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
- **Not on any tab**, so there whichever tab is shown: above the canvas a file error, the
  notice of a view whose colouring the file does not have, and the focus bar; on the canvas
  the legends (top left), the zoom controls (bottom left) and the minimap (bottom right); the
  detail panel at the right and the Diagnostics panel below the map.

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
- **Heat by work** (**Lenses** tab): a strip up both sides of a box, coloured from the bottom
  up like a bar of iron being heated — ember, red, yellow, white at the tip of the hottest.
  Hidden items are no work (the work-item filter counts).
  - **What a box counts.** The open work that no box drawn inside it shows: a leaf its own
    items, a closed group everything inside it, an open group only the items tagged to the
    group itself. Each item counts on the nearest box that is drawn for every node it is tagged
    to — the node itself, or the closest group around it that is drawn — so opening a group
    hands its work down to the boxes that appear, and closing it takes the work back. A box
    left without open work has no strip.
  - **How tall.** The count of the box against the hottest box of the same level counted with
    everything inside it, drawn or not, on the whole map. The scale does not depend on what is
    open: opening or closing a group changes the strip of that group and of the boxes that
    appear or disappear, never the height of another strip. The strip of an open group is
    therefore short, or absent — its work is on the boxes inside it. To read how hot a whole
    group is, close it, or select it: the detail panel states the total.
  - **Adding up.** The open items over all strips are the same at every level of detail, with
    one exception: an item tagged to two nodes of one group counts on each of them while both
    are drawn, and once on the closed group around them. An item tagged to several nodes counts
    once on every box it lands on.
  - **Tooltip.** "3 open work items in here"; on a box that holds more than it shows, "2 open
    work items here that no box inside shows (14 in here in all)".
- **Progress bars** (**Lenses** tab): the bottom edge of a box as a bar of completed over all
  items, for the iteration chosen under **Work items shown** (a parent path covers its sprints)
  or in total. The state filter does not affect them. A box counts what its heat strip counts —
  the items that no box drawn inside it shows — and a box left without items has no bar. The
  tooltip reads "3 of 8 done (38%)", and on a box that holds more than it shows "1 of 3 done
  (33%) of what no box inside shows (5 of 12 in here in all)".
- **Work in the detail panel**: with either of the two lenses on, the panel of a node states
  the totals of the node with everything inside it, drawn or not — the open items and the
  completed over all — in the field **Work** (for a group: **Work, with everything inside**).
  When the box on the map shows less, a line below says what it shows: "On the map: 2 open
  items · 1 of 3 done on this box; the rest is on the boxes drawn inside it", naming only the
  lenses that are on, or "On the map: all of it is on the boxes drawn inside it" when the box
  has neither a strip nor a bar.
- **Colour by** (**Lenses** tab): the boxes tinted by a preset of the file, by a label, by
  `owner`, `status` or `tech`, or by a metric (light = smallest, dark = largest).
  - _The list_ is grouped: **Presets** (the `presets` of the file by name, in file order),
    **Labels** (Owner, Status and Tech, each when some node has one, then the labels of the
    file in the order of first use) and **Metrics**. A group with nothing in it is left out;
    **Nothing** switches the colours off. While a preset with a description is chosen, the
    description stands under the list.
  - _The colours._ A label, like an attribute, holds for everything inside the box that
    carries it. Taken as it is, it gets one colour of the palette per value, in the order the
    values first appear in the file, and from the ninth value on the grey "Other". A preset
    gives the values it lists the colours the file names — a palette name, a hex colour, or a
    pair of hex colours for the light and the dark scheme — and the other values the next free
    colours of the palette. A box without a value is not tinted.
  - _The legend_ sits at the top left of the canvas, below the edge legend. It is headed by
    the name of what is chosen; under the name of a preset stands "by _label_", and the
    description of the preset is the tooltip of the title. Then each value with its colour and
    the number of boxes that have it: the values a preset lists first, in its order, then the
    others in the order of the file, "Other" (its tooltip names the values behind it, the first
    twenty) and "No value" with the number of boxes that have none. The numbers count the whole
    structure, whatever is drawn; a long legend scrolls. The legend of a metric is its scale
    with the two ends.
  - _The node panel_ shows the attributes and then every label that holds for the node (saying
    where an inherited one comes from), the metrics and the links.
- **Edges on demand** (**Visibility** tab): at every level of detail the edges are hidden
  except at the box under the pointer, at the selected box (or the boxes that list the selected
  work item), the selected edge, and those of the focus. A box is what is drawn of it: a leaf
  or a closed group itself, an open group its frame and everything inside it — so the frame of
  an open group shows the edges at all it contains, and a box inside it only its own. The edges
  stay while the pointer moves from the box onto one of them, so it can be followed and
  clicked; an edge that is hidden cannot be pointed at or clicked. The pointer is not needed: a
  box gone to from the search or from a link in a panel is selected, and shows its edges.
  While the positions are unlocked (**Layout** tab), the inside of an open group is canvas and
  not part of its frame: the group shows its edges while the pointer is on its title bar, a
  heat strip, the progress bar, the badge or a resize handle.
- **Views** (**Views** tab): the current arrangement — collapsed groups, hidden edge kinds,
  level of detail, focus (and that the map is filtered to it, when it is), colouring, story
  mode, whether the map is closed up (**Layout → Close up the gaps**) and the point in the
  middle of the view with the zoom — saved under a name, per structure, in the browser; applied
  or deleted from the list. **Copy link** puts `viewer.html#view=…` on the clipboard and in the
  address bar: the link carries the view itself and is applied when the page opens with it. The
  tab shows the number of saved views on the rail. Applying a view switches **Close up the
  gaps** on or off as it was when the view was saved, and puts the same point in the middle; a
  view saved before the option existed is one of the full map and switches it off. A link
  copied with the map closed up needs a viewer that has the option: an older one (0.2.0 or
  before) shows the full map, with the view at the wrong place.
- **A view and its colouring.** A saved view and a link remember the colouring by name: a
  preset by its `name`, a label or a metric by its own. When the file that is loaded has
  nothing of that name — the preset was renamed or removed, its label is on no node any more —
  the view is applied in every other respect, the boxes are not coloured, and a notice above
  the canvas says so: "This view is coloured by preset "Risk", which this file does not have:
  the boxes are not coloured." The notice goes when a colouring is chosen under **Lenses →
  Colour by**, when another view is applied and when a file is opened or read again; a link in
  the address bar is applied again with every reload, and says so again. The saved view is not
  changed: once the file has the preset again, it colours again. A link carries the name of a
  preset, never its colours, and needs a viewer that has presets and labels to be coloured: an
  older one (0.2.0 or before) shows the view uncoloured.
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
  when no kept node has a row there are no bands. **Layout → Arrange in rows** and **Layout →
  Close up the gaps** apply as on the whole map: closed up, it is the filtered map that closes
  up around its closed groups.
- **The view.** A filtered map arrives fitted: when the switch is set to Filter with a focus
  chosen, and when a focus, or another one, is chosen while it stands on Filter. Choosing a
  flow then does not move the view first. A flow that cannot be filtered (see the next point)
  is brought on screen on the whole map as in Focus mode — when a filtered map is on screen,
  once the whole map is back. Leaving the filtered map — the switch back to Focus,
  **Clear focus**, or going to something that is left out — brings the whole map back in the
  view it had before, at the same zoom; if the whole map was laid out anew in between (another
  story mode, for example), or comes back closed up differently, the place that was in the
  middle is in the middle again. Where
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
- **Positions and sizes set by hand.** Each filtered map has positions and group sizes of its
  own (**Layout → Unlock positions**): they are kept in the browser and come back with that
  map, the whole map keeps its own, and **Reset positions** undoes those of the map on screen.
  With **Close up the gaps**, each closed-up arrangement of a filtered map has its own too. A
  group whose children are all left out is drawn as a box without children: it is picked up
  anywhere and has no resize handles.
- **Work items and lenses.** A box lists the same work items as on the whole map, the badge of
  a closed group counts everything inside it, and the colours are unchanged. Heat and progress
  count what no box drawn inside shows, so on a filtered map an open group also counts the work
  of the nodes inside it that Filter leaves out; a group whose children are all left out is
  drawn as a box without children and counts everything inside it. The work of a domain that is
  left out entirely is counted nowhere. The badge of an open group still counts its own items
  only, so it can show fewer than the strip stands for. Heat is measured against the hottest
  box of its level on the whole map, counted with everything inside it, as without Filter.
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
  filtered to a focus. It is kept together with what it was taken on (the arrangement drawn, the
  size of the canvas and the boxes around its middle): a pinned level is not remembered, so the
  next load is in Auto and may draw the map otherwise — at another level with **Close up the
  gaps** on, or without the work-item lists — and the view then shows the same place, the box
  that was in the middle of the canvas in the middle again at the same zoom, instead of the
  same numbers,
- which edge kinds are hidden.

Per structure as well: the saved views. Per arrangement: the positions moved by hand and the
sizes of groups set by hand (each layout, and each arrangement of it closed up by "Close up the
gaps", has its own). They stay in this browser: saved views and links carry neither. Once for
the viewer (not per structure): the display settings — the thresholds, "Shrink collapsed
groups", "Arrange in rows", "Close up the gaps", the story mode, the work-item filter, the
lenses (heat, progress, edges on demand, colour by) and the Focus / Filter switch — and the
control panel: the tab shown and whether its body is hidden.

In IndexedDB, once for the viewer: the recent maps — references to the files of the last 8 maps
opened from disk (Edge and Chrome), not their content.

The selection and the focus are not remembered. If `localStorage` is unavailable or blocked,
the viewer works the same and simply starts fresh every time. Note that a page opened from
`file://` has its own storage per browser, shared by all `file://` pages.
