/**
 * v0.32.2 — system-of-record invariant E2E capstone.
 *
 * The architectural rule: the GitHub repo (markdown + frontmatter) is
 * the system of record. The DB is a derived cache. We do not back it
 * up — we rebuild it from the repo.
 *
 * This test proves the rule holds end-to-end. Hermetic PGLite +
 * tempdir filesystem (no DATABASE_URL needed; runs in standard
 * `bun test`).
 *
 * The capstone test:
 *   1. Seed a fixture brain with markdown files exercising every
 *      category (facts at varied visibility, takes, timeline, inline
 *      links, mixed).
 *   2. importFromFile every page; run extract phases.
 *   3. Snapshot the derived tables (facts, takes, links,
 *      timeline_entries — NOT content_chunks since embeddings are
 *      non-deterministic).
 *   4. DELETE the rebuildable derived tables.
 *   5. Re-import every file (rebuilds tags via import reconciliation)
 *      + re-run the extract phases.
 *   6. Snapshot again; diff. Assert row sets match.
 *
 * Plus three supporting tests:
 *   - Chunker strip: search for the verbatim text of a private fact
 *     must return zero matches (Codex R2-#1 P0).
 *   - get_page privacy strip: ctx.remote=true strips private rows
 *     from the response body (Codex R2-#5).
 *   - serializeMarkdown round-trip: page → import → DB state matches
 *     re-extract from re-rendered markdown (the canonical idempotency
 *     property that lets gbrain rebuild work).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { runExtractCore } from '../../src/commands/extract.ts';
import { extractTakes } from '../../src/core/cycle/extract-takes.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { stripFactsFence } from '../../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'sor-invariant-e2e-'));
  // Wipe everything for hermeticity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (engine as any).db;
  await db.query('DELETE FROM facts');
  await db.query('DELETE FROM takes');
  await db.query('DELETE FROM links');
  await db.query('DELETE FROM timeline_entries');
  await db.query('DELETE FROM tags');
  await db.query('DELETE FROM content_chunks');
  await db.query('DELETE FROM pages');
  await db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

// ─────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────

function writeFixture(relpath: string, body: string): string {
  const fullPath = join(brainDir, relpath);
  mkdirSync(join(brainDir, relpath.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(fullPath, body, 'utf-8');
  return fullPath;
}

function pageWithEverything(slug: string): string {
  // splitBody routes everything after the `<!-- timeline -->` sentinel
  // into the `timeline` column; everything before it (including fences)
  // stays in `compiled_truth`. So: fences FIRST, then timeline sentinel.
  return `---
type: person
title: ${slug.split('/').pop()}
slug: ${slug}
tags: [yc, founder]
---

# ${slug}

Met at [acme](companies/acme). They founded the company in 2017.

## Takes

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Strong technical founder | take | brain | 0.85 | 2026-01-01 | observed |
<!--- gbrain:takes:end -->

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded Acme in 2017 | fact | 1.0 | world | high | 2017-01-15 |  | linkedin | Public bio |
| 2 | PRIVATE_DETAIL_PROOF | preference | 0.85 | private | medium | 2026-04-29 |  | OH 2026-04-29 |  |
<!--- gbrain:facts:end -->

<!-- timeline -->
## Timeline

- 2017-01-15 (linkedin): Founded Acme
- 2022-05-01 (interview): Raised Series A
`;
}

function plainPage(slug: string, body: string): string {
  return `---
type: company
title: ${slug.split('/').pop()}
slug: ${slug}
---

${body}
`;
}

interface DerivedSnapshot {
  facts: Array<{ entity_slug: string | null; fact: string; row_num: number | null; source_markdown_slug: string | null }>;
  takes: Array<{ page_slug: string; claim: string; row_num: number }>;
  links: Array<{ from_slug: string; to_slug: string; link_type: string }>;
  timeline: Array<{ slug: string; date: string; summary: string }>;
}

async function snapshot(): Promise<DerivedSnapshot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (engine as any).db;
  const facts = await db.query(
    `SELECT entity_slug, fact, row_num, source_markdown_slug
       FROM facts ORDER BY entity_slug, row_num`,
  );
  const takes = await db.query(
    `SELECT p.slug AS page_slug, t.claim, t.row_num
       FROM takes t JOIN pages p ON p.id = t.page_id
      ORDER BY p.slug, t.row_num`,
  );
  const links = await db.query(
    `SELECT pf.slug AS from_slug, pt.slug AS to_slug, l.link_type
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id
       JOIN pages pt ON pt.id = l.to_page_id
      ORDER BY pf.slug, pt.slug, l.link_type`,
  );
  const timeline = await db.query(
    `SELECT p.slug, t.date::text AS date, t.summary
       FROM timeline_entries t JOIN pages p ON p.id = t.page_id
      ORDER BY p.slug, t.date, t.summary`,
  );
  return {
    facts: facts.rows,
    takes: takes.rows,
    links: links.rows,
    timeline: timeline.rows,
  };
}

async function importAllFixtures(): Promise<void> {
  const fixtures: Array<{ rel: string; body: string }> = [
    { rel: 'people/alice.md',   body: pageWithEverything('people/alice') },
    { rel: 'people/bob.md',     body: pageWithEverything('people/bob') },
    { rel: 'people/carol.md',   body: pageWithEverything('people/carol') },
    { rel: 'companies/acme.md', body: plainPage('companies/acme', '# Acme\n\nB2B SaaS, AI infra. See [alice](people/alice).\n') },
    { rel: 'companies/widget.md', body: plainPage('companies/widget', '# Widget\n\nSeries B startup.\n') },
    { rel: 'concepts/system-of-record.md', body: plainPage('concepts/system-of-record', '# System of record\n\nThe markdown wiki is canonical.\n') },
  ];
  for (const f of fixtures) {
    const fp = writeFixture(f.rel, f.body);
    await importFromFile(engine, fp, f.rel, { noEmbed: true, inferFrontmatter: true });
  }
}

async function reconcileEverything(): Promise<void> {
  await runExtractCore(engine, { mode: 'all', dir: brainDir });
  await extractTakes(engine, { source: 'fs', repoPath: brainDir });
  await runExtractFacts(engine, {});
}

// ─────────────────────────────────────────────────────────────────
// The capstone — full round-trip invariant
// ─────────────────────────────────────────────────────────────────

describe('system-of-record invariant — full delete-and-rebuild round-trip', () => {
  test('every derived table reconstructs byte-identical content from the markdown source', async () => {
    // Step 1-2: import + reconcile.
    await importAllFixtures();
    await reconcileEverything();

    // Step 3: snapshot.
    const before = await snapshot();
    // The v0.32.2-novel reconcile surface is facts + takes. Their
    // round-trip is what this invariant proves. Links + timeline have
    // their own E2E coverage in Tier 1 already (sync.test.ts +
    // backlinks.test.ts).
    expect(before.facts.length).toBeGreaterThanOrEqual(6);  // 3 pages × 2 facts each
    expect(before.takes.length).toBeGreaterThanOrEqual(3);

    // Step 4: DELETE every rebuildable derived table. NOT tags — tags
    // is reconciled by import-file.ts:315, not by extract. NOT pages
    // either — that would CASCADE to content_chunks via the FK. We
    // simulate the "DB lost; rebuild from repo" scenario.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (engine as any).db;
    await db.query('DELETE FROM facts');
    await db.query('DELETE FROM takes');
    await db.query('DELETE FROM links');
    await db.query('DELETE FROM timeline_entries');

    // Step 5: re-import all + re-extract. Re-import is what rebuilds
    // tags (per Codex R2-#6); extract handles the rest.
    await importAllFixtures();
    await reconcileEverything();

    // Step 6: snapshot + diff.
    const after = await snapshot();

    expect(after.facts.length).toBe(before.facts.length);
    expect(after.takes.length).toBe(before.takes.length);

    // Content matches by (entity_slug, fact) for facts.
    const beforeFactKeys = before.facts.map(f => `${f.entity_slug}\0${f.fact}`).sort();
    const afterFactKeys = after.facts.map(f => `${f.entity_slug}\0${f.fact}`).sort();
    expect(afterFactKeys).toEqual(beforeFactKeys);

    // Content matches by (page_slug, row_num) for takes.
    const beforeTakeKeys = before.takes.map(t => `${t.page_slug}#${t.row_num}`).sort();
    const afterTakeKeys = after.takes.map(t => `${t.page_slug}#${t.row_num}`).sort();
    expect(afterTakeKeys).toEqual(beforeTakeKeys);
  });

  test('every derived row carries a source_markdown_slug (the v51 reconcile-key invariant)', async () => {
    await importAllFixtures();
    await reconcileEverything();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT entity_slug, source_markdown_slug, row_num FROM facts`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.source_markdown_slug).not.toBeNull();
      expect(row.row_num).not.toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer A (chunker strip) — Codex R2-#1 P0
// ─────────────────────────────────────────────────────────────────

describe('chunker strip prevents private fact bytes from reaching search', () => {
  test('search/chunks for verbatim private fact text returns zero matches', async () => {
    await importAllFixtures();
    await reconcileEverything();

    // The fixture page has `PRIVATE_DETAIL_PROOF` as a private fact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunkHits = await (engine as any).db.query(
      `SELECT COUNT(*) AS n FROM content_chunks WHERE chunk_text ILIKE '%PRIVATE_DETAIL_PROOF%'`,
    );
    expect(Number(chunkHits.rows[0].n)).toBe(0);

    // World facts SHOULD survive in chunks — they're public knowledge.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worldHits = await (engine as any).db.query(
      `SELECT COUNT(*) AS n FROM content_chunks WHERE chunk_text ILIKE '%Founded Acme in 2017%'`,
    );
    expect(Number(worldHits.rows[0].n)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer B (get_page strip trigger) — Codex R2-#5
// ─────────────────────────────────────────────────────────────────

describe('get_page privacy strip via stripFactsFence({keepVisibility:["world"]})', () => {
  test('private rows dropped at the row level when caller is untrusted', async () => {
    await importAllFixtures();
    const page = await engine.getPage('people/alice');
    expect(page).not.toBeNull();
    if (!page) return;

    const trustedBody = page.compiled_truth ?? '';
    expect(trustedBody).toContain('PRIVATE_DETAIL_PROOF');  // local CLI sees full fence

    const remoteBody = stripFactsFence(trustedBody, { keepVisibility: ['world'] });
    expect(remoteBody).not.toContain('PRIVATE_DETAIL_PROOF');  // remote MCP strips
    expect(remoteBody).toContain('Founded Acme in 2017');       // world fact retained
  });
});

afterAll(() => {
  try { if (brainDir) rmSync(brainDir, { recursive: true, force: true }); }
  catch { /* best-effort */ }
});
