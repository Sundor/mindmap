# Changelog

All notable changes to this project are documented here, newest first. The project follows
Semantic Versioning (README.md, "Versioning"): every release has a section
`## <version> — <date>`. A change that asks something of a user of the viewer is marked
**Changed behaviour**.

## 0.1.0 — 2026-10-05

The first release.

### The map

- **Structure** from `architecture.yaml`: domains, components and subcomponents as nested,
  collapsible groups; typed edges (`dataflow`, `dependency`, `control`, `config`), each kind
  with its own line; optional rows — horizontal bands that nodes sit in and groups may span;
  flows — workflows and data flows as ordered sets of edges and nodes; the node attributes
  `owner`, `status`, `tech` (inherited down the tree), `links` and `metrics`.
- **Layout** is computed once, for the fully expanded map, and is stable: zooming and
  collapsing move nothing. Edges whose ends are hidden roll up onto the nearest visible group,
  and parallel edges merge into one line with a count. Positions can be unlocked and moved by
  hand; rows can be switched off; collapsed groups can be drawn shrunk.
- **Levels of detail:** Auto, which follows the zoom, or pinned to Domains, Components,
  Subcomponents or Everything. The zoom thresholds are adjustable.
- **Finding one's way:** pan, zoom, minimap, fit view; search by name or ID; selection with its
  neighbourhood lit and a detail panel; a filter per edge kind.
- **Lenses:** focus on a flow or a work item; heat by open work; progress bars; colour by an
  attribute or a metric, with a legend; edges on demand at the coarse levels.
- **Views:** arrangements saved under a name per structure, and links that carry one
  (`viewer.html#view=…`).

### Work items

- From `workitems.json`: user stories, tasks, bugs, features and epics, linked to the nodes by
  `comp:<node-id>` tags.
- On the canvas: the items of a node listed in it at the Everything level, tasks under their
  stories, and badges with counts on closed groups. In the panel: an item with its fields, its
  nodes, its parent and its tasks.
- Filters by state and by iteration; completed items can be hidden.
- Diagnostics of the tags: unknown ones, untagged items, and the tag coverage.

### Files and loading

- The viewer reads data files only, YAML and JSON. Served by a web server it fetches
  `architecture.yaml` and `workitems.json` next to it, or the files named by `?data=` and
  `?workitems=` on the same server. Opened from disk, the files are opened with the file dialog
  or dropped on the page.
- **Recent maps** (Edge and Chrome): the last 8 maps opened from disk are remembered as the
  browser's references to their files and opened again with one click, read fresh from the
  disk. **Reload** reads the files of the shown map again.
- **Validation:** every problem of both files with file, line, column and path, in a
  Diagnostics panel; hints for the author of the structure file.
- Remembered in the browser, per structure: collapsed groups, the viewport, hidden edge kinds,
  positions moved by hand and the saved views; once for the viewer: the display settings.

### Offline and security

- The built viewer is one HTML file with everything in it. It loads nothing from the internet.
- A Content Security Policy lets only the viewer's own code run, recognised by its SHA-256
  hash, and allows requests to the page's own server only. No script file is loaded, no code is
  made from strings, and no referrer is sent.
- The licences of the bundled libraries are in `THIRD-PARTY-NOTICES.txt` and at the end of
  `viewer.html`. The build fails for a licence that is not on its accepted list.

### Build and delivery

- `npm run build` makes the `dist/` folder: the viewer, the example data, the guide to the
  viewer and its file formats, and the notices.
- `npm run installer` makes a build kit for Windows on 64-bit Intel/AMD: a zip with Node.js,
  the source, the npm packages, the built viewer and an installer, with which the viewer can be
  built without internet access and without administrator rights.
- The viewer shows its version in the toolbar, and the built page names it.
