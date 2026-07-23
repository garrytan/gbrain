/**
 * #468 — `[NaN]` score prefix in `gbrain query` output.
 *
 * NaN.toFixed(4) returns the truthy string 'NaN', so the old
 * `r.score?.toFixed(4) || '?'` fallback never fired and the CLI printed
 * '[NaN] slug -- ...'. The formatter must gate on Number.isFinite.
 */
import { describe, test, expect } from 'bun:test';
import { formatResult } from '../src/cli.ts';

describe('formatResult — query score prefix (#468)', () => {
  test('finite score renders 4 decimal places', () => {
    const out = formatResult('query', [
      { score: 0.4922, slug: 'people/zhangsan', chunk_text: 'Zhang San' },
    ]);
    expect(out).toContain('[0.4922] people/zhangsan');
  });

  test('NaN score renders ? — never the string NaN', () => {
    const out = formatResult('query', [
      { score: NaN, slug: 'people/zhangsan', chunk_text: 'Zhang San' },
    ]);
    expect(out).toContain('[?] people/zhangsan');
    expect(out).not.toContain('NaN');
  });

  test('missing and Infinity scores also render ?', () => {
    const out = formatResult('search', [
      { slug: 'a', chunk_text: '' },
      { score: Infinity, slug: 'b', chunk_text: '' },
    ]);
    expect(out).toContain('[?] a');
    expect(out).toContain('[?] b');
  });
});
