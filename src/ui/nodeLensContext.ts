// Lets the nodes rendered by React Flow reach the lenses the app computed over the whole map:
// heat by work, progress, and the colour each node has under "Colour by".

import { createContext } from 'react';
import type { NodeHeat, NodeProgress, SchemeColor } from '../core';

export interface NodeLenses {
  /** Per node, while the heat lens is on (src/core/workload.ts). */
  readonly heat?: ReadonlyMap<string, NodeHeat> | undefined;
  /** Per node, while the progress lens is on. */
  readonly progress?: ReadonlyMap<string, NodeProgress> | undefined;
  /** Per node, while something is coloured by (src/core/colorBy.ts). */
  readonly colors?: ReadonlyMap<string, SchemeColor> | undefined;
}

export const NO_LENSES: NodeLenses = {};

export const NodeLensContext = createContext<NodeLenses>(NO_LENSES);
