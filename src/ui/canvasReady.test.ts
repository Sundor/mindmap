// Waiting for a canvas that can be moved: when the wait ends, and that it can be called off.
// The browser's frames and timers are played by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasIsUp, whenCanvasReady } from './canvasReady';

/** The frame callbacks asked for and not yet run. */
let frames: FrameRequestCallback[] = [];

/** One frame: every callback asked for so far, then the timers and promises they set off. */
async function frame(): Promise<void> {
  const due = frames;
  frames = [];
  for (const callback of due) callback(0);
  await vi.advanceTimersByTimeAsync(0);
}

type CanvasState = ReturnType<Parameters<typeof whenCanvasReady>[0]['getState']>;

const UP: CanvasState = { panZoom: {}, width: 800, height: 600, fitViewQueued: false };

/** A canvas store in a state that can be changed. */
function canvas(initial: CanvasState) {
  let state = initial;
  return {
    getState: () => state,
    set: (next: CanvasState) => {
      state = next;
    },
  };
}

beforeEach(() => {
  frames = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('canvasIsUp', () => {
  it('holds once the canvas has its pan/zoom, a size and its first view', () => {
    expect(canvasIsUp(canvas(UP))).toBe(true);
    for (const notYet of [
      { ...UP, panZoom: null },
      { ...UP, width: 0 },
      { ...UP, height: 0 },
      { ...UP, fitViewQueued: true },
    ]) {
      expect(canvasIsUp(canvas(notYet))).toBe(false);
    }
  });
});

describe('whenCanvasReady', () => {
  it('runs once, after the next paint, when the canvas is up already', async () => {
    const run = vi.fn();
    whenCanvasReady(canvas(UP), run);
    expect(run).not.toHaveBeenCalled();
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await frame();
    expect(run).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([]);
  });

  it('looks again every frame until the canvas has its pan/zoom, a size and its first view', async () => {
    const run = vi.fn();
    const store = canvas({ ...UP, panZoom: null });
    whenCanvasReady(store, run);
    await frame();
    for (const notYet of [
      { ...UP, panZoom: null },
      { ...UP, width: 0 },
      { ...UP, height: 0 },
      { ...UP, fitViewQueued: true },
    ]) {
      store.set(notYet);
      await frame();
      await frame();
      expect(run).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
    }
    store.set(UP);
    await frame();
    expect(run).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([]);
  });

  it('does not wait for a frame that never comes: a timer stands in for the paint', async () => {
    const run = vi.fn();
    whenCanvasReady(canvas(UP), run);
    await vi.advanceTimersByTimeAsync(99);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never runs once it is cancelled, before the paint or between two frames', async () => {
    const early = vi.fn();
    whenCanvasReady(canvas(UP), early)();
    await frame();
    await frame();
    expect(early).not.toHaveBeenCalled();

    const late = vi.fn();
    const store = canvas({ ...UP, width: 0 });
    const cancel = whenCanvasReady(store, late);
    await frame();
    await frame();
    cancel();
    store.set(UP);
    await frame();
    await frame();
    expect(late).not.toHaveBeenCalled();
    // A cancelled wait asks for no further frame.
    expect(frames).toEqual([]);
  });

  it('gives up on a canvas that does not come, and does not run when it comes after all', async () => {
    const run = vi.fn();
    const store = canvas({ ...UP, panZoom: null });
    whenCanvasReady(store, run);
    // Still looking after a second's worth of frames …
    for (let i = 0; i < 60; i++) await frame();
    expect(frames).toHaveLength(1);
    // … but not for ever.
    let waited = 60;
    while (frames.length > 0 && waited < 10_000) {
      await frame();
      waited += 1;
    }
    expect(frames).toEqual([]);
    expect(waited).toBeLessThan(10_000);
    store.set(UP);
    await frame();
    expect(run).not.toHaveBeenCalled();
  });
});
