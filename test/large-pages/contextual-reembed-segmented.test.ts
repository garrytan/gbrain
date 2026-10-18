/**
 * Wave B: contextual re-embed (`reembedPageWithContextualRetrieval`, the
 * `contextual_reindex_per_chunk` handler) on a segmented page.
 *
 * 1. Protects: a segmented page is skipped with the reason
 *    `page_body_segmented` (its contextual synopsis per segment is spec 8.6,
 *    PR 4; its vectors come from the segmented embedding path), its mode
 *    stamp and chunk vectors are left as they are, and the handler's job
 *    result names the reason. A page that does not exist is still
 *    `page_missing`.
 * 2. Fails when: a segmented page is reported as missing (the projection
 *    snapshot is null for it), or the skip stamps a mode its vectors were
 *    never rebuilt for.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { reembedPageWithContextualRetrieval } from '../../src/core/contextual-retrieval-service.ts';
import { makeContextualReindexHandler } from '../../src/core/minions/handlers/contextual-reindex-per-chunk.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
});

test('a segmented page is skipped as page_body_segmented, its mode and vectors untouched', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await engine.setConfig('pages.segmented_storage', 'on');
    await importFromContent(engine, 'notes/contextual', conversationPage(2 * 1024 * 1024, { seed: 91 }), { noEmbed: true });
    const page = await segmentedPageRow(engine, 'notes/contextual');
    expect(page.body_storage).toBe('segmented');
    const state = async () => engine.executeRaw<{ mode: string | null; generation: string | null; embedded: number }>(
      `SELECT p.contextual_retrieval_mode AS mode, p.corpus_generation AS generation,
         (SELECT count(*)::int FROM content_chunks c WHERE c.page_id = p.id AND c.embedded_at IS NOT NULL) AS embedded FROM pages p WHERE p.id = $1`, [page.id]);
    const before = await state();

    for (const globalMode of ['title', 'per_chunk_synopsis', 'none'] as const) {
      expect(await reembedPageWithContextualRetrieval({ engine, pageSlug: 'notes/contextual', sourceId: 'default', globalMode }))
        .toEqual({ kind: 'skipped', reason: 'page_body_segmented' });
    }
    expect(await state()).toEqual(before);
    expect(await reembedPageWithContextualRetrieval({ engine, pageSlug: 'notes/absent', sourceId: 'default', globalMode: 'title' }))
      .toEqual({ kind: 'skipped', reason: 'page_missing' });

    const [job] = await engine.executeRaw<{ id: number }>("INSERT INTO minion_jobs (name, submission_authority) VALUES ('test-contextual-segmented', '{}'::jsonb) RETURNING id");
    const handler = makeContextualReindexHandler({ engine });
    expect(await handler({ id: job!.id, data: { page_slug: 'notes/contextual', expected_source_id: 'default' }, signal: new AbortController().signal } as never))
      .toEqual({ ok: true, mode_applied: 'skipped', chunks_embedded: 0, skip_reason: 'page_body_segmented' });
  }
}), 300_000);
