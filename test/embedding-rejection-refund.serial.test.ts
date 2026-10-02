/**
 * Wave-3 connector follow-up #11: an embedding request the provider rejects
 * (HTTP 400/413/422) kept its maximum debit against the `gbrain migrate
 * embeddings --max-cost-usd` authorization, so a migration could stop early at
 * the cap. Only token-limit rejections released their reservation. A rejection
 * is now released only for providers whose documentation says rejected
 * requests are not billed (Google); every other provider keeps the debit.
 *
 * Each case runs at exactly the cap: the authorization covers one request at
 * its maximum input size, so the request after a rejection is admitted only if
 * the rejection was released.
 *
 * Serial: the gateway transport and configuration are process-global.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, embed, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { isUnbilledEmbeddingRejection } from '../src/core/ai/errors.ts';
import { planEmbeddingMigration, readMigrationState, runSchemaTransition } from '../src/core/embedding-migration.ts';
import { authorizeMigrationBudget } from '../src/core/embedding-migration-budget.ts';
import { withAIInvocationGuard, type AIInvocation } from '../src/core/ai/invocation-guard.ts';

const RATE_PER_MTOK = 1_000;
const TEXT = 'Synthetic rejected chunk. '.repeat(20);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
}, 60_000);

function rejection(status: number): Error {
  return Object.assign(new Error('Synthetic invalid request: input rejected'), { statusCode: status });
}

async function atExactCap(model: string, dims: number, env: Record<string, string>, status: number) {
  await runSchemaTransition(engine, dims);
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'embedding_migration.%'");
  await engine.setConfig('pricing.overrides', JSON.stringify({ [model]: RATE_PER_MTOK }));
  resetGateway();
  configureGateway({ embedding_model: model, embedding_dimensions: dims, env });
  const vector = () => Array.from({ length: dims }, () => 0.1);
  let reject = true;
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    if (reject) throw rejection(status);
    return { values, warnings: [], embeddings: values.map(vector), usage: { tokens: 10 } };
  });
  // The cap is exactly one request at its maximum input size.
  let maxInputTokens = 0;
  await withAIInvocationGuard(async (call: AIInvocation) => { maxInputTokens = call.maxInputTokens!; return { settle: async () => {} }; },
    () => embed([TEXT], { embeddingModel: model, dimensions: dims })).catch(() => {});
  expect(maxInputTokens).toBeGreaterThan(0);
  const cap = maxInputTokens * RATE_PER_MTOK / 1_000_000;
  const debit = await authorizeMigrationBudget(engine, await planEmbeddingMigration(engine, { to: model, dim: dims }), cap);
  await expect(withAIInvocationGuard(debit, () => embed([TEXT], { embeddingModel: model, dimensions: dims }))).rejects.toThrow();
  const afterRejection = (await readMigrationState(engine)).state!.budget!;
  reject = false;
  const next = await withAIInvocationGuard(debit, () => embed([TEXT], { embeddingModel: model, dimensions: dims })).then(() => 'embedded', (e: Error) => e.message);
  return { cap, afterRejection, next };
}

describe('embedding rejection refund', () => {
  test('Google (documented unbilled): a 400 rejection is released and the next request fits the exact cap', async () => {
    const r = await atExactCap('google:gemini-embedding-001', 768, { GOOGLE_GENERATIVE_AI_API_KEY: 'synthetic-only' }, 400);
    expect(r.afterRejection.debited_usd).toBe(0);
    expect(r.next).toBe('embedded');
  });

  test('OpenAI (no such statement): a 400 rejection keeps its debit and the next request is refused at the cap', async () => {
    const r = await atExactCap('openai:text-embedding-3-small', 8, { OPENAI_API_KEY: 'synthetic-only' }, 400);
    expect(r.afterRejection.debited_usd).toBeCloseTo(r.cap, 12);
    expect(r.next).toContain('Migration authorization exhausted');
  });

  test('only request-shaped rejections from documented providers qualify', () => {
    for (const status of [400, 413, 422]) expect(isUnbilledEmbeddingRejection('google', rejection(status))).toBe(true);
    for (const status of [401, 403, 429, 500]) expect(isUnbilledEmbeddingRejection('google', rejection(status))).toBe(false);
    for (const provider of ['openai', 'voyage', 'mistral', 'azure-openai']) expect(isUnbilledEmbeddingRejection(provider, rejection(400))).toBe(false);
    expect(isUnbilledEmbeddingRejection('google', new Error('no status'))).toBe(false);
  });
});
