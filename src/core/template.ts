// The template files: a short structure file and its work items, with every key the viewer
// reads once (examples/template/). The build copies them beside the viewer; the viewer names
// them, and does nothing else with them. Pure: no React, no browser APIs.

/**
 * Where the template files lie beside the viewer. The build makes its list from this one
 * (vite.config.ts): each is copied there from the same path under `examples/`.
 */
export const TEMPLATE_FILES = ['template/architecture.yaml', 'template/workitems.json'] as const;

/** What the viewer says about them, on the Files tab and on the empty page. */
export const TEMPLATE_NOTE =
  'Starting a map of your own? Copy template/architecture.yaml and template/workitems.json ' +
  'from the viewer’s folder: two short files with every key once, and what it does.';
