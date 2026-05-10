/**
 * v0.27.1 multimodal — real-Postgres E2E.
 *
 * Runs the v0.27.1 schema (migration v36 + dual embedding columns + files
 * table) against a real Postgres + pgvector and exercises every code path
 * the production user will hit: upsertFile / getFile / listFilesForPage,
 * upsertChunks with modality + embedding_image vector(1024), searchVector
 * column routing, modality filter on searchKeyword, partial HNSW
 * idx_chunks_embedding_image.
 *
 * Skips gracefully when DATABASE_URL is unset.
 *
 * Run: DATABASE_URL=postgresql://... bun test test/e2e/multimodal-postgres.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  test.skip('multimodal-postgres E2E skipped (DATABASE_URL unset)', () => {});
}

describe.skipIf(skip)('multimodal v0.27.1 against real Postgres', () => {
  let pg: PostgresEngine;

  beforeAll(async () => {
    pg = new PostgresEngine();
    await pg.connect({ database_url: DATABASE_URL! });
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (pg) await pg.disconnect();
  }, 30_000);

  beforeEach(async () => {
    // Clean slate so cross-test seeding doesn't bleed. CASCADE pages also
    // cleans content_chunks + tags + raw_data. files cascades on source_id
    // so we hit it explicitly to be safe.
    await pg.executeRaw('DELETE FROM content_chunks');
    await pg.executeRaw('DELETE FROM files');
    await pg.executeRaw('DELETE FROM pages');
  });

  function fakeImage1024(seed: number): Float32Array {
    const out = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) out[i] = (i + seed) / 1024;
    return out;
  }

  test('schema-drift: content_chunks has modality + embedding_image columns on Postgres', async () => {
    const rows = await pg.executeRaw<{ column_name: string; data_type: string; column_default: string | null }>(
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='content_chunks'
         AND column_name IN ('modality','embedding_image')
       ORDER BY column_name`
    );
    expect(rows.length).toBe(2);
    const modality = rows.find(r => r.column_name === 'modality')!;
    expect(modality.data_type).toBe('text');
    expect(modality.column_default).toContain("'text'");
    const embImg = rows.find(r => r.column_name === 'embedding_image')!;
    expect(embImg.data_type).toBe('USER-DEFINED');
  }, 30_000);

  test('partial HNSW index idx_chunks_embedding_image exists with WHERE clause', async () => {
    const rows = await pg.executeRaw<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname='public' AND tablename='content_chunks'
         AND indexname='idx_chunks_embedding_image'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef.toLowerCase()).toContain('hnsw');
    expect(rows[0].indexdef.toLowerCase()).toContain('where');
    expect(rows[0].indexdef.toLowerCase()).toContain('embedding_image is not null');
  }, 30_000);

  test('files table parity: same column shape as PGLite', async () => {
    const rows = await pg.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='files'
       ORDER BY column_name`
    );
    const names = rows.map(r => r.column_name).sort();
    expect(names).toEqual([
      'content_hash',
      'created_at',
      'filename',
      'id',
      'metadata',
      'mime_type',
      'page_id',
      'page_slug',
      'size_bytes',
      'source_id',
      'storage_path',
    ]);
  }, 30_000);

  test('pages.page_kind CHECK admits image (migration v36 widening)', async () => {
    // Insert a page with page_kind='image'. CHECK pre-v0.27.1 would reject.
    const result = await pg.putPage('photos/test-image-page-kind', {
      type: 'image',
      page_kind: 'image',
      title: 'test',
      compiled_truth: '',
      timeline: '',
    });
    expect(result.id).toBeGreaterThan(0);
  }, 30_000);

  test('upsertFile end-to-end on Postgres', async () => {
    const r = await pg.upsertFile({
      filename: 'whiteboard.jpg',
      storage_path: 'originals/photos/whiteboard.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 12345,
      content_hash: 'sha256:wb',
    });
    expect(r.id).toBeGreaterThan(0);
    expect(r.created).toBe(true);

    const fetched = await pg.getFile('default', 'originals/photos/whiteboard.jpg');
    expect(fetched).not.toBeNull();
    expect(fetched!.filename).toBe('whiteboard.jpg');

    // Re-upsert same path → no-op (created=false)
    const r2 = await pg.upsertFile({
      filename: 'whiteboard.jpg',
      storage_path: 'originals/photos/whiteboard.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 12345,
      content_hash: 'sha256:wb',
    });
    expect(r2.id).toBe(r.id);
    expect(r2.created).toBe(false);
  }, 30_000);

  test('upsertChunks writes embedding_image + modality columns (round-trip)', async () => {
    const page = await pg.putPage('photos/round-trip', {
      type: 'image', page_kind: 'image',
      title: 'round-trip', compiled_truth: '', timeline: '',
    });

    const vec = fakeImage1024(7);
    await pg.upsertChunks('photos/round-trip', [
      {
        chunk_index: 0,
        chunk_text: 'round-trip',
        chunk_source: 'image_asset',
        embedding_image: vec,
        modality: 'image',
      },
    ]);

    // Verify the row landed with modality='image' and embedding_image is non-NULL.
    const rows = await pg.executeRaw<{ modality: string; has_image: boolean; has_text: boolean }>(
      `SELECT modality,
              embedding_image IS NOT NULL AS has_image,
              embedding IS NOT NULL AS has_text
       FROM content_chunks WHERE page_id = $1`,
      [page.id]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].modality).toBe('image');
    expect(rows[0].has_image).toBe(true);
    expect(rows[0].has_text).toBe(false); // image rows leave embedding NULL
  }, 30_000);

  test('searchVector with embeddingColumn=embedding_image returns image rows on Postgres', async () => {
    // Seed: one text page (1536-dim primary embedding) and two image pages
    // (1024-dim embedding_image).
    const textVec = new Float32Array(1536);
    for (let i = 0; i < 1536; i++) textVec[i] = i / 1536;
    await pg.putPage('notes/text-only', {
      type: 'note', title: 'text only', compiled_truth: 'body', timeline: '',
    });
    await pg.upsertChunks('notes/text-only', [{
      chunk_index: 0, chunk_text: 'body',
      chunk_source: 'compiled_truth',
      embedding: textVec, modality: 'text',
    }]);

    const imgA = fakeImage1024(0);
    const imgB = fakeImage1024(500);
    await pg.putPage('photos/a', {
      type: 'image', page_kind: 'image',
      title: 'a', compiled_truth: '', timeline: '',
    });
    await pg.upsertChunks('photos/a', [{
      chunk_index: 0, chunk_text: 'a',
      chunk_source: 'image_asset',
      embedding_image: imgA, modality: 'image',
    }]);
    await pg.putPage('photos/b', {
      type: 'image', page_kind: 'image',
      title: 'b', compiled_truth: '', timeline: '',
    });
    await pg.upsertChunks('photos/b', [{
      chunk_index: 0, chunk_text: 'b',
      chunk_source: 'image_asset',
      embedding_image: imgB, modality: 'image',
    }]);

    // Image-similarity query nearest to imgB.
    const hits = await pg.searchVector(imgB, {
      limit: 5,
      embeddingColumn: 'embedding_image',
    });
    const slugs = hits.map(h => h.slug);
    expect(slugs).toContain('photos/b');
    // Modality filter excludes the text page even though dim mismatches.
    expect(slugs).not.toContain('notes/text-only');
    // Nearest-first ordering.
    expect(hits[0].slug).toBe('photos/b');
  }, 30_000);

  test('searchKeyword hides image rows by default (modality filter on Postgres)', async () => {
    // Seed text + image pages with chunk_text the FTS would normally match.
    const textVec = new Float32Array(1536);
    for (let i = 0; i < 1536; i++) textVec[i] = (i + 1) / 1536;
    await pg.putPage('notes/keyword', {
      type: 'note', title: 'keyword', compiled_truth: 'sunset photo at the beach', timeline: '',
    });
    await pg.upsertChunks('notes/keyword', [{
      chunk_index: 0,
      chunk_text: 'sunset photo at the beach',
      chunk_source: 'compiled_truth',
      embedding: textVec, modality: 'text',
    }]);
    await pg.putPage('photos/keyword', {
      type: 'image', page_kind: 'image',
      title: 'keyword image', compiled_truth: '', timeline: '',
    });
    await pg.upsertChunks('photos/keyword', [{
      chunk_index: 0,
      chunk_text: 'sunset photo at the beach',
      chunk_source: 'image_asset',
      embedding_image: fakeImage1024(2), modality: 'image',
    }]);

    const out = await pg.searchKeyword('sunset', { limit: 10 });
    const slugs = out.map(r => r.slug);
    expect(slugs).toContain('notes/keyword');
    expect(slugs).not.toContain('photos/keyword');
  }, 30_000);

  test('cross-engine parity: same fixture, identical chunk + file shape on PGLite + Postgres', async () => {
    // Direct comparison against PGLite for the dual-column architecture.
    // Closes Eng-3G (the v0.27.1 plan's parity gate).
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();

    try {
      const vec = fakeImage1024(42);
      const slug = 'photos/parity-test';
      const fileSpec = {
        filename: 'parity.jpg',
        storage_path: 'originals/photos/parity-test.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 999,
        content_hash: 'sha256:parity',
      };

      // PGLite (already clean since it's fresh).
      const pglitePage = await pglite.putPage(slug, {
        type: 'image', page_kind: 'image',
        title: 'parity', compiled_truth: '', timeline: '',
      });
      await pglite.upsertFile({ ...fileSpec, page_id: pglitePage.id, page_slug: slug });
      await pglite.upsertChunks(slug, [{
        chunk_index: 0, chunk_text: 'parity',
        chunk_source: 'image_asset',
        embedding_image: vec, modality: 'image',
      }]);

      // Postgres.
      const pgPage = await pg.putPage(slug, {
        type: 'image', page_kind: 'image',
        title: 'parity', compiled_truth: '', timeline: '',
      });
      await pg.upsertFile({ ...fileSpec, page_id: pgPage.id, page_slug: slug });
      await pg.upsertChunks(slug, [{
        chunk_index: 0, chunk_text: 'parity',
        chunk_source: 'image_asset',
        embedding_image: vec, modality: 'image',
      }]);

      // Pull both pages and assert structural equality (excluding id + timestamps).
      const pgliteFile = await pglite.getFile('default', fileSpec.storage_path);
      const pgFile = await pg.getFile('default', fileSpec.storage_path);
      expect(pgliteFile).not.toBeNull();
      expect(pgFile).not.toBeNull();
      expect(pgliteFile!.filename).toBe(pgFile!.filename);
      expect(pgliteFile!.mime_type).toBe(pgFile!.mime_type);
      // PGLite returns size_bytes as BigInt, Postgres as Number — both are
      // valid for a BIGINT column. Compare numerically.
      expect(Number(pgliteFile!.size_bytes)).toBe(Number(pgFile!.size_bytes));
      expect(pgliteFile!.content_hash).toBe(pgFile!.content_hash);
      expect(pgliteFile!.source_id).toBe(pgFile!.source_id);

      // Modality + presence checks via raw SQL (chunk shape, not API).
      const pgliteRows = await pglite.executeRaw<{ modality: string; has_image: boolean }>(
        `SELECT modality, embedding_image IS NOT NULL AS has_image
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
         WHERE p.slug = $1`,
        [slug]
      );
      const pgRows = await pg.executeRaw<{ modality: string; has_image: boolean }>(
        `SELECT modality, embedding_image IS NOT NULL AS has_image
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
         WHERE p.slug = $1`,
        [slug]
      );
      expect(pgliteRows[0].modality).toBe(pgRows[0].modality);
      expect(pgliteRows[0].has_image).toBe(pgRows[0].has_image);
    } finally {
      await pglite.disconnect();
    }
  }, 30_000);

  test('migration v36 ran (schema_version >= 36)', async () => {
    // initSchema runs migrations; verify config table reflects v36+ landed.
    const v = await pg.getConfig('version');
    const ver = parseInt(v ?? '0', 10);
    expect(ver).toBeGreaterThanOrEqual(36);
  }, 30_000);
});
