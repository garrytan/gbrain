/**
 * The C18 claim accounting against the interleaving that broke it (multi-writer conformance, C18, 64 writers in 8 processes).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a writer's `claimNextJob` may answer null while committed waiting work exists, because the rows it can see are locked by
 *    other claimers in flight (`FOR UPDATE SKIP LOCKED`) and a job committed after its statement's snapshot is invisible to it. The
 *    queue loses and duplicates nothing in that case, so the C18 check must not demand that the writers' claims equal the stored jobs.
 *    It accounts for every stored job exactly once across the writers' claims (a null allowed) and the parent's drain.
 *  - Regression: C18 failed 1 of 17 whole-file runs under heavy load with "the claimed ids are not the stored jobs' ids": one stored job
 *    stayed `waiting` because its writer's claim answered null. This test forces that interleaving with no timing: three jobs are held
 *    by three transactions on separate connections, a claim then must answer null, and the run is accounted the way C18 does.
 *  - Why existing coverage misses it: the conformance file hits this only when the load happens to interleave that way.
 *  - Seam: PostgreSQL only (row locks; PGLite has one connection). Raw SQL holds the rows (this is not a parity case). The barrier is
 *    promises, never a sleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { claimAccountViolations, admitKeyed, claimSpec } from './engine-parity/multi-writer-support.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const HAVE_POSTGRES = testBackends().includes('postgres');
const describePg = HAVE_POSTGRES ? describe : describe.skip;

/** The rule this replaces: the writers' claims had to equal the stored jobs. */
const oldRuleFlags = (claimed: readonly number[], stored: readonly number[]): boolean =>
  claimed.slice().sort((a, b) => a - b).join(',') !== stored.slice().sort((a, b) => a - b).join(',');

describePg('C18 claim accounting under a forced interleaving (PostgreSQL)', () => {
  let engine: PostgresEngine;
  let databaseUrl: string;
  let close: () => Promise<void>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const made = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
    ({ engine, databaseUrl, close } = made);
    sql = postgres(databaseUrl, { max: 4, prepare: false });
  });
  afterAll(async () => { await sql?.end(); await close?.(); });

  /** Holds `FOR UPDATE` on job `id` in its own transaction until `release()`; resolves `held` once the row is locked. */
  function hold(id: number) {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const done = sql.begin(async (tx) => {
      await tx`SELECT id FROM minion_jobs WHERE id = ${id} FOR UPDATE`;
      held.resolve();
      await release.promise;
    });
    return { held: held.promise, release: () => release.resolve(), done };
  }

  async function oneRun(iteration: number) {
    // Three waiting jobs, in their own request keys.
    const ids: number[] = [];
    for (let n = 1; n <= 3; n++) ids.push(Number((await admitKeyed(engine, `c18-race-${iteration}-${n}`)).row.id));
    // Three transactions on three connections hold one each; while all are held, a claim has nothing it may take.
    const holders = ids.map(hold);
    await Promise.all(holders.map(h => h.held));
    const blocked = await engine.claimNextJob(claimSpec(`blocked-${iteration}:a`));
    expect(blocked, 'a claim took a job another transaction holds (SKIP LOCKED was not skipped)').toBeNull();
    for (const h of holders) h.release();
    await Promise.all(holders.map(h => h.done));
    // The writers: two of them claim after the holders let go; the third is the one whose claim answered null above.
    const first = await engine.claimNextJob(claimSpec(`w1-${iteration}:a`));
    const second = await engine.claimNextJob(claimSpec(`w2-${iteration}:a`));
    const writerClaims = [first, second, blocked].map(row => (row ? Number(row.id) : null));
    // The parent's drain: claims what is left, until null.
    const drained: number[] = [];
    for (let calls = 0; ; calls++) {
      expect(calls, 'the drain did not end within the number of stored jobs').toBeLessThan(ids.length + 1);
      const row = await engine.claimNextJob(claimSpec(`drain-${iteration}:a`));
      if (!row) break;
      drained.push(Number(row.id));
    }
    return { ids, writerClaims, drained };
  }

  test('a null claim while waiting work is held leaves a job for the drain; the old rule flags the run, the new accounting does not', async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
      const { ids, writerClaims, drained } = await oneRun(iteration);
      const claimedByWriters = writerClaims.filter((id): id is number => id !== null);
      // The race happened: exactly one stored job was left waiting for the drain.
      expect(writerClaims.filter(id => id === null), `run ${iteration}: no writer got a null claim`).toHaveLength(1);
      expect(drained, `run ${iteration}: the drain did not claim the one job left`).toHaveLength(1);
      // The old rule (writers' claims == stored jobs) flags this run although nothing was lost or duplicated.
      expect(oldRuleFlags(claimedByWriters, ids), `run ${iteration}: the old rule would have accepted it`).toBe(true);
      // The new accounting (with the drain) accepts it, and without the drain it names the job nobody claimed.
      expect(claimAccountViolations({ writerClaims, drained, stored: ids }), `run ${iteration}`).toEqual([]);
      const undrained = claimAccountViolations({ writerClaims, drained: [], stored: ids });
      expect(undrained[0], `run ${iteration}`).toBe(`stored job ${drained[0]} was never claimed, not even by the drain`);
      expect(undrained[1], `run ${iteration}: the summary names the null claim and the unclaimed id`).toContain(`1 null writer claims; drained 0 []; claimed but not stored []; stored but never claimed [${drained[0]}]`);
    }
  });
});
