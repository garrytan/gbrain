/**
 * The coordinated purge (the `purge` job, the cycle phase, `gbrain pages purge-deleted`) refuses an age that is not a
 * finite number of hours, 0 or more, before any step runs. The recorded-tombstone expiry used to clamp a negative age
 * to 0 and hard-delete every recorded tombstone even though the engine purge itself refuses that age. The carry and its
 * read-only forecast (the manual purge's preview) refuse the same ages. Runs on PGLite, and on Postgres when
 * DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { PurgeAgeError } from '../src/core/engine-errors.ts';
import { purgeDeletedPagesCoordinated, selectPurgeCandidates } from '../src/core/persistence/purge-deleted.ts';
import { carryPrivateBeforePurge, forecastCarry } from '../src/core/repair/origin-carry.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const BAD_AGES = [-1, -72, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

async function tombstones(b: BeliefBrain): Promise<string[]> {
  const rows = await b.engine.executeRaw<{ slug: string }>(
    'SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL ORDER BY slug', [b.sourceId]);
  return rows.map(row => row.slug);
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`coordinated purge age refusal (${engineCase.name})`, () => {
    test('a NaN, negative or infinite age is refused before anything runs, and every recorded tombstone stays', async () => {
      await beliefBrain(async b => {
        for (const slug of ['companies/acme-example', 'companies/widget-co']) {
          await b.put(slug, beliefPage({ title: slug, facts: [`${slug} is an example`] }));
          const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId });
          await b.op('delete_page', { slug, expected_revision: snapshot!.revision });
        }
        // Coverage is on for this source, so both pages are recorded tombstones, the rows the expiry step reads.
        await b.engine.executeRaw(
          "UPDATE pages SET deleted_at = now() - interval '2 hours' WHERE source_id = $1 AND deleted_at IS NOT NULL", [b.sourceId]);
        expect(await tombstones(b)).toEqual(['companies/acme-example', 'companies/widget-co']);
        for (const age of BAD_AGES) {
          await expect(purgeDeletedPagesCoordinated(b.engine, age, { automatic: true })).rejects.toBeInstanceOf(PurgeAgeError);
          await expect(purgeDeletedPagesCoordinated(b.engine, age)).rejects.toBeInstanceOf(PurgeAgeError);
          await expect(selectPurgeCandidates(b.engine, age)).rejects.toBeInstanceOf(PurgeAgeError);
          await expect(forecastCarry(b.engine, age)).rejects.toBeInstanceOf(PurgeAgeError);
          await expect(carryPrivateBeforePurge(b.engine, age)).rejects.toBeInstanceOf(PurgeAgeError);
          expect(await tombstones(b)).toEqual(['companies/acme-example', 'companies/widget-co']);
        }
        // A valid age still purges: 1 hour covers both tombstones.
        const result = await purgeDeletedPagesCoordinated(b.engine, 1, { automatic: true });
        expect(result.error).toBeUndefined();
        expect(await tombstones(b)).toEqual([]);
      }, { managed: false, databaseUrl: engineCase.databaseUrl });
    }, 60_000);
  });
}
