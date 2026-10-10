// The resize handles of an open group: a strip along each edge and a square at each corner.

import {
  NodeResizeControl,
  ResizeControlVariant,
  type OnResizeEnd,
  type OnResizeStart,
} from '@xyflow/react';
import { useCallback, useContext, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import {
  controlBounds,
  EDGES,
  growthBetween,
  keyGrowth,
  RESIZE_CONTROLS,
  type NodeResize,
  type Rect,
} from '../core';
import { ResizeContext } from './resizeContext';

export interface ResizeHandlesProps {
  readonly id: string;
  readonly name: string;
  readonly resize: NodeResize;
}

function stopPropagation(event: MouseEvent): void {
  event.stopPropagation();
}

/**
 * The eight controls of the group `id`, the edges first so that the corners lie above them. A
 * drag reports once, at the drop, how far each edge went; a double-click gives the size of the
 * layout back. The grip in the bottom right corner is the control for the keyboard: the arrow
 * keys move the right and the bottom edge (with Shift the left and the top one), Delete undoes.
 */
export function ResizeHandles({ id, name, resize }: ResizeHandlesProps) {
  const actions = useContext(ResizeContext);
  // The box at the press, to tell at the drop how far each edge went.
  const pressed = useRef<Rect | undefined>(undefined);
  // React Flow binds its drag anew whenever a callback or a bound of a control changes: the
  // callbacks keep their identity, and the bounds reach the controls as numbers.
  const onResizeStart = useCallback<OnResizeStart>((_event, box) => {
    pressed.current = box;
  }, []);
  const onResizeEnd = useCallback<OnResizeEnd>(
    (_event, box) => {
      const from = pressed.current;
      pressed.current = undefined;
      if (!from) return;
      const growth = growthBetween(from, box);
      // A press without a move ends where it began: nothing to report.
      if (EDGES.some((edge) => growth[edge] !== 0)) actions.resize(id, growth);
    },
    [id, actions],
  );
  // A double-click must not also collapse the group.
  const reset = (event: MouseEvent) => {
    event.stopPropagation();
    actions.reset(id);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const delta = keyGrowth(event.key, event.shiftKey);
    if (!delta && event.key !== 'Delete' && event.key !== 'Backspace') return;
    // The arrow keys must not also scroll the page.
    event.preventDefault();
    event.stopPropagation();
    if (delta) actions.resize(id, delta);
    else actions.reset(id);
  };
  return (
    <>
      {RESIZE_CONTROLS.map((position) => (
        <NodeResizeControl
          key={position}
          position={position}
          variant={position.includes('-') ? ResizeControlVariant.Handle : ResizeControlVariant.Line}
          // `nopan`: a press on a control must not also move the map.
          className="arch-resize nopan"
          autoScale={false}
          {...controlBounds(resize, position)}
          onResizeStart={onResizeStart}
          onResizeEnd={onResizeEnd}
        >
          {/* What fills a control takes its clicks: a press on a handle must not select the group. */}
          {position === 'bottom-right' ? (
            <button
              type="button"
              // `nokey`: as on the chevron, a key on the button must not also select the node.
              className="arch-resize-grip nopan nokey"
              data-resized={resize.resized}
              aria-label={`Resize ${name}`}
              title={`Resize ${name}: drag, or use the arrow keys (Shift: the left and top edge). Delete gives back the size the layout made`}
              onClick={stopPropagation}
              onDoubleClick={reset}
              onKeyDown={onKeyDown}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
                <path d="M 9 2 L 2 9 M 9 6 L 6 9" />
              </svg>
            </button>
          ) : (
            <span className="arch-resize-hit" onClick={stopPropagation} onDoubleClick={reset} />
          )}
        </NodeResizeControl>
      ))}
    </>
  );
}
