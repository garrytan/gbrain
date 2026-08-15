import { describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli.ts';

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
});
