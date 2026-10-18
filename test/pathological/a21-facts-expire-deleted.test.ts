/**
 * GBRA-130 A-21: managed extract_facts expires the facts of soft-deleted pages
 * before it reconciles anything. One deleted page whose expiry request is
 * refused (a terminal storage failure replayed through the receipt, a
 * source_changed refusal) used to throw out of the whole phase every run, so
 * no page of the source ever reconciled again. Now that page is reported as
 * `FACTS_EXPIRE_FAILED: <slug>: <code>`, the other deleted pages expire and
 * the reconcile runs; run-scoped errors still stop the phase.
 *
 * Authoring gate: (1) protects per-page isolation of the deleted-page expiry;
 * (2) fails when expireDeletedPagesManaged loses its per-page catch or treats a
 * lost connection as one page's problem; (3) test/managed-facts-writers.test.ts
 * covers only the happy path; (4) no production seam: the refusal is a real
 * database trigger that rejects the expiry for one page.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';
import { FACTS_FENCE, managedSource, PERSON, type ManagedSource } from './managed-fixture.ts';

const ROW = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2020-01-01 |  | chat |  |`;

/** Rejects every expiry of `slug`'s fact rows, the way a terminal storage failure refuses one page's write. */
async function refuseExpiry(engine: BrainEngine, slug: string): Promise<void> {
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION patho_refuse_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.expired_at IS NOT NULL AND OLD.expired_at IS NULL AND NEW.source_markdown_slug = '${slug}' THEN
      RAISE EXCEPTION 'expiry refused for %', NEW.source_markdown_slug USING ERRCODE = '23514'; END IF; RETURN NEW; END $$`);
  await engine.executeRaw('DROP TRIGGER IF EXISTS patho_refuse_expiry ON facts');
  await engine.executeRaw('CREATE TRIGGER patho_refuse_expiry BEFORE UPDATE ON facts FOR EACH ROW EXECUTE FUNCTION patho_refuse_expiry()');
}
const allowExpiry = (engine: BrainEngine) => engine.executeRaw('DROP TRIGGER IF EXISTS patho_refuse_expiry ON facts');

async function active(engine: BrainEngine, sourceId: string, slug: string): Promise<string[]> {
  return (await engine.executeRaw<{ fact: string }>(
    'SELECT fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL ORDER BY row_num', [sourceId, slug])).map(r => r.fact);
}

/** Two soft-deleted pages with active fence facts, plus one live page whose fact index drifted from its fence. */
async function seedDeleted(s: ManagedSource, deleted = ['people/alice-example', 'people/bob-example']): Promise<void> {
  for (const slug of deleted) {
    await s.put(slug, PERSON(slug, FACTS_FENCE(ROW(1, `${slug} founded acme-example`))));
    await s.engine.softDeletePage(slug, { sourceId: s.sourceId });
  }
  await s.put('people/carol-example', PERSON('Carol Example', FACTS_FENCE(ROW(1, 'Carol plays chess'))));
  await s.engine.executeRaw('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [s.sourceId, 'people/carol-example']);
}

const failures = (warnings: string[]) => warnings.filter(w => w.startsWith('FACTS_EXPIRE_FAILED: ')).map(w => {
  const [, key, code] = w.match(/^FACTS_EXPIRE_FAILED: ([^:]+): ([a-z_]+)/) ?? [];
  return { key, code, fix: w };
});

describe('A-21 managed extract_facts isolates one deleted page whose expiry is refused', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a refused deleted-page expiry is reported and the other pages still expire and reconcile`, async () => {
      await managedSource(databaseUrl, seedDeleted, async ({ engine, sourceId }) => {
        await refuseExpiry(engine, 'people/alice-example');
        const before = await snapshotItems(engine, sourceId);
        const result = await expectUnitNotAborted(() => runExtractFacts(engine, { sourceId }));
        expect(failures(result.warnings)).toHaveLength(1);
        expectItemFailure(failures(result.warnings)[0], { key: 'people/alice-example', code: 'storage_error', fix: /retried by the next extract_facts run/ });
        expect(await active(engine, sourceId, 'people/alice-example')).toEqual(['people/alice-example founded acme-example']);
        expect(await active(engine, sourceId, 'people/bob-example')).toEqual([]);
        expect(result.factsExpiredForDeletedPages).toBe(1);
        expect(await active(engine, sourceId, 'people/carol-example')).toEqual(['Carol plays chess']);
        expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
      });
    }, 120_000);

    test(`[${backend}] a deleted page whose expiry the refusal breaker holds back is skipped, not failed`, async () => {
      await managedSource(databaseUrl, seedDeleted, async ({ engine, sourceId }) => {
        await refuseExpiry(engine, 'people/alice-example');
        for (let run = 0; run < 3; run++) await runExtractFacts(engine, { sourceId });
        const result = await expectUnitNotAborted(() => runExtractFacts(engine, { sourceId }));
        expect(failures(result.warnings)).toEqual([]);
        expect(result.warnings.filter(w => w.startsWith('FACTS_EXPIRE_SKIPPED: people/alice-example: storage_error'))).toHaveLength(1);
        expect(await active(engine, sourceId, 'people/alice-example')).toHaveLength(1);
      });
    }, 180_000);

    test(`[${backend}] once the refusal clears, the next run expires the page`, async () => {
      await managedSource(databaseUrl, seedDeleted, async ({ engine, sourceId }) => {
        await refuseExpiry(engine, 'people/alice-example');
        expect(failures((await runExtractFacts(engine, { sourceId })).warnings)).toHaveLength(1);
        await allowExpiry(engine);
        const result = await runExtractFacts(engine, { sourceId });
        expect(failures(result.warnings)).toEqual([]);
        expect(await active(engine, sourceId, 'people/alice-example')).toEqual([]);
      });
    }, 120_000);

    test(`[${backend}] most deleted pages refused trips the breaker instead of reporting each one`, async () => {
      const deleted = ['a', 'b', 'c', 'd', 'e'].map(x => `people/${x}-example`);
      await managedSource(databaseUrl, s => seedDeleted(s, deleted), async ({ engine, sourceId }) => {
        await engine.executeRaw(`CREATE OR REPLACE FUNCTION patho_refuse_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.expired_at IS NOT NULL AND OLD.expired_at IS NULL THEN RAISE EXCEPTION 'expiry refused' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$`);
        await engine.executeRaw('CREATE TRIGGER patho_refuse_expiry BEFORE UPDATE ON facts FOR EACH ROW EXECUTE FUNCTION patho_refuse_expiry()');
        await expect(runExtractFacts(engine, { sourceId })).rejects.toMatchObject({ code: 'item_failures_systemic' });
      });
    }, 120_000);

    for (const { name, error } of runScopedErrors()) {
      test(`[${backend}] a run-scoped error during a deleted-page expiry still stops extract_facts (${name})`, async () => {
        await managedSource(databaseUrl, seedDeleted, async ({ engine, sourceId }) => {
          const injected = error();
          // Transaction engines inherit from the engine, so the override forwards `this` (a bound read would leave the transaction).
          const read = engine.readPageSnapshot;
          engine.readPageSnapshot = async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) {
            if (opts?.includeDeleted && slug.endsWith('-example') && slug !== 'people/carol-example') throw injected;
            return read.call(this, slug, opts);
          } as BrainEngine['readPageSnapshot'];
          await expect(runExtractFacts(engine, { sourceId })).rejects.toBe(injected);
          engine.readPageSnapshot = read;
          expect(await active(engine, sourceId, 'people/alice-example')).toHaveLength(1);
          expect(await active(engine, sourceId, 'people/bob-example')).toHaveLength(1);
          expect(await active(engine, sourceId, 'people/carol-example')).toEqual([]);
        });
      }, 120_000);
    }
  }
});
