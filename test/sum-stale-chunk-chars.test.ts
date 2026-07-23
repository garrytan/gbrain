/**
 * v0.41.31 — BrainEngine.sumStaleChunkChars tests (PGLite).
 *
 * Sibling of countStaleChunks: sums LENGTH(chunk_text) over stale chunks so
 * the `gbrain sync --all` cost preview can price the embedding backlog.
 * Validates: empty brain → 0, exact char sum, sourceId scope, embed_skip
 * exclusion, and that non-null (already-embedded) chunks are NOT counted.
 *
 * Uses the canonical PGLite block (one engine per file, resetPgliteState in
 * beforeEach) per CLAUDE.md test-isolation rules R3+R4.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
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

/** Seed a page + stale (NULL-embedding) chunks with explicit chunk_text. */
async function seedStale(
  slug: string,
  texts: string[],
  opts?: { sourceId?: string; frontmatter?: Record<string, unknown> },
): Promise<void> {
  await engine.putPage(
    slug,
    {
      type: 'note',
      title: slug,
      compiled_truth: `# ${slug}`,
      ...(opts?.frontmatter ? { frontmatter: opts.frontmatter } : {}),
    },
    opts?.sourceId ? { sourceId: opts.sourceId } : undefined,
  );
  const chunks: ChunkInput[] = texts.map((t, i) => ({
    chunk_index: i,
    chunk_text: t,
    chunk_source: 'compiled_truth',
    token_count: 4,
    embedding: undefined, // NULL = stale
  }));
  await engine.upsertChunks(slug, chunks, opts?.sourceId ? { sourceId: opts.sourceId } : undefined);
}

describe('sumStaleChunkChars', () => {
  test('empty brain returns 0', async () => {
    expect(await engine.sumStaleChunkChars()).toBe(0);
  });

  test('sums LENGTH(chunk_text) across stale chunks', async () => {
    await seedStale('a', ['abcde', 'fghij']); // 5 + 5
    await seedStale('b', ['xyz']); // 3
    expect(await engine.sumStaleChunkChars()).toBe(13);
  });

  test('scopes to sourceId when provided', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{"federated":true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await seedStale('a', ['abcde']); // default, 5
    await seedStale('b', ['xyzwv'], { sourceId: 'other' }); // other, 5
    expect(await engine.sumStaleChunkChars({ sourceId: 'default' })).toBe(5);
    expect(await engine.sumStaleChunkChars({ sourceId: 'other' })).toBe(5);
    expect(await engine.sumStaleChunkChars()).toBe(10); // all sources
  });

  test('excludes pages with embed_skip frontmatter', async () => {
    await seedStale('keep', ['abcde']); // 5, counted
    await seedStale('skip', ['1234567890'], {
      frontmatter: { embed_skip: { at: '2026-01-01T00:00:00Z', reason: 'oversize' } },
    });
    expect(await engine.sumStaleChunkChars()).toBe(5);
  });

  test('does NOT count already-embedded (non-null) chunks', async () => {
    // Stale page → counted.
    await seedStale('stale', ['abcde']); // 5
    // "Embedded" page: seed as stale, then flip its chunk's embedding to a
    // non-null vector via raw SQL. We bypass upsertChunks so the test doesn't
    // depend on gateway-configured dimensions (keeps it robust regardless of
    // any leaked gateway state from sibling files).
    await seedStale('done', ['this is embedded and should not count']);
    // Size the embedding to the ACTUAL column dimension (pgvector stores it
    // in atttypmod) so the test is robust to whatever dim initSchema chose.
    const dimRows = await engine.executeRaw<{ dim: number }>(
      `SELECT atttypmod AS dim FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
    );
    const dim = Number(dimRows[0]?.dim);
    expect(dim).toBeGreaterThan(0);
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[$1::int]), ',') || ']')::vector
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'done' AND source_id = 'default')`,
      [dim],
    );
    expect(await engine.sumStaleChunkChars()).toBe(5);
  });
});
