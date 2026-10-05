// The legend of "Colour by": one chip per value of the attribute, or the two ends
// of the ramp of a metric. Sits over the canvas; nothing is drawn when nothing is coloured.

import type { CSSProperties } from 'react';
import { metricOf, type NodeColoring } from '../core';

export function ColorLegend({ coloring }: { coloring: NodeColoring | undefined }) {
  if (!coloring || coloring.colorBy === 'none' || coloring.legend.length === 0) return null;
  const metric = metricOf(coloring.colorBy);
  const title = metric ?? coloring.colorBy.charAt(0).toUpperCase() + coloring.colorBy.slice(1);
  return (
    <div className="color-legend" id="color-legend" data-color-by={coloring.colorBy}>
      <div className="color-legend-title">{title}</div>
      {metric !== undefined && coloring.range ? (
        <div className="color-legend-ramp">
          <span>{coloring.legend[0]?.label}</span>
          <span
            className="color-legend-gradient"
            style={
              {
                '--tint-light': coloring.legend[0]?.color.light,
                '--tint-dark': coloring.legend[0]?.color.dark,
                '--tint-light-end': coloring.legend[1]?.color.light,
                '--tint-dark-end': coloring.legend[1]?.color.dark,
              } as CSSProperties
            }
          />
          <span>{coloring.legend[1]?.label}</span>
        </div>
      ) : (
        <ul className="color-legend-list">
          {coloring.legend.map((entry) => (
            <li key={entry.label} data-legend-value={entry.label}>
              <span
                className="color-legend-chip"
                style={
                  {
                    '--tint-light': entry.color.light,
                    '--tint-dark': entry.color.dark,
                  } as CSSProperties
                }
              />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
