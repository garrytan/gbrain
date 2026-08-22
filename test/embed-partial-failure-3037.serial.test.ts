/**
 * #3037 — one oversized/bad chunk must not darken its ENTIRE page, and embed
 * failures must be visible on the run result.
 *
 * Pre-fix, all three embed paths sent a page's chunks in ONE embedBatch call
 * inside a try whose catch only logged to stderr: when the batch threw,
 * upsertChunks never ran, so EVERY sibling chunk stayed NULL (~8.6x blast
 * radius from a single bad chunk), and EmbedResult had no failure field —
 * `gbrain embed` exited 0 on a total no-op.
 *
 * Pinned here:
 *   1. --stale and --all: a page with ONE bad chunk still embeds its other
 *      chunks (per-chunk isolation via embedPageTexts), failures are counted
 *      on result.failures, and the embedding signature is NOT stamped for a
 *      partially-failed page.
 *   2. Cost bounding: a 429 (rate limit) does NOT fan out into N
 *      single-chunk calls, and neither does an AITransientError (outage) —
 *      isolation only fires for permanent request-shaped failures.
 *
 * Serial: uses mock.module (leaks across files sharing a bun process).
 * The CLI exit-code half of #3037 is pinned by
 * test/embed-exit-code-3037.serial.test.ts (real spawned CLI).
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { AITransientError } from '../src/core/ai/errors.ts';

// Track every embedBatch call's shape so tests can assert batch-vs-single
// fan-out behavior.
let embedCalls: string[][] = [];
let embedBatchBehavior: ((texts: string[], opts?: unknown) => Promise<Float32Array[]>) | null = null;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[], opts?: unknown) => {
    embedCalls.push([...texts]);
    if (embedBatchBehavior) return embedBatchBehavior(texts, opts);
    return texts.map(() => new Float32Array(1536));
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));

// Import AFTER mocking.
const { runEmbedCore } = await import('../src/commands/embed.ts');

// Preflight seam (same as test/embed.serial.test.ts): make
// diagnoseEmbedding's fast-path pass without real env vars.
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

/** Permanent 400-shaped batch failure (e.g. one oversized chunk). */
function permanentBatchError(): Error {
  const err = new Error('batch contains an invalid input');
  (err as any).cause = { status: 400 };
  return err;
}

beforeEach(() => {
  embedCalls = [];
  embedBatchBehavior = null;
  process.env.GBRAIN_EMBED_CONCURRENCY = '1';
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
});

// Behavior: the whole-page batch 400s; retried per-chunk, only 'BAD' fails.
function oneBadChunkBehavior() {
  embedBatchBehavior = async (texts: string[]) => {
    if (texts.length > 1) throw permanentBatchError();
    if (texts[0] === 'BAD') throw permanentBatchError();
    return texts.map(() => new Float32Array(1536));
  };
}

const THREE_CHUNKS = [
  { chunk_index: 0, chunk_text: 'good-a', chunk_source: 'compiled_truth' as const, embedded_at: null, token_count: 1 },
  { chunk_index: 1, chunk_text: 'BAD', chunk_source: 'compiled_truth' as const, embedded_at: null, token_count: 1 },
  { chunk_index: 2, chunk_text: 'good-b', chunk_source: 'compiled_truth' as const, embedded_at: null, token_count: 1 },
];

describe('#3037 — one bad chunk no longer darkens its page', () => {
  test('--stale: siblings of one bad chunk get embedded; failure counted; signature not stamped', async () => {
    oneBadChunkBehavior();
    const stale = THREE_CHUNKS.map(c => ({
      slug: 'poisoned-page', chunk_index: c.chunk_index, chunk_text: c.chunk_text,
      chunk_source: c.chunk_source, model: null, token_count: 1, source_id: 'default', page_id: 1,
    }));
    const upsertCalls: Array<{ slug: string; chunks: any[] }> = [];
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => stale,
      getChunks: async () => THREE_CHUNKS,
      upsertChunks: async (slug: string, chunks: any[]) => { upsertCalls.push({ slug, chunks }); },
    });

    const result = await runEmbedCore(engine, { stale: true });

    // Pre-fix: the batch threw, upsertChunks never ran, embedded stayed 0.
    expect(upsertCalls).toHaveLength(1);
    const byIdx = new Map(upsertCalls[0].chunks.map((c: any) => [c.chunk_index, c]));
    expect(byIdx.get(0)!.embedding).toBeInstanceOf(Float32Array);
    expect(byIdx.get(2)!.embedding).toBeInstanceOf(Float32Array);
    expect(byIdx.get(1)!.embedding).toBeUndefined(); // bad chunk stays NULL (re-run picks it up)
    expect(result.embedded).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.failure_samples).toHaveLength(1);
    expect(result.failure_samples[0]).toContain('poisoned-page');
    // Partially-failed page must NOT be stamped as current provenance.
    const stamps = (engine as any)._calls.filter((c: any) => c.method === 'setPageEmbeddingSignature');
    expect(stamps).toHaveLength(0);
  });

  test('--all: same isolation on the listPages path', async () => {
    oneBadChunkBehavior();
    const upsertCalls: Array<{ slug: string; chunks: any[] }> = [];
    const engine = mockEngine({
      listPages: async () => [{ slug: 'poisoned-page', source_id: 'default' }],
      getChunks: async () => THREE_CHUNKS,
      upsertChunks: async (slug: string, chunks: any[]) => { upsertCalls.push({ slug, chunks }); },
    });

    const result = await runEmbedCore(engine, { all: true });

    expect(upsertCalls).toHaveLength(1);
    const byIdx = new Map(upsertCalls[0].chunks.map((c: any) => [c.chunk_index, c]));
    expect(byIdx.get(0)!.embedding).toBeInstanceOf(Float32Array);
    expect(byIdx.get(1)!.embedding).toBeUndefined();
    expect(result.embedded).toBe(2);
    expect(result.failures).toBe(1);
    const stamps = (engine as any)._calls.filter((c: any) => c.method === 'setPageEmbeddingSignature');
    expect(stamps).toHaveLength(0);
  });

  test('--stale x #3507: fan-out retries the WRAPPED texts and a partially-failed page is not restamped', async () => {
    // Composition pin for the #3037 + #3538 merge: the per-chunk isolation
    // retry must re-send the contextually WRAPPED text (raw chunk_text here
    // would silently strip prefixes on exactly the pages that hit an error),
    // and restampIfDemotedToTitleTier must NOT fire when isolation left
    // chunks NULL (the page was not fully re-embedded — restamping would
    // make contextual_retrieval_mode lie again, the exact #3461 bug).
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.length > 1) throw permanentBatchError();
      if (texts[0].includes('BAD')) throw permanentBatchError();
      return texts.map(() => new Float32Array(1536));
    };
    const stale = THREE_CHUNKS.map(c => ({
      slug: 'wrapped-page', chunk_index: c.chunk_index, chunk_text: c.chunk_text,
      chunk_source: c.chunk_source, model: null, token_count: 1, source_id: 'default', page_id: 1,
    }));
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => stale,
      getPage: async () => ({
        slug: 'wrapped-page', title: 'My Title', compiled_truth: 'x', timeline: '',
        source_id: 'default', contextual_retrieval_mode: 'per_chunk_synopsis',
      }),
      getChunks: async () => THREE_CHUNKS,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    // Every embed call — the failed batch AND each single-chunk retry —
    // carries the stored-mode contextual prefix (fenced_code exemption is
    // pinned upstream in test/embedding-context.test.ts).
    expect(embedCalls.length).toBeGreaterThan(1);
    for (const call of embedCalls) {
      for (const text of call) expect(text).toStartWith('<context>My Title\n</context>\n');
    }
    expect(result.embedded).toBe(2);
    expect(result.failures).toBe(1);
    // Partially-failed page: neither signature-stamped nor CR-restamped.
    const calls = (engine as any)._calls as Array<{ method: string }>;
    expect(calls.filter(c => c.method === 'setPageEmbeddingSignature')).toHaveLength(0);
    expect(calls.filter(c => c.method === 'updatePageContextualRetrievalState')).toHaveLength(0);
  });

  test('--stale: a fully-failed page is counted on result.failures (no more silent no-op)', async () => {
    embedBatchBehavior = async () => { throw permanentBatchError(); };
    const stale = THREE_CHUNKS.map(c => ({
      slug: 'dark-page', chunk_index: c.chunk_index, chunk_text: c.chunk_text,
      chunk_source: c.chunk_source, model: null, token_count: 1, source_id: 'default', page_id: 1,
    }));
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => stale,
      getChunks: async () => THREE_CHUNKS,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.embedded).toBe(0);
    expect(result.failures).toBe(3);
    expect(result.failure_samples[0]).toContain('dark-page');
  });
});

describe('#3037 — cost bounding: no per-chunk fan-out on transient failures', () => {
  // #3796: sustained-429 exhaustion now deliberately spans a rolling TPM
  // minute (~120s of floors); shrink the ladder so these tests stay fast
  // while still exercising every retry.
  beforeEach(async () => {
    const { _setRateLimitFloorsForTests } = await import('../src/commands/embed.ts');
    _setRateLimitFloorsForTests([1, 1, 1, 1, 1]);
  });
  afterEach(async () => {
    const { _setRateLimitFloorsForTests } = await import('../src/commands/embed.ts');
    _setRateLimitFloorsForTests(null);
  });

  test('sustained 429 does not fan out into single-chunk calls', async () => {
    embedBatchBehavior = async () => {
      const err = new Error('Rate limit reached. Please try again in 0ms.');
      (err as any).cause = { status: 429 };
      throw err;
    };
    const stale = THREE_CHUNKS.map(c => ({
      slug: 'rate-limited-page', chunk_index: c.chunk_index, chunk_text: c.chunk_text,
      chunk_source: c.chunk_source, model: null, token_count: 1, source_id: 'default', page_id: 1,
    }));
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => stale,
      getChunks: async () => THREE_CHUNKS,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    // Every call must be the full 3-text batch: embedBatchWithBackoff's own
    // retries (initial + MAX_RATE_LIMIT_RETRIES), never a 1-text isolation call
    // hammering the limiter.
    expect(embedCalls.length).toBeGreaterThan(1);
    for (const call of embedCalls) expect(call).toHaveLength(3);
    expect(result.embedded).toBe(0);
    expect(result.failures).toBe(3);
  }, 30_000);

  test('sustained 502 retries batch but does not fan out per-chunk (#3966)', async () => {
    embedBatchBehavior = async () => {
      const err = new Error('Bad Gateway — try again in 0ms.');
      (err as any).cause = { status: 502 };
      throw err;
    };
    const stale = THREE_CHUNKS.map(c => ({
      slug: 'outage-page', chunk_index: c.chunk_index, chunk_text: c.chunk_text,
      chunk_source: c.chunk_source, model: null, token_count: 1, source_id: 'default', page_id: 1,
    }));
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => stale,
      getChunks: async () => THREE_CHUNKS,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    // 502 → embedBatchWithBackoff retries the full batch; never 1-text isolation.
    expect(embedCalls.length).toBeGreaterThan(1);
    for (const call of embedCalls) expect(call).toHaveLength(3);
    expect(result.embedded).toBe(0);
    expect(result.failures).toBe(3);
  }, 30_000);
});
