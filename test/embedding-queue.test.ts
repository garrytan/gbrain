import { describe, expect, test } from 'bun:test';
import { runEmbed } from '../src/commands/embed.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from '../src/core/embedding.ts';
import { createEmbeddingQueue } from '../src/core/embedding-queue.ts';
import type { ResolvedEmbeddingProvider } from '../src/core/embedding/provider.ts';
import { runEmbeddingBackfill } from '../src/core/services/embedding-backfill-service.ts';
import { runEmbedBackfillJob, submitEmbedBackfillJob } from '../src/core/services/embed-backfill-job-service.ts';
import { createMaintenanceRuntimeService } from '../src/core/services/maintenance-runtime-service.ts';
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

  test('falls back to submission-sized retries when a mixed provider batch fails', async () => {
    const fake = createFakeProvider({
      failForTexts: (texts) => texts.includes('bad'),
    });
    const queue = createEmbeddingQueue({
      provider: fake.provider,
      autoFlush: false,
      batchSize: 3,
      concurrency: 1,
    });

    const goodBefore = queue.submit([chunkInput(0, 'good-before')]);
    const bad = queue.submit([chunkInput(0, 'bad')]);
    const goodAfter = queue.submit([chunkInput(0, 'good-after')]);

    await queue.flush();

    await expect(goodBefore).resolves.toMatchObject({ deferred: false });
    await expect(bad).rejects.toThrow('provider exploded for bad');
    await expect(goodAfter).resolves.toMatchObject({ deferred: false });
    expect(fake.batches).toEqual([
      ['good-before', 'bad', 'good-after'],
      ['good-before'],
      ['bad'],
      ['good-after'],
    ]);
  });

  test('does not retry every submission when a large mixed provider batch fails systemically', async () => {
    const fake = createFakeProvider({
      failForTexts: () => true,
    });
    const queue = createEmbeddingQueue({
      provider: fake.provider,
      autoFlush: false,
      batchSize: 9,
      concurrency: 1,
    });

    const submitted = Array.from(
      { length: 9 },
      (_, index) => queue.submit([chunkInput(0, `chunk-${index}`)]),
    );

    await queue.flush();

    const results = await Promise.all(
      submitted.map(promise => promise.then(
        () => null,
        error => error,
      )),
    );
    expect(results.every(error => error instanceof Error)).toBe(true);
    expect(fake.batches).toHaveLength(1);
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
  test('embed --all processes pages in bounded windows and persists each window before reading the next', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const filters: Array<{ limit?: number; offset?: number }> = [];
    const engine = createMemoryEngine(
      Array.from(
        { length: 501 },
        (_, index) => page(`concepts/window-${index}`, `Window ${index}`, `window body ${index}`),
      ),
      {
        onListPages: (filter, state) => {
          filters.push({ limit: filter?.limit, offset: filter?.offset });
          if ((filter?.offset ?? 0) >= 500) {
            expect(state.embeddedWriteCount).toBeGreaterThanOrEqual(500);
          }
        },
      },
    );
    const originalLog = console.log;
    const originalStdoutWrite = process.stdout.write;
    console.log = () => {};
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await runEmbed(engine, ['--all']);
    } finally {
      console.log = originalLog;
      process.stdout.write = originalStdoutWrite;
      resetEmbeddingProviderForTests();
    }

    expect(filters).toEqual([
      { limit: 500, offset: 0 },
      { limit: 500, offset: 500 },
    ]);
    expect((await engine.getChunks('concepts/window-0'))[0]?.embedding?.[0]).toBe(13);
    expect((await engine.getChunks('concepts/window-500'))[0]?.embedding?.[0]).toBe(15);
  });

  test('embed --all flushes and writes before queued chunks exceed the chunk window', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const providerBatchCountByWrite = new Map<string, number>();
    const engine = createMemoryEngine(
      Array.from(
        { length: 101 },
        (_, index) => page(`concepts/chunk-window-${index}`, `Chunk Window ${index}`, `chunk window body ${index}`),
      ),
      {
        onUpsertChunks: (slug, chunks) => {
          if (chunks.some(chunk => chunk.embedding)) {
            providerBatchCountByWrite.set(slug, fake.batches.length);
          }
        },
      },
    );
    const originalLog = console.log;
    const originalStdoutWrite = process.stdout.write;
    console.log = () => {};
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await runEmbed(engine, ['--all']);
    } finally {
      console.log = originalLog;
      process.stdout.write = originalStdoutWrite;
      resetEmbeddingProviderForTests();
    }

    expect(providerBatchCountByWrite.get('concepts/chunk-window-0')).toBe(1);
    expect(providerBatchCountByWrite.get('concepts/chunk-window-99')).toBe(1);
    expect(providerBatchCountByWrite.get('concepts/chunk-window-100')).toBe(2);
  });

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
    expect((await engine.getChunks('concepts/alpha'))[0]?.embedding?.[0]).toBe(10);
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

  test('embed --all keeps writing later pages when one provider submission fails', async () => {
    const fake = createFakeProvider({
      failForTexts: (texts) => texts.includes('bad body'),
    });
    setEmbeddingProviderForTests(fake.provider);
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
      page('concepts/bad', 'Bad', 'bad body'),
      page('concepts/beta', 'Beta', 'beta body'),
    ]);

    try {
      await runEmbed(engine, ['--all']);
    } finally {
      resetEmbeddingProviderForTests();
    }

    expect((await engine.getChunks('concepts/alpha'))[0]?.embedding?.[0]).toBe(10);
    expect((await engine.getChunks('concepts/bad'))[0]?.embedding).toBeNull();
    expect((await engine.getChunks('concepts/beta'))[0]?.embedding?.[0]).toBe(9);
  });

  test('embed --all avoids a large pre-flush queue warning by flushing bounded windows', async () => {
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

    expect(warnings.join('\n')).not.toContain('Warning: queued');
  });
});

describe('durable embed backfill job integration', () => {
  test('submitEmbedBackfillJob dedupes stale backfill requests', async () => {
    const runtime = createMaintenanceRuntimeService();

    const first = await submitEmbedBackfillJob(runtime, { mode: 'stale' });
    const second = await submitEmbedBackfillJob(runtime, { mode: 'stale' });

    expect(first).toMatchObject({
      status: 'enqueued',
      job: {
        name: 'embed_backfill',
        queue: 'maintenance',
        payload_json: { mode: 'stale' },
        progress_json: { page_offset: 0, pages_scanned: 0, chunks_embedded: 0 },
        idempotency_key: 'embed-backfill:stale:default',
      },
    });
    expect(second.status).toBe('deduped');
    expect(second.job.id).toBe(first.job.id);
  });

  test('runEmbedBackfillJob renews progress and completes the durable job', async () => {
    const fake = createFakeProvider();
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
      page('concepts/beta', 'Beta', 'beta body'),
    ]);
    let currentNow = '2026-05-20T12:00:00.000Z';
    const runtime = createMaintenanceRuntimeService({ now: () => currentNow });
    const submitted = await submitEmbedBackfillJob(runtime, {
      mode: 'stale',
      timeout_ms: 60_000,
    });

    currentNow = '2026-05-20T12:00:01.000Z';
    const result = await runEmbedBackfillJob({
      engine,
      runtime,
      job_id: submitted.job.id,
      worker_id: 'worker:embed',
      lease_ms: 10_000,
      provider: fake.provider,
    });

    expect(result.status).toBe('completed');
    expect(result.result).toMatchObject({
      pages_scanned: 2,
      pages_touched: 2,
      chunks_queued: 2,
      chunks_embedded: 2,
      provider_failures: 0,
      write_failures: 0,
    });
    expect(await runtime.getJob(submitted.job.id)).toMatchObject({
      status: 'completed',
      progress_json: expect.objectContaining({
        page_offset: 2,
        pages_scanned: 2,
        chunks_embedded: 2,
      }),
      result_json: expect.objectContaining({
        chunks_embedded: 2,
      }),
    });
    expect(await runtime.listJobEvents(submitted.job.id)).toContainEqual(
      expect.objectContaining({
        event_type: 'job_lease_renewed',
        metadata_json: expect.objectContaining({ progress_updated: true }),
      }),
    );
    expect((await engine.getChunks('concepts/alpha'))[0]?.embedding?.[0]).toBe(10);
    expect((await engine.getChunks('concepts/beta'))[0]?.embedding).toEqual(new Float32Array([9, 0, 1]));
  });

  test('runEmbedBackfillJob retries from zero and skips already fresh chunks', async () => {
    const fake = createFakeProvider();
    const filters: Array<{ limit?: number; offset?: number }> = [];
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
      page('concepts/beta', 'Beta', 'beta body'),
    ], {
      onListPages: (filter) => {
        filters.push({ limit: filter?.limit, offset: filter?.offset });
      },
    });
    await engine.upsertChunks('concepts/alpha', [{
      chunk_index: 0,
      chunk_text: 'alpha body',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array([10, 0, 0]),
      model: 'test-local-v1',
    }]);
    const runtime = createMaintenanceRuntimeService();
    const submitted = await runtime.enqueueJob({
      name: 'embed_backfill',
      queue: 'maintenance',
      payload_json: { mode: 'stale' },
      progress_json: { page_offset: 1, pages_scanned: 1, chunks_embedded: 1 },
      idempotency_key: 'embed-backfill:stale:default',
      max_attempts: 1,
    });

    await runEmbedBackfillJob({
      engine,
      runtime,
      job_id: submitted.job.id,
      worker_id: 'worker:embed',
      lease_ms: 10_000,
      provider: fake.provider,
    });

    expect(filters[0]).toEqual({ limit: 500, offset: 0 });
    expect(fake.batches).toEqual([['beta body']]);
    expect((await engine.getChunks('concepts/alpha'))[0]?.embedding).toEqual(new Float32Array([10, 0, 0]));
    expect((await engine.getChunks('concepts/beta'))[0]?.embedding).toEqual(new Float32Array([9, 0, 0]));
    expect(await runtime.getJob(submitted.job.id)).toMatchObject({
      status: 'completed',
      progress_json: expect.objectContaining({ page_offset: 2 }),
    });
  });

  test('runEmbedBackfillJob fails the durable job when the provider is unavailable', async () => {
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const submitted = await submitEmbedBackfillJob(runtime, { mode: 'stale' });

    await expect(runEmbedBackfillJob({
      engine,
      runtime,
      job_id: submitted.job.id,
      worker_id: 'worker:embed',
      lease_ms: 10_000,
      provider: {
        capability: {
          available: false,
          mode: 'none',
          implementation: 'none',
          model: null,
          dimensions: 3,
          reason: 'embedding provider unavailable',
        },
        embedBatch: async () => {
          throw new Error('should not call unavailable provider');
        },
      },
    })).rejects.toThrow(/embedding provider unavailable/i);

    expect(await runtime.getJob(submitted.job.id)).toMatchObject({
      status: 'failed',
      failure_class: 'runner_unavailable',
      last_error: 'embedding provider unavailable',
    });
  });

  test('runEmbedBackfillJob rejects unrelated maintenance job ids without claiming them', async () => {
    const fake = createFakeProvider();
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const unrelated = await runtime.enqueueJob({
      name: 'projection_refresh',
      queue: 'maintenance',
      max_attempts: 1,
    });

    await expect(runEmbedBackfillJob({
      engine,
      runtime,
      job_id: unrelated.job.id,
      worker_id: 'worker:embed',
      lease_ms: 10_000,
      provider: fake.provider,
    })).rejects.toThrow(/embed_backfill job is not claimable/i);

    expect(await runtime.getJob(unrelated.job.id)).toMatchObject({
      status: 'waiting',
      attempts_started: 0,
      result_json: null,
    });
    expect(fake.batches).toEqual([]);
  });

  test('runEmbedBackfillJob keeps renewing the lease while provider work is in flight', async () => {
    const fake = createFakeProvider({
      delayForTexts: async () => {
        await sleep(50);
      },
    });
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const submitted = await submitEmbedBackfillJob(runtime, { mode: 'stale' });
    let renewCount = 0;
    const runtimeWithRenewSpy = {
      ...runtime,
      renewJobLease: async (input: Parameters<typeof runtime.renewJobLease>[0]) => {
        renewCount++;
        return runtime.renewJobLease(input);
      },
    };

    await runEmbedBackfillJob({
      engine,
      runtime: runtimeWithRenewSpy,
      job_id: submitted.job.id,
      worker_id: 'worker:embed',
      lease_ms: 20,
      provider: fake.provider,
    });

    expect(renewCount).toBeGreaterThan(1);
    expect(await runtime.getJob(submitted.job.id)).toMatchObject({
      status: 'completed',
    });
  });

  test('runEmbedBackfillJob fails the durable job when page-level embedding failures remain', async () => {
    const fake = createFakeProvider({
      failForTexts: (texts) => texts.includes('bad body'),
    });
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
      page('concepts/bad', 'Bad', 'bad body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const submitted = await submitEmbedBackfillJob(runtime, { mode: 'stale' });

    await expect(runEmbedBackfillJob({
      engine,
      runtime,
      job_id: submitted.job.id,
      worker_id: 'worker:embed',
      lease_ms: 10_000,
      provider: fake.provider,
    })).rejects.toThrow(/embed_backfill completed with failures/i);

    expect((await engine.getChunks('concepts/alpha'))[0]?.embedding?.[0]).toBe(10);
    expect(await runtime.getJob(submitted.job.id)).toMatchObject({
      status: 'failed',
      failure_class: 'internal',
      last_error: expect.stringContaining('provider_failures=1'),
    });
  });

  test('runEmbeddingBackfill can report progress without console output', async () => {
    const fake = createFakeProvider();
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
      page('concepts/beta', 'Beta', 'beta body'),
    ]);
    const progress: Array<{ page_offset: number; chunks_embedded: number }> = [];

    const result = await runEmbeddingBackfill(engine, {
      staleOnly: true,
      provider: fake.provider,
      onProgress: snapshot => {
        progress.push({
          page_offset: snapshot.page_offset,
          chunks_embedded: snapshot.chunks_embedded,
        });
      },
    });

    expect(result).toMatchObject({
      pages_scanned: 2,
      pages_touched: 2,
      chunks_embedded: 2,
    });
    expect(progress.at(-1)).toEqual({ page_offset: 2, chunks_embedded: 2 });
    expect(fake.batches).toEqual([['alpha body', 'beta body']]);
  });

  test('runEmbed --stale --enqueue submits a durable embed_backfill job without embedding inline', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

    try {
      await runEmbed(engine, ['--stale', '--enqueue'], { runtime });
    } finally {
      console.log = originalLog;
      resetEmbeddingProviderForTests();
    }

    expect(fake.batches).toEqual([]);
    expect(await runtime.listJobs({ name: 'embed_backfill' })).toEqual([
      expect.objectContaining({
        status: 'waiting',
        payload_json: { mode: 'stale' },
        idempotency_key: 'embed-backfill:stale:default',
      }),
    ]);
    expect(logs.join('\n')).toContain('enqueued embed_backfill');
  });

  test('runEmbed --all --enqueue submits an all-mode durable job without provider availability', async () => {
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

    try {
      await runEmbed(engine, ['--all', '--enqueue'], { runtime });
    } finally {
      console.log = originalLog;
    }

    expect(await runtime.listJobs({ name: 'embed_backfill' })).toEqual([
      expect.objectContaining({
        status: 'waiting',
        payload_json: { mode: 'all' },
        idempotency_key: 'embed-backfill:all:default',
      }),
    ]);
    expect(logs.join('\n')).toContain('enqueued embed_backfill');
  });

  test('runEmbed rejects slug enqueue without submitting a job', async () => {
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const errors: string[] = [];
    const originalError = console.error;
    const originalExit = process.exit;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;

    try {
      await expect(runEmbed(engine, ['concepts/alpha', '--enqueue'], { runtime })).rejects.toThrow('process.exit(1)');
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(errors.join('\n')).toContain('Usage: mbrain embed [--all|--stale] --enqueue');
    expect(await runtime.listJobs({ name: 'embed_backfill' })).toEqual([]);
  });

  test('runEmbed rejects enqueue and run-job mode conflicts', async () => {
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const errors: string[] = [];
    const originalError = console.error;
    const originalExit = process.exit;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;

    try {
      await expect(runEmbed(engine, ['--enqueue', '--run-job', 'job:existing'], { runtime })).rejects.toThrow('process.exit(1)');
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(errors.join('\n')).toContain('Usage: mbrain embed --run-job <id>');
    expect(await runtime.listJobs({ name: 'embed_backfill' })).toEqual([]);
  });

  test('runEmbed rejects slug and run-job mode conflicts without claiming the job', async () => {
    const fake = createFakeProvider();
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const submitted = await submitEmbedBackfillJob(runtime, { mode: 'stale' });
    const errors: string[] = [];
    const originalError = console.error;
    const originalExit = process.exit;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;

    try {
      await expect(runEmbed(engine, ['concepts/alpha', '--run-job', submitted.job.id], {
        runtime,
        provider: fake.provider,
      })).rejects.toThrow('process.exit(1)');
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(errors.join('\n')).toContain('Usage: mbrain embed --run-job <id>');
    expect(await runtime.getJob(submitted.job.id)).toMatchObject({
      status: 'waiting',
      attempts_started: 0,
    });
    expect(fake.batches).toEqual([]);
  });

  test('runEmbed --run-job completes a specific durable embed_backfill job', async () => {
    const fake = createFakeProvider();
    const engine = createMemoryEngine([
      page('concepts/alpha', 'Alpha', 'alpha body'),
    ]);
    const runtime = createMaintenanceRuntimeService();
    const submitted = await submitEmbedBackfillJob(runtime, { mode: 'stale' });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

    try {
      await runEmbed(engine, ['--run-job', submitted.job.id], {
        runtime,
        provider: fake.provider,
      });
    } finally {
      console.log = originalLog;
    }

    expect(await runtime.getJob(submitted.job.id)).toMatchObject({
      status: 'completed',
      result_json: expect.objectContaining({ chunks_embedded: 1 }),
    });
    expect((await engine.getChunks('concepts/alpha'))[0]?.embedding).toEqual(new Float32Array([10, 0, 0]));
    expect(logs.join('\n')).toContain(`completed embed_backfill ${submitted.job.id}: 1 chunks embedded`);
  });

  test('runEmbed slug reports skipped derived refresh warnings', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const stalePage = {
      ...page('concepts/concurrent-refresh', 'Concurrent Refresh', 'old body'),
      content_hash: 'old-hash',
    };
    const currentPage = {
      ...stalePage,
      compiled_truth: 'new body',
      content_hash: 'new-hash',
    };
    const engine = createMemoryEngine([stalePage], {
      pageForDerivedRefresh: new Map([[stalePage.slug, currentPage]]),
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };

    try {
      await runEmbed(engine, [stalePage.slug]);
    } finally {
      console.error = originalError;
      resetEmbeddingProviderForTests();
    }

    expect(errors.join('\n')).toContain(`Warning: skipped derived refresh for ${stalePage.slug}`);
    expect(fake.batches).toEqual([]);
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
  options: {
    failWriteOnCall?: Map<string, number>;
    onListPages?: (
      filters: { limit?: number; offset?: number } | undefined,
      state: { embeddedWriteCount: number },
    ) => void;
    onUpsertChunks?: (slug: string, chunks: ChunkInput[]) => void;
    pageForDerivedRefresh?: Map<string, Page>;
  } = {},
): BrainEngine {
  const chunksBySlug = new Map<string, Chunk[]>();
  const pageBySlug = new Map(pages.map(page => [page.slug, page]));
  const writeCallsBySlug = new Map<string, number>();
  let embeddedWriteCount = 0;

  return {
    listPages: async (filters?: { limit?: number; offset?: number }) => {
      options.onListPages?.(filters, { embeddedWriteCount });
      if (typeof filters?.limit === 'number') {
        const offset = filters.offset ?? 0;
        return pages.slice(offset, offset + filters.limit);
      }
      return pages;
    },
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
      if (chunks.some(chunk => chunk.embedding)) {
        embeddedWriteCount += 1;
      }
      options.onUpsertChunks?.(slug, chunks);
      chunksBySlug.set(slug, chunks.map((chunk, index) => materializeChunk(slug, chunk, index)));
    },
    getNoteManifestEntry: async () => null,
    listDerivedJobs: async () => [],
    listDerivedIndexStates: async () => [],
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      getPageForUpdate: async (slug: string) => options.pageForDerivedRefresh?.get(slug) ?? pageBySlug.get(slug) ?? null,
    }),
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
