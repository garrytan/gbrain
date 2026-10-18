/**
 * GBRA-130 A-22: consolidate walks (source, entity) buckets with no per-bucket
 * isolation. On a managed brain an entity page made private while its
 * world-visible facts stay active makes the consolidation submit refuse with
 * page_not_found on every run, and every bucket after it never consolidated.
 * Now that bucket is counted in `buckets_failed` with a typed sample and the
 * phase warns while later buckets consolidate; run-scoped errors still stop it.
 *
 * Authoring gate: (1) protects per-bucket isolation in runPhaseConsolidate;
 * (2) fails when the bucket loop loses its catch or swallows a lost
 * connection; (3) test/managed-maintenance.test.ts covers healthy and private
 * facts only, never a private entity page with world facts; (4) no seam: the
 * bad state is real page and fact rows.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runPhaseConsolidate } from '../../src/core/cycle/phases/consolidate.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';
import { managedSource, type ManagedSource } from './managed-fixture.ts';

const WORDS = ['alpha', 'beta', 'gamma'];
const PAGE = (slug: string, privacy = '') => `---\ntitle: ${slug}\ntype: note\n${privacy}---\nExample evidence for ${slug}.`;

async function seedFacts(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  const [{ dims }] = await engine.executeRaw<{ dims: number }>(`SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid='facts'::regclass AND attname='embedding'`);
  const vector = `[${[1, ...Array(Number(dims) - 1).fill(0)].join(',')}]`;
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,confidence,valid_from,embedding,embedding_model,embedded_text_hash)
      VALUES($1,$2,$3,'fact','test','world',$4,$5::timestamptz,$6::vector,'openai:text-embedding-3-large',md5($3))`,
    [sourceId, slug, `Example claim ${WORDS[i]} on ${slug}`, 0.9 - i / 10, `2026-01-0${i + 1}T00:00:00Z`, vector]);
  }
}

/** One entity page made private while its world facts stay active (the poison bucket), and one healthy bucket. */
async function seed(s: ManagedSource, privateSlugs = ['people/alice-example'], healthy = ['people/bob-example']): Promise<void> {
  for (const slug of privateSlugs) { await s.put(slug, PAGE(slug, 'visibility: private\n')); await seedFacts(s.engine, s.sourceId, slug); }
  for (const slug of healthy) { await s.put(slug, PAGE(slug)); await seedFacts(s.engine, s.sourceId, slug); }
}

const consolidated = async (engine: BrainEngine, sourceId: string, slug: string) => Number((await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND entity_slug=$2 AND consolidated_at IS NOT NULL', [sourceId, slug]))[0]!.n);

describe('A-22 consolidate isolates one bucket whose consolidation is refused', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a private entity page with world facts fails its bucket and later buckets still consolidate`, async () => {
      await managedSource(databaseUrl, s => seed(s), async ({ engine, sourceId }) => {
        const before = await snapshotItems(engine, sourceId);
        const result = await expectUnitNotAborted(() => runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 }));
        expect(result.status).toBe('warn');
        expect(result.details.buckets_failed).toBe(1);
        const [sample] = result.details.bucket_failures as Array<{ source_id: string; entity_slug: string; code: string; fix: string }>;
        expect(sample?.source_id).toBe(sourceId);
        expectItemFailure({ key: sample?.entity_slug, code: sample?.code, fix: sample?.fix },
          { key: 'people/alice-example', code: 'page_not_found', fix: new RegExp(`^gbrain dream --phase consolidate --source ${sourceId}$`) });
        expect(await consolidated(engine, sourceId, 'people/alice-example')).toBe(0);
        expect(await consolidated(engine, sourceId, 'people/bob-example')).toBe(3);
        expect(result.details.takes_written).toBe(1);
        expectOthersUnchanged(before, await snapshotItems(engine, sourceId), { expectProgress: ['people/bob-example'], progressFields: ['content_hash'] });
      });
    }, 120_000);

    test(`[${backend}] once the entity page is public again its bucket consolidates`, async () => {
      await managedSource(databaseUrl, s => seed(s), async ({ engine, sourceId, put }) => {
        expect((await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).details.buckets_failed).toBe(1);
        await put('people/alice-example', PAGE('people/alice-example'));
        const result = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
        expect(result.status).toBe('ok');
        expect(result.details.buckets_failed).toBe(0);
        expect(await consolidated(engine, sourceId, 'people/alice-example')).toBe(3);
      });
    }, 120_000);

    test(`[${backend}] most buckets refused trips the breaker instead of failing each one`, async () => {
      const slugs = ['a', 'b', 'c', 'd', 'e'].map(x => `people/${x}-example`);
      await managedSource(databaseUrl, s => seed(s, slugs, []), async ({ engine, sourceId }) => {
        await expect(runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).rejects.toMatchObject({ code: 'item_failures_systemic' });
      });
    }, 120_000);

    for (const { name, error } of runScopedErrors()) {
      test(`[${backend}] a run-scoped error inside a bucket still stops consolidate (${name})`, async () => {
        await managedSource(databaseUrl, s => seed(s), async ({ engine, sourceId }) => {
          const injected = error();
          const list = engine.listFactsByEntity.bind(engine);
          engine.listFactsByEntity = (async () => { throw injected; }) as BrainEngine['listFactsByEntity'];
          try {
            await expect(runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).rejects.toBe(injected);
          } finally { engine.listFactsByEntity = list; }
          expect(await consolidated(engine, sourceId, 'people/bob-example')).toBe(0);
        });
      }, 120_000);
    }
  }
});
