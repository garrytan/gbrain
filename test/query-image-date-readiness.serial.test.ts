import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as gateway from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { SearchOpts } from '../src/core/types.ts';
import { decodeDeepResearchId } from '../src/core/deep-research-id.ts';

let embeddings = 0;
mock.module('../src/core/ai/gateway.ts', () => ({
  ...gateway,
  embedMultimodal: async () => { embeddings++; return [new Float32Array(1024)]; },
}));
const { operationsByName } = await import('../src/core/operations.ts');

beforeEach(() => { embeddings = 0; });

describe('image query retains date and readiness contracts outside hybrid search', () => {
  test.each([false, true])('incomplete vector metadata survives with a nonempty image result=%s', async nonempty => {
    let options: SearchOpts | undefined;
    let meta: Record<string, unknown> = {};
    const engine = {
      getConfig: async () => null,
      getAllConfig: async () => ({}),
      executeRaw: async (sql: string) => sql.includes('AS pending') ? [{ pending: false }] : [],
      searchVector: async (_vector: Float32Array, opts: SearchOpts) => {
        options = opts;
        opts.onVectorPoolMeta?.({ underfilled: true, incomplete: true, escalations: 3,
          innerLimit: 1600, candidatePool: 1, reason: 'deadline' });
        return nonempty ? [{ slug: 'images/synthetic', page_id: 1, source_id: 'default', chunk_text: 'Synthetic image' }] : [];
      },
    } as unknown as BrainEngine;
    const ctx = { engine, remote: true, sourceId: 'default', config: { engine: 'pglite' },
      dryRun: false, logger: console,
      emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') meta = value as Record<string, unknown>; },
    } as OperationContext;
    const results = await operationsByName.query.handler(ctx, {
      image: 'c3ludGhldGlj', limit: 3, since: '2030-06-15', until: '2030-06-15',
    });
    expect(results).toHaveLength(nonempty ? 1 : 0);
    if (nonempty) {
      expect(decodeDeepResearchId((results as Array<{ id: string }>)[0].id))
        .toEqual({ sourceId: 'default', slug: 'images/synthetic' });
    }
    expect(options).toMatchObject({ afterDate: '2030-06-15', afterDateInclusive: true,
      beforeDate: '2030-06-16T00:00:00.000Z', beforeDateInclusive: false,
      sourceId: 'default', excludePrivate: true, requireSafeChunks: true });
    expect(meta.degraded).toContainEqual({ stage: 'vector_candidates_incomplete', reason: 'timeout' });
    expect(meta.vector_pool_underfilled).toMatchObject({ incomplete: true, candidatePool: 1 });
    expect(meta.projection_readiness).toEqual({ status: 'ready', ready: true });
  });

  test('invalid date input fails before an embedding request', async () => {
    const engine = { getConfig: async () => null } as unknown as BrainEngine;
    const ctx = { engine, remote: true, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false, logger: console } as OperationContext;
    await expect(operationsByName.query.handler(ctx, { image: 'c3ludGhldGlj', since: 'not-a-date' })).rejects.toThrow('Invalid since');
    expect(embeddings).toBe(0);
  });
});
