/**
 * #4696 — a forgotten fact must stay forgotten across the extract_facts
 * reconcile.
 *
 * The reconcile reads `pages.compiled_truth`, not the .md file. forget used
 * to rewrite the file (fence path) or only expire the DB row (legacy path)
 * and leave the DB body advertising the row live, so the next reconcile saw
 * fence-live/row-expired drift and re-inserted the claim active at the same
 * row_num. Both paths now strike the row in the DB body too.
 *
 * Real PGLite; no LLM, no network.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
let brainDir: string;

const SLUG = 'people/alice-example';
// Two frontmatter keys + tags on purpose: pages.frontmatter is JSONB (key
// order normalized), so any hash the strike computed could never match the
// importer's — the mirror must leave the row's content_hash alone.
const FILE = `---
title: Alice Example
type: person
tags: [founder, example]
---
# Alice Example

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded acme-example | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |
<!--- gbrain:facts:end -->
`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'forget-reconcile-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  rmSync(join(brainDir, 'people'), { recursive: true, force: true });
});

/** Import the page from its file, reconcile once, return the seeded fact id. */
async function seed(): Promise<number> {
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  writeFileSync(join(brainDir, `${SLUG}.md`), FILE, 'utf-8');
  const imp = await importFromContent(engine, SLUG, FILE, { noEmbed: true, sourceId: 'default' });
  expect(imp.status).toBe('imported');
  await runExtractFacts(engine, { slugs: [SLUG] });
  const rows = await factRows();
  expect(rows.length).toBe(1);
  expect(rows[0].expired_at).toBeNull();
  return Number(rows[0].id);
}

function factRows() {
  return engine.executeRaw<{ id: number; expired_at: Date | null }>(
    `SELECT id, expired_at FROM facts WHERE source_markdown_slug = $1 ORDER BY id`,
    [SLUG],
  );
}

async function expectForgetHeld(id: number): Promise<void> {
  const page = await engine.getPage(SLUG, { sourceId: 'default' });
  expect(page!.compiled_truth).toContain('~~Founded acme-example~~');

  await runExtractFacts(engine, { slugs: [SLUG] });

  const rows = await factRows();
  expect(rows.length).toBe(1);
  expect(Number(rows[0].id)).toBe(id); // same row, not a re-inserted twin
  expect(rows[0].expired_at).not.toBeNull();
}

describe('forget survives the extract_facts reconcile (#4696)', () => {
  test('fence path: the DB body is struck, so the reconcile is a no-op', async () => {
    const id = await seed();
    const r = await forgetFactInFence(engine, id, { reason: 'test' });
    expect(r).toMatchObject({ ok: true, path: 'fence' });
    await expectForgetHeld(id);
  });

  test('fence path: the next sync re-imports and re-chunks the struck row', async () => {
    const id = await seed();
    await forgetFactInFence(engine, id, { reason: 'test' });
    const struck = readFileSync(join(brainDir, `${SLUG}.md`), 'utf-8');
    expect(struck).toContain('~~Founded acme-example~~');
    // The DB-body strike leaves content_chunks untouched, so it must not
    // claim the importer's hash: sync has to re-chunk or the struck claim
    // keeps surfacing verbatim in chunk search (wave review).
    const imp = await importFromContent(engine, SLUG, struck, { noEmbed: true, sourceId: 'default' });
    expect(imp.status).toBe('imported');
    const chunks = await engine.getChunks(SLUG, { sourceId: 'default', requireSafeChunks: true });
    expect(chunks.map((c) => c.chunk_text).join('\n')).toContain('~~Founded acme-example~~');
  });

  test('legacy path (file gone): the DB body is struck, so the reconcile is a no-op', async () => {
    const id = await seed();
    rmSync(join(brainDir, `${SLUG}.md`));
    const r = await forgetFactInFence(engine, id, { reason: 'test' });
    expect(r).toMatchObject({ ok: true, path: 'legacy_db' });
    await expectForgetHeld(id);
  });
});
