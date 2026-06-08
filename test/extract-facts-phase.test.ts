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

// #1928 — The cycle's wipe-and-reinsert is keyed on
// (source_id, source_markdown_slug). CLI deposits (e.g. conversation-facts)
// land on that exact coordinate but live OUTSIDE the fence — the
// reconcile shouldn't touch them. Pre-fix: every cycle run that reached
// a conversation page deleted every cli-sourced fact on it; combined
// with the "failed-sync ⇒ full-walk fallback" in cycle.ts, one cycle
// could wipe an entire conversation-facts backfill.
describe('runExtractFacts — #1928 CLI-deposited facts survive the wipe', () => {
  // CLI deposits stamp page-global row_num values; we use a high seed
  // value so the fence reconcile (which numbers from 1) doesn't collide
  // with the cli row on the partial-UNIQUE index over
  // (source_id, source_markdown_slug, row_num).
  let cliRowSeq = 100;
  async function seedCliFact(slug: string, fact: string, sourceTag = 'cli:extract-conversation-facts'): Promise<void> {
    const rowNum = cliRowSeq++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', $1, $2, 'event', 'private', 'medium',
               now(), $3, 1.0, $4, $1)`,
      [slug, fact, sourceTag, rowNum],
    );
  }

  test('CLI-sourced fact on a fenceless page survives the per-page reconcile', async () => {
    // Conversation pages carry no `## Facts` fence by design.
    await putPage('conversations/imessage/alice', '# iMessage: Alice\n\nplain transcript body, no fence here.\n');
    await seedCliFact('conversations/imessage/alice', 'Alice started at Acme on 2024-03-16');

    const r = await runExtractFacts(engine, { slugs: ['conversations/imessage/alice'] });

    // Phase parses the page (no fence → 0 facts in fence, 0 inserted).
    expect(r.pagesScanned).toBe(1);
    expect(r.pagesWithFacts).toBe(0);
    expect(r.factsInserted).toBe(0);
    // And the cli row was NOT counted as deleted (the exclusion held).
    expect(r.factsDeleted).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, source FROM facts WHERE source_markdown_slug = 'conversations/imessage/alice'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].fact).toBe('Alice started at Acme on 2024-03-16');
    expect(rows.rows[0].source).toBe('cli:extract-conversation-facts');
  });

  test('full-walk fallback (no slugs) does not wipe CLI deposits across all pages', async () => {
    // The "amplifier" scenario from the issue: cycle.ts falls back to a
    // full-brain walk when sync fails; pre-fix every conversation page in
    // the brain got its cli rows wiped in one shot.
    await putPage('conversations/imessage/alice', '# iMessage: Alice\n\ntranscript a.\n');
    await putPage('conversations/imessage/bob', '# iMessage: Bob\n\ntranscript b.\n');
    await putPage('conversations/imessage/carol', '# iMessage: Carol\n\ntranscript c.\n');
    await seedCliFact('conversations/imessage/alice', 'A1');
    await seedCliFact('conversations/imessage/bob', 'B1');
    await seedCliFact('conversations/imessage/carol', 'C1');

    const r = await runExtractFacts(engine);  // full walk

    expect(r.pagesScanned).toBeGreaterThanOrEqual(3);
    expect(r.factsInserted).toBe(0);
    expect(r.factsDeleted).toBe(0);  // not a single cli row deleted

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source LIKE 'cli:%' ORDER BY fact`,
    );
    expect(rows.rows.map((r: { fact: string }) => r.fact)).toEqual(['A1', 'B1', 'C1']);
  });

  test('non-cli rows on the same page coordinate ARE still wiped (reconcile semantics preserved)', async () => {
    // A page that DOES have a fence — its fence-derived rows (source = 'sync:import' etc.)
    // should still get the wipe-and-reinsert treatment. The cli exclusion is narrow.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | New fence fact | fact | 1.0 | world | medium | 2026-01-01 |  | sync:import |  |`,
    ));
    // Seed a pre-existing fence-row (mimics what a previous reconcile left).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', 'people/alice', 'stale fence fact', 'fact', 'world', 'medium',
               now(), 'sync:import', 1.0, 99, 'people/alice')`,
    );
    // And seed a cli row on the same coordinate.
    await seedCliFact('people/alice', 'cli fact that must survive');

    await runExtractFacts(engine, { slugs: ['people/alice'] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, source FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY fact`,
    );
    const facts = rows.rows.map((r: { fact: string; source: string }) => ({ fact: r.fact, source: r.source }));
    // Stale fence row gone, new fence row in, cli row survives.
    expect(facts).toEqual([
      { fact: 'New fence fact', source: 'sync:import' },
      { fact: 'cli fact that must survive', source: 'cli:extract-conversation-facts' },
    ]);
  });

  test('engine.deleteFactsForPage honors excludeSourcePrefixes directly (engine-level pin)', async () => {
    await seedCliFact('engine-pin/page', 'cli row', 'cli:extract-conversation-facts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', 'engine-pin/page', 'fence row', 'fact', 'world', 'medium',
               now(), 'sync:import', 1.0, 1, 'engine-pin/page')`,
    );

    const result = await engine.deleteFactsForPage('engine-pin/page', 'default', {
      excludeSourcePrefixes: ['cli:'],
    });
    // 1 deleted: the sync:import fence row.
    // 1 survives: the cli row.
    expect(result.deleted).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const survivors = await (engine as any).db.query(
      `SELECT fact, source FROM facts WHERE source_markdown_slug = 'engine-pin/page'`,
    );
    expect(survivors.rows).toHaveLength(1);
    expect(survivors.rows[0].fact).toBe('cli row');
  });

  test('engine.deleteFactsForPage with no excludeSourcePrefixes deletes every page-coord row (back-compat)', async () => {
    await seedCliFact('compat/page', 'cli row');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', 'compat/page', 'fence row', 'fact', 'world', 'medium',
               now(), 'sync:import', 1.0, 1, 'compat/page')`,
    );

    const result = await engine.deleteFactsForPage('compat/page', 'default');
    expect(result.deleted).toBe(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const survivors = await (engine as any).db.query(
      `SELECT COUNT(*) AS n FROM facts WHERE source_markdown_slug = 'compat/page'`,
    );
    expect(Number(survivors.rows[0].n)).toBe(0);
  });
});
