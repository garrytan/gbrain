import { describe, expect, test } from 'bun:test';
import { runEmbed } from '../src/commands/embed.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from '../src/core/embedding.ts';
import { createEmbeddingQueue } from '../src/core/embedding-queue.ts';
import type { ResolvedEmbeddingProvider } from '../src/core/embedding/provider.ts';
import type { Chunk, ChunkInput, Page } from '../src/core/types.ts';

describe('embedding queue', () => {
  test('batches chunks across submissions while preserving each submission order and source', async () => {
    const fake = createFakeProvider();
    const queue = createEmbeddingQueue({ provider: fake.provider, autoFlush: false });

    const first = queue.submit([
      chunkInput(0, 'alpha', 'compiled_truth'),
      chunkInput(1, 'beta', 'timeline'),
    ]);
    const second = queue.submit([
      chunkInput(0, 'gamma', 'frontmatter'),
    ]);

    await queue.flush();

    await expect(first).resolves.toMatchObject({
      deferred: false,
      chunks: [
        { chunk_text: 'alpha', chunk_source: 'compiled_truth', model: 'test-local-v1', token_count: 2 },
        { chunk_text: 'beta', chunk_source: 'timeline', model: 'test-local-v1', token_count: 1 },
      ],
    });
    await expect(second).resolves.toMatchObject({
      deferred: false,
      chunks: [
        { chunk_text: 'gamma', chunk_source: 'frontmatter', model: 'test-local-v1', token_count: 2 },
      ],
    });
    expect(fake.batches).toEqual([['alpha', 'beta', 'gamma']]);
    expect((await first).chunks.map(chunk => Array.from(chunk.embedding ?? []))).toEqual([[5, 0, 0], [4, 0, 1]]);
    expect((await second).chunks.map(chunk => Array.from(chunk.embedding ?? []))).toEqual([[5, 0, 2]]);
  });

  test('flushes provider calls at 100 chunks by default', async () => {
    const fake = createFakeProvider();
    const queue = createEmbeddingQueue({ provider: fake.provider, autoFlush: false });
    const chunks = Array.from({ length: 101 }, (_, index) => chunkInput(index, `chunk-${index}`));

    const submitted = queue.submit(chunks);
    await queue.flush();
    const result = await submitted;

    expect(fake.batches.map(batch => batch.length)).toEqual([100, 1]);
    expect(result.chunks.map(chunk => chunk.chunk_text)).toEqual(chunks.map(chunk => chunk.chunk_text));
    expect(result.chunks.map(chunk => Array.from(chunk.embedding ?? [])[0])).toEqual(
      chunks.map(chunk => chunk.chunk_text.length),
    );
  });

  test('autoFlush schedules a provider call by default', async () => {
    const fake = createFakeProvider();
    const queue = createEmbeddingQueue({ provider: fake.provider });

    const result = await queue.submit([chunkInput(0, 'auto chunk')]);

    expect(fake.batches).toEqual([['auto chunk']]);
    expect(result.chunks[0]?.embedding).toEqual(new Float32Array([10, 0, 0]));
  });

  test('preserves result order when concurrent batches finish out of order', async () => {
    const fake = createFakeProvider({
      delayForTexts: async (texts) => {
        await sleep(texts[0] === 'chunk-0' ? 25 : 0);
      },
    });
    const queue = createEmbeddingQueue({
      provider: fake.provider,
      autoFlush: false,
      batchSize: 1,
      concurrency: 3,
    });

    const submitted = queue.submit([
      chunkInput(0, 'chunk-0'),
      chunkInput(1, 'chunk-1'),
      chunkInput(2, 'chunk-2'),
    ]);

    await queue.flush();

    expect((await submitted).chunks.map(chunk => chunk.chunk_text)).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);
    expect((await submitted).chunks.map(chunk => Array.from(chunk.embedding ?? [])[0])).toEqual([7, 7, 7]);
  });

  test('caps concurrent provider calls', async () => {
    const fake = createFakeProvider({
      delayForTexts: async () => {
        await sleep(10);
      },
    });
    const queue = createEmbeddingQueue({
      provider: fake.provider,
      autoFlush: false,
      batchSize: 1,
      concurrency: 2,
    });

    const submitted = queue.submit(
      Array.from({ length: 5 }, (_, index) => chunkInput(index, `chunk-${index}`)),
    );
    await queue.flush();
    await submitted;

    expect(fake.maxActive).toBe(2);
    expect(fake.batches).toHaveLength(5);
  });

  test('reports batch progress from per-iteration snapshots under concurrency', async () => {
    const fake = createFakeProvider({
      delayForTexts: async (texts) => {
        await sleep(texts[0] === 'chunk-0' ? 10 : 0);
      },
    });
    const starts: Array<{ batchIndex: number; completed: number; batchSize: number }> = [];
    const completes: Array<{ batchIndex: number; completed: number; batchSize: number }> = [];
    const queue = createEmbeddingQueue({
      provider: fake.provider,
      autoFlush: false,
      batchSize: 1,
      concurrency: 2,
      onBatchStart: (progress) => starts.push({
        batchIndex: progress.batchIndex,
        completed: progress.completed,
        batchSize: progress.batchSize,
      }),
      onBatchComplete: (progress) => completes.push({
        batchIndex: progress.batchIndex,
        completed: progress.completed,
        batchSize: progress.batchSize,
      }),
    });

    const submitted = queue.submit(
      Array.from({ length: 3 }, (_, index) => chunkInput(index, `chunk-${index}`)),
    );
    await queue.flush();
    await submitted;

    expect(starts).toHaveLength(3);
    expect(completes).toHaveLength(3);
    for (const complete of completes) {
      const start = starts.find(entry => entry.batchIndex === complete.batchIndex);
      expect(start).toBeDefined();
      expect(complete.completed).toBeGreaterThanOrEqual((start?.completed ?? 0) + complete.batchSize);
      expect(complete.completed).toBeLessThanOrEqual(3);
    }
    expect(Math.max(...completes.map(progress => progress.completed))).toBe(3);
  });

  test('rejects only submissions affected by provider errors', async () => {
    const fake = createFakeProvider({
      failForTexts: (texts) => texts.includes('bad'),
    });
    const queue = createEmbeddingQueue({
      provider: fake.provider,
      autoFlush: false,
      batchSize: 1,
      concurrency: 1,
    });

    const goodBefore = queue.submit([chunkInput(0, 'good-before')]);
    const bad = queue.submit([chunkInput(0, 'bad')]);
    const goodAfter = queue.submit([chunkInput(0, 'good-after')]);

    await queue.flush();

    await expect(goodBefore).resolves.toMatchObject({ deferred: false });
    await expect(bad).rejects.toThrow('provider exploded for bad');
    await expect(goodAfter).resolves.toMatchObject({ deferred: false });
  });

  test('propagates provider result count mismatches', async () => {
    const fake = createFakeProvider({ dropLastResult: true });
    const queue = createEmbeddingQueue({ provider: fake.provider, autoFlush: false });

    const submitted = queue.submit([chunkInput(0, 'alpha'), chunkInput(1, 'beta')]);
    await queue.flush();

    await expect(submitted).rejects.toThrow('Embedding provider returned an unexpected result count');
  });

  test('rejects provider vectors that do not match declared dimensions before storage writes', async () => {
    const provider: ResolvedEmbeddingProvider = {
      capability: {
        available: true,
        mode: 'local',
        implementation: 'test-local',
        model: 'test-local-v1',
        dimensions: 3,
      },
      embedBatch: async () => [new Float32Array([1, 2, 3, 4])],
    };
    const queue = createEmbeddingQueue({ provider, autoFlush: false });

    const submitted = queue.submit([chunkInput(0, 'wrong dimensions')]);
    await queue.flush();

    await expect(submitted).rejects.toThrow(/expected 3 dimensions, got 4/i);
  });

  test('defers unavailable providers without calling embedBatch', async () => {
    let calls = 0;
    const provider: ResolvedEmbeddingProvider = {
      capability: {
        available: false,
        mode: 'none',
        implementation: 'none',
        model: null,
        dimensions: null,
        reason: 'offline',
      },
      embedBatch: async () => {
        calls++;
        throw new Error('should not be called');
      },
    };
    const queue = createEmbeddingQueue({ provider, autoFlush: false });

    const submitted = queue.submit([chunkInput(0, 'offline chunk')]);
    await queue.flush();
    const result = await submitted;

    expect(result.deferred).toBe(true);
    expect(calls).toBe(0);
    expect(result.chunks).toEqual([
      {
        chunk_index: 0,
        chunk_text: 'offline chunk',
        chunk_source: 'compiled_truth',
        token_count: 4,
      },
    ]);
  });

  test('applies nomic document prefixes before provider batching', async () => {
    const fake = createFakeProvider({ model: 'nomic-embed-text' });
    const queue = createEmbeddingQueue({ provider: fake.provider, autoFlush: false });

    const submitted = queue.submit([chunkInput(0, 'document body')]);
    await queue.flush();
    await submitted;

    expect(fake.batches).toEqual([['search_document: document body']]);
  });

  test('leaves qwen3 document text unchanged before provider batching', async () => {
    const fake = createFakeProvider({ model: 'qwen3-embedding:0.6b' });
    const queue = createEmbeddingQueue({ provider: fake.provider, autoFlush: false });

    const submitted = queue.submit([chunkInput(0, 'document body')]);
    await queue.flush();
    await submitted;

    expect(fake.batches).toEqual([['document body']]);
  });
});

describe('runEmbed queue integration', () => {
  test('embed --all shares one queue across page submissions', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
      page('concepts/beta', 'Beta', 'beta body'),
    ]);

    try {
      await runEmbed(engine, ['--all']);
    } finally {
      resetEmbeddingProviderForTests();
    }

    expect(fake.batches).toEqual([['alpha body', 'beta body']]);
    expect((await engine.getChunks('concepts/alpha'))[0]?.embedding).toEqual(new Float32Array([10, 0, 0]));
    expect((await engine.getChunks('concepts/beta'))[0]?.embedding).toEqual(new Float32Array([9, 0, 1]));
  });

  test('embed --all keeps writing later pages when one page write fails', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
      page('concepts/beta', 'Beta', 'beta body'),
    ], { failWriteOnCall: new Map([['concepts/alpha', 2]]) });

    try {
      await runEmbed(engine, ['--all']);
    } finally {
      resetEmbeddingProviderForTests();
    }

    expect(fake.batches).toEqual([['alpha body', 'beta body']]);
    expect((await engine.getChunks('concepts/alpha'))[0]?.embedding).toBeNull();
    expect((await engine.getChunks('concepts/beta'))[0]?.embedding).toEqual(new Float32Array([9, 0, 1]));
  });

  test('embed --all warns when queued chunks grow large before flushing', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const engine = createMemoryEngine(
      Array.from(
        { length: 10_001 },
        (_, index) => page(`concepts/page-${index}`, `Page ${index}`, `body ${index}`),
      ),
    );
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalStdoutWrite = process.stdout.write;
    console.log = () => {};
    console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await runEmbed(engine, ['--all']);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.stdout.write = originalStdoutWrite;
      resetEmbeddingProviderForTests();
    }

    expect(warnings.join('\n')).toContain('Warning: queued 10001 chunks before flushing');
  });
});

function chunkInput(
  chunkIndex: number,
  chunkText: string,
  chunkSource: ChunkInput['chunk_source'] = 'compiled_truth',
): ChunkInput {
  return {
    chunk_index: chunkIndex,
    chunk_text: chunkText,
    chunk_source: chunkSource,
  };
}

interface FakeProviderOptions {
  delayForTexts?: (texts: string[]) => Promise<void>;
  failForTexts?: (texts: string[]) => boolean;
  dropLastResult?: boolean;
  model?: string;
}

function createFakeProvider(options: FakeProviderOptions = {}) {
  const batches: string[][] = [];
  let active = 0;
  let maxActive = 0;
  const provider: ResolvedEmbeddingProvider = {
    capability: {
      available: true,
      mode: 'local',
      implementation: 'test-local',
      model: options.model ?? 'test-local-v1',
      dimensions: 3,
    },
    embedBatch: async (texts: string[]) => {
      batches.push([...texts]);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await options.delayForTexts?.(texts);
        if (options.failForTexts?.(texts)) {
          throw new Error(`provider exploded for ${texts.join(', ')}`);
        }
        const embeddings = texts.map((text, index) => new Float32Array([text.length, batches.length - 1, index]));
        return options.dropLastResult ? embeddings.slice(0, -1) : embeddings;
      } finally {
        active--;
      }
    },
  };

  return {
    provider,
    batches,
    get maxActive() {
      return maxActive;
    },
  };
}

function createMemoryEngine(
  pages: Page[],
  options: { failWriteOnCall?: Map<string, number> } = {},
): BrainEngine {
  const chunksBySlug = new Map<string, Chunk[]>();
  const pageBySlug = new Map(pages.map(page => [page.slug, page]));
  const writeCallsBySlug = new Map<string, number>();

  return {
    listPages: async () => pages,
    getPage: async (slug: string) => pageBySlug.get(slug) ?? null,
    getChunks: async (slug: string) => chunksBySlug.get(slug) ?? [],
    getChunksWithEmbeddings: async (slug: string) => chunksBySlug.get(slug) ?? [],
    deleteChunks: async (slug: string) => {
      chunksBySlug.delete(slug);
    },
    upsertChunks: async (slug: string, chunks: ChunkInput[]) => {
      const writeCall = (writeCallsBySlug.get(slug) ?? 0) + 1;
      writeCallsBySlug.set(slug, writeCall);
      if (options.failWriteOnCall?.get(slug) === writeCall) {
        throw new Error(`write failed for ${slug}`);
      }
      chunksBySlug.set(slug, chunks.map((chunk, index) => materializeChunk(slug, chunk, index)));
    },
  } as unknown as BrainEngine;
}

function page(slug: string, title: string, compiledTruth: string): Page {
  return {
    id: Math.abs(hashString(slug)),
    slug,
    type: 'concept',
    title,
    compiled_truth: compiledTruth,
    timeline: '',
    frontmatter: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function materializeChunk(slug: string, input: ChunkInput, fallbackIndex: number): Chunk {
  return {
    id: fallbackIndex + 1,
    page_id: Math.abs(hashString(slug)),
    chunk_index: input.chunk_index,
    chunk_text: input.chunk_text,
    chunk_source: input.chunk_source,
    chunk_content_hash: `${slug}:${input.chunk_index}:${input.chunk_text}`,
    embedding: input.embedding ?? null,
    model: input.model ?? '',
    token_count: input.token_count ?? null,
    embedded_at: input.embedding ? new Date('2026-01-01T00:00:00Z') : null,
  };
}

function hashString(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return hash;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
