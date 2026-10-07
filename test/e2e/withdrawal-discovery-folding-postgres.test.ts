import { describe, expect, test } from 'bun:test';
import { discoverWithdrawalTargets } from '../../src/core/facts/withdrawal-discovery.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

describe.skipIf(!hasDatabase())('withdrawal discovery text-folding work', () => {
  test('folds each shortlisted chunk once while still verifying the exact claim', async () => {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const { engine } = fixture;
    const sourceId = 'withdrawal-folding-example';
    const claim = 'the example user prefers project updates by email on weekday mornings';
    const count = 32;
    try {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      for (let n = 0; n < count; n++) {
        const slug = `notes/folding-${n}`;
        await engine.putPage(slug, {
          type: 'note', title: slug, compiled_truth: '', timeline: '',
        }, { sourceId });
        await engine.upsertChunks(slug, [{
          chunk_index: 0, chunk_source: 'compiled_truth',
          chunk_text: n === 0 ? claim.toUpperCase() : claim + ' synthetic padding'.repeat(256),
        }], { sourceId });
      }
      const [key] = await engine.executeRaw<{ hash: string }>(
        'SELECT gbrain_fact_fingerprint($1) AS hash', [claim],
      );
      // A transaction-local, equivalent lower() shim counts executed folds.
      // Fingerprint functions explicitly call pg_catalog.lower and bypass it.
      // This pins the work bound rather than a query spelling or wall-clock speed.
      await engine.executeRaw('CREATE TABLE public.withdrawal_fold_counter(folds integer NOT NULL)');
      await engine.executeRaw('INSERT INTO public.withdrawal_fold_counter VALUES (0)');
      await engine.executeRaw(`CREATE FUNCTION public.lower(value text) RETURNS text
        LANGUAGE plpgsql VOLATILE AS $fn$
        BEGIN
          UPDATE public.withdrawal_fold_counter SET folds = folds + 1;
          RETURN pg_catalog.lower(value);
        END $fn$`);
      const targets = await engine.transaction(async tx => {
        await tx.executeRaw('SET LOCAL search_path = public, pg_catalog');
        return discoverWithdrawalTargets(tx, sourceId, [{
          claim, fact_hash: key.hash, subject: '*', visibility: 'world',
        }]);
      });
      expect(targets.map(t => t.slug)).toEqual(['notes/folding-0']);
      const [work] = await engine.executeRaw<{ folds: number }>(
        'SELECT folds FROM public.withdrawal_fold_counter',
      );
      expect(work.folds).toBe(count);
    } finally {
      await fixture.close();
    }
  }, 120_000);
});
