// Lets the nodes rendered by React Flow reach the work-item selection held by the app.

import { createContext } from 'react';

export interface WorkItemCanvas {
  /** The selected work item, whose line is marked. */
  readonly selectedId?: number | undefined;
  /**
   * The item the selected one is listed under: its line is marked more lightly where the
   * selected task has no line of its own (mode Stories only).
   */
  readonly parentId?: number | undefined;
  /** A line was clicked. */
  readonly select: (id: number) => void;
}

export const NO_WORK_ITEM_CANVAS: WorkItemCanvas = { select: () => undefined };

export const WorkItemCanvasContext = createContext<WorkItemCanvas>(NO_WORK_ITEM_CANVAS);
