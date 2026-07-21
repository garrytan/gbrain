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

describe('runExtractFacts — v0.42 (#3014) supersession transport + heal', () => {
  // Row 1 struck + "superseded by #2"; row 2 the live superseding fact.
  const SUPERSEDE_FENCE = FACT_FENCE(
    `| 1 | ~~Will close by Q2~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #2 |
| 2 | Closed in Q3 | fact | 1.0 | world | high | 2026-07-01 |  | call |  |`,
  );

  const readSupersessionCols = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (engine as any).db.query(
      `SELECT row_num, superseded_by, expired_at FROM facts WHERE source_markdown_slug = 'people/deal' ORDER BY row_num`,
    );
    return r.rows as Array<{ row_num: number; superseded_by: number | null; expired_at: unknown }>;
  };

  const readIds = async (): Promise<number[]> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (engine as any).db.query(
      `SELECT id FROM facts WHERE source_markdown_slug = 'people/deal' ORDER BY row_num, id`,
    );
    return (r.rows as Array<{ id: number }>).map(x => Number(x.id));
  };

  test('reconcile transports superseded_by (resolved to the target row id) + expired_at', async () => {
    await putPage('people/deal', SUPERSEDE_FENCE);
    const r = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(r.factsInserted).toBe(2);
    expect(r.warnings).toEqual([]);

    const rows = await readSupersessionCols();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = await (engine as any).db.query(
      `SELECT row_num, id FROM facts WHERE source_markdown_slug = 'people/deal' ORDER BY row_num`,
    );
    const row2Id = ids.rows.find((x: { row_num: number; id: number }) => x.row_num === 2).id;
    const row1 = rows.find(x => x.row_num === 1)!;
    expect(Number(row1.superseded_by)).toBe(Number(row2Id));
    expect(row1.expired_at).not.toBeNull();

    const sup = await engine.listSupersessions('default');
    expect(sup.some(s => s.superseded_by === Number(row2Id))).toBe(true);
  });

  test('idempotent: a second reconcile with the struck row already healed is a no-op', async () => {
    await putPage('people/deal', SUPERSEDE_FENCE);
    await runExtractFacts(engine, { slugs: ['people/deal'] });
    const r2 = await runExtractFacts(engine, { slugs: ['people/deal'] });
    // Columns already match the fence-desired state → no drift → no churn.
    expect(r2.factsInserted).toBe(0);
    expect(r2.factsDeleted).toBe(0);
  });

  test('heal: a struck row with NULL supersession columns re-populates on re-reconcile', async () => {
    await putPage('people/deal', SUPERSEDE_FENCE);
    await runExtractFacts(engine, { slugs: ['people/deal'] });

    // Simulate the pre-#3014 mis-transport: struck row inserted with NULL
    // columns. The fence text is unchanged, so only the supersession-column
    // drift check can trigger a re-heal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET superseded_by = NULL, expired_at = NULL WHERE source_markdown_slug = 'people/deal' AND row_num = 1`,
    );
    const drifted = (await readSupersessionCols()).find(x => x.row_num === 1)!;
    expect(drifted.superseded_by).toBeNull();
    expect(drifted.expired_at).toBeNull();

    const healRun = await runExtractFacts(engine, { slugs: ['people/deal'] });
    // Drift detected → wipe+reinsert re-transports the columns.
    expect(healRun.factsInserted).toBeGreaterThan(0);

    const healed = (await readSupersessionCols()).find(x => x.row_num === 1)!;
    expect(healed.superseded_by).not.toBeNull();
    expect(healed.expired_at).not.toBeNull();
  });

  test('dangling reference (#N absent from fence) → warning, superseded_by NULL, expired_at set', async () => {
    await putPage('people/deal', FACT_FENCE(
      `| 1 | ~~Retired claim~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #9 |`,
    ));
    const r = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(r.warnings.some(w => w.includes('absent from the fence'))).toBe(true);

    const row1 = (await readSupersessionCols()).find(x => x.row_num === 1)!;
    expect(row1.superseded_by).toBeNull();
    expect(row1.expired_at).not.toBeNull();
  });

  // Finding A: a permanently-unresolvable reference must NOT re-drift every
  // cycle. Pre-fix, the drift term keyed off "the fence has a reference" vs
  // "the DB resolved one", so self / dangling / chain (which correctly stay
  // NULL) drifted forever — a full wipe+reinsert + duplicate warning each
  // cycle, with the fact ids advancing 1→2→3→…
  test('idempotent: a dangling reference does not churn — second reconcile is a no-op', async () => {
    await putPage('people/deal', FACT_FENCE(
      `| 1 | ~~Retired claim~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #9 |`,
    ));
    const first = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(first.factsInserted).toBeGreaterThan(0);
    const idsAfterFirst = await readIds();

    const second = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(second.factsInserted).toBe(0);
    expect(second.factsDeleted).toBe(0);
    expect(second.warnings).toEqual([]);
    expect(await readIds()).toEqual(idsAfterFirst);
  });

  test('idempotent: a self-reference does not churn — second reconcile is a no-op', async () => {
    await putPage('people/deal', FACT_FENCE(
      `| 1 | ~~Ouroboros claim~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #1 |`,
    ));
    const first = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(first.warnings.some(w => w.includes('references itself'))).toBe(true);
    const idsAfterFirst = await readIds();

    const second = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(second.factsInserted).toBe(0);
    expect(second.factsDeleted).toBe(0);
    expect(second.warnings).toEqual([]);
    expect(await readIds()).toEqual(idsAfterFirst);
  });

  test('idempotent: a chain (struck → struck) does not churn — second reconcile is a no-op', async () => {
    await putPage('people/deal', FACT_FENCE(
      `| 1 | ~~Link a~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #2 |
| 2 | ~~Link b~~ | commitment | 0.6 | world | medium | 2026-02-01 |  | call | superseded by #3 |
| 3 | Live tail | fact | 1.0 | world | high | 2026-03-01 |  | call |  |`,
    ));
    const first = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(first.warnings.some(w => w.includes('struck'))).toBe(true);
    const idsAfterFirst = await readIds();

    const second = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(second.factsInserted).toBe(0);
    expect(second.factsDeleted).toBe(0);
    expect(second.warnings).toEqual([]);
    expect(await readIds()).toEqual(idsAfterFirst);
  });

  // Finding A: the no-churn fix must not mask a genuine reference change.
  test('changed reference re-attempts: dangling → resolvable re-resolves superseded_by', async () => {
    // Cycle 1: row 1 struck, superseded by #9 (dangling); row 2 live.
    await putPage('people/deal', FACT_FENCE(
      `| 1 | ~~Old claim~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #9 |
| 2 | New claim | fact | 1.0 | world | high | 2026-07-01 |  | call |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect((await readSupersessionCols()).find(x => x.row_num === 1)!.superseded_by).toBeNull();

    // Cycle 2: the operator fixes the reference to #2. The claim text and
    // row_num are unchanged, so only the supersession-drift term can catch
    // it — and it must, keying off the now-resolvable reference.
    await putPage('people/deal', FACT_FENCE(
      `| 1 | ~~Old claim~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #2 |
| 2 | New claim | fact | 1.0 | world | high | 2026-07-01 |  | call |  |`,
    ));
    const r = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(r.factsInserted).toBeGreaterThan(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = await (engine as any).db.query(
      `SELECT row_num, id FROM facts WHERE source_markdown_slug = 'people/deal' ORDER BY row_num`,
    );
    const row2Id = Number(ids.rows.find((x: { row_num: number }) => Number(x.row_num) === 2).id);
    const row1 = (await readSupersessionCols()).find(x => x.row_num === 1)!;
    expect(Number(row1.superseded_by)).toBe(row2Id);

    // And it settles: a third cycle is a no-op.
    const third = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(third.factsInserted).toBe(0);
    expect(third.factsDeleted).toBe(0);
  });

  // Finding B: pre-fix, the reconcile deleted the page in a self-committing
  // transaction BEFORE the separate insertFacts transaction; an insert throw
  // left the page permanently emptied. The caller now defers the wipe into
  // insertFacts' own transaction, so a failing insert can never empty it.
  test('a failing insert during the wipe+reinsert path leaves the page intact', async () => {
    await putPage('people/deal', SUPERSEDE_FENCE);
    await runExtractFacts(engine, { slugs: ['people/deal'] });
    const before = await readIds();
    expect(before).toHaveLength(2);

    // Force a drift so the reconcile takes the wipe+reinsert path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET superseded_by = NULL, expired_at = NULL WHERE source_markdown_slug = 'people/deal' AND row_num = 1`,
    );

    // Make the insert throw. Pre-fix, the separate-commit delete had already
    // emptied the page by the time this threw; now no delete runs outside
    // insertFacts, so the rows survive.
    const original = engine.insertFacts.bind(engine);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).insertFacts = async () => { throw new Error('simulated insert failure'); };
    try {
      await expect(runExtractFacts(engine, { slugs: ['people/deal'] })).rejects.toThrow('simulated insert failure');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).insertFacts = original;
    }

    // The page keeps its rows — not silently emptied.
    expect(await readIds()).toEqual(before);
  });

  // Finding C: an int4-overflowing #N in the fence must be treated as a
  // dangling reference, never overflow the resolution SELECT and abort the
  // cycle.
  test('int4-overflow reference in the fence → warning, cycle completes, second cycle no-op', async () => {
    await putPage('people/deal', FACT_FENCE(
      `| 1 | ~~Retired claim~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #99999999999 |`,
    ));
    const first = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(first.warnings.some(w => w.includes('absent from the fence'))).toBe(true);
    const row1 = (await readSupersessionCols()).find(x => x.row_num === 1)!;
    expect(row1.superseded_by).toBeNull();
    expect(row1.expired_at).not.toBeNull();
    const idsAfterFirst = await readIds();

    const second = await runExtractFacts(engine, { slugs: ['people/deal'] });
    expect(second.factsInserted).toBe(0);
    expect(second.factsDeleted).toBe(0);
    expect(second.warnings).toEqual([]);
    expect(await readIds()).toEqual(idsAfterFirst);
  });
});
