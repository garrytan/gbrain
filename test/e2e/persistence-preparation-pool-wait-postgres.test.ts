/**
 * #8651 on Postgres: a managed-sync preparation's engine read that is waiting for a pool connection ends at the
 * preparation's deadline. `runDeadlineRead` (postgres-engine/bounded-statement.ts) reserved its connection with no
 * bound, so with every pool connection held elsewhere the read settled only when a connection came back, long after the
 * budget, and then ran on it anyway.
 *
 * Value: protects=the deadline on the pool wait of a bounded engine read (bounded-statement.ts runDeadlineRead,
 * persistence/bounded-reads.ts); fails_when=the read settles only after the holder gives the sole connection back, or
 * settles as anything but preparation_deadline; seam=none (a one-connection pool held by a real transaction).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';
import { boundedReads, PreparationDeadlineError } from '../../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../../src/core/persistence/claim-phase.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { CheckoutGauge } from '../../src/core/pool-gauge.ts';

const BUDGET_MS = 300;
const HOLD_MS = 4_000;
let engine: PostgresEngine | undefined;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1);
  engine = pg.engine; close = pg.close;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.putPage('pool-wait-probe', { title: 'Pool wait probe', type: 'note', compiled_truth: 'A synthetic page.' });
}, 120_000);
afterAll(async () => { await close?.(); });

describe.skipIf(!hasDatabase())('a bounded engine read waiting for a pool connection ends at its deadline (Postgres, #8651)', () => {
  test('with the only connection held, the page read settles as preparation_deadline near the budget, not when the holder lets go', async () => {
    const e = engine!;
    const gauge = (e as unknown as { checkoutGauge: CheckoutGauge }).checkoutGauge;
    const held = Promise.withResolvers<void>();
    const letGo = Promise.withResolvers<void>();
    const holder = e.transaction(async tx => { await tx.executeRaw('SELECT 1'); held.resolve(); await letGo.promise; });
    await held.promise;
    const fallback = setTimeout(() => letGo.resolve(), HOLD_MS);
    const started = performance.now();
    let outcome: unknown;
    let elapsed = 0;
    try {
      const clock = startClaimPhase(Date.now(), undefined, BUDGET_MS);
      outcome = await boundedReads(e, clock, { engineReads: true }).readPageSnapshot('pool-wait-probe', { sourceId: 'default' }).catch(error => error);
      elapsed = performance.now() - started;
    } finally { clearTimeout(fallback); letGo.resolve(); await holder; }
    expect(elapsed).toBeLessThan(BUDGET_MS + 1_500);
    expect(outcome).toBeInstanceOf(PreparationDeadlineError);
    expect((outcome as PreparationDeadlineError).code).toBe('preparation_deadline');
    expect(gauge.snapshot().reserved).toBe(0);
    expect((await e.readPageSnapshot('pool-wait-probe', { sourceId: 'default' }))?.page.title).toBe('Pool wait probe');
  }, 30_000);
});
