// Lets the links of the detail panel know what the filtered map leaves out. The panel lists the
// whole model; a link to something that is not drawn says so before it is clicked, because
// going there switches Filter off.

import { createContext } from 'react';

/** What the filtered map on screen has. */
export interface FilteredMap {
  showsNode(id: string): boolean;
  showsEdge(id: string): boolean;
}

/** Given while the map on screen is filtered to the focus; undefined on the whole map. */
export const FilterContext = createContext<FilteredMap | undefined>(undefined);

/** The title of a link to `name`, which the filtered map leaves out. */
export function outsideTitle(name: string): string {
  return `${name} — not on the filtered map; click to show the whole map`;
}
