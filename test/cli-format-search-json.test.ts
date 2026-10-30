import { describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli/main.ts';

describe('formatResult - search/query --json', () => {
  test('search --json renders the raw result array as parseable JSON', () => {
    const out = formatResult('search', [
      {
        slug: 'docs/example',
        score: 0.42,
        chunk_text: 'Example result text',
      },
    ], { json: true });

    expect(JSON.parse(out)).toEqual([
      {
        slug: 'docs/example',
        score: 0.42,
        chunk_text: 'Example result text',
      },
    ]);
  });

  test('query --json keeps empty results machine-readable', () => {
    const out = formatResult('query', [], { json: true });

    expect(JSON.parse(out)).toEqual([]);
  });

  test('human output labels all-weak nearest neighbors as UNKNOWN', () => {
    const out = formatResult('query', [
      { slug: 'docs/nearest', score: 0.1, chunk_text: 'Nearby but unsupported', evidence: 'weak_semantic' },
    ]);
    expect(out).toContain('docs/nearest');
    expect(out).toContain('Treat as UNKNOWN');
  });

  test('human output does not warn when one hit has strong evidence', () => {
    const out = formatResult('query', [
      { slug: 'docs/exact', score: 1, chunk_text: 'Supported', evidence: 'exact_title_match' },
    ]);
    expect(out).not.toContain('Treat as UNKNOWN');
  });

  test('json output never carries the human UNKNOWN warning', () => {
    const out = formatResult('query', [
      { slug: 'docs/nearest', score: 0.1, chunk_text: 'Nearby but unsupported', evidence: 'weak_semantic' },
    ], { json: true });
    expect(out).not.toContain('Treat as UNKNOWN');
    expect(JSON.parse(out)[0].slug).toBe('docs/nearest');
  });
});
