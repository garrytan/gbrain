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
});
