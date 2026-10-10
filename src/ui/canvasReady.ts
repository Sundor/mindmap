// Waiting for a canvas that can be moved. A layout that replaces another one mounts a new canvas,
// and whatever moves the view next has to wait until that canvas is up.

import { afterNextPaint } from './afterNextPaint';

/** The part of the canvas store that says whether the canvas is up. */
interface CanvasStore {
  getState(): {
    readonly panZoom: unknown;
    readonly width: number;
    readonly height: number;
    readonly fitViewQueued: boolean;
  };
}

/** Frames waited for at most: a canvas that is not up by then is not coming. */
const MAX_FRAMES = 120;

/**
 * Whether the canvas of `store` is up: it has its pan/zoom, its size, and the viewport it starts
 * from (no fit is still to come). A move of the view before that is computed for a canvas of no
 * size, or undone by the fit.
 */
export function canvasIsUp(store: CanvasStore): boolean {
  const { panZoom, width, height, fitViewQueued } = store.getState();
  return panZoom !== null && width > 0 && height > 0 && !fitViewQueued;
}

/**
 * Calls `run` once the canvas of `store` is up ({@link canvasIsUp}). Looks after the next paint,
 * then once a frame; gives up after {@link MAX_FRAMES} frames. Returns a function that cancels
 * the wait.
 */
export function whenCanvasReady(store: CanvasStore, run: () => void): () => void {
  let cancelled = false;
  let tries = 0;
  const check = (): void => {
    if (cancelled) return;
    if (!canvasIsUp(store)) {
      tries += 1;
      if (tries < MAX_FRAMES) requestAnimationFrame(check);
      return;
    }
    run();
  };
  void afterNextPaint().then(check);
  return () => {
    cancelled = true;
  };
}
