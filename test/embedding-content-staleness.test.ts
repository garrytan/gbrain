/**
 * #4246 — embedding freshness follows chunk content, never page timestamps.
 *
 * The normal upsert path already NULLs a vector when chunk_text changes. This
 * suite pins the deeper invariant at the public engine seams: a text mutation
 * that bypasses that helper must still be visible to the stale cursor and must
 * not be served by vector search, while a metadata-only page write remains
 * fresh. The raw UPDATE is fixture setup for the historical/corrupt-row shape;
 * assertions stay on BrainEngine's public read/remediation surfaces.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SemanticQueryCache } from '../src/core/search/query-cache.ts';
import { embedStaleForSource, embedStalePages } from '../src/core/embed-stale.ts';
import { primaryEmbeddingStaleSql } from '../src/core/embedding-content-revision.ts';
import type { HybridSearchMeta, SearchResult } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let dims: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass
        AND attname = 'embedding' AND attnum > 0`,
  );
  dims = Number(rows[0]?.dim);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function vector(seed: number): Float32Array {
  const value = new Float32Array(dims);
  value[0] = seed;
  value[1] = 1;
  return value;
}

async function seedFreshChunk(): Promise<void> {
  await engine.putPage('fixture/content-revision', {
    type: 'note',
    title: 'Content revision fixture',
    compiled_truth: 'Original body',
    frontmatter: { owner: 'fixture-a' },
  });
  await engine.upsertChunks('fixture/content-revision', [{
    chunk_index: 0,
    chunk_text: 'Original body',
    chunk_source: 'compiled_truth',
    embedding: vector(1),
    token_count: 3,
  }]);
}

describe('embedding content staleness', () => {
  test('stale SQL exposes both partial-index predicates to the planner', () => {
    const sql = primaryEmbeddingStaleSql('cc');
    expect(sql).toContain('cc.embedding IS NULL OR (cc.embedding IS NOT NULL AND');
    expect(sql).toContain('cc.embedded_content_revision IS DISTINCT FROM cc.content_revision');
  });

  test('metadata-only page updates do not stale an unchanged chunk', async () => {
    await seedFreshChunk();
    expect(await engine.countStaleChunks()).toBe(0);

    await engine.putPage('fixture/content-revision', {
      type: 'note',
      title: 'Content revision fixture',
      compiled_truth: 'Original body',
      frontmatter: { owner: 'fixture-b', reviewed: true },
    });

    expect(await engine.countStaleChunks()).toBe(0);
    expect((await engine.getStats()).embedded_count).toBe(1);
    expect((await engine.getHealth()).embed_coverage).toBe(1);
    expect(await engine.searchVector(vector(1), { limit: 5 })).toHaveLength(1);
  });

  test('title changes stale only vectors whose stored contextual mode embeds the title', async () => {
    await seedFreshChunk();

    // Raw-text mode: title is page metadata, not part of the vector input.
    await engine.putPage('fixture/content-revision', {
      type: 'note', title: 'Metadata-only rename', compiled_truth: 'Original body',
    });
    expect(await engine.countStaleChunks()).toBe(0);

    // Title mode: the sanitized title is prepended to every non-code chunk.
    // Stamp the mode, refresh the vector under that convention, then rename.
    await engine.updatePageContextualRetrievalState(
      'fixture/content-revision', 'default', 'title', 'fixture-generation',
    );
    await engine.upsertChunks('fixture/content-revision', [{
      chunk_index: 0,
      chunk_text: 'Original body',
      chunk_source: 'compiled_truth',
      embedding: vector(2),
      token_count: 3,
    }]);
    await engine.putPage('fixture/content-revision', {
      type: 'note', title: 'Embedding-input rename', compiled_truth: 'Original body',
    });

    expect(await engine.countStaleChunks()).toBe(1);
    expect(await engine.searchVector(vector(2), { limit: 5 })).toEqual([]);
  });

  test('per-chunk synopsis mode stales every non-code sibling when its page corpus changes', async () => {
    await engine.putPage('fixture/synopsis-revision', {
      type: 'note', title: 'Synopsis fixture', compiled_truth: 'Body', timeline: 'Old timeline',
    });
    await engine.updatePageContextualRetrievalState(
      'fixture/synopsis-revision', 'default', 'per_chunk_synopsis', 'fixture-generation',
    );
    await engine.upsertChunks('fixture/synopsis-revision', [
      { chunk_index: 0, chunk_text: 'Body', chunk_source: 'compiled_truth', embedding: vector(3), token_count: 1 },
      { chunk_index: 1, chunk_text: 'Old timeline', chunk_source: 'timeline', embedding: vector(4), token_count: 2 },
      { chunk_index: 2, chunk_text: 'const stable = true;', chunk_source: 'fenced_code', embedding: vector(5), token_count: 3 },
    ]);

    await engine.putPage('fixture/synopsis-revision', {
      type: 'note', title: 'Synopsis fixture', compiled_truth: 'Body', timeline: 'New timeline',
    });
    expect(await engine.countStaleChunks()).toBe(2);
    expect((await engine.getChunks('fixture/synopsis-revision'))[2]?.embedding_is_stale).toBe(false);
  });

  test('direct chunk mutation invalidates a cached result for its parent page', async () => {
    await seedFreshChunk();
    const page = await engine.getPage('fixture/content-revision');
    expect(page).not.toBeNull();
    const cache = new SemanticQueryCache(engine);
    const query = vector(30);
    await cache.store(
      'original body',
      query,
      [{
        page_id: page!.id,
        slug: page!.slug,
        title: page!.title,
        snippet: 'Original body',
        score: 1,
      } as unknown as SearchResult],
      { sources_consulted: ['fixture'], intent: 'general', detail: 'medium' } as unknown as HybridSearchMeta,
    );
    expect((await cache.lookup(query)).hit).toBe(true);

    await engine.executeRaw(
      `UPDATE content_chunks SET chunk_text = 'Changed outside the page writer'
        WHERE page_id = $1 AND chunk_index = 0`,
      [page!.id],
    );
    expect((await cache.lookup(query)).hit).toBe(false);

    // Cache a non-empty result that OMITS the hidden page. Layer-2 validates
    // only page IDs already present in cached results, so a generation bump
    // on the repaired page cannot invalidate this row; source-scoped purge is
    // required when semantic eligibility returns.
    const unrelated = await engine.putPage('fixture/unrelated-cache-result', {
      type: 'note', title: 'Unrelated cache result', compiled_truth: 'Other body',
    });
    await engine.upsertChunks('fixture/unrelated-cache-result', [{
      chunk_index: 0,
      chunk_text: 'Other body',
      chunk_source: 'compiled_truth',
      embedding: vector(32),
      token_count: 2,
    }]);
    await cache.store(
      'original body', query, [{
        page_id: unrelated.id,
        slug: unrelated.slug,
        title: unrelated.title,
        snippet: 'Other body',
        score: 0.5,
      } as unknown as SearchResult],
      { sources_consulted: ['fixture'], intent: 'general', detail: 'medium' } as unknown as HybridSearchMeta,
    );
    expect((await cache.lookup(query)).hit).toBe(true);
    await engine.upsertChunks('fixture/content-revision', [{
      chunk_index: 0,
      chunk_text: 'Changed outside the page writer',
      chunk_source: 'compiled_truth',
      embedding: vector(31),
      token_count: 5,
    }]);
    expect((await cache.lookup(query)).hit).toBe(false);
  });

  test('chunk_source changes stale a vector when contextual wrapping semantics change', async () => {
    await seedFreshChunk();
    await engine.updatePageContextualRetrievalState(
      'fixture/content-revision', 'default', 'title', 'fixture-generation',
    );
    await engine.upsertChunks('fixture/content-revision', [{
      chunk_index: 0,
      chunk_text: 'Original body',
      chunk_source: 'compiled_truth',
      embedding: vector(31),
      token_count: 3,
    }]);

    await engine.upsertChunks('fixture/content-revision', [{
      chunk_index: 0,
      chunk_text: 'Original body',
      chunk_source: 'fenced_code',
      token_count: 3,
    }]);
    expect(await engine.countStaleChunks()).toBe(1);
    expect((await engine.getChunks('fixture/content-revision'))[0]?.embedding_is_null).toBe(true);
    expect(await engine.searchVector(vector(31), { limit: 5 })).toEqual([]);
  });

  test('per-chunk synopsis mode fans out direct text changes and chunk membership changes', async () => {
    const slug = 'fixture/synopsis-corpus-membership';
    await engine.putPage(slug, {
      type: 'note', title: 'Synopsis corpus membership', compiled_truth: 'Alpha\n\nBeta',
    });
    await engine.updatePageContextualRetrievalState(
      slug, 'default', 'per_chunk_synopsis', 'fixture-generation',
    );
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'Alpha', chunk_source: 'compiled_truth', embedding: vector(32), token_count: 1 },
      { chunk_index: 1, chunk_text: 'Beta', chunk_source: 'compiled_truth', embedding: vector(33), token_count: 1 },
    ]);

    await engine.executeRaw(
      `UPDATE content_chunks SET chunk_text = 'Alpha changed'
        WHERE page_id = (SELECT id FROM pages WHERE source_id = 'default' AND slug = $1)
          AND chunk_index = 0`,
      [slug],
    );
    expect(await engine.countStaleChunks()).toBe(2);

    // Refresh both, then add a third chunk. Its own supplied vector is
    // current, but the two existing synopses depended on the old corpus.
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'Alpha changed', chunk_source: 'compiled_truth', embedding: vector(34), token_count: 2 },
      { chunk_index: 1, chunk_text: 'Beta', chunk_source: 'compiled_truth', embedding: vector(35), token_count: 1 },
      { chunk_index: 2, chunk_text: 'Gamma', chunk_source: 'compiled_truth', embedding: vector(36), token_count: 1 },
    ]);
    expect(await engine.countStaleChunks()).toBe(2);

    // Refresh all three, then remove Gamma out of band. Both remaining
    // synopses depended on the old three-chunk corpus.
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'Alpha changed', chunk_source: 'compiled_truth', embedding: vector(37), token_count: 2 },
      { chunk_index: 1, chunk_text: 'Beta', chunk_source: 'compiled_truth', embedding: vector(38), token_count: 1 },
      { chunk_index: 2, chunk_text: 'Gamma', chunk_source: 'compiled_truth', embedding: vector(39), token_count: 1 },
    ]);
    await engine.executeRaw(
      `DELETE FROM content_chunks
        WHERE page_id = (SELECT id FROM pages WHERE source_id = 'default' AND slug = $1)
          AND chunk_index = 2`,
      [slug],
    );
    expect(await engine.countStaleChunks()).toBe(2);
  });

  test('synopsis demotion ignores fenced-code chunks that never used the wrapper', async () => {
    const slug = 'fixture/synopsis-fenced-demotion';
    await engine.putPage(slug, {
      type: 'note', title: 'Synopsis fenced demotion', compiled_truth: 'Body',
    });
    await engine.updatePageContextualRetrievalState(
      slug, 'default', 'per_chunk_synopsis', 'fixture-generation',
    );
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'Body', chunk_source: 'compiled_truth', embedding: vector(40), token_count: 1 },
      { chunk_index: 1, chunk_text: 'const stable = true;', chunk_source: 'fenced_code', embedding: vector(41), token_count: 3 },
    ]);
    await engine.putPage(slug, {
      type: 'note', title: 'Synopsis fenced demotion renamed', compiled_truth: 'Body',
    });
    expect(await engine.countStaleChunks()).toBe(1);

    await embedStalePages(engine, [slug], 'default', {
      embedFn: async (texts) => texts.map((_text, i) => vector(42 + i)),
    });
    expect((await engine.getPage(slug))?.contextual_retrieval_mode).toBe('title');
  });

  test('a preserved vector over changed chunk text is stale, unserved, and remediable', async () => {
    await seedFreshChunk();

    // Historical/corrupt-row fixture: the text changed while the prior vector
    // and timestamp survived. Normal upsertChunks does not create this shape,
    // but the database-level content revision must detect it if it exists.
    await engine.executeRaw(
      `UPDATE content_chunks
          SET chunk_text = 'Changed body'
        WHERE page_id = (
          SELECT id FROM pages
           WHERE source_id = 'default' AND slug = 'fixture/content-revision'
        )`,
    );

    expect(await engine.countStaleChunks()).toBe(1);
    const chunks = await engine.getChunks('fixture/content-revision');
    expect(chunks[0]?.embedding_is_null).toBe(false);
    expect(chunks[0]?.embedding_is_stale).toBe(true);
    const stale = await engine.listStaleChunks({ batchSize: 10 });
    expect(stale.map((row) => row.chunk_text)).toEqual(['Changed body']);
    expect((await engine.getStats()).embedded_count).toBe(0);
    expect((await engine.getChunksWithEmbeddings('fixture/content-revision'))[0]?.embedding).toBeNull();
    const ids = await engine.executeRaw<{ id: number }>(
      `SELECT cc.id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.source_id = 'default' AND p.slug = 'fixture/content-revision'`,
    );
    expect((await engine.getEmbeddingsByChunkIds([ids[0]!.id])).size).toBe(0);
    const health = await engine.getHealth();
    expect(health.missing_embeddings).toBe(1);
    expect(health.embed_coverage).toBe(0);
    expect(await engine.searchVector(vector(1), { limit: 5 })).toEqual([]);

    // The ordinary embed write stamps the vector against the current text and
    // makes every public freshness surface converge again.
    await engine.upsertChunks('fixture/content-revision', [{
      chunk_index: 0,
      chunk_text: 'Changed body',
      chunk_source: 'compiled_truth',
      embedding: vector(2),
      token_count: 3,
    }]);
    expect(await engine.countStaleChunks()).toBe(0);
    expect((await engine.getChunks('fixture/content-revision'))[0]?.embedding_is_stale).toBe(false);
    expect((await engine.getStats()).embedded_count).toBe(1);
    expect((await engine.getHealth()).embed_coverage).toBe(1);
    expect(await engine.searchVector(vector(2), { limit: 5 })).toHaveLength(1);
  });

  test('stale repair never stamps a vector computed before a concurrent text change', async () => {
    await seedFreshChunk();
    const page = await engine.getPage('fixture/content-revision');
    await engine.executeRaw(
      `UPDATE content_chunks SET chunk_text = 'Provider snapshot A'
        WHERE page_id = $1 AND chunk_index = 0`,
      [page!.id],
    );

    const result = await embedStalePages(engine, ['fixture/content-revision'], 'default', {
      embedFn: async () => {
        // Deterministic provider-latency race: mutate after the stale cursor
        // selected revision A but before its vector write returns.
        await engine.executeRaw(
          `UPDATE content_chunks SET chunk_text = 'Concurrent snapshot B'
            WHERE page_id = $1 AND chunk_index = 0`,
          [page!.id],
        );
        return [vector(70)];
      },
    });

    expect(result.embedded).toBe(0);
    expect(await engine.countStaleChunks()).toBe(1);
    expect((await engine.listStaleChunks({ batchSize: 10 }))[0]?.chunk_text).toBe('Concurrent snapshot B');
    expect(await engine.searchVector(vector(70), { limit: 5 })).toEqual([]);
  });

  test('stale repair never stamps a title-wrapped vector after a concurrent rename', async () => {
    await seedFreshChunk();
    await engine.updatePageContextualRetrievalState(
      'fixture/content-revision', 'default', 'title', 'title-generation-a',
    );
    await engine.upsertChunks('fixture/content-revision', [{
      chunk_index: 0,
      chunk_text: 'Original body',
      chunk_source: 'compiled_truth',
      embedding: vector(71),
      token_count: 3,
    }]);
    const page = await engine.getPage('fixture/content-revision');
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = NULL, embedded_at = NULL, embedded_content_revision = NULL
        WHERE page_id = $1 AND chunk_index = 0`,
      [page!.id],
    );

    const result = await embedStalePages(engine, ['fixture/content-revision'], 'default', {
      embedFn: async () => {
        await engine.putPage('fixture/content-revision', {
          type: 'note', title: 'Concurrent title B', compiled_truth: 'Original body',
        });
        return [vector(72)];
      },
    });

    expect(result.embedded).toBe(0);
    expect(await engine.countStaleChunks()).toBe(1);
    expect(await engine.searchVector(vector(72), { limit: 5 })).toEqual([]);
  });

  test('synopsis demotion completes when one page spans several stale batches', async () => {
    const slug = 'fixture/synopsis-split-batches';
    await engine.putPage(slug, {
      type: 'note', title: 'Synopsis split batches', compiled_truth: 'Alpha\n\nBeta',
    });
    await engine.updatePageContextualRetrievalState(
      slug, 'default', 'per_chunk_synopsis', 'synopsis-generation-a',
    );
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'Alpha', chunk_source: 'compiled_truth', embedding: vector(73), token_count: 1 },
      { chunk_index: 1, chunk_text: 'Beta', chunk_source: 'compiled_truth', embedding: vector(74), token_count: 1 },
    ]);
    await engine.putPage(slug, {
      type: 'note', title: 'Synopsis split batches renamed', compiled_truth: 'Alpha\n\nBeta',
    });
    expect(await engine.countStaleChunks()).toBe(2);

    const result = await embedStaleForSource(engine, 'default', {
      batchSize: 1,
      concurrency: 1,
      embedFn: async (texts) => texts.map((_text, index) => vector(75 + index)),
    });

    expect(result.embedded).toBe(2);
    expect(result.done).toBe(true);
    expect(await engine.countStaleChunks()).toBe(0);
    expect((await engine.getPage(slug))?.contextual_retrieval_mode).toBe('title');
  });
});
