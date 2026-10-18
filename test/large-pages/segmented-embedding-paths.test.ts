/**
 * Wave B segmented embedding paths: the per-page budget across keyset
 * batches, `embed --all` and the stale counts, writes in the hysteresis
 * band, and a segmented create whose post-commit projection never ran.
 *
 * 1. Protects: an approval (`--max-usd N`) raises a segmented page's cap once
 *    per run, and a binding cap spends on the newest rows; `embed --all`
 *    re-embeds a segmented page's live rows as it does an inline page's; the
 *    dry-run count and a segmented page's held report read the write column
 *    (a large inline page's still counts rows without embedded_at); a segmented
 *    write under the inline threshold reports deferred embedding; an
 *    unsealed segmented create with no chunk rows is rebuilt by projection
 *    recovery, `embed <slug>` and `embed --all`, and counts as chunkless.
 * 2. Fails when: each keyset batch re-applies the approval, batches walk
 *    oldest first, `--all` embeds only vector-less rows, counts key on
 *    embedded_at, a band write reports no deferral, or the unsealed page is
 *    invisible to the recovery paths.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { prepareEmbeddingProjections } from '../../src/core/embedding-readiness.ts';
import { countSegmentedEmbedRows, embedSegmentedPage, readSegmentedEmbedPage } from '../../src/core/page-body/segmented-embedding.ts';
import { estimatePageEmbedUsd, holdPageEmbedding, listBudgetLimitedPages, PAGE_EMBED_CAP_KEY, readPageSizeStates } from '../../src/core/page-embedding-budget.ts';
import { PAGE_INLINE_MAX_BYTES, SEGMENTED_CREATE_SEAL_MAX_BYTES, SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES, SEGMENTED_PROMOTE_ABOVE_BYTES } from '../../src/core/page-body/limits.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage, unitVector } from '../helpers/segmented-chunks-fixture.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { segmentedPageRow, visibleChunks } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';

const SLUG = 'notes/segmented-paths';
const ROW_TEXT = (i: number) => `Row ${i}: an ordinary paragraph about herons wading in the marsh at dawn, `.padEnd(350, 'and the reeds bend in the wind. ');
const ROW_USD = estimatePageEmbedUsd(ROW_TEXT(0).length, null);

for (const kind of testBackends()) {
  describe(`segmented embedding paths (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let dims: number;
    const embedFn = async (texts: string[]) => {
      const v = Float32Array.from(await unitVector(engine, 3));
      return texts.map(() => v);
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      dims = (await resolveActiveEmbeddingColumnFromEngine(engine)).dimensions;
    }, 120_000);
    afterAll(async () => { resetGateway(); await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw('DELETE FROM page_segment_texts');
      await engine.executeRaw('DELETE FROM page_embedding_budget');
      await engine.executeRaw(`DELETE FROM config WHERE key = $1`, [PAGE_EMBED_CAP_KEY]);
      await engine.setConfig('pages.segmented_storage', 'on');
      resetGateway();
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))),
        usage: { tokens: values.length },
      })) as never);
    });
    afterEach(() => { __setEmbedTransportForTests(null); installFaultHook(undefined); });

    const vectoredRows = async (slug = SLUG) => (await engine.executeRaw<{ chunk_index: number }>(
      `SELECT cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1 AND cc.embedding IS NOT NULL ORDER BY cc.chunk_index`, [slug])).map(r => Number(r.chunk_index));

    /** A large (metered) segmented page of six vector-less rows, chunk_index 0..5. */
    const sixRowPage = () => segmentPage(engine, SLUG, { generation: 1, bodyBytes: 4 * 1024 * 1024,
      occurrences: [{ id: 1, byteStart: 0, genFrom: 1, chunks: [0, 1, 2, 3, 4, 5].map(i => ({ text: ROW_TEXT(i), chunkIndex: i })) }] });

    test('an approval raises the cap once per run: later keyset batches spend under it, newest rows first', async () => {
      await engine.setConfig(PAGE_EMBED_CAP_KEY, '0.000000001');
      const { pageId } = await sixRowPage();
      const page = (await readSegmentedEmbedPage(engine, { sourceId: 'default', slug: SLUG }))!;
      expect(await embedSegmentedPage(engine, page, { embedFn, batchRows: 2, approvedCapUsd: 2.5 * ROW_USD }))
        .toEqual({ embedded: 2, complete: false, stopped: 'budget' });
      expect(await vectoredRows()).toEqual([4, 5]);
      const [budget] = await engine.executeRaw<{ cap_usd: number }>('SELECT cap_usd FROM page_embedding_budget WHERE page_id = $1', [pageId]);
      expect(Number(budget!.cap_usd)).toBeCloseTo(2.5 * ROW_USD, 12);
    });

    test('a binding per-page cap without approval spends on the newest rows', async () => {
      await engine.setConfig(PAGE_EMBED_CAP_KEY, String(2.5 * ROW_USD));
      await sixRowPage();
      const page = (await readSegmentedEmbedPage(engine, { sourceId: 'default', slug: SLUG }))!;
      expect(await embedSegmentedPage(engine, page, { embedFn, batchRows: 2 })).toEqual({ embedded: 2, complete: false, stopped: 'budget' });
      expect(await vectoredRows()).toEqual([4, 5]);
    });

    /** A small segmented page whose three live rows all hold a vector. */
    const embeddedPage = (bodyBytes?: number) => segmentPage(engine, SLUG, { generation: 1, bodyBytes,
      occurrences: [{ id: 1, byteStart: 0, genFrom: 1, chunks: [0, 1, 2].map(i => ({ text: ROW_TEXT(i), chunkIndex: i, vector: 1 })) }] });

    test('embed --all dry run counts every live row of a segmented page, as it does an inline page\'s', async () => {
      await embeddedPage();
      const dry = await runEmbedCore(engine, { all: true, dryRun: true, quiet: true });
      expect({ total: dry.total_chunks, would: dry.would_embed }).toEqual({ total: 3, would: 3 });
    });

    test('embed --all re-embeds every live row of a segmented page', async () => {
      await embeddedPage();
      const run = await runEmbedCore(engine, { all: true, quiet: true });
      expect({ embedded: run.embedded, failures: run.failures }).toEqual({ embedded: 3, failures: 0 });
      const rows = await engine.executeRaw<{ first: number }>(`SELECT (cc.embedding::text::jsonb ->> 0)::float8 AS first FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1`, [SLUG]);
      expect(rows.map(r => Number(r.first))).toEqual([1, 1, 1]);
    });

    test('the segmented dry-run count reads the write column, not embedded_at', async () => {
      const { pageId } = await embeddedPage();
      await engine.executeRaw('UPDATE content_chunks SET embedding = NULL WHERE page_id = $1', [pageId]);
      expect(await countSegmentedEmbedRows(engine, pageId)).toEqual({ total: 3, stale: 3 });
    });

    test('the held report counts rows without a vector in the write column, not only those without embedded_at', async () => {
      const { pageId } = await embeddedPage(4 * 1024 * 1024);
      await engine.executeRaw('UPDATE content_chunks SET embedding = NULL WHERE page_id = $1', [pageId]);
      await holdPageEmbedding(engine, pageId, 'awaiting_approval');
      expect(await listBudgetLimitedPages(engine)).toEqual([expect.objectContaining({ slug: SLUG, state: 'held', pending_chunks: 3 })]);
    });

    test('the held report of a large inline page still counts rows without embedded_at, as before segmented storage', async () => {
      await engine.putPage('notes/inline-held', { type: 'note', title: 'Inline held', compiled_truth: ROW_TEXT(9).repeat(3200), timeline: '', frontmatter: {} });
      const vector = Float32Array.from(await unitVector(engine, 1));
      await installFixtureChunks(engine, 'notes/inline-held', [0, 1, 2].map(i => ({ chunk_index: i, chunk_text: ROW_TEXT(i), chunk_source: 'compiled_truth' as const, embedding: vector })));
      const [page] = await engine.executeRaw<{ id: number; bytes: number }>(
        `SELECT id, octet_length(compiled_truth) AS bytes FROM pages WHERE slug = 'notes/inline-held'`);
      expect(Number(page!.bytes)).toBeGreaterThan(PAGE_INLINE_MAX_BYTES);
      await engine.executeRaw('UPDATE content_chunks SET embedding = NULL WHERE page_id = $1', [page!.id]);
      await holdPageEmbedding(engine, Number(page!.id), 'awaiting_approval');
      expect(await listBudgetLimitedPages(engine)).toEqual([expect.objectContaining({ slug: 'notes/inline-held', state: 'held', pending_chunks: 0 })]);
    });

    test('a segmented write in the hysteresis band defers its embedding like a large page', async () => {
      const sized = (bytes: number) => conversationPage(bytes, { seed: 5 });
      await importFromContent(engine, 'notes/band', sized(SEGMENTED_PROMOTE_ABOVE_BYTES + 128 * 1024), { sourceId: 'default', noEmbed: true });
      const band = await importFromContent(engine, 'notes/band', sized(SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES + 128 * 1024), { sourceId: 'default' });
      expect((await segmentedPageRow(engine, 'notes/band')).body_storage).toBe('segmented');
      expect(band.embedding_deferred).toBe(true);
      expect(await readPageSizeStates(engine, 'default', ['notes/band'])).toEqual([expect.objectContaining({ slug: 'notes/band', embedding: 'deferred' })]);
    }, 240_000);

    describe('a segmented create whose post-commit projection never ran', () => {
      const UNSEALED = 'notes/unsealed';
      beforeEach(async () => {
        installFaultHook(point => { if (point === 'segmented:projection_staged') throw new Error('projection died'); });
        await importFromContent(engine, UNSEALED, conversationPage(SEGMENTED_CREATE_SEAL_MAX_BYTES + 128 * 1024, { seed: 9 }), { sourceId: 'default', noEmbed: true });
        installFaultHook(undefined);
        const page = await segmentedPageRow(engine, UNSEALED);
        await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [page.id]);
        expect(page.body_storage).toBe('segmented');
        expect(page.text_projection_revision).not.toBe(page.knowledge_revision);
      }, 240_000);

      const expectSealedWithChunks = async () => {
        const page = await segmentedPageRow(engine, UNSEALED);
        expect(page.text_projection_revision).toBe(page.knowledge_revision);
        expect((await visibleChunks(engine, page.id)).length).toBeGreaterThan(0);
      };

      test('it counts as a chunkless page with content', async () => {
        expect(await engine.countChunklessPagesWithContent()).toBe(1);
      });

      test('embed --stale projection recovery rebuilds it', async () => {
        const readiness = await prepareEmbeddingProjections(engine, { existingChunksOnly: true, activeSourcesOnly: true, stale: {}, repair: true });
        expect(readiness).toEqual({ rebuilt: 1, blocked: 0 });
        await expectSealedWithChunks();
      }, 120_000);

      test('embed <slug> builds its projection and embeds it', async () => {
        const run = await runEmbedCore(engine, { slugs: [UNSEALED], quiet: true });
        expect(run.failures).toBe(0);
        expect(run.embedded).toBeGreaterThan(0);
        await expectSealedWithChunks();
      }, 120_000);

      test('embed --all builds its projection and embeds it', async () => {
        const run = await runEmbedCore(engine, { all: true, quiet: true });
        expect(run.failures).toBe(0);
        expect(run.embedded).toBeGreaterThan(0);
        await expectSealedWithChunks();
      }, 120_000);
    });
  });
}
