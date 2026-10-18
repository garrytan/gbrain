/**
 * #6696 B3 embedding state on real Postgres: the classifier and listing run
 * through PostgresEngine's scoped-read transaction, the ops tier's EXPLAIN
 * estimate binds parameters and parses postgres.js's json plan, and a custom
 * active column without a covering partial index is `unknown` on the ops tier
 * (never a scan) until one exists. The PGLite unit suite covers the same SQL;
 * this arm covers the Postgres driver path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { readEmbeddingState } from '../../src/core/embedding-state.ts';

const d = hasDatabase() ? describe : describe.skip;

beforeAll(async () => {
  if (!hasDatabase()) return;
  await setupDB();
});
afterAll(async () => { if (hasDatabase()) await teardownDB(); });

async function page(slug: string, frontmatter: Record<string, unknown> = {}, deletedHoursAgo: number | null = null, body = `${slug} body`): Promise<number> {
  const engine = getEngine();
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
  const [row] = await engine.executeRaw<{ id: number }>(
    `UPDATE pages SET frontmatter = ($2::text)::jsonb, deleted_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(hours => $3::int) END
      WHERE slug = $1 AND source_id = 'default' RETURNING id`, [slug, JSON.stringify(frontmatter), deletedHoursAgo]);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [row!.id]);
  return row!.id;
}

async function chunk(pageId: number, index: number, vector: boolean): Promise<void> {
  const [{ dims }] = await getEngine().executeRaw<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
  await getEngine().executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding, embedding_pending_since)
     VALUES ($1, $2, 'text', ${vector ? `array_fill(0.1::real, ARRAY[${Number(dims)}])::vector` : 'NULL'}, ${vector ? 'NULL' : 'now()'})`, [pageId, index]);
}

d('embedding state (Postgres)', () => {
  test('full and ops counts, listing and the custom-column unknown arm', async () => {
    const engine = getEngine();
    const embedded = await page('notes/alice-example');
    await chunk(embedded, 0, true);
    const pending = await page('notes/acme-example');
    await chunk(pending, 0, false);
    await chunk(pending, 1, false);
    await chunk(await page('notes/fund-a-oversized', { embed_skip: { reason: 'oversized', bytes: 600_000, assessed_at: '2026-01-01T00:00:00Z' } }), 0, false);
    await page('notes/junk-hidden', { quarantine: { reason: 'junk_pattern', detail: 'captcha', assessed_at: '2026-01-01T00:00:00Z' } });
    await page('notes/empty-stub', {}, null, '');
    await page('notes/stub-with-body');
    await chunk(await page('notes/deleted-old', {}, 100), 0, true);

    const full = await readEmbeddingState(engine, { mode: 'full', sourceIds: ['default'] });
    expect(full.counts).toEqual({ embedded: 1, pending: 2, keyword_only: 1, quarantined: 1, empty: 1, deleted_page_chunks: 1, chunkless_healable: 1 });
    expect(full.deleted_page_chunks).toMatchObject({ past_window: 1, within_window: 0 });

    const ops = await readEmbeddingState(engine, { mode: 'ops', sourceIds: ['default'] });
    expect(ops).toMatchObject({ status: 'known', basis: 'estimated', covering_index: 'content_chunks_stale_idx' });
    expect(ops.counts).toMatchObject({ pending: 2, keyword_only: 1, quarantined: 1, deleted_page_chunks: 1 });
    expect(typeof ops.counts.embedded).toBe('number');

    const rows = await engine.listEmbeddingStateRows({ sourceIds: ['default'], states: ['pending', 'deleted_page_chunks'], limit: 10, purgeWindowHours: 72 });
    expect(rows.map(r => [r.state, r.slug, r.chunks, r.overdue])).toEqual([
      ['deleted_page_chunks', 'notes/deleted-old', 1, true],
      ['pending', 'notes/acme-example', 2, false],
    ]);

    await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_e2e8 vector(8)');
    await engine.setConfig('embedding_columns', JSON.stringify({ embedding_e2e8: { provider: 'openai:text-embedding-3-small', dimensions: 8, type: 'vector' } }));
    await engine.setConfig('search_embedding_column', 'embedding_e2e8');
    try {
      expect(await readEmbeddingState(engine, { mode: 'ops' })).toMatchObject({ status: 'unknown', reason: 'no_covering_index', active_column: 'embedding_e2e8', unsearchable: null });
      expect((await readEmbeddingState(engine, { mode: 'full' })).counts).toMatchObject({ embedded: 0, pending: 3 });
      await engine.executeRaw('CREATE INDEX content_chunks_e2e8_stale_idx ON content_chunks(page_id, chunk_index) WHERE embedding_e2e8 IS NULL');
      expect(await readEmbeddingState(engine, { mode: 'ops' })).toMatchObject({ status: 'known', covering_index: 'content_chunks_e2e8_stale_idx', counts: { pending: 3 } });
    } finally {
      await engine.unsetConfig('search_embedding_column');
      await engine.unsetConfig('embedding_columns');
      await engine.executeRaw('DROP INDEX IF EXISTS content_chunks_e2e8_stale_idx');
      await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_e2e8');
    }
  });
});
