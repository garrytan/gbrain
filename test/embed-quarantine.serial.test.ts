/**
 * Embed failure quarantine (--stale path). Reimplemented from PR #3622
 * (drdeebtech).
 *
 * Why: a page whose embed makes no progress is only logged; its chunks stay
 * NULL, so every autopilot cycle re-sends the exact same doomed request
 * forever. Against a serial local embedding server (ollama `-np 1`) that
 * keeps computing client-aborted requests, this self-sustains into a
 * congestion collapse (observed 2026-07-29/30: 6,900+ timeouts, pages
 * retried 29×, ~4 CPU cores pinned for days). The quarantine gives the loop
 * a give-up point: after N consecutive ZERO-progress attempts in one
 * process, the page is skipped until the process restarts (or the operator
 * sets frontmatter.embed_skip permanently).
 *
 * Coverage:
 *  - page failing GBRAIN_EMBED_QUARANTINE_AFTER (default 3) consecutive
 *    runs is skipped on the next run
 *  - a success resets the counter (transient blips never quarantine)
 *  - a PARTIAL failure (#3037 per-chunk isolation left some chunks NULL but
 *    others embedded) counts as progress, never toward quarantine — the
 *    next pass sends a smaller request, not the identical doomed one
 *  - the threshold is operator-tunable via env
 *
 * Serial: uses mock.module (leaks across files sharing a bun process).
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

let totalPoisonCalls = 0;
let embedShouldFail = true;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    if (texts.some(t => t.includes('POISON'))) {
      totalPoisonCalls++;
      // Deterministic-failure shaped: not 429/gateway/net-transient (#3374
      // retries timeouts in-run now), so the backoff loop throws immediately
      // and the call count stays the attempt count.
      if (embedShouldFail) throw new Error('[embed(ollama:nomic-embed-text)] 401 Unauthorized');
    }
    return texts.map(() => new Float32Array(1536));
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));

// Import AFTER mocking.
const { runEmbedCore, _resetEmbedQuarantineForTest } = await import('../src/commands/embed.ts');

// Preflight seam (same as test/embed-partial-failure-3037.serial.test.ts):
// make diagnoseEmbedding's fast-path pass without real env vars.
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  return new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop]) return overrides[prop];
      return track(prop);
    },
  });
}

// ONE chunk on purpose: a single-text batch never fans out (#3037 isolation
// needs >1 text), so each attempted run costs exactly one embedBatch call —
// the call count IS the attempt count.
const POISON_ROWS = [
  { page_id: 1, chunk_index: 0, source_id: 'default', slug: 'poison', chunk_text: 'POISON chunk one', chunk_source: 'compiled_truth' as const, model: null, token_count: 4 },
];

function poisonEngine(): BrainEngine {
  return mockEngine({
    countStaleChunks: async () => POISON_ROWS.length,
    listStaleChunks: async () => POISON_ROWS,
    getChunks: async () => POISON_ROWS.map(r => ({
      chunk_index: r.chunk_index, chunk_text: r.chunk_text,
      chunk_source: r.chunk_source, token_count: r.token_count,
    })),
    upsertChunks: async () => {},
    setPageEmbeddingSignature: async () => {},
  });
}

beforeEach(() => {
  totalPoisonCalls = 0;
  embedShouldFail = true;
  process.env.GBRAIN_EMBED_CONCURRENCY = '1';
  _resetEmbedQuarantineForTest?.();
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_QUARANTINE_AFTER;
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
});

describe('embed --stale failure quarantine', () => {
  test('page failing 3 consecutive runs is quarantined on the 4th', async () => {
    const engine = poisonEngine();

    for (let run = 1; run <= 3; run++) {
      await runEmbedCore(engine, { stale: true });
      expect(totalPoisonCalls).toBe(run); // one attempt per run, no more
    }

    await runEmbedCore(engine, { stale: true });
    // Quarantined: run 4 must NOT send the doomed page to the provider.
    expect(totalPoisonCalls).toBe(3);
  });

  test('a success resets the failure counter', async () => {
    const engine = poisonEngine();

    await runEmbedCore(engine, { stale: true }); // fail #1
    await runEmbedCore(engine, { stale: true }); // fail #2
    embedShouldFail = false;
    await runEmbedCore(engine, { stale: true }); // success → counter resets
    embedShouldFail = true;
    await runEmbedCore(engine, { stale: true }); // fail #1 (fresh count)
    // Without reset the page would already be quarantined here (3 cumulative
    // failures) and this run would add no call. With reset it must attempt.
    expect(totalPoisonCalls).toBe(4);

    await runEmbedCore(engine, { stale: true }); // fail #2
    await runEmbedCore(engine, { stale: true }); // fail #3 → quarantine
    await runEmbedCore(engine, { stale: true }); // skipped
    expect(totalPoisonCalls).toBe(6);
  });

  test('partial failure (#3037 fan-out embedded some chunks) never quarantines', async () => {
    // Two chunks: the whole-page batch fails, isolation retries per chunk,
    // POISON fails and the sibling succeeds → progress every run. Each run
    // costs 2 POISON-bearing calls (the batch + the single-chunk retry).
    const rows = [
      { page_id: 1, chunk_index: 0, source_id: 'default', slug: 'partial-poison', chunk_text: 'POISON chunk', chunk_source: 'compiled_truth' as const, model: null, token_count: 4 },
      { page_id: 1, chunk_index: 1, source_id: 'default', slug: 'partial-poison', chunk_text: 'healthy chunk', chunk_source: 'compiled_truth' as const, model: null, token_count: 4 },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => rows.length,
      listStaleChunks: async () => rows,
      getChunks: async () => rows.map(r => ({
        chunk_index: r.chunk_index, chunk_text: r.chunk_text,
        chunk_source: r.chunk_source, token_count: r.token_count,
      })),
      upsertChunks: async () => {},
    });

    for (let run = 1; run <= 5; run++) {
      const result = await runEmbedCore(engine, { stale: true });
      // Still attempted on runs 4 and 5 — well past the default threshold.
      expect(totalPoisonCalls).toBe(run * 2);
      expect(result.embedded).toBe(1); // the healthy sibling landed
    }
  });

  test('threshold is tunable via GBRAIN_EMBED_QUARANTINE_AFTER', async () => {
    process.env.GBRAIN_EMBED_QUARANTINE_AFTER = '1';
    const engine = poisonEngine();

    await runEmbedCore(engine, { stale: true }); // fail #1 → quarantine immediately
    await runEmbedCore(engine, { stale: true }); // skipped
    expect(totalPoisonCalls).toBe(1);
  });
});
