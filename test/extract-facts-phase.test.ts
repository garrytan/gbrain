/**
 * v0.32.2 — extract_facts cycle phase tests.
 *
 * Covers the reconciliation contract: parse fence → deleteFactsForPage
 * → insertFacts. Plus the empty-fence guard (Codex R2-#7) that refuses
 * to run when legacy v0.31 rows are pending the v0_32_2 backfill.
 *
 * Uses a real PGLite engine. Pages seeded via engine.putPage so
 * compiled_truth + frontmatter are realistic.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM pages');
});

async function putPage(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    type: 'person',
    compiled_truth: body,
    frontmatter: {},
    timeline: '',
  });
}

const FACT_FENCE = (rows: string): string => `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

describe('runExtractFacts — happy path', () => {
  test('reconciles fence facts into DB for a single page', async () => {
    const body = FACT_FENCE(
      `| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |
| 2 | Prefers async | preference | 0.85 | private | medium | 2026-04-29 |  | OH |  |`,
    );
    await putPage('people/alice', body);

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(r.pagesScanned).toBe(1);
    expect(r.pagesWithFacts).toBe(1);
    expect(r.factsInserted).toBe(2);
    expect(r.guardTriggered).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbRows = await (engine as any).db.query(
      `SELECT fact, row_num, source_markdown_slug FROM facts ORDER BY row_num`,
    );
    expect(dbRows.rows).toEqual([
      expect.objectContaining({ fact: 'Founded Acme', row_num: 1, source_markdown_slug: 'people/alice' }),
      expect.objectContaining({ fact: 'Prefers async', row_num: 2, source_markdown_slug: 'people/alice' }),
    ]);
  });

  test('idempotent: running twice produces the same final DB state', async () => {
    const body = FACT_FENCE(
      `| 1 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |
| 2 | B | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    );
    await putPage('people/alice', body);

    await runExtractFacts(engine, { slugs: ['people/alice'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after1 = await (engine as any).db.query(
      `SELECT fact, row_num FROM facts ORDER BY row_num`,
    );

    const r2 = await runExtractFacts(engine, { slugs: ['people/alice'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after2 = await (engine as any).db.query(
      `SELECT fact, row_num FROM facts ORDER BY row_num`,
    );

    expect(r2.guardTriggered).toBe(false);
    expect(r2.factsInserted).toBe(0);
    expect(r2.factsDeleted).toBe(0);
    expect(after2.rows.map((r: { fact: string }) => r.fact))
      .toEqual(after1.rows.map((r: { fact: string }) => r.fact));
    expect(after2.rows).toHaveLength(2);
  });

  test('dedupes duplicate fence rows by claim and source without rewriting the fence', async () => {
    const body = FACT_FENCE(
      `| 1 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |
| 2 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    );
    await putPage('people/alice', body);

    const r1 = await runExtractFacts(engine, { slugs: ['people/alice'] });
    const r2 = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r1.factsInserted).toBe(1);
    expect(r2.factsInserted).toBe(0);
    expect(r2.factsDeleted).toBe(0);

    // The cycle dedups the derived DB index; it does not destructively
    // rewrite user-authored markdown fence rows.
    const page = await engine.getPage('people/alice', { sourceId: 'default' });
    expect(parseFactsFence(page?.compiled_truth ?? '').facts).toHaveLength(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, source FROM facts WHERE source_markdown_slug = 'people/alice'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ fact: 'A', source: 's' });
  });

  test('same claim with a different source is not treated as duplicate', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | Same claim | fact | 1.0 | world | medium | 2026-01-01 |  | source-a |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    await putPage('people/alice', FACT_FENCE(
      `| 1 | Same claim | fact | 1.0 | world | medium | 2026-01-01 |  | source-a |  |
| 2 | Same claim | fact | 1.0 | world | medium | 2026-01-01 |  | source-b |  |`,
    ));
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.factsInserted).toBe(1);
    expect(r.factsDeleted).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, source FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ fact: 'Same claim', source: 'source-a' }),
      expect.objectContaining({ fact: 'Same claim', source: 'source-b' }),
    ]);
  });

  test('new fact added to the fence is inserted once without re-appending existing facts', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | Existing | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    await putPage('people/alice', FACT_FENCE(
      `| 1 | Existing | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |
| 2 | New | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(r.factsInserted).toBe(1);
    expect(r.factsDeleted).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(rows.rows.map((row: { fact: string }) => row.fact)).toEqual(['Existing', 'New']);
  });

  test('cli:-origin conversation facts (#1928) neither break idempotency nor get wiped', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | Fence fact | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    // A conversation fact on the same page coordinate — NOT fence-owned.
    await engine.insertFacts(
      [{ fact: 'conversation fact', kind: 'fact', source: 'cli:extract-conversation-facts', row_num: 99, source_markdown_slug: 'people/alice' }],
      { source_id: 'default' },
    );

    const r1 = await runExtractFacts(engine, { slugs: ['people/alice'] });
    const r2 = await runExtractFacts(engine, { slugs: ['people/alice'] });

    // The cli: row must not count as "stale" — a wipe/reinsert every cycle
    // would defeat idempotency (and churn factsDeleted/factsInserted).
    expect(r1.factsInserted).toBe(1);
    expect(r2.factsInserted).toBe(0);
    expect(r2.factsDeleted).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(rows.rows.map((row: { fact: string }) => row.fact))
      .toEqual(['Fence fact', 'conversation fact']);
  });

  test('removed-from-fence row is deleted from DB (wipe-and-reinsert pattern)', async () => {
    // Seed: 2 facts.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |
| 2 | B | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    // Edit the page to remove row 2.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));

    await runExtractFacts(engine, { slugs: ['people/alice'] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].fact).toBe('A');
  });

  test('page with no facts fence → DB facts for that page wiped (empty fence reconciles to empty index)', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | seeded | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    // Now write a fact-less version of the page.
    await putPage('people/alice', '# Just a page\n\nNo fence.\n');
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.pagesWithFacts).toBe(0);
    expect(r.factsInserted).toBe(0);
    expect(r.factsDeleted).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT COUNT(*) AS n FROM facts WHERE source_markdown_slug = 'people/alice'`,
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  test('dry-run does not touch DB', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    const r = await runExtractFacts(engine, { slugs: ['people/alice'], dryRun: true });
    expect(r.pagesScanned).toBe(1);
    expect(r.pagesWithFacts).toBe(1);
    expect(r.factsInserted).toBe(0);
    expect(r.factsDeleted).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT COUNT(*) AS n FROM facts');
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  test('walks every brain page when no slugs filter is provided', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | A1 | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await putPage('companies/acme', FACT_FENCE(
      `| 1 | C1 | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine);  // no slugs filter
    expect(r.pagesScanned).toBe(2);
    expect(r.factsInserted).toBe(2);
  });
});

describe('runExtractFacts — empty-fence guard (Codex R2-#7)', () => {
  test('refuses to run when legacy v0.31 rows are pending the v0_32_2 backfill', async () => {
    // Seed a legacy fact (row_num NULL, entity_slug NOT NULL — the
    // v0.31 hot-memory shape pre-backfill).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/alice', 'legacy claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0)`,
    );

    // Seed a real page with a fence.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | new fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRowsPending).toBe(1);
    expect(r.factsInserted).toBe(0);
    expect(r.factsDeleted).toBe(0);
    expect(r.warnings.some(w => w.includes('apply-migrations'))).toBe(true);

    // Legacy row was NOT touched.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, row_num FROM facts WHERE row_num IS NULL`,
    );
    expect(rows.rows[0].fact).toBe('legacy claim');
  });

  test('guard releases when all legacy rows have been backfilled', async () => {
    // Seed a backfilled (v51) row — row_num + source_markdown_slug set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', 'people/alice', 'already fenced', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0, 5, 'people/alice')`,
    );

    await putPage('people/alice', FACT_FENCE(
      `| 1 | F1 | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRowsPending).toBe(0);
    expect(r.factsInserted).toBe(1);
  });

  test('NULL entity_slug legacy rows do NOT trigger the guard (they are structurally unfenceable)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', NULL, 'unparented', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0)`,
    );

    await putPage('people/alice', FACT_FENCE(
      `| 1 | F | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(r.guardTriggered).toBe(false);
    expect(r.factsInserted).toBe(1);
  });

  // ── #2484: structurally-unfenceable hot-memory rows ───────────
  // The inline facts writer (backstop.ts) keeps producing
  // `row_num IS NULL, entity_slug IS NOT NULL` rows AFTER the v0_32_2
  // migration completes: when a resolved slug has no fenceable page
  // (slugify-floor / stub-guard-blocked unprefixed slugs like
  // `wingman` or `people-jane-doe`), it falls through to a DB-only
  // insert with row_num NULL. The OLD guard predicate
  // (`row_num IS NULL AND entity_slug IS NOT NULL`) matched these and
  // jammed the phase forever (~16/day) — they can never be fenced (no
  // page to fence onto; the ledger-complete migration won't re-run).
  // The fix requires a LIVE backing page, so these rows no longer gate.
  test('#2484: unfenceable inline-writer rows (entity_slug set, NO backing page) do NOT trigger the guard', async () => {
    // Two unfenceable rows whose entity_slug has no page row at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES
         ('default', 'wingman',          'handoff note A', 'fact', 'private', 'medium', now(), 'mcp:extract_facts', 1.0),
         ('default', 'people-jane-doe',  'handoff note B', 'fact', 'private', 'medium', now(), 'mcp:extract_facts', 1.0)`,
    );

    // A real page with a fence that SHOULD reconcile (proves the phase
    // converges past the guard rather than early-returning).
    await putPage('people/alice', FACT_FENCE(
      `| 1 | real fenced fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    // Guard must NOT trip — the unfenceable rows are permanent by
    // construction, not a migration blocker.
    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRowsPending).toBe(0);
    // The phase ran its reconcile pass (did not early-return).
    expect(r.factsInserted).toBe(1);

    // The unfenceable rows survive untouched (still row_num NULL).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const survivors = await (engine as any).db.query(
      `SELECT entity_slug FROM facts WHERE row_num IS NULL ORDER BY entity_slug`,
    );
    expect(survivors.rows.map((x: { entity_slug: string }) => x.entity_slug))
      .toEqual(['people-jane-doe', 'wingman']);
  });

  test('#2484: a genuine legacy row WITH a backing page still triggers the guard (discriminator stays sharp)', async () => {
    // Same shape as the unfenceable row above (row_num NULL, entity_slug
    // set) — the ONLY difference is a live backing page exists, so the
    // migration's Phase B could fence it. This MUST still gate.
    await putPage('people/bob', FACT_FENCE(
      `| 1 | fence fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/bob', 'genuine legacy claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0)`,
    );

    const r = await runExtractFacts(engine, { slugs: ['people/bob'] });

    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRowsPending).toBe(1);
    expect(r.factsInserted).toBe(0);
    expect(r.factsDeleted).toBe(0);
    expect(r.warnings.some(w => w.includes('apply-migrations'))).toBe(true);
  });

  test('#2484: a soft-deleted backing page makes its legacy row unfenceable (does NOT gate)', async () => {
    // Page exists then gets soft-deleted (deleted_at set). The migration
    // can't fence onto a deleted page, so the row must not gate.
    await putPage('people/carol', FACT_FENCE(
      `| 1 | live fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/carol', 'orphaned legacy claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0)`,
    );
    // Soft-delete the page.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE pages SET deleted_at = now() WHERE slug = 'people/carol' AND source_id = 'default'`,
    );

    // Reconcile a DIFFERENT live page so the phase has work to do.
    await putPage('people/dave', FACT_FENCE(
      `| 1 | dave fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/dave'] });
    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRowsPending).toBe(0);
    expect(r.factsInserted).toBe(1);
  });
});

describe('runExtractFacts — multi-source isolation', () => {
  test('deleteFactsForPage scoping does not affect other sources', async () => {
    // Seed sources work + home.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO sources (id, name, config) VALUES
         ('work', 'work', '{}'::jsonb),
         ('home', 'home', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Seed v51-shape facts in both sources for the same slug.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('home', 'people/alice', 'home fact', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0, 1, 'people/alice')`,
    );

    // Seed default source's fence-only page (the cycle will reconcile this).
    await putPage('people/alice', FACT_FENCE(
      `| 1 | default fact | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));

    await runExtractFacts(engine, { slugs: ['people/alice'], sourceId: 'default' });

    // The home-source row should survive — deleteFactsForPage('people/alice', 'default')
    // never matched it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const homeRows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_id = 'home'`,
    );
    expect(homeRows.rows).toHaveLength(1);
    expect(homeRows.rows[0].fact).toBe('home fact');
  });
});

describe('runExtractFacts — empty-slugs guard (v0.36.x #1096 regression)', () => {
  test('slugs:[] returns immediately without a full-brain walk', async () => {
    // Seed many pages; full-walk over them would be slow and would
    // populate pagesScanned > 0. With the bug, slugs:[] fell through
    // to engine.getAllSlugs() and walked every seed page.
    for (let i = 0; i < 5; i++) {
      await putPage(`people/seed-${i}`, FACT_FENCE(`| 1 | Seed ${i} | fact | 1.0 | world | high | 2017-01-01 |  | seed |  |`));
    }
    const r = await runExtractFacts(engine, { slugs: [] });
    expect(r.pagesScanned).toBe(0);
    expect(r.factsInserted).toBe(0);
  });

  test('slugs:undefined still triggers full-brain walk (regression guard for the other side of the bug)', async () => {
    await putPage('people/unscoped-walk', FACT_FENCE(`| 1 | Unscoped fact | fact | 1.0 | world | high | 2017-01-01 |  | seed |  |`));
    const r = await runExtractFacts(engine, {});
    expect(r.pagesScanned).toBeGreaterThan(0);
    // The unscoped fact should be seen at least once
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/unscoped-walk' AND fact = 'Unscoped fact'`,
    );
    expect(seen.rows.length).toBeGreaterThan(0);
  });

  test('slugs:["a"] walks just the one slug, no full-brain fallback', async () => {
    await putPage('people/just-this-one', FACT_FENCE(`| 1 | Just one fact | fact | 1.0 | world | high | 2017-01-01 |  | seed |  |`));
    await putPage('people/sibling', FACT_FENCE(`| 1 | Sibling fact | fact | 1.0 | world | high | 2017-01-01 |  | seed |  |`));
    const r = await runExtractFacts(engine, { slugs: ['people/just-this-one'] });
    expect(r.pagesScanned).toBe(1);
  });
});
