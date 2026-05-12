/**
 * v0.32.7 CJK wave — reindex sweep tests.
 *
 * Drives `gbrain reindex --markdown` against an in-memory PGLite brain,
 * verifies the chunker_version sweep updates rows below the current
 * MARKDOWN_CHUNKER_VERSION and is idempotent on re-run.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindex } from '../src/commands/reindex.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';

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
  await (engine as any).db.exec('DELETE FROM content_chunks');
  await (engine as any).db.exec('DELETE FROM pages');
});

async function seedLegacyPage(slug: string, body: string, sourcePath: string | null = null) {
  // Force chunker_version=1 explicitly to simulate a pre-bump row.
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title, compiled_truth, page_kind, chunker_version, source_path)
     VALUES ($1, 'note', $2, $3, 'markdown', 1, $4)`,
    [slug, slug.split('/').pop() ?? slug, body, sourcePath],
  );
}

describe('gbrain reindex --markdown (v0.32.7)', () => {
  test('dry-run reports pending count and does not write', async () => {
    await seedLegacyPage('note-a', 'body a');
    await seedLegacyPage('note-b', 'body b');

    const result = await runReindex(engine, ['--markdown', '--dry-run']);
    expect(result.dryRun).toBe(true);
    expect(result.pending).toBe(2);
    expect(result.reindexed).toBe(0);

    // chunker_version still 1 after dry-run
    const rows = await engine.executeRaw<{ chunker_version: number }>(
      `SELECT chunker_version FROM pages WHERE slug IN ('note-a', 'note-b') ORDER BY slug`,
    );
    expect(rows.every(r => Number(r.chunker_version) === 1)).toBe(true);
  });

  test('actual sweep bumps chunker_version on each row', async () => {
    await seedLegacyPage('note-c', 'content for c\n\nmore content');
    await seedLegacyPage('note-d', 'content for d');

    const result = await runReindex(engine, ['--markdown', '--no-embed']);
    expect(result.reindexed).toBe(2);
    expect(result.failed).toBe(0);

    const rows = await engine.executeRaw<{ chunker_version: number }>(
      `SELECT chunker_version FROM pages WHERE slug IN ('note-c', 'note-d')`,
    );
    expect(rows.every(r => Number(r.chunker_version) === MARKDOWN_CHUNKER_VERSION)).toBe(true);
  });

  test('idempotent: re-run on a fully-updated brain reports nothing to do', async () => {
    await seedLegacyPage('note-e', 'body e');
    await runReindex(engine, ['--markdown', '--no-embed']);
    const second = await runReindex(engine, ['--markdown', '--no-embed']);
    expect(second.pending).toBe(0);
    expect(second.reindexed).toBe(0);
  });

  test('--limit caps the work done in one invocation', async () => {
    for (let i = 0; i < 5; i++) await seedLegacyPage(`note-lim-${i}`, `body ${i}`);
    const result = await runReindex(engine, ['--markdown', '--no-embed', '--limit', '2']);
    expect(result.reindexed).toBe(2);

    const remaining = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*)::bigint AS count
         FROM pages
        WHERE page_kind = 'markdown' AND chunker_version < $1`,
      [MARKDOWN_CHUNKER_VERSION],
    );
    expect(Number(remaining[0].count)).toBe(3);
  });

  test('REGRESSION: forceRechunk bypasses content_hash short-circuit (codex F1)', async () => {
    // The bug: importFromContent skips pages whose content_hash matches even
    // when the chunker version is stale. The fix: reindex passes
    // forceRechunk: true so the bumped chunker actually applies.
    //
    // We can't easily verify chunk_text changed (CJK delimiters are additive
    // for English text), but we can verify chunker_version was bumped on the
    // row even though compiled_truth + content_hash are unchanged from the
    // import.
    await seedLegacyPage('regression-force-rechunk', 'unchanged body text');

    // First reindex pass — content_hash gets stamped to match the body.
    await runReindex(engine, ['--markdown', '--no-embed']);

    // Mock a "stale chunker" state: reset chunker_version to 1 WITHOUT
    // changing compiled_truth. A non-forceRechunk import would now skip.
    await engine.executeRaw(
      `UPDATE pages SET chunker_version = 1 WHERE slug = 'regression-force-rechunk'`,
    );

    // Second reindex pass — must bump chunker_version DESPITE content_hash
    // matching the stored value.
    const result = await runReindex(engine, ['--markdown', '--no-embed']);
    expect(result.reindexed).toBe(1);

    const rows = await engine.executeRaw<{ chunker_version: number }>(
      `SELECT chunker_version FROM pages WHERE slug = 'regression-force-rechunk'`,
    );
    expect(Number(rows[0].chunker_version)).toBe(MARKDOWN_CHUNKER_VERSION);
  });

  test('skips pages already at current chunker_version', async () => {
    // Pre-bump page (chunker_version = 1)
    await seedLegacyPage('note-up', 'pending body');
    // Already-bumped page (chunker_version = current)
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, page_kind, chunker_version)
       VALUES ('note-current', 'note', 'note-current', 'current body', 'markdown', $1)`,
      [MARKDOWN_CHUNKER_VERSION],
    );

    const result = await runReindex(engine, ['--markdown', '--no-embed']);
    expect(result.pending).toBe(1);
    expect(result.reindexed).toBe(1);
  });
});
