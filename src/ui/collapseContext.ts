// Lets the group nodes rendered by React Flow reach the collapse state held by the app.

import { createContext } from 'react';

/** Toggles the collapsed state of the group with the given node ID. */
export type ToggleCollapse = (id: string) => void;

export const CollapseContext = createContext<ToggleCollapse>(() => undefined);
