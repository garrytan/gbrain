import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

// Mock the embedding module BEFORE importing runEmbed, so runEmbed picks up
// the mocked embedBatch. We track max concurrent invocations via a counter
// that increments on entry and decrements when the mock resolves.
let activeEmbedCalls = 0;
let maxConcurrentEmbedCalls = 0;
let totalEmbedCalls = 0;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    activeEmbedCalls++;
    totalEmbedCalls++;
    if (activeEmbedCalls > maxConcurrentEmbedCalls) {
      maxConcurrentEmbedCalls = activeEmbedCalls;
    }
    // Simulate API latency so concurrent workers actually overlap.
    await new Promise(r => setTimeout(r, 30));
    activeEmbedCalls--;
    return texts.map(() => new Float32Array(1536));
  },
}));

// Import AFTER mocking.
const { runEmbed } = await import('../src/commands/embed.ts');

// Proxy-based mock engine that matches test/import-file.test.ts pattern.
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

beforeEach(() => {
  activeEmbedCalls = 0;
  maxConcurrentEmbedCalls = 0;
  totalEmbedCalls = 0;
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
});

describe('runEmbed --all (parallel)', () => {
  test('runs embedBatch calls concurrently across pages', async () => {
    const NUM_PAGES = 20;
    const pages = Array.from({ length: NUM_PAGES }, (_, i) => ({ slug: `page-${i}` }));
    // Each page has one chunk without an embedding (stale).
    const chunksBySlug = new Map(
      pages.map(p => [
        p.slug,
        [{ chunk_index: 0, chunk_text: `text for ${p.slug}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 }],
      ]),
    );

    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '10';

    await runEmbed(engine, ['--all']);

    expect(totalEmbedCalls).toBe(NUM_PAGES);
    // Concurrency actually happened.
    expect(maxConcurrentEmbedCalls).toBeGreaterThan(1);
    // And stayed within the configured limit.
    expect(maxConcurrentEmbedCalls).toBeLessThanOrEqual(10);
  });

  test('respects GBRAIN_EMBED_CONCURRENCY=1 (serial)', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ slug: `page-${i}` }));
    const chunksBySlug = new Map(
      pages.map(p => [
        p.slug,
        [{ chunk_index: 0, chunk_text: `text ${p.slug}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 }],
      ]),
    );

    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '1';

    await runEmbed(engine, ['--all']);

    expect(totalEmbedCalls).toBe(5);
    expect(maxConcurrentEmbedCalls).toBe(1);
  });

  test('creates chunks lazily for pages that have none, then embeds them (--stale)', async () => {
    // Regression: prior to the ensureChunks refactor, embedAll skipped any
    // page whose getChunks returned []. Sync/extract never create chunks,
    // so any page that had never been individually embedded would be stuck
    // at 0 chunks forever and autopilot would report "0 chunks embedded"
    // on every cycle. This test catches that regression.
    const pages = [{
      slug: 'never-chunked',
      compiled_truth: 'Hello world. This is the compiled truth.',
      timeline: '',
    }];
    // Stateful mock: upsertChunks actually persists, getChunks reflects it.
    const store = new Map<string, any[]>();
    let upsertCalls = 0;

    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => store.get(slug) ?? [],
      upsertChunks: async (slug: string, inputs: any[]) => {
        upsertCalls++;
        const existing = store.get(slug) ?? [];
        const byIndex = new Map<number, any>(existing.map(c => [c.chunk_index, c]));
        for (const inp of inputs) {
          const prev = byIndex.get(inp.chunk_index);
          byIndex.set(inp.chunk_index, {
            ...(prev ?? {}),
            ...inp,
            embedded_at: inp.embedding ? '2026-04-19' : (prev?.embedded_at ?? null),
          });
        }
        store.set(slug, Array.from(byIndex.values()).sort((a, b) => a.chunk_index - b.chunk_index));
      },
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '1';

    await runEmbed(engine, ['--stale']);

    // Chunks were created (1st upsert) and then embedded (2nd upsert).
    expect(upsertCalls).toBe(2);
    expect(totalEmbedCalls).toBe(1);
    const finalChunks = store.get('never-chunked') ?? [];
    expect(finalChunks.length).toBeGreaterThan(0);
    expect(finalChunks.every((c: any) => c.embedded_at !== null)).toBe(true);
  });

  test('skips pages whose chunks are all already embedded when --stale', async () => {
    const pages = [{ slug: 'fresh' }, { slug: 'stale' }];
    const chunksBySlug = new Map<string, any[]>([
      ['fresh', [{ chunk_index: 0, chunk_text: 'hi', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 }]],
      ['stale', [{ chunk_index: 0, chunk_text: 'hi', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 }]],
    ]);

    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '5';

    await runEmbed(engine, ['--stale']);

    // Only the stale page triggers an embedBatch call.
    expect(totalEmbedCalls).toBe(1);
  });
});
