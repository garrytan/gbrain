/**
 * #6236: pattern claim records store the reflection list once per page
 * (lossless), not on every claim. Every path stays recoverable.
 */
import { describe, expect, test } from 'bun:test';
import { CLAIM_SOURCES_KEY, MAX_PATTERN_CLAIM_RECORDS, resolveClaimSources, withClaimSources } from '../src/core/cycle/pattern-claim-sources.ts';

const paths = (n: number, tag = 'r') => Array.from({ length: n }, (_, i) => `wiki/personal/reflections/${tag}-${i}`);

describe('pattern claim sources (#6236)', () => {
  test('new claims share one reference to the run\'s reflection set; every path is recoverable', () => {
    const run = paths(100);
    const { frontmatter } = withClaimSources({ title: 'p' }, [{ text: 'a', reason: 'quote_not_in_source' }, { text: 'b', reason: 'quote_not_in_source' }], run);
    const claims = frontmatter.unverified_claims as Array<{ sources: string[] }>;
    expect(claims).toHaveLength(2);
    expect(claims[0].sources).toHaveLength(1);
    expect(claims[0].sources).toEqual(claims[1].sources);
    expect(Object.keys(frontmatter[CLAIM_SOURCES_KEY] as object)).toHaveLength(1);
    for (const claim of claims) expect(resolveClaimSources(frontmatter, claim)).toEqual(run);
  });

  test('legacy records listing every path are de-duplicated with no path lost, and the page shrinks', () => {
    const runA = paths(100, 'a');
    const runB = paths(100, 'b');
    const legacy = { title: 'p', unverified_claims: [
      ...Array.from({ length: 30 }, (_, i) => ({ text: `a${i}`, sources: runA })),
      ...Array.from({ length: 11 }, (_, i) => ({ text: `b${i}`, sources: runB })),
      { text: 'single', sources: ['wiki/personal/reflections/only'] },
    ] };
    const { frontmatter, changed } = withClaimSources(legacy);
    expect(changed).toBe(true);
    const claims = frontmatter.unverified_claims as Array<{ text: string; sources: string[] }>;
    expect(claims).toHaveLength(42);
    for (const [i, claim] of claims.entries()) expect(resolveClaimSources(frontmatter, claim)).toEqual(legacy.unverified_claims[i].sources);
    expect(Object.keys(frontmatter[CLAIM_SOURCES_KEY] as object)).toHaveLength(2);
    expect(JSON.stringify(frontmatter).length).toBeLessThan(JSON.stringify(legacy).length / 10);
    expect(withClaimSources(frontmatter).changed).toBe(false);
  });

  test('records past the cap drop oldest first and unreferenced sets are pruned', () => {
    const first = withClaimSources({}, Array.from({ length: MAX_PATTERN_CLAIM_RECORDS }, (_, i) => ({ text: `old${i}` })), paths(5, 'old')).frontmatter;
    const second = withClaimSources(first, Array.from({ length: MAX_PATTERN_CLAIM_RECORDS }, (_, i) => ({ text: `new${i}` })), paths(5, 'new')).frontmatter;
    expect((second.unverified_claims as unknown[])).toHaveLength(MAX_PATTERN_CLAIM_RECORDS);
    const sets = Object.values(second[CLAIM_SOURCES_KEY] as Record<string, string[]>);
    expect(sets).toEqual([paths(5, 'new')]);
  });
});
