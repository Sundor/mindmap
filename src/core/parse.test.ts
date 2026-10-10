import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL_COLORS,
  editDistance,
  effectiveAttribute,
  labelNames,
  OTHER_COLOR,
  parseArchitecture,
  suggest,
  type Diagnostic,
  type ParseResult,
} from './index';

/** Strips the common leading indentation so YAML can be written inline in tests. */
function yaml(strings: TemplateStringsArray, ...values: unknown[]): string {
  const text = String.raw({ raw: strings }, ...values).replace(/^\n/, '');
  const indents = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  const indent = Math.min(...indents);
  return text
    .split('\n')
    .map((line) => line.slice(indent))
    .join('\n');
}

/** Two domains, two components, one subcomponent — the base for most variations. */
const DOMAINS = yaml`
  domains:
    - id: ingest
      name: Ingest
      components:
        - id: ingest.reader
          name: Reader
          subcomponents:
            - id: ingest.reader.parser
              name: Parser
        - id: ingest.queue
          name: Queue
    - id: api
      name: API
      components:
        - id: api.gateway
          name: Gateway
`;

function file(body: string, edges = ''): string {
  return `version: 1\n${body}${edges ? `edges:\n${edges}` : ''}`;
}

function edge(id: string, from: string, to: string, kind = 'dataflow'): string {
  return `  - id: ${id}\n    from: ${from}\n    to: ${to}\n    kind: ${kind}\n`;
}

function errorAt(result: ParseResult, path: string): Diagnostic {
  const found = result.errors.find((d) => d.path === path);
  if (!found) {
    const all = result.errors.map((d) => `${d.path}: ${d.message}`).join('\n');
    throw new Error(`no error at ${path}; errors:\n${all}`);
  }
  return found;
}

function expectClean(result: ParseResult): NonNullable<ParseResult['model']> {
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.model).not.toBeNull();
  if (!result.model) throw new Error('unreachable');
  return result.model;
}

describe('parseArchitecture: valid input', () => {
  it('builds a flat node map with level, parentId and ordered childIds', () => {
    const model = expectClean(
      parseArchitecture(file(DOMAINS, edge('e1', 'ingest.reader.parser', 'ingest.queue'))),
    );
    expect(model.version).toBe(1);
    expect(model.rootIds).toEqual(['ingest', 'api']);
    expect([...model.nodes.keys()]).toEqual([
      'ingest',
      'ingest.reader',
      'ingest.reader.parser',
      'ingest.queue',
      'api',
      'api.gateway',
    ]);
    expect(model.nodes.get('ingest')).toEqual({
      id: 'ingest',
      name: 'Ingest',
      level: 0,
      childIds: ['ingest.reader', 'ingest.queue'],
    });
    expect(model.nodes.get('ingest.reader')).toMatchObject({
      level: 1,
      parentId: 'ingest',
      childIds: ['ingest.reader.parser'],
    });
    expect(model.nodes.get('ingest.reader.parser')).toMatchObject({
      level: 2,
      parentId: 'ingest.reader',
      childIds: [],
    });
    expect(model.nodes.get('ingest')?.parentId).toBeUndefined();
    expect(model.rows).toEqual([]);
    expect(model.edges).toEqual([
      { id: 'e1', from: 'ingest.reader.parser', to: 'ingest.queue', kind: 'dataflow' },
    ]);
  });

  it('keeps optional descriptions, labels and protocols', () => {
    const model = expectClean(
      parseArchitecture(
        yaml`
          version: 1
          domains:
            - id: a
              name: A
              description: The A domain
            - id: b
              name: B
          edges:
            - id: a-b
              from: a
              to: b
              kind: control
              label: commands
              protocol: gRPC
              description: Why A drives B
        `,
      ),
    );
    expect(model.nodes.get('a')?.description).toBe('The A domain');
    expect(model.edges[0]).toEqual({
      id: 'a-b',
      from: 'a',
      to: 'b',
      kind: 'control',
      label: 'commands',
      protocol: 'gRPC',
      description: 'Why A drives B',
    });
  });

  it('accepts an empty domain list and a file without edges', () => {
    const model = expectClean(parseArchitecture('version: 1\ndomains: []\n'));
    expect(model.nodes.size).toBe(0);
    expect(model.edges).toEqual([]);
  });

  it('keeps node and edge IDs in separate namespaces', () => {
    expectClean(parseArchitecture(file(DOMAINS, edge('ingest', 'ingest', 'api'))));
  });

  it('accepts every edge kind', () => {
    const edges = ['dataflow', 'dependency', 'control', 'config']
      .map((kind, i) => edge(`e${i}`, 'ingest', 'api', kind))
      .join('');
    expect(expectClean(parseArchitecture(file(DOMAINS, edges))).edges).toHaveLength(4);
  });
});

describe('parseArchitecture: never throws', () => {
  it.each([
    ['empty input', ''],
    ['whitespace only', '  \n\n'],
    ['a comment only', '# nothing here\n'],
    ['explicit null', 'null\n'],
    ['a scalar root', 'hello\n'],
    ['a list root', '- version: 1\n'],
    ['a YAML syntax error', 'version: 1\ndomains: [\n'],
    ['plain text', 'This is not YAML: at all: really\n'],
  ])('%s becomes an error', (_, text) => {
    const result = parseArchitecture(text);
    expect(result.model).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('reports a non-string argument instead of throwing', () => {
    const result = parseArchitecture(42 as unknown as string);
    expect(result.model).toBeNull();
    expect(result.errors[0]?.message).toMatch(/Expected YAML text/);
  });

  it('reports the empty file clearly', () => {
    const result = parseArchitecture('');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/empty/);
  });

  it('reports a YAML syntax error with its line number', () => {
    const result = parseArchitecture('version: 1\ndomains:\n  - id: a\n    name: "unterminated\n');
    expect(result.model).toBeNull();
    expect(result.errors[0]?.line).toBeGreaterThanOrEqual(4);
    expect(result.errors[0]?.message).not.toMatch(/\n/);
  });

  it('reports duplicate YAML keys', () => {
    const result = parseArchitecture('version: 1\nversion: 1\ndomains: []\n');
    expect(result.model).toBeNull();
    expect(result.errors[0]?.line).toBe(2);
  });

  it('rejects a list where a mapping is expected', () => {
    const result = parseArchitecture('version: 1\ndomains:\n  - just a string\n');
    expect(errorAt(result, 'domains[0]').message).toMatch(/must be a mapping/);
  });
});

describe('parseArchitecture: file shape', () => {
  it('rejects a wrong version', () => {
    const result = parseArchitecture(`version: 2\n${DOMAINS}`);
    expect(result.model).toBeNull();
    const d = errorAt(result, 'version');
    expect(d.message).toMatch(/Unsupported version 2/);
    expect(d.line).toBe(1);
  });

  it('requires version and domains', () => {
    const result = parseArchitecture('edges: []\n');
    expect(errorAt(result, 'version').message).toMatch(/Missing required field "version"/);
    expect(errorAt(result, 'domains').message).toMatch(/Missing required field "domains"/);
  });

  it('requires id and name on nodes', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - name: No ID
          - id: noname
      `,
    );
    expect(errorAt(result, 'domains[0].id').message).toMatch(/Missing required field "id"/);
    expect(errorAt(result, 'domains[1].name').message).toMatch(/Missing required field "name"/);
  });

  it('rejects names that are only whitespace, and trims the others', () => {
    const blank = parseArchitecture(
      'version: 1\nrows:\n  - {id: r1, name: "  "}\ndomains:\n  - {id: a, name: "   ", row: r1}\n',
    );
    expect(blank.model).toBeNull();
    expect(errorAt(blank, 'rows[0].name').message).toMatch(/must not be empty/);
    expect(errorAt(blank, 'domains[0].name').message).toMatch(/must not be empty/);

    const padded = parseArchitecture(
      'version: 1\nrows:\n  - {id: r1, name: " Top "}\ndomains:\n  - {id: a, name: "  Alpha ", row: r1}\n',
    );
    expect(padded.errors).toEqual([]);
    expect(padded.model?.nodes.get('a')?.name).toBe('Alpha');
    expect(padded.model?.rows[0]?.name).toBe('Top');
  });

  it('reports a file with several YAML documents in its own words', () => {
    const result = parseArchitecture('version: 1\ndomains: []\n---\nversion: 1\ndomains: []\n');
    expect(result.model).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe(
      'The file contains several YAML documents (separated by "---"); only one is supported',
    );
    expect(result.errors[0]?.message).not.toMatch(/parseAllDocuments/);
    expect(result.errors[0]?.line).toBe(3);
  });

  it('rejects an empty name and non-string fields', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: a
            name: ""
          - id: b
            name: [x]
      `,
    );
    expect(errorAt(result, 'domains[0].name').message).toMatch(/must not be empty/);
    expect(errorAt(result, 'domains[1].name').message).toMatch(/must be text, but got a list/);
  });

  it('warns about unknown keys, with a suggestion, and still returns the model', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: a
            name: A
            descripton: typo
      `,
      { sourceName: 'arch.yaml' },
    );
    expect(result.errors).toEqual([]);
    expect(result.model).not.toBeNull();
    expect(result.warnings).toEqual([
      {
        severity: 'warning',
        path: 'domains[0].descripton',
        message: 'Unknown key "descripton" in domain "a" (ignored); did you mean "description"?',
        line: 5,
        column: 5,
        source: 'arch.yaml',
      },
    ]);
  });

  it('warns about unknown keys at the top level and on edges', () => {
    const result = parseArchitecture(
      `${file(DOMAINS, `${edge('e1', 'ingest', 'api')}    lable: x\n`)}extra: 1\n`,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.path)).toEqual(['edges[0].lable', 'extra']);
  });

  it('only warns about an empty node list at the wrong level (nothing is lost)', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: a
            name: A
            components:
              - id: a.b
                name: B
                subcomponents:
                  - id: a.b.c
                    name: C
                    subcomponents: []
      `,
    );
    expect(result.errors).toEqual([]);
    expect(result.model).not.toBeNull();
    expect(result.warnings.map((w) => w.path)).toEqual([
      'domains[0].components[0].subcomponents[0].subcomponents',
    ]);
  });

  it('rejects nodes nested at the wrong level instead of silently dropping them', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        components:
          - id: x
            name: X
        domains:
          - id: a
            name: A
            subcomponents:
              - id: a.x
                name: X
                subcomponents:
                  - id: a.x.y
                    name: Y
            components:
              - id: a.b
                name: B
                subcomponents:
                  - id: a.b.c
                    name: C
                    subcomponents:
                      - id: a.b.c.d
                        name: D
      `,
    );
    expect(result.model).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.errors.map((e) => [e.path, e.line])).toEqual([
      ['components', 2],
      ['domains[0].subcomponents', 8],
      ['domains[0].components[0].subcomponents[0].subcomponents', 20],
    ]);
    expect(errorAt(result, 'components').message).toContain('the file lists its domains');
    expect(errorAt(result, 'domains[0].subcomponents').message).toBe(
      '"subcomponents" is not allowed in domain "a": the hierarchy is domains → components → subcomponents, and a domain lists its children under "components"; 2 nodes under it would be left out of the map',
    );
    expect(
      errorAt(result, 'domains[0].components[0].subcomponents[0].subcomponents').message,
    ).toContain('a subcomponent has no children; 1 node under it');
  });

  it('keeps ordinary typos of node-list keys as warnings', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: a
            name: A
            component:
              - id: a.b
                name: B
      `,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.message)).toEqual([
      'Unknown key "component" in domain "a" (ignored); did you mean "components"?',
    ]);
  });

  it('treats empty optional keys (YAML null) as absent', () => {
    const model = expectClean(
      parseArchitecture(
        yaml`
          version: 1
          rows:
          domains:
            - id: a
              name: A
              description:
              row:
              components:
            - id: b
              name: B
              components:
                - id: b.c
                  name: C
                  subcomponents:
          edges:
        `,
      ),
    );
    expect(model.rows).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.nodes.get('a')).toEqual({ id: 'a', name: 'A', level: 0, childIds: [] });
    expect(model.nodes.get('b.c')?.childIds).toEqual([]);

    const edgeModel = expectClean(
      parseArchitecture(
        `${file(DOMAINS, `${edge('e1', 'ingest', 'api')}    label:\n    protocol:\n    description:\n`)}`,
      ),
    );
    expect(edgeModel.edges).toEqual([{ id: 'e1', from: 'ingest', to: 'api', kind: 'dataflow' }]);
  });

  it('treats an empty rows: section as no rows section', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        rows:
        domains:
          - id: a
            name: A
            row: top
      `,
    );
    expect(errorAt(result, 'domains[0].row').message).toContain('has no top-level "rows:" section');
  });

  it('still requires domains to be a list', () => {
    const result = parseArchitecture('version: 1\ndomains:\n');
    expect(errorAt(result, 'domains').message).toBe(
      '"domains" of the file must be a list, but got an empty value',
    );
  });

  it('locates unknown non-string keys at the key itself', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: a
            name: A
            1: x
      `,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toMatchObject([{ path: 'domains[0].1', line: 5, column: 5 }]);
  });
});

describe('parseArchitecture: IDs', () => {
  it('rejects duplicate node IDs across the whole tree', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: a
            name: A
            components:
              - id: a.x
                name: X
              - id: a.x
                name: X again
          - id: a
            name: A again
      `,
    );
    expect(result.model).toBeNull();
    expect(errorAt(result, 'domains[0].components[1].id').message).toBe(
      'Duplicate node ID "a.x" (first defined at domains[0].components[0])',
    );
    expect(errorAt(result, 'domains[1].id').message).toMatch(/Duplicate node ID "a"/);
  });

  it('rejects duplicate edge IDs', () => {
    const result = parseArchitecture(
      file(DOMAINS, edge('e1', 'ingest', 'api') + edge('e1', 'api', 'ingest')),
    );
    expect(result.model).toBeNull();
    expect(errorAt(result, 'edges[1].id').message).toBe(
      'Duplicate edge ID "e1" (first defined at edges[0])',
    );
  });

  it('rejects a component not prefixed by its domain', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: ingest
            name: Ingest
            components:
              - id: api.reader
                name: Reader
      `,
    );
    const d = errorAt(result, 'domains[0].components[0].id');
    expect(d.message).toMatch(/must start with its domain's ID "ingest"/);
    expect(d.message).toMatch(/"ingest\.reader"/);
    expect(d.line).toBe(6);
  });

  it('rejects a prefix that only matches as a string, not as a segment', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: ingest
            name: Ingest
            components:
              - id: ingestion.reader
                name: Reader
      `,
    );
    expect(errorAt(result, 'domains[0].components[0].id').message).toMatch(/must start with/);
  });

  it('rejects a subcomponent with the wrong parent prefix', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: ingest
            name: Ingest
            components:
              - id: ingest.reader
                name: Reader
                subcomponents:
                  - id: ingest.queue.parser
                    name: Parser
      `,
    );
    expect(errorAt(result, 'domains[0].components[0].subcomponents[0].id').message).toMatch(
      /must start with its component's ID "ingest\.reader"/,
    );
  });

  it('rejects extra segments', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: ingest.core
            name: Ingest
          - id: api
            name: API
            components:
              - id: api.gateway.v2
                name: Gateway
      `,
    );
    expect(errorAt(result, 'domains[0].id').message).toMatch(/must be a single segment/);
    expect(errorAt(result, 'domains[1].components[0].id').message).toMatch(/too many segments/);
  });

  it.each([
    ['Ingest', 'uppercase'],
    ['in gest', 'a space'],
    ['ingest!', 'punctuation'],
    ['-ingest', 'a leading dash'],
    ['in--gest', 'a double dash'],
    ['ingest_', 'a trailing underscore'],
    ['ingest..reader', 'an empty segment'],
    ['', 'nothing'],
  ])('rejects the ID %j (%s)', (id) => {
    const result = parseArchitecture(`version: 1\ndomains:\n  - id: "${id}"\n    name: X\n`);
    expect(result.model).toBeNull();
    expect(errorAt(result, 'domains[0].id').message).toMatch(/Invalid domain ID/);
  });

  it('accepts digits, dashes and underscores within segments', () => {
    expectClean(
      parseArchitecture(
        yaml`
          version: 1
          domains:
            - id: api-2
              name: API
              components:
                - id: api-2.io_scan
                  name: IO
        `,
      ),
    );
  });

  it('rejects invalid edge IDs', () => {
    const result = parseArchitecture(file(DOMAINS, edge('E1', 'ingest', 'api')));
    expect(errorAt(result, 'edges[0].id').message).toMatch(/Invalid edge ID "E1"/);
  });
});

describe('parseArchitecture: edges', () => {
  it('rejects a dangling "from" with a suggestion', () => {
    const result = parseArchitecture(file(DOMAINS, edge('e1', 'ingest.reder', 'api')));
    expect(result.model).toBeNull();
    const d = errorAt(result, 'edges[0].from');
    expect(d.message).toBe(
      'Edge "e1": "from" refers to unknown node "ingest.reder"; did you mean "ingest.reader"?',
    );
    expect(d.line).toBe(20);
  });

  it('rejects a dangling "to" and suggests the full ID for a bare last segment', () => {
    const result = parseArchitecture(file(DOMAINS, edge('e1', 'ingest', 'gateway')));
    expect(errorAt(result, 'edges[0].to').message).toMatch(/did you mean "api\.gateway"\?/);
  });

  it('gives no suggestion when nothing is close', () => {
    const result = parseArchitecture(file(DOMAINS, edge('e1', 'ingest', 'warehouse')));
    expect(errorAt(result, 'edges[0].to').message).not.toMatch(/did you mean/);
  });

  it('rejects self-edges', () => {
    const result = parseArchitecture(file(DOMAINS, edge('e1', 'ingest.queue', 'ingest.queue')));
    expect(result.model).toBeNull();
    expect(errorAt(result, 'edges[0].to').message).toMatch(/to itself/);
  });

  it('rejects an invalid kind and lists the allowed kinds', () => {
    const result = parseArchitecture(file(DOMAINS, edge('e1', 'ingest', 'api', 'flows')));
    expect(errorAt(result, 'edges[0].kind').message).toBe(
      'Invalid edge kind "flows" in edge "e1"; allowed kinds: dataflow, dependency, control, config',
    );
  });

  it('requires kind', () => {
    const result = parseArchitecture(file(DOMAINS, '  - id: e1\n    from: ingest\n    to: api\n'));
    expect(errorAt(result, 'edges[0].kind').message).toMatch(
      /Missing required field "kind" in edge "e1" \(one of: dataflow/,
    );
  });

  it('warns on duplicate (from, to, kind) and still returns the model', () => {
    const result = parseArchitecture(
      file(
        DOMAINS,
        edge('e1', 'ingest', 'api') +
          edge('e2', 'ingest', 'api') +
          edge('e3', 'ingest', 'api', 'control') +
          edge('e4', 'api', 'ingest'),
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.model?.edges).toHaveLength(4);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ severity: 'warning', path: 'edges[1]' });
    expect(result.warnings[0]?.message).toMatch(/duplicates edge "e1"/);
  });
});

describe('parseArchitecture: diagnostics', () => {
  it('reports many problems together, in document order', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: Ingest
            name: Ingest
            colour: red
          - id: api
            components:
              - id: gateway
                name: Gateway
        edges:
          - id: e1
            from: ingest
            to: ingest
            kind: flow
          - id: e1
            from: api
            to: nowhere
            kind: control
      `,
    );
    expect(result.model).toBeNull();
    expect(result.errors.map((d) => d.path)).toEqual([
      'domains[0].id',
      'domains[1].name',
      'domains[1].components[0].id',
      'edges[0].from',
      'edges[0].to',
      'edges[0].to',
      'edges[0].kind',
      'edges[1].id',
      'edges[1].to',
    ]);
    expect(result.warnings.map((d) => d.path)).toEqual(['domains[0].colour']);
    for (const d of [...result.errors, ...result.warnings]) {
      expect(d.line).toBeGreaterThan(0);
      expect(d.column).toBeGreaterThan(0);
    }
  });

  it('does not cascade: a node with a missing name still resolves edge references', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: a
          - id: b
            name: B
        edges:
          - id: e1
            from: a
            to: b
            kind: dataflow
      `,
    );
    expect(result.errors.map((d) => d.path)).toEqual(['domains[0].name']);
  });

  it('attaches the source name to every diagnostic', () => {
    const result = parseArchitecture('version: 3\n', { sourceName: 'repo/architecture.yaml' });
    expect(result.errors.length).toBeGreaterThan(0);
    for (const d of result.errors) expect(d.source).toBe('repo/architecture.yaml');
  });
});

describe('parseArchitecture: rows', () => {
  const ROWS = yaml`
    rows:
      - id: top
        name: Top level
        description: Tools
      - id: mid
        name: Middle level
      - id: bottom
        name: Bottom level
  `;

  function withRows(domains: string): ParseResult {
    return parseArchitecture(`version: 1
${ROWS}${domains}`);
  }

  it('preserves row order and inherits rows down the tree', () => {
    const model = expectClean(
      withRows(yaml`
        domains:
          - id: be
            name: Backend
            row: bottom
            components:
              - id: be.api
                name: API
                subcomponents:
                  - id: be.api.io
                    name: IO
      `),
    );
    expect(model.rows).toEqual([
      { id: 'top', name: 'Top level', description: 'Tools' },
      { id: 'mid', name: 'Middle level' },
      { id: 'bottom', name: 'Bottom level' },
    ]);
    expect(model.nodes.get('be')).toMatchObject({
      row: 'bottom',
      effectiveRow: 'bottom',
      rowRange: { top: 2, bottom: 2 },
    });
    const io = model.nodes.get('be.api.io');
    expect(io?.row).toBeUndefined();
    expect(io?.effectiveRow).toBe('bottom');
    expect(io?.rowRange).toEqual({ top: 2, bottom: 2 });
  });

  it('computes spanning ranges, including nested spans, and leaves unassigned subtrees undefined', () => {
    const model = expectClean(
      withRows(yaml`
        domains:
          - id: ops
            name: Operations
            components:
              - id: ops.console
                name: Console
                row: top
              - id: ops.analytics
                name: Analytics
                subcomponents:
                  - id: ops.analytics.dash
                    name: Dashboards
                    row: top
                  - id: ops.analytics.model
                    name: Models
                    row: mid
                  - id: ops.analytics.store
                    name: Store
              - id: ops.collector
                name: Collector
                row: bottom
              - id: ops.alerts
                name: Alerts
          - id: platform
            name: Platform
            components:
              - id: platform.logging
                name: Logging
      `),
    );
    const range = (id: string) => model.nodes.get(id)?.rowRange;
    expect(range('ops')).toEqual({ top: 0, bottom: 2 });
    expect(range('ops.analytics')).toEqual({ top: 0, bottom: 1 });
    expect(range('ops.analytics.dash')).toEqual({ top: 0, bottom: 0 });
    expect(range('ops.analytics.store')).toBeUndefined();
    expect(range('ops.alerts')).toBeUndefined();
    expect(range('platform')).toBeUndefined();
    expect(range('platform.logging')).toBeUndefined();
    expect(model.nodes.get('ops')?.effectiveRow).toBeUndefined();
    expect(model.nodes.get('ops.analytics.store')?.effectiveRow).toBeUndefined();
    expect('rowRange' in (model.nodes.get('platform') ?? {})).toBe(false);
  });

  it('allows a child to repeat its ancestor row', () => {
    const model = expectClean(
      withRows(yaml`
        domains:
          - id: be
            name: HW
            row: bottom
            components:
              - id: be.api
                name: API
                row: bottom
      `),
    );
    expect(model.nodes.get('be.api')).toMatchObject({ row: 'bottom', effectiveRow: 'bottom' });
  });

  it('rejects a child whose row conflicts with an ancestor row', () => {
    const result = withRows(yaml`
      domains:
        - id: be
          name: HW
          row: bottom
          components:
            - id: be.api
              name: API
              subcomponents:
                - id: be.api.ui
                  name: UI
                  row: top
    `);
    expect(result.model).toBeNull();
    const d = errorAt(result, 'domains[0].components[0].subcomponents[0].row');
    expect(d.message).toMatch(/row "top", but "be" puts it in row "bottom"/);
    expect(d.message).toMatch(/a group with a row keeps all its contents in that row/);
  });

  it('rejects an unknown row reference with a suggestion', () => {
    const result = withRows(yaml`
      domains:
        - id: be
          name: HW
          row: botom
    `);
    expect(result.model).toBeNull();
    expect(errorAt(result, 'domains[0].row').message).toMatch(
      /Unknown row "botom" on domain "be"; did you mean "bottom"\?/,
    );
  });

  it('rejects row: when the file has no rows section', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        domains:
          - id: be
            name: HW
            row: bottom
      `,
    );
    expect(result.model).toBeNull();
    expect(errorAt(result, 'domains[0].row').message).toMatch(/no top-level "rows:" section/);
  });

  it('rejects duplicate and invalid row IDs', () => {
    const result = parseArchitecture(
      yaml`
        version: 1
        rows:
          - id: top
            name: Top
          - id: top
            name: Top again
          - id: mid.level
            name: Middle
          - id: bottom
        domains: []
      `,
    );
    expect(result.model).toBeNull();
    expect(errorAt(result, 'rows[1].id').message).toBe(
      'Duplicate row ID "top" (first defined at rows[0])',
    );
    expect(errorAt(result, 'rows[2].id').message).toMatch(/Invalid row ID "mid\.level"/);
    expect(errorAt(result, 'rows[3].name').message).toMatch(/Missing required field "name"/);
  });

  it('keeps row IDs in their own namespace', () => {
    const model = expectClean(
      withRows(yaml`
        domains:
          - id: top
            name: Top domain
            row: top
      `),
    );
    expect(model.nodes.get('top')?.effectiveRow).toBe('top');
  });
});

describe('parseArchitecture: node attributes, links and metrics', () => {
  const body = yaml`
    domains:
      - id: shop
        name: Shop
        owner: ' Team Blue '
        status: live
        tech: .NET
        links:
          - label: Source
            url: https://example.com/src/shop
          - url: https://example.com/docs
        metrics:
          loc: 12000
          coverage: 81.5
        components:
          - id: shop.catalog
            name: Catalog
            owner: Team Red
  `;

  it('reads them, trimmed, and resolves the inherited ones', () => {
    const model = expectClean(parseArchitecture(file(body)));
    const shop = model.nodes.get('shop');
    expect(shop).toMatchObject({ owner: 'Team Blue', status: 'live', tech: '.NET' });
    expect(shop?.links).toEqual([
      { label: 'Source', url: 'https://example.com/src/shop' },
      { label: 'https://example.com/docs', url: 'https://example.com/docs' },
    ]);
    expect([...(shop?.metrics ?? [])]).toEqual([
      ['loc', 12000],
      ['coverage', 81.5],
    ]);
    const catalog = model.nodes.get('shop.catalog');
    expect(catalog?.owner).toBe('Team Red');
    expect(catalog?.status).toBeUndefined();
    expect(effectiveAttribute(model, 'shop.catalog', 'owner')).toEqual({
      value: 'Team Red',
      from: 'shop.catalog',
    });
    expect(effectiveAttribute(model, 'shop.catalog', 'status')).toEqual({
      value: 'live',
      from: 'shop',
    });
    expect(effectiveAttribute(model, 'shop.catalog', 'tech')?.from).toBe('shop');
    expect(effectiveAttribute(model, 'nope', 'tech')).toBeUndefined();
  });

  it('leaves out a link that is not an http(s) address, with a warning', () => {
    const result = parseArchitecture(
      file(yaml`
        domains:
          - id: a
            name: A
            links:
              - url: 'javascript:alert(1)'
              - url: https://ok.example
              - label: 3
      `),
    );
    expect(result.warnings.map((d) => d.path)).toEqual(['domains[0].links[0].url']);
    expect(result.errors.map((d) => d.path)).toEqual([
      'domains[0].links[2].url',
      'domains[0].links[2].label',
    ]);
    expect(result.warnings[0]?.message).toMatch(/not an http\(s\) address/);
  });

  it('rejects a metric that is not a number', () => {
    const result = parseArchitecture(
      file(yaml`
        domains:
          - id: a
            name: A
            metrics:
              loc: many
              churn: 3
      `),
    );
    expect(result.model).toBeNull();
    expect(errorAt(result, 'domains[0].metrics.loc').message).toMatch(/must be a number/);
  });
});

describe('parseArchitecture: flows', () => {
  const edges =
    edge('e1', 'ingest.reader.parser', 'ingest.queue') +
    edge('e2', 'ingest.queue', 'api.gateway', 'control');

  it('reads flows with their steps and nodes; the kind defaults to workflow', () => {
    const model = expectClean(
      parseArchitecture(
        file(
          `${DOMAINS}flows:\n  - id: order\n    name: Place an order\n    kind: dataflow\n    description: How an order travels\n    edges: [e1, e2, e1]\n    nodes: [api, api]\n  - id: just-nodes\n    name: Nodes only\n    nodes: [ingest]\n`,
          edges,
        ),
      ),
    );
    expect(model.flows).toEqual([
      {
        id: 'order',
        name: 'Place an order',
        kind: 'dataflow',
        description: 'How an order travels',
        edgeIds: ['e1', 'e2', 'e1'],
        nodeIds: ['api'],
      },
      { id: 'just-nodes', name: 'Nodes only', kind: 'workflow', edgeIds: [], nodeIds: ['ingest'] },
    ]);
  });

  it('reports unknown edges and nodes, bad kinds, duplicate and invalid IDs, and empty flows', () => {
    const result = parseArchitecture(
      file(
        `${DOMAINS}flows:\n  - id: a\n    name: A\n    edges: [e9, 7]\n    nodes: [nope]\n  - id: a\n    name: Again\n    kind: loop\n    edges: [e1]\n  - id: Bad Id\n    name: Empty\n  - id: fine\n    name: Fine\n    edges: [e1]\n`,
        edges,
      ),
    );
    expect(result.model).toBeNull();
    expect(errorAt(result, 'flows[0].edges[0]').message).toMatch(/unknown edge "e9"/);
    expect(errorAt(result, 'flows[0].edges[1]').message).toMatch(/must be the ID of an edge/);
    expect(errorAt(result, 'flows[0].nodes[0]').message).toMatch(/unknown node "nope"/);
    expect(errorAt(result, 'flows[1].id').message).toMatch(/Duplicate flow ID "a"/);
    expect(errorAt(result, 'flows[1].kind').message).toMatch(
      /Invalid flow kind "loop" in flow "a"; allowed kinds: workflow, dataflow/,
    );
    expect(errorAt(result, 'flows[2].id').message).toMatch(/Invalid flow ID/);
    expect(result.warnings.map((d) => d.path)).toEqual(['flows[2]']);
  });

  it('is an empty list when the file has none', () => {
    expect(expectClean(parseArchitecture(file(DOMAINS))).flows).toEqual([]);
  });
});

/** A file with one domain `a` (component `a.x`, subcomponent `a.x.k`) and what `rest` adds. */
function withDomain(domainLines: string, rest = ''): string {
  return `version: 1
domains:
  - id: a
    name: A
${domainLines}
    components:
      - id: a.x
        name: X
        subcomponents:
          - { id: a.x.k, name: K }
${rest}`;
}

/** The labels written on node `id`, in the order the model holds them. */
function labelsOf(model: ParseResult['model'], id: string): [string, string][] {
  return [...(model?.nodes.get(id)?.labels ?? [])];
}

function messages(list: readonly Diagnostic[]): string[] {
  return list.map((d) => d.message);
}

describe('parseArchitecture: labels', () => {
  it('reads labels at every level, in file order, block or flow style', () => {
    const model = expectClean(
      parseArchitecture(`version: 1
domains:
  - id: a
    name: A
    labels:
      zone: public
      team: Shop
    components:
      - id: a.x
        name: X
        labels: { team: Core, risk: high }
        subcomponents:
          - id: a.x.k
            name: K
            labels: { zone: internal }
`),
    );
    expect(labelsOf(model, 'a')).toEqual([
      ['zone', 'public'],
      ['team', 'Shop'],
    ]);
    expect(labelsOf(model, 'a.x')).toEqual([
      ['team', 'Core'],
      ['risk', 'high'],
    ]);
    expect(labelsOf(model, 'a.x.k')).toEqual([['zone', 'internal']]);
    expect(labelNames(model)).toEqual(['zone', 'team', 'risk']);
  });

  it('keeps a number and true/false as the file writes them', () => {
    const model = expectClean(
      parseArchitecture(
        withDomain(`    labels:
      release: 1.10
      next: 1.1
      hex: 0x1F
      exp: 1e3
      pii: true
      public: False
      quoted: '1.10'
      2: two
      1: one`),
      ),
    );
    expect(labelsOf(model, 'a')).toEqual([
      ['release', '1.10'],
      ['next', '1.1'],
      ['hex', '0x1F'],
      ['exp', '1e3'],
      ['pii', 'true'],
      ['public', 'False'],
      ['quoted', '1.10'],
      // Number-like names stay where the file has them (a plain object would put 1 before 2).
      ['2', 'two'],
      ['1', 'one'],
    ]);
  });

  it('trims names and values; an entry without a value or with an empty text is no entry', () => {
    const model = expectClean(
      parseArchitecture(
        withDomain(`    labels:
      ' team ': '  Shop  '
      empty:
      tilde: ~
      blank: ''
      spaces: '   '`),
      ),
    );
    expect(labelsOf(model, 'a')).toEqual([['team', 'Shop']]);
  });

  it('gives a node whose labels are all empty no labels at all', () => {
    const model = expectClean(parseArchitecture(withDomain(`    labels: { a: , b: '' }`)));
    expect(model.nodes.get('a')?.labels).toBeUndefined();
    expect(labelNames(model)).toEqual([]);
  });

  it('reads labels given through a YAML alias', () => {
    const model = expectClean(
      parseArchitecture(`version: 1
domains:
  - id: a
    name: A
    labels: &base { zone: public, tier: 1.0 }
  - id: b
    name: B
    labels: *base
`),
    );
    expect(labelsOf(model, 'b')).toEqual([
      ['zone', 'public'],
      ['tier', '1.0'],
    ]);
    // A single value given through an alias is the text its anchor writes.
    const single = expectClean(
      parseArchitecture(withDomain('    labels: { first: &release 1.10, second: *release }')),
    );
    expect(labelsOf(single, 'a')).toEqual([
      ['first', '1.10'],
      ['second', '1.10'],
    ]);
  });

  it('a name that is a list or a mapping is taken as the YAML library writes it, not dropped', () => {
    const model = expectClean(
      parseArchitecture(
        withDomain(
          '    labels: { tier: 1.10, [a, b]: c }',
          'presets:\n  - { name: P, label: "[ a, b ]" }\n',
        ),
      ),
    );
    // The whole mapping is then read from the plain object: a number as JavaScript prints it.
    expect(labelsOf(model, 'a')).toEqual([
      ['tier', '1.1'],
      ['[ a, b ]', 'c'],
    ]);
    expect(model.presets.map((preset) => preset.label)).toEqual(['[ a, b ]']);
  });

  it('leaves a file without labels and presets as it was', () => {
    const model = expectClean(parseArchitecture(withDomain('    owner: Me')));
    expect(model.presets).toEqual([]);
    for (const node of model.nodes.values()) expect('labels' in node).toBe(false);
  });

  it('an empty "labels:" and an empty "presets:" are the same as leaving them out', () => {
    const model = expectClean(parseArchitecture(withDomain('    labels:', 'presets:\n')));
    expect(model.presets).toEqual([]);
    for (const node of model.nodes.values()) expect('labels' in node).toBe(false);
  });
});

describe('parseArchitecture: mistakes in labels', () => {
  const errorsOf = (domainLines: string): string[] =>
    messages(parseArchitecture(withDomain(domainLines)).errors);

  it('a list where the mapping belongs — for metrics too', () => {
    expect(errorsOf('    labels: [a, b]')).toEqual([
      '"labels" of domain "a" must be a mapping (key: value pairs), but got a list',
    ]);
    expect(errorsOf('    labels: text')).toEqual([
      '"labels" of domain "a" must be a mapping (key: value pairs), but got text "text"',
    ]);
    expect(errorsOf('    metrics: [1]')).toEqual([
      '"metrics" of domain "a" must be a mapping (key: value pairs), but got a list',
    ]);
  });

  it('a value that is a list or a mapping', () => {
    expect(errorsOf('    labels: { team: [x, y] }')).toEqual([
      'Label "team" of domain "a" must be text, a number or true/false, but got a list',
    ]);
    expect(errorsOf('    labels: { zone: { a: 1 } }')).toEqual([
      'Label "zone" of domain "a" must be text, a number or true/false, but got a mapping',
    ]);
  });

  it('an attribute written as a label says where it goes', () => {
    const result = parseArchitecture(`version: 1
domains:
  - id: a
    name: A
    components:
      - id: a.x
        name: X
        labels: { status: live }
`);
    expect(messages(result.errors)).toEqual([
      'Label "status" of component "a.x" is a key of its own: write "status:" on the component itself, not under "labels"',
    ]);
    expect(result.errors[0]).toMatchObject({
      path: 'domains[0].components[0].labels.status',
      line: 8,
    });
    expect(result.model).toBeNull();
    // In any letter case: "Owner" would stand in the list beside the attribute's "Owner".
    expect(errorsOf('    labels: { Owner: Me, TECH: Go, ownership: fine }')).toEqual([
      'Label "Owner" of domain "a" is a key of its own: write "owner:" on the domain itself, not under "labels"',
      'Label "TECH" of domain "a" is a key of its own: write "tech:" on the domain itself, not under "labels"',
    ]);
  });

  it('an empty name and a name that is too long', () => {
    expect(errorsOf("    labels: { '': x }")).toEqual(['A label of domain "a" has an empty name']);
    expect(errorsOf('    labels: { ~: x }')).toEqual(['A label of domain "a" has an empty name']);
    const long = 'n'.repeat(81);
    expect(errorsOf(`    labels: { ${long}: x }`)).toEqual([
      `Label name "${'n'.repeat(39)}…" of domain "a" is longer than 80 characters`,
    ]);
    expect(errorsOf(`    labels: { ${'n'.repeat(80)}: x }`)).toEqual([]);
  });

  it('warns about names that differ only in letter case — once per spelling — and keeps both', () => {
    const result = parseArchitecture(`version: 1
domains:
  - id: a
    name: A
    labels: { Team: Shop }
    components:
      - id: a.x
        name: X
        labels: { team: Core }
      - id: a.y
        name: Y
        labels: { Team: Other }
      - id: a.z
        name: Z
        labels: { team: Again }
      - id: a.w
        name: W
        labels: { TEAM: Loud }
`);
    expect(result.errors).toEqual([]);
    // The second node that writes "team" is not told again: a slip on the first node of a
    // hundred would otherwise be reported on the ninety-nine that are right.
    expect(messages(result.warnings)).toEqual([
      'Label "team" of component "a.x" differs only in letter case from "Team" (first used at domains[0].labels.Team); they are two labels',
      'Label "TEAM" of component "a.w" differs only in letter case from "Team" (first used at domains[0].labels.Team); they are two labels',
    ]);
    expect(result.model ? labelNames(result.model) : []).toEqual(['Team', 'team', 'TEAM']);
  });

  it('the same name twice is the YAML library’s error; twice after trimming is a warning', () => {
    expect(errorsOf('    labels:\n      team: A\n      team: B')).toEqual([
      'Map keys must be unique',
    ]);
    const result = parseArchitecture(withDomain("    labels:\n      team: A\n      ' team': B"));
    expect(result.errors).toEqual([]);
    expect(messages(result.warnings)).toEqual([
      'Label "team" of domain "a" is written twice; the first value is kept',
    ]);
    expect(labelsOf(result.model, 'a')).toEqual([['team', 'A']]);
  });
});

describe('parseArchitecture: presets', () => {
  const LABELLED = `    owner: Shop team
    labels: { lifecycle: live, tier: 2 }`;
  const withPresets = (presets: string): string => withDomain(LABELLED, `presets:\n${presets}`);

  it('reads name, label, description and the values in the order of the file', () => {
    const model = expectClean(
      parseArchitecture(
        withPresets(`  - name: Lifecycle
    label: lifecycle
    description: '  Where each part is in its life  '
    values:
      planned: blue
      live: GREEN
      beta:
      deprecated: '#E34'
      gone: { light: '#C2410C', dark: '#fb923c' }
      rest: gray
  - { name: Teams, label: owner }
  - name: Tiers
    label: tier
    values: { 3: red, 2: orange, 10: teal, 1.10: pink }
`),
      ),
    );
    expect(model.presets).toEqual([
      {
        name: 'Lifecycle',
        label: 'lifecycle',
        description: 'Where each part is in its life',
        values: [
          { value: 'planned', color: CATEGORICAL_COLORS[0] },
          { value: 'live', color: CATEGORICAL_COLORS[5] },
          { value: 'beta' },
          { value: 'deprecated', color: { light: '#ee3344', dark: '#ee3344' } },
          { value: 'gone', color: { light: '#c2410c', dark: '#fb923c' } },
          { value: 'rest', color: OTHER_COLOR },
        ],
      },
      { name: 'Teams', label: 'owner', values: [] },
      {
        name: 'Tiers',
        label: 'tier',
        // Not 2, 3, 10, 1.1: the order and the spelling of the file.
        values: [
          { value: '3', color: CATEGORICAL_COLORS[7] },
          { value: '2', color: CATEGORICAL_COLORS[1] },
          { value: '10', color: CATEGORICAL_COLORS[2] },
          { value: '1.10', color: CATEGORICAL_COLORS[4] },
        ],
      },
    ]);
    // A description that is empty or only spaces is none.
    const blank = expectClean(
      parseArchitecture(
        withPresets(`  - { name: Empty, label: tier, description: '' }
  - { name: Spaces, label: tier, description: '   ' }
`),
      ),
    );
    expect(blank.presets.map((preset) => Object.keys(preset))).toEqual([
      ['name', 'label', 'values'],
      ['name', 'label', 'values'],
    ]);
  });

  it('shape mistakes are errors, in the words of the other sections', () => {
    const result = parseArchitecture(
      withPresets(`  - { label: tier }
  - just text
  - { name: '', label: tier }
  - { name: 12, label: tier }
  - { name: NoLabel }
  - { name: V, label: tier, values: [a] }
  - { name: D, label: tier, description: [a] }
  - { name: ${'p'.repeat(81)}, label: tier }
`),
    );
    expect(messages(result.errors)).toEqual([
      'Missing required field "name" in preset presets[0]',
      'Preset presets[1] must be a mapping (key: value pairs), but got text "just text"',
      '"name" of preset presets[2] must not be empty',
      '"name" of preset presets[3] must be text, but got number 12',
      'Missing required field "label" in preset "NoLabel"',
      '"values" of preset "V" must be a mapping (key: value pairs), but got a list',
      '"description" of preset "D" must be text, but got a list',
      `"name" of preset "${'p'.repeat(39)}…" is longer than 80 characters`,
    ]);
    expect(result.model).toBeNull();
    expect(
      messages(parseArchitecture(withDomain(LABELLED, 'presets: { name: X }\n')).errors),
    ).toEqual(['"presets" of the file must be a list, but got a mapping']);
    // A name of exactly 80 characters is one.
    expect(
      parseArchitecture(withPresets(`  - { name: ${'p'.repeat(80)}, label: tier }\n`)).errors,
    ).toEqual([]);
  });

  it('a name used twice is an error', () => {
    const result = parseArchitecture(
      withPresets(`  - { name: Life, label: lifecycle }
  - { name: Other, label: tier }
  - { name: ' Life ', label: tier }
`),
    );
    expect(messages(result.errors)).toEqual([
      'Duplicate preset name "Life" (first defined at presets[0])',
    ]);
    expect(result.errors[0]).toMatchObject({ path: 'presets[2].name', line: 15 });
  });

  it('a preset on a label no node has is a warning and is left out', () => {
    const result = parseArchitecture(
      withPresets(`  - { name: Typo, label: lifecycel }
  - { name: Status, label: status }
  - { name: Kept, label: lifecycle }
`),
    );
    expect(result.errors).toEqual([]);
    expect(messages(result.warnings)).toEqual([
      'Preset "Typo" colours by label "lifecycel", which no node has, so it is left out; did you mean "lifecycle"?',
      // No node of this file has a status, although the key exists.
      'Preset "Status" colours by label "status", which no node has, so it is left out',
    ]);
    expect(result.model?.presets.map((preset) => preset.name)).toEqual(['Kept']);
  });

  it('what is no colour is a warning; the value keeps its place and takes a free colour', () => {
    const result = parseArchitecture(
      withPresets(`  - name: Life
    label: lifecycle
    values:
      a: gren
      b: 'url(https://example.com/x)'
      c: 123456
      d: { light: '#fff' }
      e: { light: red, dark: blue }
      f: [red]
      g: none
      live: red
`),
    );
    const help =
      "Use blue, orange, teal, yellow, pink, green, purple, red, grey, or a hex colour in quotes such as '#1baf7a'. The next free colour is used";
    expect(result.errors).toEqual([]);
    expect(messages(result.warnings)).toEqual([
      `Unknown colour "gren" for value "a" of preset "Life"; did you mean "green"? ${help}`,
      `Unknown colour "url(https://example.com/x)" for value "b" of preset "Life". ${help}`,
      `The colour for value "c" of preset "Life" must be a colour name or a hex colour in quotes, but got number 123456. ${help}`,
      `The colour for value "d" of preset "Life" must give "light" and "dark", each a hex colour in quotes, and nothing else. ${help}`,
      `The colour for value "e" of preset "Life" must give "light" and "dark", each a hex colour in quotes, and nothing else. ${help}`,
      `The colour for value "f" of preset "Life" must be a colour name or a hex colour in quotes, but got a list. ${help}`,
      `Unknown colour "none" for value "g" of preset "Life". ${help}`,
    ]);
    expect(result.model?.presets[0]?.values).toEqual([
      { value: 'a' },
      { value: 'b' },
      { value: 'c' },
      { value: 'd' },
      { value: 'e' },
      { value: 'f' },
      { value: 'g' },
      { value: 'live', color: CATEGORICAL_COLORS[7] },
    ]);
  });

  it('an unquoted hex colour is a comment to YAML: said so; a real comment is not', () => {
    const result = parseArchitecture(
      withPresets(`  - name: Life
    label: lifecycle
    values:
      planned: #1baf7a
      short: #1b7
      commented: #1baf7a the green
      beta: # not decided yet
      word: #decade of work
      letters: #abc later
      seven: #1baf7a1
      bare: #fff
      live: '#1baf7a' # quoted: fine
`),
    );
    expect(result.errors).toEqual([]);
    expect(messages(result.warnings)).toEqual([
      'Value "planned" of preset "Life" has no colour: YAML reads the unquoted #1baf7a as a comment; write \'#1baf7a\' in quotes. The next free colour is used',
      'Value "short" of preset "Life" has no colour: YAML reads the unquoted #1b7 as a comment; write \'#1b7\' in quotes. The next free colour is used',
      'Value "commented" of preset "Life" has no colour: YAML reads the unquoted #1baf7a as a comment; write \'#1baf7a\' in quotes. The next free colour is used',
      'Value "bare" of preset "Life" has no colour: YAML reads the unquoted #fff as a comment; write \'#fff\' in quotes. The next free colour is used',
    ]);
    expect(result.warnings[0]).toMatchObject({ path: 'presets[0].values.planned', line: 16 });
    expect(result.model?.presets[0]?.values).toEqual([
      { value: 'planned' },
      { value: 'short' },
      { value: 'commented' },
      { value: 'beta' },
      { value: 'word' },
      { value: 'letters' },
      { value: 'seven' },
      { value: 'bare' },
      { value: 'live', color: { light: '#1baf7a', dark: '#1baf7a' } },
    ]);
  });

  it('an unquoted hex colour is said whatever stands on the line below it', () => {
    const unquoted = (value: string, hex: string): string =>
      `Value "${value}" of preset "Life" has no colour: YAML reads the unquoted #${hex} as a comment; write '#${hex}' in quotes. The next free colour is used`;
    const said = (values: string, after = ''): string[] =>
      messages(
        parseArchitecture(
          withPresets(`  - name: Life\n    label: lifecycle\n    values:\n${values}${after}`),
        ).warnings,
      );
    // YAML joins a comment line to the comment of the empty value above it.
    const commentBelow = `      planned: #1baf7a
      # the next one
      live: green
`;
    expect(said(commentBelow)).toEqual([unquoted('planned', '1baf7a')]);
    expect(said(commentBelow.replace(/\n/g, '\r\n'))).toEqual([unquoted('planned', '1baf7a')]);
    // A value that is commented out, and words after the colour on its own line.
    expect(
      said(`      planned: #1baf7a the green
      # deprecated: red
      short: #1b7
      # beta: '#abc'
      live: green
`),
    ).toEqual([unquoted('planned', '1baf7a'), unquoted('short', '1b7')]);
    // The last value of the list: before the next preset, and before the end of the file.
    expect(
      said(
        `      live: green
      planned: #1baf7a
`,
        '  # the second preset\n  - { name: Tiers, label: tier }\n',
      ),
    ).toEqual([unquoted('planned', '1baf7a')]);
    expect(said('      live: green\n      planned: #1baf7a\n# the end\n')).toEqual([
      unquoted('planned', '1baf7a'),
    ]);
    // Letters in either case, as the file has them.
    expect(said('      planned: #1BAF7A\n      short: #FfF\n')).toEqual([
      unquoted('planned', '1BAF7A'),
      unquoted('short', 'FfF'),
    ]);
    // What follows a real comment is a comment too, hex digits or not.
    expect(
      said(`      beta: # not decided yet
      #1baf7a was the colour before
      word: #decade of work
      #fff
      live: green
`),
    ).toEqual([]);
  });

  it('a listed value nobody has is said only when it resembles one somebody has', () => {
    const result = parseArchitecture(`version: 1
domains:
  - { id: a, name: A, labels: { lifecycle: deprecated } }
  - { id: b, name: B, labels: { lifecycle: live } }
presets:
  - name: Life
    label: lifecycle
    values: { planned: blue, depricated: red, Live: green }
  - name: Both
    label: lifecycle
    values: { deprecated: red, depricated: red }
`);
    expect(result.errors).toEqual([]);
    expect(messages(result.warnings)).toEqual([
      'Preset "Life" lists value "depricated", which no node has as its "lifecycle"; did you mean "deprecated"?',
      'Preset "Life" lists value "Live", which no node has as its "lifecycle"; did you mean "live"?',
    ]);
    // A value some node has is no slip, whatever else on the map resembles it.
    expectClean(
      parseArchitecture(`version: 1
domains:
  - { id: a, name: A, labels: { lifecycle: live } }
  - { id: b, name: B, labels: { lifecycle: Live } }
presets:
  - { name: Life, label: lifecycle, values: { live: green } }
`),
    );
  });

  it('values that differ only in their numerals are a series, not a slip', () => {
    const result = parseArchitecture(`version: 1
domains:
  - { id: a, name: A, labels: { tier: tier-1, release: '1.10' } }
  - { id: b, name: B, labels: { tier: tier-9, release: '1.9' } }
presets:
  - name: Tiers
    label: tier
    values: { tier-2: red, tier-3: blue, Tier-1: green }
  - name: Releases
    label: release
    values: { '1.11': red, '2.0': blue }
`);
    expect(result.errors).toEqual([]);
    // tier-2 and tier-3 are ahead of the map; "Tier-1" is tier-1 in another letter case.
    expect(messages(result.warnings)).toEqual([
      'Preset "Tiers" lists value "Tier-1", which no node has as its "tier"; did you mean "tier-1"?',
    ]);
  });

  it('messages cut a value and a label they quote to 40 characters', () => {
    const cut = (text: string): string => `${text.slice(0, 39)}…`;
    const label = 'l'.repeat(60);
    const onMap = 'word '.repeat(12).trim();
    const slip = `${onMap}s`;
    const twice = 't'.repeat(60);
    const result = parseArchitecture(`version: 1
domains:
  - { id: a, name: A, labels: { ${label}: ${onMap} } }
presets:
  - name: P
    label: ${label}
    values:
      ${slip}: gren
      ${twice}: red
      ' ${twice}': blue
  - { name: Q, label: ${'m'.repeat(60)} }
`);
    expect(result.errors).toEqual([]);
    expect(messages(result.warnings)).toEqual([
      `Preset "P" lists value "${cut(slip)}", which no node has as its "${cut(label)}"; did you mean "${cut(onMap)}"?`,
      `Unknown colour "gren" for value "${cut(slip)}" of preset "P"; did you mean "green"? Use blue, orange, teal, yellow, pink, green, purple, red, grey, or a hex colour in quotes such as '#1baf7a'. The next free colour is used`,
      `Preset "P" lists value "${cut(twice)}" twice; the first is kept`,
      `Preset "Q" colours by label "${cut('m'.repeat(60))}", which no node has, so it is left out`,
    ]);
    // 40 characters are quoted whole.
    const whole = 'v'.repeat(40);
    expect(
      messages(
        parseArchitecture(`version: 1
domains:
  - { id: a, name: A, labels: { kind: ${whole} } }
presets:
  - { name: P, label: kind, values: { ${whole.toUpperCase()}: red } }
`).warnings,
      ),
    ).toEqual([
      `Preset "P" lists value "${whole.toUpperCase()}", which no node has as its "kind"; did you mean "${whole}"?`,
    ]);
  });

  it('the hint for a listed value is the one the other hints would give (seeded)', () => {
    let state = 11;
    const random = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const below = (count: number): number => Math.floor(random() * count);
    const letters = 'abAB.';
    const letter = (): string => letters.charAt(below(letters.length));
    const text = (): string => Array.from({ length: 1 + below(12) }, letter).join('');
    // One slip of the hand: a letter replaced, added or dropped, or two neighbours swapped.
    const slip = (value: string): string => {
      const at = below(value.length);
      const kind = below(4);
      if (kind === 0) return value.slice(0, at) + letter() + value.slice(at + 1);
      if (kind === 1) return value.slice(0, at) + letter() + value.slice(at);
      if (kind === 2) return value.slice(0, at) + value.slice(at + 1);
      return value.slice(0, at) + value.charAt(at + 1) + value.charAt(at) + value.slice(at + 2);
    };
    const hints = new Map<number, number>();
    let byLastSegment = 0;
    let silent = 0;
    for (let round = 0; round < 300; round++) {
      const onMap = Array.from({ length: 1 + below(6) }, text);
      const listed = new Set<string>();
      for (let i = 0; i < 1 + below(8); i++) {
        let value = random() < 0.2 ? text() : (onMap[below(onMap.length)] ?? text());
        if (random() < 0.2) value = value.slice(value.lastIndexOf('.') + 1);
        for (let slips = below(6); slips > 0; slips--) value = slip(value);
        if (value !== '') listed.add(value);
      }
      const result = parseArchitecture(
        [
          'version: 1',
          'domains:',
          ...onMap.map(
            (value, i) => `  - { id: d${i}, name: D, labels: { v: ${JSON.stringify(value)} } }`,
          ),
          'presets:',
          '  - name: P',
          '    label: v',
          '    values:',
          ...[...listed].map((value) => `      ${JSON.stringify(value)}:`),
          '',
        ].join('\n'),
      );
      const unlisted = onMap.filter((value) => !listed.has(value));
      const expected: string[] = [];
      for (const value of listed) {
        const meant = onMap.includes(value) ? undefined : suggest(value, unlisted);
        if (meant === undefined) {
          silent += 1;
          continue;
        }
        const edits = editDistance(value.toLowerCase(), meant.toLowerCase());
        if (edits > Math.min(3, Math.floor(value.length / 3))) byLastSegment += 1;
        else hints.set(edits, (hints.get(edits) ?? 0) + 1);
        expected.push(
          `Preset "P" lists value "${value}", which no node has as its "v"; did you mean "${meant}"?`,
        );
      }
      expect(result.errors).toEqual([]);
      expect(messages(result.warnings)).toEqual(expected);
    }
    // Hints at every distance that counts as a slip and by the last segment, and values that
    // get none.
    for (const edits of [0, 1, 2, 3]) expect(hints.get(edits) ?? 0, `${edits}`).toBeGreaterThan(10);
    expect(byLastSegment).toBeGreaterThan(10);
    expect(silent).toBeGreaterThan(100);
  });

  it('stays fast when a preset lists many long values that resemble those of the nodes', () => {
    const count = 60;
    const base = 'word '.repeat(120).trim();
    const withLetter = (at: number, letter: string): string =>
      base.slice(0, at) + letter + base.slice(at + 1);
    const onMap = Array.from({ length: count }, (_, i) => withLetter(5 * i, 'x'));
    const text = [
      'version: 1',
      'domains:',
      ...onMap.map((value, i) => `  - { id: d${i}, name: D, labels: { note: ${value} } }`),
      'presets:',
      '  - name: P',
      '    label: note',
      '    values:',
      ...Array.from({ length: count }, (_, i) => `      ${withLetter(5 * i + 1, 'y')}:`),
      '',
    ].join('\n');
    const started = performance.now();
    const result = parseArchitecture(text);
    const elapsed = performance.now() - started;
    expect(result.errors).toEqual([]);
    // Every listed value is two letters away from every value on the map.
    expect(result.warnings).toHaveLength(count);
    expect(result.warnings[0]?.message).toContain('; did you mean "xord word ');
    // Well under a second here; it took about 20 s when a table of one length by the other was
    // filled for every pair of values. The bound is generous to survive a loaded computer.
    expect(elapsed).toBeLessThan(4500);
  });

  it('an unknown key, an empty value and a value listed twice are warnings', () => {
    const result = parseArchitecture(
      withPresets(`  - name: Life
    label: lifecycle
    colours: { live: green }
    values:
      '': red
      live: green
      ' live': red
`),
    );
    expect(result.errors).toEqual([]);
    expect(messages(result.warnings)).toEqual([
      'Unknown key "colours" in preset "Life" (ignored)',
      'Preset "Life" lists an empty value (ignored)',
      'Preset "Life" lists value "live" twice; the first is kept',
    ]);
    expect(result.model?.presets[0]?.values).toEqual([
      { value: 'live', color: CATEGORICAL_COLORS[5] },
    ]);
    expect(
      messages(parseArchitecture(withPresets('  - { name: L, label: tier, value: 1 }\n')).warnings),
    ).toEqual(['Unknown key "value" in preset "L" (ignored); did you mean "values"?']);
  });

  it('the same value twice in "values" is the YAML library’s error', () => {
    const result = parseArchitecture(
      withPresets('  - name: L\n    label: tier\n    values:\n      a: red\n      a: blue\n'),
    );
    expect(messages(result.errors)).toEqual(['Map keys must be unique']);
  });
});
