import { describe, test, expect, mock } from 'bun:test';

// v0.22.15 — cooperative abort coverage for embedBatch itself.
//
// We mock the gateway (not embedBatch) so the real BATCH_SIZE-paginator
// loop and throwIfAborted() checks run. Separate file from
// embed.serial.test.ts because that file mocks embedBatch wholesale.
//
// `*.serial.test.ts` because `mock.module(...)` leaks across files in
// the shard process (per scripts/check-test-isolation.sh R2).

let gatewayCalls = 0;
let perCallDelayMs = 20;

mock.module('../src/core/ai/gateway.ts', () => ({
  embed: async (texts: string[]) => {
    gatewayCalls++;
    await new Promise(r => setTimeout(r, perCallDelayMs));
    return texts.map(() => new Float32Array(1536));
  },
  embedOne: async (_text: string) => new Float32Array(1536),
  getEmbeddingModel: () => 'openai:text-embedding-3-large',
  getEmbeddingDimensions: () => 1536,
  embedMultimodal: async () => new Float32Array(1536),
}));

// Import AFTER the mock so embedBatch picks up our stub gateway.
const { embedBatch } = await import('../src/core/embedding.ts');

describe('embedBatch cooperative abort (v0.22.15)', () => {
  test('signal already aborted before first sub-batch — throws immediately', async () => {
    gatewayCalls = 0;
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    await expect(
      embedBatch(['a', 'b'], { signal: controller.signal }),
    ).rejects.toThrow('pre-aborted');

    // The fast-path (texts.length <= 100, no onBatchComplete) must check
    // the signal BEFORE calling the gateway.
    expect(gatewayCalls).toBe(0);
  });

  test('aborts between sub-batches (>100 texts → multi-batch loop)', async () => {
    gatewayCalls = 0;
    perCallDelayMs = 20;
    const texts = Array.from({ length: 350 }, (_, i) => `chunk ${i}`);
    const controller = new AbortController();
    // Fire abort after the first sub-batch is well into flight; the
    // between-batch check on the second iteration must unwind.
    setTimeout(() => controller.abort(new Error('mid-batch-abort')), 25);

    await expect(
      embedBatch(texts, { signal: controller.signal, onBatchComplete: () => {} }),
    ).rejects.toThrow('mid-batch-abort');

    // 350 texts → 4 sub-batches if completed. We must stop short.
    expect(gatewayCalls).toBeGreaterThanOrEqual(1);
    expect(gatewayCalls).toBeLessThan(4);
  });

  test('no signal supplied — embedBatch unchanged (regression guard)', async () => {
    gatewayCalls = 0;
    const out = await embedBatch(['a', 'b']);
    expect(out.length).toBe(2);
    expect(gatewayCalls).toBe(1);
  });

  test('signal supplied but never fires — completes normally', async () => {
    gatewayCalls = 0;
    const controller = new AbortController();
    const out = await embedBatch(['a', 'b'], { signal: controller.signal });
    expect(out.length).toBe(2);
  });
});
