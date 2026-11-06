/** #8651: saturate a real one-slot pool and exercise the preparation's actual scoped page read. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';
import { boundedReads, PreparationDeadlineError } from '../../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../../src/core/persistence/claim-phase.ts';
import { runDeadlineRead } from '../../src/core/postgres-engine/bounded-statement.ts';
import { CheckoutGauge } from '../../src/core/pool-gauge.ts';

let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>> | undefined;
beforeAll(async () => {
  if (!hasDatabase()) return;
  fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1);
  await fixture.engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await fixture.engine.putPage('deadline-probe', { title: 'Synthetic probe', type: 'note', compiled_truth: 'Synthetic body.' });
}, 120_000);
afterAll(async () => { await fixture?.close(); });

describe.skipIf(!hasDatabase())('#8651 real PostgreSQL deadline recovery', () => {
  test('a saturated preparation read settles before the holder releases; repeated timeouts leave no queued zombie', async () => {
    const engine = fixture!.engine;
    for (let attempt = 0; attempt < 3; attempt++) {
      const acquired = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holder = engine.transaction(async tx => {
        await tx.executeRaw('SELECT 1');
        acquired.resolve();
        await release.promise;
      });
      await acquired.promise;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      let settledWhileHeld = false;
      try {
        const clock = startClaimPhase(Date.now(), undefined, 150);
        // The fallback makes the old code finish so failure is an executed assertion, not a hook timeout.
        fallback = setTimeout(() => release.resolve(), 1500);
        const outcome = await boundedReads(engine, clock, { engineReads: true }).readPageSnapshot('deadline-probe', { sourceId: 'default' })
          .catch(error => error);
        settledWhileHeld = Date.now() < clock.deadlineAt! + 1000;
        expect(outcome).toBeInstanceOf(PreparationDeadlineError);
        expect(outcome.code).toBe('preparation_deadline');
        expect(settledWhileHeld).toBe(true);
      } finally { clearTimeout(fallback); release.resolve(); await holder; }
      expect((await engine.readPageSnapshot('deadline-probe', { sourceId: 'default' }))?.page.title).toBe('Synthetic probe');
    }
  }, 30_000);

  test('a real in-flight read times out, discards its slot and the next checkout can run', async () => {
    const pool = postgres(fixture!.databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
    const gauge = new CheckoutGauge();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await runDeadlineRead(pool, Date.now() + 100, async sql => sql.unsafe('SELECT pg_sleep(2)'), gauge).catch(error => error);
        expect(['read_deadline', '57014']).toContain(result.code);
        // The answer can precede COMMIT; a following ordinary query must still acquire the sole slot.
        expect(Number((await pool.unsafe('SELECT 1 AS n'))[0]!.n)).toBe(1);
        expect(gauge.snapshot().reserved).toBe(0);
      }
    } finally { await pool.end({ timeout: 1 }); }
  }, 30_000);
});
