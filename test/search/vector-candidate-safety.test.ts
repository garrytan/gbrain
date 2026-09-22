import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { candidateColumn, candidateVector, seedVectorCandidateCorpus, verifyVectorCapabilityRetry } from '../helpers/vector-candidate-corpus.ts';

describe('PGLite filtered ANN candidate safety', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await seedVectorCandidateCorpus(engine);
  }, 240_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);
  test('a transient capability probe is retried and successful capability is cached', async () => { await verifyVectorCapabilityRetry(engine); });

  test('bounded iterative scanning fills selective source and private-filtered results', async () => {
    const events: unknown[] = [];
    const hits = await engine.searchVector(candidateVector, { limit: 75, sourceId: 'ann-allowed', excludePrivate: true, embeddingColumn: candidateColumn, onVectorPoolMeta: meta => events.push(meta) });
    expect(hits).toHaveLength(75);
    expect(new Set(hits.map(hit => hit.page_id)).size).toBe(75);
    expect(hits.every(hit => hit.source_id === 'ann-allowed' && Number(hit.slug.split('-').at(-1)) % 100 !== 1)).toBe(true);
    expect(events).toEqual([]);
  }, 60_000);

  test('deep offsets and genuinely empty scopes remain distinguishable', async () => {
    const events: unknown[] = [];
    expect(await engine.searchVector(candidateVector, { limit: 10, offset: 1040, embeddingColumn: candidateColumn, onVectorPoolMeta: meta => events.push(meta) })).toHaveLength(10);
    expect(await engine.searchVector(candidateVector, { limit: 10, sourceId: 'missing-source', embeddingColumn: candidateColumn, onVectorPoolMeta: meta => events.push(meta) })).toEqual([]);
    expect(await engine.searchVector(candidateVector, { limit: 10, sourceId: 'ann-allowed', type: 'company', embeddingColumn: candidateColumn, onVectorPoolMeta: meta => events.push(meta) })).toEqual([]);
    expect(events).toEqual([]);
  }, 60_000);

  test('transaction-local scan settings return to their prior values', async () => {
    const before = await engine.executeRaw(`SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS iterative, current_setting('hnsw.max_scan_tuples') AS tuples`);
    await engine.searchVector(candidateVector, { limit: 75, embeddingColumn: candidateColumn });
    expect(await engine.executeRaw(`SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS iterative, current_setting('hnsw.max_scan_tuples') AS tuples`)).toEqual(before);
  });

  test('older-extension underfill is explicit and never triggers a PGLite exact fallback', async () => {
    const capability = engine as unknown as { vectorIterativeScan?: Promise<boolean> };
    const previous = capability.vectorIterativeScan;
    capability.vectorIterativeScan = Promise.resolve(false);
    await engine.executeRaw('SET enable_seqscan = off');
    await engine.executeRaw('SET enable_sort = off');
    try {
      const events: Array<{ reason?: string; exactFallback?: boolean }> = [];
      const hits = await engine.searchVector(candidateVector, { limit: 75, sourceId: 'ann-allowed', excludePrivate: true, embeddingColumn: candidateColumn, onVectorPoolMeta: meta => events.push(meta) });
      expect(hits.length).toBeLessThan(75);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: 'iterative_scan_unavailable', exactFallback: false });
    } finally {
      capability.vectorIterativeScan = previous;
      await engine.executeRaw('RESET enable_seqscan');
      await engine.executeRaw('RESET enable_sort');
    }
  }, 60_000);

  test('the real iterative work ceiling reports incomplete candidates instead of a false clean miss', async () => {
    await engine.executeRaw(`UPDATE content_chunks cc SET language = 'rare-fixture' FROM pages p
      WHERE cc.page_id = p.id AND cc.chunk_index = 0 AND p.id % 60 = 1`);
    await engine.executeRaw('ANALYZE content_chunks');
    await engine.executeRaw('SET enable_seqscan = off');
    await engine.executeRaw('SET enable_sort = off');
    try {
      const events: Array<{ reason?: string; exactFallback?: boolean }> = [];
      const hits = await engine.searchVector(candidateVector, { limit: 75, language: 'rare-fixture', embeddingColumn: candidateColumn, onVectorPoolMeta: meta => events.push(meta) });
      expect(hits.length).toBeLessThan(75);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: 'candidate_budget', exactFallback: false });
      expect((await engine.executeRaw(`SELECT count(*)::int AS eligible FROM content_chunks WHERE language = 'rare-fixture'`))[0].eligible).toBe(100);
    } finally {
      await engine.executeRaw('RESET enable_seqscan');
      await engine.executeRaw('RESET enable_sort');
    }
  }, 60_000);
});
