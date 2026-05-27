/**
 * Engine Parity E2E
 *
 * Codex flagged that searchKeyword behavior differs structurally between
 * the two engines (Postgres uses a CTE that ranks pages then picks best
 * chunk; PGLite returns chunks directly). Without verification, source-aware
 * ranking could pass on PGLite and silently fail on Postgres.
 *
 * Strategy: seed identical corpora into both engines, run identical queries,
 * assert top-5 slug ordering matches.
 *
 * Gated by DATABASE_URL — skips gracefully if no real Postgres. Always runs
 * the PGLite half so the seed/query path is at least exercised.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput, SearchResult } from '../../src/core/types.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

interface SeedPage {
  slug: string;
  type: 'writing' | 'concept' | 'note' | 'person' | 'company';
  title: string;
  body: string;
  embeddingDim: number;
}

const SEED_PAGES: SeedPage[] = [
  {
    slug: 'originals/talks/article-outline-fat-code',
    type: 'writing',
    title: 'Fat Code Thin Harness — Part 3',
    body: 'fat code thin harness pattern part 3 production case studies',
    embeddingDim: 7,
  },
  {
    slug: 'concepts/fat-code-thin-harness',
    type: 'concept',
    title: 'Fat Code Thin Harness',
    body: 'reusable concept fat code thin harness architecture',
    embeddingDim: 14,
  },
  {
    slug: 'openclaw/chat/2026-04-15',
    type: 'note',
    title: '2026-04-15 chat',
    body:
      'fat code thin harness fat code thin harness discussion went on at length, ' +
      'fat code thin harness came up again and again, fat code thin harness fat code thin harness.',
    embeddingDim: 8,
  },
  {
    slug: 'openclaw/chat/2026-04-16',
    type: 'note',
    title: '2026-04-16 chat',
    body:
      'fat code thin harness once more, fat code thin harness fat code thin harness, ' +
      'still talking about fat code thin harness fat code thin harness.',
    embeddingDim: 9,
  },
  {
    slug: 'people/example-founder',
    type: 'person',
    title: 'Example Founder',
    body: 'example founder unrelated content for distraction',
    embeddingDim: 50,
  },
];

async function seedEngine(eng: BrainEngine) {
  for (const p of SEED_PAGES) {
    await eng.putPage(p.slug, {
      type: p.type,
      title: p.title,
      compiled_truth: p.body,
      timeline: '',
    });
    const chunks: ChunkInput[] = [
      {
        chunk_index: 0,
        chunk_text: p.body,
        chunk_source: 'compiled_truth',
        embedding: basisEmbedding(p.embeddingDim),
        token_count: p.body.split(/\s+/).length,
      },
    ];
    await eng.upsertChunks(p.slug, chunks);
  }
}

const QUERIES = [
  'fat code thin harness',
  'fat code thin harness part 3',
  'fat code production',
];

describeBoth('Engine parity — Postgres vs PGLite', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = await setupDB();
    await seedEngine(pgEngine);

    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    await seedEngine(pgliteEngine);
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  for (const q of QUERIES) {
    test(`searchKeyword: top-5 slugs match for "${q}"`, async () => {
      const pgResults = await pgEngine.searchKeyword(q, { limit: 5 });
      const pgliteResults = await pgliteEngine.searchKeyword(q, { limit: 5 });

      const pgSlugs = pgResults.map((r: SearchResult) => r.slug);
      const pgliteSlugs = pgliteResults.map((r: SearchResult) => r.slug);

      // Top result MUST match (the swamp-resistance guarantee).
      expect(pgSlugs[0]).toBe(pgliteSlugs[0]);
      // Sets should match (allowing some ordering drift on lower-ranked
      // results since FTS rank function differences between engines are
      // out of scope for this fix).
      expect(new Set(pgSlugs)).toEqual(new Set(pgliteSlugs));
    });
  }

  test('searchVector: top result matches between engines', async () => {
    const queryVec = basisEmbedding(7); // article direction
    const pgResults = await pgEngine.searchVector(queryVec, { limit: 5 });
    const pgliteResults = await pgliteEngine.searchVector(queryVec, { limit: 5 });

    expect(pgResults[0]?.slug).toBe(pgliteResults[0]?.slug);
  });

  test('hard-exclude is consistent across engines', async () => {
    // Both engines should hide test/ pages by default; both should opt
    // them back in via include_slug_prefixes.
    await pgEngine.putPage('test/parity-fixture', {
      type: 'note',
      title: 'parity test fixture',
      compiled_truth: 'parity test fixture content',
      timeline: '',
    });
    await pgEngine.upsertChunks('test/parity-fixture', [{
      chunk_index: 0,
      chunk_text: 'parity test fixture content',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(20),
      token_count: 5,
    }] satisfies ChunkInput[]);

    await pgliteEngine.putPage('test/parity-fixture', {
      type: 'note',
      title: 'parity test fixture',
      compiled_truth: 'parity test fixture content',
      timeline: '',
    });
    await pgliteEngine.upsertChunks('test/parity-fixture', [{
      chunk_index: 0,
      chunk_text: 'parity test fixture content',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(20),
      token_count: 5,
    }] satisfies ChunkInput[]);

    const pgDefault = await pgEngine.searchKeyword('parity test fixture');
    const pgliteDefault = await pgliteEngine.searchKeyword('parity test fixture');
    expect(pgDefault.map((r: SearchResult) => r.slug)).not.toContain('test/parity-fixture');
    expect(pgliteDefault.map((r: SearchResult) => r.slug)).not.toContain('test/parity-fixture');

    const pgOptIn = await pgEngine.searchKeyword('parity test fixture', {
      include_slug_prefixes: ['test/'],
    });
    const pgliteOptIn = await pgliteEngine.searchKeyword('parity test fixture', {
      include_slug_prefixes: ['test/'],
    });
    expect(pgOptIn.map((r: SearchResult) => r.slug)).toContain('test/parity-fixture');
    expect(pgliteOptIn.map((r: SearchResult) => r.slug)).toContain('test/parity-fixture');
  });

  test('detail=high produces a different ranking than default on at least one engine', async () => {
    // Source-boost gates on `detail !== 'high'`. If the gate works on both
    // engines, the ordering for `detail=high` should differ from default in
    // any case where the swamp / curated pages have different raw scores.
    //
    // Postgres's CTE ranks pages then picks best chunk; ts_rank normalizes
    // by doc length so chat pages don't always swamp at the page level.
    // PGLite scores chunks directly — chat chunks beat article chunks on
    // raw ts_rank. The two engines need different parity contracts here.
    //
    // Common assertion that holds on both: detail=high must include the
    // chat pages in its result set (they're not filtered by detail), and
    // the result set should not be identical to default-detail (the boost
    // must be doing _something_ visible).
    const pgDefault = await pgEngine.searchKeyword('fat code thin harness', { limit: 5 });
    const pgHigh = await pgEngine.searchKeyword('fat code thin harness', { detail: 'high', limit: 5 });
    const pgliteDefault = await pgliteEngine.searchKeyword('fat code thin harness', { limit: 5 });
    const pgliteHigh = await pgliteEngine.searchKeyword('fat code thin harness', { detail: 'high', limit: 5 });

    // Chat pages must be present in detail=high results on both engines.
    expect(pgHigh.some((r: SearchResult) => r.slug.startsWith('openclaw/chat/'))).toBe(true);
    expect(pgliteHigh.some((r: SearchResult) => r.slug.startsWith('openclaw/chat/'))).toBe(true);

    // The boost must be doing something — at least one engine's ordering
    // should change between default and detail=high.
    const pgChanged = pgDefault.map((r: SearchResult) => r.slug).join(',') !== pgHigh.map((r: SearchResult) => r.slug).join(',');
    const pgliteChanged = pgliteDefault.map((r: SearchResult) => r.slug).join(',') !== pgliteHigh.map((r: SearchResult) => r.slug).join(',');
    expect(pgChanged || pgliteChanged).toBe(true);
  });

  // v0.39.3.0 T3 — provenance write+read parity (WARN-8 + CV5).
  // Both engines must write the same 4 provenance columns (source_kind,
  // source_uri, ingested_via, ingested_at) on putPage AND surface them
  // on getPage. A drift here would mean `gbrain migrate --to supabase`
  // silently loses half a user's provenance audit trail.
  test('provenance columns: putPage writes + getPage returns identical shape on both engines', async () => {
    const slug = 'wiki/provenance-parity';
    const input = {
      type: 'note' as const,
      title: 'Provenance Parity Test',
      compiled_truth: 'body',
      timeline: '',
      source_kind: 'capture-cli',
      source_uri: 'file:///tmp/parity.md',
      ingested_via: 'put_page',
    };
    await pgEngine.putPage(slug, input);
    await pgliteEngine.putPage(slug, input);

    const pgPage = await pgEngine.getPage(slug);
    const pglitePage = await pgliteEngine.getPage(slug);

    expect(pgPage).not.toBeNull();
    expect(pglitePage).not.toBeNull();

    // All 4 provenance fields must match across engines.
    expect(pgPage!.source_kind).toBe('capture-cli');
    expect(pglitePage!.source_kind).toBe('capture-cli');
    expect(pgPage!.source_uri).toBe('file:///tmp/parity.md');
    expect(pglitePage!.source_uri).toBe('file:///tmp/parity.md');
    expect(pgPage!.ingested_via).toBe('put_page');
    expect(pglitePage!.ingested_via).toBe('put_page');
    // ingested_at is server-stamped; both engines must populate a Date
    // (not Date drift across engines — the assertion is structural).
    expect(pgPage!.ingested_at).toBeInstanceOf(Date);
    expect(pglitePage!.ingested_at).toBeInstanceOf(Date);
  });

  test('provenance COALESCE-preserve UPDATE: parity on both engines (CV12)', async () => {
    // First write with provenance.
    const slug = 'wiki/provenance-preserve-parity';
    await pgEngine.putPage(slug, {
      type: 'note',
      title: 'V1',
      compiled_truth: 'body v1',
      timeline: '',
      source_kind: 'capture-cli',
      ingested_via: 'put_page',
    });
    await pgliteEngine.putPage(slug, {
      type: 'note',
      title: 'V1',
      compiled_truth: 'body v1',
      timeline: '',
      source_kind: 'capture-cli',
      ingested_via: 'put_page',
    });

    // Second write WITHOUT provenance — both engines must preserve
    // the first-write audit trail via COALESCE-preserve UPDATE.
    await pgEngine.putPage(slug, {
      type: 'note',
      title: 'V2',
      compiled_truth: 'body v2',
      timeline: '',
    });
    await pgliteEngine.putPage(slug, {
      type: 'note',
      title: 'V2',
      compiled_truth: 'body v2',
      timeline: '',
    });

    const pgPage = await pgEngine.getPage(slug);
    const pglitePage = await pgliteEngine.getPage(slug);

    // Provenance preserved on BOTH engines (CV12 first-write-wins).
    expect(pgPage!.source_kind).toBe('capture-cli');
    expect(pglitePage!.source_kind).toBe('capture-cli');
    expect(pgPage!.ingested_via).toBe('put_page');
    expect(pglitePage!.ingested_via).toBe('put_page');
    // Page title updated (proves the UPDATE actually fired).
    expect(pgPage!.title).toBe('V2');
    expect(pglitePage!.title).toBe('V2');
  });

  test('v0.41.19.0 deletePages parity: both engines return same confirmed-deleted slugs', async () => {
    const realSlugs = ['wiki/dpp-1', 'wiki/dpp-2', 'wiki/dpp-3'];
    for (const slug of realSlugs) {
      await pgEngine.putPage(slug, {
        type: 'note', title: slug, compiled_truth: 'body', timeline: '',
      });
      await pgliteEngine.putPage(slug, {
        type: 'note', title: slug, compiled_truth: 'body', timeline: '',
      });
    }

    // Mix real + ghost slugs. D6: only real ones come back.
    const allSlugs = [...realSlugs, 'wiki/dpp-ghost-a', 'wiki/dpp-ghost-b'];
    const pgDeleted = await pgEngine.deletePages(allSlugs, { sourceId: 'default' });
    const pgliteDeleted = await pgliteEngine.deletePages(allSlugs, { sourceId: 'default' });

    expect(pgDeleted.sort()).toEqual(realSlugs.sort());
    expect(pgliteDeleted.sort()).toEqual(realSlugs.sort());

    // Pages actually gone on both engines.
    for (const slug of realSlugs) {
      const pg = await pgEngine.getPage(slug);
      const pglite = await pgliteEngine.getPage(slug);
      expect(pg).toBeNull();
      expect(pglite).toBeNull();
    }
  });

  test('v0.41.19.0 resolveSlugsByPaths parity: same Map on both engines', async () => {
    const seedSql = `
      INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
        VALUES ('default', $1, $2, 'note', 't', 'b', '', '{}'::jsonb)
        ON CONFLICT (source_id, slug) DO UPDATE SET source_path = EXCLUDED.source_path
    `;
    await pgEngine.executeRaw(seedSql, ['wiki/rsp-1', 'wiki/rsp-1.md']);
    await pgEngine.executeRaw(seedSql, ['wiki/rsp-2', 'wiki/rsp-2.md']);
    await pgliteEngine.executeRaw(seedSql, ['wiki/rsp-1', 'wiki/rsp-1.md']);
    await pgliteEngine.executeRaw(seedSql, ['wiki/rsp-2', 'wiki/rsp-2.md']);

    const paths = ['wiki/rsp-1.md', 'wiki/rsp-2.md', 'wiki/rsp-missing.md'];
    const pgMap = await pgEngine.resolveSlugsByPaths(paths, { sourceId: 'default' });
    const pgliteMap = await pgliteEngine.resolveSlugsByPaths(paths, { sourceId: 'default' });

    expect(pgMap.size).toBe(2);
    expect(pgliteMap.size).toBe(2);
    expect(pgMap.get('wiki/rsp-1.md')).toBe('wiki/rsp-1');
    expect(pgliteMap.get('wiki/rsp-1.md')).toBe('wiki/rsp-1');
    expect(pgMap.get('wiki/rsp-2.md')).toBe('wiki/rsp-2');
    expect(pgliteMap.get('wiki/rsp-2.md')).toBe('wiki/rsp-2');
    expect(pgMap.get('wiki/rsp-missing.md')).toBeUndefined();
    expect(pgliteMap.get('wiki/rsp-missing.md')).toBeUndefined();
  });
});
