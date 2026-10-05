// Validation diagnostics (reported with file path + message, never thrown).

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  readonly severity: Severity;
  /** Location in the document, e.g. `domains[1].components[0].id` or `edges[3].to`; '' = root. */
  readonly path: string;
  readonly message: string;
  /** 1-based line of the offending YAML node, when known. */
  readonly line?: number;
  /** 1-based column of the offending YAML node, when known. */
  readonly column?: number;
  /** Name of the file the diagnostic refers to (the `sourceName` passed to the parser). */
  readonly source?: string;
}

/** A path into the parsed YAML: object keys and array indexes. */
export type DocPath = readonly (string | number)[];

/** Formats a path as `domains[1].components[0].id`. */
export function formatPath(path: DocPath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/** One-line rendering, e.g. `architecture.yaml:12:9: error: ... (at edges[3].to)`. */
export function formatDiagnostic(d: Diagnostic): string {
  let location = d.source ?? '';
  if (d.line !== undefined) {
    location += `${location ? ':' : 'line '}${d.line}`;
    if (d.column !== undefined) location += `:${d.column}`;
  }
  const where = d.path ? ` (at ${d.path})` : '';
  return `${location ? `${location}: ` : ''}${d.severity}: ${d.message}${where}`;
}
