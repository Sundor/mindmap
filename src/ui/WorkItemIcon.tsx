// Type icons of the work items: our own small glyphs in the Azure Boards colours.
// One component for the canvas, the panels and the search list; sized by the font size (or by
// `--wi-icon-size` where a fixed size is reserved), coloured through `--wi-*` in styles.css so
// that they read in light and dark mode.

import type { ReactNode } from 'react';
import type { WorkItemType } from '../core';

const SLUG: Readonly<Record<WorkItemType, string>> = {
  'User Story': 'story',
  Task: 'task',
  Bug: 'bug',
  Feature: 'feature',
  Epic: 'epic',
};

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** The glyphs, drawn on a 16 × 16 grid in the colour of the type (`currentColor`). */
const GLYPH: Readonly<Record<WorkItemType, ReactNode>> = {
  // An open book.
  'User Story': (
    <path d="M7.4 3.7C6 2.8 3.9 2.5 1.5 2.8v9.5c2.4-.3 4.5 0 5.9.9zM8.6 3.7c1.4-.9 3.5-1.2 5.9-.9v9.5c-2.4-.3-4.5 0-5.9.9z" />
  ),
  // A clipboard with a check mark.
  Task: (
    <>
      <path d="M5.4 2.6H3.6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-10a1 1 0 0 0-1-1h-1.8v.9a.9.9 0 0 1-.9.9H6.3a.9.9 0 0 1-.9-.9z" />
      <rect x="6.4" y="1" width="3.2" height="2.4" rx="0.7" />
      <path className="wi-icon-mark" d="M5.4 9.5l1.8 1.8 3.5-3.8" />
    </>
  ),
  // A bug: head, body and six legs.
  Bug: (
    <>
      <circle cx="8" cy="4.1" r="1.9" />
      <ellipse cx="8" cy="10.1" rx="3.2" ry="4.1" />
      <path
        {...STROKE}
        d="M5 8.3 2.5 6.9M4.8 10.4H2M5.1 12.4l-2.4 1.5M11 8.3l2.5-1.4M11.2 10.4H14M10.9 12.4l2.4 1.5"
      />
    </>
  ),
  // A trophy: cup, two handles, stem and base.
  Feature: (
    <>
      <path d="M4.6 2h6.8v4.3a3.4 3.4 0 0 1-6.8 0zM7.3 9.3h1.4v2.2H7.3zM5 11.6h6V14H5z" />
      <path
        {...STROKE}
        d="M4.4 3.3H2.7v1a2.2 2.2 0 0 0 2.2 2.2M11.6 3.3h1.7v1a2.2 2.2 0 0 1-2.2 2.2"
      />
    </>
  ),
  // A crown.
  Epic: <path d="M1.7 4.6 5 7.5l3-4.9 3 4.9 3.3-2.9-1.1 6.6H2.8zM2.9 12.3h10.2V14H2.9z" />,
};

export interface WorkItemIconProps {
  readonly type: WorkItemType;
  /** Name the type to assistive technology (default: decorative, the text beside it says it). */
  readonly labelled?: boolean;
}

export function WorkItemIcon({ type, labelled = false }: WorkItemIconProps) {
  return (
    <svg
      className={`wi-icon wi-icon-${SLUG[type]}`}
      viewBox="0 0 16 16"
      data-workitem-type={type}
      focusable="false"
      {...(labelled ? { role: 'img', 'aria-label': type } : { 'aria-hidden': true })}
    >
      {GLYPH[type]}
    </svg>
  );
}
