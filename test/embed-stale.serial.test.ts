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

  test('preserves modality and code-symbol metadata across the merge round-trip', async () => {
    // Regression: the merged ChunkInput[] used to rebuild rows with only 5
    // fields; upsertChunks writes modality/symbol columns as EXCLUDED.<col>,
    // so an image page with one stale TEXT chunk got its image row reset to
    // modality='text' — permanently invisible to the image search arm.
    await engine.putPage('media/mixed-page', {
      type: 'image',
      title: 'mixed',
      compiled_truth: 'mixed modality page',
    });
    const imgVec = new Float32Array(1024).fill(0.03);
    await engine.upsertChunks('media/mixed-page', [
      {
        chunk_index: 0,
        chunk_text: 'field-photo.jpg',
        chunk_source: 'image_asset',
        modality: 'image',
        embedding_image: imgVec,
        // embedding intentionally present so this row is NOT stale.
        embedding: new Float32Array(1536).fill(0.01),
        token_count: 4,
      },
      {
        chunk_index: 1,
        chunk_text: 'ocr caption text needing embed',
        chunk_source: 'compiled_truth',
        language: 'python',
        symbol_name: 'kept_symbol',
        symbol_type: 'function',
        symbol_name_qualified: 'mod::kept_symbol',
        token_count: 6,
        embedding: undefined, // stale — triggers the merge path
      },
    ]);

    const result = await embedStaleForSource(engine, 'default', { embedFn: fakeEmbedFn });
    expect(result.embedded).toBe(1);

    const after = await engine.getChunks('media/mixed-page');
    const imgRow = after.find((c) => c.chunk_index === 0)!;
    const txtRow = after.find((c) => c.chunk_index === 1)!;
    expect(imgRow.modality).toBe('image');
    expect(txtRow.language).toBe('python');
    expect(txtRow.symbol_name).toBe('kept_symbol');
    expect(txtRow.symbol_name_qualified).toBe('mod::kept_symbol');
    // The stale text row actually got its embedding.
    expect(txtRow.embedded_at).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// #3507 — re-embed must reproduce the page's STORED contextual-retrieval
// wrapping convention. Before the fix, every plain re-embed (including the
// normal post-model-migration `embed --stale`) embedded raw chunk_text,
// silently replacing context-wrapped vectors with unwrapped ones.
// ────────────────────────────────────────────────────────────────

describe('contextual-retrieval wrapping on re-embed (#3507)', () => {
  /** embedFn that records every text it is asked to embed. */
  function capturingEmbedFn(seen: string[]) {
    return (texts: string[]): Promise<Float32Array[]> => {
      seen.push(...texts);
      return fakeEmbedFn(texts);
    };
  }

  async function seedWrappablePage(slug: string, title: string): Promise<void> {
    await engine.putPage(slug, { type: 'note', title, compiled_truth: 'seeded' });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'prose chunk about widgets', chunk_source: 'compiled_truth', token_count: 4 },
      { chunk_index: 1, chunk_text: 'const x = 1;', chunk_source: 'fenced_code', token_count: 4 },
    ]);
  }

  test('title-mode page: stale re-embed sends title-wrapped texts; fenced_code stays raw', async () => {
    await seedWrappablePage('wrapped-page', 'Widget Notes');
    await engine.updatePageContextualRetrievalState('wrapped-page', 'default', 'title', 'gen-title');

    const seen: string[] = [];
    const result = await embedStaleForSource(engine, 'default', { embedFn: capturingEmbedFn(seen) });
    expect(result.embedded).toBe(2);

    expect(seen).toContain('<context>Widget Notes\n</context>\nprose chunk about widgets');
    expect(seen).toContain('const x = 1;'); // fenced_code is NEVER wrapped (D20-T4)

    // D20-T1: the canonical chunk_text is NOT rewritten — wrapping is embed-input-only.
    const chunks = await engine.getChunks('wrapped-page');
    expect(chunks.map((c) => c.chunk_text).sort()).toEqual(['const x = 1;', 'prose chunk about widgets']);
    // Mode stamp unchanged for title-tier pages.
    const rows = await engine.executeRaw<{ contextual_retrieval_mode: string }>(
      `SELECT contextual_retrieval_mode FROM pages WHERE slug = 'wrapped-page'`,
    );
    expect(rows[0].contextual_retrieval_mode).toBe('title');
  });

  test('per_chunk_synopsis page: re-embed applies the title-tier wrapper and restamps honestly', async () => {
    await seedWrappablePage('synopsis-page', 'Synopsis Notes');
    await engine.updatePageContextualRetrievalState('synopsis-page', 'default', 'per_chunk_synopsis', 'gen-synopsis');

    const seen: string[] = [];
    const result = await embedStaleForSource(engine, 'default', { embedFn: capturingEmbedFn(seen) });
    expect(result.embedded).toBe(2);

    // Synopsis re-generation is a paid backfill concern; the plain re-embed
    // lands at the title tier (the service's own D14 fallback tier)…
    expect(seen).toContain('<context>Synopsis Notes\n</context>\nprose chunk about widgets');
    // …and the stamped mode is updated so it keeps describing the vectors.
    const rows = await engine.executeRaw<{ contextual_retrieval_mode: string }>(
      `SELECT contextual_retrieval_mode FROM pages WHERE slug = 'synopsis-page'`,
    );
    expect(rows[0].contextual_retrieval_mode).toBe('title');
  });

  test('unstamped page (NULL mode) embeds raw chunk_text — convention preserved', async () => {
    await seedWrappablePage('plain-page', 'Plain Notes');
    // No updatePageContextualRetrievalState call: pre-CR page.

    const seen: string[] = [];
    const result = await embedStaleForSource(engine, 'default', { embedFn: capturingEmbedFn(seen) });
    expect(result.embedded).toBe(2);

    expect(seen).toContain('prose chunk about widgets');
    expect(seen.some((t) => t.startsWith('<context>'))).toBe(false);
  });
});
