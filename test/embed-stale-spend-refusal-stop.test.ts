/**
 * The embed-backfill job drains through embedStaleForSource. Under a queued
 * job's spend guard, the first refusal stops every key worker and is rethrown,
 * instead of being logged per page while the drain keeps asking the guard.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { openAppendBrain } from './helpers/append-brain.ts';
import { conversationPage } from './helpers/conversation-page.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../src/core/search/embedding-column.ts';
import { chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';

const DIMS = 1536;
let engine: PGLiteEngine;
let sent = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  sent = 0;
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    sent++;
    return { embeddings: values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
  }) as never);
});

afterEach(() => __setEmbedTransportForTests(null));

describe('embed-stale stops at a spend refusal', () => {
  test('the first refusal ends the drain and reaches the caller', async () => {
    for (let i = 0; i < 4; i++) {
      const slug = `notes/refused-${i}`;
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nseeded` });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined }]);
    }
    let asked = 0;
    const refusal = new Error('job spend cap reached');
    const run = withAIInvocationGuard(async () => { asked++; throw refusal; },
      () => embedStaleForSource(engine, 'default', { concurrency: 1 }));

    await expect(run).rejects.toBe(refusal);
    expect(asked).toBe(1);
    expect(sent).toBe(0);
  }, 60_000);
  test('a refusal on one key keeps the vectors a sibling key already paid for', async () => {
    for (let i = 0; i < 2; i++) {
      const slug = `notes/sibling-${i}`;
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nseeded` });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined }]);
    }
    let markRefused!: () => void;
    const refusedNow = new Promise<void>(resolve => { markRefused = resolve; });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      sent++;
      // The admitted request is still in flight when its sibling is refused.
      await refusedNow;
      await new Promise(resolve => setTimeout(resolve, 50));
      return { embeddings: values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
    }) as never);
    let asked = 0;
    const refusal = new Error('job spend cap reached');
    const run = withAIInvocationGuard(async () => {
      if (++asked === 1) return { settle: async () => {} };
      markRefused();
      throw refusal;
    }, () => embedStaleForSource(engine, 'default', { concurrency: 2 }));

    await expect(run).rejects.toBe(refusal);
    expect(asked).toBe(2);
    expect(sent).toBe(1);
    const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL');
    expect(row!.n).toBe(1);
  }, 60_000);
});

describe('embed-stale keeps a segmented key\'s paid vectors at a sibling refusal', () => {
  test('the segmented key installs the vectors it was sent while the inline key is refused', async () => {
    const brain = await openAppendBrain('pglite');
    try {
      await brain.seed('notes/sibling-segmented', conversationPage(1_200_000, { seed: 13 }));
      expect((await brain.body('notes/sibling-segmented')).storage).toBe('segmented');
      await brain.seed('notes/sibling-inline', '# Inline\n\nA small inline page.');
      const dims = (await resolveActiveEmbeddingColumnFromEngine(brain.engine)).dimensions;
      let markSent!: () => void;
      const segmentedSent = new Promise<void>(resolve => { markSent = resolve; });
      let markRefused!: () => void;
      const refusedNow = new Promise<void>(resolve => { markRefused = resolve; });
      let admitted = 0;
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
        admitted += values.length;
        markSent();
        // The segmented page's request is still in flight when the inline page is refused.
        await refusedNow;
        await new Promise(resolve => setTimeout(resolve, 50));
        return { embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
      }) as never);
      const refusal = new Error('job spend cap reached');
      // The segmented page's batch is the large one: admit it, and refuse the small inline batch once it is in flight.
      const run = withAIInvocationGuard(async call => {
        if ((call.estimatedInputTokens ?? 0) > 1_000) return { settle: async () => {} };
        await segmentedSent;
        markRefused();
        throw refusal;
      }, () => embedStaleForSource(brain.engine, 'default', { concurrency: 2 }));

      await expect(run).rejects.toBe(refusal);
      expect(admitted).toBeGreaterThan(0);
      const [row] = await brain.engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
          WHERE p.slug = 'notes/sibling-segmented' AND cc.embedding IS NOT NULL AND ${chunkGenerationFilter('p', 'cc')}`);
      expect(row!.n).toBe(admitted);
    } finally { await brain.close(); }
  }, 600_000);
});
