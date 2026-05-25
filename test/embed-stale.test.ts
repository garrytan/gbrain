/**
 * Tests for src/core/embed-stale.ts (v0.40 D15.2).
 *
 * Hermetic — uses an injected `embedFn` so no network call lands. Validates:
 *   - empty stale set → done:true, embedded:0
 *   - multi-batch run → embed every stale chunk, advance cursor correctly
 *   - kill mid-flight (signal.aborted) → aborted:true, partial progress preserved
 *   - resume from cursor → picks up where prior call left off (DB predicate)
 *   - per-page embedFn throw → logged + skipped, NOT propagated; chunks stay NULL
 *
 * Why PGLite: validates the engine.listStaleChunks/getChunks/upsertChunks
 * roundtrip the helper depends on, not just the loop control flow.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Seed a page with N stale chunks (no embedding) into the default source. */
async function seedPageWithStaleChunks(slug: string, chunkCount: number): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `# ${slug}\n\nseeded`,
  });
  const chunks: ChunkInput[] = Array.from({ length: chunkCount }, (_, i) => ({
    chunk_index: i,
    chunk_text: `chunk ${i} of ${slug}`,
    chunk_source: 'compiled_truth',
    token_count: 4,
    embedding: undefined, // NULL = stale
  }));
  await engine.upsertChunks(slug, chunks);
}

/** Deterministic fake embedder — returns unit-length 1536-dim vectors with
 *  first dim = text length, so we can assert specific chunks got embedded. */
function fakeEmbedFn(texts: string[]): Promise<Float32Array[]> {
  return Promise.resolve(
    texts.map((t) => {
      const v = new Float32Array(1536);
      v[0] = t.length;
      v[1] = 1;
      return v;
    }),
  );
}

describe('embedStaleForSource', () => {
  test('empty stale set returns done:true with zero embedded', async () => {
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
    });
    expect(result).toEqual({
      embedded: 0,
      chunksProcessed: 0,
      pagesProcessed: 0,
      lastCursor: null,
      done: true,
      aborted: false,
    });
  });

  test('embeds every stale chunk across multiple pages in one call', async () => {
    await seedPageWithStaleChunks('a', 5);
    await seedPageWithStaleChunks('b', 3);

    const result = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
    });
    expect(result.done).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.embedded).toBe(8);
    expect(result.pagesProcessed).toBe(2);

    // Verify DB: zero stale remaining for default.
    const stale = await engine.countStaleChunks({ sourceId: 'default' });
    expect(stale).toBe(0);
  });

  test('respects batchSize for cursor pagination', async () => {
    await seedPageWithStaleChunks('a', 3);
    await seedPageWithStaleChunks('b', 3);
    let batchCount = 0;
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
      batchSize: 2,
      onProgress: () => {
        batchCount++;
      },
    });
    expect(result.embedded).toBe(6);
    // 2-chunk batches across 6 stale rows = at least 3 progress callbacks.
    expect(batchCount).toBeGreaterThanOrEqual(3);
  });

  test('IRON-RULE: aborted mid-flight → aborted:true, partial progress preserved', async () => {
    await seedPageWithStaleChunks('a', 4);
    await seedPageWithStaleChunks('b', 4);
    await seedPageWithStaleChunks('c', 4);
    const controller = new AbortController();
    // Batch size 4 = one page per batch. concurrency 1 = serialize keys.
    // Abort fires inside embedFn for page 'b', so 'a' lands, 'b' aborts mid-call,
    // and the third batch ('c') never starts.
    const result = await embedStaleForSource(engine, 'default', {
      batchSize: 4,
      concurrency: 1,
      signal: controller.signal,
      embedFn: async (texts) => {
        if (texts.some((t) => t.includes(' of b'))) {
          controller.abort();
          throw new Error('aborted'); // simulates HTTP abort throw
        }
        return fakeEmbedFn(texts);
      },
    });
    expect(result.aborted).toBe(true);
    expect(result.done).toBe(false);
    expect(result.embedded).toBe(4); // only 'a' landed
    // 'b' and 'c' (8 chunks) remain stale
    const stale = await engine.countStaleChunks({ sourceId: 'default' });
    expect(stale).toBe(8);
  });

  test('IRON-RULE: kill + resume — second call picks up via embedding-IS-NULL predicate', async () => {
    await seedPageWithStaleChunks('a', 4);
    await seedPageWithStaleChunks('b', 4);

    // First call aborts when 'b' is reached
    const controller = new AbortController();
    const first = await embedStaleForSource(engine, 'default', {
      batchSize: 4,
      concurrency: 1,
      signal: controller.signal,
      embedFn: async (texts) => {
        if (texts.some((t) => t.includes(' of b'))) {
          controller.abort();
          throw new Error('aborted');
        }
        return fakeEmbedFn(texts);
      },
    });
    expect(first.aborted).toBe(true);
    expect(first.embedded).toBe(4); // 'a' landed

    // Second call with NO cursor — predicate excludes already-embedded chunks
    const second = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
    });
    expect(second.done).toBe(true);
    expect(first.embedded + second.embedded).toBe(8);

    const stale = await engine.countStaleChunks({ sourceId: 'default' });
    expect(stale).toBe(0);
  });

  test('per-page embedFn throw is logged but does NOT propagate', async () => {
    await seedPageWithStaleChunks('good', 2);
    await seedPageWithStaleChunks('bad', 2);

    let badCount = 0;
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: async (texts) => {
        if (texts.some((t) => t.includes('bad'))) {
          badCount++;
          throw new Error('intentional embed failure');
        }
        return fakeEmbedFn(texts);
      },
    });

    // The helper itself didn't throw
    expect(result.done).toBe(true);
    expect(badCount).toBe(1);

    // 'good' chunks got embedded; 'bad' chunks stayed NULL
    expect(result.embedded).toBe(2);
    const stale = await engine.countStaleChunks({ sourceId: 'default' });
    expect(stale).toBe(2);
  });

  test('source-scoped: does not touch other sources', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{"federated":true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await seedPageWithStaleChunks('a', 3);
    await engine.putPage('b', {
      type: 'note',
      title: 'b',
      compiled_truth: '# b\n\nseeded',
    }, { sourceId: 'other' });
    await engine.upsertChunks(
      'b',
      Array.from({ length: 3 }, (_, i) => ({
        chunk_index: i,
        chunk_text: `other ${i}`,
        chunk_source: 'compiled_truth',
        token_count: 4,
        embedding: undefined,
      })),
      { sourceId: 'other' },
    );

    const result = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
    });
    expect(result.embedded).toBe(3);

    // 'other' source still has 3 stale chunks
    const otherStale = await engine.countStaleChunks({ sourceId: 'other' });
    expect(otherStale).toBe(3);
  });
});
