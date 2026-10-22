/**
 * The vector index walk (`indexWalkSql`) returns exactly what the joined
 * candidate statement returns whenever its window is full, and searchVector
 * falls back to the joined statement when page filters leave the walk short.
 *
 * Fixture (PGLite, 8-dim): three sources (one archived), five page types,
 * pages that the private-page rule hides (explicit `visibility: private`,
 * atoms, synthesized concepts, `derived_from` a private page), quarantined
 * and soft-deleted pages, stale chunk hashes, and three chunks per page, plus
 * a `tiny` source with 2% of pages, which skips the walk. Every statement
 * runs with index scans disabled, so each computes its window exactly and
 * the comparison is row-for-row, order included. The scope scan
 * (`scopeScanSql`) is held to the same row-for-row bar. The Postgres
 * plan proof is test/e2e/vector-plan-real-column-postgres.test.ts.
 *
 * The joined statement behind the walk runs with JOINED_STATEMENT_SETTINGS
 * (materialization off). Its result set is judged under exact evaluation,
 * like every statement here: ruling out the materialized page join can move
 * the planner from the HNSW scan to an exact scope-first scan on a small
 * scope or brain (this fixture is one), which returns the exact window rather
 * than the HNSW approximation. That is accepted; on large brains the same
 * HNSW scan stays and only the page join changes.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import * as vectorPool from '../../src/core/search/vector-pool.ts';
import * as vectorSettings from '../../src/core/search/vector-settings.ts';
import { buildVectorSearchStatement, INDEX_WALK_MIN_SCOPE_SHARE, INDEX_WALK_SETTINGS, PAGE_SOURCE_STATS_SQL, sourceScope, sourceScopeShare, type PageSourceStats } from '../../src/core/search/vector-statement.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { column, planNodes, seedVectorWalkFixture, vec, type PlanNode } from '../helpers/vector-index-walk-fixture.ts';

let engine: PGLiteEngine;

/** Rows a statement returns with its window computed exactly (no index scans). */
async function exactRows(sql: string, params: unknown[]) {
  await engine.executeRaw('SET enable_indexscan = off');
  try {
    return await engine.executeRaw<Record<string, unknown>>(sql, params);
  } finally {
    await engine.executeRaw('RESET enable_indexscan');
  }
}

const shape = (rows: Record<string, unknown>[]) => rows.filter(row => row.page_id != null)
  .map(row => [row.slug, row.source_id, row.chunk_id, Number(row.score).toFixed(9)]);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedVectorWalkFixture(engine);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('vector index walk (PGLite)', () => {
  const matrix: Array<[string, SearchOpts]> = [
    ['default scope', {}],
    ['remote reader (private-page rule)', { excludePrivate: true }],
    ['remote reader, limit 50', { excludePrivate: true, limit: 50 }],
    ['granted sources', { excludePrivate: true, sourceIds: ['default', 'side'] }],
    ['slug exclusion', { exclude_slugs: ['notes/n-5', 'notes/n-6'] }],
    ['compiled truth only', { detail: 'low', excludePrivate: true }],
  ];

  for (const [label, opts] of matrix) {
    test(`${label}: a full walk window returns the joined statement's rows in the same order`, async () => {
      for (const seed of [11, 202, 3003]) {
        const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(seed), limit: opts.limit ?? 20, offset: 0, opts: { embeddingColumn: column, ...opts } });
        expect(stmt.indexWalkSql).toBeDefined();
        const params = [...stmt.params];
        const walked = await exactRows(stmt.indexWalkSql!, params);
        const joined = await exactRows(stmt.sql, params);
        expect(Number(walked[0].candidate_pool)).toBe(stmt.innerLimit);
        expect(shape(walked).length).toBe(opts.limit ?? 20);
        expect(shape(walked)).toEqual(shape(joined));
        expect([walked[0].candidate_pool, walked[0].eligible_pool]).toEqual([joined[0].candidate_pool, joined[0].eligible_pool]);
      }
    });
  }

  test('the walk probes chunks and pages by key per ANN row: no scope-wide join is materialized under the ANN loop (#6728)', async () => {
    // A narrow page scope with a large overfetch is what drew the planner to
    // materialize the scope's chunk-page join and rescan it once per ANN row
    // (on a real brain the materialized join spilled past work_mem: ~1 GB of
    // temp reads per search).
    for (const sourceIds of [['side'], ['tiny', 'side']]) {
      const opts: SearchOpts = { embeddingColumn: column, excludePrivate: true, sourceIds };
      const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(11), limit: 20, offset: 0, opts, scope: { share: 0.05 } });
      expect(stmt.indexWalkSql).toBeDefined();
      for (const [key, value] of Object.entries(INDEX_WALK_SETTINGS)) await engine.executeRaw(`SET ${key} = ${value}`);
      let plan: PlanNode;
      try {
        const [row] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${stmt.indexWalkSql!}`, [...stmt.params]);
        plan = row['QUERY PLAN'][0].Plan;
      } finally {
        for (const key of Object.keys(INDEX_WALK_SETTINGS)) await engine.executeRaw(`RESET ${key}`);
      }
      const nodes = planNodes(plan);
      expect(nodes.filter(node => node['Node Type'] === 'Materialize')).toEqual([]);
      expect(nodes.filter(node => node['Join Filter']?.includes('ann.id'))).toEqual([]);
      const annRows = nodes.find(node => node['Index Name'] === 'idx_chunks_embedding')!;
      expect(annRows).toBeDefined();
      for (const index of ['content_chunks_pkey', 'pages_pkey']) {
        const probe = nodes.find(node => node['Index Name'] === index && node['Actual Loops']! > 1);
        expect(probe).toBeDefined();
      }
      expect(nodes.some(node => node['Index Name'] === 'idx_chunks_page')).toBe(false);
    }
  });

  /** The scan settings searchVector applies to its first pool attempt, the joined statement's. */
  async function poolAttemptSettings(opts: SearchOpts): Promise<Record<string, string>> {
    const applied: Array<Record<string, string>> = [];
    const walk = spyOn(vectorPool, 'searchIndexWalk').mockResolvedValue(null);
    const settings = spyOn(vectorSettings, 'withVectorSettings').mockImplementation(async (_query, iterative, limit, maxScanTuples, run, deadline, mode, walkOverfetch, joined) => {
      applied.push(vectorSettings.vectorScanSettings(iterative, limit, maxScanTuples, deadline, mode, walkOverfetch, joined));
      return run();
    });
    try {
      await engine.searchVector(vec(5), opts);
    } finally {
      walk.mockRestore();
      settings.mockRestore();
    }
    return applied[0]!;
  }

  /** Plan and rows of `sql` under `settings`. */
  async function planAndRows(sql: string, params: unknown[], settings: Record<string, string>) {
    for (const [name, value] of Object.entries(settings)) await engine.executeRaw('SELECT set_config($1, $2, false)', [name, value]);
    try {
      const [row] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
      return { nodes: planNodes(row['QUERY PLAN'][0].Plan), rows: await engine.executeRaw<Record<string, unknown>>(sql, params) };
    } finally {
      for (const name of Object.keys(settings)) await engine.executeRaw(`RESET ${name}`);
    }
  }

  const materializedPages = (nodes: PlanNode[]) => nodes.filter(node => node['Node Type'] === 'Materialize' && planNodes(node).some(inner => inner['Relation Name'] === 'pages')).map(node => node['Node Type']);

  test('the joined statement never materializes the filtered pages and rescans them per HNSW candidate, and returns the same rows', async () => {
    // The private-page rule's subplans drew the planner to filter every page
    // once and rescan the materialized survivors for each candidate chunk
    // (2.2 s per attempt on a 51k-page brain, where the pool attempt now
    // probes pages_pkey per HNSW candidate). The rows stay the same.
    for (const opts of [{ excludePrivate: true }, { excludePrivate: true, sourceIds: ['default', 'side'] }] as SearchOpts[]) {
      for (const seed of [11, 202]) {
        const searchOpts: SearchOpts = { limit: 20, embeddingColumn: column, ...opts };
        const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(seed), limit: 20, offset: 0, opts: searchOpts });
        const params = [...stmt.params];
        const settings = await poolAttemptSettings(searchOpts);
        const { nodes, rows } = await planAndRows(stmt.sql, params, settings);
        expect(materializedPages(nodes)).toEqual([]);
        expect(nodes.flatMap(node => node['Join Filter']?.includes('page_id') ? [node['Join Filter']] : [])).toEqual([]);
        const materialized = await planAndRows(stmt.sql, params, { ...settings, enable_material: 'on' });
        expect(materializedPages(materialized.nodes)).not.toEqual([]);
        expect(shape(rows)).toHaveLength(20);
        // Judged under exact evaluation (header): the materialized plan walks HNSW, whose
        // approximate window depends on the randomly levelled graph, so it is not the reference.
        expect(shape(rows)).toEqual(shape(await exactRows(stmt.sql, params)));
      }
    }
  });

  test('the walk keeps every page filter: no hidden, deleted, archived or out-of-scope page reaches results', async () => {
    const hits = await engine.searchVector(vec(42), { limit: 50, embeddingColumn: column, excludePrivate: true, sourceIds: ['default', 'side'] });
    expect(hits).toHaveLength(50);
    for (const hit of hits) {
      const n = Number(hit.slug.split('-').at(-1));
      expect([0, 1, 2, 3]).not.toContain(n % 20);
      expect(n % 37 === 0 || n % 31 === 0 || hit.source_id === 'gone').toBe(false);
    }
  });

  async function statementsSearched(opts: SearchOpts) {
    const seen: Array<string | undefined> = [];
    const original = vectorPool.searchIndexWalk;
    const spy = spyOn(vectorPool, 'searchIndexWalk').mockImplementation((stmt, limit, run) => {
      seen.push(stmt.indexWalkSql);
      return original(stmt, limit, run);
    });
    await engine.executeRaw('SET enable_indexscan = off');
    try {
      return { hits: await engine.searchVector(vec(7), opts), seen };
    } finally {
      await engine.executeRaw('RESET enable_indexscan');
      spy.mockRestore();
    }
  }

  test('a source scope below the share threshold skips the walk and returns the joined statement result', async () => {
    const opts: SearchOpts = { limit: 10, embeddingColumn: column, sourceId: 'tiny', excludePrivate: true };
    const [stats] = await engine.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL);
    const share = sourceScopeShare(stats, opts)!;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(INDEX_WALK_MIN_SCOPE_SHARE);
    const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(7), limit: 10, offset: 0, opts, scope: { share } });
    expect(stmt.indexWalkSql).toBeUndefined();
    const unscoped = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(7), limit: 10, offset: 0, opts });
    expect(stmt.sql).toBe(unscoped.sql);
    const joined = await exactRows(stmt.sql, [...stmt.params]);
    const { hits, seen } = await statementsSearched(opts);
    expect(seen).toEqual([undefined]);
    expect(hits).toHaveLength(10);
    expect(hits.map(hit => hit.slug)).toEqual(shape(joined).map(row => String(row[0])));
  });

  test('a source scope at or above the share threshold still runs the walk', async () => {
    const opts: SearchOpts = { limit: 20, embeddingColumn: column, sourceIds: ['default', 'side'], excludePrivate: true };
    const [stats] = await engine.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL);
    expect(sourceScopeShare(stats, opts)!).toBeGreaterThanOrEqual(INDEX_WALK_MIN_SCOPE_SHARE);
    const scope = sourceScope(stats, opts)!;
    const { hits, seen } = await statementsSearched(opts);
    expect(seen).toEqual([buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(7), limit: 20, offset: 0, opts, scope }).indexWalkSql!]);
    expect(hits).toHaveLength(20);
  });

  const scanMatrix: Array<[string, SearchOpts]> = [
    ['small source', { sourceId: 'side' }],
    ['small source, remote reader', { sourceId: 'side', excludePrivate: true }],
    ['small source, limit 50 and offset', { sourceId: 'side', excludePrivate: true, limit: 50, offset: 5 }],
    ['small source, type filter', { sourceId: 'side', type: 'note' }],
    ['small source, compiled truth only', { sourceIds: ['side', 'tiny'], detail: 'low', excludePrivate: true }],
    ['archived source', { sourceId: 'gone' }],
    ['scope smaller than the limit', { sourceId: 'tiny', excludePrivate: true }],
  ];
  for (const [label, opts] of scanMatrix) {
    test(`${label}: the scope scan returns the joined statement's rows in the same order`, async () => {
      for (const seed of [11, 202, 3003]) {
        const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(seed), limit: opts.limit ?? 20, offset: opts.offset ?? 0, opts: { embeddingColumn: column, ...opts }, scope: { share: 0.2, chunks: 500 } });
        expect(stmt.scopeScanSql).toBeDefined();
        const params = [...stmt.params];
        expect(shape(await exactRows(stmt.scopeScanSql!, params))).toEqual(shape(await exactRows(stmt.sql, params)));
      }
    });
  }

  test('searchVector runs the scope scan for a source with few chunks and returns the joined statement result', async () => {
    const opts: SearchOpts = { limit: 10, embeddingColumn: column, sourceId: 'side', excludePrivate: true };
    const [stats] = await engine.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL);
    const scope = sourceScope(stats, opts)!;
    const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(7), limit: 10, offset: 0, opts, scope });
    expect(stmt.scopeScanSql).toBeDefined();
    expect(stmt.indexWalkSql).toBeUndefined();
    const kinds: string[] = [];
    const original = vectorPool.searchIndexWalk;
    const spy = spyOn(vectorPool, 'searchIndexWalk').mockImplementation((s, limit, run) => original(s, limit, attempt => {
      kinds.push(attempt.scopeScan ? 'scan' : 'walk');
      return run(attempt);
    }));
    try {
      const hits = await engine.searchVector(vec(7), opts);
      expect(kinds).toEqual(['scan']);
      expect(hits.map(hit => hit.slug)).toEqual(shape(await exactRows(stmt.sql, [...stmt.params])).map(row => String(row[0])));
    } finally {
      spy.mockRestore();
    }
  });

  test('a selective filter leaves the walk short and searchVector returns the joined statement result', async () => {
    const opts: SearchOpts = { limit: 10, embeddingColumn: column, sourceId: 'side', excludePrivate: true };
    const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(7), limit: 10, offset: 0, opts });
    const walked = await exactRows(stmt.indexWalkSql!, [...stmt.params]);
    expect(Number(walked[0].candidate_pool)).toBeLessThan(stmt.innerLimit);
    const joined = await exactRows(stmt.sql, [...stmt.params]);
    await engine.executeRaw('SET enable_indexscan = off');
    try {
      const hits = await engine.searchVector(vec(7), opts);
      expect(hits).toHaveLength(10);
      expect(hits.map(hit => hit.slug)).toEqual(shape(joined).map(row => String(row[0])));
    } finally {
      await engine.executeRaw('RESET enable_indexscan');
    }
  });
});
