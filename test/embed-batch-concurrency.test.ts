/**
 * #1818: embedBatch dispatches its 100-input sub-batches through a bounded
 * worker pool (the embed-stale.ts concurrency pattern) instead of a serial
 * `for` loop. This file pins:
 *
 *   - output order matches input order regardless of completion order
 *     (index-addressed results)
 *   - parallelism actually happens (max in-flight > 1) and stays bounded
 *     (max in-flight <= configured concurrency)
 *   - concurrency: 1 restores the serial pre-#1818 dispatch
 *   - GBRAIN_EMBED_BATCH_CONCURRENCY env is honored when the option is unset
 *   - onBatchComplete reports a monotonic completed count ending at total
 *
 * Transport is stubbed via the gateway's __setEmbedTransportForTests seam
 * (same pattern as test/ai/adaptive-embed-batch.test.ts). OpenAI recipe =
 * fast path (no pre-split), so each embedBatch sub-batch is exactly one
 * transport call.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { embedBatch } from '../src/core/embedding.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;

function configureOpenAI(): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
}

/**
 * Install a transport whose returned embedding encodes the GLOBAL input
 * index in dim 0 (texts are `t<N>`), so order can be asserted end-to-end.
 * Tracks the max number of concurrently in-flight transport calls.
 */
function installTrackingTransport(delayMs = 5): { maxInFlight: () => number } {
  let inFlight = 0;
  let maxInFlight = 0;
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, delayMs));
    inFlight--;
    return {
      embeddings: values.map(v => {
        const idx = Number(v.slice(1));
        return Array.from({ length: DIMS }, (_, j) => (j === 0 ? idx : 0.1));
      }),
    };
  }) as any);
  return { maxInFlight: () => maxInFlight };
}

const texts = Array.from({ length: 250 }, (_, i) => `t${i}`);

afterAll(() => resetGateway());

describe('embedBatch bounded parallelism (#1818)', () => {
  beforeEach(() => {
    resetGateway();
    configureOpenAI();
  });
  afterEach(() => {
    __setEmbedTransportForTests(null);
  });

  test('default pool dispatches sub-batches in parallel, order preserved', async () => {
    const tracker = installTrackingTransport();
    const result = await embedBatch(texts, { onBatchComplete: () => {} });
    expect(result).toHaveLength(250);
    for (let i = 0; i < 250; i++) {
      expect(result[i][0]).toBe(i);
    }
    // 250 texts → 3 sub-batches; default concurrency 4 → all 3 in flight.
    expect(tracker.maxInFlight()).toBeGreaterThan(1);
    expect(tracker.maxInFlight()).toBeLessThanOrEqual(4);
  });

  test('concurrency: 1 keeps the serial dispatch', async () => {
    const tracker = installTrackingTransport();
    const result = await embedBatch(texts, { concurrency: 1, onBatchComplete: () => {} });
    expect(result).toHaveLength(250);
    expect(tracker.maxInFlight()).toBe(1);
  });

  test('GBRAIN_EMBED_BATCH_CONCURRENCY env bounds the pool when option unset', async () => {
    const tracker = installTrackingTransport();
    await withEnv({ GBRAIN_EMBED_BATCH_CONCURRENCY: '2' }, async () => {
      await embedBatch(texts, { onBatchComplete: () => {} });
    });
    expect(tracker.maxInFlight()).toBeGreaterThan(1);
    expect(tracker.maxInFlight()).toBeLessThanOrEqual(2);
  });

  test('onBatchComplete reports a monotonic count ending at total', async () => {
    installTrackingTransport();
    const seen: number[] = [];
    await embedBatch(texts, {
      onBatchComplete: (done, total) => {
        expect(total).toBe(250);
        seen.push(done);
      },
    });
    expect(seen).toHaveLength(3); // 100 + 100 + 50 sub-batches
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
    expect(seen[seen.length - 1]).toBe(250);
  });

  test('a failing sub-batch rejects the whole call', async () => {
    let call = 0;
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      call++;
      if (call === 2) throw new Error('boom');
      await new Promise(r => setTimeout(r, 2));
      return { embeddings: values.map(() => Array.from({ length: DIMS }, () => 0.1)) };
    }) as any);
    await expect(embedBatch(texts, { onBatchComplete: () => {} })).rejects.toThrow();
  });

  test('after a failure, surviving workers stop dispatching new slices', async () => {
    // 1000 texts → 10 slices, concurrency 2. First call fails immediately;
    // without the `failed` flag the second worker would keep draining all
    // 10 slices in the background AFTER embedBatch already rejected —
    // burning provider spend and firing onBatchComplete post-rejection.
    let calls = 0;
    const completions: number[] = [];
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      calls++;
      if (calls === 1) throw new Error('boom');
      await new Promise(r => setTimeout(r, 5));
      return { embeddings: values.map(() => Array.from({ length: DIMS }, () => 0.1)) };
    }) as any);
    const many = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    await expect(
      embedBatch(many, { concurrency: 2, onBatchComplete: d => completions.push(d) }),
    ).rejects.toThrow('boom');
    const callsAtRejection = calls;
    await new Promise(r => setTimeout(r, 50)); // would-be background drain window
    expect(calls).toBe(callsAtRejection); // no new dispatch after rejection
    expect(calls).toBeLessThanOrEqual(2); // only the in-flight sibling ran
    expect(completions).toHaveLength(0); // no progress reported after failure
  });

  test('single small batch without callback stays on the one-call fast path', async () => {
    const tracker = installTrackingTransport(1);
    const result = await embedBatch(['t0', 't1', 't2']);
    expect(result).toHaveLength(3);
    expect(result[1][0]).toBe(1);
    expect(tracker.maxInFlight()).toBe(1);
  });
});
