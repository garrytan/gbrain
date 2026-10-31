import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { readEmbeddingState } from '../src/core/embedding-state.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

describe('issue 7858: embedding state respects purge restore holds', () => {
  test('restorable retired atom chunks past 72 hours are not overdue during the restore hold', async () => {
    await engine.putPage('notes/source', { type: 'note', title: 'source', compiled_truth: 'source body' });
    await engine.putPage('atoms/source-atom', { type: 'atom', title: 'atom', compiled_truth: 'atom body' });
    const [atom] = await engine.executeRaw<{ id: number }>(`UPDATE pages SET
      frontmatter = $1::jsonb, deleted_at = now() - interval '100 hours'
      WHERE slug = 'atoms/source-atom' RETURNING id`, [JSON.stringify({ source_slug: 'notes/source', source_hash: 'hash-1', retired_by: 'managed-reextract', retired_at: new Date().toISOString() })]);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding, embedding_pending_since)
      VALUES ($1, 0, 'retired atom', array_fill(0.1::real, ARRAY[1536])::vector, NULL)`, [atom!.id]);

    const state = await readEmbeddingState(engine, { mode: 'full' });
    expect(state.deleted_page_chunks).toMatchObject({ within_window: 1, past_window: 0 });
  });
});
