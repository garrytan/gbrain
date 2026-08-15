/**
 * v0.41.31 — real stale semantics via pages.embedding_signature (PGLite).
 *
 * Pins the commit-3 contract:
 *   - R-4 (grandfather, CRITICAL): a page embedded under a NULL signature is
 *     NEVER stale. After the v108 migration every existing page has NULL, so
 *     the next embed --stale must NOT re-embed the whole corpus.
 *   - signature mismatch (model/dims swap) → counted as stale.
 *   - matching signature → not stale.
 *   - invalidateStaleSignatureEmbeddings NULLs only mismatched (grandfathered
 *     NULL + matching untouched) and returns the count.
 *   - setPageEmbeddingSignature stamps.
 *
 * Canonical PGLite block (CLAUDE.md R3+R4).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;
let colDim: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
  );
  colDim = Number(rows[0]?.dim);
});

/**
 * Seed a page with one EMBEDDED chunk (non-null vector) and a given
 * embedding_signature (null → grandfathered legacy state).
 */
async function seedEmbedded(slug: string, text: string, signature: string | null, sourceId?: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` }, sourceId ? { sourceId } : undefined);
  const chunks: ChunkInput[] = [
    { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined },
  ];
  await engine.upsertChunks(slug, chunks, sourceId ? { sourceId } : undefined);
  // Flip the chunk to a non-null vector sized to the actual column dim.
  await engine.executeRaw(
    `UPDATE content_chunks
        SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[$1::int]), ',') || ']')::vector
      WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = $3)`,
    [colDim, slug, sourceId ?? 'default'],
  );
  if (signature !== null) {
    await engine.setPageEmbeddingSignature(slug, { sourceId, signature });
  }
}

describe('embedding_signature stale semantics', () => {
  test('R-4 GRANDFATHER: NULL signature is never stale', async () => {
    await seedEmbedded('legacy', 'abcde', null); // embedded, NULL signature
    // No NULL embeddings, NULL signature → not stale under any signature.
    expect(await engine.countStaleChunks({ signature: 'openai:m:1536' })).toBe(0);
    expect(await engine.sumStaleChunkChars({ signature: 'openai:m:1536' })).toBe(0);
  });

  test('signature MISMATCH (model swap) is counted as stale', async () => {
    await seedEmbedded('drifted', 'abcde', 'openai:old:1536'); // 5 chars
    expect(await engine.countStaleChunks({ signature: 'voyage:new:1024' })).toBe(1);
    expect(await engine.sumStaleChunkChars({ signature: 'voyage:new:1024' })).toBe(5);
    // Without the signature opt, the legacy NULL-only predicate ignores it.
    expect(await engine.countStaleChunks()).toBe(0);
  });

  test('MATCHING signature is not stale', async () => {
    await seedEmbedded('fresh', 'abcde', 'voyage:new:1024');
    expect(await engine.countStaleChunks({ signature: 'voyage:new:1024' })).toBe(0);
    expect(await engine.sumStaleChunkChars({ signature: 'voyage:new:1024' })).toBe(0);
  });

  test('invalidateStaleSignatureEmbeddings NULLs only mismatched; grandfathered + matching untouched', async () => {
    await seedEmbedded('old', 'abcde', 'openai:old:1536'); // mismatched → invalidate
    await seedEmbedded('legacy', 'fghij', null); // grandfathered → keep
    await seedEmbedded('new', 'klmno', 'voyage:new:1024'); // matching → keep

    const invalidated = await engine.invalidateStaleSignatureEmbeddings({ signature: 'voyage:new:1024' });
    expect(invalidated).toBe(1); // only 'old'

    // Now exactly the 'old' page's chunk is NULL → legacy stale count = 1.
    expect(await engine.countStaleChunks()).toBe(1);
    // Re-running is idempotent (nothing left to invalidate).
    expect(await engine.invalidateStaleSignatureEmbeddings({ signature: 'voyage:new:1024' })).toBe(0);
  });

  test('invalidate is sourceId-scoped', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await seedEmbedded('a', 'abcde', 'openai:old:1536'); // default
    await seedEmbedded('b', 'fghij', 'openai:old:1536', 'other'); // other
    const n = await engine.invalidateStaleSignatureEmbeddings({ signature: 'voyage:new:1024', sourceId: 'default' });
    expect(n).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: 'other' })).toBe(0); // untouched
  });

  test('setPageEmbeddingSignature stamps the page', async () => {
    await engine.putPage('p', { type: 'note', title: 'p', compiled_truth: '# p' });
    await engine.setPageEmbeddingSignature('p', { signature: 'openai:m:1536' });
    const rows = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'p' AND source_id = 'default'`,
    );
    expect(rows[0]?.embedding_signature).toBe('openai:m:1536');
  });
});
