/**
 * PR #6411 diagnosis: the CRAG think escalation must read the sources the
 * query searched. An explicit per-call `source_id` used to be dropped, so
 * think ran against the context's default source instead.
 *
 * Serial: mock.module replaces hybrid search and think for the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SearchResult } from '../../src/core/types.ts';
import type { OperationContext } from '../../src/core/operations.ts';

let thinkCalls: Array<Record<string, unknown>> = [];
const actualHybrid = await import('../../src/core/search/hybrid.ts');
mock.module('../../src/core/search/hybrid.ts', () => ({
  ...actualHybrid,
  hybridSearchCached: async (_engine: unknown, _query: string, opts: { sourceId?: string; sourceIds?: string[] }) => [{
    slug: 'notes/weak-hit', source_id: opts.sourceId ?? opts.sourceIds?.[0] ?? 'default', page_id: 1, title: 'Weak hit',
    type: 'note', chunk_text: 'barely related', chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0,
    score: 0.01, rerank_score: 0.01, stale: false,
  } as SearchResult],
}));
const actualThink = await import('../../src/core/think/index.ts');
mock.module('../../src/core/think/index.ts', () => ({
  ...actualThink,
  runThink: async (_engine: unknown, opts: Record<string, unknown>) => {
    thinkCalls.push(opts);
    return { answer: 'scoped answer', citations: [], modelUsed: 'synthetic-model' };
  },
}));

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { operationsByName } = await import('../../src/core/operations.ts');
const { resetPgliteState } = await import('../helpers/reset-pglite.ts');
let engine: InstanceType<typeof PGLiteEngine>;

function context(): OperationContext {
  return {
    engine, remote: false, sourceId: 'beta-example', config: { engine: 'pglite' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    emitResponseMeta: () => {},
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);
beforeEach(async () => {
  await resetPgliteState(engine);
  for (const id of ['alpha-example', 'beta-example']) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [id]);
  }
  await engine.setConfig('search.crag_think', 'true');
  thinkCalls = [];
});
afterAll(async () => { await engine.disconnect(); });

describe('CRAG think escalation source scope', () => {
  test('an explicit source_id scopes think to that source, not the context default', async () => {
    await operationsByName.query.handler(context(), { query: 'weakly matched question', expand: false, source_id: 'alpha-example' });
    expect(thinkCalls).toHaveLength(1);
    expect(thinkCalls[0].sourceId).toBe('alpha-example');
    expect(thinkCalls[0].allowedSources).toBeUndefined();
  });

  test('without source_id think keeps the context default', async () => {
    await operationsByName.query.handler(context(), { query: 'weakly matched question', expand: false });
    expect(thinkCalls).toHaveLength(1);
    expect(thinkCalls[0].sourceId).toBe('beta-example');
  });
});
