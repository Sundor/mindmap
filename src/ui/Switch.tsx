// A switch between two named positions: a button with `role="switch"`, so Space and Enter
// toggle it. Both names are shown, the one in force emphasised.

export interface SwitchProps {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly offLabel: string;
  readonly onLabel: string;
  /** The accessible name: what "on" means. */
  readonly label: string;
  readonly describedBy?: string;
}

export function Switch({
  id,
  checked,
  onChange,
  offLabel,
  onLabel,
  label,
  describedBy,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-label switch-label-off" aria-hidden="true">
        {offLabel}
      </span>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label switch-label-on" aria-hidden="true">
        {onLabel}
      </span>
    </button>
  );
}
