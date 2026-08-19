/**
 * Migration v133 (#4246): content_chunk_embedding_revision.
 *
 * Upgrade contract: preserve every existing vector and grandfather it at
 * revision 1/1 (no blind re-embed), then fail closed for future unstamped or
 * content-mismatched vectors. Re-running the idempotent migration must never
 * re-grandfather a mismatch created after the first upgrade.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let dims: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass
        AND attname = 'embedding' AND attnum > 0`,
  );
  dims = Number(rows[0]?.dim);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function vector(): Float32Array {
  const value = new Float32Array(dims);
  value[0] = 1;
  value[1] = 1;
  return value;
}

async function seedLegacyVector(): Promise<void> {
  await engine.putPage('fixture/pre-v133', {
    type: 'note', title: 'Pre-v133 fixture', compiled_truth: 'Legacy text',
  });
  await engine.upsertChunks('fixture/pre-v133', [{
    chunk_index: 0,
    chunk_text: 'Legacy text',
    chunk_source: 'compiled_truth',
    embedding: vector(),
    token_count: 3,
  }]);

  // Reconstruct the pre-v133 table shape while retaining the legacy vector.
  await engine.executeRaw('DROP INDEX IF EXISTS content_chunks_stale_revision_idx');
  await engine.executeRaw('DROP TRIGGER IF EXISTS bump_chunk_content_revision_trg ON content_chunks');
  await engine.executeRaw('DROP FUNCTION IF EXISTS bump_chunk_content_revision_fn');
  await engine.executeRaw('DROP TRIGGER IF EXISTS bump_contextual_embedding_revisions_trg ON pages');
  await engine.executeRaw('DROP FUNCTION IF EXISTS bump_contextual_embedding_revisions_fn');
  await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedded_content_revision');
  await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS content_revision');
  await engine.setConfig('version', '132');
}

describe('migration v133 — structure', () => {
  test('tracks embedding inputs without a timestamp-based predicate', () => {
    const migration = MIGRATIONS.find((item) => item.version === 133);
    expect(migration?.name).toBe('content_chunk_embedding_revision');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('content_revision BIGINT NOT NULL DEFAULT 1');
    expect(migration?.sql).toContain('embedded_content_revision BIGINT DEFAULT 1');
    expect(migration?.sql).toContain('ALTER COLUMN embedded_content_revision DROP DEFAULT');
    expect(migration?.sql).toContain('OLD.chunk_text IS DISTINCT FROM NEW.chunk_text');
    expect(migration?.sql).toContain('OLD.chunk_source IS DISTINCT FROM NEW.chunk_source');
    expect(migration?.sql).toContain('REFERENCING NEW TABLE AS new_chunks');
    expect(migration?.sql).toContain('REFERENCING OLD TABLE AS old_chunks');
    expect(migration?.sql).toContain('REFERENCING OLD TABLE AS old_chunks NEW TABLE AS new_chunks');
    expect(migration?.sql).toContain('OLD.title IS DISTINCT FROM NEW.title');
    expect(migration?.sql).toContain('OLD.timeline IS DISTINCT FROM NEW.timeline');
    expect(migration?.sql).toContain("OLD.contextual_retrieval_mode = 'per_chunk_synopsis'");
    expect(migration?.sql).toContain('content_chunks_stale_revision_idx');
    expect(migration?.sql).not.toContain('pages.updated_at');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(133);
  });
});

describe('migration v133 — upgrade semantics', () => {
  test('grandfathers legacy vectors once, then detects and preserves future mismatch', async () => {
    await seedLegacyVector();

    const applied = await runMigrations(engine);
    expect(applied.current).toBe(LATEST_VERSION);
    expect(applied.applied).toBeGreaterThanOrEqual(1);

    const upgraded = await engine.executeRaw<{
      embedding_null: boolean;
      content_revision: string;
      embedded_content_revision: string | null;
      embedded_default: string | null;
    }>(`
      SELECT cc.embedding IS NULL AS embedding_null,
             cc.content_revision::text,
             cc.embedded_content_revision::text,
             (SELECT column_default FROM information_schema.columns
               WHERE table_name = 'content_chunks'
                 AND column_name = 'embedded_content_revision') AS embedded_default
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
       WHERE p.source_id = 'default' AND p.slug = 'fixture/pre-v133'
    `);
    expect(upgraded[0]).toEqual({
      embedding_null: false,
      content_revision: '1',
      embedded_content_revision: '1',
      embedded_default: null,
    });
    expect(await engine.countStaleChunks()).toBe(0);

    // Any writer changing chunk_text trips the DB trigger, even when it
    // incorrectly preserves the old vector and embedded_at.
    await engine.executeRaw(`
      UPDATE content_chunks
         SET chunk_text = 'Post-upgrade changed text'
       WHERE page_id = (SELECT id FROM pages
                         WHERE source_id = 'default' AND slug = 'fixture/pre-v133')
    `);
    expect(await engine.countStaleChunks()).toBe(1);

    const mismatch = await engine.executeRaw<{
      content_revision: string;
      embedded_content_revision: string | null;
    }>(`
      SELECT content_revision::text, embedded_content_revision::text
        FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.source_id = 'default' AND p.slug = 'fixture/pre-v133'
    `);
    expect(mismatch[0]).toEqual({ content_revision: '2', embedded_content_revision: '1' });

    // Ledger rewind exercises the full idempotent SQL a second time. ADD IF
    // NOT EXISTS must not restore a default or bless the mismatch as current.
    await engine.setConfig('version', '132');
    await runMigrations(engine);
    expect(await engine.countStaleChunks()).toBe(1);
    const afterRerun = await engine.executeRaw<{
      content_revision: string;
      embedded_content_revision: string | null;
    }>(`
      SELECT content_revision::text, embedded_content_revision::text
        FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.source_id = 'default' AND p.slug = 'fixture/pre-v133'
    `);
    expect(afterRerun[0]).toEqual({ content_revision: '2', embedded_content_revision: '1' });
  }, 30_000);
});
