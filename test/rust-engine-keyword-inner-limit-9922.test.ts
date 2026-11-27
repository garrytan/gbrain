/**
 * #9922 on the Rust engine: the keyword arm keeps (offset + limit) x 3 candidates, as PGLite and Postgres do.
 *
 * 1. Protects: RustEngine searchKeyword passes the store an innerLimit of (offset + limit) * 3, clamped to the search
 *    cap * 3, so an offset at or past 3 x limit still reads its page (engine-parity search.test.ts windowPastInner).
 * 2. Fails when: the innerLimit ignores the offset (the pre-#9922 limit * 3) or drops the cap.
 * 3. Real seams: the searchKeyword store member with a stub store that records the options it receives.
 */
import { describe, expect, test } from 'bun:test';
import { searchKeyword } from '../src/core/rust-engine/store-members/keyword.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';
import { searchLimitCap } from '../src/core/search/eval-pool-depth.ts';

async function innerLimitFor(opts: { limit: number; offset: number }): Promise<unknown> {
  const seen: Record<string, unknown>[] = [];
  const brain = {
    searchKeywordArm: async (_match: string, _rank: string, options: Record<string, unknown>) => { seen.push({ ...options }); return []; },
    searchKeywordPages: async () => [],
    keywordRareTermPages: async () => [],
  } as unknown as StoreBrain;
  await searchKeyword(brain, 'nebula', opts);
  expect(seen.length).toBeGreaterThan(0);
  return seen[0]!.innerLimit;
}

describe('RustEngine searchKeyword innerLimit (#9922)', () => {
  test('an offset past 3 x limit widens the candidate pool', async () => {
    expect(await innerLimitFor({ limit: 1, offset: 4 })).toBe(15);
    expect(await innerLimitFor({ limit: 10, offset: 40 })).toBe(150);
  });

  test('the pool stays clamped to the search cap x 3', async () => {
    const cap = searchLimitCap();
    expect(await innerLimitFor({ limit: cap, offset: cap * 10 })).toBe(cap * 3);
  });
});
