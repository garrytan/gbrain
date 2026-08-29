/**
 * v0.32.7 CJK wave — reindex sweep tests.
 *
 * Drives `gbrain reindex --markdown` against an in-memory PGLite brain,
 * verifies the chunker_version sweep updates rows below the current
 * MARKDOWN_CHUNKER_VERSION and is idempotent on re-run.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindex, validateReindexModeScope } from '../src/commands/reindex.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  _resetCliExitVerdictForTests();
  await (engine as any).db.exec('DELETE FROM content_chunks');
  await (engine as any).db.exec('DELETE FROM pages');
});

async function seedLegacyPage(
  slug: string,
  body: string,
  sourcePath: string | null = null,
  opts: { type?: string; sourceId?: string; contextualMode?: string | null } = {},
) {
  const sourceId = opts.sourceId ?? 'default';
  if (sourceId !== 'default') {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [sourceId],
    );
  }
  // Force chunker_version=1 explicitly to simulate a pre-bump row.
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, chunker_version, source_path, contextual_retrieval_mode)
     VALUES ($1, $2, $3, $4, $5, 'markdown', 1, $6, $7)`,
    [sourceId, slug, opts.type ?? 'note', slug.split('/').pop() ?? slug, body, sourcePath, opts.contextualMode ?? null],
  );
}

async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  (process.stdout.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  };
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
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

  test('idempotent: --no-embed re-run ignores contextual mode drift it cannot repair', async () => {
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

  test('skips pages already at current chunker_version (and CR mode set)', async () => {
    // Pre-bump page (chunker_version = 1)
    await seedLegacyPage('note-up', 'pending body');
    // A genuinely complete current page has both a canonical chunk and a
    // stamped contextual mode. A bare pages row is not complete.
    await importFromContent(engine, 'note-current', '# Current\n\ncurrent body', {
      sourceId: 'default',
      noEmbed: true,
      forceRechunk: true,
    });
    await engine.executeRaw(
      `UPDATE pages SET contextual_retrieval_mode = 'title' WHERE slug = 'note-current'`,
    );

    const result = await runReindex(engine, ['--markdown', '--no-embed']);
    expect(result.pending).toBe(1);
    expect(result.reindexed).toBe(1);
  });

  test('--type atom only selects atom markdown pages', async () => {
    await seedLegacyPage('atoms/a', 'atom body a', null, { type: 'atom' });
    await seedLegacyPage('notes/a', 'note body a', null, { type: 'note' });

    const result = await runReindex(engine, ['--markdown', '--type', 'atom', '--no-embed']);
    expect(result.type).toBe('atom');
    expect(result.pending).toBe(1);
    expect(result.reindexed).toBe(1);

    const rows = await engine.executeRaw<{ slug: string; chunker_version: number }>(
      `SELECT slug, chunker_version FROM pages WHERE slug IN ('atoms/a', 'notes/a') ORDER BY slug`,
    );
    expect(rows).toEqual([
      { slug: 'atoms/a', chunker_version: MARKDOWN_CHUNKER_VERSION },
      { slug: 'notes/a', chunker_version: 1 },
    ]);
  });

  test('inline type and limit forms stay scoped and bounded', async () => {
    await seedLegacyPage('atoms/inline-a', 'atom body a', null, { type: 'atom' });
    await seedLegacyPage('atoms/inline-b', 'atom body b', null, { type: 'atom' });
    await seedLegacyPage('notes/inline', 'note body', null, { type: 'note' });

    const result = await runReindex(engine, ['--markdown', '--type=atom', '--limit=1', '--no-embed']);
    expect(result.type).toBe('atom');
    expect(result.pending).toBe(2);
    expect(result.reindexed).toBe(1);
    expect(result.pendingAfter).toBe(1);

    const notes = await engine.executeRaw<{ chunker_version: number }>(
      `SELECT chunker_version FROM pages WHERE slug = 'notes/inline'`,
    );
    expect(Number(notes[0]?.chunker_version)).toBe(1);
  });

  test('leaves current-version chunkless healing to native embed --stale', async () => {
    await seedLegacyPage('atoms/chunkless-stamped', 'repair me', null, {
      type: 'atom',
      contextualMode: 'title',
    });
    await engine.executeRaw(
      `UPDATE pages SET chunker_version = $1 WHERE slug = 'atoms/chunkless-stamped'`,
      [MARKDOWN_CHUNKER_VERSION],
    );

    const normal = await runReindex(engine, ['--markdown', '--type', 'atom', '--dry-run']);
    const noEmbed = await runReindex(engine, ['--markdown', '--type', 'atom', '--no-embed', '--dry-run']);
    expect(normal.pending).toBe(0);
    expect(noEmbed.pending).toBe(0);
  });

  test('keyset lets a failed first row reach later batches in one invocation', async () => {
    await seedLegacyPage('atoms/fails-first', 'synthetic failure', null, { type: 'atom' });
    for (let i = 0; i < 101; i++) {
      await seedLegacyPage(`atoms/after-failure-${i}`, `valid atom ${i}`, null, { type: 'atom' });
    }
    const originalGetPage = engine.getPage.bind(engine);
    let failedReads = 0;
    engine.getPage = async (slug, opts) => {
      if (slug === 'atoms/fails-first') {
        failedReads++;
        throw new Error('synthetic read failure');
      }
      return originalGetPage(slug, opts);
    };

    try {
      const result = await runReindex(engine, ['--markdown', '--type', 'atom', '--no-embed']);
      expect(result.pending).toBe(102);
      expect(result.reindexed).toBe(101);
      expect(result.failed).toBe(1);
      expect(result.pendingAfter).toBe(1);
      expect(failedReads).toBe(1);

      const rows = await engine.executeRaw<{ chunks: string | number }>(
        `SELECT COUNT(c.id)::bigint AS chunks
           FROM pages p JOIN content_chunks c ON c.page_id = p.id
          WHERE p.slug LIKE 'atoms/after-failure-%'`,
      );
      expect(Number(rows[0]?.chunks)).toBe(101);
    } finally {
      engine.getPage = originalGetPage;
    }
  });

  test('normal mode selects CR drift that --no-embed deliberately ignores', async () => {
    await importFromContent(engine, 'atoms/cr-null', '# CR null\n\nbody', {
      sourceId: 'default',
      noEmbed: true,
      forceRechunk: true,
    });
    await engine.executeRaw(
      `UPDATE pages SET contextual_retrieval_mode = NULL WHERE slug = 'atoms/cr-null'`,
    );

    const normal = await runReindex(engine, ['--markdown', '--dry-run']);
    const noEmbed = await runReindex(engine, ['--markdown', '--no-embed', '--dry-run']);
    expect(normal.pending).toBe(1);
    expect(noEmbed.pending).toBe(0);
  });

  test('--type atom preserves source threading for same-slug pages', async () => {
    await seedLegacyPage('shared/page', 'default note body', null, { type: 'note', sourceId: 'default' });
    await seedLegacyPage('shared/page', 'work atom body', null, { type: 'atom', sourceId: 'work' });

    const result = await runReindex(engine, ['--markdown', '--type', 'atom', '--no-embed']);
    expect(result.reindexed).toBe(1);

    const rows = await engine.executeRaw<{ source_id: string; type: string; chunker_version: number }>(
      `SELECT source_id, type, chunker_version
         FROM pages
        WHERE slug = 'shared/page'
        ORDER BY source_id`,
    );
    expect(rows).toEqual([
      { source_id: 'default', type: 'note', chunker_version: 1 },
      { source_id: 'work', type: 'atom', chunker_version: MARKDOWN_CHUNKER_VERSION },
    ]);
    const chunks = await engine.executeRaw<{ source_id: string; chunk_text: string }>(
      `SELECT p.source_id, c.chunk_text
         FROM pages p JOIN content_chunks c ON c.page_id = p.id
        WHERE p.slug = 'shared/page'`,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.source_id).toBe('work');
    expect(chunks[0]?.chunk_text).toContain('work atom body');
  });

  test('omitted --type keeps the unscoped selection', async () => {
    await seedLegacyPage('atoms/unscoped', 'atom body', null, { type: 'atom' });
    await seedLegacyPage('notes/unscoped', 'note body', null, { type: 'note' });

    const result = await runReindex(engine, ['--markdown', '--no-embed']);
    expect(result.type).toBeNull();
    expect(result.pending).toBe(2);
    expect(result.reindexed).toBe(2);
  });

  test('dry-run includes type scope and counts only scoped rows', async () => {
    await seedLegacyPage('atoms/dry-a', 'atom body a', null, { type: 'atom' });
    await seedLegacyPage('atoms/dry-b', 'atom body b', null, { type: 'atom' });
    await seedLegacyPage('notes/dry', 'note body', null, { type: 'note' });

    const { result, stderr } = await captureOutput(() =>
      runReindex(engine, ['--markdown', '--type', 'atom', '--dry-run', '--limit', '1']));
    expect(result.pending).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(stderr).toContain('would re-chunk 1 of 2 pending markdown pages');
    expect(stderr).toContain('type=atom');

    const rows = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*)::bigint AS count
         FROM pages
        WHERE chunker_version = $1`,
      [MARKDOWN_CHUNKER_VERSION],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  test('JSON reports consistent pending-before and pending-after fields', async () => {
    const empty = await captureOutput(() =>
      runReindex(engine, ['--markdown', '--json', '--no-embed']));
    expect(JSON.parse(empty.stdout).pending).toBe(0);
    expect(JSON.parse(empty.stdout).pending_after).toBe(0);

    await seedLegacyPage('notes/json', 'json body');
    const dry = await captureOutput(() =>
      runReindex(engine, ['--markdown', '--json', '--no-embed', '--dry-run']));
    expect(JSON.parse(dry.stdout).pending).toBe(1);
    expect(JSON.parse(dry.stdout).pending_after).toBe(1);

    const done = await captureOutput(() =>
      runReindex(engine, ['--markdown', '--json', '--no-embed']));
    expect(JSON.parse(done.stdout).pending).toBe(1);
    expect(JSON.parse(done.stdout).pending_after).toBe(0);
  });

  test('empty --type fails closed before reading or writing', async () => {
    await seedLegacyPage('atoms/invalid', 'atom body', null, { type: 'atom' });

    const { result, stdout } = await captureOutput(() =>
      runReindex(engine, ['--markdown', '--type', '   ', '--json', '--no-embed']));
    expect(result.pending).toBe(0);
    expect(result.reindexed).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      error: 'invalid --type: expected a non-empty value, not another flag',
    });

    const rows = await engine.executeRaw<{ chunker_version: number }>(
      `SELECT chunker_version FROM pages WHERE slug = 'atoms/invalid'`,
    );
    expect(Number(rows[0].chunker_version)).toBe(1);
  });

  test('missing --type value cannot consume the next flag', async () => {
    await seedLegacyPage('atoms/missing-type', 'atom body', null, { type: 'atom' });

    const { result, stdout } = await captureOutput(() =>
      runReindex(engine, ['--markdown', '--type', '--json', '--no-embed']));
    expect(result.pending).toBe(0);
    expect(result.reindexed).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      error: 'invalid --type: expected a non-empty value, not another flag',
    });

    const rows = await engine.executeRaw<{ chunker_version: number }>(
      `SELECT chunker_version FROM pages WHERE slug = 'atoms/missing-type'`,
    );
    expect(Number(rows[0].chunker_version)).toBe(1);
  });

  test('every repeated --type occurrence is validated', async () => {
    await seedLegacyPage('atoms/repeated-type', 'atom body', null, { type: 'atom' });

    const { result, stdout } = await captureOutput(() =>
      runReindex(engine, ['--markdown', '--type', 'atom', '--type', '--json', '--no-embed']));
    expect(result.pending).toBe(0);
    expect(result.reindexed).toBe(0);
    expect(JSON.parse(stdout).error).toContain('invalid --type');
  });

  test('open-world custom page types are accepted as bound values', async () => {
    await seedLegacyPage('private/page', 'private body', null, { type: '_private' });
    await seedLegacyPage('meta/page', 'meta body', null, { type: '.meta' });
    await seedLegacyPage('research/page', 'research body', null, { type: 'research/paper' });
    await seedLegacyPage('legacy/page', 'legacy body', null, { type: 'legacy type' });

    const privateResult = await runReindex(engine, ['--markdown', '--type', '_private', '--no-embed']);
    const metaResult = await runReindex(engine, ['--markdown', '--type', '.meta', '--no-embed']);
    const researchResult = await runReindex(engine, ['--markdown', '--type', 'research/paper', '--no-embed']);
    const legacyResult = await runReindex(engine, ['--markdown', '--type', 'legacy type', '--no-embed']);
    expect(privateResult.reindexed).toBe(1);
    expect(metaResult.reindexed).toBe(1);
    expect(researchResult.reindexed).toBe(1);
    expect(legacyResult.reindexed).toBe(1);
  });

  test.each([
    ['missing', ['--markdown', '--limit', '--type', 'atom', '--json', '--no-embed']],
    ['zero', ['--markdown', '--limit', '0', '--json', '--no-embed']],
    ['negative', ['--markdown', '--limit', '-1', '--json', '--no-embed']],
    ['fractional', ['--markdown', '--limit', '1.5', '--json', '--no-embed']],
    ['text', ['--markdown', '--limit', 'many', '--json', '--no-embed']],
  ])('invalid --limit (%s) fails closed', async (_label, args) => {
    await seedLegacyPage('atoms/limit', 'atom body', null, { type: 'atom' });
    const { result, stdout } = await captureOutput(() => runReindex(engine, args));
    expect(result.pending).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ error: 'invalid --limit: expected a positive integer' });
    expect(currentExitCode()).toBe(2);
  });

  test.each([
    ['repo', ['--markdown', '--repo', '--type', 'atom', '--json', '--no-embed']],
    ['inline repo', ['--markdown', '--repo=', '--type=atom', '--json', '--no-embed']],
    ['workers', ['--markdown', '--workers', '--type', 'atom', '--json', '--no-embed']],
    ['concurrency', ['--markdown', '--concurrency', '--type', 'atom', '--json', '--no-embed']],
  ])('missing --%s value cannot swallow a scope flag', async (_label, args) => {
    await seedLegacyPage('atoms/value', 'atom body', null, { type: 'atom' });
    const { result, stdout } = await captureOutput(() => runReindex(engine, args));
    expect(result.pending).toBe(0);
    expect(JSON.parse(stdout).error).toContain('expected');
    expect(currentExitCode()).toBe(2);
  });

  test('scope flags reject reindex modes that do not consume them', () => {
    expect(validateReindexModeScope(['--multimodal', '--type', 'atom'])).toContain('--multimodal');
    expect(validateReindexModeScope(['--multimodal', '--type=atom'])).toContain('--multimodal');
    expect(validateReindexModeScope(['--aliases', '--type', 'atom'])).toContain('--aliases');
    expect(validateReindexModeScope(['--markdown', '--type', 'atom'])).toBeNull();
  });

  test('source-file import errors are surfaced, counted, and fail the CLI', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-reindex-'));
    try {
      writeFileSync(join(repo, 'bad.md'), '---\ntype: note\ntitle: Re: invalid yaml\n---\nbody\n');
      await seedLegacyPage('bad', 'old body', 'bad.md');

      const { result, stderr } = await captureOutput(() =>
        runReindex(engine, ['--markdown', '--repo', repo, '--no-embed']));
      expect(result.reindexed).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.pendingAfter).toBe(1);
      expect(stderr).toContain('[reindex] bad:');
      expect(currentExitCode()).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('successful source-file imports are counted and indexed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-reindex-'));
    try {
      writeFileSync(join(repo, 'source.md'), '---\ntype: note\ntitle: Source page\n---\nfile-backed body\n');
      await seedLegacyPage('source', 'old body', 'source.md');

      const result = await runReindex(engine, ['--markdown', '--repo', repo, '--no-embed']);
      expect(result.reindexed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.pendingAfter).toBe(0);
      const chunks = await engine.executeRaw<{ chunk_text: string }>(
        `SELECT c.chunk_text FROM pages p JOIN content_chunks c ON c.page_id = p.id WHERE p.slug = 'source'`,
      );
      expect(chunks.some((row) => row.chunk_text.includes('file-backed body'))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('failed rows remain in the reported pending count', async () => {
    await seedLegacyPage('notes/fails', 'will fail');
    await seedLegacyPage('notes/succeeds', 'will succeed');
    const originalGetPage = engine.getPage.bind(engine);
    engine.getPage = async (slug, opts) => {
      if (slug === 'notes/fails') throw new Error('synthetic read failure');
      return originalGetPage(slug, opts);
    };

    try {
      const { result, stderr } = await captureOutput(() =>
        runReindex(engine, ['--markdown', '--no-embed']));
      expect(result.reindexed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.pendingAfter).toBe(1);
      expect(stderr).toContain('pending_before=2 pending_after=1');
      expect(currentExitCode()).toBe(1);
    } finally {
      engine.getPage = originalGetPage;
    }
  });
});
