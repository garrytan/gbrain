/**
 * v0.32.2 commit 8 — 3-layer privacy strip + forget-as-fence tests.
 *
 * Three layers under test:
 *   - Layer A (chunker): chunkText strips private fact rows so private
 *     text never reaches content_chunks (Codex R2-#1 P0)
 *   - Layer B (get_page privacy trigger): stripFactsFence + stripTakesFence
 *     fire when ctx.remote === true (Codex R2-#5 closes the subagent hole)
 *   - Forget-as-fence: forgetFactInFence rewrites the fence row instead of
 *     the DB-only expire path so forgets survive gbrain rebuild (Codex R2-#3)
 *
 * Real PGLite + tempdir filesystem.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../src/core/facts-fence.ts';

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
  brainDir = mkdtempSync(join(tmpdir(), 'privacy-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

const FENCE_BODY = (rows: string): string => `# Page

Some text.

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
${FACTS_FENCE_END}
`;

// ─────────────────────────────────────────────────────────────────
// Layer A: chunker strip — private fact text NEVER reaches chunks
// ─────────────────────────────────────────────────────────────────

describe('Layer A — chunker strips private fact rows (Codex R2-#1)', () => {
  test('chunkText drops private fact text from output', () => {
    const body = FENCE_BODY(
      `| 1 | PUBLIC_FACT_PROOF | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_FACT_PROOF | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');

    expect(allText).toContain('PUBLIC_FACT_PROOF');     // world fact survives
    expect(allText).not.toContain('PRIVATE_FACT_PROOF'); // private fact dropped
  });

  test('private-only fence still produces chunks (the prose around it survives)', () => {
    const body = FENCE_BODY(
      `| 1 | SECRET | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');

    expect(allText).not.toContain('SECRET');
    // The prose ("Some text.") is preserved.
    expect(allText).toContain('Some text.');
  });

  test('no fence at all → chunker behavior unchanged', () => {
    const body = '# Just a page\n\nNo fence here.\n';
    const chunks = chunkText(body);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('Just a page');
  });

  test('private takes fence ALSO stripped (regression — v0.28 behavior preserved)', () => {
    const body = `# Page

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | PRIVATE_TAKE | take | brain | 0.9 | 2026-01-01 |  |
<!--- gbrain:takes:end -->

Body text.`;
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).not.toContain('PRIVATE_TAKE');
    expect(allText).toContain('Body text');
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer B: get_page strip trigger — ctx.remote drives the filter
// ─────────────────────────────────────────────────────────────────
//
// The trigger logic lives in src/core/operations.ts (the get_page
// handler) and is unit-tested via direct stripFactsFence + the
// `ctx.remote === true` check pattern. Full operations-dispatch
// integration test for get_page over MCP lives in
// test/e2e/system-of-record-invariant.test.ts (commit 10).

describe('Layer B — get_page strip trigger (Codex R2-#5)', () => {
  test('stripFactsFence({keepVisibility:["world"]}) drops private rows in body', async () => {
    // Use the fence's own stripFactsFence helper to verify the
    // shape that operations.ts will call. The trigger lives in
    // operations.ts:413 (now `ctx.remote === true`); we test the
    // helper here, and the trigger plumbing E2E in commit 10.
    const { stripFactsFence } = await import('../src/core/facts-fence.ts');
    const body = FENCE_BODY(
      `| 1 | WORLD_ROW | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_ROW | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const stripped = stripFactsFence(body, { keepVisibility: ['world'] });
    expect(stripped).toContain('WORLD_ROW');
    expect(stripped).not.toContain('PRIVATE_ROW');
  });
});

// ─────────────────────────────────────────────────────────────────
// Forget-as-fence (Codex R2-#3)
// ─────────────────────────────────────────────────────────────────

async function seedV51Fact(opts: {
  entity_slug: string;
  source_markdown_slug: string;
  row_num: number;
  fact: string;
  source?: string;
}): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence, row_num, source_markdown_slug)
     VALUES ('default', $1, $2, 'fact', 'world', 'medium', now(), $3, 1.0, $4, $5)
     RETURNING id`,
    [opts.entity_slug, opts.fact, opts.source ?? 's', opts.row_num, opts.source_markdown_slug],
  );
  return r.rows[0].id;
}

function seedFile(slug: string, rows: string): void {
  const filePath = join(brainDir, `${slug}.md`);
  mkdirSync(join(brainDir, slug.split('/')[0]), { recursive: true });
  writeFileSync(filePath, FENCE_BODY(rows), 'utf-8');
}

describe('forgetFactInFence — fence path (happy)', () => {
  test('rewrites the fence row with strikethrough + valid_until + forgotten context', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'I will hit $10M by Q4',
    });
    seedFile('people/alice', `| 1 | I will hit $10M by Q4 | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const r = await forgetFactInFence(engine, id, { reason: 'changed my mind' });
    expect(r.ok).toBe(true);
    expect(r.path).toBe('fence');

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('~~I will hit $10M by Q4~~');
    expect(body).toContain('forgotten: changed my mind');

    // DB row expired_at is now non-null + valid_until set to today.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbRow = await (engine as any).db.query(
      'SELECT expired_at, valid_until FROM facts WHERE id = $1', [id],
    );
    expect(dbRow.rows[0].expired_at).not.toBeNull();
    expect(dbRow.rows[0].valid_until).not.toBeNull();
  });

  test('re-parsing the rewritten fence sees forgotten=true + active=false', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F1',
    });
    seedFile('people/alice', `| 1 | F1 | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    await forgetFactInFence(engine, id, { reason: 'test' });

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    const parsed = parseFactsFence(body);
    expect(parsed.facts[0]).toMatchObject({
      claim: 'F1',
      active: false,
      forgotten: true,
    });
  });

  test('default reason is "forgotten" when caller omits it', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    seedFile('people/alice', `| 1 | F | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const r = await forgetFactInFence(engine, id);
    expect(r.reason).toBe('forgotten');

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('forgotten: forgotten');
  });

  test('preserves existing context cell (appends rather than overwriting)', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    seedFile(
      'people/alice',
      `| 1 | F | fact | 1.0 | world | medium | 2026-01-01 |  | s | important note |`,
    );

    await forgetFactInFence(engine, id, { reason: 'r' });

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('important note');
    expect(body).toContain('forgotten: r');
  });
});

describe('forgetFactInFence — fallback paths', () => {
  test('legacy NULL-row_num fact falls back to DB-only expire', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/alice', 'legacy', 'fact', 'world', 'medium',
               now(), 's', 1.0) RETURNING id`,
    );
    const id = r.rows[0].id;

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = await (engine as any).db.query(
      'SELECT expired_at FROM facts WHERE id = $1', [id],
    );
    expect(after.rows[0].expired_at).not.toBeNull();
  });

  test('missing local_path on source falls back to DB-only', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('missing entity page file falls back to DB-only (file deleted out from under us)', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/ghost', source_markdown_slug: 'people/ghost',
      row_num: 1, fact: 'F',
    });
    // No file created — page exists in DB but not on disk.
    expect(existsSync(join(brainDir, 'people/ghost.md'))).toBe(false);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('row_num drift (DB has v51 cols but fence missing the row) falls back to DB-only', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 99, fact: 'F',  // row_num 99 in DB but only row 1 in fence
    });
    seedFile('people/alice', `| 1 | Different fact | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('unknown id returns ok:false path:not_found', async () => {
    const result = await forgetFactInFence(engine, 999999);
    expect(result.ok).toBe(false);
    expect(result.path).toBe('not_found');
  });

  test('already-expired id returns ok:false path:already_expired', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE facts SET expired_at = now() WHERE id = $1`, [id]);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(false);
    expect(result.path).toBe('already_expired');
  });
});

afterAll(() => {
  try { if (brainDir) rmSync(brainDir, { recursive: true, force: true }); }
  catch { /* best-effort */ }
});
