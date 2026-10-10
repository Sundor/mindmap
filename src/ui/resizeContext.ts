// Lets the resize handles of the group nodes rendered by React Flow reach the sizes held by the app.

import { createContext } from 'react';
import type { EdgeGrowth } from '../core';

export interface ResizeActions {
  /** The edges of the group `id` were moved outward by `delta` (canvas pixels). */
  readonly resize: (id: string, delta: Partial<EdgeGrowth>) => void;
  /** Give the group `id` the size of the layout back, as far as what is inside allows. */
  readonly reset: (id: string) => void;
}

export const NO_RESIZE_ACTIONS: ResizeActions = {
  resize: () => undefined,
  reset: () => undefined,
};

export const ResizeContext = createContext<ResizeActions>(NO_RESIZE_ACTIONS);
