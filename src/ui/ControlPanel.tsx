// The control panel at the left of the map: a rail that is always there — search, one tab per
// group of controls, and the actions wanted at any time — and beside it a body with the title,
// the search box and the tab that is shown. The body can be collapsed to the rail; the search
// box then shows as a small card beside it while it is in use. The shell knows nothing about
// the controls: they come as props.

import {
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { CONTROL_TABS, controlTabAfterKey, type ControlTab } from '../core';
import { PanelIcon } from './PanelIcons';

/** Captions on the rail. */
const TAB_LABELS: Readonly<Record<ControlTab, string>> = {
  detail: 'Detail',
  visibility: 'Visibility',
  lenses: 'Lenses',
  layout: 'Layout',
  views: 'Views',
  files: 'Files',
};

/** Headings of the tab panels. "Level of detail", not to be taken for the detail panel. */
const TAB_HEADINGS: Readonly<Record<ControlTab, string>> = {
  detail: 'Level of detail',
  visibility: 'Visibility',
  lenses: 'Lenses',
  layout: 'Layout',
  views: 'Saved views',
  files: 'Files',
};

/** Tooltips of the tabs: the heading, and what is found under it. */
const TAB_HINTS: Readonly<Record<ControlTab, string>> = {
  detail: 'Level of detail',
  visibility: 'Visibility: focus, edge kinds, work items shown',
  lenses: 'Lenses: colour, heat and progress on the boxes',
  layout: 'Layout: rows, positions set by hand',
  views: 'Saved views: keep the current arrangement under a name, or share it as a link',
  files: 'Files',
};

/** What the tabs say on the rail about the controls behind them. */
export interface ControlTabMarks {
  /**
   * Detail: the level being drawn — its name, the short form shown —, whether it is pinned, and
   * the name of the level that is drawn once the view rests, when that is another one.
   */
  readonly level?:
    | {
        readonly text: string;
        readonly name: string;
        readonly pinned: boolean;
        readonly pending?: string | undefined;
      }
    | undefined;
  /** Visibility: something is hidden, paled or filtered. */
  readonly hiding?: boolean | undefined;
  /** Views: the number of saved views. */
  readonly views?: number | undefined;
  /** Files: the names of the files in use. */
  readonly files?: string | undefined;
}

export interface ControlPanelProps {
  /** The tab shown (already through `shownControlTab`). */
  readonly tab: ControlTab;
  readonly collapsed: boolean;
  /** The tabs that can be chosen. */
  readonly available: readonly ControlTab[];
  /** A user action: a tab chosen, the body hidden or shown. */
  readonly onChange: (next: { readonly tab: ControlTab; readonly collapsed: boolean }) => void;
  readonly marks?: ControlTabMarks | undefined;
  /** Title, version, file names. */
  readonly head: ReactNode;
  /** The search box: one instance, kept mounted; undefined while there is nothing to search. */
  readonly search: ReactNode | undefined;
  /** The search is shown beside the rail although the body is collapsed. */
  readonly searchOpen: boolean;
  readonly onSearchOpenChange: (open: boolean) => void;
  /** `#search-open` was pressed. */
  readonly onSearch: () => void;
  /** Buttons at the foot of the rail, above Hide / Show (Reload, Fit view). */
  readonly actions: ReactNode;
  /** The contents of each tab; all stay mounted. */
  readonly panels: Readonly<Record<ControlTab, ReactNode>>;
}

const NO_MARKS: ControlTabMarks = {};

function tabHint(id: ControlTab, marks: ControlTabMarks): string {
  const hint = TAB_HINTS[id];
  switch (id) {
    case 'detail':
      if (!marks.level) return hint;
      if (marks.level.pinned) return `${hint}: ${marks.level.name} — pinned`;
      return marks.level.pending === undefined
        ? `${hint}: ${marks.level.name} — follows the zoom`
        : `${hint}: ${marks.level.name} — ${marks.level.pending} once the view rests`;
    case 'visibility':
      return marks.hiding ? `${hint} — something is hidden, paled or filtered` : hint;
    case 'views':
      return marks.views ? `${hint} — ${marks.views} saved` : hint;
    case 'files':
      return marks.files ? `${hint} — ${marks.files}` : hint;
    default:
      return hint;
  }
}

/** A mark is for the eye: the tab is named by its caption, and its tooltip says the mark in full. */
function TabMark({ id, marks }: { readonly id: ControlTab; readonly marks: ControlTabMarks }) {
  if (id === 'detail' && marks.level) {
    const pinned = marks.level.pinned ? ' cp-tab-mark-pinned' : '';
    const pending = marks.level.pending === undefined ? '' : ' cp-tab-mark-pending';
    return (
      <span className={`cp-tab-mark cp-tab-mark-level${pinned}${pending}`} aria-hidden="true">
        {marks.level.text}
      </span>
    );
  }
  if (id === 'visibility' && marks.hiding) {
    return <span className="cp-tab-mark cp-tab-mark-dot" aria-hidden="true" />;
  }
  if (id === 'views' && marks.views !== undefined && marks.views > 0) {
    return (
      <span className="cp-tab-mark" aria-hidden="true">
        {marks.views}
      </span>
    );
  }
  return null;
}

export function ControlPanel({
  tab,
  collapsed,
  available,
  onChange,
  marks = NO_MARKS,
  head,
  search,
  searchOpen,
  onSearchOpenChange,
  onSearch,
  actions,
  panels,
}: ControlPanelProps) {
  // A click on the tab that is shown hides the body; any other click shows the tab clicked.
  const choose = (id: ControlTab) => {
    if (!available.includes(id)) return;
    onChange({ tab: id, collapsed: !collapsed && id === tab });
  };
  // The arrow keys move among the tabs that can be chosen, and never hide the body.
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = controlTabAfterKey(tab, event.key, available);
    if (next === undefined) return;
    event.preventDefault();
    onChange({ tab: next, collapsed: false });
    event.currentTarget.querySelector<HTMLElement>(`#tab-${next}`)?.focus();
  };
  // Collapsed, the search box is on screen only while it is in use: it goes when the cursor
  // leaves the box for anything else, the list of matches included.
  const onSearchBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!collapsed) return;
    const next = event.relatedTarget;
    if (next instanceof HTMLInputElement && event.currentTarget.contains(next)) return;
    onSearchOpenChange(false);
  };
  // The tabs share one scrolling area: another tab starts at its top, not where the last was left.
  const panelsArea = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (panelsArea.current) panelsArea.current.scrollTop = 0;
  }, [tab]);
  return (
    <aside
      className="control-panel"
      id="control-panel"
      aria-label="Controls"
      data-collapsed={collapsed}
    >
      <div className="cp-rail">
        <button
          type="button"
          id="search-open"
          className="cp-rail-button"
          disabled={search === undefined}
          title="Search nodes and work items (shortcut: / or Ctrl+K)"
          onClick={onSearch}
        >
          <PanelIcon name="search" />
          <span className="cp-tab-label">Search</span>
        </button>
        <div
          className="cp-tabs"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Control panel"
          onKeyDown={onTabKeyDown}
        >
          {CONTROL_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              className="cp-tab"
              aria-selected={id === tab}
              aria-controls={`panel-${id}`}
              aria-disabled={available.includes(id) ? undefined : 'true'}
              tabIndex={id === tab ? 0 : -1}
              title={tabHint(id, marks)}
              onClick={() => choose(id)}
            >
              <PanelIcon name={id} />
              <span className="cp-tab-label">{TAB_LABELS[id]}</span>
              <TabMark id={id} marks={marks} />
            </button>
          ))}
        </div>
        <span className="cp-rail-spacer" />
        {actions}
        <button
          type="button"
          id="panel-toggle"
          className="cp-rail-button"
          aria-expanded={!collapsed}
          aria-controls="control-panel-body"
          title={
            collapsed ? 'Show the controls beside the map' : 'Hide the controls: the rail stays'
          }
          onClick={() => onChange({ tab, collapsed: !collapsed })}
        >
          <PanelIcon name={collapsed ? 'show' : 'hide'} />
          <span className="cp-tab-label">{collapsed ? 'Show' : 'Hide'}</span>
        </button>
      </div>
      <div
        id="control-panel-body"
        className={`cp-body${collapsed ? ' cp-body-flyout' : ''}`}
        hidden={collapsed && !(searchOpen && search !== undefined)}
      >
        <div className="cp-head" hidden={collapsed}>
          {head}
        </div>
        <div className="cp-search" hidden={search === undefined} onBlur={onSearchBlur}>
          {search}
        </div>
        <div className="cp-panels" ref={panelsArea} hidden={collapsed}>
          {CONTROL_TABS.map((id) => (
            <div
              key={id}
              role="tabpanel"
              id={`panel-${id}`}
              className="cp-panel"
              aria-labelledby={`tab-${id}`}
              hidden={id !== tab}
            >
              <h2 className="cp-panel-title">{TAB_HEADINGS[id]}</h2>
              {panels[id]}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
