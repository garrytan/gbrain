/**
 * The fence trend prefix (persistence/sync-prepare.ts `readFenceTrendPrefix`) reads request rows that select
 * `sequence::text AS sequence`. An `ORDER BY sequence` there sorts that text alias, so once the sequences gain a digit the
 * rows come back as 10, 11, 9: the trend's sample paths and the list of imports left open come out of order.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: both prefix reads return requests in numeric sequence order.
 *  - Regression: the two reads ordered by the text alias ("10" < "11" < "9").
 *  - Why existing coverage misses it: test/sync-fence-trend-prefix-9646.test.ts answers executeRaw with a fake that
 *    returns rows already in order; only a real database sorts.
 *  - Seam: the request sequence is set to 8 (then 98) so three requests take 9, 10, 11 (then 99, 100, 101).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { readFenceTrendPrefix } from '../src/core/persistence/sync-prepare.ts';
import { editRequest, freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

const databaseUrl = process.env.DATABASE_URL;

for (const kind of testBackends()) {
  describe(`fence trend prefix sequence order ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    beforeAll(async () => { factory = await freshBrainFactory(kind, databaseUrl); }, 120_000);
    afterAll(async () => { await factory?.dispose(); });

    test('the prefix tallies committed imports and lists open ones in numeric sequence order (9, 10, 11 and 99, 100, 101)', async () => {
      const engine: BrainEngine = await factory.fresh();
      const requests = await requestFixture(engine);
      const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id::text AS id');
      const importAt = async (sequence: number, state: 'committed' | 'queued') => {
        await engine.executeRaw("SELECT setval(pg_get_serial_sequence('persistence_requests','sequence'), $1::bigint)", [sequence - 1]);
        const admitted = await requests.admit(`notes/p${sequence}`);
        expect(String(admitted.sequence)).toBe(String(sequence));
        const intent = { kind: 'managed_sync_import', passId: 'pass-1', path: `notes/p${sequence}.md` };
        const outcome = state === 'committed' ? { fences_normalized: [{ class: 'kind_map' }] } : null;
        await editRequest(engine, admitted.id, 'worktree_id=$2::uuid, state=$3, intent=$4::text::jsonb, outcome=$5::text::jsonb',
          [worktree!.id, state, JSON.stringify(intent), outcome === null ? null : JSON.stringify(outcome)]);
      };
      for (const sequence of [9, 10, 11]) await importAt(sequence, 'committed');
      for (const sequence of [99, 100, 101]) await importAt(sequence, 'queued');

      const prefix = await readFenceTrendPrefix(engine, { worktreeId: worktree!.id, sourceId: requests.sourceId, incarnation: requests.incarnation });
      expect(prefix.through).toBe('101');
      expect(prefix.open).toEqual(['99', '100', '101']);
      expect(prefix.tally?.sample_paths).toEqual(['notes/p9.md', 'notes/p10.md', 'notes/p11.md']);
    }, 120_000);
  });
}
