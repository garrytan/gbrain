/**
 * #5824: the vector statement keeps the content-freshness test out of the
 * HNSW candidate CTE on indexed columns (the planner cannot estimate it and
 * drops the index), keeps it inside on non-indexed columns and under the
 * legacy guard, and always keeps it in the exact fallback and the `hasMore`
 * witness. Both engines emit the same statement apart from the PGLite
 * timeline `stale` column.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { buildVectorSearchStatement, type VectorSearchStatementInput } from '../../src/core/search/vector-statement.ts';
import { _resetVectorLegacyGuardForTests, readVectorLegacyGuard, resolveVectorLegacyGuard } from '../../src/core/search/vector-legacy-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const MD5 = 'md5(cc.chunk_text)';
const indexedColumn = { name: 'embedding', type: 'vector' as const, dimensions: 1536, embeddingModel: 'openai:text-embedding-3-large' };
const wideColumn = { name: 'embedding', type: 'vector' as const, dimensions: 3072, embeddingModel: 'openai:text-embedding-3-large' };

function build(overrides: Partial<VectorSearchStatementInput['opts']> = {}, dialect: 'postgres' | 'pglite' = 'postgres') {
  return buildVectorSearchStatement({ dialect, embedding: new Float32Array([1, 0, 0]), limit: 10, offset: 0, opts: { embeddingColumn: indexedColumn, ...overrides } });
}

/** The WHERE of the `hnsw_candidates` CTE, between its FROM and its ORDER BY. */
function candidateWhere(sql: string): string {
  const cte = sql.slice(sql.indexOf('WITH hnsw_candidates AS ('), sql.indexOf('scored AS ('));
  return cte.slice(cte.indexOf('FROM content_chunks cc'), cte.indexOf('ORDER BY'));
}

function scoredCte(sql: string): string {
  return sql.slice(sql.indexOf('scored AS ('), sql.indexOf('best_per_page AS ('));
}

describe('vector statement freshness placement (#5824)', () => {
  test('an indexed embedding column keeps only the model check in the candidate CTE', () => {
    const stmt = build();
    expect(stmt.indexed).toBe(true);
    expect(stmt.relaxed).toBe(true);
    const where = candidateWhere(stmt.sql);
    expect(where).not.toContain(MD5);
    expect(where).toContain('AND (cc.model=$2 OR ($2::text IS NULL AND NOT EXISTS(SELECT 1 FROM config WHERE key=\'embedding_migration.state\')))');
    expect(stmt.sql).toContain(`(cc.embedded_text_hash=${MD5} OR cc.embedded_text_hash IS NULL) AS hash_current`);
    expect(scoredCte(stmt.sql)).toContain('WHERE $2::text IS NULL OR hash_current');
    expect(stmt.sql).toContain('(count(*) FILTER (WHERE $2::text IS NULL OR hash_current))::int AS eligible_pool');
  });

  test('the exact fallback and the hasMore witness keep the full guard', () => {
    const stmt = build();
    expect(candidateWhere(stmt.exactSql)).toContain(`AND ((cc.model=$2 AND (cc.embedded_text_hash=${MD5} OR cc.embedded_text_hash IS NULL))`);
    expect(stmt.exactSql).toContain(') + 0');
    expect(stmt.exactSql).not.toContain('hash_current');
    expect(stmt.hasMoreSql).toContain(`AND ((cc.model=$2 AND (cc.embedded_text_hash=${MD5} OR cc.embedded_text_hash IS NULL))`);
    expect(stmt.hasMoreSql).toContain(`LIMIT $${stmt.innerLimitIdx + 1}`);
  });

  test('a column wider than the HNSW cap keeps the guard inside the candidate CTE', () => {
    const stmt = build({ embeddingColumn: wideColumn });
    expect(stmt.indexed).toBe(false);
    expect(stmt.relaxed).toBe(false);
    expect(candidateWhere(stmt.sql)).toContain(`AND ((cc.model=$2 AND (cc.embedded_text_hash=${MD5} OR cc.embedded_text_hash IS NULL))`);
    expect(stmt.sql).not.toContain('hash_current');
    expect(stmt.sql).toContain('count(*)::int AS candidate_pool, count(*)::int AS eligible_pool');
  });

  test('the legacy guard emits the guarded variant on an indexed column', () => {
    const guarded = build({ vectorLegacyGuard: true });
    expect(guarded.indexed).toBe(true);
    expect(guarded.relaxed).toBe(false);
    expect(candidateWhere(guarded.sql)).toContain(MD5);
    expect(guarded.sql).toBe(build({ embeddingColumn: wideColumn }).sql);
  });

  test('non-text columns carry no generation guard to relax', () => {
    const stmt = build({ embeddingColumn: { name: 'embedding_image', type: 'vector', dimensions: 1024, embeddingModel: 'voyage:voyage-multimodal-3' } });
    expect(stmt.relaxed).toBe(false);
    expect(stmt.sql).not.toContain(MD5);
    expect(stmt.sql).toContain(`AND cc.modality = 'image'`);
  });

  test('Postgres and PGLite emit the same statement apart from the timeline stale column', () => {
    const opts = { type: 'note', sourceIds: ['a', 'b'], afterDate: '2026-01-01', language: 'typescript', excludePrivate: true };
    for (const vectorLegacyGuard of [false, true]) {
      const pg = build({ ...opts, vectorLegacyGuard });
      const lite = build({ ...opts, vectorLegacyGuard }, 'pglite');
      expect(lite.params).toEqual(pg.params);
      expect(lite.innerLimitIdx).toBe(pg.innerLimitIdx);
      expect(lite.hasMoreSql).toBe(pg.hasMoreSql);
      const strip = (sql: string) => sql.replace(' p.updated_at,', '').replace(/CASE WHEN bpp\.updated_at < \([\s\S]*?\) THEN true ELSE false END AS stale/, 'false AS stale');
      expect(strip(lite.sql)).toBe(pg.sql);
    }
  });

  test('parameters bind the vector, filters, model and the three limits in order', () => {
    const stmt = build({ type: 'note', sourceId: 'default', limit: 10 });
    expect(stmt.params).toEqual(['[1,0,0]', 'note', 'default', 'openai:text-embedding-3-large', 100, 10, 0]);
    expect(stmt.innerLimitIdx).toBe(4);
    expect(stmt.innerLimit).toBe(100);
  });
});

describe('vector legacy guard setting', () => {
  afterEach(() => _resetVectorLegacyGuardForTests());

  test('env wins over config, and config enables it when env is unset', async () => {
    await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: undefined }, async () => {
      expect(readVectorLegacyGuard(null)).toEqual({ enabled: false, via: null });
      expect(readVectorLegacyGuard({ search: { vector_legacy_guard: true } })).toEqual({ enabled: true, via: 'config' });
    });
    await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: '1' }, async () => {
      expect(readVectorLegacyGuard(null)).toEqual({ enabled: true, via: 'env' });
    });
    await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: '0' }, async () => {
      expect(readVectorLegacyGuard({ search: { vector_legacy_guard: true } })).toEqual({ enabled: false, via: 'env' });
    });
  });

  test('resolves once per process and logs activation once to stderr', async () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: 'true' }, async () => {
        expect(resolveVectorLegacyGuard(null)).toBe(true);
        expect(resolveVectorLegacyGuard(null)).toBe(true);
      });
      await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: undefined }, async () => {
        expect(resolveVectorLegacyGuard(null)).toBe(true);
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0][0])).toStartWith('[gbrain] vector legacy guard active');
    } finally {
      stderr.mockRestore();
    }
  });
});
