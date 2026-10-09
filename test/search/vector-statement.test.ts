/**
 * #5824: the vector statement keeps the content-freshness test out of the
 * HNSW candidate CTE on indexed columns (the planner cannot estimate it and
 * drops the index), keeps it inside on non-indexed columns and under the
 * legacy guard, and always keeps it in the exact fallback and the `hasMore`
 * witness. Both engines emit the same statement apart from the PGLite
 * timeline `stale` column.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { buildVectorSearchStatement, INDEX_WALK_MIN_SCOPE_SHARE, indexWalkOverfetch, SCOPE_SCAN_FIRST_MAX_CHUNKS, SCOPE_SCAN_MAX_CHUNKS, SCOPE_SCAN_MAX_SHARE, sourceScope, sourceScopeShare, vectorScopeLoader, type PageSourceStats, type VectorSearchStatementInput } from '../../src/core/search/vector-statement.ts';
import { _resetVectorLegacyGuardForTests, readVectorLegacyGuard, resolveVectorLegacyGuard } from '../../src/core/search/vector-legacy-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const MD5 = 'md5(cc.chunk_text)';
const indexedColumn = { name: 'embedding', type: 'vector' as const, dimensions: 1536, embeddingModel: 'openai:text-embedding-3-large' };
const wideColumn = { name: 'embedding', type: 'vector' as const, dimensions: 3072, embeddingModel: 'openai:text-embedding-3-large' };

function build(overrides: Partial<VectorSearchStatementInput['opts']> = {}, dialect: 'postgres' | 'pglite' = 'postgres', scopeShare?: number, scopeChunks?: number) {
  return buildVectorSearchStatement({ dialect, embedding: new Float32Array([1, 0, 0]), limit: 10, offset: 0, opts: { embeddingColumn: indexedColumn, ...overrides }, scope: scopeShare === undefined ? undefined : { share: scopeShare, chunks: scopeChunks } });
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

describe('source scope strategy: walk overfetch, walk skip and scope scan', () => {
  const stats: PageSourceStats = { sources: ['notes', 'sessions', 'small'], freqs: [0.7, 0.25, 0.01], n_distinct: 5, null_frac: 0, reltuples: 1000, chunk_reltuples: 200_000 };
  const unchanged = (stmt: ReturnType<typeof build>, base: ReturnType<typeof build>) =>
    expect([stmt.sql, stmt.exactSql, stmt.hasMoreSql, stmt.params, stmt.innerLimit, stmt.innerLimitIdx])
      .toEqual([base.sql, base.exactSql, base.hasMoreSql, base.params, base.innerLimit, base.innerLimitIdx]);

  test('the walk over-fetches about INDEX_WALK_OVERFETCH in-scope rows per window slot', () => {
    expect(indexWalkOverfetch(undefined)).toBe(2);
    expect(indexWalkOverfetch(1)).toBe(2);
    expect(indexWalkOverfetch(0.5)).toBe(4);
    expect(indexWalkOverfetch(0.16)).toBe(13);
    expect(indexWalkOverfetch(INDEX_WALK_MIN_SCOPE_SHARE)).toBe(50);
    expect(indexWalkOverfetch(INDEX_WALK_MIN_SCOPE_SHARE / 10)).toBe(50);
  });

  test('an unscoped or whole-brain scope keeps the walk byte-identical; a partial share only changes its LIMIT factor', () => {
    for (const dialect of ['postgres', 'pglite'] as const) {
      const unscoped = build({ sourceId: 'notes', excludePrivate: true }, dialect);
      const whole = build({ sourceId: 'notes', excludePrivate: true }, dialect, 1, 1_000_000);
      const half = build({ sourceId: 'notes', excludePrivate: true }, dialect, 0.5, 1_000_000);
      expect(unscoped.indexWalkOverfetch).toBe(2);
      expect(whole.indexWalkSql).toBe(unscoped.indexWalkSql!);
      expect(half.indexWalkOverfetch).toBe(4);
      expect(half.indexWalkSql).toBe(unscoped.indexWalkSql!.replace(`::int * 2\n`, `::int * 4\n`));
      for (const stmt of [whole, half]) {
        unchanged(stmt, unscoped);
        expect(stmt.scopeScanSql).toBeUndefined();
      }
    }
  });

  test('a scope share below the walk threshold omits the walk; without chunk statistics it keeps only the joined statement', () => {
    for (const dialect of ['postgres', 'pglite'] as const) {
      const unscoped = build({ sourceId: 'small', excludePrivate: true }, dialect);
      const sparse = build({ sourceId: 'small', excludePrivate: true }, dialect, INDEX_WALK_MIN_SCOPE_SHARE / 2);
      expect(sparse.indexWalkSql).toBeUndefined();
      expect(sparse.scopeScanSql).toBeUndefined();
      unchanged(sparse, unscoped);
    }
  });

  test('a scope of at most SCOPE_SCAN_FIRST_MAX_CHUNKS runs the scope scan instead of the walk', () => {
    const small = build({ sourceId: 'small' }, 'postgres', 0.2, SCOPE_SCAN_FIRST_MAX_CHUNKS);
    expect(small.scopeScanSql).toBeDefined();
    expect(small.indexWalkSql).toBeUndefined();
    const narrowed = build({ sourceId: 'small', type: 'note' }, 'postgres', 0.01, 500);
    expect(narrowed.scopeScanSql).toBeDefined();
    unchanged(small, build({ sourceId: 'small' }));
  });

  test('a mid-size scope runs the walk first and keeps the scope scan as its fallback; larger, wider or unindexed scopes get no scan', () => {
    const mid = build({ sourceId: 'sessions' }, 'postgres', 0.25, SCOPE_SCAN_MAX_CHUNKS);
    expect(mid.indexWalkSql).toBeDefined();
    expect(mid.scopeScanSql).toBeDefined();
    expect(build({ sourceId: 'sessions' }, 'postgres', 0.25, SCOPE_SCAN_MAX_CHUNKS + 1).scopeScanSql).toBeUndefined();
    expect(build({ sourceId: 'notes' }, 'postgres', SCOPE_SCAN_MAX_SHARE, 1_000).scopeScanSql).toBeUndefined();
    expect(build({ sourceId: 'small' }, 'postgres', 0.01).scopeScanSql).toBeUndefined();
    expect(build({ sourceId: 'small', vectorLegacyGuard: true }, 'postgres', 0.01, 500).scopeScanSql).toBeUndefined();
    expect(build({ sourceId: 'small', embeddingColumn: wideColumn }, 'postgres', 0.01, 500).scopeScanSql).toBeUndefined();
  });

  test('the scope scan orders only chunk ids over the eligible pages, with the index kept out, then joins the window back', () => {
    const stmt = build({ sourceIds: ['a'], exclude_slugs: ['x'], language: 'typescript', detail: 'low', excludePrivate: true, type: 'note' }, 'postgres', 0.01, 500);
    const scan = stmt.scopeScanSql!;
    const cte = scan.slice(scan.indexOf('WITH scope_scan AS MATERIALIZED ('), scan.indexOf('hnsw_candidates AS ('));
    const pagesSubquery = cte.slice(cte.indexOf('ANY(ARRAY('), cte.indexOf('))'));
    expect(cte).toContain('SELECT cc.id\n        FROM content_chunks cc\n        WHERE cc.page_id = ANY(ARRAY(');
    for (const filter of ['AND p.type = $2', 'AND p.slug != ALL($3::text[])', 'AND p.source_id = ANY($5::text[])', `COALESCE(p.frontmatter->>'visibility'`, "AND NOT (p.slug LIKE 'test/%'"]) {
      expect(pagesSubquery).toContain(filter);
    }
    expect(pagesSubquery).not.toContain('cc.');
    expect(cte).toContain(`AND cc.chunk_source = 'compiled_truth'`);
    expect(cte).toContain('AND cc.language = $4');
    expect(cte).toContain('AND (cc.model=$6 OR');
    expect(cte).not.toContain(MD5);
    expect(cte).toContain('ORDER BY (cc."embedding" <=> $1::vector) + 0, cc.id');
    expect(cte).toContain(`LIMIT $${stmt.innerLimitIdx + 1}\n`);
    expect(scan).toContain('JOIN content_chunks cc ON cc.id = scope_scan.id');
    expect(scoredCte(scan)).toContain('WHERE $6::text IS NULL OR hash_current');
    const placeholders = (sql: string) => [...new Set(sql.match(/\$\d+/g))].sort();
    expect(placeholders(scan)).toEqual(placeholders(stmt.sql));
    const lite = build({ sourceIds: ['a'], excludePrivate: true }, 'pglite', 0.01, 500).scopeScanSql!;
    expect(lite.replace(' p.updated_at,', '').replace(/CASE WHEN bpp\.updated_at < \([\s\S]*?\) THEN true ELSE false END AS stale/, 'false AS stale'))
      .toBe(build({ sourceIds: ['a'], excludePrivate: true }, 'postgres', 0.01, 500).scopeScanSql!);
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

  test('scope chunks are the share of content_chunks reltuples, absent when chunks were never analyzed', () => {
    expect(sourceScope(stats, { sourceId: 'sessions' })).toEqual({ share: 0.25, chunks: 50_000 });
    expect(sourceScope({ ...stats, chunk_reltuples: -1 }, { sourceId: 'sessions' })).toEqual({ share: 0.25 });
    expect(sourceScope({ ...stats, chunk_reltuples: undefined }, { sourceId: 'sessions' })).toEqual({ share: 0.25 });
    expect(sourceScope(stats, {})).toBeUndefined();
  });

  test('a sampled chunk count replaces the share estimate; an empty sample falls back to it', () => {
    expect(sourceScope(stats, { sourceId: 'sessions' }, { pages: 250, sampled: 125, sample_chunks: 1_200 })).toEqual({ share: 0.25, chunks: 2_400 });
    expect(sourceScope(stats, { sourceId: 'sessions' }, { pages: 7_900, sampled: 416, sample_chunks: 3_922 })).toEqual({ share: 0.25, chunks: 74_480 });
    expect(sourceScope(stats, { sourceId: 'sessions' }, { pages: 0, sampled: 0, sample_chunks: 0 })).toEqual({ share: 0.25, chunks: 50_000 });
    expect(sourceScope({ ...stats, chunk_reltuples: -1 }, { sourceId: 'sessions' }, { pages: 0, sampled: 0, sample_chunks: 0 })).toEqual({ share: 0.25 });
  });

  test('a scope of long pages routes on its counted chunks: walk first with the scan as fallback instead of scan first', () => {
    const estimated = sourceScope(stats, { sourceId: 'sessions' })!;
    const counted = sourceScope(stats, { sourceId: 'sessions' }, { pages: 250, sampled: 250, sample_chunks: 100_000 })!;
    expect(estimated.chunks!).toBeLessThanOrEqual(SCOPE_SCAN_FIRST_MAX_CHUNKS * 2);
    expect(counted.chunks!).toBeGreaterThan(SCOPE_SCAN_FIRST_MAX_CHUNKS);
    expect(counted.chunks!).toBeLessThanOrEqual(SCOPE_SCAN_MAX_CHUNKS);
    const scanFirst = buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array([1, 0, 0]), limit: 10, offset: 0, opts: { embeddingColumn: indexedColumn, sourceId: 'sessions' }, scope: { share: 0.25, chunks: SCOPE_SCAN_FIRST_MAX_CHUNKS } });
    const walkFirst = buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array([1, 0, 0]), limit: 10, offset: 0, opts: { embeddingColumn: indexedColumn, sourceId: 'sessions' }, scope: counted });
    expect([!!scanFirst.indexWalkSql, !!scanFirst.scopeScanSql]).toEqual([false, true]);
    expect([!!walkFirst.indexWalkSql, !!walkFirst.scopeScanSql]).toEqual([true, true]);
    expect(walkFirst.scopeScanSql).toBe(scanFirst.scopeScanSql!);
  });

  test('the loader counts chunks only for scopes under SCOPE_SCAN_MAX_SHARE, in the background, once a minute per scope, and keeps the estimate on a failed count', async () => {
    const asked: string[][] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const scope = vectorScopeLoader(async () => [stats], async ids => { asked.push(ids); await gate; return [{ pages: 250, sampled: 250, sample_chunks: 90_000 }]; });
    expect(await scope({ sourceIds: ['notes'] })).toEqual({ share: 0.7, chunks: 140_000 });
    expect(asked).toEqual([]);
    // The first search routes on the share estimate while the count runs.
    expect(await scope({ sourceId: 'sessions' })).toEqual({ share: 0.25, chunks: 50_000 });
    expect(await scope({ sourceIds: ['sessions', 'sessions'] })).toEqual({ share: 0.25, chunks: 50_000 });
    expect(asked).toEqual([['sessions']]);
    release();
    await Bun.sleep(0);
    expect(await scope({ sourceId: 'sessions' })).toEqual({ share: 0.25, chunks: 90_000 });
    await scope({ sourceIds: ['small', 'sessions'] });
    await Bun.sleep(0);
    expect((await scope({ sourceIds: ['sessions', 'small'] }))?.chunks).toBe(90_000);
    expect(asked).toEqual([['sessions'], ['small', 'sessions']]);
    const now = performance.now();
    const clock = spyOn(performance, 'now').mockReturnValue(now + 61_000);
    try {
      // A refresh keeps routing on the last count until it lands.
      expect((await scope({ sourceId: 'sessions' }))?.chunks).toBe(90_000);
      expect(asked).toHaveLength(3);
    } finally {
      clock.mockRestore();
    }
    const failing = vectorScopeLoader(async () => [stats], async () => { throw new Error('canceling statement due to statement timeout'); });
    await failing({ sourceId: 'sessions' });
    await Bun.sleep(0);
    expect(await failing({ sourceId: 'sessions' })).toEqual({ share: 0.25, chunks: 50_000 });
  });

  test('no scope or no statistics leaves the walk on', () => {
    expect(sourceScopeShare(stats, {})).toBeUndefined();
    expect(sourceScopeShare(stats, { sourceIds: [] })).toBeUndefined();
    expect(sourceScopeShare(undefined, { sourceId: 'small' })).toBeUndefined();
    expect(build({ sourceId: 'small' }, 'postgres', undefined).indexWalkSql).toBeDefined();
  });

  test('the loader reads statistics only for scoped searches, once a minute, and treats a failed read as unknown', async () => {
    let reads = 0;
    const scope = vectorScopeLoader(async () => { reads++; return [stats]; });
    expect(await scope({})).toBeUndefined();
    expect(await scope(undefined)).toBeUndefined();
    expect(reads).toBe(0);
    expect(await scope({ sourceId: 'small' })).toEqual({ share: 0.01, chunks: 2_000 });
    expect((await scope({ sourceIds: ['notes'] }))?.share).toBe(0.7);
    expect(reads).toBe(1);
    const now = performance.now();
    const clock = spyOn(performance, 'now').mockReturnValue(now + 61_000);
    try {
      expect((await scope({ sourceId: 'small' }))?.share).toBe(0.01);
      expect(reads).toBe(2);
    } finally {
      clock.mockRestore();
    }
    const failing = vectorScopeLoader(async () => { throw new Error('permission denied for pg_stats'); });
    expect(await failing({ sourceId: 'small' })).toBeUndefined();
    const empty = vectorScopeLoader(async () => []);
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
