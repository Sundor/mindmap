# Changelog

All notable changes to this project are documented here, newest first. The project follows
Semantic Versioning (README.md, "Versioning"): every release has a section
`## <version> — <date>`. A change that asks something of a user of the viewer is marked
**Changed behaviour**.

## Unreleased

- **Changed behaviour — Edges on demand holds at every level of detail.** It used to hide the
  edges only at the Domains and Components levels and show every edge at the finer ones; now
  the Subcomponents and Everything levels hide them too, with the same exceptions: the edges at
  the box under the pointer or selected, the selected edge, and those of the focus (a map
  filtered to its focus still shows all its edges). The frame of an open group shows the edges
  at the group and at everything drawn inside it; a box inside the group shows its own. The
  edges of a box now stay while the pointer moves onto one of them, so it can be clicked, and a
  click no longer picks a hidden edge that runs close to the one shown.
- **Layout → Close up the gaps** (off by default). When groups are closed — by hand, by
  Collapse all, by a pinned level or in Auto by the zoom — the boxes that are drawn move closer
  together, and apart again when the groups open: a closed group is drawn shrunk and takes only
  the room of its small box, an open group shrinks to what it shows, and with rows the bands
  close up too. Among the boxes of one group, and among the domains, every box keeps its side
  of the others — left or right, above or below — and the map never becomes wider or taller
  than the full one; it is not laid out again, so it happens at once and the same groups closed
  at the same level always give the same map. A group opened or closed with its chevron, or by
  a double-click, stays where it is on the screen; for any other change the box in the middle
  of the canvas stays where it is. While the option is on, closed groups are always drawn
  shrunk (**Shrink collapsed groups** shows checked and disabled), and in Auto the level follows
  the zoom once the view has come to rest rather than in the middle of a zoom — until then the
  level to come has a dashed outline on the **Detail** tab and on the rail. **Fit view**
  fits the map as it is closed up at the level the fit ends on. Hand-moved positions are kept
  per closed-up arrangement. The option is remembered with the other settings, and saved views
  and links remember whether the map was closed up; a view saved before switches it off. A link
  copied with the map closed up needs this version: an older viewer shows the full map, with the
  view at the wrong place.
- **A view at the Everything level comes back where it was.** A reload, a saved view and a
  link that were taken at the Everything level showed another part of the map the first time
  (the map is laid out again there, with the work-item lists); they now show the place they
  were taken at. The remembered viewport is kept with what it was taken on, so a reload also
  shows the same place when it draws the map otherwise: a pinned level is not remembered, and
  with **Close up the gaps** on the level of the zoom is another arrangement.
- **Fit view pressed at the Everything level** gives the fitted view at the first press; it
  used to stop short of it, and a second press was needed.
- **The fit button among the zoom controls** at the bottom left of the canvas now fits the map
  as **Fit view** on the rail does — clear of the open body of the control panel and of the
  minimap, and not beyond 125% — instead of into the whole canvas.
- **Open groups can be resized by hand.** With **Layout → Unlock positions**, every group that
  is drawn open has a handle on each edge and each corner, and a grip in its bottom-right
  corner. Dragging a handle moves that edge and nothing else: the boxes inside stay where they
  are on the canvas, and the neighbours and the row bands do not move. A nested group grows up
  to the border of its parent and stays below the parent's title bar; an edge moved inward
  stops 16 px from the boxes inside. The grip is a button: the arrow keys move the right and
  the bottom edge by 8 px, with **Shift** the left and the top edge. Double-click a handle, or
  press **Delete** on the grip, to give one group back the size the layout made; **Reset
  positions** now puts back every box moved and every group resized in the arrangement on
  screen. Sizes are remembered in the browser per arrangement, as moved positions are, and like
  them are not part of saved views or links. Leaves, closed groups and row bands are not
  resized; a closed group keeps the box of the open one.
- **Changed behaviour — an open group is moved by its title bar.** While the positions are
  unlocked, a group drawn open is picked up by its title bar only — six dots at its right end
  mark it — and a drag anywhere else inside it pans the map, where it used to move the group.
  The inside of an open group is canvas in the other ways too: a double-click collapses the
  group at its title bar, not inside it, and **Edges on demand** shows the edges of the group
  while the pointer is on its title bar, not inside it. A click inside still selects the group.
  Closed groups and leaves are picked up anywhere, as before, and with the positions locked
  nothing has changed. What picks a box up shows the move cursor instead of the hand, which is
  left to panning.
- **Changed behaviour — heat and progress count only what is not drawn.** The heat strip and
  the progress bar of a box count the work that no box drawn inside it shows: a closed group
  everything inside it, as before, an open group only the items tagged to the group itself (on
  a filtered map also those of the nodes inside it that Filter leaves out), where it used to
  count everything inside it once more. The strips and bars of open groups are therefore
  shorter than before, and gone where nothing is left; the same work is no longer counted again
  on every group around it. The scale of the heat is unchanged — the hottest box of the level,
  counted with everything inside it — so no other strip changes when a group opens or closes.
  The tooltips say when a box holds more than it shows, and the detail panel still states the
  totals of a node with everything inside it, and adds what the box on the map shows.
- **Labels.** A node of the structure file can carry `labels`: name → value pairs under names
  of your own (`zone: public`, `tier: 1`), on a domain, a component or a subcomponent, and
  inherited by everything inside like `owner`, `status` and `tech`. A number or true/false is
  kept as written (`release: 1.10` is "1.10"). Every label is an entry under **Lenses → Colour
  by**, and the detail panel of a node lists the labels that hold for it and says where an
  inherited one comes from. A file without labels loads as before, and `version` stays `1`.
- **Colour presets.** A top-level `presets:` list of the structure file names colourings: each
  has a `name`, the `label` it colours by (a label, or `owner`, `status` or `tech`), and
  optionally a `description` and `values` — a colour for a value, written as one of nine names
  (`blue`, `orange`, `teal`, `yellow`, `pink`, `green`, `purple`, `red`, `grey`), as a hex
  colour in quotes, or as a pair of hex colours for the light and the dark scheme. The presets
  stand first under **Colour by**, and the legend lists the values in the order of the preset.
  A value the file gives no colour takes the next free colour of the palette. A mistake in a
  colour is a warning and does not stop the map; a preset on a label that no node has is left
  out, with a warning.
- **Changed behaviour — `labels` on a node and `presets` at the top level are keys of the
  format.** A structure file that already had one of them for something of its own was told
  "Unknown key … (ignored)" and is now read: `labels` has to be a mapping of name → value and
  `presets` a list of presets, or the file has errors and no map is drawn. Give such a key
  another name.
- **The list under Colour by is grouped** into Presets, Labels (Owner, Status and Tech, then
  the labels of the file) and Metrics; a group with nothing in it is left out.
- **The legend of Colour by** shows beside each value how many boxes have it, names in the
  tooltip of "Other" the values that share it, and ends with "No value" and the number of boxes
  that have none — for owner, status and tech too. The numbers count the whole structure,
  whatever is drawn. A long legend scrolls. The summary text of a closed group that is tinted
  is darker than before, so that it reads on the tint.
- **A saved view or a link whose colouring the file does not have** — a preset that was renamed
  or removed, a label or a metric that no node has any more — is applied uncoloured and says so
  in a notice above the map: "This view is coloured by preset "Risk", which this file does not
  have: the boxes are not coloured." Before, it was applied uncoloured without a word. A link
  coloured by a preset or a label needs this version: an older viewer shows the view
  uncoloured.
- **Template files.** The viewer folder has a folder `template/` with an `architecture.yaml`
  and a `workitems.json`: two short files in which every key the viewer reads occurs once, with
  what it does — the files to copy and start a map from. The guide shows them as its two
  complete files, and the **Files** tab and the start page of the viewer say where they are.
- The error for a list where `metrics` expects a mapping reads "must be a mapping (key: value
  pairs), but got a list"; it read "must be record".
- **Fixed — the legend of Colour by on the dark colour scheme.** Its chips, and the scale of a
  metric, showed the colours of the light scheme while the boxes had the dark ones; legend and
  boxes now show the same colour.
- **Export.** **Files → Export** saves the map as a file: **PNG**, a picture; **SVG**, a vector
  drawing of shapes and text, sharp at any size; **HTML**, a web page that needs nothing else,
  with the picture, its boxes as a nested list and its edges as a table. A file holds the map
  as it is drawn at the click, not the window — level of detail, closed and shrunk groups,
  moved positions, a focus or a filtered map, the selection, the edge kinds and edges that are
  shown, work items and lenses — and none of the panels, the minimap or the zoom controls.
  Four choices, remembered in the browser once for the viewer: **Area** (Whole map, or What is
  on screen), **Colours** (As on screen, Light, Dark), **PNG size** (1×, 2×, 3×) and **Title
  and legend**, which puts the name of the structure file, a note of what is shown and a key
  into the picture. The file is named after the structure file (`architecture-map.png`,
  `.svg`, `.html`) and goes where the browser puts its downloads. A PNG is at most 16 384 px a
  side and 64 million pixels: a larger picture is saved reduced, and the tab says to what; SVG
  and HTML have no limit. Nothing is sent anywhere, the Content Security Policy of the viewer
  is unchanged, and an exported page runs no script and loads nothing.
- **Design pages.** `npm run design` writes `design-template/kit.html` and `screens.html`: the
  viewer's interface as static pages around its real stylesheet — every control, panel, box and
  notice in its states, light and dark, and the whole app in a few situations — for restyling in
  a design tool. `npm run design:extract <page>` says what a restyled page changed in the
  stylesheet and can write it back. The pages are not part of the viewer.

## 0.2.0 — 2026-10-08

- **Changed behaviour — the controls are in a panel at the left.** The toolbar at the top and
  its Settings drop-down are gone. A rail at the left edge is always there, with **Search**,
  six tabs, **Reload**, **Fit view** and **Hide** / **Show**; beside it, the body of the panel
  shows the name and version of the viewer, the names of the files in use, the search box and
  the tab that is chosen. Where the controls went:
  - **Detail**: the level of detail, Collapse all and Expand all, Shrink collapsed groups, the
    zoom thresholds, and what was the **Stories** selector, now **Work items on the map**.
  - **Visibility**: the focus chooser, the four edge-kind buttons, Edges on demand, Work items
    shown.
  - **Lenses**: Colour by, Heat by work, Progress bars.
  - **Layout**: Arrange in rows, Unlock / Lock positions, Reset positions.
  - **Views**: the saved views and Copy link.
  - **Files**: Open YAML…, Open work items…, the recent maps, and the size of the structure,
    the number of work items and the tag coverage.
- **The body of the panel can be hidden** — **Hide**, or a click on the tab that is shown —
  which leaves the rail and gives the map the room; the tabs still show the level being drawn,
  a dot while something is hidden, paled or filtered, and the number of saved views. With the
  body hidden, **/**, **Ctrl+K** and **Search** show the search box alone beside the rail. In a
  window at least 1400 px wide the open body stands beside the map. In a narrower one it is
  hidden until you show it; opened, it lies over the left of the map until it is hidden again,
  **Fit view** fits the map into the part beside it, and the notices above the map, the legends,
  the zoom controls and the Diagnostics panel begin where it ends.
- **Edge legend.** A key to the four edge kinds sits at the top left of the canvas, above the
  colour legend, whatever the control panel shows; a hidden kind is struck through. The kind
  buttons themselves are on the **Visibility** tab.
- **Focus / Filter.** A switch under the focus chooser, and again in the focus bar above the
  canvas, says how a focus is shown. **Focus** pales the rest of the map, as before. **Filter**
  does not draw it: the map is reduced to what the focus involves — the nodes, the groups
  around them, what lies inside them and the edges of the focus — laid out again with every
  node in its row, and fitted. Leaving Filter brings the whole map back in the view it had.
  The search and the detail panel still cover the whole structure and mark what the filtered
  map does not have; going to it switches back to Focus, and the focus bar says so. Level of
  detail, collapsed groups and hidden edge kinds apply to the filtered map as to the whole
  one, and a filtered map has hand-moved positions of its own. In both modes, what is selected
  is no longer paled when the focus does not involve it.
- **Fit view** ends at another zoom than before, because the control panel takes width from
  the canvas where the toolbar took height: with the shipped example at 1920×1080, at 61% with
  the body open and 72% with it hidden (about 75% before); at 1366×768, where the body starts
  hidden, at 50% (about 53% before). A fit — **Fit view**, and a map fitted when it is drawn —
  no longer puts a box under the minimap: where it would, the map ends beside the minimap or
  above it.
- **Saved views and links** keep that a view was saved on a map filtered to its focus, and
  show that filtered map again. Views and links saved before open as they did. A link copied
  on a filtered map needs this version: an older viewer shows its focus paled, with the view
  at the wrong place.
- **Remembered in the browser**, once for the viewer: the tab shown and whether the body of the
  control panel is hidden, and the Focus / Filter switch. The focus is still not remembered,
  and the remembered viewport is that of the whole map: it does not change while a filtered
  map is shown.

## 0.1.1 — 2026-10-06

- **Two downloads per release.** The viewer is its own download,
  `architecture-map-<version>-viewer.zip`: the built folder with the viewer, the example data
  files, the guide and the licence notices. The build kit, now named
  `architecture-map-<version>-build-kit-win-x64.zip`, no longer contains the viewer; its
  installer still builds the viewer and reports whether the result is identical to the
  released one.

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
