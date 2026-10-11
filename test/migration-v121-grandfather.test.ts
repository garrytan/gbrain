import { setTestSchemaVersion } from './helpers/schema-version.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let root: string;
let engine: PGLiteEngine;

describe('migration 121 legacy embedding compatibility', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pmbrain-v121-grandfather-'));
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(root, 'brain.pglite') });
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  test('only adds nullable structures and never registers a data backfill', () => {
    const migration = MIGRATIONS.find(item => item.version === 121);
    expect(migration?.handler).toBeUndefined();
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS embedding_signature TEXT');
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS embedded_text_hash TEXT');
    expect(migration?.sql).not.toMatch(/UPDATE\s+(content_chunks|pages)\b/i);
    expect(LATEST_VERSION).toBe(134);
  });

  test('PGLite keeps legacy vectors and NULL receipts untouched when upgrading from schema 120', async () => {
    const embeddingDimensions = Number(await engine.getConfig('embedding_dimensions'));
    await engine.putPage('legacy-vector', {
      type: 'note',
      title: 'Legacy vector',
      compiled_truth: 'legacy content',
    });
    await engine.upsertChunks('legacy-vector', [{
      chunk_index: 0,
      chunk_text: 'legacy content',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array(embeddingDimensions).fill(0.01),
      model: 'test:model',
      token_count: 2,
    }]);
    await engine.executeRaw(`UPDATE content_chunks SET embedded_text_hash = NULL`);
    await engine.executeRaw(`UPDATE pages SET embedding_signature = NULL WHERE slug = 'legacy-vector'`);
    await setTestSchemaVersion(engine, '120');

    await runMigrations(engine);

    const [row] = await engine.executeRaw<{
      embedding_kept: boolean;
      embedded_text_hash: string | null;
      embedding_signature: string | null;
    }>(`
      SELECT cc.embedding IS NOT NULL AS embedding_kept,
             cc.embedded_text_hash,
             p.embedding_signature
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = 'legacy-vector'
    `);
    expect(row).toEqual({
      embedding_kept: true,
      embedded_text_hash: null,
      embedding_signature: null,
    });
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
    expect(await engine.listStaleChunks({ sourceId: 'default', batchSize: 10 })).toEqual([]);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  }, 120_000);
});
