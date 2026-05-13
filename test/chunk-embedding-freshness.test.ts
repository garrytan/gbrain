import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let pglite: PGLiteEngine;
let sqlite: SQLiteEngine;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();

  sqlite = new SQLiteEngine();
  await sqlite.connect({ engine: 'sqlite', database_path: ':memory:' });
  await sqlite.initSchema();
});

afterAll(async () => {
  await pglite.disconnect();
  await sqlite.disconnect();
});

async function clearEngine(engine: PGLiteEngine | SQLiteEngine): Promise<void> {
  if (engine instanceof PGLiteEngine) {
    await (engine as any).db.exec(`
      DELETE FROM content_chunks;
      DELETE FROM pages;
    `);
    return;
  }

  (engine as any).database.exec(`
    DELETE FROM content_chunks;
    DELETE FROM pages;
  `);
}

async function expectEmbeddingClearedWhenChunkIdentityChanges(engine: BrainEngine): Promise<void> {
  await engine.putPage('concepts/chunk-freshness', {
    type: 'concept',
    title: 'Chunk Freshness',
    compiled_truth: 'Initial embedded chunk text.',
  });

  await engine.upsertChunks('concepts/chunk-freshness', [{
    chunk_index: 0,
    chunk_text: 'Initial embedded chunk text.',
    chunk_source: 'compiled_truth',
    embedding: new Float32Array(768).fill(0.25),
    model: 'test-embedding-v1',
  }]);

  const initial = (await engine.getChunksWithEmbeddings('concepts/chunk-freshness'))[0]!;
  expect(initial.embedding).not.toBeNull();
  expect(initial.embedded_at).not.toBeNull();
  expect(initial.chunk_content_hash).toBeTruthy();

  await engine.upsertChunks('concepts/chunk-freshness', [{
    chunk_index: 0,
    chunk_text: 'Changed chunk text must not keep the old embedding.',
    chunk_source: 'compiled_truth',
    model: 'test-embedding-v1',
  }]);

  const changed = (await engine.getChunksWithEmbeddings('concepts/chunk-freshness'))[0]!;
  expect(changed.chunk_text).toBe('Changed chunk text must not keep the old embedding.');
  expect(changed.chunk_content_hash).toBeTruthy();
  expect(changed.chunk_content_hash).not.toBe(initial.chunk_content_hash);
  expect(changed.embedding).toBeNull();
  expect(changed.embedded_at).toBeNull();
}

describe('chunk embedding freshness identity', () => {
  beforeEach(async () => {
    await clearEngine(pglite);
    await clearEngine(sqlite);
  });

  test('SQLite clears preserved embeddings when chunk text changes without a replacement embedding', async () => {
    await expectEmbeddingClearedWhenChunkIdentityChanges(sqlite);
  });

  test('PGLite clears preserved embeddings when chunk text changes without a replacement embedding', async () => {
    await expectEmbeddingClearedWhenChunkIdentityChanges(pglite);
  });

  test('PGLite preserves embeddings for unchanged chunks backfilled by migration 36', async () => {
    const page = await pglite.putPage('concepts/migrated-chunk-freshness', {
      type: 'concept',
      title: 'Migrated Chunk Freshness',
      compiled_truth: 'Migrated embedded chunk text.',
    });
    const migratedHash = createHash('md5')
      .update('compiled_truth\nMigrated embedded chunk text.')
      .digest('hex');

    await (pglite as any).db.query(
      `INSERT INTO content_chunks (
        page_id, chunk_index, chunk_text, chunk_source, chunk_content_hash, embedding, model, token_count, embedded_at
      ) VALUES ($1, 0, $2, 'compiled_truth', $3, $4::vector, 'test-embedding-v1', NULL, now())`,
      [
        page.id,
        'Migrated embedded chunk text.',
        migratedHash,
        `[${Array.from(new Float32Array(768).fill(0.5)).join(',')}]`,
      ],
    );

    await pglite.upsertChunks('concepts/migrated-chunk-freshness', [{
      chunk_index: 0,
      chunk_text: 'Migrated embedded chunk text.',
      chunk_source: 'compiled_truth',
      model: 'test-embedding-v1',
    }]);

    const unchanged = (await pglite.getChunksWithEmbeddings('concepts/migrated-chunk-freshness'))[0]!;
    expect(unchanged.chunk_content_hash).toBe(migratedHash);
    expect(unchanged.embedding).not.toBeNull();
    expect(unchanged.embedded_at).not.toBeNull();
  });
});
