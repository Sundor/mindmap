// Sizes shared between components and the code that positions the view.

import { FIT_MAX_ZOOM } from '../core';

/** Width of the detail panel in pixels; allowed for when something is brought on screen. */
export const DETAIL_PANEL_WIDTH = 340;

/** How the view is fitted: on load, when a stored viewport is useless, and by **Fit view**. */
export const FIT_VIEW_OPTIONS = { padding: 0.05, maxZoom: FIT_MAX_ZOOM } as const;
