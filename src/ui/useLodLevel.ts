// The level of detail selected by the React Flow zoom, and the level that follows it once the view
// rests.

import { useStore, useStoreApi, type ReactFlowState } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createLodTracker, LOD_CONFIG, type LodConfig, type LodLevel } from '../core';

/**
 * How long the viewport must have rested before {@link useLevelAtRest} takes another level over:
 * longer than the 150 ms a wheel gesture stays open.
 */
export const LEVEL_SETTLE_MS = 200;

/**
 * Current level of detail. Subscribes to the zoom through a selector that returns the *level*
 * (with hysteresis against the level it last returned), so the calling component re-renders only
 * when the level changes: panning, and zooming within a band, cause no React re-render.
 *
 * The zoom only counts once it is real. While no canvas is mounted the store holds its default
 * zoom of 1, and while a fit to view is queued the zoom is about to be replaced: in both cases
 * the level last shown is held (the plain level of the provisional zoom when there is none yet)
 * and the hysteresis history dropped, so the next real zoom is judged by the plain thresholds
 * (on load, after loading another file or replacing the layout, and on **Fit view**).
 *
 * The same holds while `fitting`: a fit the app makes itself (a move to a view it worked out) is
 * judged like one of the canvas, by the plain thresholds once it is there.
 *
 * A new `config` object (the thresholds were changed on the Detail tab) starts a new tracker: the
 * current zoom is then judged by the plain thresholds of that config. Keep the object stable
 * between changes. Must be used below a `ReactFlowProvider`.
 */
export function useLodLevel(config: LodConfig = LOD_CONFIG, fitting = false): LodLevel {
  const track = useMemo(() => createLodTracker(config), [config]);
  const selectLevel = useMemo(
    () =>
      (state: ReactFlowState): LodLevel => {
        const zoom = state.transform[2];
        // While there is no canvas (none mounted yet, or it is being replaced for another layout
        // or file) and while a fit is pending, the zoom in the store is not the real one: the
        // level last shown is held. It must not fall back to the level of the store's default
        // zoom — reaching the Everything level lays the map out again, and a level that flipped
        // while the canvas is replaced would lay it out back and forth.
        if (!fitting && state.panZoom !== null && !state.fitViewQueued) return track(zoom);
        return track.hold(zoom);
      },
    [track, fitting],
  );
  return useStore(selectLevel);
}

/**
 * `level`, taken over once the viewport has not changed for {@link LEVEL_SETTLE_MS} and no
 * gesture is under way (a finger on the screen, even one that pauses in a pinch, or the canvas
 * dragged with the mouse); and a setter, for a move that sets the level it ends on before it
 * starts. While the zoom in the store is not a real one (no canvas mounted, a fit to come)
 * `level` is a held one, and it is waited for too; so it is while `fitting`, the app making a
 * fit of its own (see {@link useLodLevel}). Must be used below a `ReactFlowProvider`.
 */
export function useLevelAtRest(
  level: LodLevel,
  fitting = false,
): readonly [LodLevel, (level: LodLevel) => void] {
  const [atRest, setAtRest] = useState(level);
  const store = useStoreApi();
  // The touch pointers that are down, kept whatever the level: a gesture may begin before it.
  const touches = useRef(new Set<number>());
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'touch') touches.current.add(event.pointerId);
    };
    const up = (event: PointerEvent) => {
      touches.current.delete(event.pointerId);
    };
    const clear = () => touches.current.clear();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', clear);
    };
  }, []);
  useEffect(() => {
    if (atRest === level || fitting) return;
    let timer: ReturnType<typeof setTimeout>;
    const settle = () => {
      const { paneDragging, panZoom, fitViewQueued } = store.getState();
      if (touches.current.size > 0 || paneDragging || panZoom === null || fitViewQueued) {
        timer = setTimeout(settle, LEVEL_SETTLE_MS);
      } else {
        setAtRest(level);
      }
    };
    timer = setTimeout(settle, LEVEL_SETTLE_MS);
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transform === previous.transform) return;
      clearTimeout(timer);
      timer = setTimeout(settle, LEVEL_SETTLE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [atRest, level, fitting, store]);
  return [atRest, setAtRest];
}
