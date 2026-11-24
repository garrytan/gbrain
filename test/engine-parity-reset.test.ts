/**
 * The parity harness's Postgres reset (test/engine-parity/harness.ts `resetPostgres`) waits for the transactions the
 * previous case left open on the arm's database before it deletes rows.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a reset that starts while another connection of the arm's database still has a transaction open (work
 *    the previous case started and did not finish, such as apply-mode writes still draining) waits until that
 *    transaction ends, then empties the brain. The open transaction sees the rows it was working on.
 *  - Regression: the reset deleted rows under the open transaction. On CI one such interleaving deadlocked the reset's
 *    `DELETE FROM sources` against the edge-contradictions apply-mode case's leftover work (family-tail-sites.test.ts,
 *    "an applied closure line the user deletes ..."), and the case failed on a Postgres arm.
 *  - Why existing coverage misses it: the parity cases run the reset only between cases, where the leftover work is
 *    usually done; a slow runner is needed to overlap them. This test forces the overlap with a transaction held open.
 *  - Seam: none. A real isolated Postgres database; the leftover work is a transaction on the engine's own pool.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPostgres } from './engine-parity/harness.ts';

const SKIP = !process.env.DATABASE_URL;
const NOTE = { type: 'note' as const, title: 'Leftover', compiled_truth: 'Leftover work.', timeline: '' };

describe.skipIf(SKIP)('the parity harness Postgres reset (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  }, 120_000);
  afterAll(async () => { await close(); });

  test('the reset waits for a transaction the previous case left open, then empties the brain', async () => {
    await engine.putPage('notes/leftover', NOTE);
    let opened!: () => void;
    const open = new Promise<void>(resolve => { opened = resolve; });
    // The previous case's leftover work: a transaction already open when the reset starts, which touches a page later.
    const leftover = engine.transaction(async tx => {
      await tx.executeRaw('SELECT 1');
      opened();
      await new Promise(resolve => setTimeout(resolve, 1500));
      return (await tx.executeRaw<{ n: number }>(`UPDATE pages SET title = 'touched' WHERE slug = 'notes/leftover' RETURNING 1 AS n`)).length;
    });
    await open;
    const [touched] = await Promise.all([leftover, resetPostgres(engine)]);
    const left = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
    expect({ touched, pagesAfterReset: left[0]!.n }).toEqual({ touched: 1, pagesAfterReset: 0 });
  }, 60_000);
});
