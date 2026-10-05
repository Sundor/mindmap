// The level of detail selected by the React Flow zoom.

import { useStore, type ReactFlowState } from '@xyflow/react';
import { useMemo } from 'react';
import { createLodTracker, LOD_CONFIG, type LodConfig, type LodLevel } from '../core';

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
 * A new `config` object (the thresholds were changed in the settings) starts a new tracker: the
 * current zoom is then judged by the plain thresholds of that config. Keep the object stable
 * between changes. Must be used below a `ReactFlowProvider`.
 */
export function useLodLevel(config: LodConfig = LOD_CONFIG): LodLevel {
  const selectLevel = useMemo(() => {
    const track = createLodTracker(config);
    return (state: ReactFlowState): LodLevel => {
      const zoom = state.transform[2];
      // While there is no canvas (none mounted yet, or it is being replaced for another layout
      // or file) and while a fit is pending, the zoom in the store is not the real one: the level
      // last shown is held. It must not fall back to the level of the store's default zoom —
      // reaching the Everything level lays the map out again, and a level that flipped while the
      // canvas is replaced would lay it out back and forth.
      if (state.panZoom !== null && !state.fitViewQueued) return track(zoom);
      return track.hold(zoom);
    };
  }, [config]);
  return useStore(selectLevel);
}
