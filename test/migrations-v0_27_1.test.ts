// Phase 5 + Eng-3C: migration v39 (multimodal_dual_column_v0_27_1) contract.
//
// Verifies:
// - SQL shape: modality column with DEFAULT 'text', embedding_image vector(1024),
//   partial HNSW index `idx_chunks_embedding_image WHERE embedding_image IS NOT NULL`,
//   PGLite gains the `files` table.
// - Eng-3C preflight: pgvector < 0.5 refusal BEFORE DDL fires (Postgres-only;
//   PGLite ships pgvector built into the WASM bundle so the gate is a no-op).
// - End-to-end on PGLite: clean apply on a fresh brain.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('migration v39 (multimodal dual-column + PGLite files)', () => {
  test('SQL shape: present in MIGRATIONS array as version 39', () => {
    const m = MIGRATIONS.find(x => x.version === 39);
    expect(m).toBeDefined();
    expect(m!.name).toBe('multimodal_dual_column_v0_27_1');
    // Handler-driven: empty `sql`, populated `handler`.
    expect(m!.sql).toBe('');
    expect(typeof m!.handler).toBe('function');
  });

  test('handler is idempotent — running twice on a clean brain does not error', async () => {
    const m = MIGRATIONS.find(x => x.version === 39)!;
    // The PGLite engine ran v39 during initSchema in beforeAll. Re-running
    // the handler should be a true no-op thanks to ADD COLUMN IF NOT EXISTS
    // + CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
    await m.handler!(engine);
    await m.handler!(engine);
    // No throw means the IF NOT EXISTS guards work.
  });

  test('content_chunks has modality + embedding_image columns post-migration', async () => {
    const rows = await engine.executeRaw<{ column_name: string; data_type: string; column_default: string | null }>(
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'content_chunks'
         AND column_name IN ('modality', 'embedding_image')
       ORDER BY column_name`
    );
    expect(rows.length).toBe(2);
    const modality = rows.find(r => r.column_name === 'modality')!;
    expect(modality.data_type).toBe('text');
    // Default is the literal 'text'::text.
    expect(modality.column_default).toContain("'text'");
    const embImg = rows.find(r => r.column_name === 'embedding_image')!;
    expect(embImg.data_type).toBe('USER-DEFINED'); // pgvector type — show up as USER-DEFINED.
  });

  test('partial HNSW index exists on embedding_image', async () => {
    const rows = await engine.executeRaw<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'content_chunks'
         AND indexname = 'idx_chunks_embedding_image'`
    );
    expect(rows.length).toBe(1);
    // Index is partial (WHERE embedding_image IS NOT NULL).
    expect(rows[0].indexdef.toLowerCase()).toContain('where');
    expect(rows[0].indexdef.toLowerCase()).toContain('embedding_image is not null');
    expect(rows[0].indexdef.toLowerCase()).toContain('hnsw');
  });

  test('PGLite gained the files table (F1)', async () => {
    const rows = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'files'`
    );
    expect(rows.length).toBe(1);
  });

  test('PGLite files table has the same columns as Postgres (parity)', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'files'
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
  });

  test('Eng-3C: handler text mentions pgvector >= 0.5 in error message', async () => {
    const m = MIGRATIONS.find(x => x.version === 39)!;
    // The error message string is the user-facing fix hint. Pin its presence
    // via toString() inspection of the handler — looking for the version
    // requirement so future refactors don't accidentally drop it.
    const handlerSrc = m.handler!.toString();
    expect(handlerSrc).toContain('pgvector >= 0.5');
    expect(handlerSrc).toContain('ALTER EXTENSION vector UPDATE');
  });

  test('partial HNSW index is queryable via vector cosine on a fresh row', async () => {
    // Seed a page + chunk with embedding_image populated. Verify that
    // searching by cosine distance finds it (proves the index is not
    // accidentally invalid — a regression mode pgvector has historically
    // shown when partial-index DDL succeeds but the index fails build).
    const pageRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ['photos/probe', 'media', 'Probe', '', '']
    );
    const pageId = pageRows[0].id;
    // 1024 dims of 0.5 — a valid Voyage multimodal-shaped vector.
    const vec = '[' + Array.from({ length: 1024 }, () => 0.5).join(',') + ']';
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, modality, embedding_image)
       VALUES ($1, 0, $2, 'image', $3::vector)`,
      [pageId, 'probe', vec]
    );
    const hits = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM content_chunks
       WHERE embedding_image IS NOT NULL
       ORDER BY embedding_image <=> $1::vector
       LIMIT 1`,
      [vec]
    );
    expect(hits.length).toBe(1);
  });
});
