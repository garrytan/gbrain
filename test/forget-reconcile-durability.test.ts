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
import { acquirePageLock } from '../src/core/page-lock.ts';

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

// ─── wave review: legacy-tier hash, page lock, never an empty hash ──
describe('forget DB-body mirror — hash + lock discipline (wave review)', () => {
  test('legacy path (no local_path): the row stops claiming the unchanged file\'s hash, so the next sync re-imports', async () => {
    // The legacy tier does NOT rewrite the file. Keeping the importer's hash
    // on the struck row made the next sync `skipped` the page: the DB body
    // said struck while content_chunks kept the live claim, forever.
    const id = await seed();
    const before = (await engine.getPage(SLUG, { sourceId: 'default' }))!.content_hash;
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    try {
      const r = await forgetFactInFence(engine, id, { reason: 'test' });
      expect(r).toMatchObject({ ok: true, path: 'legacy_db' });
      const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
      expect(page.compiled_truth).toContain('~~Founded acme-example~~');
      expect(page.content_hash).toBeTruthy();
      expect(page.content_hash).not.toBe(before);
      // The importer's own idempotency check: same file bytes must now re-import.
      const imp = await importFromContent(engine, SLUG, FILE, { noEmbed: true, sourceId: 'default' });
      expect(imp.status).toBe('imported');
    } finally {
      await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
    }
  });

  test('legacy path honors the page lock: a live holder defers the DB-body strike (Codex P1)', async () => {
    // strikeDbBody is a read-modify-write on pages.compiled_truth; the fence
    // writers hold the per-page lock around theirs. Pre-fix the legacy tier
    // ran it lock-free and could clobber a concurrent fence write.
    const id = await seed();
    rmSync(join(brainDir, `${SLUG}.md`));
    const handle = await acquirePageLock(SLUG, { timeoutMs: 0 });
    expect(handle).not.toBeNull();
    try {
      const r = await forgetFactInFence(engine, id, { reason: 'test' });
      expect(r).toMatchObject({ ok: true, path: 'legacy_db' }); // the facts row still expires
      const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
      expect(page.compiled_truth).not.toContain('~~'); // strike waited on the lock and gave up
    } finally {
      await handle!.release();
    }
  }, 20_000);

  test('fence path never persists an empty content_hash', async () => {
    const id = await seed();
    await engine.executeRaw(`UPDATE pages SET content_hash = NULL WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
    const r = await forgetFactInFence(engine, id, { reason: 'test' });
    expect(r).toMatchObject({ ok: true, path: 'fence' });
    const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
    expect(page.compiled_truth).toContain('~~Founded acme-example~~');
    expect(typeof page.content_hash).toBe('string');
    expect(page.content_hash!.length).toBeGreaterThan(0);
  });
});
