/**
 * Wave B: the oversized-page backfill (`gbrain reindex --oversized`) on
 * segmented pages.
 *
 * 1. Protects: a segmented page carrying the gate's `embed_skip: oversized`
 *    marker is sized by `pages.body_bytes` (its row has no body columns):
 *    while it is over the block it counts in `over_block` and is left alone;
 *    once the block is raised above it, it is a candidate, and the backfill
 *    rewrites it through the segmented write path without the marker, holds
 *    its embedding for approval, and leaves it sealed, segmented, byte-identical
 *    and keyword-searchable.
 * 2. Fails when: the size SQL reads `compiled_truth` (NULL for a segmented
 *    page, so the page is never counted or rewritten), or the rewrite reads
 *    the page's throwing body getters (`page_body_segmented`).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { isEmbedSkipped } from '../../src/core/embed-skip.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { runOversizedBackfill, BACKFILL_HOLD_REASON } from '../../src/core/oversized-backfill.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { reconstructedPage } from '../helpers/segmented-page-checks.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-backfill-segmented-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, HOME: home, GBRAIN_AUDIT_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const NEEDLE = 'zqxbackfillneedle';
const content = conversationPage(2 * 1024 * 1024, { seed: 81, needles: [{ at: 0.6, word: NEEDLE }] });

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('a marked segmented page is sized by body_bytes, counted over the block, then rewritten without the marker under it', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('content_sanity.bytes_block', '500000');
    expect((await importFromContent(engine, 'notes/backfill', content, { noEmbed: true })).status).toBe('imported');
    const before = await reconstructedPage(engine, 'notes/backfill');
    expect(before.page.body_storage).toBe('segmented');
    expect(isEmbedSkipped(before.page.frontmatter)).toBe(true);

    const over = await runOversizedBackfill(engine, { dryRun: true });
    expect(over).toMatchObject({ candidates: 0, over_block: 1 });

    await engine.unsetConfig('content_sanity.bytes_block');
    expect(await runOversizedBackfill(engine, { dryRun: true })).toMatchObject({ candidates: 1, over_block: 0, held_for_approval: 1 });
    const receipt = await runOversizedBackfill(engine);
    expect(receipt).toMatchObject({ candidates: 1, reindexed: 1, held_for_approval: 1, remaining: 0, failed: [] });

    const after = await reconstructedPage(engine, 'notes/backfill');
    expect(after.page.id).toBe(before.page.id);
    expect(after.page.body_storage).toBe('segmented');
    expect(isEmbedSkipped(after.page.frontmatter)).toBe(false);
    expect(after.body).toEqual(before.body);
    expect(after.body.compiled_truth).toBe(parseMarkdown(content, 'notes/backfill.md').compiled_truth);
    expect(after.page.content_hash).toBe(after.hash);
    expect(after.page.text_projection_revision).toBe(after.page.knowledge_revision);
    const [budget] = await engine.executeRaw<{ state: string; reason: string }>('SELECT state, reason FROM page_embedding_budget WHERE page_id=$1', [after.page.id]);
    expect(budget).toMatchObject({ state: 'held', reason: BACKFILL_HOLD_REASON });
    expect((await engine.searchKeyword(NEEDLE, { limit: 10 })).map(hit => hit.slug)).toContain('notes/backfill');
    expect(await runOversizedBackfill(engine, { dryRun: true })).toMatchObject({ candidates: 0, over_block: 0 });
  }
}), 300_000);

test('the backfill keeps a verified importer author on a segmented page whose text it does not change (GST-4056)', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('content_sanity.bytes_block', '500000');
    const slug = 'notes/backfill-imported';
    expect((await importFromContent(engine, slug, content, { noEmbed: true, ingested_via: 'cli:transcripts-ingest' })).status).toBe('imported');
    const author = () => engine.executeRaw<{ content_author: string | null; stamped: boolean }>(
      "SELECT content_author, content_author_hash IS NOT DISTINCT FROM content_hash AS stamped FROM pages WHERE source_id = 'default' AND slug = $1", [slug]);
    expect(await author()).toEqual([{ content_author: 'cli:transcripts-ingest', stamped: true }]);
    await engine.unsetConfig('content_sanity.bytes_block');
    expect(await runOversizedBackfill(engine)).toMatchObject({ reindexed: 1, failed: [] });
    expect(await author()).toEqual([{ content_author: 'cli:transcripts-ingest', stamped: true }]);
  }
}), 300_000);

test('the backfill never writes its snapshot over a page that changed after it was read (GST-4056)', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('content_sanity.bytes_block', '500000');
    const slug = 'notes/backfill-raced';
    expect((await importFromContent(engine, slug, content, { noEmbed: true })).status).toBe('imported');
    await engine.unsetConfig('content_sanity.bytes_block');
    const revision = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const read = engine.readPageSnapshot.bind(engine);
    let raced: string | undefined;
    engine.readPageSnapshot = async (s, opts) => {
      const snapshot = await read(s, opts);
      if (s === slug && raced === undefined) {
        raced = '';
        await engine.addTag(slug, 'raced-example', { sourceId: 'default' });
        raced = await revision();
      }
      return snapshot;
    };
    try {
      const receipt = await runOversizedBackfill(engine);
      expect(receipt.reindexed).toBe(0);
      expect(receipt.failed).toHaveLength(1);
    } finally {
      engine.readPageSnapshot = read;
    }
    expect(await revision()).toBe(raced!);
  }
}), 300_000);
