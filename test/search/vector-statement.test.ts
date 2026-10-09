/**
 * #5824: the vector statement keeps the content-freshness test out of the
 * HNSW candidate CTE on indexed columns (the planner cannot estimate it and
 * drops the index), keeps it inside on non-indexed columns and under the
 * legacy guard, and always keeps it in the exact fallback and the `hasMore`
 * witness. Both engines emit the same statement apart from the PGLite
 * timeline `stale` column.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { buildVectorSearchStatement, INDEX_WALK_MIN_SCOPE_SHARE, sourceScopeShare, vectorScopeShareLoader, type PageSourceStats, type VectorSearchStatementInput } from '../../src/core/search/vector-statement.ts';
import { _resetVectorLegacyGuardForTests, readVectorLegacyGuard, resolveVectorLegacyGuard } from '../../src/core/search/vector-legacy-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const MD5 = 'md5(cc.chunk_text)';
const indexedColumn = { name: 'embedding', type: 'vector' as const, dimensions: 1536, embeddingModel: 'openai:text-embedding-3-large' };
const wideColumn = { name: 'embedding', type: 'vector' as const, dimensions: 3072, embeddingModel: 'openai:text-embedding-3-large' };

function build(overrides: Partial<VectorSearchStatementInput['opts']> = {}, dialect: 'postgres' | 'pglite' = 'postgres', scopeShare?: number) {
  return buildVectorSearchStatement({ dialect, embedding: new Float32Array([1, 0, 0]), limit: 10, offset: 0, opts: { embeddingColumn: indexedColumn, ...overrides }, scopeShare });
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

describe('vector index walk statement', () => {
  /** The `ann` CTE: the only part that touches the HNSW index. */
  function annCte(sql: string): string {
    return sql.slice(sql.indexOf('WITH ann AS MATERIALIZED ('), sql.indexOf('hnsw_candidates AS ('));
  }

  test('orders content_chunks alone and applies page filters and visibility after the key joins', () => {
    const stmt = build({ exclude_slugs: ['x'], sourceIds: ['a'], language: 'typescript', detail: 'low', excludePrivate: true });
    const walk = stmt.indexWalkSql!;
    const ann = annCte(walk);
    expect(ann).toContain('FROM content_chunks cc');
    expect(ann).not.toMatch(/JOIN|pages|sources|p\./);
    expect(ann).toContain(`AND cc.chunk_source = 'compiled_truth'`);
    expect(ann).toContain('AND cc.language = $3');
    expect(ann).toContain('AND (cc.model=$5 OR');
    expect(ann).not.toContain(MD5);
    expect(ann).toContain(`LIMIT $${stmt.innerLimitIdx + 1}::int * 2`);
    const candidates = walk.slice(walk.indexOf('hnsw_candidates AS ('), walk.indexOf('scored AS ('));
    expect(candidates).toContain('JOIN content_chunks cc ON cc.id = ann.id');
    expect(candidates).toContain('JOIN pages p ON p.id = cc.page_id');
    expect(candidates).toContain('AND p.slug != ALL($2::text[])');
    expect(candidates).toContain('AND p.source_id = ANY($4::text[])');
    expect(candidates).toContain(`COALESCE(p.frontmatter->>'visibility'`);
    expect(candidates).toContain('ORDER BY ann.distance, ann.id');
    expect(candidates).toContain(`LIMIT $${stmt.innerLimitIdx + 1}::int`);
    expect(scoredCte(walk)).toContain('WHERE $5::text IS NULL OR hash_current');
  });

  test('exists only for the relaxed variant without a type or date filter, and binds the same parameters', () => {
    expect(build({ vectorLegacyGuard: true }).indexWalkSql).toBeUndefined();
    expect(build({ embeddingColumn: wideColumn }).indexWalkSql).toBeUndefined();
    for (const narrowing of [{ type: 'note' }, { types: ['note'] }, { afterDate: '2026-01-01' }, { beforeDate: '2026-01-01' }]) {
      expect(build(narrowing).indexWalkSql).toBeUndefined();
    }
    const pg = build({ excludePrivate: true });
    const lite = build({ excludePrivate: true }, 'pglite');
    const placeholders = (sql: string) => [...new Set(sql.match(/\$\d+/g))].sort();
    expect(placeholders(pg.indexWalkSql!)).toEqual(placeholders(pg.sql));
    expect(lite.indexWalkSql!.replace(' p.updated_at,', '').replace(/CASE WHEN bpp\.updated_at < \([\s\S]*?\) THEN true ELSE false END AS stale/, 'false AS stale'))
      .toBe(pg.indexWalkSql!);
  });
});

describe('index walk skip for small source scopes', () => {
  const stats: PageSourceStats = { sources: ['notes', 'sessions', 'small'], freqs: [0.7, 0.25, 0.01], n_distinct: 5, null_frac: 0, reltuples: 1000 };

  test('a scope share below the threshold omits the walk and leaves every other statement byte-identical', () => {
    for (const dialect of ['postgres', 'pglite'] as const) {
      const unscoped = build({ sourceId: 'small', excludePrivate: true }, dialect);
      const sparse = build({ sourceId: 'small', excludePrivate: true }, dialect, INDEX_WALK_MIN_SCOPE_SHARE / 2);
      const wide = build({ sourceId: 'small', excludePrivate: true }, dialect, INDEX_WALK_MIN_SCOPE_SHARE);
      expect(sparse.indexWalkSql).toBeUndefined();
      expect(wide.indexWalkSql).toBe(unscoped.indexWalkSql!);
      for (const stmt of [sparse, wide]) {
        expect([stmt.sql, stmt.exactSql, stmt.hasMoreSql, stmt.params, stmt.innerLimit, stmt.innerLimitIdx])
          .toEqual([unscoped.sql, unscoped.exactSql, unscoped.hasMoreSql, unscoped.params, unscoped.innerLimit, unscoped.innerLimitIdx]);
      }
    }
  });

  test('scope share sums the planner frequencies of the scoped sources', () => {
    expect(sourceScopeShare(stats, { sourceId: 'sessions' })).toBe(0.25);
    expect(sourceScopeShare(stats, { sourceIds: ['notes', 'sessions', 'notes'] })).toBeCloseTo(0.95);
    expect(sourceScopeShare(stats, { sourceIds: ['small'], sourceId: 'notes' })).toBe(0.01);
    // Unlisted sources split what the MCV list leaves: (1 - 0.96) / (5 - 3).
    expect(sourceScopeShare(stats, { sourceId: 'missing' })).toBeCloseTo(0.02);
    // A negative n_distinct is a fraction of the row estimate.
    expect(sourceScopeShare({ ...stats, n_distinct: -0.005 }, { sourceId: 'missing' })).toBeCloseTo(0.04 / 2);
    expect(sourceScopeShare({ sources: null, freqs: null, n_distinct: 4, null_frac: 0, reltuples: 100 }, { sourceId: 'x' })).toBe(0.25);
  });

  test('no scope or no statistics leaves the walk on', () => {
    expect(sourceScopeShare(stats, {})).toBeUndefined();
    expect(sourceScopeShare(stats, { sourceIds: [] })).toBeUndefined();
    expect(sourceScopeShare(undefined, { sourceId: 'small' })).toBeUndefined();
    expect(build({ sourceId: 'small' }, 'postgres', undefined).indexWalkSql).toBeDefined();
  });

  test('the loader reads statistics only for scoped searches, once a minute, and treats a failed read as unknown', async () => {
    let reads = 0;
    const share = vectorScopeShareLoader(async () => { reads++; return [stats]; });
    expect(await share({})).toBeUndefined();
    expect(await share(undefined)).toBeUndefined();
    expect(reads).toBe(0);
    expect(await share({ sourceId: 'small' })).toBe(0.01);
    expect(await share({ sourceIds: ['notes'] })).toBe(0.7);
    expect(reads).toBe(1);
    const now = performance.now();
    const clock = spyOn(performance, 'now').mockReturnValue(now + 61_000);
    try {
      expect(await share({ sourceId: 'small' })).toBe(0.01);
      expect(reads).toBe(2);
    } finally {
      clock.mockRestore();
    }
    const failing = vectorScopeShareLoader(async () => { throw new Error('permission denied for pg_stats'); });
    expect(await failing({ sourceId: 'small' })).toBeUndefined();
    const empty = vectorScopeShareLoader(async () => []);
    expect(await empty({ sourceId: 'small' })).toBeUndefined();
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
