/**
 * P0 regression contract for PGLite CJK retrieval.
 *
 * Product behavior:
 * - existing PGLite brains gain trigram indexes without changing Postgres;
 * - fresh PGLite brains start with the same indexes;
 * - CJK retrieval first builds per-field candidates, then keeps the existing
 *   ranking/dedup pipeline instead of scanning a four-column OR join.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from '../src/core/migrate.ts';

const root = join(import.meta.dir, '..');
const pgliteSchema = readFileSync(join(root, 'src/core/pglite-schema.ts'), 'utf8');
const pgliteEngine = readFileSync(join(root, 'src/core/pglite-engine.ts'), 'utf8');

const expectedIndexes = [
  'idx_chunks_text_trgm',
  'idx_pages_slug_trgm',
] as const;

describe('PGLite CJK trigram candidate retrieval', () => {
  test('migration 119 upgrades only PGLite with all missing trigram indexes', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 119);
    expect(migration?.name).toBe('pglite_cjk_trigram_candidate_indexes');
    expect(migration?.sqlFor?.postgres).toBe('');

    const sql = migration?.sqlFor?.pglite ?? '';
    for (const index of expectedIndexes) {
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
      expect(sql).toContain('gin_trgm_ops');
    }
  });

  test('fresh PGLite schema includes the same indexes', () => {
    for (const index of expectedIndexes) {
      expect(pgliteSchema).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    }
  });

  test('CJK SQL unions per-field candidates before applying the legacy score', () => {
    expect(pgliteEngine).toContain('chunk_text_candidates AS');
    expect(pgliteEngine).toContain('compiled_truth_candidates AS');
    expect(pgliteEngine).toContain('title_candidates AS');
    expect(pgliteEngine).toContain('slug_candidates AS');
    expect(pgliteEngine).toContain('candidate_chunks AS');
    expect(pgliteEngine).not.toContain(`cc.chunk_text ILIKE ANY($1::text[])
               OR p.compiled_truth ILIKE ANY($1::text[])
               OR p.title ILIKE ANY($1::text[])
               OR p.slug ILIKE ANY($1::text[])`);
  });
});
