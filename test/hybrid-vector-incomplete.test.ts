import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';

describe('hybrid search carries engine underfill into recall degradation', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('search.reranker.enabled', 'false');
  }, 60_000);

  afterAll(async () => { await engine?.disconnect(); });

  test('an incomplete zero-row engine result is not a clean miss', async () => {
    const original = engine.searchVector;
    engine.searchVector = async (_embedding, opts) => {
      opts?.onVectorPoolMeta?.({
        underfilled: true, incomplete: true, reason: 'candidate_budget',
        escalations: 3, innerLimit: 1600, candidatePool: 0,
      });
      return [];
    };
    try {
      let meta: HybridSearchMeta | undefined;
      const rows = await hybridSearch(engine, 'synthetic missing candidate', {
        expansion: false,
        queryEmbedFn: () => Float32Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0),
        onMeta: value => { meta = value; },
      });
      expect(rows).toEqual([]);
      expect(meta?.degraded).toContainEqual({ stage: 'vector_candidates_incomplete', reason: 'candidate_budget' });
      expect(meta?.vector_pool_underfilled).toMatchObject({ incomplete: true, candidatePool: 0, innerLimit: 1600 });
    } finally { engine.searchVector = original; }
  });
});
