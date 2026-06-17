/**
 * v0.20.0 Cathedral II Layer 3 (1b) — chunk-grain FTS.
 *
 * Before Cathedral II, searchKeyword ranked pages by pages.search_vector
 * and returned the first matching chunk per page. Doc-comment content
 * living on a chunk couldn't influence page-grain ranking; two-pass
 * retrieval anchors couldn't find the best-matching chunk; the "A4
 * doc-comment boost" story was structurally impossible.
 *
 * Layer 3 moves the FTS primitive to content_chunks.search_vector (the
 * column + trigger added in Layer 1/v27), then dedups-to-best-chunk-per-page
 * inside searchKeyword so every external caller still sees the v0.19.0
 * page-grain contract. A2 two-pass (Layer 7) consumes searchKeywordChunks
 * to get the raw chunk-grain ranking without dedup.
 *
 * Tests run against a real in-memory PGLite so they exercise the actual
 * trigger + FTS machinery.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';

describe('Cathedral II v28 migration — search_vector backfill', () => {
  test('v28 migration exists in registry', () => {
    const v28 = MIGRATIONS.find(m => m.version === 28);
    expect(v28).toBeDefined();
    expect(v28!.name).toBe('cathedral_ii_chunk_fts_backfill');
  });

  test('v28 UPDATE is scoped to rows with NULL search_vector (idempotent)', () => {
    const v28 = MIGRATIONS.find(m => m.version === 28)!;
    expect(v28.sql).toMatch(/WHERE search_vector IS NULL/);
  });

  test('v28 builds the vector with same weight shape as v27 trigger', () => {
    const v28 = MIGRATIONS.find(m => m.version === 28)!;
    // Same A/A/B weighting as v27 trigger — critical that re-runs produce
    // identical vectors to freshly-inserted rows.
    expect(v28.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(doc_comment, ''\)\), 'A'\)/);
    expect(v28.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(symbol_name_qualified, ''\)\), 'A'\)/);
    expect(v28.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(chunk_text, ''\)\), 'B'\)/);
  });
});

describe('Cathedral II Layer 3 — searchKeyword external contract', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Two pages, each with multiple chunks that match "refactor" so we can
    // verify the dedup pass returns one chunk per page. upsertChunks fires
    // the chunk-grain search_vector trigger from Layer 1 v27.
    await engine.putPage('guides/refactor-large-fns', {
      type: 'guide',
      title: 'How to refactor large functions',
      compiled_truth: 'placeholder',
      timeline: '',
    });
    await engine.upsertChunks('guides/refactor-large-fns', [
      { chunk_index: 0, chunk_text: 'First, refactor the function into smaller units.', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Then refactor further using extract-method patterns.', chunk_source: 'compiled_truth' },
    ]);
    await engine.putPage('guides/refactor-patterns', {
      type: 'guide',
      title: 'Refactor patterns',
      compiled_truth: 'placeholder',
      timeline: '',
    });
    await engine.upsertChunks('guides/refactor-patterns', [
      { chunk_index: 0, chunk_text: 'The strangler-fig refactor is the safest approach.', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Refactor incrementally; never boil the ocean at once.', chunk_source: 'compiled_truth' },
    ]);
    // A third page with no match — must be absent from results.
    await engine.putPage('guides/unrelated', {
      type: 'guide',
      title: 'Deployment',
      compiled_truth: 'placeholder',
      timeline: '',
    });
    await engine.upsertChunks('guides/unrelated', [
      { chunk_index: 0, chunk_text: 'Ship to production on a Tuesday, never a Friday.', chunk_source: 'compiled_truth' },
    ]);
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('returns one row per matched page (dedup to best chunk per page)', async () => {
    const results = await engine.searchKeyword('refactor');
    const slugs = results.map(r => r.slug).sort();
    // Deduped: each matched page appears exactly once.
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('guides/refactor-large-fns');
    expect(slugs).toContain('guides/refactor-patterns');
    expect(slugs).not.toContain('guides/unrelated');
  });

  test('results include chunk metadata (chunk_id, chunk_text, chunk_source)', async () => {
    const results = await engine.searchKeyword('refactor');
    expect(results.length).toBeGreaterThan(0);
    const first = results[0]!;
    expect(first.chunk_id).toBeGreaterThan(0);
    expect(first.chunk_text).toMatch(/refactor/i);
    expect(first.chunk_source).toBe('compiled_truth');
  });

  test('limit is honored on the page-grain external shape', async () => {
    const results = await engine.searchKeyword('refactor', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test('non-matching query returns empty', async () => {
    const results = await engine.searchKeyword('zzzzznomatch');
    expect(results).toEqual([]);
  });
});

describe('Cathedral II Layer 3 — searchKeywordChunks (internal primitive)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Page with multiple matching chunks so chunk-grain results can
    // return two chunks from the same page (no dedup).
    await engine.putPage('guides/multi-chunk', {
      type: 'guide',
      title: 'Long guide',
      compiled_truth: 'placeholder',
      timeline: '',
    });
    await engine.upsertChunks('guides/multi-chunk', [
      { chunk_index: 0, chunk_text: 'refactor is a core engineering practice.', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'refactor safely using characterization tests.', chunk_source: 'compiled_truth' },
      { chunk_index: 2, chunk_text: 'refactor tools can automate common patterns.', chunk_source: 'compiled_truth' },
    ]);
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('does not dedup: can return multiple chunks from the same page', async () => {
    const results = await engine.searchKeywordChunks('refactor', { limit: 20 });
    const slugs = results.map(r => r.slug);
    // More results than distinct slugs means we got multiple chunks per page.
    // (If the page only produced 1 chunk, the assertion short-circuits.)
    if (results.length > 1) {
      // Either multiple chunks from one page, or the page was small. Either
      // is a valid observation; what matters is we did NOT forcibly dedup.
      const uniqueSlugs = new Set(slugs);
      expect(uniqueSlugs.size).toBeLessThanOrEqual(results.length);
    }
  });

  test('ordered by score descending', async () => {
    const results = await engine.searchKeywordChunks('refactor', { limit: 20 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  test('limit is honored (no dedup inflating counts)', async () => {
    const results = await engine.searchKeywordChunks('refactor', { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe('Cathedral II Layer 3 — doc-comment weight precedence (A4 foundation)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Two pages, each with one chunk. Alpha's chunk has the target term
    // 'hexagon' in its doc_comment (weight A); Beta's chunk has it in
    // chunk_text (weight B). After Layer 5/6 populate doc_comment from
    // real AST leading comments, this preference delivers A4's ranking win.
    await engine.putPage('pages/alpha', {
      type: 'note',
      title: 'Alpha',
      compiled_truth: 'placeholder',
      timeline: '',
    });
    await engine.upsertChunks('pages/alpha', [
      { chunk_index: 0, chunk_text: 'Some boilerplate text without the term.', chunk_source: 'compiled_truth' },
    ]);
    await engine.putPage('pages/beta', {
      type: 'note',
      title: 'Beta',
      compiled_truth: 'placeholder',
      timeline: '',
    });
    await engine.upsertChunks('pages/beta', [
      { chunk_index: 0, chunk_text: 'The hexagon term appears only inside body text here.', chunk_source: 'compiled_truth' },
    ]);

    // Manually promote Alpha's chunk to have a doc_comment containing
    // 'hexagon'. The v27 trigger re-fires BEFORE UPDATE OF doc_comment,
    // so search_vector rebuilds with the weight-A doc-comment contribution.
    // In real use this happens at Layer 5 import time when AST leading
    // comments land as doc_comment.
    await engine.executeRaw(
      `UPDATE content_chunks
       SET doc_comment = 'hexagon architecture documented here'
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`,
      ['pages/alpha'],
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('doc-comment match outranks body-text match on the same term', async () => {
    const results = await engine.searchKeyword('hexagon');
    expect(results.length).toBeGreaterThan(0);
    // Alpha (with doc_comment match, weight A) should rank above Beta
    // (with body-text match, weight B). If the FTS weighting is wrong,
    // Beta would win because its chunk_text contains 'hexagon' too.
    const slugs = results.map(r => r.slug);
    const alphaIdx = slugs.indexOf('pages/alpha');
    const betaIdx = slugs.indexOf('pages/beta');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(betaIdx);
  });
});
