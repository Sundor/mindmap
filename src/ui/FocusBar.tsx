// The notice above the canvas while a focus is set: what the map is focused on and how much it
// involves, with the ways to its panel and out of the focus. Visible whatever the control panel
// shows. The text stands at the left and the controls at the right end of the first line, so
// that a control stays where it is when the text changes with the mode.

import { Switch } from './Switch';

export interface FocusBarProps {
  /** The focus leaves the rest out (Filter) instead of paling it (Focus): the bar says which. */
  readonly filterOn: boolean;
  readonly onFilterChange: (on: boolean) => void;
  /** Name of the flow or the work item. */
  readonly name: string;
  /** What it involves (" · 8 nodes · 7 edges"), following the name. */
  readonly counts: string;
  /** What that means for the map on screen, following the counts. */
  readonly state?: string | undefined;
  /** What the viewer changed by itself, said after that. */
  readonly note?: string | undefined;
  /** Whether **Show** is offered: the focus is not what the detail panel shows. */
  readonly showVisible: boolean;
  readonly onShow: () => void;
  readonly onClear: () => void;
}

export function FocusBar({
  filterOn,
  onFilterChange,
  name,
  counts,
  state,
  note,
  showVisible,
  onShow,
  onClear,
}: FocusBarProps) {
  return (
    <p
      id="focus-bar"
      className="notice notice-focus"
      role="status"
      data-mode={filterOn ? 'filter' : 'focus'}
    >
      <span className="focus-bar-text">
        {filterOn ? 'Filter' : 'Focus'}: <strong>{name}</strong>
        {counts}
        {state}
        {note !== undefined && <span id="focus-bar-note">{note}</span>}
      </span>
      <span className="focus-bar-controls">
        <Switch
          id="focus-bar-mode"
          checked={filterOn}
          onChange={onFilterChange}
          offLabel="Focus"
          onLabel="Filter"
          label="Filter: draw only what the focus involves"
        />
        {showVisible && (
          <button type="button" id="focus-show" onClick={onShow}>
            Show
          </button>
        )}
        <button type="button" id="focus-clear" onClick={onClear}>
          Clear focus
        </button>
      </span>
    </p>
  );
}
