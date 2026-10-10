/**
 * Postgres arm of test/claim-earlier-equivalence.test.ts (GBRA-69): the claim's
 * root probe claims what the former COALESCE key claimed, and with queued rows
 * on 8 worktrees it is an index range scan of its own root (the former key
 * walked every root's pending rows once per queued candidate).
 */
import { describe, expect, test } from 'bun:test';
import { compareClaimOrders, explainEarlierProbe } from '../helpers/claim-earlier-fixture.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres write claim root probe', () => {
  test('claims the same rows in the same order as the COALESCE key', async () => {
    const { engine, close } = await isolatedPersistencePostgres(url!);
    try {
      const cases = await compareClaimOrders(engine);
      expect(cases.filter(c => c.former.length > 1).length).toBeGreaterThan(cases.length / 8);
      for (const c of cases) expect({ seed: c.seed, priority: c.priority, lanes: c.lanes, order: c.current }).toEqual({ seed: c.seed, priority: c.priority, lanes: c.lanes, order: c.former });
    } finally { await close(); }
  }, 180_000);

  test('the probe is an index scan of the pending rows, and reads fewer buffers than the COALESCE key', async () => {
    const { engine, close } = await isolatedPersistencePostgres(url!);
    try {
      const { current, former } = await explainEarlierProbe(engine);
      expect(current.earlier.length).toBeGreaterThan(0);
      for (const scan of current.earlier) expect(scan.type).toMatch(/Index|Bitmap/);
      expect(current.earlier.some(scan => /worktree_id/.test(String(scan.index)))).toBe(true);
      expect(current.buffers).toBeLessThan(former.buffers * 0.85);
    } finally { await close(); }
  }, 180_000);
});
