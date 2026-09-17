import { describe, expect, test } from 'bun:test';
import { runRuntimeMatrix } from '../../scripts/persistence/matrix.ts';

const directUrl = process.env.GBRAIN_PGBOUNCER_DIRECT_URL ?? process.env.DATABASE_URL;
const pooledUrl = process.env.GBRAIN_PGBOUNCER_URL;
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && (!directUrl || !pooledUrl)) {
  throw new Error('Required persistence matrix needs real direct and transaction-mode PgBouncer URLs');
}
describe.skipIf(!directUrl || !pooledUrl)('persistence runtime deployment matrix', () => {
  test('all direct/pooler, RLS and 1/2/3-connection cases execute without a skipped cell', async () => {
    const result = await runRuntimeMatrix({ directUrl: directUrl!, pooledUrl: pooledUrl! });
    expect(result.status).toBe('passed'); expect(result.full_gate).toBe(true); expect(result.cases).toHaveLength(24);
    expect(result.ownership.source_incarnation_fenced).toBe(true);
    expect(result.ownership.stale_owner_refused).toBe(true);
  }, 150_000);
});
