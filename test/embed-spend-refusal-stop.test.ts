/**
 * A spend guard's refusal stops `gbrain embed` instead of being retried per
 * page and per chunk. Queued embedding jobs approved with --max-usd run under
 * the job's spend guard; once it refuses, every later request would be refused
 * too, so fanning a batch out into single-chunk calls or marking pages toward
 * quarantine only multiplies refused meter reads and skips healthy pages later.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { mockEmbedProjectionEngine as mockEngine } from './helpers/embed-projection-mock.ts';
import { withEnv } from './helpers/with-env.ts';
import { openAppendBrain } from './helpers/append-brain.ts';
import { conversationPage } from './helpers/conversation-page.ts';
import { embedStaleTakes } from '../src/core/embed-takes.ts';
import { embedBatchWithBackoff, _setRateLimitFloorsForTests } from '../src/core/embed-retry.ts';

const DIMS = 1536;
const slugs = Array.from({ length: 3 }, (_, i) => `notes/refused-${i}`);
let sent = 0;

beforeEach(() => {
  sent = 0;
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    sent++;
    return { embeddings: values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
  }) as never);
});

afterEach(() => __setEmbedTransportForTests(null));
afterAll(() => resetGateway());

const chunks = (slug: string) => [0, 1].map(chunk_index => ({
  chunk_index, chunk_text: `Synthetic text ${chunk_index} for ${slug}.`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4,
}));

describe('embed stops at a spend refusal', () => {
  test('--stale: the first refusal ends the run with no per-chunk retries', async () => {
    const stale = slugs.flatMap((slug, i) => chunks(slug).map(c => ({
      slug, chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: 'compiled_truth' as const,
      model: null, token_count: 4, source_id: 'default', page_id: i + 1,
    })));
    let served = false;
    const engine = mockEngine({
      countStaleChunks: async () => (served ? 0 : stale.length),
      listStaleChunks: async () => { if (served) return []; served = true; return stale; },
      getChunks: async (slug: string) => chunks(slug),
      upsertChunks: async () => {},
    });
    let asked = 0;
    const refusal = new Error('job spend cap reached');
    const run = withAIInvocationGuard(async () => { asked++; throw refusal; },
      () => withEnv({ GBRAIN_EMBED_CONCURRENCY: '1' }, () => runEmbedCore(engine, { stale: true })));

    await expect(run).rejects.toBe(refusal);
    expect(asked).toBe(1);
    expect(sent).toBe(0);
  });

  test('--all: the first refusal ends the run with no per-chunk retries', async () => {
    const engine = mockEngine({
      listPages: async () => slugs.map(slug => ({ slug })),
      getChunks: async (slug: string) => chunks(slug),
      upsertChunks: async () => {},
    });
    let asked = 0;
    const refusal = new Error('job spend cap reached');
    const run = withAIInvocationGuard(async () => { asked++; throw refusal; },
      () => withEnv({ GBRAIN_EMBED_CONCURRENCY: '1' }, () => runEmbedCore(engine, { all: true })));

    await expect(run).rejects.toBe(refusal);
    expect(asked).toBe(1);
    expect(sent).toBe(0);
  });
});

describe('embed stops at a spend refusal on the other paths', () => {
  test('a segmented page: the refusal ends the run instead of being recorded as a page failure', async () => {
    const brain = await openAppendBrain('pglite');
    try {
      await brain.seed('notes/refused-segmented', conversationPage(1_200_000, { seed: 11 }));
      expect((await brain.body('notes/refused-segmented')).storage).toBe('segmented');
      await brain.seed('notes/refused-inline', '# Inline\n\nA small inline page.');
      let asked = 0;
      const refusal = new Error('job spend cap reached');
      const run = withAIInvocationGuard(async () => { asked++; throw refusal; },
        () => withEnv({ GBRAIN_EMBED_CONCURRENCY: '1' }, () => runEmbedCore(brain.engine, { slugs: ['notes/refused-segmented', 'notes/refused-inline'], quiet: true })));

      await expect(run).rejects.toBe(refusal);
      expect(asked).toBe(1);
      expect(brain.embedded).toEqual([]);
    } finally { await brain.close(); }
  }, 600_000);

  test('stale takes: a refusal is rethrown instead of being counted as a batch failure', async () => {
    const rows = [1, 2].map(take_id => ({ take_id, claim: `Synthetic claim ${take_id}.` }));
    const engine = mockEngine({
      countStaleTakes: async () => rows.length,
      listStaleTakes: async () => rows,
      executeRaw: async (sql: string) => /format_type/i.test(sql) ? [{ formatted: `vector(${DIMS})` }] : [],
      updateTakeEmbeddings: async (writes: unknown[]) => writes.length,
    });
    let asked = 0;
    const refusal = new Error('job spend cap reached');
    const run = withAIInvocationGuard(async () => { asked++; throw refusal; }, () => embedStaleTakes(engine, { batchSize: 1 }));

    await expect(run).rejects.toBe(refusal);
    expect(asked).toBe(1);
    expect(sent).toBe(0);
  });

  test('a refusal whose message carries 429 is never retried as a rate limit', async () => {
    _setRateLimitFloorsForTests([1]);
    try {
      let asked = 0;
      const refusal = new Error('job 4290 spend cap reached, try again in 1ms');
      const run = withAIInvocationGuard(async () => { asked++; throw refusal; }, () => embedBatchWithBackoff(['one text']));

      await expect(run).rejects.toBe(refusal);
      expect(asked).toBe(1);
      expect(sent).toBe(0);
    } finally { _setRateLimitFloorsForTests(null); }
  });
});
