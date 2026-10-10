// The Export section of the Files tab: three buttons that save the map as it is drawn — as a
// picture (PNG), a vector drawing (SVG) or a web page (HTML) —, the choices that go with them,
// and what became of the last export.

import { useState } from 'react';
import {
  EXPORT_AREAS,
  EXPORT_FORMATS,
  EXPORT_SCHEMES,
  EXPORT_TEXTS,
  exportBlocked,
  outcomeText,
  PNG_SCALES,
  readExportChoices,
  writeExportChoices,
  type ExportArea,
  type ExportChoices,
  type ExportFormat,
  type ExportOutcome,
  type ExportScheme,
} from '../core';
import { afterNextPaint } from './afterNextPaint';
import { browserStorage } from './browserStorage';

export interface ExportSectionProps {
  /** A layout is on its way: the buttons wait. */
  readonly pending: boolean;
  /** Something is selected on the map: said under the choices. */
  readonly selection: boolean;
  /** Edges on demand holds edges back: said under the choices. */
  readonly edgesHeldBack: boolean;
  /** The Files tab is the one shown; the status goes when it is left. */
  readonly active: boolean;
  /**
   * Makes the file and hands it to the browser. Rejects with an Error whose message is the
   * sentence to show.
   */
  readonly onExport: (format: ExportFormat, choices: ExportChoices) => Promise<ExportOutcome>;
}

/** What became of the last export, or that one is running. */
type ExportStatus =
  | { readonly state: 'working' | 'failed'; readonly text: string }
  | {
      readonly state: 'saved';
      readonly text: string;
      readonly outcome: ExportOutcome;
      /** Whole milliseconds the export took, from the status being on screen to the file. */
      readonly ms: number;
    };

const FORMAT_TITLES: Readonly<Record<ExportFormat, string>> = {
  png: EXPORT_TEXTS.pngTitle,
  svg: EXPORT_TEXTS.svgTitle,
  html: EXPORT_TEXTS.htmlTitle,
};

const AREA_TEXTS: Readonly<Record<ExportArea, string>> = {
  map: EXPORT_TEXTS.areaMap,
  view: EXPORT_TEXTS.areaView,
};

const SCHEME_TEXTS: Readonly<Record<ExportScheme, string>> = {
  screen: EXPORT_TEXTS.schemeScreen,
  light: EXPORT_TEXTS.schemeLight,
  dark: EXPORT_TEXTS.schemeDark,
};

/** The one of `values` that `text` — the value of a list — names; undefined for any other text. */
function named<T extends string | number>(values: readonly T[], text: string): T | undefined {
  return values.find((value) => String(value) === text);
}

/**
 * What became of the export `work` makes. It starts once the browser has painted: making the
 * picture blocks the main thread, and the status that announces it is on screen first. Never
 * rejects.
 */
async function exported(work: () => Promise<ExportOutcome>): Promise<ExportStatus> {
  await afterNextPaint();
  const started = performance.now();
  try {
    const outcome = await work();
    const ms = Math.round(performance.now() - started);
    return { state: 'saved', text: outcomeText(outcome), outcome, ms };
  } catch (error) {
    return { state: 'failed', text: error instanceof Error ? error.message : String(error) };
  }
}

export function ExportSection({
  pending,
  selection,
  edgesHeldBack,
  active,
  onExport,
}: ExportSectionProps) {
  const [choices, setChoices] = useState(() => readExportChoices(browserStorage()));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ExportStatus>();
  /** Exports finished, saved or not, since the section was mounted. */
  const [count, setCount] = useState(0);
  // Adjusted while rendering (not in an effect), so the tab never comes back with a stale
  // status. That an export is running stays true while the tab is away.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active && status?.state !== 'working') setStatus(undefined);
  }

  const choose = (change: Partial<ExportChoices>) => {
    const next = { ...choices, ...change };
    setChoices(next);
    writeExportChoices(browserStorage(), next);
  };

  const run = async (format: ExportFormat) => {
    setBusy(true);
    setStatus({ state: 'working', text: EXPORT_TEXTS.working });
    setStatus(await exported(() => onExport(format, choices)));
    setCount((finished) => finished + 1);
    setBusy(false);
  };

  const blocked = exportBlocked({ pending, busy });
  const saved = status?.state === 'saved' ? status : undefined;
  const png = saved?.outcome.png;
  const hints: string[] = [];
  if (selection) hints.push(EXPORT_TEXTS.selection);
  if (edgesHeldBack) hints.push(EXPORT_TEXTS.onDemand);
  return (
    <section className="settings-group" id="export" aria-labelledby="export-title">
      <h3 className="cp-section-title" id="export-title">
        {EXPORT_TEXTS.heading}
      </h3>
      <div className="cp-actions">
        {EXPORT_FORMATS.map((format) => (
          <button
            key={format}
            type="button"
            id={`export-${format}`}
            disabled={blocked !== undefined}
            title={blocked ?? FORMAT_TITLES[format]}
            onClick={() => void run(format)}
          >
            {format.toUpperCase()}
          </button>
        ))}
      </div>
      <label className="settings-row">
        <span className="settings-label">{EXPORT_TEXTS.area}</span>
        <select
          id="export-area"
          value={choices.area}
          onChange={(event) =>
            choose({ area: named(EXPORT_AREAS, event.target.value) ?? choices.area })
          }
        >
          {EXPORT_AREAS.map((area) => (
            <option key={area} value={area}>
              {AREA_TEXTS[area]}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-row">
        <span className="settings-label">{EXPORT_TEXTS.scheme}</span>
        <select
          id="export-scheme"
          value={choices.scheme}
          onChange={(event) =>
            choose({ scheme: named(EXPORT_SCHEMES, event.target.value) ?? choices.scheme })
          }
        >
          {EXPORT_SCHEMES.map((scheme) => (
            <option key={scheme} value={scheme}>
              {SCHEME_TEXTS[scheme]}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-row">
        <span className="settings-label">{EXPORT_TEXTS.scale}</span>
        <select
          id="export-scale"
          title={EXPORT_TEXTS.scaleTitle}
          value={choices.scale}
          onChange={(event) =>
            choose({ scale: named(PNG_SCALES, event.target.value) ?? choices.scale })
          }
        >
          {PNG_SCALES.map((scale) => (
            <option key={scale} value={scale}>
              {scale}×
            </option>
          ))}
        </select>
      </label>
      <label className="settings-row settings-check">
        <input
          type="checkbox"
          id="export-caption"
          checked={choices.caption}
          onChange={(event) => choose({ caption: event.target.checked })}
        />
        <span>{EXPORT_TEXTS.caption}</span>
      </label>
      {status && (
        <small
          className="settings-note"
          id="export-status"
          role="status"
          data-state={status.state}
          data-count={count}
          data-format={saved?.outcome.format}
          data-name={saved?.outcome.name}
          data-bytes={saved?.outcome.bytes}
          data-width={saved?.outcome.width}
          data-height={saved?.outcome.height}
          data-scale={png?.scale.toFixed(4)}
          data-reduced={png && String(png.reduced)}
          data-nodes={saved?.outcome.nodes}
          data-edges={saved?.outcome.edges}
          data-ms={saved?.ms}
        >
          {status.text}
        </small>
      )}
      {hints.length > 0 && (
        <small className="settings-note" id="export-hint">
          {hints.join(' ')}
        </small>
      )}
      <small className="settings-note" id="export-note">
        {EXPORT_TEXTS.note}
      </small>
    </section>
  );
}
