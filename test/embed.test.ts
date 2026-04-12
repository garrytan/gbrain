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
