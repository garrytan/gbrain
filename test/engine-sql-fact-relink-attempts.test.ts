/**
 * fact_relink_attempts SQL that the engine parity tests cannot see, on both SQL engines.
 *
 * 1. Contract: the paid re-extraction memo's upsert (`keepModelAndRun`) keeps the stored `model` and `run_id`
 *    on a conflict, and the plain upsert replaces them. `countFactRelinkOutcomes` counts the linked attempts
 *    of the last 7 days and every no_subject attempt.
 * 2. Regressions: the keep variant falling back to the plain UPSERT (the memo then loses the model and run of
 *    the first paid pass), or the 7-day cutoff being dropped or moved.
 * 3. Existing coverage: no typed reader returns `model` or `run_id`, and the parity harness cannot age a row,
 *    so test/engine-parity/fact-relink-attempts.test.ts and facts-doctor.test.ts pass with either regression.
 *    The SQL-text golden pins both statements' text, not which one the keep option selects.
 * 4. Seams: none. The test reads and ages rows with `executeRaw`, which both SQL engines already expose.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const attempt = (factId: number, outcome: string, model: string, runId: string) =>
  ({ factId, outcome, reason: null, tier: outcome === 'linked' ? 'mention' : 'model', model, targetSlug: 'conv/a', runId });

for (const kind of testBackends()) {
  describe(`fact_relink_attempts SQL (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const stored = async (factId: number) =>
      (await engine.executeRaw<{ outcome: string; model: string; run_id: string }>(
        `SELECT outcome, model, run_id FROM fact_relink_attempts WHERE source_id = 'default' AND fact_id = $1`, [factId]))[0];
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => { await engine.executeRaw('DELETE FROM fact_relink_attempts'); });

    test('keepModelAndRun keeps the stored model and run on a conflict; the plain upsert replaces them', async () => {
      await engine.upsertFactRelinkAttempt('default', attempt(1, 'tried', 'm1', 'r1'));
      await engine.upsertFactRelinkAttempt('default', attempt(1, 'paid_reextract', 'm2', 'r2'), { keepModelAndRun: true });
      expect(await stored(1)).toEqual({ outcome: 'paid_reextract', model: 'm1', run_id: 'r1' });
      // With no row to conflict with, the keep variant inserts the given model and run.
      await engine.upsertFactRelinkAttempt('default', attempt(2, 'paid_reextract', 'm2', 'r2'), { keepModelAndRun: true });
      expect(await stored(2)).toEqual({ outcome: 'paid_reextract', model: 'm2', run_id: 'r2' });
      await engine.upsertFactRelinkAttempt('default', attempt(1, 'linked', 'm3', 'r3'));
      expect(await stored(1)).toEqual({ outcome: 'linked', model: 'm3', run_id: 'r3' });
    });

    test('countFactRelinkOutcomes counts linked rows of the last 7 days and every no_subject row', async () => {
      for (const [id, outcome] of [[1, 'linked'], [2, 'linked'], [3, 'no_subject'], [4, 'ambiguous']] as const) {
        await engine.upsertFactRelinkAttempt('default', attempt(id, outcome, 'm', 'r'));
      }
      const age = (id: number, interval: string) =>
        engine.executeRaw(`UPDATE fact_relink_attempts SET attempted_at = now() - $1::text::interval WHERE fact_id = $2`, [interval, id]);
      await age(1, '6 days 23 hours');
      await age(2, '7 days 1 hour');
      await age(3, '30 days');
      // GROUP BY has no order; sort by outcome, which is unique here.
      const rows = (await engine.countFactRelinkOutcomes(['default'])).sort((a, b) => (a.outcome < b.outcome ? -1 : 1));
      expect(rows).toEqual([
        { outcome: 'linked', tier: 'mention', n: 1 },
        { outcome: 'no_subject', tier: 'model', n: 1 },
      ]);
    });
  });
}
