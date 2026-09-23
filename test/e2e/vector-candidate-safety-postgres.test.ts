import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { candidateColumn, candidateVector, seedVectorCandidateCorpus, verifyVectorCapabilityRetry } from '../helpers/vector-candidate-corpus.ts';
import type { SearchOpts } from '../../src/core/types.ts';

(hasDatabase() ? describe : describe.skip)('Postgres filtered ANN candidate safety', () => {
  let engine: PostgresEngine;
  let delayExact = false;
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const opts: SearchOpts = { limit: 75, sourceId: 'ann-allowed', excludePrivate: true, embeddingColumn: candidateColumn };

  beforeAll(async () => {
    const seedEngine = await setupDB();
    await seedVectorCandidateCorpus(seedEngine);
    engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL!, poolSize: 1 });
    const scoped = engine as unknown as { withScopedReadTransaction: (...args: any[]) => Promise<any> };
    const original = scoped.withScopedReadTransaction;
    scoped.withScopedReadTransaction = function (sourceIds, sourceId, fn, options) { return original.call(this, sourceIds, sourceId, (tx: any) => fn(new Proxy(tx, {
      get(target, key) {
        if (key !== 'unsafe') return Reflect.get(target, key);
        return (sql: string, params: unknown[]) => {
          if (sql.includes('WITH hnsw_candidates')) statements.push({ sql, params: [...params] });
          if (delayExact && sql.includes(') + 0')) return target.unsafe('SELECT pg_sleep(30)');
          return target.unsafe(sql, params);
        };
      },
    })), options); };
  }, 240_000);

  afterAll(async () => {
    await engine?.executeRaw('DROP INDEX IF EXISTS idx_chunks_candidate_fixture');
    await engine?.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_candidate_fixture');
    await engine?.disconnect();
    await teardownDB();
  }, 60_000);

  test('a transient capability probe is retried and successful capability is cached', async () => { await verifyVectorCapabilityRetry(engine); });

  test('natural HNSW serves a mostly-current corpus and selective plans preserve authorization', async () => {
    const firstStatement = statements.length;
    await engine.searchVector(candidateVector, { limit: 75, embeddingColumn: candidateColumn });
    const events: unknown[] = [];
    const hits = await engine.searchVector(candidateVector, { ...opts, onVectorPoolMeta: meta => events.push(meta) });
    expect(hits).toHaveLength(75);
    expect(new Set(hits.map(hit => hit.page_id)).size).toBe(75);
    expect(hits.every(hit => hit.source_id === 'ann-allowed' && Number(hit.slug.split('-').at(-1)) % 100 !== 1)).toBe(true);
    expect(events).toEqual([]);
    const captured = statements[firstStatement];
    const plan = await engine.transaction(async tx => {
      await tx.executeRaw(`SET LOCAL hnsw.ef_search = 375`);
      await tx.executeRaw(`SET LOCAL hnsw.iterative_scan = 'strict_order'`);
      return tx.executeRaw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.sql}`, captured.params);
    });
    expect(JSON.stringify(plan)).toContain('idx_chunks_candidate_fixture');
    const stale = await engine.executeRaw(`SELECT id FROM pages WHERE text_projection_revision IS DISTINCT FROM knowledge_revision`);
    expect(stale.length).toBeGreaterThan(0);
    const staleIds = new Set(stale.map(row => Number(row.id)));
    expect(hits.some(hit => staleIds.has(hit.page_id))).toBe(false);
  }, 60_000);

  test('filtered HNSW underfill is recovered without confusing a short pool with exhaustion', async () => {
    const captured = statements.find(statement => statement.params.includes('ann-allowed'))!;
    await engine.executeRaw('SET enable_seqscan = off');
    await engine.executeRaw('SET enable_sort = off');
    try {
      const oldRows = await engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL hnsw.ef_search = 75`);
        await tx.executeRaw(`SET LOCAL hnsw.iterative_scan = 'off'`);
        return tx.executeRaw(captured.sql, captured.params.map(value => value === 375 ? 75 : value));
      });
      expect(oldRows.filter(row => row.page_id != null).length).toBeLessThan(75);
      const events: unknown[] = [];
      const hits = await engine.searchVector(candidateVector, { ...opts, onVectorPoolMeta: meta => events.push(meta) });
      console.info(JSON.stringify({ metric: 'filtered-ann-candidates', efSearchOnly: oldRows.filter(row => row.page_id != null).length, boundedRecovery: hits.length }));
      expect(hits).toHaveLength(75);
      expect(events).toEqual([]);
    } finally {
      await engine.executeRaw('RESET enable_seqscan');
      await engine.executeRaw('RESET enable_sort');
    }
  }, 60_000);

  test('older-extension compatibility uses one explicitly exact and identically scoped fallback', async () => {
    const capability = engine as unknown as { vectorIterativeScan?: Promise<boolean> };
    const previous = capability.vectorIterativeScan;
    const start = statements.length;
    capability.vectorIterativeScan = Promise.resolve(false);
    await engine.executeRaw('SET enable_seqscan = off');
    await engine.executeRaw('SET enable_sort = off');
    try {
      const events: unknown[] = [];
      const hits = await engine.searchVector(candidateVector, { ...opts, onVectorPoolMeta: meta => events.push(meta) });
      expect(hits).toHaveLength(75);
      expect(hits.every(hit => hit.source_id === 'ann-allowed' && Number(hit.slug.split('-').at(-1)) % 100 !== 1)).toBe(true);
      expect(events).toEqual([]);
      const exact = statements.slice(start).filter(statement => statement.sql.includes(') + 0'));
      expect(exact).toHaveLength(1);
      const plan = await engine.executeRaw(`EXPLAIN (FORMAT JSON) ${exact[0].sql}`, exact[0].params);
      expect(JSON.stringify(plan)).not.toContain('idx_chunks_candidate_fixture');
    } finally {
      capability.vectorIterativeScan = previous;
      await engine.executeRaw('RESET enable_seqscan');
      await engine.executeRaw('RESET enable_sort');
    }
  }, 60_000);

  test('deep offsets past ef_search 1000 remain reachable', async () => {
    const events: unknown[] = [];
    const hits = await engine.searchVector(candidateVector, { limit: 10, offset: 1040, embeddingColumn: candidateColumn, onVectorPoolMeta: meta => events.push(meta) });
    expect(hits).toHaveLength(10);
    expect(events).toEqual([]);
  }, 60_000);

  test('natural ANN recall remains measurable against an identically scoped exact baseline', async () => {
    for (const angle of [0, 0.5, 1.5]) {
      const query = new Float32Array([Math.cos(angle), Math.sin(angle), 0.1, 0, 0, 0, 0, 0]);
      const firstStatement = statements.length;
      const annStart = performance.now();
      const hits = await engine.searchVector(query, { limit: 75, embeddingColumn: candidateColumn });
      const annMs = performance.now() - annStart;
      const captured = statements[firstStatement];
      const exactSql = captured.sql.replace('ORDER BY cc."embedding_candidate_fixture" <=> $1::vector', 'ORDER BY (cc."embedding_candidate_fixture" <=> $1::vector) + 0');
      expect(exactSql).not.toBe(captured.sql);
      const params = [...captured.params];
      params[1] = null;
      const exactStart = performance.now();
      const exact = await engine.executeRaw(exactSql, params);
      const exactIds = new Set(exact.map(row => Number(row.page_id)));
      const recall = hits.filter(hit => exactIds.has(hit.page_id)).length / 75;
      console.info(JSON.stringify({ metric: 'candidate-recall@75', angle, recall, annMs, exactMs: performance.now() - exactStart }));
      expect(hits).toHaveLength(75);
      expect(recall).toBeGreaterThanOrEqual(0.9);
    }
  }, 60_000);

  test('all shape filters remain in the candidate pool and empty scopes are genuinely exhausted', async () => {
    const events: unknown[] = [];
    expect(await engine.searchVector(candidateVector, { ...opts, type: 'company', onVectorPoolMeta: meta => events.push(meta) })).toEqual([]);
    expect(await engine.searchVector(candidateVector, { ...opts, sourceId: 'missing-source', onVectorPoolMeta: meta => events.push(meta) })).toEqual([]);
    expect(await engine.searchVector(candidateVector, { ...opts, language: 'python', onVectorPoolMeta: meta => events.push(meta) })).toEqual([]);
    expect(events).toEqual([]);
    const hits = await engine.searchVector(candidateVector, opts);
    const excluded = hits.slice(0, 10).map(hit => hit.slug);
    const filtered = await engine.searchVector(candidateVector, { ...opts, exclude_slugs: excluded, types: ['note'], symbolKind: 'function', language: 'typescript' });
    expect(filtered).toHaveLength(75);
    expect(filtered.some(hit => excluded.includes(hit.slug))).toBe(false);
  }, 60_000);

  test('search-local ANN settings never leak onto the pooled connection', async () => {
    const before = await engine.executeRaw(`SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS iterative, current_setting('hnsw.max_scan_tuples') AS tuples`);
    await engine.searchVector(candidateVector, opts);
    expect(await engine.executeRaw(`SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS iterative, current_setting('hnsw.max_scan_tuples') AS tuples`)).toEqual(before);
    await engine.transaction(async tx => {
      await tx.executeRaw(`SET LOCAL statement_timeout = '20s'`);
      const before = await tx.executeRaw(`SELECT current_setting('statement_timeout') AS timeout, current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS iterative, current_setting('hnsw.max_scan_tuples') AS tuples`);
      await tx.searchVector(candidateVector, opts);
      await tx.searchVector(candidateVector, { ...opts, sourceId: 'missing-source' });
      expect(await tx.executeRaw(`SELECT current_setting('statement_timeout') AS timeout, current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS iterative, current_setting('hnsw.max_scan_tuples') AS tuples`)).toEqual(before);
    });
  });

  test('the exact fallback is server-cancelled at the remaining deadline and preserves ANN survivors', async () => {
    const capability = engine as unknown as { vectorIterativeScan?: Promise<boolean> };
    const previous = capability.vectorIterativeScan;
    capability.vectorIterativeScan = Promise.resolve(false);
    await engine.executeRaw('SET enable_seqscan = off');
    await engine.executeRaw('SET enable_sort = off');
    delayExact = true;
    try {
      const events: Array<{ reason?: string; exactFallback?: boolean }> = [];
      const start = performance.now();
      const hits = await engine.searchVector(candidateVector, { ...opts, onVectorPoolMeta: meta => events.push(meta) });
      expect(performance.now() - start).toBeLessThan(15_000);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThan(75);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: 'deadline', exactFallback: true });
      expect(await engine.executeRaw('SELECT 1 AS healthy')).toEqual([{ healthy: 1 }]);
    } finally {
      delayExact = false;
      capability.vectorIterativeScan = previous;
      await engine.executeRaw('RESET enable_seqscan');
      await engine.executeRaw('RESET enable_sort');
    }
  }, 30_000);
});
