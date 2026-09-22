/**
 * A chunk the embedder can never accept must be parked, not retried forever.
 *
 * Production shape this reproduces: observed in production where multiple code
 * pages each held exactly one chunk longer than an embedder (such as
 * `ollama:bge-m3`) will accept. The sync pass isolated it and embedded the
 * siblings, which left the page with ONE stale chunk. The catch-up pass then
 * hit `embedPageTexts`'s `texts.length <= 1` bail — rethrow, count a failure,
 * exit non-zero — and the next run did the identical thing with the identical
 * bytes, producing repeated non-actionable alert noise on every scheduled run.
 *
 * The fix has two halves and both are pinned here:
 *   - the cheap half: a chunk over gbrain's own budget never reaches the
 *     provider at all;
 *   - the load-bearing half: when only the provider can tell (its tokenizer is
 *     not ours), its verdict is taken as final, recorded on the page, and not
 *     re-litigated.
 *
 * Serial: uses mock.module, which leaks across files sharing a bun process.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { AITransientError } from '../src/core/ai/errors.ts';

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
// 0.51.6.0 merge: the embed path now reads a guarded projection snapshot and
// installs vectors through `installPageEmbeddings` inside `engine.transaction`
// (upstream #5149). This suite pins the PARKING contract, not the guard, so
// the projection layer is stubbed onto the same tracked mock engine: the
// snapshot is whatever `getChunks` returns and installation is the old
// `upsertChunks` call the assertions below already inspect.
mock.module('../src/core/page-state/projections.ts', () => ({
  readProjectionSnapshot: async (engine: any, slug: string, sourceId: string) => {
    const chunks = await engine.getChunks(slug, { sourceId, includeUnsealed: true });
    if (!chunks) return null;
    const page = (await engine.getPage(slug, { sourceId })) ?? {};
    return {
      snapshot: {
        page: { slug, source_id: sourceId, id: 1, contextual_retrieval_mode: null, ...page },
        revision: 'r1', sourceIncarnation: '1', tags: [], withdrawals: [],
      },
      chunks, indexingContext: 'test-ctx', embeddingModel: 'test:model', maxChunkTokens: 2000,
    };
  },
  installPageEmbeddings: async (engine: any, prepared: any, chunks: any[], signature?: string) => {
    const { slug, source_id: sourceId } = prepared.snapshot.page;
    await engine.upsertChunks(slug, chunks, { sourceId });
    if (signature) await engine.setPageEmbeddingSignature(slug, { sourceId, signature });
    return true;
  },
  installPageProjection: async () => {},
  sealPageTextProjection: async () => {},
  queuePageProjection: async () => {},
  rebuildPendingPageProjections: async () => ({ rebuilt: 0, superseded: 0 }),
}));

const { runEmbedCore } = await import('../src/commands/embed.ts');

// Preflight seam: let diagnoseEmbedding's fast path pass without real env.
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const proxy: any = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop]) return overrides[prop];
      // Guarded installs run inside engine.transaction(fn); the mock has no
      // isolation to offer, so the callback simply sees the same engine.
      if (prop === 'transaction') return (fn: (tx: any) => Promise<any>) => fn(proxy);
      return track(prop);
    },
  });
  return proxy;
}

/** The exact wording Ollama returned on the failing runs. */
const OVER_CONTEXT = 'the input length exceeds the context length';
const overContextError = () => new Error(OVER_CONTEXT);

/** Text past the default 2000-token pre-embed ceiling. */
const HUGE_CHUNK = 'alpha beta gamma delta epsilon '.repeat(2000);

function staleRows(slug: string, chunks: Array<{ chunk_index: number; chunk_text: string }>) {
  return chunks.map(c => ({
    slug, chunk_index: c.chunk_index, chunk_text: c.chunk_text,
    chunk_source: 'compiled_truth' as const, model: null, token_count: 1,
    source_id: 'default', page_id: 1,
  }));
}

function chunkRows(chunks: Array<{ chunk_index: number; chunk_text: string }>) {
  return chunks.map(c => ({
    chunk_index: c.chunk_index, chunk_text: c.chunk_text,
    chunk_source: 'compiled_truth' as const, embedded_at: null, token_count: 1,
  }));
}

beforeEach(() => {
  embedCalls = [];
  embedBatchBehavior = null;
  process.env.GBRAIN_EMBED_CONCURRENCY = '1';
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
});

describe('the provider verdict is taken as final', () => {
  test('--stale: siblings embed, the offender is parked, and the run stays green', async () => {
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good-a' },
      { chunk_index: 1, chunk_text: 'TOO-BIG' },
      { chunk_index: 2, chunk_text: 'good-b' },
    ];
    const upserts: Array<{ slug: string; chunks: any[] }> = [];
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => staleRows('poisoned-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async (slug: string, rows: any[]) => { upserts.push({ slug, chunks: rows }); },
    });

    const result = await runEmbedCore(engine, { stale: true });

    const byIdx = new Map(upserts[0].chunks.map((c: any) => [c.chunk_index, c]));
    expect(byIdx.get(0)!.embedding).toBeInstanceOf(Float32Array);
    expect(byIdx.get(2)!.embedding).toBeInstanceOf(Float32Array);
    expect(byIdx.get(1)!.embedding).toBeUndefined();
    expect(result.embedded).toBe(2);
    // The heart of the fix: an un-embeddable chunk is NOT a failure. Counting
    // it as one is what held the run's exit code red run after run.
    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
    expect(result.parked_samples[0]).toContain('poisoned-page');
  });

  test('--stale: the page is marked embed_skip so it leaves the rotation', async () => {
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [{ chunk_index: 0, chunk_text: 'ok' }, { chunk_index: 1, chunk_text: 'TOO-BIG' }];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('parked-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    await runEmbedCore(engine, { stale: true });

    const marks = (engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip');
    expect(marks).toHaveLength(1);
    expect(marks[0].args[0]).toBe('parked-page');
    expect(marks[0].args[1].marker.reason).toBe('chunk_token_limit');
    expect(marks[0].args[1].marker.bytes).toBe('TOO-BIG'.length);
    expect(typeof marks[0].args[1].marker.assessed_at).toBe('string');
  });

  test('--stale: a page left with ONE over-context chunk parks instead of failing', async () => {
    // The exact catch-up shape from the production log. Pre-fix this hit the
    // `texts.length <= 1` bail: rethrow → recordFailure → exit 1 → repeat
    // tomorrow, unchanged, forever.
    embedBatchBehavior = async () => { throw overContextError(); };
    const chunks = [{ chunk_index: 1, chunk_text: 'TOO-BIG' }];
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => staleRows('catch-up-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
    expect(result.embedded).toBe(0);
    const marks = (engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip');
    expect(marks).toHaveLength(1);
  });

  test('--stale: a partly-parked page is not stamped as fully embedded', async () => {
    // Same reasoning as a partial failure (#3037): the page's chunks are not
    // all in the current embedding space, so claiming that provenance lies.
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [{ chunk_index: 0, chunk_text: 'ok' }, { chunk_index: 1, chunk_text: 'TOO-BIG' }];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('mixed-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    await runEmbedCore(engine, { stale: true });

    const calls = (engine as any)._calls as Array<{ method: string }>;
    expect(calls.filter(c => c.method === 'setPageEmbeddingSignature')).toHaveLength(0);
  });

  test('--all: the same verdict applies on the listPages path', async () => {
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good-a' },
      { chunk_index: 1, chunk_text: 'TOO-BIG' },
    ];
    const engine = mockEngine({
      listPages: async () => [{ slug: 'all-path-page', source_id: 'default' }],
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { all: true });

    expect(result.embedded).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(1);
  });

  test('a dry run neither embeds nor parks', async () => {
    // Parking is a WRITE. A preview that silently marked pages embed_skip
    // would take them out of the embed rotation without being asked, which is
    // the one thing --dry-run promises not to do.
    embedBatchBehavior = async () => { throw overContextError(); };
    const chunks = [{ chunk_index: 0, chunk_text: 'TOO-BIG' }, { chunk_index: 1, chunk_text: HUGE_CHUNK }];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('previewed-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(embedCalls).toHaveLength(0);
    expect(result.parked).toBe(0);
    expect(result.failures).toBe(0);
    const calls = (engine as any)._calls as Array<{ method: string }>;
    expect(calls.filter(c => c.method === 'markEmbedSkip')).toHaveLength(0);
    expect(calls.filter(c => c.method === 'upsertChunks')).toHaveLength(0);
  });

  test('a failed marker write does not turn an otherwise clean run red', async () => {
    // Parking is an optimization on top of the local guard, not the guarantee.
    embedBatchBehavior = async () => { throw overContextError(); };
    const chunks = [{ chunk_index: 0, chunk_text: 'TOO-BIG' }];
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => staleRows('unwritable-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
      markEmbedSkip: async () => { throw new Error('read-only replica'); },
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
  });
});

describe('the local ceiling spends no provider call', () => {
  test('--stale: a chunk over the token cap never reaches the embedder', async () => {
    const chunks = [
      { chunk_index: 0, chunk_text: 'small' },
      { chunk_index: 1, chunk_text: HUGE_CHUNK },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('legacy-chunker-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    // Exactly one call, carrying only the small chunk. Pre-fix the oversized
    // text was sent, rejected, and re-sent on every subsequent run.
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(1);
    expect(embedCalls[0][0]).not.toContain(HUGE_CHUNK);
    expect(result.embedded).toBe(1);
    expect(result.parked).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.parked_samples[0]).toContain('exceeds the 2000-token embed input cap');
  });

  test('--stale: a page whose every chunk is over the cap spends no call at all', async () => {
    const chunks = [{ chunk_index: 0, chunk_text: HUGE_CHUNK }];
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => staleRows('all-oversized-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(embedCalls).toHaveLength(0);
    expect(result.parked).toBe(1);
    expect(result.failures).toBe(0);
  });
});

describe('retryable failures keep their existing treatment', () => {
  test('a transient outage is still a failure, not a parked chunk', async () => {
    // The whole point of the split: "come back later" must not be silenced
    // into "never again". A brain whose embedder was briefly down must still
    // re-embed those chunks on the next run.
    // #3966 (0.50 merge): gateway 502s now go through embedBatchWithBackoff's
    // retry ladder before failing. Shrink the floors and carry a retry hint so
    // the exhaustion path runs in milliseconds, not 5x60s of wall clock.
    const { _setRateLimitFloorsForTests } = await import('../src/commands/embed.ts');
    _setRateLimitFloorsForTests([1, 1, 1, 1, 1]);
    embedBatchBehavior = async () => { throw new AITransientError('upstream 502, try again in 1ms', { status: 502 }); };
    const chunks = [
      { chunk_index: 0, chunk_text: 'a' },
      { chunk_index: 1, chunk_text: 'b' },
      { chunk_index: 2, chunk_text: 'c' },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => staleRows('outage-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.failures).toBe(3);
    expect(result.parked).toBe(0);
    // Still no per-chunk fan-out on a transient error (#3037 cost bounding):
    // every call is the SAME full batch — retries (#3966), not isolation.
    expect(embedCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of embedCalls) expect(call).toHaveLength(3);
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(0);
    _setRateLimitFloorsForTests(null);
  });

  test('a permanent request-shaped 400 still fans out and still counts as a failure', async () => {
    // Not every permanent error means "too long". A malformed input is a
    // failure the operator should see, and the page must not be parked.
    const bad400 = () => Object.assign(new Error('batch contains an invalid input'), { cause: { status: 400 } });
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.length > 1 || texts[0] === 'BAD') throw bad400();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good' },
      { chunk_index: 1, chunk_text: 'BAD' },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('malformed-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.failures).toBe(1);
    expect(result.parked).toBe(0);
    expect(result.embedded).toBe(1);
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(0);
  });
});

describe('batch-boundary parking', () => {
  test('a page straddling the keyset batch boundary defers embed_skip until no embeddable chunk remains', async () => {
    // Repro from the merge review: 3 chunks, batch of 2 — one embeds, one is
    // parked by the pre-guard, the third (healthy) lives in the NEXT batch.
    // Writing the marker in batch 1 would hide the page from stale selection
    // and orphan the healthy chunk unembedded.
    // Provider-parked (not pre-guard): the oversized chunk passes the local
    // cap but the PROVIDER rejects it, so the heal path stays out of the way
    // and the keyset batches stay as listed.
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good-a' },
      { chunk_index: 1, chunk_text: 'TOO-BIG' },
      { chunk_index: 2, chunk_text: 'good-b' },
    ];
    let listCalls = 0;
    const upserts: Array<{ slug: string; chunks: any[] }> = [];
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => {
        listCalls += 1;
        if (listCalls === 1) return staleRows('straddle-page', chunks.slice(0, 2));
        if (listCalls === 2) return staleRows('straddle-page', chunks.slice(2));
        return [];
      },
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async (slug: string, rows: any[]) => { upserts.push({ slug, chunks: rows }); },
      // #4825 provenance stamp probes DB state; report incomplete (chunk 1 is
      // parked, its provenance stays NULL) so no stamp fires.
      executeRaw: async () => [{ complete: false }],
    });

    const result = await runEmbedCore(engine, { stale: true, batchSize: 2 });

    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
    // The healthy chunk from the second batch was embedded, not orphaned.
    const embeddedIdx = upserts.flatMap(u => u.chunks.filter((c: any) => c.embedding).map((c: any) => c.chunk_index));
    expect(embeddedIdx).toContain(2);
    // And the page was NOT hidden from stale selection mid-drain.
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(0);
  });
});

describe('parking verdicts and unresolved failures', () => {
  test('two provider-rejected chunks in different batches still converge on the marker', async () => {
    // c1 parks in batch 1, c3 parks in batch 2. Without the per-drain verdict
    // memory each batch would treat the OTHER parked chunk as "still
    // embeddable" and the marker would never be written in any run.
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.some(x => x.startsWith('TOO-BIG'))) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good-a' },
      { chunk_index: 1, chunk_text: 'TOO-BIG-1' },
      { chunk_index: 2, chunk_text: 'good-b' },
      { chunk_index: 3, chunk_text: 'TOO-BIG-2' },
    ];
    let listCalls = 0;
    const embeddedIdx = new Set<number>();
    const engine = mockEngine({
      countStaleChunks: async () => 4,
      listStaleChunks: async () => {
        listCalls += 1;
        if (listCalls === 1) return staleRows('two-verdicts-page', chunks.slice(0, 2));
        if (listCalls === 2) return staleRows('two-verdicts-page', chunks.slice(2));
        return [];
      },
      // Stateful: chunks embedded by an earlier batch show their vector, the
      // way the real engine would.
      getChunks: async () => chunkRows(chunks).map(c => ({
        ...c,
        embedding: embeddedIdx.has(c.chunk_index) ? new Float32Array(1536) : null,
      })),
      upsertChunks: async (_slug: string, rows: any[]) => {
        for (const r of rows) if (r.embedding) embeddedIdx.add(r.chunk_index);
      },
      executeRaw: async () => [{ complete: false }],
    });

    const result = await runEmbedCore(engine, { stale: true, batchSize: 2 });

    expect(result.failures).toBe(0);
    expect(result.parked).toBe(2);
    // Batch 2 knows batch 1's verdict — nothing embeddable remains, so the
    // page IS parked (exactly once).
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(1);
  });

  test('a transiently-failed sibling in the same batch defers the marker', async () => {
    // One over-context chunk + one transient 500 in one page/batch: the page
    // must stay visible to the next stale run so the failure can retry.
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.length > 1) throw overContextError(); // force isolation
      if (texts[0] === 'TOO-BIG') throw overContextError();
      if (texts[0] === 'FLAKY') { const e: any = new Error('boom'); e.cause = { status: 500 }; throw e; }
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'TOO-BIG' },
      { chunk_index: 1, chunk_text: 'FLAKY' },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: (() => { let done = false; return async () => {
        if (done) return []; done = true; return staleRows('flaky-sibling-page', chunks);
      }; })(),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
      executeRaw: async () => [{ complete: false }],
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.parked).toBe(1);
    expect(result.failures).toBe(1);
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(0);
  });

  test('a stamped row with a NULL vector still counts as embeddable (schema-restore shape)', async () => {
    // c2 has embedded_at set but no vector — the active-vector check must
    // treat it as pending work and defer the marker.
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good-a' },
      { chunk_index: 1, chunk_text: 'TOO-BIG' },
    ];
    const restoreShaped = { chunk_index: 2, chunk_text: 'restored', chunk_source: 'compiled_truth' as const, embedded_at: new Date(), embedding: null, token_count: 1 };
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: (() => { let done = false; return async () => {
        if (done) return []; done = true; return staleRows('restore-page', chunks);
      }; })(),
      getChunks: async () => [...chunkRows(chunks), restoreShaped],
      upsertChunks: async () => {},
      executeRaw: async () => [{ complete: false }],
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.parked).toBe(1);
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(0);
  });
});
