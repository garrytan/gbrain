/**
 * doctor `embedding_state` must not call chunks "overdue" for a page that
 * `pages purge-deleted` refuses to select (derived-retirement restore hold),
 * or the advertised fix can never reduce the count. PGLite in-memory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readEmbeddingState } from '../src/core/embedding-state.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function deletedPage(slug: string, frontmatter: Record<string, unknown>): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body` }, { sourceId: 'default' });
  const [row] = await engine.executeRaw<{ id: number }>(
    `UPDATE pages SET frontmatter = $2::jsonb, deleted_at = now() - make_interval(hours => 100) WHERE slug = $1 RETURNING id`,
    [slug, JSON.stringify(frontmatter)]);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [row!.id]);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding_pending_since) VALUES ($1, 0, 'c', now())`, [row!.id]);
}

describe('embedding_state overdue deleted-page chunks', () => {
  test('a purge-held page is not counted as past the window; a plain one is', async () => {
    await deletedPage('notes/held-retired', { retired_by: 'extract-atoms' });
    await deletedPage('notes/plain-deleted', {});
    const purgeable = await engine.purgeDeletedPages(72, { dryRun: true });
    expect(purgeable.slugs).toEqual(['notes/plain-deleted']);
    for (const mode of ['full', 'ops'] as const) {
      const s = await readEmbeddingState(engine, { mode });
      expect((s.deleted_page_chunks as { past_window: number }).past_window).toBe(purgeable.count);
    }
  });
});
