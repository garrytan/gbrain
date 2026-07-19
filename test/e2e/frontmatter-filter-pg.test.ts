/**
 * v0.42.63 — frontmatter-field filter, real-Postgres parity (U1).
 *
 * PGLite cannot surface the postgres.js bind-path bug classes, so this file
 * is the backstop for the three shapes the shared compiler emits against a
 * real Postgres:
 *   - `@>` containment bound via `$N::text::jsonb` (positional search
 *     paths) and via `sql.json()` (the listPages tagged-template path).
 *     A double-encoded bind (the #2339 class) would make containment
 *     silently match NOTHING — the eq tests here would fail loudly.
 *   - the jsonb `?` operator with a bound text key (exists / missing).
 *   - `->>` text comparison with bound key + value (lt/lte/gt/gte).
 *
 * Gated by DATABASE_URL — skips gracefully without a real Postgres
 * (same convention as test/e2e/engine-parity.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describePg = SKIP_PG ? describe.skip : describe;

const SHARED = 'frontmatter-filter-pg-target-xyz';

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

describePg('frontmatter filter — real Postgres', () => {
  let pg: PostgresEngine;

  beforeAll(async () => {
    pg = await setupDB();

    const seed: Array<{
      slug: string;
      title: string;
      frontmatter: Record<string, unknown>;
      embIdx: number;
    }> = [
      {
        slug: 'wiki/projects/alpha',
        title: 'Project Alpha',
        frontmatter: { status: 'active', priority: 1, review_by: '2026-07-01' },
        embIdx: 10,
      },
      {
        slug: 'wiki/projects/beta',
        title: 'Project Beta',
        frontmatter: { status: 'paused', review_by: '2026-12-31' },
        embIdx: 11,
      },
      {
        slug: 'wiki/decisions/d1',
        title: 'Decision One',
        frontmatter: { decided: true },
        embIdx: 12,
      },
      {
        slug: 'wiki/decisions/d2',
        title: 'Decision Two',
        frontmatter: { decided: true, actual_outcome: 'worked' },
        embIdx: 13,
      },
    ];
    for (const s of seed) {
      await pg.putPage(s.slug, {
        type: 'note',
        title: s.title,
        compiled_truth: `${s.title} mentions ${SHARED}.`,
        frontmatter: s.frontmatter,
      });
      await pg.upsertChunks(s.slug, [
        {
          chunk_index: 0,
          chunk_text: `${s.title} mentions ${SHARED}.`,
          chunk_source: 'compiled_truth',
          embedding: basisEmbedding(s.embIdx),
          token_count: 10,
        },
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    await teardownDB();
  });

  describe('searchKeyword (positional $N::text::jsonb bind path)', () => {
    test('no filter: all four pages match', async () => {
      const results = await pg.searchKeyword(SHARED, { limit: 10 });
      expect(results.length).toBe(4);
    });

    test('eq string containment — the double-encode canary', async () => {
      const results = await pg.searchKeyword(SHARED, {
        limit: 10,
        frontmatterFilter: [{ key: 'status', op: 'eq', value: 'active' }],
      });
      // If the jsonb param double-encoded (string scalar instead of object),
      // @> would match nothing and this would be [].
      expect(results.map((r) => r.slug)).toEqual(['wiki/projects/alpha']);
    });

    test('eq is type-sensitive on jsonb numbers', async () => {
      const num = await pg.searchKeyword(SHARED, {
        limit: 10,
        frontmatterFilter: [{ key: 'priority', op: 'eq', value: 1 }],
      });
      expect(num.map((r) => r.slug)).toEqual(['wiki/projects/alpha']);
      const str = await pg.searchKeyword(SHARED, {
        limit: 10,
        frontmatterFilter: [{ key: 'priority', op: 'eq', value: '1' }],
      });
      expect(str.length).toBe(0);
    });

    test('exists / missing via the jsonb ? operator with a bound key', async () => {
      const missing = await pg.searchKeyword(SHARED, {
        limit: 10,
        frontmatterFilter: [
          { key: 'decided', op: 'eq', value: true },
          { key: 'actual_outcome', op: 'missing' },
        ],
      });
      expect(missing.map((r) => r.slug)).toEqual(['wiki/decisions/d1']);
      const exists = await pg.searchKeyword(SHARED, {
        limit: 10,
        frontmatterFilter: [
          { key: 'decided', op: 'eq', value: true },
          { key: 'actual_outcome', op: 'exists' },
        ],
      });
      expect(exists.map((r) => r.slug)).toEqual(['wiki/decisions/d2']);
    });

    test('lt ISO-date text comparison + AND-combination', async () => {
      const pastDue = await pg.searchKeyword(SHARED, {
        limit: 10,
        frontmatterFilter: [{ key: 'review_by', op: 'lt', value: '2026-07-18' }],
      });
      expect(pastDue.map((r) => r.slug)).toEqual(['wiki/projects/alpha']);

      const contradiction = await pg.searchKeyword(SHARED, {
        limit: 10,
        frontmatterFilter: [
          { key: 'status', op: 'eq', value: 'paused' },
          { key: 'review_by', op: 'lt', value: '2026-07-18' },
        ],
      });
      expect(contradiction.length).toBe(0);
    });
  });

  describe('searchVector (filter inside the HNSW candidate CTE)', () => {
    test('eq excludes non-matching pages', async () => {
      const results = await pg.searchVector(basisEmbedding(10), {
        limit: 10,
        frontmatterFilter: [{ key: 'status', op: 'eq', value: 'active' }],
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) expect(r.slug).toBe('wiki/projects/alpha');
    });

    test('gte keeps only the future review date', async () => {
      const results = await pg.searchVector(basisEmbedding(11), {
        limit: 10,
        frontmatterFilter: [{ key: 'review_by', op: 'gte', value: '2026-07-18' }],
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) expect(r.slug).toBe('wiki/projects/beta');
    });
  });

  describe('listPages (postgres.js tagged-template path: sql.json + ? + ->>)', () => {
    test('eq via sql.json containment', async () => {
      const pages = await pg.listPages({
        frontmatterFilter: [{ key: 'status', op: 'eq', value: 'active' }],
      });
      expect(pages.map((p) => p.slug)).toEqual(['wiki/projects/alpha']);
    });

    test('missing + exists split the decision pages', async () => {
      const missing = await pg.listPages({
        frontmatterFilter: [
          { key: 'decided', op: 'eq', value: true },
          { key: 'actual_outcome', op: 'missing' },
        ],
      });
      expect(missing.map((p) => p.slug)).toEqual(['wiki/decisions/d1']);
      const exists = await pg.listPages({
        frontmatterFilter: [
          { key: 'decided', op: 'eq', value: true },
          { key: 'actual_outcome', op: 'exists' },
        ],
      });
      expect(exists.map((p) => p.slug)).toEqual(['wiki/decisions/d2']);
    });

    test('lt comparison on the tagged-template path', async () => {
      const pages = await pg.listPages({
        frontmatterFilter: [{ key: 'review_by', op: 'lt', value: '2026-07-18' }],
      });
      expect(pages.map((p) => p.slug)).toEqual(['wiki/projects/alpha']);
    });

    test('no filter returns all pages (absent param leaves behavior unchanged)', async () => {
      const pages = await pg.listPages({});
      expect(pages.length).toBe(4);
    });
  });
});
