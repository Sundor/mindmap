// What the control panel hides of the canvas. In a narrow window its open body lies over the
// left of the canvas instead of standing beside it (see `.cp-body` in styles.css); the code that
// positions the view leaves that part out, so nothing it shows ends up underneath.

/**
 * How many pixels at the left of the canvas the tab panels of the control panel lie over: 0
 * while the body is collapsed or stands beside the canvas. Reads the page as it is laid out
 * now: for event handlers, effects and mount initialisers, not for rendering.
 */
export function coveredCanvasLeft(): number {
  const panels = document.querySelector('.cp-panels');
  const column = document.querySelector('.app-column');
  // Not displayed (the body is collapsed): it covers nothing.
  if (!panels || !column || panels.getClientRects().length === 0) return 0;
  return Math.max(0, panels.getBoundingClientRect().right - column.getBoundingClientRect().left);
}
