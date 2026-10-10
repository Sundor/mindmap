// The legend of "Colour by": one chip per value of the label, with the number of boxes, or the
// two ends of the ramp of a metric. Sits over the canvas; nothing is drawn when nothing is
// coloured.

import type { CSSProperties } from 'react';
import { boxCountText, legendEntryTitle, NO_VALUE_LABEL, type NodeColoring } from '../core';

export function ColorLegend({ coloring }: { coloring: NodeColoring | undefined }) {
  if (!coloring || coloring.colorBy === 'none' || coloring.legend.length === 0) return null;
  return (
    <div className="color-legend" id="color-legend" data-color-by={coloring.colorBy}>
      <div className="color-legend-title" title={coloring.description}>
        {coloring.title}
      </div>
      {coloring.subtitle !== undefined && (
        <div className="color-legend-subtitle">{coloring.subtitle}</div>
      )}
      {coloring.range ? (
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
            <li
              key={`${entry.kind}:${entry.label}`}
              data-legend-kind={entry.kind}
              data-legend-value={entry.label}
              data-legend-count={entry.count}
              title={legendEntryTitle(entry)}
            >
              <span
                className="color-legend-chip"
                style={
                  {
                    '--tint-light': entry.color.light,
                    '--tint-dark': entry.color.dark,
                  } as CSSProperties
                }
              />
              <span className="color-legend-label">{entry.label}</span>
              {entry.count !== undefined && (
                <span
                  className="color-legend-count"
                  title={boxCountText(entry.count)}
                  aria-label={boxCountText(entry.count)}
                >
                  {entry.count}
                </span>
              )}
            </li>
          ))}
          {coloring.withoutValue > 0 && (
            <li data-legend-kind="none" data-legend-count={coloring.withoutValue}>
              <span className="color-legend-chip color-legend-chip-none" />
              <span className="color-legend-label">{NO_VALUE_LABEL}</span>
              <span
                className="color-legend-count"
                title={boxCountText(coloring.withoutValue)}
                aria-label={boxCountText(coloring.withoutValue)}
              >
                {coloring.withoutValue}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
