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
    expect(after2.rows.map((r: { fact: string }) => r.fact))
      .toEqual(after1.rows.map((r: { fact: string }) => r.fact));
    expect(after2.rows).toHaveLength(2);
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
