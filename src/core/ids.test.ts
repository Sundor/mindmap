import { describe, expect, it } from 'vitest';
import {
  editDistance,
  formatDiagnostic,
  formatPath,
  isValidId,
  isValidSegment,
  suggest,
} from './index';

describe('ID rules', () => {
  it.each(['a', 'ingest', 'api-2', 'io_scan', 'a.b.c', 'x1.y-2.z_3'])('accepts %j', (id) => {
    expect(isValidId(id)).toBe(true);
  });

  it.each(['', 'A', 'a.', '.a', 'a..b', 'a b', 'a-', '_a', 'a--b', 'a-_b', 'ä'])(
    'rejects %j',
    (id) => {
      expect(isValidId(id)).toBe(false);
    },
  );

  it('single segments exclude dots', () => {
    expect(isValidSegment('top')).toBe(true);
    expect(isValidSegment('top.level')).toBe(false);
  });
});

describe('suggest', () => {
  const ids = ['ingest', 'ingest.reader', 'ingest.queue', 'api.gateway'];

  it('finds close typos', () => {
    expect(suggest('ingest.reder', ids)).toBe('ingest.reader');
    expect(suggest('Ingest', ids)).toBe('ingest');
    expect(suggest('lable', ['label', 'protocol'])).toBe('label');
  });

  it('maps a bare last segment to the full ID', () => {
    expect(suggest('gateway', ids)).toBe('api.gateway');
  });

  it('returns undefined when nothing is close', () => {
    expect(suggest('warehouse', ids)).toBeUndefined();
    expect(suggest('x', [])).toBeUndefined();
    expect(suggest('b', ['a'])).toBeUndefined();
  });

  it('computes edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
    expect(editDistance('lable', 'label')).toBe(1);
  });
});

describe('diagnostic formatting', () => {
  it('formats paths with indexes', () => {
    expect(formatPath(['domains', 1, 'components', 0, 'id'])).toBe('domains[1].components[0].id');
    expect(formatPath([])).toBe('');
  });

  it('formats a diagnostic with file, position and path', () => {
    expect(
      formatDiagnostic({
        severity: 'error',
        path: 'edges[3].to',
        message: 'Bad',
        line: 12,
        column: 9,
        source: 'architecture.yaml',
      }),
    ).toBe('architecture.yaml:12:9: error: Bad (at edges[3].to)');
    expect(formatDiagnostic({ severity: 'warning', path: '', message: 'Hm', line: 3 })).toBe(
      'line 3: warning: Hm',
    );
    expect(formatDiagnostic({ severity: 'error', path: '', message: 'Empty' })).toBe(
      'error: Empty',
    );
  });
});
