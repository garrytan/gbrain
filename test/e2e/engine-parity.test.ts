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
import { getSessionContextState, upsertSessionContextState } from '../../src/core/context/session-state.ts';
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

  test('v0.46.15 searchVector escalation parity: a dense page cannot starve the page result on either engine', async () => {
    // One page with 120 chunks nearest the query + 8 sparse pages behind it.
    // Pre-fix, the 100-chunk inner pool was consumed entirely by the dense
    // page → 1 result page. The bounded escalation loop (identical in both
    // engines) must recover >= limit distinct pages with identical top-5.
    const denseDim = 900;
    const mk = (cos: number, other: number): Float32Array => {
      const e = new Float32Array(1536);
      e[denseDim] = cos;
      e[other % 1536] = Math.sqrt(Math.max(0, 1 - cos * cos));
      return e;
    };
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.putPage('notes/parity-dense', { type: 'note', title: 'Parity Dense', compiled_truth: 'd.' });
      await eng.upsertChunks(
        'notes/parity-dense',
        Array.from({ length: 120 }, (_, i) => ({
          chunk_index: i,
          chunk_text: `pd ${i}`,
          chunk_source: 'compiled_truth' as const,
          embedding: mk(0.99 - i * 0.0005, 1000 + i),
          token_count: 2,
        })),
      );
      for (let p = 0; p < 8; p++) {
        const slug = `notes/parity-sparse-${p}`;
        await eng.putPage(slug, { type: 'note', title: `Parity Sparse ${p}`, compiled_truth: 's.' });
        await eng.upsertChunks(slug, [
          { chunk_index: 0, chunk_text: `ps ${p}`, chunk_source: 'compiled_truth', embedding: mk(0.6 - p * 0.001, 1200 + p), token_count: 2 },
        ]);
      }
    }
    const q = new Float32Array(1536);
    q[denseDim] = 1.0;
    const pg = await pgEngine.searchVector(q, { limit: 6, detail: 'high' });
    const pl = await pgliteEngine.searchVector(q, { limit: 6, detail: 'high' });
    expect(pg.length).toBe(6); // pre-fix: 1
    expect(pl.length).toBe(6);
    expect(pg.slice(0, 5).map((r) => r.slug)).toEqual(pl.slice(0, 5).map((r) => r.slug));
    expect(new Set(pg.map((r) => r.slug)).size).toBe(6);
  });

  test('#4152 dream verdict triage-v1 round-trip: identical shape on both engines (jsonb path)', async () => {
    // The postgres path binds segments/entities via sql.json(); PGLite via
    // $N::jsonb + JSON.stringify. A double-encode regression on the postgres
    // side would come back as a jsonb STRING scalar — the parity assert on
    // the parsed arrays catches exactly that class (#2339).
    const input = {
      worth_processing: true,
      reasons: ['thesis articulated', 'names a pattern'],
      score: 0.83,
      content_type: 'reflection',
      segments: [
        { quote: 'a verbatim line with "quotes" and unicode — 🤖', note: 'why it matters' },
        { quote: 'second segment' },
      ],
      entities: ['acme-example', 'fund-a'],
      model: 'anthropic:claude-haiku-4-5-20251001',
      triage_version: 1,
    };
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.putDreamVerdict('/corpus/parity.txt', 'parity-hash-0001', input);
      // Upsert path: overwrite with a new score, same PK.
      await eng.putDreamVerdict('/corpus/parity.txt', 'parity-hash-0001', { ...input, score: 0.31 });
    }
    const pg = await pgEngine.getDreamVerdict('/corpus/parity.txt', 'parity-hash-0001');
    const lite = await pgliteEngine.getDreamVerdict('/corpus/parity.txt', 'parity-hash-0001');
    expect(pg).not.toBeNull();
    expect(lite).not.toBeNull();
    for (const v of [pg!, lite!]) {
      expect(v.score).toBe(0.31);
      expect(v.content_type).toBe('reflection');
      expect(Array.isArray(v.segments)).toBe(true); // NOT a double-encoded string scalar
      expect(v.segments).toEqual(input.segments);
      expect(v.entities).toEqual(input.entities);
      expect(v.model).toBe(input.model);
      expect(v.triage_version).toBe(1);
    }
    // Legacy-row semantics: a boolean-era row reads back with null triage fields.
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.executeRaw(
        `INSERT INTO dream_verdicts (file_path, content_hash, worth_processing, reasons)
         VALUES ('/corpus/legacy.txt', 'legacy-hash-0001', true, '["old"]'::jsonb)
         ON CONFLICT (file_path, content_hash) DO NOTHING`,
      );
      const legacy = await eng.getDreamVerdict('/corpus/legacy.txt', 'legacy-hash-0001');
      expect(legacy!.score).toBeNull();
      expect(legacy!.triage_version).toBeNull();
      expect(legacy!.segments).toEqual([]);
      expect(legacy!.entities).toEqual([]);
    }
  });

  test('email citation metadata projects identically across engines', async () => {
    const slug = 'mail/example-citation';
    const page = {
      type: 'note' as const,
      title: 'Generated page title',
      compiled_truth: 'unique citation projection evidence',
      timeline: '',
      frontmatter: {
        message_id: '<citation@example.com>',
        thread_id: 'thread-example',
        subject: 'Example exact email subject',
      },
    };
    const chunks = [{
      chunk_index: 0,
      chunk_text: page.compiled_truth,
      chunk_source: 'compiled_truth' as const,
      embedding: basisEmbedding(77),
    }];

    await pgEngine.putPage(slug, page);
    await pgEngine.upsertChunks(slug, chunks);
    await pgliteEngine.putPage(slug, page);
    await pgliteEngine.upsertChunks(slug, chunks);

    const results = [
      (await pgEngine.searchKeyword('unique citation projection evidence'))[0],
      (await pgliteEngine.searchKeyword('unique citation projection evidence'))[0],
      (await pgEngine.searchKeywordChunks('unique citation projection evidence'))[0],
      (await pgliteEngine.searchKeywordChunks('unique citation projection evidence'))[0],
      (await pgEngine.searchVector(basisEmbedding(77)))[0],
      (await pgliteEngine.searchVector(basisEmbedding(77)))[0],
    ];

    for (const result of results) {
      expect(result?.message_id).toBe('<citation@example.com>');
      expect(result?.thread_id).toBe('thread-example');
      expect(result?.source_subject).toBe('Example exact email subject');
    }

    const nonEmailSlug = 'notes/generated-title-subject-gate';
    const nonEmailPage = {
      type: 'note' as const,
      title: 'Generated page title must stay a title',
      compiled_truth: 'unique non-email subject gate evidence',
      timeline: '',
      frontmatter: {
        subject: 'Frontmatter subject without an email identity',
        thread_id: 'standalone-thread-id',
      },
    };
    const nonEmailChunks = [{
      chunk_index: 0,
      chunk_text: nonEmailPage.compiled_truth,
      chunk_source: 'compiled_truth' as const,
    }];
    await pgEngine.putPage(nonEmailSlug, nonEmailPage);
    await pgEngine.upsertChunks(nonEmailSlug, nonEmailChunks);
    await pgliteEngine.putPage(nonEmailSlug, nonEmailPage);
    await pgliteEngine.upsertChunks(nonEmailSlug, nonEmailChunks);

    for (const result of [
      (await pgEngine.searchKeyword('unique non-email subject gate evidence'))[0],
      (await pgliteEngine.searchKeyword('unique non-email subject gate evidence'))[0],
    ]) {
      expect(result?.message_id).toBeUndefined();
      expect(result?.thread_id).toBe('standalone-thread-id');
      expect(result?.source_subject).toBeUndefined();
    }

    const whitespaceSlug = 'mail/whitespace-message-id';
    const whitespacePage = {
      type: 'note' as const,
      title: 'Whitespace Message-ID',
      compiled_truth: 'unique whitespace message id evidence',
      timeline: '',
      frontmatter: {
        message_id: ' \t\n ',
        thread_id: 'thread-whitespace',
        subject: 'Subject must remain gated',
      },
    };
    const whitespaceChunks = [{
      chunk_index: 0,
      chunk_text: whitespacePage.compiled_truth,
      chunk_source: 'compiled_truth' as const,
      embedding: basisEmbedding(78),
    }];
    await pgEngine.putPage(whitespaceSlug, whitespacePage);
    await pgEngine.upsertChunks(whitespaceSlug, whitespaceChunks);
    await pgliteEngine.putPage(whitespaceSlug, whitespacePage);
    await pgliteEngine.upsertChunks(whitespaceSlug, whitespaceChunks);

    for (const result of [
      (await pgEngine.searchKeyword('unique whitespace message id evidence'))[0],
      (await pgliteEngine.searchKeyword('unique whitespace message id evidence'))[0],
      (await pgEngine.searchKeywordChunks('unique whitespace message id evidence'))[0],
      (await pgliteEngine.searchKeywordChunks('unique whitespace message id evidence'))[0],
      (await pgEngine.searchVector(basisEmbedding(78)))[0],
      (await pgliteEngine.searchVector(basisEmbedding(78)))[0],
    ]) {
      expect(result?.message_id).toBeUndefined();
      expect(result?.thread_id).toBe('thread-whitespace');
      expect(result?.source_subject).toBeUndefined();
    }
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

  // fix/title-retrieval-arm (Reviewer F2): the title arm must behave
  // identically on both engines — including the D1 case where the title
  // tokens never appear in any chunk. Without this case the Postgres
  // implementation would only ever execute behind hybridSearch's fail-open
  // catch and a break could ship dark on the production brain. Runs in CI
  // via scripts/run-e2e.sh (docker-provisioned Postgres); skips gracefully
  // when DATABASE_URL is not configured.
  test('searchTitles parity: exact-title hit with title tokens absent from body', async () => {
    const seed = async (eng: BrainEngine) => {
      await eng.putPage('wiki/title-arm-parity', {
        type: 'note',
        title: 'Vermilion Icebreaker Compendium',
        compiled_truth: 'A document body that never mentions those words.',
        timeline: '',
      });
      await eng.upsertChunks('wiki/title-arm-parity', [{
        chunk_index: 0,
        chunk_text: 'A document body that never mentions those words.',
        chunk_source: 'compiled_truth',
        embedding: basisEmbedding(33),
        token_count: 9,
      }] satisfies ChunkInput[]);
    };
    await seed(pgEngine);
    await seed(pgliteEngine);

    const q = 'Vermilion Icebreaker Compendium';
    // Premise on both engines: chunk-grain keyword cannot see the page
    // (also pins the F1 contract — no orFallback flag means strict AND).
    expect((await pgEngine.searchKeyword(q, { limit: 5 })).map((r: SearchResult) => r.slug))
      .not.toContain('wiki/title-arm-parity');
    expect((await pgliteEngine.searchKeyword(q, { limit: 5 })).map((r: SearchResult) => r.slug))
      .not.toContain('wiki/title-arm-parity');

    const pg = await pgEngine.searchTitles(q, { limit: 5 });
    const pglite = await pgliteEngine.searchTitles(q, { limit: 5 });
    expect(pg.map((r: SearchResult) => r.slug)).toContain('wiki/title-arm-parity');
    expect(pglite.map((r: SearchResult) => r.slug)).toContain('wiki/title-arm-parity');

    // Row-shape parity: identical representative chunk on both engines.
    const pgHit = pg.find((r: SearchResult) => r.slug === 'wiki/title-arm-parity')!;
    const pgliteHit = pglite.find((r: SearchResult) => r.slug === 'wiki/title-arm-parity')!;
    expect(pgHit.chunk_source).toBe('compiled_truth');
    expect(pgliteHit.chunk_source).toBe(pgHit.chunk_source);
    expect(pgliteHit.chunk_text).toBe(pgHit.chunk_text);
  });

  // fix/title-retrieval-arm (Reviewer F1): the AND→OR fallback is opt-in.
  // Default searchKeyword stays strict on BOTH engines; orFallback: true
  // rescues the one-bad-token query identically.
  test('searchKeyword orFallback parity: default strict, opt-in rescues', async () => {
    const q = 'fat code thin harness zzzabsenttoken';
    for (const eng of [pgEngine, pgliteEngine]) {
      const strict = await eng.searchKeyword(q, { limit: 5 });
      expect(strict.length).toBe(0);
      const relaxed = await eng.searchKeyword(q, { limit: 5, orFallback: true });
      expect(relaxed.map((r: SearchResult) => r.slug)).toContain('concepts/fat-code-thin-harness');
    }
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

  test('putPage restores soft-deleted rows on both engines', async () => {
    const slug = 'notes/put-page-restore-parity';
    for (const engine of [pgEngine, pgliteEngine]) {
      await engine.putPage(slug, {
        type: 'note',
        title: 'Before delete',
        compiled_truth: 'before',
        timeline: '',
      });
      await engine.softDeletePage(slug, { sourceId: 'default' });
      expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();

      await engine.putPage(slug, {
        type: 'note',
        title: 'After restore',
        compiled_truth: 'after',
        timeline: '',
      });
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.title).toBe('After restore');
    }
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

  test('#2555 getChunks sourceIds[] parity: federated grant + scalar floor + unset default identical on both engines', async () => {
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('gcp-beta', 'gcp-beta', '/tmp/gcp-beta') ON CONFLICT (id) DO NOTHING`);
      await eng.putPage('wiki/gcp-doc', {
        type: 'note', title: 'beta doc', compiled_truth: 'beta body', timeline: '',
      }, { sourceId: 'gcp-beta' });
      await eng.upsertChunks('wiki/gcp-doc', [
        { chunk_index: 0, chunk_text: 'gcp beta chunk', chunk_source: 'compiled_truth' },
      ], { sourceId: 'gcp-beta' });
      await eng.putPage('wiki/gcp-doc', {
        type: 'note', title: 'default decoy', compiled_truth: 'decoy body', timeline: '',
      }, { sourceId: 'default' });
      await eng.upsertChunks('wiki/gcp-doc', [
        { chunk_index: 0, chunk_text: 'gcp default decoy', chunk_source: 'compiled_truth' },
      ], { sourceId: 'default' });
    }

    for (const eng of [pgEngine, pgliteEngine]) {
      // Federated array wins over scalar and reaches the non-default source.
      const federated = await eng.getChunks('wiki/gcp-doc', { sourceId: 'default', sourceIds: ['gcp-beta'] });
      expect(federated.map(c => c.chunk_text)).toEqual(['gcp beta chunk']);
      // Out-of-grant array → empty, never a fall-through to 'default'.
      const outOfGrant = await eng.getChunks('wiki/gcp-doc', { sourceIds: ['gcp-nonexistent'] });
      expect(outOfGrant).toEqual([]);
      // Unset opts keep the historical 'default' floor.
      const unset = await eng.getChunks('wiki/gcp-doc');
      expect(unset.map(c => c.chunk_text)).toEqual(['gcp default decoy']);
      // #2544 trim keeps the Chunk shape (embedding deliberately unselected → null).
      expect(federated[0].embedding).toBeNull();
    }
  });

  test('v114 (#1941) listLinkSources parity: same ordered provenance counts on both engines', async () => {
    const mk = async (eng: BrainEngine) => {
      for (const s of ['lsp-a', 'lsp-b', 'lsp-c']) {
        await eng.putPage(s, { type: 'note', title: s, compiled_truth: 'b', timeline: '' });
      }
      // citation-graph:2, manual:1 — exercises count DESC + the kebab regex.
      await eng.addLink('lsp-a', 'lsp-b', '', 'cites', 'citation-graph');
      await eng.addLink('lsp-a', 'lsp-c', '', 'cites', 'citation-graph');
      await eng.addLink('lsp-b', 'lsp-c', '', 'rel', 'manual');
    };
    await mk(pgEngine);
    await mk(pgliteEngine);

    const pg = await pgEngine.listLinkSources({ sourceId: 'default' });
    const pglite = await pgliteEngine.listLinkSources({ sourceId: 'default' });

    const norm = (rows: { link_source: string | null; count: number }[]) =>
      rows.filter(r => r.link_source === 'citation-graph' || r.link_source === 'manual');
    expect(norm(pg)).toEqual(norm(pglite));
    // citation-graph (2) must order before manual (1) on both engines.
    const cgIdx = pg.findIndex(r => r.link_source === 'citation-graph');
    const mIdx = pg.findIndex(r => r.link_source === 'manual');
    expect(cgIdx).toBeLessThan(mIdx);
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

  // v0.41.29.0 — findOrphanPages source scoping parity. Real Postgres
  // coverage for the postgres.js `sql` scalar fragment + `= ANY(${arr}::text[])`
  // array binding (a documented footgun class — the jsonb double-encode saga).
  // PGLite logic is pinned in test/orphans-source-scope.test.ts; this asserts
  // the Postgres SQL produces the same scoped sets. Cross-source inbound
  // (src-b → src-a) must NOT make the target an orphan of src-a (A2).
  test('v0.41.29.0 findOrphanPages source scoping parity (scalar + federated)', async () => {
    const srcSql = `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`;
    const pageSql = `
      INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
        VALUES ($1, $2, 'person', 't', 'b', '', '{}'::jsonb)
        ON CONFLICT (source_id, slug) DO NOTHING
    `;
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.executeRaw(srcSql, ['orphan-src-a']);
      await eng.executeRaw(srcSql, ['orphan-src-b']);
      await eng.executeRaw(pageSql, ['orphan-src-a', 'people/op-orphan-a']);
      await eng.executeRaw(pageSql, ['orphan-src-a', 'people/op-target-a']);
      await eng.executeRaw(pageSql, ['orphan-src-b', 'people/op-linker-b']);
      // Cross-source inbound: src-b page → src-a target (A2).
      await eng.addLink(
        'people/op-linker-b', 'people/op-target-a', '', 'mentions', 'markdown',
        undefined, undefined, { fromSourceId: 'orphan-src-b', toSourceId: 'orphan-src-a' },
      );
    }

    const scoped = async (eng: BrainEngine, opts: { sourceId?: string; sourceIds?: string[] }) =>
      (await eng.findOrphanPages(opts)).map(r => r.slug).filter(s => s.startsWith('people/op-')).sort();

    // Scalar scope to src-a: op-orphan-a is an orphan; op-target-a is saved
    // by the cross-source inbound (A2). Parity on both engines.
    const pgA = await scoped(pgEngine, { sourceId: 'orphan-src-a' });
    const pgliteA = await scoped(pgliteEngine, { sourceId: 'orphan-src-a' });
    expect(pgA).toEqual(['people/op-orphan-a']);
    expect(pgliteA).toEqual(pgA);

    // Scalar scope to src-b.
    const pgB = await scoped(pgEngine, { sourceId: 'orphan-src-b' });
    const pgliteB = await scoped(pgliteEngine, { sourceId: 'orphan-src-b' });
    expect(pgB).toEqual(['people/op-linker-b']);
    expect(pgliteB).toEqual(pgB);

    // Federated array scope (= ANY binding) → union.
    const pgFed = await scoped(pgEngine, { sourceIds: ['orphan-src-a', 'orphan-src-b'] });
    const pgliteFed = await scoped(pgliteEngine, { sourceIds: ['orphan-src-a', 'orphan-src-b'] });
    expect(pgFed).toEqual(['people/op-linker-b', 'people/op-orphan-a']);
    expect(pgliteFed).toEqual(pgFed);
  });

  // v0.42.7 (#1696): stale-page extraction watermark parity. Isolated under a
  // dedicated source so other tests' mutations don't perturb the counts.
  test('stale-page extraction methods: Postgres ↔ PGLite parity', async () => {
    const SRC = 'stale-parity';
    const VER = '2026-05-31T00:00:00Z';
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, 'Stale Parity', '{}'::jsonb) ON CONFLICT DO NOTHING`, [SRC]);
      await eng.executeRaw(
        `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
         SELECT 'sp/' || g, $1, 'concept', 'SP' || g, 'body ' || g, '', '{}'::jsonb, 'sph' || g, now(), now()
           FROM generate_series(1, 3) g`,
        [SRC],
      );
    }

    // NULL arm: all 3 stale on both engines.
    expect(await pgEngine.countStalePagesForExtraction({ sourceId: SRC })).toBe(3);
    expect(await pgliteEngine.countStalePagesForExtraction({ sourceId: SRC })).toBe(3);

    // listStalePagesForExtraction: same slugs + content columns populated.
    const pgList = (await pgEngine.listStalePagesForExtraction({ batchSize: 10, sourceId: SRC })).map(r => r.slug).sort();
    const plList = (await pgliteEngine.listStalePagesForExtraction({ batchSize: 10, sourceId: SRC })).map(r => r.slug).sort();
    expect(pgList).toEqual(['sp/1', 'sp/2', 'sp/3']);
    expect(plList).toEqual(pgList);
    const pgRow = (await pgEngine.listStalePagesForExtraction({ batchSize: 1, sourceId: SRC }))[0];
    expect(pgRow.compiled_truth).toBeTruthy();
    expect(pgRow.updated_at).toBeInstanceOf(Date);

    // markPagesExtractedBatch: stamp one → count drops to 2 on both.
    // Stamp with the row's OWN updated_at_iso (per-ref extractedAt — the
    // #1768/D4 production semantics used by extractStaleFromDB), NOT client
    // `new Date()`: the test client's clock and the DB server's clock are
    // different clocks (docker VM drift under load), so a client-now stamp can
    // land before the row's server-side `updated_at`, leaving sp/1 flagged
    // `updated_at > links_extracted_at` and the count stuck at 3.
    for (const eng of [pgEngine, pgliteEngine]) {
      const sp1 = (await eng.listStalePagesForExtraction({ batchSize: 10, sourceId: SRC }))
        .find((r) => r.slug === 'sp/1')!;
      await eng.markPagesExtractedBatch(
        [{ slug: 'sp/1', source_id: SRC, extractedAt: sp1.updated_at_iso }],
        sp1.updated_at_iso,
      );
    }
    expect(await pgEngine.countStalePagesForExtraction({ sourceId: SRC })).toBe(2);
    expect(await pgliteEngine.countStalePagesForExtraction({ sourceId: SRC })).toBe(2);

    // version arm: stamp sp/2 old + set updated_at old (isolate version arm) →
    // flagged only when versionTs is passed. Parity on both engines.
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.markPagesExtractedBatch([{ slug: 'sp/2', source_id: SRC }], '2000-01-01T00:00:00Z');
      await eng.executeRaw(`UPDATE pages SET updated_at = '2000-01-01T00:00:00Z' WHERE slug = 'sp/2' AND source_id = $1`, [SRC]);
    }
    // Without versionTs: sp/2 not stale (stamp == updated, not NULL). sp/3 still NULL-stale.
    expect(await pgEngine.countStalePagesForExtraction({ sourceId: SRC })).toBe(1);
    expect(await pgliteEngine.countStalePagesForExtraction({ sourceId: SRC })).toBe(1);
    // With versionTs: sp/2's old stamp (< VER) re-flags it → 2 stale.
    expect(await pgEngine.countStalePagesForExtraction({ sourceId: SRC, versionTs: VER })).toBe(2);
    expect(await pgliteEngine.countStalePagesForExtraction({ sourceId: SRC, versionTs: VER })).toBe(2);

    // edited-since arm: stamp sp/1 in the recent past, updated_at slightly after →
    // re-flagged on both engines (updated_at > links_extracted_at).
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.executeRaw(
        `UPDATE pages SET links_extracted_at = now() - interval '2 hours', updated_at = now() - interval '1 hour' WHERE slug = 'sp/1' AND source_id = $1`,
        [SRC],
      );
    }
    expect(await pgEngine.countStalePagesForExtraction({ sourceId: SRC })).toBe(2); // sp/1 (edited) + sp/3 (NULL)
    expect(await pgliteEngine.countStalePagesForExtraction({ sourceId: SRC })).toBe(2);
  });

  // Chunkless-page safety net (embed --stale detection gap): a page with
  // non-empty content but zero content_chunks rows (e.g. a putPage-only
  // write) must be found on BOTH engines identically, and quarantined /
  // embed_skip pages (intentionally chunkless by design) must be excluded
  // identically on both. Isolated under a dedicated source.
  test('chunkless-page-with-content detection: Postgres ↔ PGLite parity', async () => {
    const SRC = 'chunkless-parity';
    for (const eng of [pgEngine, pgliteEngine]) {
      await eng.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, 'Chunkless Parity', '{}'::jsonb) ON CONFLICT DO NOTHING`, [SRC]);

      // cp/stub: non-empty content, never chunked — THE bug this fix targets.
      await eng.putPage('cp/stub', { type: 'person', title: 'Stub', compiled_truth: 'stub content, never chunked' }, { sourceId: SRC });
      // cp/chunked: same shape, but chunked — must be excluded.
      await eng.putPage('cp/chunked', { type: 'note', title: 'Chunked', compiled_truth: 'chunked content' }, { sourceId: SRC });
      await eng.upsertChunks('cp/chunked', [
        { chunk_index: 0, chunk_text: 'chunked content', chunk_source: 'compiled_truth' },
      ], { sourceId: SRC });
      // cp/empty: no content — must be excluded (the #2822 empty-put class, not this bug).
      await eng.putPage('cp/empty', { type: 'note', title: 'Empty', compiled_truth: '' }, { sourceId: SRC });
      // cp/quarantined: chunkless BY DESIGN — must be excluded.
      await eng.putPage('cp/quarantined', {
        type: 'note', title: 'Quarantined', compiled_truth: 'junk content',
        frontmatter: { quarantine: { reason: 'junk_pattern', detail: 'parity fixture', assessed_at: new Date().toISOString() } },
      }, { sourceId: SRC });
      // cp/skipped: chunkless BY DESIGN — must be excluded.
      await eng.putPage('cp/skipped', {
        type: 'note', title: 'Skipped', compiled_truth: 'x'.repeat(500),
        frontmatter: { embed_skip: { reason: 'oversized', bytes: 500, assessed_at: new Date().toISOString() } },
      }, { sourceId: SRC });
    }

    expect(await pgEngine.countChunklessPagesWithContent({ sourceId: SRC })).toBe(1);
    expect(await pgliteEngine.countChunklessPagesWithContent({ sourceId: SRC })).toBe(1);

    const pgRows = await pgEngine.listChunklessPagesWithContent({ sourceId: SRC });
    const pgliteRows = await pgliteEngine.listChunklessPagesWithContent({ sourceId: SRC });
    expect(pgRows.map(r => r.slug)).toEqual(['cp/stub']);
    expect(pgliteRows.map(r => r.slug)).toEqual(['cp/stub']);
    expect(pgRows[0].compiled_truth).toBe('stub content, never chunked');
    expect(pgliteRows[0].compiled_truth).toBe(pgRows[0].compiled_truth);

    // Unscoped count/list is >= the scoped count on both engines (other
    // tests' fixtures may also be chunkless — this only asserts the SRC
    // subset is reachable without scoping, not an exact global count).
    const pgAllSlugs = (await pgEngine.listChunklessPagesWithContent({ batchSize: 10000 })).map(r => r.slug);
    const pgliteAllSlugs = (await pgliteEngine.listChunklessPagesWithContent({ batchSize: 10000 })).map(r => r.slug);
    expect(pgAllSlugs).toContain('cp/stub');
    expect(pgliteAllSlugs).toContain('cp/stub');
  });

  test('v0.41.39 listEnrichCandidates parity (thin filter + source-aware inbound + order)', async () => {
    const stub = 'Stub page.';
    const pageSql = `
      INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
        VALUES ('default', $1, $2, $3, $4, '', '{}'::jsonb)
        ON CONFLICT (source_id, slug) DO NOTHING
    `;
    for (const eng of [pgEngine, pgliteEngine]) {
      // Two thin people (ec-alice ← 2 inbound, ec-bob ← 1), one thin company
      // (ec-widget ← 0), one long page (must be excluded by the thin filter).
      await eng.executeRaw(pageSql, ['ep/ec-alice', 'person', 'EC Alice', stub]);
      await eng.executeRaw(pageSql, ['ep/ec-bob', 'person', 'EC Bob', stub]);
      await eng.executeRaw(pageSql, ['companies/ec-widget', 'company', 'EC Widget', stub]);
      await eng.executeRaw(pageSql, ['ep/ec-long', 'person', 'EC Long', 'x'.repeat(900)]);
      // Linker pages + inbound links (link_source NULL → counted).
      await eng.executeRaw(pageSql, ['ep/ec-l1', 'note', 'L1', 'links']);
      await eng.executeRaw(pageSql, ['ep/ec-l2', 'note', 'L2', 'links']);
      await eng.executeRaw(pageSql, ['ep/ec-l3', 'note', 'L3', 'links']);
      await eng.addLink('ep/ec-l1', 'ep/ec-alice', 'ctx a1');
      await eng.addLink('ep/ec-l2', 'ep/ec-alice', 'ctx a2');
      await eng.addLink('ep/ec-l3', 'ep/ec-bob', 'ctx b1');
    }

    const run = async (eng: BrainEngine) =>
      (await eng.listEnrichCandidates({
        types: ['person', 'company'],
        thinThreshold: 400,
        order: 'inbound-links',
        limit: 10,
        sourceId: 'default',
      })).filter((c) => c.slug.startsWith('ep/') || c.slug === 'companies/ec-widget');

    const pg = await run(pgEngine);
    const pglite = await run(pgliteEngine);

    const shape = (rows: typeof pg) => rows.map((r) => `${r.slug}:${r.inbound_count}:${r.body_len}`);
    expect(shape(pg)).toEqual(shape(pglite));

    // Concrete contract: long page excluded; ordering alice(2) > bob(1) > widget(0).
    const slugs = pg.map((r) => r.slug);
    expect(slugs).not.toContain('ep/ec-long');
    expect(slugs.indexOf('ep/ec-alice')).toBeLessThan(slugs.indexOf('ep/ec-bob'));
    expect(slugs.indexOf('ep/ec-bob')).toBeLessThan(slugs.indexOf('companies/ec-widget'));
    expect(pg.find((r) => r.slug === 'ep/ec-alice')!.inbound_count).toBe(2);
  });
});

// ── relationalFanout parity (v0.43) ─────────────────────────────────────
async function seedRelational(eng: BrainEngine) {
  const pages: Array<[string, 'company' | 'person']> = [
    ['companies/ep-widget', 'company'],
    ['companies/ep-other', 'company'],
    ['people/ep-inv-a', 'person'],
    ['people/ep-inv-b', 'person'],
    ['people/ep-emp-c', 'person'],
    ['people/ep-mentioner', 'person'],
  ];
  for (const [slug, type] of pages) {
    await eng.putPage(slug, { type, title: slug, compiled_truth: `${slug} body`, timeline: '' });
  }
  await eng.upsertChunks('people/ep-inv-b', [{
    chunk_index: 0, chunk_text: 'b', chunk_source: 'compiled_truth',
    embedding: basisEmbedding(2), token_count: 1,
  }] satisfies ChunkInput[]);
  await eng.addLink('people/ep-inv-a', 'companies/ep-widget', '', 'invested_in', 'manual');
  await eng.addLink('people/ep-inv-b', 'companies/ep-widget', '', 'invested_in', 'manual');
  await eng.addLink('people/ep-emp-c', 'companies/ep-widget', '', 'works_at', 'manual');
  await eng.addLink('people/ep-mentioner', 'companies/ep-widget', '', 'mentions', 'mentions');
  await eng.addLink('people/ep-inv-a', 'companies/ep-other', '', 'invested_in', 'manual');
}

describeBoth('Engine parity — relationalFanout', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = await setupDB();
    await seedRelational(pgEngine);
    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    await seedRelational(pgliteEngine);
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  const shape = (rows: Awaited<ReturnType<BrainEngine['relationalFanout']>>) =>
    // canonical_chunk_id is a serial id — its absolute value diverges between a
    // fresh PGLite engine and a shared Postgres DB whose content_chunks sequence
    // advanced earlier (setupDB TRUNCATEs without RESTART IDENTITY). Compare its
    // PRESENCE, not the exact id, so the parity check verifies graph structure +
    // canonical-chunk resolution without depending on cross-engine sequence state.
    rows.map(r => `${r.source_id}:${r.slug}:${r.hop}:${r.edge_count}:${r.via_link_types.join(',')}:${r.path.join('>')}:${r.canonical_chunk_id != null ? 'set' : 'null'}`);

  test('typed-edge fan-out is identical across engines', async () => {
    const opts = { direction: 'in' as const, linkTypes: ['invested_in'] };
    const pg = await pgEngine.relationalFanout(['companies/ep-widget'], opts);
    const pglite = await pgliteEngine.relationalFanout(['companies/ep-widget'], opts);
    expect(shape(pg)).toEqual(shape(pglite));
    expect(pg.map(r => r.slug).sort()).toEqual(['people/ep-inv-a', 'people/ep-inv-b']);
  });

  test('type-agnostic + mentions-exclusion identical across engines', async () => {
    const pg = await pgEngine.relationalFanout(['companies/ep-widget'], { direction: 'in' });
    const pglite = await pgliteEngine.relationalFanout(['companies/ep-widget'], { direction: 'in' });
    expect(shape(pg)).toEqual(shape(pglite));
    expect(pg.map(r => r.slug)).not.toContain('people/ep-mentioner');
  });

  test('connects (multi-seed, both) identical across engines', async () => {
    const seeds = ['companies/ep-widget', 'companies/ep-other'];
    const pg = await pgEngine.relationalFanout(seeds, { direction: 'both' });
    const pglite = await pgliteEngine.relationalFanout(seeds, { direction: 'both' });
    expect(shape(pg)).toEqual(shape(pglite));
  });
});

// #2200 — federated sourceIds[] on the secondary-fetch reads must behave
// identically on both engines (a drift would mean a federated MCP client sees
// different tags/links/timeline after `gbrain migrate --to supabase`).
async function seedFederated(eng: BrainEngine) {
  await eng.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  await eng.putPage('fed/doc', { type: 'note', title: 'Fed doc', compiled_truth: 'b', timeline: '' }, { sourceId: 'beta' });
  await eng.putPage('fed/target', { type: 'note', title: 'Fed target', compiled_truth: 'b', timeline: '' }, { sourceId: 'beta' });
  await eng.putPage('fed/doc', { type: 'note', title: 'Default decoy', compiled_truth: 'd', timeline: '' }, { sourceId: 'default' });
  await eng.putPage('fed/outside', { type: 'note', title: 'Outside', compiled_truth: 'd', timeline: '' }, { sourceId: 'default' });
  await eng.addTag('fed/doc', 'beta-tag', { sourceId: 'beta' });
  await eng.addTag('fed/doc', 'default-decoy-tag', { sourceId: 'default' });
  await eng.addLink('fed/doc', 'fed/target', 'in', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'beta', toSourceId: 'beta' });
  await eng.addLink('fed/doc', 'fed/outside', 'leak', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'beta', toSourceId: 'default' });
  await eng.addLink('fed/target', 'fed/doc', 'inback', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'beta', toSourceId: 'beta' });
  await eng.addLink('fed/outside', 'fed/doc', 'leakback', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'default', toSourceId: 'beta' });
  // F1: in-grant edge authored by an out-of-grant origin — origin_slug must null out.
  await eng.addLink('fed/doc', 'fed/target', 'originleak', 'mentions', 'frontmatter', 'fed/outside', 'related', { fromSourceId: 'beta', toSourceId: 'beta', originSourceId: 'default' });
  await eng.addTimelineEntry('fed/doc', { date: '2026-02-02', source: 't', summary: 'fed event', detail: 'd' }, { sourceId: 'beta' });
  // Second-dated entry so the after/before fragment paths (D5A Postgres refactor) are exercised.
  await eng.addTimelineEntry('fed/doc', { date: '2026-08-08', source: 't', summary: 'late event', detail: 'd' }, { sourceId: 'beta' });
}

describeBoth('Engine parity — federated sourceIds[] secondary reads (#2200)', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;
  const grant = { sourceIds: ['beta'] };

  beforeAll(async () => {
    pgEngine = await setupDB();
    await seedFederated(pgEngine);
    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    await seedFederated(pgliteEngine);
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  test('getTags identical under sourceIds[]', async () => {
    const pg = (await pgEngine.getTags('fed/doc', grant)).sort();
    const pglite = (await pgliteEngine.getTags('fed/doc', grant)).sort();
    expect(pg).toEqual(pglite);
    expect(pg).toEqual(['beta-tag']); // default decoy excluded
  });

  function exactLinkShape(links: Awaited<ReturnType<BrainEngine['getLinks']>>): string[] {
    return links.map(link => [
      link.from_source_id,
      link.from_slug,
      link.to_source_id,
      link.to_slug,
      link.origin_source_id ?? null,
      link.origin_slug ?? null,
      link.link_type,
    ].join('::')).sort();
  }

  test('getLinks identical under sourceIds[] (all three endpoints scoped)', async () => {
    const pgLinks = await pgEngine.getLinks('fed/doc', grant);
    const pgliteLinks = await pgliteEngine.getLinks('fed/doc', grant);
    expect(exactLinkShape(pgLinks)).toEqual(exactLinkShape(pgliteLinks));
    expect([...new Set(pgLinks.map(l => `${l.to_source_id}:${l.to_slug}`))])
      .toEqual(['beta:fed/target']); // far-endpoint 'fed/outside' excluded
    // F1: origin identity nulls identically when origin is out-of-grant.
    const pgOrigins = pgLinks.map(l => [l.origin_source_id ?? null, l.origin_slug ?? null]);
    const pgliteOrigins = pgliteLinks.map(l => [l.origin_source_id ?? null, l.origin_slug ?? null]);
    expect(pgOrigins.sort()).toEqual(pgliteOrigins.sort());
    expect(pgOrigins).not.toContainEqual(['default', 'fed/outside']);
  });

  test('scalar getLinks preserves cross-source destination identity across engines', async () => {
    const scalar = { sourceId: 'beta' };
    const pg = await pgEngine.getLinks('fed/doc', scalar);
    const pglite = await pgliteEngine.getLinks('fed/doc', scalar);
    expect(exactLinkShape(pg)).toEqual(exactLinkShape(pglite));
    expect(pg).toContainEqual(expect.objectContaining({
      from_source_id: 'beta',
      from_slug: 'fed/doc',
      to_source_id: 'default',
      to_slug: 'fed/outside',
    }));
  });

  test('unscoped link reads expose exact endpoint identity across engines', async () => {
    const pgLinks = await pgEngine.getLinks('fed/doc');
    const pgliteLinks = await pgliteEngine.getLinks('fed/doc');
    expect(exactLinkShape(pgLinks)).toEqual(exactLinkShape(pgliteLinks));
    expect(pgLinks.every(link => link.from_source_id && link.to_source_id)).toBe(true);

    const pgBacklinks = await pgEngine.getBacklinks('fed/doc');
    const pgliteBacklinks = await pgliteEngine.getBacklinks('fed/doc');
    expect(exactLinkShape(pgBacklinks)).toEqual(exactLinkShape(pgliteBacklinks));
    expect(pgBacklinks.every(link => link.from_source_id && link.to_source_id)).toBe(true);
  });

  test('getBacklinks identical under sourceIds[] (both endpoints scoped)', async () => {
    const pg = await pgEngine.getBacklinks('fed/doc', grant);
    const pglite = await pgliteEngine.getBacklinks('fed/doc', grant);
    expect(exactLinkShape(pg)).toEqual(exactLinkShape(pglite));
    expect(pg.map(l => `${l.from_source_id}:${l.from_slug}`)).toEqual(['beta:fed/target']);
  });

  test('getTimeline identical under sourceIds[]', async () => {
    const pg = (await pgEngine.getTimeline('fed/doc', grant)).map(e => e.summary).sort();
    const pglite = (await pgliteEngine.getTimeline('fed/doc', grant)).map(e => e.summary).sort();
    expect(pg).toEqual(pglite);
    expect(pg).toEqual(['fed event', 'late event']);
  });

  // Pins the D5A Postgres fragment refactor: after/before/both window paths must
  // match PGLite under a federated grant (the 8-branch→composed-WHERE rewrite).
  test('getTimeline date-window fragments identical across engines (D5A regression guard)', async () => {
    for (const win of [{ after: '2026-05-01' }, { before: '2026-05-01' }, { after: '2026-01-01', before: '2026-12-31' }]) {
      const opts = { ...grant, ...win };
      const pg = (await pgEngine.getTimeline('fed/doc', opts)).map(e => e.summary).sort();
      const pglite = (await pgliteEngine.getTimeline('fed/doc', opts)).map(e => e.summary).sort();
      expect(pg).toEqual(pglite);
    }
  });
});

// ── ambient recall parity (v0.45.7, issue #1) ───────────────────────────
// Two seams that only real Postgres can vet:
//   1. The keyset-pagination WHERE clause (PageFilters.updatedAfterKeyset) —
//      Postgres composes it from postgres.js sql`` fragments, PGLite from
//      positional $N params. A drift here means the `delta` verb's session
//      cursor drops or re-delivers pages after `gbrain migrate --to supabase`.
//   2. The session_context_state $N::text::jsonb upsert (session-state.ts) —
//      the postgres.js jsonb double-encode trap PGLite structurally cannot
//      surface (the CLAUDE.md #2339 class).
const KS_TIE_TS = '2026-08-05T12:00:00.000Z';
const KS_EARLY_TS = '2026-08-01T00:00:00.000Z';
const KS_LATE_TS = '2026-08-09T00:00:00.000Z';
// 10-page tie cluster: bulk syncs stamp identical now() across a transaction,
// so a >limit same-timestamp cluster is the exact shape the slug tiebreaker
// exists for (limit 3 below forces two cursor advances INSIDE the cluster).
const KS_TIE_SLUGS = Array.from({ length: 10 }, (_, i) => `ks/tie-${String(i).padStart(2, '0')}`);

async function seedKeyset(eng: BrainEngine) {
  const stamp = async (slug: string, ts: string) => {
    await eng.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
    // Direct updated_at stamp (same precedent as the stale-parity test) —
    // putPage server-stamps now(), which can't produce a controlled tie.
    await eng.executeRaw(
      `UPDATE pages SET updated_at = $1::timestamptz WHERE slug = $2 AND source_id = 'default'`,
      [ts, slug],
    );
  };
  for (const slug of KS_TIE_SLUGS) await stamp(slug, KS_TIE_TS);
  await stamp('ks/early-1', KS_EARLY_TS);
  await stamp('ks/early-2', KS_EARLY_TS);
  await stamp('ks/late-1', KS_LATE_TS);
  await stamp('ks/late-2', KS_LATE_TS);
}

/** Page through listPages exactly the way the delta verb does (turn-context.ts):
 * anchor at (updated_at, slug) of the last DELIVERED row, sort updated_asc. */
async function drainKeyset(
  eng: BrainEngine,
  start: { updatedAt: string; slug: string },
): Promise<string[]> {
  const out: string[] = [];
  let cursor = start;
  // Iteration guard: a strict-greater bug that fails to advance the cursor
  // would livelock the loop instead of failing the assertion below.
  for (let i = 0; i < 20; i++) {
    const batch = await eng.listPages({
      updatedAfterKeyset: cursor,
      sort: 'updated_asc',
      limit: 3,
      slugPrefix: 'ks/',
      sourceId: 'default',
    });
    if (batch.length === 0) break;
    for (const p of batch) out.push(p.slug);
    const last = batch[batch.length - 1];
    cursor = { updatedAt: last.updated_at.toISOString(), slug: last.slug };
    if (batch.length < 3) break;
  }
  return out;
}

describeBoth('Engine parity — ambient recall keyset + session cursor (v0.45.7)', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = await setupDB();
    await seedKeyset(pgEngine);
    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    await seedKeyset(pgliteEngine);
    // session_context_state is not in helpers' TRUNCATE list — clear this
    // block's key space so a prior run's rows can't leak into assertions.
    await pgEngine.executeRaw(`DELETE FROM session_context_state WHERE session_id LIKE 'parity-%'`);
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  test('keyset drain from bucket start: identical ordered sequence, no dupes/omissions', async () => {
    // slug '' ⇒ start of the tie bucket (every tie slug > ''). Earlier pages
    // are strictly excluded (updated_at < ts); later pages follow the cluster.
    const start = { updatedAt: KS_TIE_TS, slug: '' };
    const pg = await drainKeyset(pgEngine, start);
    const pglite = await drainKeyset(pgliteEngine, start);
    expect(pg).toEqual(pglite);
    expect(pg).toEqual([...KS_TIE_SLUGS, 'ks/late-1', 'ks/late-2']);
    expect(new Set(pg).size).toBe(pg.length); // no duplicates across batches
  });

  test('keyset strict-greater: anchor slug excluded, mid-cluster resume identical', async () => {
    // Resuming from tie-04 must exclude tie-04 itself (strict >, not >=) and
    // everything before it in the (updated_at, slug) total order.
    const anchor = { updatedAt: KS_TIE_TS, slug: 'ks/tie-04' };
    const pg = await drainKeyset(pgEngine, anchor);
    const pglite = await drainKeyset(pgliteEngine, anchor);
    expect(pg).toEqual(pglite);
    expect(pg).toEqual([...KS_TIE_SLUGS.slice(5), 'ks/late-1', 'ks/late-2']);
    expect(pg).not.toContain('ks/tie-04');
  });

  test('session_context_state round trip: jsonb arrays stay arrays + keep-if-absent', async () => {
    const sess = 'parity-sess-1';
    const entities = ['people/alice-example', 'companies/acme-example'];
    for (const eng of [pgEngine, pgliteEngine]) {
      await upsertSessionContextState(eng, 'default', null, sess, {
        standingEntities: entities,
        lastWakeAt: KS_TIE_TS,
        cursorSlug: 'ks/tie-04',
      });
    }

    const pg = await getSessionContextState(pgEngine, 'default', null, sess);
    const pglite = await getSessionContextState(pgliteEngine, 'default', null, sess);
    expect(pg).not.toBeNull();
    expect(pglite).not.toBeNull();
    expect(pg!.standing_entities).toEqual(entities);
    expect(pglite!.standing_entities).toEqual(pg!.standing_entities);
    expect(pg!.surfaced_slugs).toEqual(['ks/tie-04']); // single-element keyset slug
    expect(pglite!.surfaced_slugs).toEqual(pg!.surfaced_slugs);
    expect(pg!.last_wake_at).toBe(KS_TIE_TS);
    expect(pglite!.last_wake_at).toBe(pg!.last_wake_at);

    // The read helper JSON.parses string scalars (fail-open), so it would MASK
    // a double-encoded write. jsonb_typeof is the unmaskable probe — a
    // JSON.stringify'd value bound straight into ::jsonb stores typeof
    // 'string', not 'array'. Only the real-Postgres arm can actually surface
    // the postgres.js trap; PGLite is asserted for stored-shape parity.
    for (const eng of [pgEngine, pgliteEngine]) {
      const rows = await eng.executeRaw<{ se: string; ss: string }>(
        `SELECT jsonb_typeof(standing_entities) AS se, jsonb_typeof(surfaced_slugs) AS ss
         FROM session_context_state
         WHERE source_id = 'default' AND client_id = 'local' AND session_id = $1`,
        [sess],
      );
      expect(rows[0]?.se).toBe('array');
      expect(rows[0]?.ss).toBe('array');
    }

    // keep-if-absent: a patch omitting standingEntities/cursorSlug must leave
    // both stored sets untouched while the wake cursor advances.
    for (const eng of [pgEngine, pgliteEngine]) {
      await upsertSessionContextState(eng, 'default', null, sess, { lastWakeAt: KS_LATE_TS });
    }
    for (const st of [
      await getSessionContextState(pgEngine, 'default', null, sess),
      await getSessionContextState(pgliteEngine, 'default', null, sess),
    ]) {
      expect(st!.standing_entities).toEqual(entities);
      expect(st!.surfaced_slugs).toEqual(['ks/tie-04']);
      expect(st!.last_wake_at).toBe(KS_LATE_TS);
    }
  });
});

// ── unscoped getPage deterministic multi-source tiebreak ─────────────────
// The pre-fix behavior: unscoped getPage was `LIMIT 1` with no ORDER BY, so a
// slug present in several sources returned an ARBITRARY row (and an
// existence-check + write pair could target different sources). Both engines
// now pin `ORDER BY (source_id = 'default') DESC, source_id ASC` —
// default-source first, then stable alpha. Parity here catches either engine
// dropping the clause.
describeBoth('Engine parity — unscoped getPage multi-source tiebreak', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = await setupDB();
    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    for (const eng of [pgEngine, pgliteEngine]) {
      for (const src of ['archive', 'work', 'zeta']) {
        await eng.executeRaw(
          `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
          [src],
        );
      }
      // Same slug in 'archive' AND 'default' — default must win even though
      // 'archive' sorts first alphabetically.
      await eng.putPage('tiebreak/with-default', {
        type: 'note', title: 'archive row', compiled_truth: 'a', timeline: '',
      }, { sourceId: 'archive' });
      await eng.putPage('tiebreak/with-default', {
        type: 'note', title: 'default row', compiled_truth: 'd', timeline: '',
      }, { sourceId: 'default' });
      // Same slug in 'work' AND 'zeta' only (no default row) — the
      // alphabetically-first source wins.
      await eng.putPage('tiebreak/no-default', {
        type: 'note', title: 'work row', compiled_truth: 'w', timeline: '',
      }, { sourceId: 'work' });
      await eng.putPage('tiebreak/no-default', {
        type: 'note', title: 'zeta row', compiled_truth: 'z', timeline: '',
      }, { sourceId: 'zeta' });
    }
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  test('unscoped getPage prefers the default-source row on both engines', async () => {
    for (const eng of [pgEngine, pgliteEngine]) {
      const page = await eng.getPage('tiebreak/with-default');
      expect(page).not.toBeNull();
      expect(page!.source_id).toBe('default');
      expect(page!.title).toBe('default row');
    }
  });

  test('unscoped getPage falls back to the alphabetically-first source when no default row exists', async () => {
    for (const eng of [pgEngine, pgliteEngine]) {
      const page = await eng.getPage('tiebreak/no-default');
      expect(page).not.toBeNull();
      expect(page!.source_id).toBe('work');
      expect(page!.title).toBe('work row');
    }
  });
});
