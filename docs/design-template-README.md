# Restyling the Architecture Map viewer: the design pages

This folder holds the viewer's interface as two static HTML pages, generated from the real
components with the real stylesheet. Restyle them here; the stylesheet is read back into the
app afterwards. Nothing in these pages is live: no script runs, the data is the shipped example.

| File           | What it shows                                                                                                                                                                                                                                                                                                              | Use it for                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `kit.html`     | The design kit: the colour and size tokens, the icons, the control panel in its states (each tab, the rail, collapsed, the search card), the map (open and closed boxes at each level, shrunk groups, edges of the four kinds with their labels, legends, lenses, work-item lines), the detail panel, the notices and bars | Styling the parts: every element in every state, each on its own stage |
| `screens.html` | The whole app in a few situations: the start page, the map at several levels, a selection with its panel, the lenses, a narrow window                                                                                                                                                                                      | Judging the whole: how the parts work together at real size            |

Open either file in a browser as it is. The checkbox at the top right switches the dark scheme;
a page generated with `--dark` is dark throughout and has no switch. Hover and keyboard-focus
states show when an element is pointed at or reached with Tab.

## The one block to change

Each page carries three style blocks in its `<head>`:

1. `/* tpl:library … — as shipped, not to be changed */`: the stylesheet of the canvas library.
   Leave it.
2. `/* tpl:app-stylesheet:begin — src/ui/styles.css; the block to restyle */` up to
   `/* tpl:app-stylesheet:end */`: **the app's stylesheet. This is the block to restyle.**
3. `/* tpl:page — the page's own */`: the frames, stages and captions of the page itself. Every
   selector in it starts with `.tpl-` or `#tpl-`. Leave it.

The extract reads the text between the two `tpl:app-stylesheet` markers and nothing else, so:

- **Change values, not names.** Keep every selector (class names, ids, attribute tests such as
  `[data-lod='domains']`) and every custom-property name (`--fg`, `--edge-dataflow`, …) exactly
  as it is: the components write those names and the smoke test checks them. Adding a rule for
  an existing selector is fine; adding a selector the markup does not carry does nothing.
- **Leave the markup alone.** A change to the HTML outside the style block is lost on extract.
  If a part needs another structure, say so in a comment at the top of the block (`/* ask: … */`)
  rather than editing the markup; it is then changed in the components.
- **Plain CSS only.** Rules and `@media` blocks one level deep. No nesting, no `@layer`,
  `@container`, `@supports`, `@import` or `@font-face`: the extract refuses them. No URLs to the
  web, no web fonts: the viewer runs offline under a strict content-security policy, so only
  system fonts and colours, gradients and inline SVG are safe.

## Tokens, schemes and conditions

The **Tokens** section at the top of the kit lists every custom property declared on `:root`,
with its light and dark value and where it is used. Most of the look is in those values; start
there. The colours of the heat scale and of _Colour by_ are not in the stylesheet (they are
computed), and the edge colours are the four `--edge-*` tokens, used by the lines, the
arrowheads (`.arch-arrow-*`), the dots on the labels (`.arch-edge-dot`) and the legend alike.

In the app the dark scheme is `@media (prefers-color-scheme: dark)`. In the pages that condition
is rewritten so that the switch can show it: the block reads
`@media all /*tpl:was (prefers-color-scheme: dark)*/` and its selectors are prefixed with a page
scope (`:root:has(#tpl-dark:checked)` or `.tpl-dark`). Edit the values inside as they are; a rule
you add inside such a block, without the prefix, is taken as a dark-scheme rule. The same holds
for the narrow-window condition (`max-width: 1399.98px`, scope `.tpl-narrow`). Rules for a coarse
pointer (`(pointer: coarse)`) are left as they are.

## What the parts are called

- **Control panel** (`.control-panel`): the **rail** (`.cp-rail`: `.cp-rail-button` for Search,
  the level of detail `#lod-cycle` with its mark `.cp-tab-mark-level`, Reload, Fit view, Hide;
  `.cp-tab` for the four tabs Map, Lenses, Views, Files, with `.cp-tab-mark` badges) and the
  **body** (`.cp-body`, `.cp-head`, `.cp-search`, `.cp-panels`; a tab is `.cp-panel` with
  `.cp-panel-title` and `.cp-section-title` sections; controls use `.settings-row`,
  `.settings-check`, `.cp-actions`, `.cp-select`, `.lod-indicator` / `.lod-step` for a row of
  choices, `.switch` for the Focus / Filter switch). Collapsed, the body is a flyout
  (`.cp-body-flyout`).
- **Map**: row bands (`.arch-band-node`, `.arch-band-gutter`, `.arch-band-title`), boxes
  (`.arch-node` with `.arch-level-domain|component|subcomponent` by its level, and the level
  tag `.arch-level-tag` in a group header; open groups `.arch-group`
  with `.arch-group-header`, closed ones `.arch-collapsed`, shrunk ones `.arch-compact`, leaves
  `.arch-leaf`, names `.arch-node-name`, badges `.arch-badge`, work-item lines `.arch-workitem`,
  heat strips and progress bars of the lenses, resize handles `.arch-resize`), edges (the line
  `.react-flow__edge-path` coloured per kind by `.arch-edge-dataflow|dependency|control|config`,
  merged edges `.arch-edge-aggregate`, labels `.arch-edge-label` with the same kind classes, the
  dots `.arch-edge-dot`), the states dimmed (`.arch-dimmed`), paled (`.arch-faded`) and held back
  (`.arch-quiet`), the legends (`.map-legends`), the minimap and the zoom buttons.
- **Detail panel** (`.detail-panel`, `.detail-section`, `.detail-link`), the **focus bar**, the
  **notices** (`.notice`, `.notice-error`), the **diagnostics** bar and panel, and the **start
  page** (`.empty-state`).

The caption under each stage of the kit names the specimen and the states it shows.

## Handing the work back

Return the whole page with the block changed (both pages if both were changed; the stylesheet
in them is the same, so the last one returned wins). Then, in the repository:

```sh
npm run design:extract design-template/kit.html          # lists what the page changes
npm run design:extract design-template/kit.html --write  # puts the stylesheet in place
npm run design                                           # regenerates the pages from it
npm test && npm run build && npm run smoke               # the checks of the viewer
```

The extract compares rule by rule: formatting and comments do not count, and the page scopes are
turned back into the media conditions. `--all-styles` reads every style block of a page that
lost its markers. A test fails when a class or id the stylesheet selects is on no page, so a
selector that was renamed or dropped by mistake shows up there.
