/**
 * The purge receipt's bounded probe (boundedProbe, src/core/facts/purge-verify.ts) runs countPurgeProbe in its own
 * transaction under `setPurgeProbeTimeout` (`SELECT set_config('statement_timeout',$1,true)`). A probe the server cancels at that timeout reports
 * `{ unverified: 'statement_deadline' }`, so the receipt says the store was not verified instead of failing or
 * claiming it is clean.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on Postgres, a probe that waits on a lock longer than `statementMs` stops at the timeout (it does not
 *    wait for the lock) and reports `statement_deadline`; the timeout is local to the probe's transaction, so the
 *    connection's own statement_timeout is unchanged afterwards; once the lock is gone the same probe counts. Any other
 *    error escapes. PGLite cannot wait on a lock in one process, so its arm proves the 57014 mapping and the error
 *    pass-through on the same function.
 *  - Regression: a probe that runs without the set_config, sets the timeout for the session, or maps every error to
 *    `statement_deadline` (or none) makes a receipt hang on a busy table, leak a timeout into later statements, or hide
 *    a real failure.
 *  - Why existing coverage misses it: test/page-purge.test.ts drives the receipt with no contention, and
 *    test/engine-parity/purge-verify.test.ts compares the counts only.
 *  - Seam: a second real connection holds ACCESS EXCLUSIVE on `pages` (Postgres); a `transaction` that throws a 57014
 *    error stands in for the server (PGLite).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { PurgeProbe } from '../src/core/engine-sql/facts-purge-plan.ts';
import { boundedProbe, __setPurgeProbeLimitsForTests } from '../src/core/facts/purge-verify.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const probe: PurgeProbe = { kind: 'slug_key', store: 'pages', sourceId: 'default', slug: 'notes/held' };

/** The probe under `statementMs`, with a row bound of 10 and no receipt deadline. */
function countPurgeProbe(engine: Pick<BrainEngine, 'transaction'>, p: PurgeProbe, limits: { rows: number; statementMs: number }) {
  __setPurgeProbeLimitsForTests(limits);
  return boundedProbe(engine as BrainEngine, p, Number.POSITIVE_INFINITY);
}

/** A second connection holding ACCESS EXCLUSIVE on `table` until `release` runs. */
async function lockTable(url: string, table: 'pages') {
  const locker = postgres(url, { max: 1, prepare: false });
  let locked!: () => void, unlock!: () => void;
  const isLocked = new Promise<void>(resolve => { locked = resolve; });
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const held = locker.begin(async sql => { await sql.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`); locked(); await gate; });
  await isLocked;
  return { release: async () => { unlock(); await held.catch(() => undefined); await locker.end(); } };
}

for (const backend of testBackends()) describe(`[${backend}] purge probe statement deadline`, () => {
  let engine: BrainEngine;
  let databaseUrl = '';
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; databaseUrl = pg.databaseUrl; close = pg.close; }
    await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'Body.', frontmatter: {} });
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); }, 60_000);
  afterEach(() => { __setPurgeProbeLimitsForTests(null); });

  if (backend === 'postgres') {
    test('a probe blocked by a lock stops at its statement timeout as statement_deadline; the timeout stays local', async () => {
      const [before] = await engine.executeRaw<{ statement_timeout: string }>('SHOW statement_timeout');
      const lock = await lockTable(databaseUrl, 'pages');
      let result: unknown;
      const started = performance.now();
      try { result = await countPurgeProbe(engine, probe, { rows: 10, statementMs: 200 }); }
      finally { await lock.release(); }
      const elapsed = performance.now() - started;
      expect(result).toEqual({ unverified: 'statement_deadline' });
      // It gave up at the timeout, not when the lock went away.
      expect(elapsed).toBeLessThan(5_000);
      const [after] = await engine.executeRaw<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(after!.statement_timeout).toBe(before!.statement_timeout);
      expect(await countPurgeProbe(engine, probe, { rows: 10, statementMs: 2_000 })).toEqual({ count: 1 });
    }, 30_000);
  }

  test('57014 from the probe is statement_deadline; any other error escapes', async () => {
    const failing = (code: string): Pick<BrainEngine, 'transaction'> => ({
      transaction: async () => { throw Object.assign(new Error(`failed with ${code}`), { code }); },
    });
    expect(await countPurgeProbe(failing('57014'), probe, { rows: 10, statementMs: 200 })).toEqual({ unverified: 'statement_deadline' });
    await expect(countPurgeProbe(failing('40P01'), probe, { rows: 10, statementMs: 200 })).rejects.toThrow('failed with 40P01');
    // The real engine sets the timeout inside the probe's transaction and counts.
    expect(await countPurgeProbe(engine, probe, { rows: 10, statementMs: 2_000 })).toEqual({ count: 1 });
  });
});
