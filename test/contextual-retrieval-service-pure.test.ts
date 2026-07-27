/**
 * Pure-function tests for src/core/contextual-retrieval-service.ts.
 *
 * This file pins the service's pure helpers plus hermetic service behavior
 * driven through fake engine + gateway seams. Full PGLite coverage lives in
 * test/e2e/contextual-retrieval-pglite.test.ts.
 */

import { afterEach, describe, test, expect } from 'bun:test';
import {
  computeCorpusGeneration,
  computeSourceTextHash,
  expectedModeForPageSourceOnly,
  reembedPageWithContextualRetrieval,
  resolveContextualChunkConcurrency,
  TITLE_WRAPPER_VERSION,
} from '../src/core/contextual-retrieval-service.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

const TEST_DIMS = 1536;

afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('computeCorpusGeneration', () => {
  test('returns 16-char hex hash', () => {
    const h = computeCorpusGeneration({
      crMode: 'title',
      haikuModel: 'anthropic:claude-haiku-4-5-20251001',
    });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test('deterministic for same inputs', () => {
    const h1 = computeCorpusGeneration({
      crMode: 'per_chunk_synopsis',
      haikuModel: 'anthropic:claude-haiku-4-5-20251001',
    });
    const h2 = computeCorpusGeneration({
      crMode: 'per_chunk_synopsis',
      haikuModel: 'anthropic:claude-haiku-4-5-20251001',
    });
    expect(h1).toBe(h2);
  });

  test('different mode → different hash', () => {
    const haikuModel = 'anthropic:claude-haiku-4-5-20251001';
    const a = computeCorpusGeneration({ crMode: 'title', haikuModel });
    const b = computeCorpusGeneration({ crMode: 'per_chunk_synopsis', haikuModel });
    const c = computeCorpusGeneration({ crMode: 'none', haikuModel });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  test('different model → different hash', () => {
    const a = computeCorpusGeneration({
      crMode: 'title',
      haikuModel: 'anthropic:claude-haiku-4-5-20251001',
    });
    const b = computeCorpusGeneration({
      crMode: 'title',
      haikuModel: 'anthropic:claude-haiku-future-model',
    });
    expect(a).not.toBe(b);
  });

  test('TITLE_WRAPPER_VERSION is stable across reads', () => {
    // Bump this constant only when changing the wrapper text shape.
    // The hash composition includes it so a future change invalidates
    // prior cache entries.
    expect(TITLE_WRAPPER_VERSION).toBe(1);
  });
});

describe('computeSourceTextHash', () => {
  test('returns 16-char hex', () => {
    expect(computeSourceTextHash('any text')).toMatch(/^[0-9a-f]{16}$/);
  });

  test('deterministic', () => {
    const a = computeSourceTextHash('source text');
    const b = computeSourceTextHash('source text');
    expect(a).toBe(b);
  });

  test('different text → different hash (D27 P1-4 cache invalidation)', () => {
    const a = computeSourceTextHash('original page body');
    const b = computeSourceTextHash('edited page body');
    expect(a).not.toBe(b);
  });

  test('empty input still produces a hash', () => {
    expect(computeSourceTextHash('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('expectedModeForPageSourceOnly (T9 reindex sweep helper)', () => {
  test('kill switch returns none regardless of source/global', () => {
    expect(
      expectedModeForPageSourceOnly({
        source: { id: 'default', contextual_retrieval_mode: 'per_chunk_synopsis' },
        globalMode: 'per_chunk_synopsis',
        killSwitchDisabled: true,
      }),
    ).toBe('none');
  });

  test('source override beats global when set', () => {
    expect(
      expectedModeForPageSourceOnly({
        source: { id: 'team', contextual_retrieval_mode: 'title' },
        globalMode: 'per_chunk_synopsis',
      }),
    ).toBe('title');
  });

  test('global wins when source override is null', () => {
    expect(
      expectedModeForPageSourceOnly({
        source: { id: 'team', contextual_retrieval_mode: null },
        globalMode: 'per_chunk_synopsis',
      }),
    ).toBe('per_chunk_synopsis');
  });

  test('invalid source override (typo) falls through to global', () => {
    expect(
      expectedModeForPageSourceOnly({
        source: { id: 'team', contextual_retrieval_mode: 'per_chunk' as string },
        globalMode: 'title',
      }),
    ).toBe('title');
  });

  test('all three CR modes round-trip through source override', () => {
    for (const mode of ['none', 'title', 'per_chunk_synopsis'] as const) {
      expect(
        expectedModeForPageSourceOnly({
          source: { id: 'team', contextual_retrieval_mode: mode },
          globalMode: 'none',
        }),
      ).toBe(mode);
    }
  });
});

describe('resolveContextualChunkConcurrency', () => {
  test('defaults to 4 and reads the process env', async () => {
    await withEnv({ GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY: undefined }, async () => {
      expect(resolveContextualChunkConcurrency()).toBe(4);
    });
    await withEnv({ GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY: '7' }, async () => {
      expect(resolveContextualChunkConcurrency()).toBe(7);
    });
  });

  test('clamps to [1, 16] and ignores invalid values', () => {
    expect(resolveContextualChunkConcurrency({
      GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY: '0',
    })).toBe(1);
    expect(resolveContextualChunkConcurrency({
      GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY: '-3',
    })).toBe(1);
    expect(resolveContextualChunkConcurrency({
      GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY: '99',
    })).toBe(16);
    expect(resolveContextualChunkConcurrency({
      GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY: '1.9',
    })).toBe(1);
    expect(resolveContextualChunkConcurrency({
      GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY: 'not-a-number',
    })).toBe(4);
  });
});

describe('per-chunk synopsis concurrency', () => {
  test('concurrency > 1 preserves chunk-order embed input', async () => {
    const chunks = makeChunks(['alpha', 'beta', 'gamma', 'delta']);
    const delays: Record<string, number> = { alpha: 30, beta: 5, gamma: 20, delta: 1 };
    const sequential = await runWithChatStub({
      chunks,
      concurrency: 1,
      delayForChunk: (chunk) => delays[chunk] ?? 1,
    });
    const parallel = await runWithChatStub({
      chunks,
      concurrency: 4,
      delayForChunk: (chunk) => delays[chunk] ?? 1,
    });

    expect(parallel.result.kind).toBe('success');
    expect(parallel.embedInputs).toEqual(sequential.embedInputs);
    expect(parallel.embeddedChunks.map((c) => c.chunk_text)).toEqual(
      chunks.map((c) => c.chunk_text),
    );
  });

  test('concurrency is bounded', async () => {
    let active = 0;
    let maxActive = 0;
    let leaseActive = 0;
    let maxLeaseActive = 0;
    let acquired = 0;
    let released = 0;
    const chunks = makeChunks(Array.from({ length: 8 }, (_, i) => `chunk-${i}`));
    const out = await runWithChatStub({
      chunks,
      concurrency: 3,
      acquireSynopsisLease: async () => {
        acquired++;
        leaseActive++;
        maxLeaseActive = Math.max(maxLeaseActive, leaseActive);
        return acquired;
      },
      releaseSynopsisLease: async () => {
        released++;
        leaseActive--;
      },
      chat: async (opts) => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await delay(20, opts.abortSignal);
          return chatSuccess(`Synopsis for ${extractChunk(opts)}`);
        } finally {
          active--;
        }
      },
    });

    expect(out.result.kind).toBe('success');
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxLeaseActive).toBeLessThanOrEqual(3);
    expect(acquired).toBe(8);
    expect(released).toBe(8);
    expect(leaseActive).toBe(0);
  });

  test('one chunk failure aborts queued work and falls back at page level', async () => {
    let started = 0;
    const chunks = makeChunks(Array.from({ length: 9 }, (_, i) => `chunk-${i}`));
    const out = await runWithChatStub({
      chunks,
      concurrency: 3,
      chat: async (opts) => {
        started++;
        const chunk = extractChunk(opts);
        if (chunk === 'chunk-0') return chatSuccess('');
        await delay(30, opts.abortSignal);
        return chatSuccess(`Synopsis for ${chunk}`);
      },
    });

    expect(out.result.kind).toBe('page_fallback');
    expect(started).toBeLessThanOrEqual(3);
  });

  test('fenced code chunks bypass synopsis calls and leases', async () => {
    let chatCalls = 0;
    let leaseCalls = 0;
    const chunks: ChunkInput[] = [
      { chunk_index: 0, chunk_text: 'intro', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'const x = 1;', chunk_source: 'fenced_code' },
      { chunk_index: 2, chunk_text: 'outro', chunk_source: 'compiled_truth' },
    ];

    const out = await runWithChatStub({
      chunks,
      concurrency: 3,
      acquireSynopsisLease: async () => {
        leaseCalls++;
      },
      releaseSynopsisLease: async () => {},
      chat: async (opts) => {
        chatCalls++;
        return chatSuccess(`Synopsis for ${extractChunk(opts)}`);
      },
    });

    expect(out.result.kind).toBe('success');
    expect(chatCalls).toBe(2);
    expect(leaseCalls).toBe(2);
    expect(out.embedInputs[1]).toBe('const x = 1;');
  });

  test('abortSignal cancels in-flight and queued synopsis work promptly', async () => {
    const controller = new AbortController();
    let started = 0;
    const chunks = makeChunks(Array.from({ length: 20 }, (_, i) => `chunk-${i}`));
    const startedAt = Date.now();
    const promise = runWithChatStub({
      chunks,
      concurrency: 4,
      abortSignal: controller.signal,
      chat: async (opts) => {
        started++;
        await delay(1000, opts.abortSignal);
        return chatSuccess(`Synopsis for ${extractChunk(opts)}`);
      },
    });
    setTimeout(() => controller.abort(), 20);

    const out = await promise;
    expect(out.result.kind).toBe('transient_error');
    if (out.result.kind === 'transient_error') {
      expect(out.result.cause).toBe('timeout');
    }
    expect(started).toBeLessThanOrEqual(4);
    expect(Date.now() - startedAt).toBeLessThan(300);
  });
});

function makeChunks(texts: string[]): ChunkInput[] {
  return texts.map((text, i) => ({
    chunk_index: i,
    chunk_text: text,
    chunk_source: 'compiled_truth',
  }));
}

async function runWithChatStub(opts: {
  chunks: ChunkInput[];
  concurrency: number;
  abortSignal?: AbortSignal;
  delayForChunk?: (chunk: string) => number;
  chat?: (opts: ChatOpts) => Promise<ChatResult>;
  acquireSynopsisLease?: () => Promise<unknown>;
  releaseSynopsisLease?: (lease?: unknown) => Promise<void>;
}) {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: TEST_DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });

  const embedInputs: string[][] = [];
  __setEmbedTransportForTests(async ({ values }: any) => {
    embedInputs.push([...values]);
    return {
      embeddings: values.map((_: string, i: number) =>
        Array.from({ length: TEST_DIMS }, () => 0.001 + i * 0.001),
      ),
      usage: { tokens: 0 },
    } as any;
  });

  __setChatTransportForTests(opts.chat ?? (async (chatOpts) => {
    const chunk = extractChunk(chatOpts);
    await delay(opts.delayForChunk?.(chunk) ?? 1, chatOpts.abortSignal);
    return chatSuccess(`Synopsis for ${chunk}`);
  }));

  const engine = makeServiceEngine(opts.chunks);
  const result = await reembedPageWithContextualRetrieval({
    engine,
    pageSlug: 'wiki/concepts/concurrency-test',
    sourceId: 'default',
    globalMode: 'per_chunk_synopsis',
    chunkConcurrency: opts.concurrency,
    abortSignal: opts.abortSignal,
    ...(opts.acquireSynopsisLease && { acquireSynopsisLease: opts.acquireSynopsisLease }),
    ...(opts.releaseSynopsisLease && { releaseSynopsisLease: opts.releaseSynopsisLease }),
  });

  return {
    result,
    embedInputs: embedInputs.flat(),
    embeddedChunks: engine.embeddedChunks as ChunkInput[],
  };
}

function makeServiceEngine(chunks: ChunkInput[]) {
  const engine: any = {
    embeddedChunks: [] as ChunkInput[],
    async getPage() {
      return {
        id: 1,
        slug: 'wiki/concepts/concurrency-test',
        source_id: 'default',
        type: 'concept',
        title: 'Concurrency Test',
        compiled_truth: chunks.map((c) => c.chunk_text).join('\n\n'),
        timeline: '',
        frontmatter: {},
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        deleted_at: null,
      };
    },
    async executeRaw() {
      return [{
        id: 'default',
        name: 'Default',
        local_path: null,
        last_commit: null,
        last_sync_at: null,
        config: {},
        created_at: new Date('2026-01-01T00:00:00Z'),
        contextual_retrieval_mode: null,
        trust_frontmatter_overrides: false,
      }];
    },
    async getChunks() {
      return chunks;
    },
    async transaction(fn: (tx: any) => Promise<void>) {
      await fn({
        upsertChunks: async (_slug: string, embedded: ChunkInput[]) => {
          engine.embeddedChunks = embedded;
        },
        updatePageContextualRetrievalState: async () => {},
      });
    },
    async updatePageContextualRetrievalState() {},
  };
  return engine;
}

function extractChunk(opts: ChatOpts): string {
  const content = String(opts.messages[0]?.content ?? '');
  return content.match(/<chunk>\n([\s\S]*?)\n<\/chunk>/)?.[1] ?? '';
}

function chatSuccess(text: string): ChatResult {
  return {
    text,
    blocks: [],
    stopReason: 'end',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: 'stub:chat',
    providerId: 'stub',
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
