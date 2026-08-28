/**
 * GBRAIN_EMBED_MAX_BATCH_TOKENS — operator-declared batch cap for
 * no_batch_cap recipes (ollama, llama-server, litellm). Reimplemented from
 * PR #3622 (drdeebtech).
 *
 * Why: local inference servers (ollama with `-np 1`) process one request
 * at a time and keep computing client-aborted requests. Without a batch
 * cap, embed() sends a page's ENTIRE chunk set as one request; a request
 * that outlives the embed timeout is retried forever by the stale-page
 * loop while the server grinds abandoned work — a self-sustaining
 * congestion collapse (observed 2026-07-29/30: 6,900+ timeouts, ~4 cores
 * pinned). The recipes deliberately declare `no_batch_cap: true` because
 * real capacity depends on the operator's hardware — so the cap is an
 * operator env knob, mirroring GBRAIN_EMBED_CONCURRENCY.
 *
 * The knob is read from the gateway's configure-time env snapshot
 * (`cfg.env`, Codex C3 — the gateway never reads process.env at call
 * time); production folds the whole process env into that snapshot via
 * buildGatewayConfig/mergedProviderEnv, so `export
 * GBRAIN_EMBED_MAX_BATCH_TOKENS=2048` reaches it. Tests therefore pass the
 * knob through configureGateway({env}) — hermetic, no process.env writes.
 *
 * Coverage:
 *  - env cap set + no_batch_cap recipe → pre-split into bounded batches
 *  - env cap absent → existing single-call fast path (regression guard)
 *  - invalid env values (0, negative, garbage, empty) → fast path unchanged
 *  - recipe-declared max_batch_tokens still wins over the env knob
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';

// Same rationale as test/ai/adaptive-embed-batch.test.ts: without a final
// reset, this file's last gateway config leaks into whichever test file the
// shard runs next.
afterAll(() => resetGateway());

function fakeEmbeddings(values: string[], dims: number): { embeddings: number[][] } {
  return {
    embeddings: values.map((_, i) =>
      Array.from({ length: dims }, (_, j) => (j === 0 ? i : 0.1)),
    ),
  };
}

const ENV_KEY = 'GBRAIN_EMBED_MAX_BATCH_TOKENS';

function configureOllama(env: Record<string, string | undefined> = {}): void {
  configureGateway({
    embedding_model: 'ollama:nomic-embed-text',
    embedding_dimensions: 768,
    env,
  });
}

describe('GBRAIN_EMBED_MAX_BATCH_TOKENS env cap for no_batch_cap recipes', () => {
  beforeEach(() => resetGateway());
  afterEach(() => __setEmbedTransportForTests(null));

  test('env cap set → ollama batches are pre-split and each stays within the token budget', async () => {
    configureOllama({ [ENV_KEY]: '1000' });

    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 768));
    __setEmbedTransportForTests(stub as any);

    // 10 texts × 2000 chars = 500 tokens each at the default 4 chars/token.
    // Budget 1000 tokens → at most 2 texts per batch (fewer once the default
    // safety factor tightens it) → several transport calls, never 1.
    const texts = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(2000));
    const result = await embed(texts);

    expect(result).toHaveLength(10);
    expect(stub.mock.calls.length).toBeGreaterThan(1);
    for (const [arg] of stub.mock.calls) {
      const batch = (arg as { values: string[] }).values;
      const batchChars = batch.reduce((s, t) => s + t.length, 0);
      // 1000 tokens × 4 chars/token = 4000 chars absolute ceiling per batch
      // (the safety factor only ever tightens below this).
      expect(batchChars).toBeLessThanOrEqual(4000);
    }
  });

  test('env cap absent → single transport call (existing fast-path preserved)', async () => {
    configureOllama({});

    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 768));
    __setEmbedTransportForTests(stub as any);

    const texts = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(2000));
    const result = await embed(texts);

    expect(stub).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(10);
  });

  test.each(['0', '-5', 'abc', ''])('invalid env value %j → fast path unchanged', async (bad) => {
    configureOllama({ [ENV_KEY]: bad });

    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 768));
    __setEmbedTransportForTests(stub as any);

    const result = await embed(['a'.repeat(8000), 'b'.repeat(8000)]);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
  });

  test('recipe-declared max_batch_tokens wins over a larger env value', async () => {
    // Voyage declares max_batch_tokens=120000 with safety_factor 0.5 →
    // 60K-token effective budget. A huge env value must NOT loosen it.
    configureGateway({
      embedding_model: 'voyage:voyage-3-large',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: 'sk-fake', [ENV_KEY]: '99000000' },
    });

    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 1024));
    __setEmbedTransportForTests(stub as any);

    // 20 texts × 8000 chars (= MAX_CHARS, so no truncation) = 8000 tokens
    // each at voyage's 1 char/token density → 160K tokens total against a
    // 60K effective budget → must split into >1 call. If the env value
    // (99M) leaked past the recipe cap, everything would fit in 1 call.
    const texts = Array.from({ length: 20 }, (_, i) => `${i % 10}`.repeat(8000));
    await embed(texts);
    expect(stub.mock.calls.length).toBeGreaterThan(1);
  });
});
