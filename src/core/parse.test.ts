import { describe, expect, it } from 'vitest';
import { effectiveAttribute, parseArchitecture, type Diagnostic, type ParseResult } from './index';

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
