/**
 * Embed failure quarantine (--stale path).
 *
 * Why: a page whose embed fails is only logged; its chunks stay NULL, so
 * every autopilot cycle re-sends the exact same doomed request forever.
 * Against a serial local embedding server (ollama `-np 1`) that keeps
 * computing client-aborted requests, this self-sustains into a congestion
 * collapse (observed 2026-07-29/30: 6,900+ timeouts, pages retried 29×,
 * ~4 CPU cores pinned for days). The quarantine gives the loop a give-up
 * point: after N consecutive failed attempts in one process, the page is
 * skipped until the process restarts (or the operator sets
 * frontmatter.embed_skip permanently).
 *
 * Coverage:
 *  - page failing GBRAIN_EMBED_QUARANTINE_AFTER (default 3) consecutive
 *    runs is skipped on the next run
 *  - a success resets the counter (transient blips never quarantine)
 *  - the threshold is operator-tunable via env
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

let totalPoisonCalls = 0;
let embedShouldFail = true;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    if (texts.some(t => t.includes('POISON'))) {
      totalPoisonCalls++;
      if (embedShouldFail) throw new Error('[embed(ollama:nomic-embed-text)] The operation timed out.');
    }
    return texts.map(() => new Float32Array(1536));
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));

const { runEmbed, _resetEmbedQuarantineForTest } = await import('../src/commands/embed.ts');

const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop]) return overrides[prop];
      return track(prop);
    },
  });
  return engine;
}

const POISON_ROWS = [
  { page_id: 1, chunk_index: 0, source_id: 'default', slug: 'poison', chunk_text: 'POISON chunk one', token_count: 4 },
  { page_id: 1, chunk_index: 1, source_id: 'default', slug: 'poison', chunk_text: 'POISON chunk two', token_count: 4 },
];

function poisonEngine(): BrainEngine {
  return mockEngine({
    countStaleChunks: async () => POISON_ROWS.length,
    listStaleChunks: async (opts: { afterPageId: number }) =>
      opts.afterPageId === 0 ? POISON_ROWS : [],
    invalidateStaleSignatureEmbeddings: async () => 0,
    getChunks: async () => POISON_ROWS.map(r => ({
      chunk_index: r.chunk_index, chunk_text: r.chunk_text,
      chunk_source: 'compiled_truth', token_count: r.token_count,
    })),
    upsertChunks: async () => {},
    setPageEmbeddingSignature: async () => {},
  });
}

beforeEach(() => {
  totalPoisonCalls = 0;
  embedShouldFail = true;
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
      await runEmbed(engine, ['--stale']);
      expect(totalPoisonCalls).toBe(run); // one attempt per run, no more
    }

    await runEmbed(engine, ['--stale']);
    // Quarantined: run 4 must NOT send the doomed page to the provider.
    expect(totalPoisonCalls).toBe(3);
  });

  test('a success resets the failure counter', async () => {
    const engine = poisonEngine();

    await runEmbed(engine, ['--stale']); // fail #1
    await runEmbed(engine, ['--stale']); // fail #2
    embedShouldFail = false;
    await runEmbed(engine, ['--stale']); // success → counter resets
    embedShouldFail = true;
    await runEmbed(engine, ['--stale']); // fail #1 (fresh count)
    // Without reset the page would already be quarantined here (3 cumulative
    // failures) and this run would add no call. With reset it must attempt.
    expect(totalPoisonCalls).toBe(4);

    await runEmbed(engine, ['--stale']); // fail #2
    await runEmbed(engine, ['--stale']); // fail #3 → quarantine
    await runEmbed(engine, ['--stale']); // skipped
    expect(totalPoisonCalls).toBe(6);
  });

  test('threshold is tunable via GBRAIN_EMBED_QUARANTINE_AFTER', async () => {
    process.env.GBRAIN_EMBED_QUARANTINE_AFTER = '1';
    const engine = poisonEngine();

    await runEmbed(engine, ['--stale']); // fail #1 → quarantine immediately
    await runEmbed(engine, ['--stale']); // skipped
    expect(totalPoisonCalls).toBe(1);
  });
});
