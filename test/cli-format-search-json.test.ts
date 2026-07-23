/**
 * `search --json` (reported by morzu117/swairm alongside the source_id fix):
 * scripts/agents piping `gbrain search` shouldn't have to parse the human
 * one-line-per-result format. formatResult's `params.json` branch returns raw
 * JSON — checked BEFORE the "No results." short-circuit so an empty result set
 * is still valid JSON (`[]`), and only when params are threaded (a regression
 * guard: the flag was inert until both cli.ts call sites passed `params`).
 */
import { describe, test, expect } from 'bun:test';
import { formatResult } from '../src/cli.ts';

const RESULTS = [
  { slug: 'notes/alpha-doc', source_id: 'alpha', title: 'Alpha Doc', score: 0.9 },
  { slug: 'notes/beta-doc', source_id: 'beta', title: 'Beta Doc', score: 0.7 },
];

describe('formatResult — search --json', () => {
  test('json:true returns parseable JSON of the full result array', () => {
    const out = formatResult('search', RESULTS, { json: true });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].slug).toBe('notes/alpha-doc');
  });

  test('json:true on an empty result set returns "[]", not the human "No results." line', () => {
    const out = formatResult('search', [], { json: true });
    expect(JSON.parse(out)).toEqual([]);
    expect(out).not.toContain('No results.');
  });

  test('without params (default CLI path) still renders the human format, not JSON', () => {
    const out = formatResult('search', RESULTS);
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('notes/alpha-doc');
  });
});
