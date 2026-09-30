import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { embedStaleForSource } from '../../src/core/embed-stale.ts';
import { tryAcquireDbLock } from '../../src/core/db-lock.ts';
import { assertMigrationLeases } from '../../src/core/embedding-migration-budget.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { withEnv } from '../helpers/with-env.ts';
import { migrationWaveFixture, observeMigrationEngine } from '../helpers/migration-wave-fixture.ts';

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`migration wave oversized healing fence (${kind})`, () => {
    let fixture: Awaited<ReturnType<typeof migrationWaveFixture>>;
    let engine: BrainEngine;
    beforeAll(async () => { fixture = await migrationWaveFixture(kind); engine = fixture.engine; }, 60_000);
    afterAll(async () => { resetGateway(); await fixture?.close(); });
    for (const boundary of ['lease', 'abort', 'deadline'] as const) {
      test(`${boundary} during prepared healing leaves exact projection unchanged and dispatches nothing`, async () => {
        await withEnv({ GBRAIN_MAX_CHUNK_TOKENS: '128' }, async () => {
          configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
          const slug = `synthetic-healing-${boundary}`;
          const body = 'Synthetic oversized canonical recovery paragraph with several distinct words. '.repeat(150);
          await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
          await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
          const snapshot = () => engine.executeRaw(`SELECT row_to_json(p) AS page,
            (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM content_chunks c WHERE c.page_id=p.id) AS chunks
            FROM pages p WHERE slug=$1`, [slug]);
          const before = await snapshot();
          const lock = (await tryAcquireDbLock(engine, `migration-wave-healing-${boundary}`, 1))!;
          const controller = new AbortController();
          let armed = false, injected = false, calls = 0;
          const opts = {
            signal: controller.signal,
            deadline: Date.now() + 60_000,
            assertOwned: (tx?: BrainEngine) => assertMigrationLeases(tx ?? engine, [lock]),
            embedFn: async (texts: string[]) => { calls++; return texts.map(() => new Float32Array(1536).fill(0.1)); },
          };
          const observed = observeMigrationEngine(engine, async (tx, method) => {
            if (method === 'listStaleChunks') armed = true;
            if (!armed || injected || method !== 'getChunks') return;
            injected = true;
            if (boundary === 'lease') await tx.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1', [lock.id]);
            if (boundary === 'abort') controller.abort();
            if (boundary === 'deadline') opts.deadline = Date.now() - 1;
          });
          try {
            try { await embedStaleForSource(observed, 'default', opts); }
            catch (error) { expect(String(error)).toMatch(/lease lost|abort/i); }
            expect(injected).toBe(true);
            expect(calls).toBe(0);
            expect(await snapshot()).toEqual(before);
          } finally {
            await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [lock.id]);
            await engine.deletePage(slug);
          }
        });
      });
    }
  });
}
