// Collapsible list of validation errors and warnings: those of the structure file,
// then those of the work items under their own heading, with the tag coverage.

import { useState } from 'react';
import { plural, type AuthoringHint, type Diagnostic, type TagCoverage } from '../core';

function position(d: Diagnostic): string {
  if (d.line === undefined) return '';
  return d.column === undefined ? String(d.line) : `${d.line}:${d.column}`;
}

/** What the panel says about the work items. */
export interface WorkItemDiagnostics {
  /** Name of the file the work items came from. */
  readonly sourceName: string;
  /**
   * How many of the items are linked to the structure. Absent while there is no structure to
   * link them to (the structure file has errors); the problems of the file are shown all the same.
   */
  readonly coverage?: TagCoverage | undefined;
  /** Problems of the file. */
  readonly errors: readonly Diagnostic[];
  /** Problems of the file, tags naming unknown nodes, the items without a `comp:` tag. */
  readonly warnings: readonly Diagnostic[];
}

/**
 * Rows one table shows. A broken export can have a problem in every one of its items; a table
 * of all of them would be too long to read and, far beyond this, too large to draw.
 */
const MAX_ROWS = 500;

function DiagnosticsTable({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  const more = diagnostics.length - MAX_ROWS;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Severity</th>
          <th scope="col">Source</th>
          <th scope="col">Line:col</th>
          <th scope="col">Path</th>
          <th scope="col">Message</th>
        </tr>
      </thead>
      <tbody>
        {diagnostics.slice(0, MAX_ROWS).map((d, i) => (
          <tr key={i} className={`diagnostic diagnostic-${d.severity}`}>
            <td className="diagnostic-severity">{d.severity}</td>
            <td>{d.source ?? ''}</td>
            <td>{position(d)}</td>
            <td className="diagnostic-path">{d.path}</td>
            <td className="diagnostic-message">{d.message}</td>
          </tr>
        ))}
        {more > 0 && (
          <tr className="diagnostic diagnostic-more">
            <td colSpan={5}>… and {more} more, not listed. Fix the ones above and load again.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/**
 * Renders nothing when there is nothing to report: no diagnostics and no work items whose tag
 * coverage to state. Starts open when there are errors (there is no graph to look at then) and
 * collapsed to its badges otherwise. Mount with a `key` per loaded file so that default applies
 * to each file.
 */
export function DiagnosticsPanel({
  errors: structureErrors,
  warnings: structureWarnings,
  workItems,
  hints = [],
}: {
  /** Of the structure file. */
  errors: readonly Diagnostic[];
  warnings: readonly Diagnostic[];
  workItems?: WorkItemDiagnostics | undefined;
  /** What the author could add (src/core/hints.ts); not problems. */
  hints?: readonly AuthoringHint[] | undefined;
}) {
  const errors = [...structureErrors, ...(workItems?.errors ?? [])];
  const warnings = [...structureWarnings, ...(workItems?.warnings ?? [])];
  const [open, setOpen] = useState(errors.length > 0);
  // The coverage is stated whenever there are work items to cover, with or without findings;
  // a file that gave no items (broken, or empty) has none to state.
  const coverage =
    workItems?.coverage && workItems.coverage.total > 0 ? workItems.coverage : undefined;
  if (errors.length === 0 && warnings.length === 0 && !coverage && hints.length === 0) {
    return null;
  }
  const structure = [...structureErrors, ...structureWarnings];
  const work = workItems ? [...workItems.errors, ...workItems.warnings] : [];

  return (
    <section
      id="diagnostics"
      className="diagnostics"
      data-errors={errors.length}
      data-warnings={warnings.length}
      data-hints={hints.length}
      data-open={open}
    >
      <button
        type="button"
        className="diagnostics-toggle"
        aria-expanded={open}
        aria-controls="diagnostics-list"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="diagnostics-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>Diagnostics</span>
        {errors.length > 0 && (
          <span className="badge badge-error">{plural(errors.length, 'error')}</span>
        )}
        {warnings.length > 0 && (
          <span className="badge badge-warning">{plural(warnings.length, 'warning')}</span>
        )}
        {coverage && <span className="badge badge-info">{coverage.percent}% tagged</span>}
        {hints.length > 0 && (
          <span className="badge badge-hint">{plural(hints.length, 'hint')}</span>
        )}
      </button>
      {open && (
        <div id="diagnostics-list" className="diagnostics-list">
          {structure.length > 0 && <DiagnosticsTable diagnostics={structure} />}
          {workItems && (coverage !== undefined || work.length > 0) && (
            <section id="diagnostics-workitems" data-source={workItems.sourceName}>
              <h3 className="diagnostics-heading">Work items — {workItems.sourceName}</h3>
              {coverage && (
                <p
                  id="tag-coverage"
                  className="diagnostics-coverage"
                  data-percent={coverage.percent}
                >
                  Tag coverage {coverage.percent}%: {coverage.tagged} of{' '}
                  {plural(coverage.total, 'work item')}
                  {coverage.hidden > 0 ? ' shown' : ''} linked to the structure by a comp: tag
                  (their own, or for a task that of the item it belongs to).
                  {coverage.hidden > 0
                    ? ` ${plural(coverage.hidden, 'item')} hidden by the work-item filter ${
                        coverage.hidden === 1 ? 'is' : 'are'
                      } not counted.`
                    : ''}
                </p>
              )}
              {work.length > 0 && <DiagnosticsTable diagnostics={work} />}
            </section>
          )}
          {hints.length > 0 && (
            <section id="diagnostics-hints">
              <h3 className="diagnostics-heading">Hints for the author</h3>
              <ul className="diagnostics-hint-list">
                {hints.map((hint) => (
                  <li key={hint.kind} className="diagnostic-hint" data-hint={hint.kind}>
                    {hint.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
