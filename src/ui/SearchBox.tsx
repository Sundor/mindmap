// The search box of the control panel: finds a node by name or ID, or a work item by #ID or
// title. All matching and ranking is in `searchNodes` / `searchWorkItems` (src/core/search.ts);
// this only shows the list and handles the keys.

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  dropdownOffset,
  moveActiveIndex,
  NODE_LEVEL_NAMES,
  searchNodes,
  searchWorkItems,
  type ArchitectureModel,
  type SearchMatch,
  type WorkItemMatch,
  type WorkItemSummary,
} from '../core';
import { WorkItemIcon } from './WorkItemIcon';

/** Matches listed at most; the rest are summarised ("… and 7 more"). */
const MAX_RESULTS = 12;
/** Of those, the places kept for work items when both nodes and work items match. */
const WORK_ITEM_SHARE = 5;

/** A listed match: a node, or (after the nodes) a work item. */
type Option =
  | { readonly kind: 'node'; readonly match: SearchMatch }
  | { readonly kind: 'workitem'; readonly match: WorkItemMatch };

const NO_ITEMS: readonly WorkItemSummary[] = [];

export interface SearchBoxProps {
  readonly model: ArchitectureModel;
  /** The work items that can be found: those the work-item filter shows. */
  readonly workItems?: readonly WorkItemSummary[] | undefined;
  /** The node the user chose (Enter or click). */
  readonly onChoose: (id: string) => void;
  /** The work item the user chose. */
  readonly onChooseWorkItem: (id: number) => void;
  /** Lets the app focus the box ("/" and Ctrl+K). */
  readonly inputRef: RefObject<HTMLInputElement | null>;
  /**
   * Given while the map is filtered to the focus: whether it leaves a node or a work item out.
   * Such a match is listed all the same, and marked: choosing it shows the whole map again.
   */
  readonly outside?: SearchOutside | undefined;
  /** The box was left by a key (Escape, or Enter on a match): the cursor is nowhere then. */
  readonly onLeave?: (() => void) | undefined;
}

/** What the filtered map leaves out, of what can be found. */
export interface SearchOutside {
  node(id: string): boolean;
  workItem(id: number): boolean;
}

/** Mount with a `key` per loaded file, so that the query does not outlive its model. */
export function SearchBox({
  model,
  workItems = NO_ITEMS,
  onChoose,
  onChooseWorkItem,
  inputRef,
  outside,
  onLeave,
}: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const nodeMatches = useMemo(() => searchNodes(model, query), [model, query]);
  const itemMatches = useMemo(() => searchWorkItems(workItems, query), [workItems, query]);
  // Nodes first; work items keep a share of the list when there are more nodes than fit.
  const shownNodes = nodeMatches.slice(
    0,
    MAX_RESULTS - Math.min(itemMatches.length, WORK_ITEM_SHARE),
  );
  const shownItems = itemMatches.slice(0, MAX_RESULTS - shownNodes.length);
  const shown: Option[] = [
    ...shownNodes.map((match): Option => ({ kind: 'node', match })),
    ...shownItems.map((match): Option => ({ kind: 'workitem', match })),
  ];
  const total = nodeMatches.length + itemMatches.length;
  const listed = open && query.trim() !== '';
  const list = useRef<HTMLUListElement | null>(null);

  // The list starts at the left edge of the box and hangs over the canvas; in a window too
  // narrow for that it is kept inside the window.
  useLayoutEffect(() => {
    if (!listed) return;
    const place = () => {
      const element = list.current;
      const anchor = element?.parentElement?.getBoundingClientRect();
      if (!element || !anchor) return;
      const viewportWidth = document.documentElement.clientWidth;
      element.style.left = `${dropdownOffset(anchor.left, element.offsetWidth, viewportWidth)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [listed]);

  const isOutside = (option: Option): boolean =>
    outside !== undefined &&
    (option.kind === 'node'
      ? outside.node(option.match.id)
      : outside.workItem(option.match.item.id));

  const choose = (option: Option, byKey = false) => {
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
    if (option.kind === 'node') onChoose(option.match.id);
    else onChooseWorkItem(option.match.item.id);
    if (byKey) onLeave?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        setOpen(true);
        setActive((current) =>
          moveActiveIndex(listed ? current : -1, event.key === 'ArrowDown' ? 1 : -1, shown.length),
        );
        break;
      case 'Enter': {
        const match = shown[active] ?? shown[0];
        if (listed && match) {
          event.preventDefault();
          choose(match, true);
        }
        break;
      }
      case 'Escape':
        // First Escape closes the list, the next clears and leaves the box.
        event.preventDefault();
        if (listed) setOpen(false);
        else {
          setQuery('');
          inputRef.current?.blur();
          onLeave?.();
        }
        break;
    }
  };

  const activeId = listed && shown[active] ? `search-option-${active}` : undefined;
  return (
    <div className="search" id="search">
      <input
        ref={inputRef}
        id="search-input"
        type="search"
        role="combobox"
        aria-label="Search nodes by name or ID, work items by #ID or title"
        aria-expanded={listed}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search…  ( / )"
        title="Search nodes by name or ID, work items by #ID or title (shortcut: / or Ctrl+K)"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {listed && (
        <ul
          ref={list}
          id="search-results"
          className="search-results"
          role="listbox"
          aria-label="Matching nodes and work items"
          // Not a stop of the Tab key, which a list that scrolls would otherwise be: the cursor
          // stays in the box, and Tab leaves the search.
          tabIndex={-1}
          data-count={total}
          data-nodes={nodeMatches.length}
          data-workitems={itemMatches.length}
          // Keep the focus in the input: a blur would close the list before the click.
          onMouseDown={(event) => event.preventDefault()}
        >
          {shown.map((option, index) => {
            const leftOut = isOutside(option);
            return (
              <li
                key={option.kind === 'node' ? option.match.id : `#${option.match.item.id}`}
                id={`search-option-${index}`}
                role="option"
                aria-selected={index === active}
                className={`search-option${index === active ? ' search-option-active' : ''}${
                  leftOut ? ' search-option-outside' : ''
                }`}
                data-outside={leftOut ? 'true' : undefined}
                {...(option.kind === 'node'
                  ? { 'data-node-id': option.match.id }
                  : { 'data-workitem-id': option.match.item.id })}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
              >
                {option.kind === 'node' ? (
                  <>
                    <span className="search-option-name">{option.match.name}</span>
                    <span className="search-option-level">
                      {NODE_LEVEL_NAMES[option.match.level]}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="search-option-name">
                      <WorkItemIcon type={option.match.item.type} /> {option.match.item.title}
                    </span>
                    <span className="search-option-level">{option.match.item.type}</span>
                  </>
                )}
                <span className="search-option-more">
                  <span className="search-option-id">
                    {option.kind === 'node'
                      ? option.match.id
                      : `#${option.match.item.id} · ${option.match.item.state}`}
                  </span>
                  {leftOut && <span className="search-option-note">not on the filtered map</span>}
                </span>
              </li>
            );
          })}
          {total === 0 && (
            <li className="search-empty">
              {workItems.length > 0 ? 'No node or work item matches' : 'No node matches'}
            </li>
          )}
          {total > shown.length && (
            <li className="search-empty">… and {total - shown.length} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
