/**
 * E2E regression: cursor-paginated `embed --stale` (D7 + IRON RULE from the
 * v0.33.4 plan-eng-review). Seeds >PAGE_SIZE chunks with `embedding IS NULL`
 * and walks the production cursor to verify:
 *
 *  - Static case: every chunk visited exactly once across multiple batches.
 *  - Cursor monotonically advances on `(page_id, chunk_index)`.
 *  - Migration v66's partial index `idx_chunks_embedding_null` exists.
 *  - D7: source-scoped scan returns ONLY that source's NULLs even when
 *    same-slug pages exist across sources.
 *  - Failed-page semantics: a failed upsert keeps `embedding IS NULL` and
 *    the next run picks it up (covers the "cursor advances past failures
 *    in the same run" intended behavior).
 *
 * Requires DATABASE_URL. Skips gracefully otherwise.
 *
 * Run: DATABASE_URL=... bun test test/e2e/embed-stale-pagination.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { getConnection } from '../../src/core/db.ts';

const getConn = getConnection;

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E embed-stale-pagination tests (DATABASE_URL not set)');
}

const PAGE_SIZE = 2000; // matches embed.ts production constant

/**
 * Seed N chunks across M pages, all with `embedding IS NULL`.
 * Uses raw SQL because the public engine API doesn't expose page+chunk
 * insertion at this granularity without going through importFromContent
 * (which would compute embeddings if a model is configured).
 */
async function seedNullChunks(opts: {
  sourceId: string;
  pageCount: number;
  chunksPerPage: number;
  slugPrefix: string;
}) {
  const sql = getConn();
  // Bulk-insert all pages in one round-trip via unnest, then bulk-insert
  // all chunks. Avoids 3000+ sequential round-trips on the "static case"
  // seed which would otherwise blow the test's 5s default timeout.
  const slugs = Array.from({ length: opts.pageCount }, (_, p) =>
    `${opts.slugPrefix}-${p.toString().padStart(4, '0')}`,
  );
  const titles = slugs;
  const sourceIds = slugs.map(() => opts.sourceId);
  const pageRows = await sql`
    INSERT INTO pages (slug, title, type, compiled_truth, timeline, frontmatter, source_id)
    SELECT s, t, 'page', '', '', '{}'::jsonb, src
    FROM unnest(${sql.array(slugs)}::text[], ${sql.array(titles)}::text[], ${sql.array(sourceIds)}::text[]) AS u(s, t, src)
    RETURNING id, slug
  `;
  const slugToId = new Map<string, number>();
  for (const r of pageRows as unknown as Array<{ id: number; slug: string }>) {
    slugToId.set(r.slug, r.id);
  }
  // Build the flat (page_id, chunk_index, chunk_text) arrays.
  const pageIds: number[] = [];
  const indices: number[] = [];
  const texts: string[] = [];
  for (let p = 0; p < opts.pageCount; p++) {
    const slug = slugs[p];
    const pid = slugToId.get(slug);
    if (pid === undefined) throw new Error(`seed: missing pageId for ${slug}`);
    for (let c = 0; c < opts.chunksPerPage; c++) {
      pageIds.push(pid);
      indices.push(c);
      texts.push(`chunk-${p}-${c}`);
    }
  }
  // `model` column is NOT NULL with a default ('text-embedding-3-large')
  // — omit it from the INSERT so the default applies. `embedding` is
  // nullable; we intentionally leave it NULL so the chunk is "stale".
  await sql`
    INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, token_count, embedding, embedded_at)
    SELECT pid, idx, txt, 'compiled_truth', 5, NULL, NULL
    FROM unnest(${sql.array(pageIds)}::int[], ${sql.array(indices)}::int[], ${sql.array(texts)}::text[]) AS u(pid, idx, txt)
  `;
}

/** Ensure the migration v66 partial index exists in the seeded DB. */
async function indexExists(name: string): Promise<boolean> {
  const sql = getConn();
  const rows = await sql`
    SELECT 1 FROM pg_indexes WHERE indexname = ${name}
  `;
  return rows.length > 0;
}

describeE2E('embed --stale cursor pagination (D7 + REGRESSION)', () => {
  beforeAll(async () => {
    await setupDB();
    // setupDB() seeds one default source; D7 cases add a second source
    // via raw SQL on demand.
  });

  afterAll(async () => {
    // setupDB's ALL_TABLES truncate list does NOT include `sources`
    // (the `default` row is treated as fixed). This test adds an
    // `other-source` row for the D7 cases; clean it up so later tests
    // running on the same DB don't see a never-synced source (which
    // mechanical.test.ts:`gbrain doctor` would correctly fail on).
    try {
      await getConn()`DELETE FROM sources WHERE id <> 'default'`;
    } catch {
      // If the connection is already torn down, that's fine.
    }
    await teardownDB();
  });

  test('migration v66 created partial index idx_chunks_embedding_null', async () => {
    const exists = await indexExists('idx_chunks_embedding_null');
    expect(exists).toBe(true);
  });

  test('static case: every chunk visited exactly once across multiple batches', async () => {
    const engine = getEngine();
    // Truncate so other tests don't bleed in.
    await getConn()`TRUNCATE content_chunks, pages CASCADE`;
    // Seed PAGE_SIZE + 500 chunks to force at least 2 cursor pages.
    const TOTAL_PAGES = Math.ceil((PAGE_SIZE + 500) / 5); // 5 chunks/page
    const CHUNKS_PER_PAGE = 5;
    await seedNullChunks({
      sourceId: 'default',
      pageCount: TOTAL_PAGES,
      chunksPerPage: CHUNKS_PER_PAGE,
      slugPrefix: 'static-case',
    });
    const expectedTotal = TOTAL_PAGES * CHUNKS_PER_PAGE;

    const count = await engine.countStaleChunks();
    expect(count).toBe(expectedTotal);

    // Walk the cursor manually (production code in embedAllStale does
    // the same; we re-implement the loop here so the test asserts on
    // the engine contract, not the caller's wrapper).
    const visited = new Set<string>();
    let lastPageId = -1;
    let lastChunkIndex = -1;
    let afterPageId = 0;
    let afterChunkIndex = -1;
    let cursorMonotonic = true;
    let batchCount = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await engine.listStaleChunks({
        batchSize: PAGE_SIZE,
        afterPageId,
        afterChunkIndex,
      });
      if (batch.length === 0) break;
      batchCount++;
      for (const row of batch) {
        const key = `${row.page_id}::${row.chunk_index}`;
        // No duplicate visits.
        expect(visited.has(key)).toBe(false);
        visited.add(key);
        // Monotonic advance on (page_id, chunk_index).
        const adv = row.page_id > lastPageId
          || (row.page_id === lastPageId && row.chunk_index > lastChunkIndex);
        if (!adv) cursorMonotonic = false;
        lastPageId = row.page_id;
        lastChunkIndex = row.chunk_index;
      }
      const tail = batch[batch.length - 1];
      afterPageId = tail.page_id;
      afterChunkIndex = tail.chunk_index;
      if (batch.length < PAGE_SIZE) break;
    }

    expect(visited.size).toBe(expectedTotal);
    expect(cursorMonotonic).toBe(true);
    expect(batchCount).toBeGreaterThanOrEqual(2); // forced split
  });

  test('source-scoped scan only returns the target source (D7)', async () => {
    const engine = getEngine();
    await getConn()`TRUNCATE content_chunks, pages CASCADE`;
    // Insert the second source row (default already exists from setupDB).
    await getConn()`
      INSERT INTO sources (id, name, local_path)
      VALUES ('other-source', 'other-source', '/tmp/other')
      ON CONFLICT (id) DO NOTHING
    `;
    // Same slug-prefix in both sources to verify the filter is true source
    // separation, not slug separation.
    await seedNullChunks({ sourceId: 'default', pageCount: 3, chunksPerPage: 2, slugPrefix: 'shared' });
    await seedNullChunks({ sourceId: 'other-source', pageCount: 5, chunksPerPage: 2, slugPrefix: 'shared' });

    // Global count: 8 pages × 2 chunks = 16.
    expect(await engine.countStaleChunks()).toBe(16);
    // Default-only: 3 × 2 = 6.
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(6);
    // Other-only: 5 × 2 = 10.
    expect(await engine.countStaleChunks({ sourceId: 'other-source' })).toBe(10);

    // listStaleChunks should return ONLY the requested source.
    const defaultRows = await engine.listStaleChunks({ sourceId: 'default', batchSize: 100 });
    expect(defaultRows).toHaveLength(6);
    for (const row of defaultRows) expect(row.source_id).toBe('default');

    const otherRows = await engine.listStaleChunks({ sourceId: 'other-source', batchSize: 100 });
    expect(otherRows).toHaveLength(10);
    for (const row of otherRows) expect(row.source_id).toBe('other-source');
  });

  test('duplicate slug across sources: cursor on (page_id, chunk_index) keeps them separate', async () => {
    const engine = getEngine();
    await getConn()`TRUNCATE content_chunks, pages CASCADE`;
    await getConn()`
      INSERT INTO sources (id, name, local_path)
      VALUES ('other-source', 'other-source', '/tmp/other')
      ON CONFLICT (id) DO NOTHING
    `;
    // Same slug, different sources.
    await seedNullChunks({ sourceId: 'default', pageCount: 1, chunksPerPage: 3, slugPrefix: 'collide' });
    await seedNullChunks({ sourceId: 'other-source', pageCount: 1, chunksPerPage: 3, slugPrefix: 'collide' });

    const allRows = await engine.listStaleChunks({ batchSize: 100 });
    expect(allRows).toHaveLength(6);
    const seen = new Set<string>();
    for (const row of allRows) {
      // Each (source_id, slug, chunk_index) is unique.
      const key = `${row.source_id}::${row.slug}::${row.chunk_index}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Two distinct source_ids.
    const sourceIds = new Set(allRows.map(r => r.source_id));
    expect(sourceIds.size).toBe(2);
  });

  test('failed embedding stays NULL; next run picks it up', async () => {
    const engine = getEngine();
    await getConn()`TRUNCATE content_chunks, pages CASCADE`;
    await seedNullChunks({ sourceId: 'default', pageCount: 1, chunksPerPage: 3, slugPrefix: 'fail-case' });

    // First walk — simulate that we read all 3 chunks but did not upsert
    // anything (i.e. the embedding step "failed" for every page). Cursor
    // advance is observed; the chunks should still be NULL.
    const firstRun = await engine.listStaleChunks({ batchSize: 100 });
    expect(firstRun).toHaveLength(3);

    // Verify the NULL rows are still there.
    expect(await engine.countStaleChunks()).toBe(3);

    // Second walk picks them up because the partial index still finds them.
    const secondRun = await engine.listStaleChunks({ batchSize: 100 });
    expect(secondRun).toHaveLength(3);
    // Same (page_id, chunk_index) set.
    const firstKeys = new Set(firstRun.map(r => `${r.page_id}::${r.chunk_index}`));
    const secondKeys = new Set(secondRun.map(r => `${r.page_id}::${r.chunk_index}`));
    expect(firstKeys).toEqual(secondKeys);
  });

  test('page split across batches: a multi-chunk page can land in two cursor pages', async () => {
    const engine = getEngine();
    await getConn()`TRUNCATE content_chunks, pages CASCADE`;
    // One page with 5 chunks; use batchSize=2 to force splits.
    await seedNullChunks({ sourceId: 'default', pageCount: 1, chunksPerPage: 5, slugPrefix: 'split' });
    const visited: number[] = [];
    let after_pid = 0;
    let after_idx = -1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await engine.listStaleChunks({
        batchSize: 2,
        afterPageId: after_pid,
        afterChunkIndex: after_idx,
      });
      if (batch.length === 0) break;
      for (const r of batch) visited.push(r.chunk_index);
      const tail = batch[batch.length - 1];
      after_pid = tail.page_id;
      after_idx = tail.chunk_index;
      if (batch.length < 2) break;
    }
    expect(visited).toEqual([0, 1, 2, 3, 4]);
  });
});
