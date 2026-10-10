# Architecture Map — viewer folder

This folder is a complete, self-contained architecture map. `viewer.html` is the whole
application in one file; it draws the map described by two data files that you write:

- **`architecture.yaml`** — the structure: domains → components → subcomponents, and the typed
  connections (edges) between them.
- **`workitems.json`** — optional: the work items (epics, features, user stories, bugs, tasks,
  typically exported from Azure DevOps) that are shown on the parts of the structure they affect.

Nothing here needs a server, a build step or the source repository. This document tells you how
to use the viewer and — in full — how to author both data files, so that a person or an AI agent
can produce a map for any project from its repository and its Azure DevOps project.

**Contents:** [Files](#files-in-this-folder) · [Quick start](#quick-start-a-map-for-your-own-project) ·
[architecture.yaml](#architectureyaml--the-structure) ·
[From a repository](#deriving-the-structure-from-a-repository) ·
[workitems.json](#workitemsjson--the-work-items) ·
[From Azure DevOps](#getting-the-work-items-from-azure-devops) ·
[Opening the files](#opening-the-data-files) ·
[Checking](#checking-the-result) · [Using the viewer](#using-the-viewer) ·
[Troubleshooting](#troubleshooting)

## Files in this folder

| File                         | What it is                                                                                   | You edit it? |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------ |
| `viewer.html`                | The viewer (all code and styles inlined). Works offline and from `file://`                   | No           |
| `architecture.yaml`          | The structure. **As delivered: an example** (an online shop)                                 | **Yes**      |
| `workitems.json`             | The work items. **As delivered: dummy data** for the example                                 | **Yes**      |
| `template/architecture.yaml` | A short structure file with every key once and what it does: the file to copy and start from | Copy it      |
| `template/workitems.json`    | The matching work items: one of each type                                                    | Copy it      |
| `THIRD-PARTY-NOTICES.txt`    | The licences of the open-source software inside `viewer.html`                                | No           |
| `README.md`                  | This document                                                                                | No           |

The viewer reads the two data files as they are: YAML and JSON, which it shows and never runs.
Nothing is generated from them and nothing has to be rebuilt after an edit. How the files get
into the viewer depends on how it is opened — see
[Opening the data files](#opening-the-data-files).

## Quick start: a map for your own project

1. **Write `architecture.yaml`** for the project: copy `template/architecture.yaml` over the
   example file in this folder and rewrite it (format:
   [below](#architectureyaml--the-structure); method:
   [Deriving the structure from a repository](#deriving-the-structure-from-a-repository)).
2. **Write `workitems.json`** the same way: copy `template/workitems.json` over the dummy file
   and rewrite it ([format](#workitemsjson--the-work-items),
   [Azure DevOps export](#getting-the-work-items-from-azure-devops)). For a map without work
   items, leave the file out.
3. **Open `viewer.html`** (double-click) and give it the files: click **Open YAML…** and choose
   `architecture.yaml` and `workitems.json` together, or drop both on the page.
4. Look at the **Diagnostics** panel at the bottom: it lists every problem of both files with
   line numbers. Fix the file, click **Reload** (at the foot of the control panel at the left),
   until it is clean. See
   [Checking the result](#checking-the-result).
5. **Next time** the map is one click away: the start page lists it under **Open again** (Edge
   and Chrome).
6. **Share** the folder. Served by a web server, the map opens by itself, in every browser.

Two things to know:

- **A page opened from disk cannot read files by itself.** That is a rule of every browser, and
  the reason the files are opened by hand the first time and offered for one click afterwards.
  Served by a web server, the viewer fetches them without being asked. Both ways are described
  in [Opening the data files](#opening-the-data-files).
- **The delivered data is an example.** Until you replace the two files, they describe an
  online shop with about 60 invented work items. The two files in `template/` are the short
  ones to start from: every key the viewer reads occurs in them once, with what it does. They
  open like any other map — **Open YAML…** with both chosen, or both dropped on the page. The
  start page and the **Files** tab of the viewer say where they are.

## `architecture.yaml` — the structure

A complete, valid file — `template/architecture.yaml` in this folder:

```yaml
# Template: every key the viewer reads, once, with what it does. Copy the file, replace the
# IDs and names with your own, and delete what you do not need. Required are "version" and
# "domains"; "id" and "name" of a row, a node and a flow; "id", "from", "to" and "kind" of an
# edge; "url" of a link; "name" and "label" of a preset. The full reference is README.md.
version: 1 # the format version: always 1

rows: # horizontal bands, top → bottom; without this key the map is laid out by its edges
  - id: front # what a node's "row:" names: one lowercase segment, unique among the rows
    name: Front end # the band's name, in the left gutter and in a box's detail panel
    description: What people use # checked and kept, not displayed: a note for readers of the file
  - id: back
    name: Back end

domains: # the top-level boxes; three levels: domains → components → subcomponents
  - id: shop # the stable key: edges, flows and comp: tags name it; found by the search
    name: Web Shop # the text of the box; found by the search
    description: Everything a customer sees # tooltip of the box, and its detail panel
    row: front # the band of this box and of everything inside it
    owner: Shop team # owner, status and tech hold for everything inside, unless set there;
    status: live # the detail panel lists them and says where each comes from;
    tech: TypeScript # Lenses → Colour by gives each of their values a colour
    labels: # your own name: value pairs; they behave like owner, status and tech
      zone: public
      tier: 1 # a number or true/false is kept as written
    links: # listed in the detail panel; opened in a new tab
      - label: Source # the link's text; without it, the address
        url: https://example.com/shop # must be http(s), or the link is left out
    metrics: # numbers by name: detail panel, and Colour by (light → dark); not inherited
      loc: 12000
    components: # the boxes inside a domain
      - id: shop.catalog # a child's ID: its parent's ID, a dot, one more segment
        name: Catalog
      - id: shop.checkout
        name: Checkout
        labels: { zone: payment } # replaces the domain's value, here and inside
        subcomponents: # the boxes inside a component: the last level
          - id: shop.checkout.basket
            name: Basket
          - id: shop.checkout.payment
            name: Payment

  - id: orders
    name: Orders # no row: the box spans the rows its components are in
    owner: Order team
    status: planned
    labels: { zone: internal }
    components:
      - id: orders.api
        name: Orders API
        row: back
      - id: orders.jobs
        name: Nightly jobs
        row: back
      - id: orders.settings
        name: Settings
        row: front

edges: # the lines; the arrowhead is at "to"
  - id: payment-places-order # unique among the edges; what a flow lists
    from: shop.checkout.payment # a node of any level
    to: orders.api # another node of any level
    kind: dataflow # dataflow | dependency | control | config: the line's style, the kind buttons
    label: place order # text on the line
    protocol: REST # shown after the label: place order [REST]
    description: Sends the basket as an order # hover text of the line, and its detail panel
  - { id: basket-needs-catalog, from: shop.checkout.basket, to: shop.catalog, kind: dependency }
  - { id: jobs-run-api, from: orders.jobs, to: orders.api, kind: control, label: run exports }
  - { id: settings-set-prices, from: orders.settings, to: shop.catalog, kind: config }

flows: # stories told through the edges: Visibility → Focus lights one and pales the rest
  - id: place-order # unique among the flows; what a saved view remembers
    name: Place an order # its entry in the focus list, the title of its panel
    kind: workflow # workflow (the default) or dataflow: its group in the focus list
    description: From the basket to a stored order # shown in its panel
    edges: [payment-places-order, jobs-run-api] # the steps, in order
    nodes: [shop.checkout.basket] # further nodes it involves
  - { id: prices, name: Prices reach the shop, kind: dataflow, edges: [settings-set-prices] }

presets: # named colourings, offered first under Lenses → Colour by
  - name: Zones # unique: its entry in the list, the title of the legend, what a view remembers
    label: zone # the label whose values it colours; owner, status and tech work too
    description: Who may reach it # shown under the list and on the legend's title
    values: # value: colour, in the order of the legend; other values get the next free colour
      public: orange # a palette name: blue orange teal yellow pink green purple red grey
      payment: '#b3261e' # a hex colour, in quotes (an unquoted # starts a comment)
      internal: { light: '#0d6b5e', dark: '#5fd1bf' } # one hex colour for each scheme
      partner: # no colour: the next free one of the palette
  - { name: Teams, label: owner } # no values: every owner gets a colour of the palette
```

It opens in the viewer as it is, together with `template/workitems.json`. The sections below
describe every key.

### Top level

| Key       | Required | Value                                                             |
| --------- | -------- | ----------------------------------------------------------------- |
| `version` | yes      | The number `1`                                                    |
| `domains` | yes      | List of domains (may be empty, but then there is nothing to draw) |
| `rows`    | no       | List of rows (bands), top → bottom                                |
| `edges`   | no       | List of edges                                                     |
| `flows`   | no       | List of flows (see below)                                         |
| `presets` | no       | List of colour presets (see below)                                |

### Nodes: domains, components, subcomponents

There are exactly **three levels**. A domain lists its children under `components`, a component
lists its children under `subcomponents`, a subcomponent has no children. Nothing nests deeper,
and a list under the wrong key (for example `subcomponents` directly in a domain) is an error.

| Key             | Required | Value                                                |
| --------------- | -------- | ---------------------------------------------------- |
| `id`            | yes      | Text; see the ID rules below                         |
| `name`          | yes      | Text, not empty: what the box shows                  |
| `description`   | no       | Text: shown in the detail panel and as a tooltip     |
| `row`           | no       | ID of a row from `rows`                              |
| `owner`         | no       | Text: the team or person responsible                 |
| `status`        | no       | Text: `planned`, `live`, `deprecated`, … (free)      |
| `tech`          | no       | Text: the main technology                            |
| `labels`        | no       | Mapping of name → value (`zone: public`); see Labels |
| `links`         | no       | List of `{ label, url }`; `url` must be `http(s)`    |
| `metrics`       | no       | Mapping of name → number (`loc: 12400`)              |
| `components`    | no       | Domains only: list of components                     |
| `subcomponents` | no       | Components only: list of subcomponents               |

`owner`, `status` and `tech` are **inherited**, and so is every label (see [Labels](#labels)):
a node without one has its nearest ancestor's (the panel says where it comes from). Set them on
a domain and override where a component differs. A key left empty, or given an empty text, is
the same as no entry: it does not clear a value that comes from a group around the node.
**Lenses → Colour by** tints the boxes by any of them (one colour per value, with a legend), by
a colour preset of the file (see [Colour presets](#colour-presets)) or by any metric (light to
dark). Metrics are not inherited. A link that is not an `http(s)` address is left out with a
warning; a metric that is not a number is an error.

**ID rules** (all are checked; a violation is an error):

- An ID is made of **segments** joined by dots. A segment is lowercase letters `a–z` and digits,
  optionally joined by single `-` or `_`: `orders`, `order-api`, `v2_store`. No uppercase, no
  spaces, no leading/trailing or doubled `-`/`_`.
- A **domain** ID is one segment: `orders`.
- A **child** ID is its parent's ID, a dot, and exactly one more segment: component
  `orders.api`, subcomponent `orders.api.validation`.
- Node IDs are **unique in the whole file**.
- IDs are the stable keys of the map: work items point at them (`comp:orders.api`) and the
  viewer remembers collapsed groups by them. Choose names that will survive a refactoring, and
  do not rename them casually.

### Rows

Rows are optional horizontal bands (tiers), for example _UI / Services / Storage_ or
_Engineering / Middle / Hardware_. Without a `rows` section the map is laid out as a plain
graph by its connections.

| Key           | Required | Value                                                           |
| ------------- | -------- | --------------------------------------------------------------- |
| `id`          | yes      | One segment (same rule as a domain ID), unique in rows          |
| `name`        | yes      | Text, not empty: shown in the left gutter                       |
| `description` | no       | Text: kept for readers of the file; the viewer does not show it |

- `row:` may be set on any node; everything inside inherits it. A node inside may repeat the
  same row, but naming a **different** row than an ancestor is an error.
- A group without a row **spans** the rows its children use and places each child in its band.
- A child without a row inside a spanning group is placed in the band most of its connections
  point to (drawn with a dashed border).
- A top-level domain with no row anywhere in it goes to an **Unassigned** area at the right.
- `row:` naming an unknown row, or used in a file without `rows`, is an error.

### Edges

| Key           | Required | Value                                                              |
| ------------- | -------- | ------------------------------------------------------------------ |
| `id`          | yes      | Text, same character rules as a node ID; unique among edges        |
| `from`        | yes      | ID of an existing node (any level)                                 |
| `to`          | yes      | ID of another existing node (any level); the arrowhead points here |
| `kind`        | yes      | `dataflow`, `dependency`, `control` or `config`                    |
| `label`       | no       | Short text on the line (2–4 words)                                 |
| `protocol`    | no       | Free text, shown as `label [protocol]`                             |
| `description` | no       | Text: shown on hover and in the detail panel                       |

| Kind         | Drawn as       | Use it for                                                          |
| ------------ | -------------- | ------------------------------------------------------------------- |
| `dataflow`   | solid blue     | Data moving from `from` to `to`: requests, events, messages, files  |
| `dependency` | dashed grey    | `from` needs `to` to build or run: libraries, shared services, auth |
| `control`    | dotted red     | `from` commands or orchestrates `to`: start/stop, deploy, schedule  |
| `config`     | dash-dot green | `from` supplies settings, parameters or definitions to `to`         |

- Edge IDs, node IDs and row IDs are three separate namespaces.
- `from` and `to` must be different nodes (no self-edges).
- Two edges with the same `from`, `to` and `kind` give a warning; they are drawn as one line.
- Attach an edge at the **most specific level you know**. When a group is collapsed or the view
  is zoomed out, the viewer re-attaches the edge to the group by itself and merges parallel
  ones into a single line with a count (`×3`).
- Do not connect a node to its own ancestor or descendant (`orders` → `orders.api`): such an
  edge has no line to draw once the group is closed and says nothing the nesting does not say.

### Flows

A flow is a story told through the edges: a **workflow** (an order is placed, a release goes
out) or a **data flow** (a page view becomes a chart). It is defined apart from the nodes
and edges, as a set: the viewer's **Focus** lights what a flow involves and pales everything
else — or, switched to **Filter**, draws nothing else — and the panel of a node or an edge
lists the flows it is part of.

| Key           | Required | Value                                                            |
| ------------- | -------- | ---------------------------------------------------------------- |
| `id`          | yes      | Text, same character rules as a node ID; unique among flows      |
| `name`        | yes      | Text, not empty                                                  |
| `kind`        | no       | `workflow` (default) or `dataflow`                               |
| `description` | no       | Text: what the flow is, shown in its panel                       |
| `edges`       | no       | List of edge IDs, **in step order**; an edge may occur twice     |
| `nodes`       | no       | List of node IDs the flow involves besides the ends of its edges |

- A flow involves the nodes it names plus both ends of every edge it names.
- An ID that names no edge or node is an error; a flow with neither is a warning.
- Four to ten steps read well. Give the edges in a flow short labels that read as a sentence
  when followed in order (`place order` → `reserve stock` → `confirm`).

### Errors, warnings and YAML pitfalls

**With any error the viewer draws no map at all**, only the Diagnostics list. Warnings do not
stop it. Unknown keys are warnings and are ignored — check them, they are usually typos
(`subcomponent:` for `subcomponents:`).

Every value listed as "Text" must be a YAML string. Plain YAML turns some unquoted values into
other types, which is then an error ("must be text") — except for the values under `labels` and
the values a preset lists, where a number or true/false is taken as written. Quote when in
doubt:

| Written like this           | YAML reads            | Write instead                |
| --------------------------- | --------------------- | ---------------------------- |
| `id: 404`                   | a number              | `id: '404'`                  |
| `name: true` / `name: null` | a boolean / nothing   | `name: 'true'`               |
| `label: 8080`               | a number              | `label: '8080'`              |
| `description: Reads: fast`  | a syntax error (`: `) | `description: 'Reads: fast'` |
| `label: [async]`            | a list                | `label: '[async]'`           |
| `name: # todo`              | nothing (a comment)   | `name: '# todo'`             |
| `live: #1baf7a` (a colour)  | nothing (a comment)   | `live: '#1baf7a'`            |

Use spaces for indentation (never tabs), one document per file (no `---` separators), UTF-8.
An empty optional key (`edges:` with nothing after it) is treated as absent.

## Deriving the structure from a repository

The map is a **communication tool**, not an inventory: someone should understand the system
from it in a minute. Aim for the size of a whiteboard drawing.

**Target size.** 3–8 domains, 10–40 components, subcomponents only where they explain
something; up to about 150 nodes and 100 edges in total. The layout is computed in the browser:
a map of more than roughly 300 nodes makes the page hang for a noticeable time on every load.

**Procedure.**

1. **Survey the repository.** Read the README and any architecture documents first. Then the
   build and workspace definitions, which name the real units: `*.sln`/`*.csproj`,
   `package.json` workspaces, `pnpm-workspace.yaml`, `go.work`/`go.mod`, `Cargo.toml`,
   `pom.xml`/`settings.gradle`, `CMakeLists.txt`, `pyproject.toml`. Then what is deployed:
   Dockerfiles, compose files, Kubernetes/Helm, Bicep/Terraform, pipeline definitions.
2. **Choose the domains**: the few large areas a newcomer would be told about first — business
   capabilities, bounded contexts or separately deployed systems. Top-level folders are a
   starting point, not the answer; group by purpose, not by technology.
3. **Choose the components** of each domain: one per service, application, library or package
   that has a name the team uses. Use that name. Put the source path in the description
   (`Order intake and validation (src/Services/Orders)`), so the reader can find the code.
4. **Add subcomponents** only for the parts worth pointing at: the main modules of a large
   service, the notable stages of a pipeline. Around 2–8 per component; none is fine.
5. **Find the edges from evidence**, not from guesses:
   - project/package references and imports across components → `dependency`;
   - HTTP/gRPC clients, message topics and queues, database reads and writes, file exchange →
     `dataflow`, pointing the way the data moves, with the `protocol`;
   - schedulers, orchestrators, deployment and command channels → `control`;
   - configuration, parameter and schema providers → `config`.
     Leave out what every part does (logging, the standard library). Prefer one edge with a
     clear label to five that say the same.
6. **Decide on rows** if the system has tiers everyone recognises (UI / services / data,
   cloud / edge / device). Give whole domains a row where they fit in one; give the components
   of a cross-tier domain their own rows. Skip rows when nothing natural offers itself.
7. **Add what makes the map speak.** `owner` per domain (from CODEOWNERS, team folders or the
   README), `status` where something is planned or being retired, `tech` from the build files,
   `links` to the source folder and the docs. For `metrics`, numbers you can compute from the
   repository are the most telling: `loc` (lines of code in the component's folder), `churn`
   (commits touching it in the last 90 days: `git log --since=90.days --oneline -- <path> | wc -l`),
   `contributors`, `coverage` from the test report. Keep the names short and the same on every
   node. Use `labels` for what the three attributes do not cover — a zone, a tier, a lifecycle,
   the group a team belongs to: a few names, set on a domain and replaced where a part differs.
   Add a preset where a colour has to mean the same on every map (`deprecated` always grey,
   for example). Then write 2–4 `flows` for the stories everyone asks about — how a request is
   served, how a release goes out, where the data comes from.
8. **Write the file, generate, open, read the Diagnostics**, and look at the picture: does
   **Fit view** show something a person would recognise? Merge or drop what is noise. The
   Diagnostics panel ends with **hints** (nodes without a description or without any
   connection, domains without work, no flows) — they are suggestions, not errors.

Record facts you are unsure about in the `description` rather than inventing structure, and tell
the person you work for which parts of the map are inferred.

## `workitems.json` — the work items

A complete, valid file — `template/workitems.json` in this folder. JSON has no comments: the
titles and the description of its items say what the viewer does with them.

```json
{
  "version": 1,
  "items": [
    {
      "id": 1,
      "type": "Epic",
      "title": "An epic: id, type, title and state are required",
      "state": "Active",
      "tags": "comp:shop"
    },
    {
      "id": 2,
      "type": "Feature",
      "title": "A feature: parentId names another item of this file",
      "state": "Active",
      "tags": "comp:shop.checkout",
      "parentId": 1
    },
    {
      "id": 3,
      "type": "User Story",
      "title": "A user story with every key",
      "state": "Active",
      "assignedTo": "Robin Patel",
      "iteration": "Shop\\Release 1\\Sprint 1",
      "tags": "comp:shop.checkout.payment; comp:orders.api; payments",
      "parentId": 2,
      "description": "Plain text for the work-item panel. Each comp: tag puts the item on that box; the other tags are listed. The iteration feeds the filter, and Release 1 can be chosen as a whole.",
      "url": "https://example.com/items/3",
      "fields": { "Story Points": 5, "Area": "Checkout" }
    },
    {
      "id": 4,
      "type": "Task",
      "title": "A task: listed under its parent; Closed, Done, Resolved and Removed count as completed",
      "state": "Closed",
      "iteration": "Shop\\Release 1\\Sprint 1",
      "parentId": 3
    },
    {
      "id": 5,
      "type": "Bug",
      "title": "A bug: counted on its box like a story",
      "state": "New",
      "tags": "comp:orders.api"
    }
  ]
}
```

| Key           | Required | Value                                                                         |
| ------------- | -------- | ----------------------------------------------------------------------------- |
| `id`          | yes      | A positive whole **number** (not a string); unique in the file                |
| `type`        | yes      | Exactly `Epic`, `Feature`, `User Story`, `Bug` or `Task`                      |
| `title`       | yes      | Text, not empty                                                               |
| `state`       | yes      | Text, not empty, as the tracker names it (`New`, `Active`, `Closed`, …)       |
| `assignedTo`  | no       | Text: the person's display name                                               |
| `iteration`   | no       | Text: the iteration path; the viewer can filter by it                         |
| `tags`        | no       | **One string**, entries separated by `;` — as Azure DevOps stores them        |
| `parentId`    | no       | The `id` of another item **in this file**                                     |
| `description` | no       | **Plain text** (line breaks are kept; HTML is shown as written, not rendered) |
| `url`         | no       | Link to the item; must start with `http://` or `https://`                     |
| `fields`      | no       | Object of further parameters: each value a **string or a number**             |

Strictness — what happens to an item that breaks a rule:

- A wrong type of value (`"id": "1010"`, `"assignedTo": {…}`, a `fields` value that is `true`,
  `null`, a list or an object), a missing required key or a duplicate `id`: **error, the item is
  skipped**; the others still load.
- A `type` outside the five: **warning, the item is skipped**. Convert other type names first
  (see the Azure DevOps section).
- A key that is not in the table: warning, the key is ignored. Put extra data into `fields`.
- `parentId` naming an item that is not in the file: warning, the parent is ignored. A circle of
  parents: error, those links are ignored.
- A `url` that is not `http(s)`: warning, the item is kept without the link.
- `null` for an optional top-level key is the same as leaving it out. Inside `fields`, leave
  the entry out instead.
- A file that is not valid JSON, has another `version`, or no `items` list gives no items.

### Linking work items to the structure: `comp:` tags

A tag **`comp:<node-id>`** puts the item on that node — a domain, a component or a
subcomponent. The prefix may be in any letter case and the ID is lower-cased by the viewer
(`Comp:Orders.API` works). An item may carry several `comp:` tags and is then listed on each of
those nodes. All other tags are shown as plain tags in the panel.

- Tag at the most specific node that is true. An item tagged to `orders.api` is also counted on
  `orders` — in its badge, its heat and its progress — when that group is collapsed, and not
  there while `orders.api` is drawn. An item tagged to several nodes counts on each box it
  lands on.
- **Tasks follow their parent**: a task is listed under its parent wherever the parent is
  shown, and its own `comp:` tags are then not used. Tag stories, bugs and features; leave tasks
  to inherit. (A task without a parent in the file is placed by its own tags.)
- A `comp:` tag naming a node that does not exist is reported in the Diagnostics, as is every
  item without any `comp:` tag, with a **tag coverage** percentage. Untagged items are not on
  the map; they are still found by the search.

### How the viewer treats the values

- States **Closed, Done, Resolved, Removed** (any letter case) count as completed: such items
  are struck through and can be hidden with one setting. Every other state counts as open.
- **Work items on the map**, on the **Detail** tab, shows nothing, the
  stories/bugs/features/epics, or those with their tasks. A box lists at most 8 lines and then
  "+_k_ more"; the detail panel always lists all.
- `iteration` and `state` feed the filter under **Visibility → Work items shown**. The iteration
  list offers every path above a sprint too (`Shop\PI 3` covers `Shop\PI 3\Sprint 13` and
  `…\Sprint 14`), so a programme increment or a release can be chosen as one scope.
- Open items are what **Heat by work** measures; completed over all items is what the
  **Progress bars** show, within the chosen iteration (or in total).
- `fields` are listed in the work-item panel in the order of the file, by the names you give
  them — use readable names (`"Story Points"`, not `"Microsoft.VSTS.Scheduling.StoryPoints"`).

## Getting the work items from Azure DevOps

Any way of reading Azure DevOps that you have will do — the REST API, the `az boards` command
line, or a connector/MCP tool. What matters is the conversion into the format above.

**Credentials.** Read access to work items is enough (a personal access token with the scope
_Work Items → Read_). Take the token from the environment or the tool's own sign-in. **Never
write a token into any file of this folder**, and remember that `workitems.json` is plain text
that gets shared together with the viewer: export only what the readers of the map may see.

### 1. Query the IDs

WIQL for everything the map can show (narrow it by area path, iteration or change date as
needed — a few hundred to a few thousand items is a sensible size):

```sql
SELECT [System.Id] FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] IN ('Epic', 'Feature', 'User Story', 'Bug', 'Task')
  AND [System.State] <> 'Removed'
ORDER BY [System.Id]
```

REST: `POST https://dev.azure.com/{organization}/{project}/_apis/wit/wiql?api-version=7.1` with
the body `{ "query": "<the WIQL>" }`; the answer lists `workItems[].id`. (Azure DevOps Server:
`https://{server}/{collection}/{project}/_apis/…`.) Authenticate with the token as the password
of HTTP Basic authentication and an empty user name.

In projects that use another process, the story-level type has another name: put
`Product Backlog Item` (Scrum), `Requirement` (CMMI) or `Issue` (Basic) into the `IN (…)` list
in place of `User Story`.

### 2. Fetch the fields

`POST https://dev.azure.com/{organization}/{project}/_apis/wit/workitemsbatch?api-version=7.1`
with at most **200 IDs per request**:

```json
{
  "ids": [1010, 1011],
  "fields": [
    "System.Id",
    "System.WorkItemType",
    "System.Title",
    "System.State",
    "System.AssignedTo",
    "System.IterationPath",
    "System.AreaPath",
    "System.Tags",
    "System.Parent",
    "System.Description",
    "Microsoft.VSTS.TCM.ReproSteps",
    "Microsoft.VSTS.Scheduling.StoryPoints",
    "Microsoft.VSTS.Common.Priority",
    "Microsoft.VSTS.Scheduling.RemainingWork"
  ]
}
```

### 3. Convert each work item

| `workitems.json` | Azure DevOps field          | Conversion                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | `System.Id`                 | As a number                                                                                                                                                                                                                                                        |
| `type`           | `System.WorkItemType`       | `Product Backlog Item`, `Requirement`, `Issue` → `User Story`; drop every type outside the five                                                                                                                                                                    |
| `title`          | `System.Title`              | As it is                                                                                                                                                                                                                                                           |
| `state`          | `System.State`              | As it is                                                                                                                                                                                                                                                           |
| `assignedTo`     | `System.AssignedTo`         | The API gives an object: take its `displayName`. Leave the key out when unassigned                                                                                                                                                                                 |
| `iteration`      | `System.IterationPath`      | As it is (`Shop\Sprint 13`)                                                                                                                                                                                                                                        |
| `tags`           | `System.Tags`               | As it is — already one string separated by `;`                                                                                                                                                                                                                     |
| `parentId`       | `System.Parent`             | As a number; leave it out when there is none or the parent is not in the export                                                                                                                                                                                    |
| `description`    | `System.Description`        | **HTML → plain text**: `<br>`, `</p>`, `</div>`, `</li>` become line breaks, other tags are removed, entities (`&amp;`, `&nbsp;`) decoded. For a Bug use `Microsoft.VSTS.TCM.ReproSteps` when the description is empty. Leave the key out when the result is empty |
| `url`            | —                           | `https://dev.azure.com/{organization}/{project}/_workitems/edit/{id}` (URL-encode the project name)                                                                                                                                                                |
| `fields`         | anything else worth showing | Readable name → string or number, e.g. `"Story Points": 5`, `"Priority": 2`, `"Area": "Shop\\Checkout"`. Leave out empty values. When you renamed the type, keep the original as `"Work item type": "Product Backlog Item"`                                        |

Write the file with a JSON encoder (never by string concatenation), as UTF-8.

### 4. Make sure the items carry `comp:` tags

The link between a work item and the map is the `comp:<node-id>` tag
([above](#linking-work-items-to-the-structure-comp-tags)). After the export, compare the tags
with the IDs of your `architecture.yaml`:

- Where the team already tags its items, there is nothing to do.
- Where it does not, decide the node for each story, bug and feature from what you can see —
  area path, title, description, linked commits or pull requests — and **add the `comp:` entry
  to the `tags` string in `workitems.json`**. This changes only the export.
- Writing the tags back to Azure DevOps makes them permanent and visible to the whole team. Do
  that only when the person you work for asks for it.
- Leave an item untagged rather than guess wildly; the Diagnostics panel lists the untagged
  items and the coverage, which is the honest summary to report.

## Opening the data files

The viewer reads `architecture.yaml` and `workitems.json` directly. There are two ways to use
it.

### From disk (double-click on `viewer.html`)

A page opened from disk is not allowed to read other files by itself — a rule of every browser.
So the files are given to it:

- **Open YAML…** — on the start page, and on the **Files** tab of the control panel at the left
  — opens the browser's file dialog: choose `architecture.yaml`, or `architecture.yaml` and
  `workitems.json` together. **Open work items…**, on the same tab, opens a work-items file on
  its own.
- Or **drop** the file or both files on the page. A `.json` file is taken as the work items,
  anything else as the structure.

In **Edge and Chrome** the viewer remembers what was opened — the last 8 maps:

- The start page lists them under **Open again**, and the **Files** tab under **Recent maps**.
  One click opens a map again: its structure and the work items it was last opened with, read
  **fresh from the disk**.
- The browser may first ask whether the page may read the files again. That question is the
  browser's own. Where it offers to allow this on every visit and you choose that, the viewer
  opens the last map by itself as soon as the page is opened.
- **Reload**, at the foot of the control panel's rail, reads the files of the map again without
  leaving the page: edit the YAML, click Reload, see the change.
- A map is listed by its file names, with its first domains and the date as a hint — the folder
  of a file is not something a browser tells a page. **×** forgets an entry; the files are not
  touched.
- What is remembered is the browser's reference to each file: not its content. It stays in this
  browser profile. When a file has been moved, renamed or deleted, the entry says so when
  clicked: open the file again from where it is now.
- Opening a remembered map shows it as it was remembered — with its own work items, or with
  none. A file opened by hand replaces just the structure or just the work items.

Firefox and Safari have no such references: there the files are opened or dropped each time. A
browser policy can switch the file dialog off in Edge and Chrome; the viewer then uses the plain
file dialog and remembers nothing. In both cases a web server is the comfortable way.

### From a web server

Serve the folder with any static web server and the map opens by itself: the viewer fetches
`architecture.yaml` and `workitems.json` next to it — no click, in every browser, always the
current files. Other files can be named in the address:
`viewer.html?data=<path>&workitems=<path>`, each a path on the same server — relative to the
page (`maps/store.yaml`) or from the root of the server (`/shared/store.yaml`). An address on
another server is refused (see [Offline use and security](#offline-use-and-security)): save such
a file and open it with **Open YAML…** / **Open work items…**, or put it next to the viewer.

## Checking the result

Open `viewer.html` and read the **Diagnostics** panel at the bottom. It shows severity, file,
line:column, the path inside the file and a message that says what to change.

- **Errors in the structure**: there is no map, and the panel is open. Fix all of them.
- **Only warnings**: the map is drawn and the panel is collapsed to a badge — click it.
- **Work items** have their own heading in the panel: problems of the file, `comp:` tags that
  name no node, untagged items, and the coverage ("87% tagged").

The top of the control panel shows where the data came from (a file name, or a path on the
server), and its **Files** tab the size of the structure, the number of work items and the
coverage — check that it is your data and not the example.

Checklist before handing the folder over:

- [ ] The Diagnostics panel shows no errors, and every warning is understood.
- [ ] The viewer shows the files as they are now (**Reload** after the last edit).
- [ ] **Fit view** shows a map a newcomer could read; no domain is a wall of boxes.
- [ ] Every edge has a `kind` that matches its meaning, and a short `label`.
- [ ] No `comp:` tag is reported as unknown; the tag coverage is what you expect.
- [ ] Clicking a work item's link opens the right item in Azure DevOps.
- [ ] No token, password or private data is in any file of the folder.

To try another file, use **Open YAML…** / **Open work items…** on the **Files** tab, or drop a
`.yaml`/`.yml` file (structure) and/or a `.json` file (work items) on the page. The panel lists the first 500 problems of each file and counts the rest.

## Using the viewer

The controls are in the **control panel** at the left, as tall as the window. Its **rail** is
always there: **Search**, six tabs, and at the foot **Reload** (for a map the browser can read
again from the disk), **Fit view** and **Hide** / **Show**. Beside the rail, the body of the
panel shows the name and version of the viewer, the names of the two data files, the search
box and the tab that is chosen. Below, "**Lenses → Colour by**" means the control _Colour by_
on the tab _Lenses_.

| Tab            | Holds                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detail**     | The level of detail; Collapse all, Expand all, Shrink collapsed groups (on while Close up the gaps is); Work items on the map; the zoom thresholds of Auto |
| **Visibility** | Focus, with the Focus / Filter switch; the four edge-kind buttons, Edges on demand; Work items shown (states, iteration)                                   |
| **Lenses**     | Colour by, Heat by work, Progress bars                                                                                                                     |
| **Layout**     | Arrange in rows; Close up the gaps; Unlock / Lock positions (to move boxes and resize open groups), Reset positions                                        |
| **Views**      | The saved views and Copy link                                                                                                                              |
| **Files**      | What the two data files hold, Open YAML…, Open work items…, Export (PNG, SVG, HTML), Recent maps                                                           |

- A click on a tab shows it. A click on the tab that is shown, or **Hide**, hides the body and
  leaves the rail; **Show** or a click on any tab brings it back. The tab shown and whether the
  body is hidden are remembered.
- The tabs say on the rail what is behind them: **Detail** the level being drawn (`Dom`, `Comp`,
  `Sub`, `All`; highlighted while it is pinned), **Visibility** a dot while something is hidden,
  paled or filtered, **Views** the number of saved views.
- In a window at least 1400 px wide the open body stands beside the map. In a narrower one it
  lies over the left of the map until it is hidden; the map does not change size under it, and
  **Fit view**, the search and the links of the detail panel bring things on screen in the part
  beside it. What else stands at the left — the notices above the map, the legends, the zoom
  buttons, the Diagnostics panel — begins where the open body ends. Until you show or hide the
  body yourself, it is shown in a window at least 1400 px wide and hidden in a narrower one.
- With the body hidden, **/**, **Ctrl+K** and **Search** on the rail show the search box alone,
  beside the rail, for as long as it is used.
- A control is offered when it has something to act on (the controls for work items only when
  work items are loaded, for example). While no structure is loaded only **Files** can be
  chosen.

The version of the viewer stands beside its name at the top of the control panel (for example
`0.1.0`): quote it when you report something.

| To                                    | Do                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pan / zoom                            | Drag the canvas / mouse wheel or pinch; or press, drag, wheel in the minimap                           |
| See the whole map                     | **Fit view** on the rail                                                                               |
| Choose how much is drawn              | **Detail** tab: Auto (follows the zoom), Domains, Components, Subcomponents, Everything                |
| Collapse / expand a group             | Its chevron, or double-click it; **Detail → Collapse all** / **Expand all**                            |
| Select a node, an edge or a work item | Click it: its neighbourhood stays lit, the rest dims, the detail panel opens                           |
| Clear the selection                   | Click the empty canvas, **Esc**, or **×** in the panel                                                 |
| Find a node or a work item            | Type in the search box (**/**, **Ctrl+K**, **Search**): names, IDs, `#1010`, title words               |
| Show / hide an edge kind              | The four kind buttons under **Visibility → Edges** (the legend is on the map, top left)                |
| Choose what is shown of the work      | **Detail → Work items on the map**: Off / Stories only / Stories + Tasks                               |
| Hide work items by state or iteration | **Visibility → Work items shown**; **Show completed work items**                                       |
| Follow one story through the map      | **Visibility → Focus**: a flow, an epic or a feature; or **Focus** in the panel of a work item or flow |
| Draw only what a focus involves       | The **Focus / Filter** switch: on the **Visibility** tab, and in the bar above the map                 |
| See where the work is                 | **Lenses → Heat by work**, **Progress bars**                                                           |
| Colour the boxes                      | **Lenses → Colour by**: a preset, a label, owner, status, tech or a metric (legend top left)           |
| Calm the overview                     | **Visibility → Edges on demand**                                                                       |
| Keep or share an arrangement          | **Views** tab: save under a name, come back, **Copy link**                                             |
| Save the map as a picture or a page   | **Files → Export**: **PNG**, **SVG** or **HTML**, of the map as it is drawn                            |
| Lay out without the row bands         | **Layout → Arrange in rows**                                                                           |
| Close up the room of closed groups    | **Layout → Close up the gaps**                                                                         |
| Move and resize boxes by hand         | **Layout → Unlock positions**, drag a box or the edge of an open group; **Reset positions** undoes it  |
| Load other data                       | **Files → Open YAML…**, **Open work items…**, or drop a file on the page                               |
| Open a map again                      | **Files → Recent maps**, **Open again** on the start page (Edge, Chrome)                               |
| See an edit of the data files         | **Reload** on the rail (maps opened from disk in Edge, Chrome); else open the file again               |
| Get more room for the map             | **Hide** on the rail, or click the tab that is shown                                                   |

- **Levels of detail.** Zoomed out, only domains are drawn and edges are merged per domain;
  zooming in shows components, then subcomponents with edge labels, then (**Everything**, above
  160%) the work items listed inside the boxes. At the coarser levels a badge on a box counts
  its work items and its open bugs. Changing level never moves anything, unless **Close up the
  gaps** is on.
- **Collapsed groups** keep their place, unless **Close up the gaps** is on; edges into them
  are re-attached to the group and merged (`×3`). Select a merged edge to see its member edges.
- **Close up the gaps** (**Layout** tab, off by default) moves the boxes that are drawn closer
  together whenever groups are closed — by hand, by **Collapse all**, by a pinned level, or in
  Auto by the zoom — and apart again when they open.
  - _What moves:_ a closed group is drawn shrunk and takes only the room of its small box; an
    open group closes up around what is drawn inside it and shrinks to it; a leaf keeps its
    size. With rows, the items of each band are placed again from their new sizes, in the same
    order, the bands are as tall as what they now hold, and a closed group that spans rows keeps
    its column over them.
  - _What stays:_ among the boxes of one group, and among the domains, a box that is left or
    right of another box stays on that side, and so does one above or below it; the space
    between two such boxes is never less than on the full map — or, where it is wider there,
    than the usual spacing, so a wide gap may close down to that — and the map never becomes
    wider or taller than the full one. One exception: a box of the Unassigned area follows its
    connections, as on the full map — it stays right of the row bands, but may come to stand
    beside a box in the bands that it stood above or below.
    The map is still laid out only once, fully expanded, and closing up only moves its boxes,
    so it happens at once, and the same groups closed at the same level always give the same
    map: zooming across a level and back shows the map as it was. With every group open at
    Subcomponents or Everything the map is the full one.
  - _What changes it:_ a group opened or closed, **Collapse all** / **Expand all**, pinning a
    level or going back to Auto, switching the option, a closed group gaining or losing its
    work-item badge, and in Auto a zoom that crosses a level. Panning, zooming within a level,
    selecting, the lenses and the edge kinds do not.
  - _What keeps its place:_ a group opened or closed with its chevron (or by double-clicking
    it) stays where it is on the screen — its top left corner, with the header and the chevron
    — and the rest closes up or opens out around it. For every other change the box in the
    middle of the canvas stays where it is, at the same zoom.
  - _Auto:_ the level follows the zoom once the view has come to rest (0.2 s after it last
    moved, and not while a finger is on the screen or the canvas is being dragged), not in the
    middle of a zoom. Until then the **Detail** tab shows the level that is still drawn, the
    button of the level to come has a dashed outline there, and so has the level shown on the
    rail; the work-item lists of Everything come and go with their level, when the view rests.
    Going to a search result, a link in the detail panel, a work item or a saved view first
    closes up the map for the level the move ends on, then moves there.
  - _Shrink collapsed groups_ is implied: while the option is on, closed groups are drawn shrunk
    whatever that setting says, and its checkbox shows checked and disabled. Switching the
    option off brings that setting back as it was.
  - _Fit view_ fits the map as it is closed up at the level the fit ends on. In Auto it tries
    every level and takes, of the fits whose zoom draws that very level, the one zoomed in
    furthest; the level then stays, the fit is the same whatever level it is pressed at, and
    pressing **Fit view** again changes nothing. With a pinned level the map closed up for that
    level is fitted. The fit button among the zoom buttons at the bottom left of the map fits
    the map as **Fit view** on the rail does, with the option on or off.
  - _With the other controls:_ **Arrange in rows** and **Filter** work as without the option (a
    filtered map closes up around its own closed groups); leaving Filter puts the box that was
    in the middle back in the middle. The minimap shows the map as it is drawn, closed up.
  - _Limits:_ without rows, keeping the boxes on their sides of each other costs room — a gap
    stays open where a box further along still needs it — so the map closes up less than it
    could; with rows this costs less, but a box also stays right of the boxes of other rows
    that it was right of, so a gap can stay open in a row. Positions and sizes set by hand belong to one
    arrangement: each set of closed groups has its own, so a box dragged or a group resized
    while some groups are closed is back as the layout made it when others are, and as it was
    left when the same ones are closed again; what was moved or resized on the full map shows
    only with the option off or every group open. In Auto every level that closes other groups
    is such a set.
- **Moving and resizing by hand** (**Layout → Unlock positions**; **Lock positions** ends it).
  Nothing else on the map moves for a box that is moved or resized, edges are redrawn on the
  drop, and **Reset positions** puts back every move and every size of the arrangement on
  screen.
  - _Picking a box up:_ a leaf or a closed group anywhere on it; an open group — one drawn with
    its children — by its title bar only, which shows six dots at its right end and the move
    cursor, and whose tooltip begins "Drag the title bar to move _name_". A node stays inside
    its group; a group takes its contents along.
  - _Inside an open group,_ while the positions are unlocked, the rest of the box is canvas: a
    drag pans the map, the wheel and a pinch zoom it (a finger on a touch screen too), a drag
    from a box inside moves that box, and a click selects the group. The chevron stays a
    button. A double-click collapses an open group at its title bar (also on its heat strip,
    its progress bar and its badge), not inside it; the tooltip with its description shows at
    the title bar; **Edges on demand** shows the edges of the group while the pointer is on its
    title bar, a heat strip, the progress bar, the badge or a resize handle. Closed groups and
    leaves take all of that anywhere on them, and with the positions locked so does an open
    group.
  - _Resizing:_ while the positions are unlocked, every open group, at any level, has a handle
    on each edge and each corner, on its border and just outside it, and a grip mark in its
    bottom-right corner. The edge that is dragged follows the pointer in whole pixels and the
    other edges stay. Everything inside stays where it is on the canvas — never laid out again,
    never scaled — and the group's own work-item list stays under its title bar. Neighbours,
    row bands and the Unassigned area do not move; the group may overlap them or leave its
    band. While an edge is dragged only the box follows: edges, the minimap and the group's
    work-item list are redrawn on the drop. A box inside can then be moved anywhere in the
    resized group.
  - _How far:_ a nested group grows to the border of its parent, upward to the parent's title
    bar and the parent's own work items; the parent does not grow along (grow the outer group
    first). A top-level group grows at each edge by at most the size of the map as laid out:
    its width to the left and the right, its height upward and downward. An edge moved inward
    stops 16 px from the nearest box inside (at the top: under the title bar, the group's own
    work items and 8 px), or at the smaller distance the layout left there; a box moved nearer
    to an edge holds it and is not pushed; a group is never narrower than its title needs. The
    layout is tight: shrinking mostly takes back what was grown.
  - _Not resized:_ leaves, closed groups, row bands and the Unassigned area. A closed group is
    drawn in the box of the open one, resized if that was; drawn shrunk, the small box sits in
    the middle of it (with **Close up the gaps** on, closing a group gives another arrangement,
    which has sizes of its own). With the positions locked a group keeps the size set by hand
    and has no handles.
  - _Undoing one group:_ double-click any of its handles, or press **Delete** or **Backspace**
    on its grip: the group gets back the size the layout made, as far as what is inside and
    around it allows — an edge moved outward stops at a box that was moved into the room
    gained, an edge moved inward at the parent's border when the group was moved there since.
  - _Keyboard:_ the grip is a button ("Resize _name_"; **Tab** reaches it). The arrow keys move
    the right and the bottom edge by 8 px the way the arrow points, with **Shift** the left and
    the top edge; **Delete** or **Backspace** undoes the size. No box is moved with the
    keyboard.
  - _Where it is kept:_ in this browser, per arrangement — rows on or off, each story mode,
    each filtered map and each closed-up arrangement have positions and sizes of their own —
    and counted on the **Layout** tab ("2 moved · 1 resized"). Saved views and links carry
    neither positions nor sizes. A changed structure file starts from the arrangement the
    layout computes.
  - _Limits:_ the title bar is 40 px of the map high (16 px on the screen at 40%, 8 px at 20%),
    and the handles are about 8 px thick on the screen at 100%, stay near that down to a zoom of
    about a third and then shrink with the map. In Auto, with the default thresholds, every
    group is closed below 40% and picked up anywhere; at a pinned level and a zoom below about
    25% the title bar and the handles of an open group are too small to use — zoom in, or close
    the group to move it. A group grown, or a box moved, left of or above the top-left corner
    of the map is not on the minimap there (**Fit view** shows it); grown to the right or
    downward, the map and the minimap grow along. A box or an edge that is drawn over a handle
    takes the press there.
- **Edge legend** (top left of the map): a sample of the line of each edge kind with its name,
  there whichever tab is shown; a kind that is hidden is struck through. It is a key only — the
  kinds are switched under **Visibility → Edges**.
- **Detail panel** (right): for a node its description, parent path, children, incoming and
  outgoing edges and all its work items; for an edge its ends, kind, protocol and description;
  for a work item everything in the file, its parent, its tasks and the nodes it is tagged to.
  The panel of a node lists Owner, Status and Tech and then every label that holds for the
  node, each followed by "(from _name_)" when the node has it from a group around it.
  Everything underlined is a link that selects that thing and brings it on screen.
- **Focus** answers "what does this involve": choose a flow, an epic or a feature under
  **Visibility → Focus**, or press **Focus** in the panel of any work item or flow (a story, a
  bug). The nodes and edges involved stay lit — for a work item, the nodes of everything under
  it and the edges among them — and the rest of the map is paled; a bar above the map names the
  focus. Selecting things still works inside a focus, and what is selected is never paled.
  **Clear focus** ends it.
- **Focus / Filter.** The switch under the focus chooser, and again in that bar, says what
  happens to the rest of the map: **Focus** pales it, **Filter** does not draw it. The choice
  is remembered; it takes effect once a focus is chosen.
  - _What Filter draws:_ exactly what Focus leaves lit — the nodes involved, the groups around
    them, what lies inside them, and the edges of the focus among them — laid out again as a
    map of its own. Every node stays in its row; rows left empty close up. The bar begins
    "Filter:" and the line under the switch counts what is not drawn.
  - _The view:_ a filtered map arrives fitted. Leaving it — the switch back to Focus, **Clear
    focus** — brings the whole map back where it was, at the same zoom (after a link that
    opened filtered: at its remembered view, or fitted). The view remembered for the next visit
    is that of the whole map; it does not change while a filtered map is shown.
  - _Something that is left out:_ the search and the detail panel still cover the whole
    structure. What the filtered map does not have is set in italics there and marked "not on
    the filtered map"; choosing it switches back to **Focus** (the focus stays), shows the whole
    map and goes there. The bar says "Filter switched off to show …", and its switch turns
    Filter on again. A selected thing that is not on the filtered map keeps its panel, with the
    note "Not on the map: Filter leaves it out." and a **Show it** button.
  - _Nothing to leave out:_ a focus that cannot be filtered leaves the whole map as in Focus
    mode. When it involves every node and every edge, the bar says "nothing to leave out: the
    whole map is shown"; when it involves no node, or is not in the loaded data, "nothing of it
    is on the map: the whole map is shown, paled".
  - _With the other controls:_ the level of detail and collapsing work as on the whole map (in
    Auto the level is the one the zoom of the fitted map selects), and the collapsed groups are
    the same ones in both; hidden edge kinds stay hidden; **Edges on demand** holds nothing
    back, because every edge of a filtered map belongs to the focus; **Arrange in rows** applies
    as on the whole map; a filtered map has positions and sizes set by hand of its own; the
    boxes list the same work items and show the same colours as on the whole map. Heat and
    progress count what no box drawn inside shows: an open group also counts the work of the
    nodes inside it that Filter leaves out, a group whose children are all left out is drawn as
    a box without children (it counts everything inside it, is picked up anywhere and has no
    resize handles), and the work of a domain that is left out entirely is counted nowhere. The
    badge of an open group still counts its own items only. Heat is measured against the
    hottest box of its level on the whole map, as without Filter. With a work item as the
    focus, **Work items shown** also decides what the focus involves.
  - _After a reload_ — of the page, or with **Reload** — the whole map is shown: the focus is
    not remembered, the switch is.
- **Heat by work** draws a strip up both sides of a box, coloured from the bottom up like a bar
  of iron being heated: a little work smoulders dark red, more glows red, then yellow, and the
  hottest box is white at the top.
  - _What a box counts:_ the open work that no box drawn inside it shows — a leaf its own
    items, a closed group everything inside it, an open group only the items tagged to the
    group itself. An item counts on the nearest drawn box of every node it is tagged to: the
    node itself, or the closest group around it that is drawn. A box left without open work has
    no strip.
  - _How tall:_ the count of the box against the hottest box of its level counted with
    everything inside it, drawn or not, on the whole map (domains against domains, components
    against components). The scale does not depend on what is open: opening or closing a group
    changes its own strip and those of the boxes that appear or disappear, never another. The
    strip of an open group is short or absent for that reason — its work is on the boxes inside
    it; close the group, or read the total in the detail panel.
  - _Adding up:_ the open items over all strips are the same at every level, except for an item
    tagged to two nodes of one group: it counts on each of them while both are drawn and once
    on the closed group around them. An item tagged to several nodes counts once on every box
    it lands on.
  - _Tooltip:_ "3 open work items in here", or, on a box that holds more than it shows, "2 open
    work items here that no box inside shows (14 in here in all)".
- **Progress bars** turn the bottom edge of a box into a bar of the completed items over all
  items — for the iteration chosen under **Work items shown**, else in total. The state filter
  does not affect them (hiding Closed items must not make a box look untouched). A box counts
  as for the heat: the items that no box drawn inside it shows; a box left without items has no
  bar. The tooltip reads "3 of 8 done (38%)", or "1 of 3 done (33%) of what no box inside shows
  (5 of 12 in here in all)".
- **Work in the detail panel.** With either of the two lenses on, the panel of a node states
  the totals of the node and everything inside it, drawn or not, under **Work** (for a group:
  **Work, with everything inside**). When the box on the map shows less, a second line says
  what it shows: "On the map: 2 open items · 1 of 3 done on this box; the rest is on the boxes
  drawn inside it" (only the lenses that are on), or "On the map: all of it is on the boxes
  drawn inside it" when the box has neither a strip nor a bar.
- **Colour by** tints every box that has a value — a stripe along its top in the colour, and
  its background lightly — and shows a legend, below the edge legend. A label, like owner,
  status and tech, holds for everything inside the box that carries it, so a box without a
  value of its own has the colour of the nearest group around it that has one. A box with no
  value anywhere, or without the metric, is not tinted.
  - _The list_ has three groups, each left out when the file has nothing for it. **Presets**:
    the colourings the file names (see [Colour presets](#colour-presets)), in the order of the
    file; while one with a description is chosen, the description stands under the list.
    **Labels**: Owner, Status and Tech, each when some node has one, and then the labels of the
    file as they are written, in the order of first use. **Metrics**: the metrics of the file.
    **Nothing** switches the colours off.
  - _The colours_ of a label, and of Owner, Status and Tech, are given in the order the values
    first appear in the file; from the ninth value on everything is "Other". They can change
    when the file does: only a preset fixes a colour. A metric is drawn light (its smallest
    value) to dark (its largest).
  - _The legend_ is headed by the name of what is chosen. Under the name of a preset stands
    "by _label_" (left out when that is its name too), and its description is the tooltip of
    the title. Then one line for each value: its colour, the value, and the number of boxes
    that have it. The values a preset lists come first, in its order, then the others in the
    order of the file. "Other" stands for the values that share the grey, and its tooltip names
    them: the first twenty, then "… and _n_ more". "No value" counts the boxes that have none.
    A long legend scrolls. The legend of a metric is its scale, with the two ends.
  - _The counts_ are of the whole structure: the boxes of every level, drawn or not. Filter,
    the level of detail and closed groups do not change them, so the legend can list a value
    that no box on screen shows — its boxes are inside closed groups.
  - _A group_, open or closed, shows its own value, whatever the boxes inside it have. A closed
    group without a value is not tinted, even when boxes inside it are.
  - _On the dark colour scheme_ the boxes and the legend have the dark variant of each colour
    of the palette, and of a colour the file gives as a pair.
- **Edges on demand** hides the edges, at every level of detail, except at the box under the
  pointer, at the selected box or edge, and those of the focus. Pointing at the frame of an open
  group shows the edges at the group and at everything drawn inside it; pointing at a box inside
  the group shows only that box's edges. Selecting a box works the same way — also one gone to
  from the search or a link in a panel, without the pointer — and a selected work item shows
  the edges of the boxes that list it. Moving the pointer from a box onto one of its edges
  keeps them shown, so the edge can be followed and clicked; a hidden edge cannot be clicked.
  While the positions are unlocked, the inside of an open group is canvas and not part of its
  frame: point at its title bar, a heat strip, the progress bar, the badge or a resize handle.
- **Views** (the **Views** tab) keep an arrangement under a name: collapsed groups, hidden edge
  kinds, level of detail, focus, colouring, story mode, whether the map is closed up (**Close
  up the gaps**) and where the view is (the point in the middle, so it fits any window). Saved
  views stay in this browser, per structure. **Copy link** puts a link on the clipboard that
  carries the view itself (`viewer.html#view=…`), so it can be sent to anyone who has the same
  folder; the link is put in the address bar as well, for where the clipboard is not available.
  The page applies the view of a link when it opens with it, and again when it is reloaded with
  the link still in the address.
  - A view saved, or a link copied, while the map is filtered to its focus keeps **Filter**
    too: applied, it shows that filtered map again, at the same place. A view with a focus that
    was saved on the whole map shows it in Focus mode and sets the switch to Focus; a view
    without a focus leaves the switch alone.
  - When the focus of such a view cannot be filtered with the data that is loaded, the whole
    map is shown, fitted.
  - Applying a view switches **Close up the gaps** on or off as it was when the view was
    saved, and puts the same point in the middle. A view saved without the option, or before
    it existed, is one of the full map and switches it off.
  - Views and links saved with version 0.1.1 or earlier open as before. A link copied on a
    filtered map needs version 0.2.0 or later: an older one shows the focus in Focus mode,
    with the view at the wrong place. A link copied with the map closed up needs a viewer newer
    than 0.2.0: an older one shows the full map, with the view at the wrong place.
  - A view remembers its colouring by name: a preset by its `name`, a label or a metric by its
    own. When the file that is loaded has nothing of that name — the preset was renamed or
    removed, its label is on no node any more — the view is applied in every other respect, the
    boxes are not coloured, and a notice above the map says so: "This view is coloured by
    preset "Risk", which this file does not have: the boxes are not coloured." The notice goes
    when a colouring is chosen under **Lenses → Colour by** (choose one and then **Nothing** to
    have none), when another view is applied and when a file is opened or read again. A link in
    the address bar is applied again with every reload, and says so again. The view itself
    stays as it was saved: once the file has the preset again, it colours again. A link carries
    the name of a preset, never its colours — those come from the file of whoever opens the
    link. A link coloured by a preset or a label needs a viewer that has them: one of version
    0.2.0 or earlier shows the view uncoloured.
- **Exporting the map.** The section **Export** on the **Files** tab — there while a map is
  drawn — saves the map as a file with one of three buttons: **PNG**, a picture; **SVG**, a
  vector drawing; **HTML**, a web page that needs nothing else. The file is made in the browser
  and handed to the browser's own download.
  - _What is in a file:_ the map as it is drawn at the moment of the click — the map, not the
    window. That is: the level of detail that is drawn (in Auto the one the zoom selects: for
    the whole map with the work items listed in the boxes, pin **Everything** first); closed and
    shrunk groups, and the map closed up by **Close up the gaps**; the row bands and the
    Unassigned area, or the map without rows; every box where it is and as large as it is drawn,
    positions moved by hand included; a focus with the rest paled, or with **Filter** the
    filtered map alone; the selection — the ring around the selected box, the heavier line of
    the selected edge, the marked line of the selected work item, and the rest dimmed; the edge
    kinds that are shown, and with **Edges on demand** only the edges shown at that moment
    (those of the selection and of the focus: the pointer is on the button, not on a box); the
    work items, as lines in the boxes or as badges; **Colour by**, **Heat by work** and
    **Progress bars**. An SVG and a page keep the tooltips of the map as well: the description
    of a node and of an edge, what a heat strip and a progress bar count, the text of a label
    that is not drawn, and the type, ID, state and full title of a work item.
  - _What is never in a file:_ the control panel, the detail panel and the Diagnostics panel,
    the notices and the bar of a focus above the map, the minimap, the zoom buttons, the two
    legends at the top left (a file has a key of its own, see below), the dotted background, the
    "React Flow" credit, and whatever only shows under the pointer or while the positions are
    unlocked. What is not drawn is not exported either: a hidden edge kind, what lies inside a
    closed group, a work item that **Work items shown** hides, another level of detail than the
    one on screen.
  - _The three files._ **PNG** is a fixed picture, of **PNG size** pixels for each pixel of the
    map: every program shows it, and its text is pixels. **SVG** is shapes and text, sharp at
    any size, for documents and drawing programs: its text is found by a search, can be
    selected, and can be edited in a drawing program. It is plain SVG — no script, no style
    sheet, no embedded image or font — and opens in a browser; an image viewer that cannot
    show SVG shows nothing, which is what the PNG is for. **HTML** is one page with the picture
    in it and, below the picture, what it shows as text. The page has no script and loads
    nothing; it opens in any browser, from disk or from a server, and it prints.
  - _The page:_ at its top the title and the note (see below), as text; then the picture, in a
    frame that scrolls; then **Boxes**, the boxes of the picture as a nested list, and
    **Edges**, its edges as a table with the columns From, To, Kind and Label. **Fit the
    width**, above the picture, is checked at first: the picture is as wide as the window.
    Unchecked, the picture has its own size and is scrolled in its frame. A name in the list is
    a link to its box in the picture: the browser goes there and the box is outlined. Beside
    its name the list gives the level of a box, its description, for a closed group the names
    of what is inside it ("closed, inside: …"), what its badge, its heat strips and its
    progress bar count, and its work-item lines (type, ID, title and state). The table gives
    the label of an edge at every level of detail, also where the picture draws the line
    without it. Only what is in the picture is listed. The browser's own search finds every
    text of the page, the picture included; printed, the page shows the whole picture at the
    width of the paper. The page is a picture with an index, not a second viewer: nothing in it
    pans, zooms, collapses or opens a panel.
  - _The four choices_, under the buttons (the default in bold):

    | Choice               | Values                            | Decides                                           |
    | -------------------- | --------------------------------- | ------------------------------------------------- |
    | **Area**             | **Whole map** · What is on screen | How much of the map is in the file                |
    | **Colours**          | **As on screen** · Light · Dark   | The colour scheme of the file                     |
    | **PNG size**         | 1× · **2×** · 3×                  | The pixels of a PNG for each pixel of the map     |
    | **Title and legend** | **on** · off                      | Whether the picture has a title, a note and a key |

    **Whole map** is everything that is drawn, with a margin of 24 px, wherever the view is.
    **What is on screen** is the part of the map the canvas shows, without what the open control
    panel lies over: a box, a line or a label that reaches into that part is in the file, cut
    off at its edge, and the rest is left out. Whatever the area and the zoom, the picture has
    the scale of the map at a zoom of 100%: a name set in 15 px is 15 px in an SVG and 30 px in
    a PNG at 2×. **As on screen** is the scheme the viewer is shown in at the click, light or
    dark as the system says; **Light** and **Dark** name one, and a light file made on a dark
    screen changes nothing on screen. A file has one scheme and does not follow the system of
    whoever opens it. With **Title and legend** the title and the note stand above the map and
    the key below it, inside the picture, so that a PNG has them too; without it the file is the
    map and its margin alone, and the page still has its title and its note as text. The four
    choices are remembered in the browser, once for the viewer; they are not part of a saved
    view or a link.

  - _Title, note and key._ The **title** is the name of the structure file — `architecture.yaml`
    — and, while a focus is set, " — " and the name of the focus; without a file name it is
    "Architecture map". The **note** says what the picture shows, part by part, joined by " · ";
    a part with nothing to say is left out: the level ("Level: Components"); a focus ("Focus:
    the rest is paled", or "Filtered to the focus"); the lenses ("Colour by Owner", "Heat by
    work", "Progress"); the work items ("Work items: Stories only" or "Work items: Stories +
    Tasks", "Iteration" with the one chosen under **Work items shown**, "Work items from
    workitems.json"); what the picture leaves out or adds ("Without config edges", with the edge
    kinds that are hidden, "Edges on demand: only the edges shown", "With the selection", "Part
    of the map" for **What is on screen**); and the time of the export on the clock of the
    computer ("Exported 2026-10-10 09:30"). The **key** lists what occurs in the picture, each
    part on a line of its own: under "Edges" a sample of the line of every edge kind that is
    drawn, and "several edges (×n)" when a merged edge is; under the name of what **Colour by**
    shows, the entries of the colour legend on the map with their colours, in the same order
    (for a metric the ramp from its smallest to its largest value); with **Heat by work**,
    "Heat: open work in the box; the taller the strip, the more"; and with **Progress bars**,
    "Progress: completed work items of all in the box". A long key wraps at the width of the
    picture, and a picture with a title or a key is at least 480 px wide. An SVG and a page also
    carry the title and a description — the title, the numbers of boxes and edges, the note and
    the version of the viewer — as their own title and description, which a screen reader reads
    out, with **Title and legend** off as well.
  - _The name of the file_ is that of the structure file without its folders and its extension,
    then `-map` and the format: `architecture-map.png`, `architecture-map.svg`,
    `architecture-map.html` for `architecture.yaml`. A character that a file name must not have
    (`< > : " / \ | ? *`) becomes `-`, a long name is cut to 80 characters, and when nothing
    usable is left of the name the file is called as for `architecture.yaml`. Where the file
    goes is the browser's decision: its downloads folder, or the place it asks for. The same
    export again has the same name, and the browser numbers the second file.
  - _What the section says._ While a file is made the three buttons wait and the line under
    the choices reads "Making the picture…"; they also wait while the map is being laid out
    (their tooltip then reads "The map is still being laid out"). Afterwards the line names the
    file — "Saved architecture-map.svg.", and for a PNG with its size, "Saved
    architecture-map.png (6728 × 4014 px)." — until another tab is shown or the body of the
    panel is hidden. When no file can be made, none is saved and the line says why: "Nothing is
    drawn."; with **What is on screen**, "Nothing of the map is on screen."; "Could not make
    the PNG: the picture is too large for this browser. SVG has no such limit."; or "Could not
    export: " and the reason. Before the click the section says what a picture will carry:
    "The selection is part of the picture: click the empty canvas first for one without it."
    while something is selected, and "Edges on demand: only the edges shown now are in the
    picture." while **Edges on demand** holds edges back.
  - _Limits._ A PNG is at most 16 384 px a side and 64 million pixels. A larger picture is
    saved reduced, and the line says to what: "Saved architecture-map.png (16384 × 1653 px —
    reduced to 24 % to fit a picture; a smaller part of the map, or SVG, keeps every detail)."
    For every detail export a smaller part — **What is on screen**, zoomed in — or SVG or
    HTML, which have no limit. **What is on screen** keeps the scale of the map, so the picture
    of a view zoomed far out is much larger than the window: a canvas 1800 px wide at a zoom of
    10% gives a picture 18 000 px wide. SVG and HTML name the font of the system and carry
    none, so another computer draws the text in its own font; each text is held to the width it
    had where it was exported, by the spacing of its letters, which with a narrower font pulls
    the letters of a joined script (Arabic) apart. Some things are drawn more simply than on
    the map: the soft shadows of the boxes are left out, the glow of a heat strip is a plain
    translucent strip, and a text may sit a pixel higher or lower. A name too long for its box
    is cut at its end with "…", also a name written from right to left, of which the map hides
    the beginning instead. A file has one colour scheme, the selection is in the picture, and
    the time in the note is that of the export, not of the data.
- **Remembered in the browser** (`localStorage`): collapsed groups, the view of the whole map,
  hidden edge kinds, hand-moved positions (per arrangement: rows on or off, each story mode,
  each filtered map and each closed-up arrangement have their own) and saved views per
  structure; once for the viewer the settings — the Focus / Filter switch and Close up the gaps
  among them — and the tab and the hidden or shown body of the control panel. The four choices
  of the export (area, colours, title and legend, PNG size) are remembered once for the viewer
  too, not per structure. The focus, the
  selection and a pinned level of detail are not remembered: a reload comes back in Auto, and
  where the map is then drawn otherwise (closed up for another level, or without the work-item
  lists) the view shows the same place — the box that was in the middle of the canvas is in the
  middle again, at the same zoom.
  The recent maps are kept as references to their files (IndexedDB; Edge and Chrome), not as
  copies. Nothing is sent anywhere — the viewer makes no network request except fetching the
  data files when it is served over HTTP.

## Offline use and security

The viewer works on a computer or a network without internet access. What that rests on:

- **Nothing comes from the internet.** `viewer.html` contains all of its code and styles. There
  is no CDN, no web font, no analytics, no telemetry and no update check. Opened from disk
  (`file://`) the page makes no network request at all; served by a web server it asks that
  same server for `architecture.yaml` and `workitems.json`, and nothing else.
- **The browser enforces it.** The page carries a Content Security Policy that forbids
  everything and then allows only: the viewer's own code (recognised by its SHA-256 hash),
  inline styles, and requests to the page's own server. No script file is loaded, not even one
  lying next to the page. Code from anywhere else, `eval`, a script slipped into the page and
  a request to any other address are stopped by the browser itself, whatever a data file or a
  link contains. For the same reason **`viewer.html` must not be edited by hand**: with other
  code in it the hash no longer matches and the page stays empty. Change the data files, not
  the viewer.
- **Your data stays where it is.** The data files are read in the browser and nothing is
  uploaded; the same holds for a file opened with the buttons or dropped on the page. What the
  viewer remembers is kept in this browser: settings and views in `localStorage`, the recent
  maps as references to their files — never the content of a file — in IndexedDB. **Copy link** writes to the
  clipboard, only when clicked.
- **A file is written only when you export.** The viewer saves nothing by itself. A click on
  **PNG**, **SVG** or **HTML** under **Files → Export** makes the file in the browser and hands
  it to the browser's own download; nothing is sent anywhere, and the policy of the viewer is
  the same with the export as without it. An exported page carries a policy of its own —
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:` — so it runs no script and
  loads nothing, wherever it is opened; an exported SVG holds shapes and text only, no script,
  no style sheet and no link. A file says what the map says — names, descriptions, edge labels,
  the titles of work items — so pass it on as you would pass on the data files.
- **A link cannot bring in a foreign map.** `?data=` and `?workitems=` only name files on the
  server the page came from; on `file://` they name nothing. Whoever sends a link to the viewer
  cannot make it load, or show, content from somewhere else.
- **The only ways out are links you click.** The `links` of a node and the `url` of a work item
  open in a new tab — `http(s)` addresses only, and without telling the other site where the
  click came from. The small "React Flow" credit in the corner of the canvas links to the
  website of the library that draws the map. Nothing is contacted until such a link is clicked.
- **The data files are data, never code.** The viewer reads YAML and JSON only. Their content
  is shown as text; a title or a description cannot run anything. Earlier versions loaded
  generated `*.data.js` scripts next to the page: those are gone, and one left over in the
  folder is ignored — the policy would not let it run.
- **Azure DevOps is never contacted by the viewer.** The export described above is a separate
  step that you run with your own access token; the token never comes near the viewer.
- **Open-source licences.** `viewer.html` contains open-source libraries (React, React Flow,
  d3, ELK, yaml, zod and what they need). `THIRD-PARTY-NOTICES.txt` lists them with their
  licence texts, and the same text is at the end of `viewer.html`, so the file can be passed on
  alone. All are under permissive licences (MIT, ISC, BSD) except the layout engine `elkjs`,
  which is used unmodified under the Eclipse Public License 2.0.

## Troubleshooting

| What you see                                               | Cause and fix                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The example map instead of yours                           | The example files were opened. Open your own `architecture.yaml` (and `workitems.json`)                                                                 |
| Your edits do not show                                     | The viewer shows the file as it was when opened. Click **Reload**, or open it again; over HTTP reload the page                                          |
| Empty page with **Open YAML…**                             | Normal when opened from disk: click the map under **Open again**, or open / drop the files. Over HTTP: `architecture.yaml` is not next to `viewer.html` |
| No map, a list of errors                                   | The structure file has errors: fix every error in the Diagnostics panel                                                                                 |
| **Open again** / **Recent maps** is missing                | Firefox or Safari, a private window, or storage switched off: open the files each time, or serve the folder over HTTP                                   |
| The browser asks before a recent map opens                 | Its rule for files a page has remembered. Allow it — on every visit where that is offered — or serve the folder over HTTP                               |
| "… is no longer where it was"                              | The file was moved, renamed or deleted. Open it from where it is now; **×** forgets the old entry                                                       |
| A recent map opens without its work items                  | They could not be read again (moved, or not allowed). Open them with **Open work items…**                                                               |
| Work items load but none are on the map                    | No `comp:` tag matches a node ID — see the unknown tags and the coverage in the Diagnostics panel                                                       |
| Items missing                                              | Skipped for a format problem (Diagnostics), or hidden by **Visibility → Work items shown**                                                              |
| No stories in the boxes                                    | They are listed at the **Everything** level only (zoom in, or click **Everything**); **Work items on the map** not Off                                  |
| Only a part of the map is drawn                            | The **Focus / Filter** switch stands on Filter and a focus is chosen: set it to Focus, or **Clear focus** (bar above the map)                           |
| A preset is missing from **Colour by**                     | Its `label` is on no node, so the preset is left out. The Diagnostics panel has the warning, with the label it may have meant                           |
| A value has another colour than the preset gives it        | The colour was not read: a hex colour without quotes, or a name that is none of the nine. See the warnings in the Diagnostics panel                     |
| A view or a link opens uncoloured, with a notice           | The file has no preset, label or metric of the name the view remembers (renamed, removed). Choose a colouring and save the view again                   |
| The controls are gone, only a strip of icons is left       | The body of the control panel is hidden: **Show** at the foot of that strip, or click one of its tabs                                                   |
| The left of the map is under the controls                  | In a window narrower than 1400 px the open control panel lies over the left of the map: **Hide**, or click the tab that is shown                        |
| The page hangs after loading                               | The map is too large (hundreds of nodes). Reduce subcomponents; see the target size above                                                               |
| Odd view or collapsed state after changing files           | Remembered state from before: **Fit view**, **Expand all**, **Reset positions** (moves and sizes set by hand)                                           |
| An open group does not move when it is dragged             | With the positions unlocked it is picked up by its title bar; a drag inside it pans. Zoomed far out the bar is small: zoom in, or close the group       |
| The heat strip or progress bar of an open group is gone    | An open group counts only what no box inside it shows. Close it, or select it: the detail panel states the total                                        |
| Work items missing when served over HTTP                   | `workitems.json` took longer than 4 seconds: reload, or open it with **Open work items…**                                                               |
| "…reads data files only from the place it was opened from" | `?data=` / `?workitems=` names a file on another server. Save it and open it, or put it next to the viewer                                              |
| An empty page after `viewer.html` was edited               | The browser only runs the code the viewer was built with. Take the original file again                                                                  |
| The exported PNG is small or blurred                       | A picture too large for a PNG is saved reduced; the line under **Export** says to what. Export a smaller part (**What is on screen**, zoomed in) or SVG |
| The browser asks whether to download several files         | Its rule for a page that saves another file a while after the click, as a large PNG does. Allow it: an export saves one file, and only when you click   |
| The exported PNG is blank or speckled                      | The browser keeps pages from reading what they drew (Firefox with `privacy.resistFingerprinting`, some extensions). Allow it, or export SVG or HTML     |
