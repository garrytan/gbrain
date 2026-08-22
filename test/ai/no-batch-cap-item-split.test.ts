/**
 * #3875 — `no_batch_cap` recipes get a default per-call item cap.
 *
 * Before this fix, recipes that declare `no_batch_cap: true` (Ollama, LiteLLM
 * proxy) sent ALL of a file's chunks to the provider in ONE request, so the
 * per-SDK-call AI_EMBED_TIMEOUT_MS (60s) silently became a per-FILE budget —
 * a slow local model embedding a large file timed out deterministically and
 * no retry could ever succeed.
 *
 * Now embed() caps those recipes at NO_BATCH_CAP_SUB_BATCH_ITEMS inputs per
 * transport call (explicit `max_batch_items` still wins), making the timeout
 * a per-batch bound. Verified through the public embed() with the transport
 * stubbed (same seam as adaptive-embed-batch.test.ts).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  NO_BATCH_CAP_SUB_BATCH_ITEMS,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { __setTestRecipesForTests } from '../../src/core/ai/recipes/index.ts';
import type { Recipe } from '../../src/core/ai/types.ts';

// Same leak-guard rationale as adaptive-embed-batch.test.ts: never leave a
// configured gateway (or a synthetic recipe list) behind for the next file.
afterAll(() => {
  __setTestRecipesForTests([]);
  __setEmbedTransportForTests(null);
  resetGateway();
});

function fakeEmbeddings(values: string[], dims: number): { embeddings: number[][] } {
  return {
    embeddings: values.map((_, i) =>
      Array.from({ length: dims }, (_, j) => (j === 0 ? i : 0.1)),
    ),
  };
}

/** A dynamic-cap recipe shaped like ollama/litellm: no token cap, no item cap. */
const NO_CAP_RECIPE: Recipe = {
  id: 'synthetic-nocap',
  name: 'Synthetic no_batch_cap (test fixture)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:9/v1',
  touchpoints: {
    embedding: {
      models: ['synthetic-embed-1'],
      default_dims: 8,
      no_batch_cap: true,
    },
  },
};

/** Same, but with an explicit max_batch_items — the explicit cap must win. */
const EXPLICIT_CAP_RECIPE: Recipe = {
  ...NO_CAP_RECIPE,
  id: 'synthetic-explicitcap',
  touchpoints: {
    embedding: {
      models: ['synthetic-embed-1'],
      default_dims: 8,
      no_batch_cap: true,
      max_batch_items: 4,
    },
  },
};

describe('#3875 embed() item-caps no_batch_cap recipes', () => {
  beforeEach(() => resetGateway());
  afterEach(() => {
    __setEmbedTransportForTests(null);
    __setTestRecipesForTests([]);
  });

  test('40 texts split into ceil(40/CAP) transport calls, each <= CAP', async () => {
    __setTestRecipesForTests([NO_CAP_RECIPE]);
    configureGateway({
      embedding_model: 'synthetic-nocap:synthetic-embed-1',
      embedding_dimensions: 8,
      env: {},
    });
    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 8));
    __setEmbedTransportForTests(stub as any);

    const texts = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const result = await embed(texts);

    const cap = NO_BATCH_CAP_SUB_BATCH_ITEMS;
    const expectedCalls = Math.ceil(40 / cap);
    expect(stub).toHaveBeenCalledTimes(expectedCalls);
    for (const [arg] of stub.mock.calls) {
      expect((arg as { values: string[] }).values.length).toBeLessThanOrEqual(cap);
    }
    // Order preserved across sub-batches: slot 0 encodes within-call index,
    // so reassembled output must be within-call-ascending per batch and total
    // length must match.
    expect(result).toHaveLength(40);
  });

  test('a batch already under the cap stays a single call', async () => {
    __setTestRecipesForTests([NO_CAP_RECIPE]);
    configureGateway({
      embedding_model: 'synthetic-nocap:synthetic-embed-1',
      embedding_dimensions: 8,
      env: {},
    });
    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 8));
    __setEmbedTransportForTests(stub as any);

    await embed(['a', 'b', 'c']);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  test('an explicit max_batch_items wins over the no_batch_cap default', async () => {
    __setTestRecipesForTests([EXPLICIT_CAP_RECIPE]);
    configureGateway({
      embedding_model: 'synthetic-explicitcap:synthetic-embed-1',
      embedding_dimensions: 8,
      env: {},
    });
    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 8));
    __setEmbedTransportForTests(stub as any);

    await embed(Array.from({ length: 10 }, (_, i) => `t${i}`));
    const sizes = stub.mock.calls.map(([arg]) => (arg as { values: string[] }).values.length);
    expect(sizes).toEqual([4, 4, 2]);
  });
});
