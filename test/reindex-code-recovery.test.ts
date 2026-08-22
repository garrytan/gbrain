/**
 * issue #3970 — 3-surface recovery for code pages stuck without symbol
 * metadata (the content_hash short-circuit makes a plain reindex a no-op):
 *
 *   1. `reindexForceHint` — the "0 reindexed, N skipped" summary points at
 *      --force (pure helper, unit-tested here).
 *   2. doctor `code_chunk_metadata` — counts code-page chunks with
 *      symbol_name IS NULL AND language IS NULL and names
 *      `gbrain reindex-code --force` as the cure.
 *   3. the CLI help line for reindex-code documents --force.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { reindexForceHint } from '../src/commands/reindex-code.ts';
import { checkCodeChunkMetadata } from '../src/commands/doctor.ts';

describe('reindexForceHint (#3970 surface 3)', () => {
  test('all-skipped pass without --force → hint naming --force', () => {
    const hint = reindexForceHint({ reindexed: 0, skipped: 12 }, false);
    expect(hint).not.toBeNull();
    expect(hint!).toContain('--force');
    expect(hint!).toContain('12');
    expect(hint!).toContain('content_hash');
  });

  test('no hint when --force was already passed', () => {
    expect(reindexForceHint({ reindexed: 0, skipped: 12 }, true)).toBeNull();
  });

  test('no hint when pages actually reindexed', () => {
    expect(reindexForceHint({ reindexed: 3, skipped: 9 }, false)).toBeNull();
  });

  test('no hint when nothing was skipped', () => {
    expect(reindexForceHint({ reindexed: 0, skipped: 0 }, false)).toBeNull();
  });
});

describe('doctor code_chunk_metadata (#3970 surface 2)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  async function addPageWithChunk(
    slug: string,
    opts: { type?: string; symbolName?: string | null; language?: string | null; deleted?: boolean } = {},
  ): Promise<void> {
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (slug, source_id, type, page_kind, title, compiled_truth, timeline, frontmatter, deleted_at)
       VALUES ($1, 'default', $2, 'markdown', $1, 'body', '', '{}'::jsonb, $3)
       RETURNING id`,
      [slug, opts.type ?? 'code', opts.deleted ? new Date().toISOString() : null],
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, symbol_name, language)
       VALUES ($1, 0, 'chunk body', $2, $3)`,
      [rows[0]!.id, opts.symbolName ?? null, opts.language ?? null],
    );
  }

  test('ok when every code chunk carries symbol metadata (markdown NULLs and deleted pages ignored)', async () => {
    // Healthy code chunk (both fields populated).
    await addPageWithChunk('src-foo-ts', { symbolName: 'foo', language: 'typescript' });
    // Markdown chunk with NULL metadata — not a code page, must not count.
    await addPageWithChunk('notes/meeting', { type: 'concept', symbolName: null, language: null });
    // Soft-deleted code page with NULL metadata — must not count.
    await addPageWithChunk('src-dead-ts', { symbolName: null, language: null, deleted: true });

    const c = await checkCodeChunkMetadata(engine);
    expect(c.name).toBe('code_chunk_metadata');
    expect(c.status).toBe('ok');
  });

  test('warn with reindex-code --force cure when code chunks have no metadata', async () => {
    await addPageWithChunk('src-legacy-ts', { symbolName: null, language: null });
    await addPageWithChunk('src-legacy2-py', { symbolName: null, language: null });

    const c = await checkCodeChunkMetadata(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('reindex-code --force');
    expect(c.message).toContain('2 chunk(s)');
    expect((c.details as { chunks_missing_metadata: number }).chunks_missing_metadata).toBe(2);
    expect((c.details as { pages_affected: number }).pages_affected).toBe(2);
  });

  test('chunk with only language populated (symbol_name NULL) does not count — both must be NULL', async () => {
    // e.g. a chunk between symbols still stamped with the file language.
    await addPageWithChunk('src-partial-go', { symbolName: null, language: 'go' });

    const c = await checkCodeChunkMetadata(engine);
    // Still warns from the previous test's rows, but the count is unchanged.
    expect((c.details as { chunks_missing_metadata: number }).chunks_missing_metadata).toBe(2);
  });
});

describe('CLI help line (#3970 surface 1)', () => {
  test('reindex-code help documents --force', () => {
    const cli = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf-8');
    const line = cli.split('\n').find((l) => l.trimStart().startsWith('reindex-code ['));
    expect(line).toBeDefined();
    expect(line!).toContain('--force');
  });
});
