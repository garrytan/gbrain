/**
 * Postgres contention: the exclusive source lock of the publication transaction.
 *
 * 1. Protects: two writers that both take `SELECT id FROM sources WHERE id=$1 FOR UPDATE` (engine-sql/sources.ts
 *    `lockSourceForUpdate`) on one source serialize: the second one waits, server side, until the first one's transaction
 *    commits, and then sees everything the first one wrote. A writer of another source, or of an unknown one, never waits.
 * 2. Fails when: the second writer's lock returns while the first transaction is still open (two `sourceExclusive`
 *    publications of one source overlap), or it returns before the first commit became visible, or it blocks a different source.
 * 3. Existing coverage: test/engine-parity/publication-source-lock.test.ts pins that the member runs, and answers nothing,
 *    on every arm; none of them has two connections, so a lock that took no lock at all would pass them.
 * 4. Seam: two pooled connections of one real Postgres database, each in its own `engine.transaction`. The wait is proved by
 *    order, not by a sleep: a third connection sees the second writer waiting on a lock (pg_stat_activity) before the first
 *    one commits, the second lock has not resolved by then, and after the commit the second writer reads the first one's write.
 *
 * The test is aimed at the statement, not at a call site. It runs the engine-sql helper and the typed member over the same
 * SQL, so it keeps passing when the publication transaction takes the lock through the journal's `journal.lockSource`
 * (same statement); the trunk's second lander keeps `journal.lockSource`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { lockSourceForUpdate } from '../src/core/engine-sql/sources.ts';
import type { SqlExecutor } from '../src/core/engine-sql/executor.ts';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SKIP = !process.env.DATABASE_URL;
const SOURCE = 'lock-contention-example';
const OTHER = 'lock-contention-other-example';
const LOCK_SQL = '%FROM sources WHERE id=$1 FOR UPDATE%';

/** Takes the source row lock the way a caller does: through the engine-sql helper, or through the typed member. */
const lockers = {
  'engine-sql lockSourceForUpdate': (tx: BrainEngine, sourceId: string) => lockSourceForUpdate(tx as unknown as SqlExecutor, sourceId),
  'BrainEngine.lockSourceForUpdate': (tx: BrainEngine, sourceId: string) => tx.lockSourceForUpdate(sourceId),
} as const;

/** A promise that settles from outside. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}

/** Polls (bounded, no fixed sleep) until `check` is true; a failure names `what`. */
async function until(what: string, check: () => Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(SKIP)('the source row lock under two connections (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 6));
    for (const id of [SOURCE, OTHER]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $2)', [id, id + ' before']);
  }, 180_000);
  afterAll(async () => { await close?.(); });

  const name = async (id: string) => (await engine.executeRaw<{ name: string }>('SELECT name FROM sources WHERE id=$1', [id]))[0]?.name;
  /** Writers (backends on this database) that wait on a lock taken by the source lock statement. */
  const waiting = async () => Number((await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [LOCK_SQL]))[0]!.n);

  for (const [label, lock] of Object.entries(lockers)) {
    describe(label, () => {
      test('the second writer of one source waits until the first commits, then sees the first one\'s write', async () => {
        await engine.executeRaw('UPDATE sources SET name = $2 WHERE id = $1', [SOURCE, SOURCE + ' before']);
        const events: string[] = [];
        const firstHolds = gate();
        const firstMayCommit = gate();

        const first = engine.transaction(async tx => {
          await lock(tx, SOURCE);
          events.push('first locked');
          await tx.executeRaw('UPDATE sources SET name = $2 WHERE id = $1', [SOURCE, SOURCE + ' written by first']);
          firstHolds.open();
          await firstMayCommit.opened;
          events.push('first leaves its transaction (commit follows)');
        }).then(() => { events.push('first committed'); });

        await firstHolds.opened;
        let secondSaw: string | undefined;
        const second = engine.transaction(async tx => {
          await lock(tx, SOURCE);
          events.push('second locked');
          secondSaw = (await tx.executeRaw<{ name: string }>('SELECT name FROM sources WHERE id=$1', [SOURCE]))[0]?.name;
        }).then(() => { events.push('second committed'); });

        // Order: the second writer is waiting on the lock, server side, while the first transaction is still open ...
        await until('the second writer to wait on the source lock', async () => (await waiting()) === 1);
        expect(events).toEqual(['first locked']);
        expect(secondSaw).toBeUndefined();
        // ... and the first writer's write is not visible to anyone else yet.
        expect(await name(SOURCE)).toBe(SOURCE + ' before');

        firstMayCommit.open();
        await Promise.all([first, second]);

        // The second lock resolved only after the first transaction ended, and it read the committed write.
        expect(events.indexOf('second locked')).toBeGreaterThan(events.indexOf('first leaves its transaction (commit follows)'));
        expect(secondSaw).toBe(SOURCE + ' written by first');
        expect(events.at(-1)).toBe('second committed');
        expect(await waiting()).toBe(0);
        expect(await name(SOURCE)).toBe(SOURCE + ' written by first');
      }, 60_000);

      test('the lock is released by a rollback too, and another source or an unknown one never waits', async () => {
        const firstHolds = gate();
        const firstMayEnd = gate();
        const first = engine.transaction(async tx => {
          await lock(tx, SOURCE);
          firstHolds.open();
          await firstMayEnd.opened;
          throw new Error('stop after the lock');
        }).then(() => 'committed', (error: Error) => error.message);

        await firstHolds.opened;
        const events: string[] = [];
        // While the first writer holds SOURCE: another source and an unknown one lock at once ...
        await engine.transaction(async tx => { await lock(tx, OTHER); events.push('other locked'); });
        await engine.transaction(async tx => { await lock(tx, 'lock-contention-unknown-example'); events.push('unknown locked'); });
        // ... and a second writer of SOURCE waits.
        const second = engine.transaction(async tx => { await lock(tx, SOURCE); events.push('second locked'); });
        await until('the second writer to wait on the source lock', async () => (await waiting()) === 1);
        expect(events).toEqual(['other locked', 'unknown locked']);

        firstMayEnd.open();
        expect(await first).toBe('stop after the lock');
        await second;
        expect(events).toEqual(['other locked', 'unknown locked', 'second locked']);
        expect(await waiting()).toBe(0);
      }, 60_000);
    });
  }
});
