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
import { importFromContent } from '../src/core/import-file.ts';

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
  // #2763: the legacy-row guard only counts rows the v0_32_2 Phase B
  // backfill could actually fence, which requires the source to carry a
  // local_path. The guard tests here simulate a migrated v0.31 brain,
  // whose default source inherits local_path from sync.repo_path
  // (migration v14) — mirror that. A fresh PGLite seed leaves it NULL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = '/tmp/gbrain-extract-facts-phase-test' WHERE id = 'default'`,
  );
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

// #3625: writes compiled_truth and timeline as SEPARATE columns, mirroring
// what splitBody() produces when a `## Facts` fence sits below the
// `<!-- timeline -->` sentinel — the fence text lands in `timeline`, not
// `compiled_truth`, exactly as MCP put_page would store it.
async function putPageWithTimeline(slug: string, compiledTruth: string, timeline: string): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    type: 'person',
    compiled_truth: compiledTruth,
    frontmatter: {},
    timeline,
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

  test('malformed fence rows make the page non-authoritative and preserve its indexed facts', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |
| 2 | B | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    // A hand edit corrupts row 2. The parser can still recover row 1, but
    // that partial result is not an authoritative replacement for the page.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | A | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |
| 2 | B | bogus | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await putPage('people/bob', FACT_FENCE(
      `| 1 | Clean | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice', 'people/bob'] });

    expect(r.warnings.some(w => w.includes('FACTS_TABLE_MALFORMED'))).toBe(true);
    expect(r.pagesScanned).toBe(2);
    expect(r.factsInserted).toBe(1);
    expect(r.factsDeleted).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(rows.rows.map((row: { fact: string }) => row.fact)).toEqual(['A', 'B']);

    // A warning is page-local: clean pages in the same cycle still reconcile.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanRows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/bob'`,
    );
    expect(cleanRows.rows.map((row: { fact: string }) => row.fact)).toEqual(['Clean']);
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

  test('#3625: a Facts fence below the timeline sentinel is preserved, not deleted, and warns loudly', async () => {
    // Seed the page with the fence in its normal place (above the sentinel)
    // and let it index normally.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |
| 2 | Prefers async | preference | 0.85 | private | medium | 2026-04-29 |  | OH |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seeded = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(seeded.rows).toHaveLength(2);

    // #3625 repro: rewrite the page so the SAME fence content now lives in
    // `timeline` (below the sentinel) instead of `compiled_truth` — exactly
    // what splitBody() produces for a page whose `## Facts` fence was
    // written below `<!-- timeline -->`. compiled_truth carries none of the
    // fence text, so parseFactsFence(compiled_truth) sees zero facts.
    await putPageWithTimeline(
      'people/alice',
      '# Page\n\nBody.\n',
      FACT_FENCE(
        `| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |
| 2 | Prefers async | preference | 0.85 | private | medium | 2026-04-29 |  | OH |  |`,
      ),
    );

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    // The fix: this must NOT read as "fence removed" and must NOT delete
    // the previously-indexed rows.
    expect(r.factsDeleted).toBe(0);
    expect(r.warnings.some(w => w.includes('FACTS_FENCE_BELOW_SENTINEL'))).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY row_num`,
    );
    expect(rows.rows.map((row: { fact: string }) => row.fact)).toEqual(['Founded Acme', 'Prefers async']);
  });

  test('#3625 control: a genuinely fence-less page (no fence anywhere in the body) still wipes as before', async () => {
    // Same shape as the misplaced-fence case above, but this time the fence
    // is truly absent from BOTH compiled_truth and timeline — the existing
    // "user deleted the fence" contract must still hold; the #3625 guard
    // must not swallow genuine deletions.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | seeded | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    await putPageWithTimeline('people/alice', '# Just a page\n\nNo fence.\n', 'Some unrelated timeline prose.\n');
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.factsDeleted).toBe(1);
    expect(r.warnings.some(w => w.includes('FACTS_FENCE_BELOW_SENTINEL'))).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT COUNT(*) AS n FROM facts WHERE source_markdown_slug = 'people/alice'`,
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  test('#3625 adversarial review finding: the marker merely mentioned inside a ```code block``` does not block a genuine deletion', async () => {
    // A naive `.includes(FACTS_FENCE_BEGIN)` check false-positives here — the
    // marker text is present in timeline, but only as documentation, not as
    // a real fence. The real fence was genuinely removed and must delete.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | seeded | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    await putPageWithTimeline(
      'people/alice',
      '# Alice\n\nThe real Facts fence was removed.\n',
      '## Docs\n\n```markdown\n<!--- gbrain:facts:begin -->\nexample only\n```\n',
    );
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.factsDeleted).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  test('#3625 adversarial review finding: the marker merely quoted in prose does not block a genuine deletion', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | seeded | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    await putPageWithTimeline(
      'people/alice',
      '# Alice\n\nThe real Facts fence was removed.\n',
      '> Historical docs mention the token <!--- gbrain:facts:begin -->, but this is not a fence.\n',
    );
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.factsDeleted).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  test('#3625 control: a genuine unbalanced marker (own line, not inside a code block) still blocks deletion', async () => {
    // Contrast with the two false-positive tests above — this marker IS a
    // real (if malformed/unbalanced) fence occurrence and must still guard.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | seeded | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    await putPageWithTimeline(
      'people/alice',
      '# Alice\n\nNo compiled fence.\n',
      '<!--- gbrain:facts:begin -->\nPRIVATE_UNBALANCED_ROW\n',
    );
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.factsDeleted).toBe(0);
    expect(r.warnings.some(w => w.includes('FACTS_FENCE_BELOW_SENTINEL'))).toBe(true);
  });

  test('#3625 adversarial review round 2: a CRLF-line-ending code block mentioning the marker does not false-positive', async () => {
    // Round-1 fix (scanFencedBlocks + string removal) normalized line
    // endings internally but tried to remove fence text from the
    // UN-normalized original string, silently failing to strip a CRLF code
    // block and leaving the false positive in place. The round-2 fix
    // (single-pass line scanner, one \r\n|\r|\n split applied throughout)
    // must handle this correctly.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | seeded | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    await putPageWithTimeline(
      'people/alice',
      '# Alice\n\nThe real Facts fence was removed.\n',
      '## Docs\r\n\r\n```markdown\r\n<!--- gbrain:facts:begin -->\r\nexample only\r\n```\r\n',
    );
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.factsDeleted).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  test('#3625 adversarial review round 2: two identical code-block mentions of the marker do not false-positive', async () => {
    await putPage('people/alice', FACT_FENCE(
      `| 1 | seeded | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    const codeBlock = '```markdown\n<!--- gbrain:facts:begin -->\nexample only\n```\n';
    await putPageWithTimeline(
      'people/alice',
      '# Alice\n\nThe real Facts fence was removed.\n',
      `${codeBlock}\n${codeBlock}`,
    );
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.factsDeleted).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  test('#3625 via the real MCP write path: a stray fence below the sentinel is preserved even when import-file.ts is in play', async () => {
    // Codex review finding: the two tests above write compiled_truth/timeline
    // directly via engine.putPage, bypassing importFromContent's own #2044
    // remote-preservation logic (restores an old fence into compiled_truth
    // when an incoming remote write's compiled half has ZERO facts — which
    // would otherwise mask a below-sentinel duplicate by never even letting
    // this test reach the state it wants to prove: confirmed by running the
    // simpler "compiled_truth ends up with zero facts" version of this test
    // first — #2044 fired and restored the OLD fence, so compiled_truth
    // never went empty and this guard was never exercised).
    //
    // Reproduce a case #2044 does NOT swallow: the incoming remote write's
    // compiled_truth keeps ONE valid fact above the sentinel (so
    // incomingFacts.facts.length > 0 — #2044's restore condition requires
    // exactly 0 and does not fire) while ALSO carrying a stray duplicate
    // fence below the sentinel (e.g. an agent re-appending a "## Facts"
    // section near new content it's adding at the bottom of the page).
    // splitBody() (inside putPage, called by importFromContent) does the
    // real fence/sentinel split — no direct column poking.
    const seed = `---
title: alice
type: person
---

Some body content.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  |  linkedin |  |
| 2 | Prefers async | preference | 0.85 | world | medium | 2026-04-29 |  |  OH |  |
<!--- gbrain:facts:end -->

<!-- timeline -->
`;
    await importFromContent(engine, 'people/alice', seed, { noEmbed: true, remote: true });
    await runExtractFacts(engine, { slugs: ['people/alice'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seeded = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice'`,
    );
    expect(seeded.rows).toHaveLength(2);

    // A malformed remote rewrite: row 1 stays correctly placed above the
    // sentinel (so #2044's restore never fires — incomingFacts.facts.length
    // is 1, not 0), but row 2 got duplicated into a second fence below it.
    const misplaced = `---
title: alice
type: person
---

Some body content.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  |  linkedin |  |
<!--- gbrain:facts:end -->

<!-- timeline -->

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Prefers async | preference | 0.85 | world | medium | 2026-04-29 |  |  OH |  |
<!--- gbrain:facts:end -->
`;
    await importFromContent(engine, 'people/alice', misplaced, { noEmbed: true, remote: true });

    const page = await engine.getPage('people/alice');
    // Sanity: confirm the real write path actually reproduces the #3625
    // precondition (#2044 did NOT restore anything away, and a fence marker
    // really did land in timeline) before trusting the assertions below.
    expect(parseFactsFence(page!.compiled_truth ?? '').facts).toHaveLength(1);
    expect((page!.timeline ?? '')).toContain('gbrain:facts:begin');

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(r.factsDeleted).toBe(0);
    expect(r.warnings.some(w => w.includes('FACTS_FENCE_BELOW_SENTINEL'))).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice'`,
    );
    expect(rows.rows).toHaveLength(2);
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

  test('soft-expired legacy rows do NOT trigger the guard (#2646 — forget_fact drains the backlog)', async () => {
    // A legacy row that forget_fact already soft-expired. Before #2646
    // the guard counted it forever: apply-migrations no-ops (migration
    // marked applied) and forget_fact only sets expired_at, so the
    // phase was permanently blocked with no sanctioned way out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, expired_at)
       VALUES ('default', 'people/alice', 'forgotten legacy claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0, now())`,
    );

    await putPage('people/alice', FACT_FENCE(
      `| 1 | new fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRowsPending).toBe(0);
    expect(r.factsInserted).toBe(1);

    // The expired legacy row itself is untouched (soft-expire is the
    // record of the forget; the phase must not hard-delete it).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE row_num IS NULL AND expired_at IS NOT NULL`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].fact).toBe('forgotten legacy claim');
  });

  test('expired legacy row WITH source_markdown_slug set survives reconcile untouched (#2646 codex P2)', async () => {
    // Hybrid shape: row_num NULL (legacy — never fence-owned) but
    // source_markdown_slug matching a live page. Without the
    // preserveExpiredLegacy filter, the reconcile pass would count it
    // as "stale", trigger a wipe, hard-delete the forget record, and
    // reinsert the fence's rows fresh — reviving a forgotten claim as
    // an active fact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, expired_at, source_markdown_slug)
       VALUES ('default', 'people/alice', 'forgotten hybrid claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0, now(), 'people/alice')`,
    );

    await putPage('people/alice', FACT_FENCE(
      `| 1 | fence fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    const r1 = await runExtractFacts(engine, { slugs: ['people/alice'] });
    const r2 = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r1.guardTriggered).toBe(false);
    // The expired hybrid row is invisible to the reconcile: the fence
    // fact inserts normally, nothing is wiped, and re-running stays
    // idempotent (the hybrid row must not read as perpetually stale).
    expect(r1.factsInserted).toBe(1);
    expect(r1.factsDeleted).toBe(0);
    expect(r2.factsInserted).toBe(0);
    expect(r2.factsDeleted).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, expired_at FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].fact).toBe('forgotten hybrid claim');
    expect(rows.rows[0].expired_at).not.toBeNull();
    expect(rows.rows[1].fact).toBe('fence fact');
    expect(rows.rows[1].expired_at).toBeNull();
  });

  test('expired legacy hybrid row survives even a stale-row wipe on the same page (#2646 codex P2)', async () => {
    // Force the wipe path: seed a fence, reconcile, then change the
    // fence so the old DB row goes stale. The wipe must delete the
    // stale fence-owned row but preserve the expired legacy hybrid.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, expired_at, source_markdown_slug)
       VALUES ('default', 'people/alice', 'forgotten hybrid claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0, now(), 'people/alice')`,
    );

    await putPage('people/alice', FACT_FENCE(
      `| 1 | old fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));
    await runExtractFacts(engine, { slugs: ['people/alice'] });

    // Replace the fence content — 'old fact' is now stale in the DB.
    await putPage('people/alice', FACT_FENCE(
      `| 1 | replacement fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));
    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.factsDeleted).toBe(1); // only the stale fence-owned row
    expect(r.factsInserted).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact FROM facts WHERE source_markdown_slug = 'people/alice' ORDER BY id`,
    );
    expect(rows.rows.map((row: { fact: string }) => row.fact))
      .toEqual(['forgotten hybrid claim', 'replacement fact']);
  });

  test('fence claim matching an expired legacy row is inserted active — fence is canonical (#2646)', async () => {
    // Deliberate semantics, pinned: legacy DB-only forgets are
    // documented NOT to survive rebuild (forget.ts header — the
    // explicit DB-only exception). When the fence still carries the
    // same (claim, source), the reconcile inserts a fresh active
    // fence-owned row; the expired legacy row survives alongside as
    // the record of the earlier forget. Suppressing the insert would
    // create silent fence↔DB divergence ("0 facts" while the fence
    // says otherwise) — the exact failure mode the guard prevents.
    // To durably forget, forget the fence-owned row (fence path).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, expired_at, source_markdown_slug)
       VALUES ('default', 'people/alice', 'shared claim', 'fact', 'private', 'medium',
               now(), 's', 1.0, now(), 'people/alice')`,
    );

    await putPage('people/alice', FACT_FENCE(
      `| 1 | shared claim | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    const r1 = await runExtractFacts(engine, { slugs: ['people/alice'] });
    const r2 = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r1.factsInserted).toBe(1);
    expect(r1.factsDeleted).toBe(0);
    // Idempotent thereafter — the coexisting pair is stable state.
    expect(r2.factsInserted).toBe(0);
    expect(r2.factsDeleted).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, row_num, expired_at FROM facts
        WHERE source_markdown_slug = 'people/alice' ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ fact: 'shared claim', row_num: null });
    expect(rows.rows[0].expired_at).not.toBeNull();   // forget record preserved
    expect(rows.rows[1]).toMatchObject({ fact: 'shared claim', row_num: 1 });
    expect(rows.rows[1].expired_at).toBeNull();       // fence-canonical active row
  });

  test('mixed active + expired legacy rows: guard counts only the active ones (#2646)', async () => {
    // One active legacy row + one soft-expired legacy row. The guard
    // must still trigger (an active row is pending backfill) but the
    // pending count must exclude the expired row — so each forget_fact
    // visibly drains the counter toward release.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, expired_at)
       VALUES
         ('default', 'people/alice', 'active legacy claim', 'fact', 'private', 'medium',
          now(), 'mcp:put_page', 1.0, NULL),
         ('default', 'people/alice', 'expired legacy claim', 'fact', 'private', 'medium',
          now(), 'mcp:put_page', 1.0, now())`,
    );

    await putPage('people/alice', FACT_FENCE(
      `| 1 | new fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });

    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRowsPending).toBe(1);
    expect(r.factsInserted).toBe(0);
    expect(r.factsDeleted).toBe(0);
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

describe('runExtractFacts — guard requires a fenceable source (#2763)', () => {
  const seedLegacyRow = async (): Promise<void> => {
    // NULL-row_num fact whose entity_slug maps to a LIVE page — the shape
    // the guard gates on.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/alice', 'db-only claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0)`,
    );
    await putPage('people/alice', FACT_FENCE(
      `| 1 | new fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));
  };

  test('a local_path-less source does NOT trip the guard (thin-client rows are unfenceable)', async () => {
    // Thin-client / DB-only source: the backstop writer keeps producing
    // row_num-NULL rows with a live backing page, but the v0_32_2 Phase B
    // backfill SKIPS sources without local_path (skipped_no_local_path)
    // while returning complete — those rows can never drain, so they must
    // not jam the phase forever.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE sources SET local_path = NULL WHERE id = 'default'`,
    );
    await seedLegacyRow();

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRowsPending).toBe(0);
    expect(r.factsInserted).toBe(1);
  });

  test('the same row on a source WITH local_path still trips the guard', async () => {
    // beforeEach set default.local_path (the migrated v0.31 brain shape);
    // Phase B CAN fence this row, so the guard must keep gating.
    await seedLegacyRow();

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRowsPending).toBe(1);
    expect(r.factsInserted).toBe(0);
  });
});

describe('runExtractFacts — multi-source isolation', () => {
  test('a pending legacy row in source A does NOT jam extraction for source B (#2646 source-scope)', async () => {
    // local_path set: 'work' simulates a fenceable (migrated) source, so
    // its pending legacy row must still gate work's own cycle (#2763).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('work', 'work', '/tmp/gbrain-extract-facts-work-src', '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    );

    // Source "work": a genuine pending legacy row (row_num NULL, active,
    // live backing page) — the exact shape that must gate work's cycle.
    await engine.putPage('people/alice', {
      title: 'people/alice', type: 'person',
      compiled_truth: FACT_FENCE(`| 1 | work fence fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`),
      frontmatter: {}, timeline: '',
    }, { sourceId: 'work' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('work', 'people/alice', 'work legacy claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0)`,
    );

    // Source "default": clean — no legacy rows, one fenced page.
    await putPage('people/bob', FACT_FENCE(
      `| 1 | default fact | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`,
    ));

    // default's run must NOT be jammed by work's pending backlog.
    const rDefault = await runExtractFacts(engine, { slugs: ['people/bob'], sourceId: 'default' });
    expect(rDefault.guardTriggered).toBe(false);
    expect(rDefault.legacyRowsPending).toBe(0);
    expect(rDefault.factsInserted).toBe(1);

    // work's own run still gates (discriminator stays sharp).
    const rWork = await runExtractFacts(engine, { slugs: ['people/alice'], sourceId: 'work' });
    expect(rWork.guardTriggered).toBe(true);
    expect(rWork.legacyRowsPending).toBe(1);
    expect(rWork.factsInserted).toBe(0);
    // The drain advice must be one that actually re-runs Phase B — a bare
    // `apply-migrations --yes` no-ops once the ledger says complete.
    expect(rWork.warnings.some(w => w.includes('--force-retry 0.32.2'))).toBe(true);
    expect(rWork.warnings.some(w => w.includes('forget_fact'))).toBe(true);
    expect(rWork.warnings.some(w => w.includes('source "work"'))).toBe(true);
  });

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

describe('runExtractFacts — v0.46 (#3014) supersession transport + heal', () => {
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
    // The only expected warning is the NULL-embedding notice (#2821) — no
    // supersession-resolution warning for a clean #2 reference.
    expect(r.warnings.filter(w => w.includes('superseded'))).toEqual([]);

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

  // A permanently-unresolvable reference must NOT re-drift every cycle. A
  // naive drift term keyed off "the fence has a reference" vs "the DB
  // resolved one" would see self / dangling / chain (which correctly stay
  // NULL) drift forever — a full wipe+reinsert + duplicate warning each
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
    expect(second.warnings.filter(w => w.includes('superseded'))).toEqual([]);
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
    expect(second.warnings.filter(w => w.includes('superseded'))).toEqual([]);
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
    expect(second.warnings.filter(w => w.includes('superseded'))).toEqual([]);
    expect(await readIds()).toEqual(idsAfterFirst);
  });

  // The no-churn drift term must not mask a genuine reference change.
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

  // Pre-fix, the reconcile deleted the page in a self-committing transaction
  // BEFORE the separate insertFacts transaction; an insert throw left the
  // page permanently emptied. The caller now defers the wipe into
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

  // An int4-overflowing #N in the fence must be treated as a dangling
  // reference, never overflow the resolution SELECT and abort the cycle.
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
    expect(second.warnings.filter(w => w.includes('superseded'))).toEqual([]);
    expect(await readIds()).toEqual(idsAfterFirst);
  });
});
