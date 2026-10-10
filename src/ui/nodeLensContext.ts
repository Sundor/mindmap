// Lets the nodes rendered by React Flow reach the lenses the app computed: the heat and the
// progress of what each drawn box stands for — its own work and that of everything below it that
// no box drawn inside it shows — and the colour each node has under "Colour by".

import { createContext } from 'react';
import type { DrawnHeat, DrawnProgress, SchemeColor } from '../core';

export interface NodeLenses {
  /** Per drawn box, while the heat lens is on (`heatOfDrawn` in src/core/workload.ts). */
  readonly heat?: ReadonlyMap<string, DrawnHeat> | undefined;
  /** Per drawn box, while the progress lens is on (`progressOfDrawn`). */
  readonly progress?: ReadonlyMap<string, DrawnProgress> | undefined;
  /** Per node, while something is coloured by (src/core/colorBy.ts). */
  readonly colors?: ReadonlyMap<string, SchemeColor> | undefined;
}

export const NO_LENSES: NodeLenses = {};

export const NodeLensContext = createContext<NodeLenses>(NO_LENSES);
