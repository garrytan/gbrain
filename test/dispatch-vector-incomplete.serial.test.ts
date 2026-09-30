import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let results: unknown[] = [];
mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearchCached: async (_engine: unknown, _query: string, opts: { onMeta?: (meta: unknown) => void }) => {
    opts.onMeta?.({
      vector_enabled: true, expansion_applied: false, detail_resolved: null,
      retrieved_count: results.length,
      degraded: [{ stage: 'vector_candidates_incomplete', reason: 'candidate_budget' }],
      vector_pool_underfilled: { escalations: 3, innerLimit: 1600, candidatePool: 0, incomplete: true },
    });
    return results;
  },
}));

const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');
const engine = {
  getConfig: async () => null,
  executeRaw: async (sql: string) => sql.includes('AS pending') ? [{ pending: false }] : [],
} as unknown as BrainEngine;

describe('HTTP MCP dispatch preserves bounded-vector incompleteness', () => {
  test.each([false, true])('real operation response carries metadata when nonempty=%s', async nonempty => {
    results = nonempty ? [{ page_id: 1, source_id: 'default', slug: 'notes/synthetic', chunk_text: 'Synthetic note' }] : [];
    const response = await dispatchToolCall(engine, 'search', { query: 'synthetic' }, {
      remote: true, transport: 'http', sourceId: 'default',
    });
    expect(response.isError).toBeUndefined();
    const retrieval = (response._meta as { retrieval: Record<string, unknown> }).retrieval;
    expect(retrieval.degraded).toContainEqual({ stage: 'vector_candidates_incomplete', reason: 'candidate_budget' });
    expect(retrieval.vector_pool_underfilled).toEqual({ escalations: 3, innerLimit: 1600, candidatePool: 0, incomplete: true });
    if (!nonempty) {
      expect(response.content[1].text).toContain('vector_candidates_incomplete');
      expect(response.content[1].text).not.toContain('clean miss');
    }
  });
});
