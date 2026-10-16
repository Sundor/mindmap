// The icons of the control panel's rail: line drawings in the colour of the text around them.
// They are decoration — the caption under each one is its name.

const ICON_PATHS = {
  map: ['M2.5 2.5h11v11h-11z', 'M2.5 7h4.5v6.5', 'M7 2.5v4.5h6.5'],
  lenses: ['M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11z', 'M8 2.5v11'],
  views: ['M4 2.5h8v11l-4-3-4 3z'],
  files: ['M2 4.5h4l1.5 1.5H14v6.5H2z'],
  /** The level of detail: three layers, one above the other. */
  lod: ['M8 2.5L13.5 5.5L8 8.5L2.5 5.5z', 'M2.5 8.5L8 11.5L13.5 8.5', 'M2.5 11L8 14L13.5 11'],
  search: ['M7 2.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM10.5 10.5l3 3'],
  reload: ['M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3'],
  fit: ['M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'],
  hide: ['M10 3L5 8l5 5'],
  show: ['M6 3l5 5-5 5'],
} as const;

export type PanelIconName = keyof typeof ICON_PATHS;

export function PanelIcon({ name }: { readonly name: PanelIconName }) {
  return (
    <svg
      className="cp-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
