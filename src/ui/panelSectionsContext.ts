// The arrangement of the node panel's lists, shared with each `PanelSection`.

import { createContext } from 'react';
import type { PanelLayout, SectionMove } from '../core';

export interface PanelSections {
  readonly layout: PanelLayout;
  /** The sections on screen, in the order shown. */
  readonly shown: readonly string[];
  readonly toggle: (id: string) => void;
  readonly move: (id: string, move: SectionMove) => void;
}

export const PanelSectionsContext = createContext<PanelSections | undefined>(undefined);
