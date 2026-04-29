import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const STALE_HASH = 'a'.repeat(64);
const MISSING_HASH = 'b'.repeat(64);
const DEFAULT_PAGE_SOURCE = '[Source: Page write precondition fixture, 2026-04-25 12:00 PM KST]';

function getOperation(name: string): Operation {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) {
    throw new Error(`${name} operation is missing`);
  }
  return operation;
}

async function withSqliteEngine<T>(fn: (ctx: OperationContext) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-page-write-precondition-'));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    return await fn({
      engine: engine as unknown as BrainEngine,
      config: {} as any,
      logger: console,
      dryRun: false,
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function pageContent(title: string, body: string, timeline: string): string {
  const citedTimeline = timeline.includes('[Source:') ? timeline : `${timeline} ${DEFAULT_PAGE_SOURCE}`;
  return `---
type: concept
title: ${title}
---

${body}

---

${citedTimeline}
`;
}

describe('put_page content hash preconditions and mutation ledger', () => {
  test('invalid expected_content_hash rejects before mutation or ledger recording', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/invalid-precondition-hash';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Invalid Precondition Hash',
          'Original compiled truth.',
          '- 2026-04-25 | Initial evidence.',
        ),
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent(
            'Invalid Precondition Hash',
            'This content should not be written.',
            '- 2026-04-25 | Invalid hash attempted update.',
          ),
          expected_content_hash: 'not-a-sha',
          session_id: 'put-page-invalid-hash-session',
          source_refs: ['Source: invalid hash test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toContain('expected_content_hash');
      expect(await ctx.engine.getPage(slug)).toMatchObject({
        content_hash: before?.content_hash,
        compiled_truth: before?.compiled_truth,
      });
      expect(await ctx.engine.listMemoryMutationEvents({
        session_id: 'put-page-invalid-hash-session',
      })).toEqual([]);
    });
  });

  test('stale expected_content_hash rejects without mutating existing page and records one conflict event', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-stale';
      const sessionId = 'put-page-stale-session';
      const initial = pageContent(
        'Precondition Stale',
        'Original compiled truth.',
        '- 2026-04-25 | Initial evidence.',
      );
      const updated = pageContent(
        'Precondition Stale',
        'Updated compiled truth should not be written.',
        '- 2026-04-25 | Updated evidence should not appear.',
      );

      await put.handler(ctx, { slug, content: initial });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: updated,
          expected_content_hash: STALE_HASH,
          session_id: sessionId,
          source_refs: ['Source: stale precondition test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('write_conflict');
      expect((error as Error).message).toContain('content hash mismatch');

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBe(before?.content_hash);
      expect(after?.compiled_truth).toBe(before?.compiled_truth);
      expect(after?.compiled_truth).not.toContain('Updated compiled truth');

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        realm_id: 'work',
        actor: 'mbrain:put_page',
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        scope_id: 'workspace:default',
        source_refs: ['Source: stale precondition test'],
        expected_target_snapshot_hash: STALE_HASH,
        current_target_snapshot_hash: before?.content_hash,
        result: 'conflict',
        dry_run: false,
      });
      expect(events[0].conflict_info).toEqual({
        reason: 'content_hash_mismatch',
        expected_content_hash: STALE_HASH,
        current_content_hash: before?.content_hash,
      });
    });
  });

  test('expected_content_hash on missing page rejects and records a conflict event', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-missing';
      const sessionId = 'put-page-missing-session';

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent(
            'Precondition Missing',
            'This page should not be created.',
            '- 2026-04-25 | Missing page attempted update.',
          ),
          expected_content_hash: MISSING_HASH,
          session_id: sessionId,
          source_refs: ['Source: missing precondition test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('write_conflict');
      expect((error as Error).message).toContain('Page not found');

      expect(await ctx.engine.getPage(slug)).toBeNull();

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        result: 'conflict',
        expected_target_snapshot_hash: MISSING_HASH,
        current_target_snapshot_hash: null,
        source_refs: ['Source: missing precondition test'],
      });
      expect(events[0].conflict_info).toEqual({
        reason: 'missing_page',
        expected_content_hash: MISSING_HASH,
      });
    });
  });

  test('conflict ledger failure preserves write_conflict and does not mutate the page', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/conflict-ledger-failure';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Conflict Ledger Failure',
          'Original compiled truth.',
          '- 2026-04-25 | Initial evidence.',
        ),
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      const originalCreateMemoryMutationEvent = ctx.engine.createMemoryMutationEvent.bind(ctx.engine);
      ctx.engine.createMemoryMutationEvent = async (input) => {
        if (input.session_id === 'put-page-conflict-ledger-failure-session') {
          throw new Error('ledger write failed');
        }
        return originalCreateMemoryMutationEvent(input);
      };

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent(
            'Conflict Ledger Failure',
            'This content should not be written.',
            '- 2026-04-25 | Failed conflict audit attempted update.',
          ),
          expected_content_hash: STALE_HASH,
          session_id: 'put-page-conflict-ledger-failure-session',
          source_refs: ['Source: conflict ledger failure test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('write_conflict');
      expect((error as Error).message).toContain('content hash mismatch');
      expect(await ctx.engine.getPage(slug)).toMatchObject({
        content_hash: before?.content_hash,
        compiled_truth: before?.compiled_truth,
      });
      expect(await ctx.engine.listMemoryMutationEvents({
        session_id: 'put-page-conflict-ledger-failure-session',
      })).toEqual([]);
    });
  });

  test('stale expected_content_hash records conflict ledger after precondition transaction exits', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/conflict-ledger-outside-transaction';
      const sessionId = 'put-page-conflict-ledger-outside-transaction-session';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Conflict Ledger Outside Transaction',
          'Original compiled truth.',
          '- 2026-04-25 | Initial evidence.',
        ),
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      let inTransaction = false;
      const conflictLedgerTransactionStates: boolean[] = [];
      const originalTransaction = ctx.engine.transaction.bind(ctx.engine);
      const originalCreateMemoryMutationEvent = ctx.engine.createMemoryMutationEvent.bind(ctx.engine);

      ctx.engine.transaction = async <T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> => {
        return originalTransaction(async (tx) => {
          inTransaction = true;
          try {
            return await fn(tx);
          } finally {
            inTransaction = false;
          }
        });
      };

      ctx.engine.createMemoryMutationEvent = async (input) => {
        if (input.session_id === sessionId && input.result === 'conflict') {
          conflictLedgerTransactionStates.push(inTransaction);
        }
        return originalCreateMemoryMutationEvent(input);
      };

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent(
            'Conflict Ledger Outside Transaction',
            'This content should not be written.',
            '- 2026-04-25 | Transaction state attempted update.',
          ),
          expected_content_hash: STALE_HASH,
          session_id: sessionId,
          source_refs: ['Source: conflict ledger transaction state test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('write_conflict');
      expect(conflictLedgerTransactionStates).toEqual([false]);
      expect(await ctx.engine.getPage(slug)).toMatchObject({
        content_hash: before?.content_hash,
        compiled_truth: before?.compiled_truth,
      });
    });
  });

  test('correct expected_content_hash allows update and records applied event with final hash', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-correct';
      const sessionId = 'put-page-correct-session';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Precondition Correct',
          'Original compiled truth.',
          '- 2026-04-25 | Initial evidence.',
        ),
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      const result = await put.handler(ctx, {
        slug,
        content: pageContent(
          'Precondition Correct',
          'Updated compiled truth is written.',
          '- 2026-04-25 | Updated evidence appears.',
        ),
        expected_content_hash: before?.content_hash,
        session_id: sessionId,
        realm_id: 'realm-correct',
        actor: 'agent-correct',
        scope_id: 'scope-correct',
        source_refs: ['Source: correct precondition test'],
      }) as any;

      expect(result).toMatchObject({ slug, status: 'created_or_updated' });

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBeTruthy();
      expect(after?.content_hash).not.toBe(before?.content_hash);
      expect(after?.compiled_truth).toContain('Updated compiled truth is written.');

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        realm_id: 'realm-correct',
        actor: 'agent-correct',
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        scope_id: 'scope-correct',
        result: 'applied',
        expected_target_snapshot_hash: before?.content_hash,
        current_target_snapshot_hash: after?.content_hash,
        source_refs: ['Source: correct precondition test'],
        dry_run: false,
      });
      expect(events[0].conflict_info).toBeNull();
    });
  });

  test('put_page writes the markdown repo file before importing the DB projection when repo is provided', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-repo-'));
      const slug = 'concepts/markdown-first-write';
      const content = pageContent(
        'Markdown First Write',
        'Markdown-first compiled truth is written to disk.',
        '- 2026-04-25 | Markdown-first write evidence.',
      );

      try {
        const result = await put.handler(ctx, {
          slug,
          content,
          repo: repoPath,
          session_id: 'put-page-markdown-first-write-session',
          source_refs: ['Source: markdown-first write test'],
        }) as any;

        const filePath = join(repoPath, 'concepts', 'markdown-first-write.md');
        expect(result).toMatchObject({ slug, status: 'created_or_updated' });
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, 'utf-8')).toBe(content);

        const page = await ctx.engine.getPage(slug);
        expect(page?.compiled_truth).toContain('Markdown-first compiled truth is written to disk.');
        const manifest = await ctx.engine.getNoteManifestEntry('workspace:default', slug);
        expect(manifest?.path).toBe('concepts/markdown-first-write.md');
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('put_page rejects when the markdown repo file changed independently from the DB page', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-conflict-'));
      const slug = 'concepts/markdown-file-conflict';
      const initial = pageContent(
        'Markdown File Conflict',
        'Initial compiled truth.',
        '- 2026-04-25 | Initial evidence.',
      );
      const independentMarkdownEdit = pageContent(
        'Markdown File Conflict',
        'User edited the markdown file outside MBrain.',
        '- 2026-04-25 | Independent markdown edit evidence.',
      );
      const agentUpdate = pageContent(
        'Markdown File Conflict',
        'Agent update should not overwrite the independent markdown edit.',
        '- 2026-04-25 | Agent overwrite attempt evidence.',
      );

      try {
        await put.handler(ctx, {
          slug,
          content: initial,
          repo: repoPath,
          session_id: 'put-page-markdown-file-conflict-seed',
        });
        const before = await ctx.engine.getPage(slug);
        expect(before?.content_hash).toBeTruthy();

        const filePath = join(repoPath, 'concepts', 'markdown-file-conflict.md');
        writeFileSync(filePath, independentMarkdownEdit);

        let error: unknown;
        try {
          await put.handler(ctx, {
            slug,
            content: agentUpdate,
            repo: repoPath,
            session_id: 'put-page-markdown-file-conflict-session',
            source_refs: ['Source: markdown conflict test'],
          });
        } catch (caught) {
          error = caught;
        }

        expect(error).toBeInstanceOf(OperationError);
        expect((error as OperationError).code).toBe('write_conflict');
        expect((error as Error).message).toContain('markdown file changed');
        expect(readFileSync(filePath, 'utf-8')).toBe(independentMarkdownEdit);
        const after = await ctx.engine.getPage(slug);
        expect(after?.content_hash).toBe(before?.content_hash);
        expect(after?.compiled_truth).toBe(before?.compiled_truth);
        expect(after?.compiled_truth).not.toContain('Agent update should not overwrite');
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('put_page uses the configured markdown repo path when repo is omitted', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-configured-repo-'));
      const slug = 'concepts/configured-markdown-repo';
      const content = pageContent(
        'Configured Markdown Repo',
        'Configured markdown repo path should receive the page file.',
        '- 2026-04-25 | Configured markdown repo evidence.',
      );

      try {
        await ctx.engine.setConfig('markdown.repo_path', repoPath);
        await put.handler(ctx, {
          slug,
          content,
          session_id: 'put-page-configured-markdown-repo-session',
          source_refs: ['Source: configured markdown repo test'],
        });

        expect(readFileSync(join(repoPath, 'concepts', 'configured-markdown-repo.md'), 'utf-8')).toBe(content);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('put_page rejects markdown targets whose parent path escapes through a symlink', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-symlink-repo-'));
      const outsidePath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-symlink-outside-'));

      try {
        symlinkSync(outsidePath, join(repoPath, 'concepts'), 'dir');

        await expect(put.handler(ctx, {
          slug: 'concepts/symlink-escape',
          content: pageContent(
            'Symlink Escape',
            'This write must not leave the configured markdown repo.',
            '- 2026-04-25 | Symlink escape attempt.',
          ),
          repo: repoPath,
          session_id: 'put-page-symlink-escape-session',
          source_refs: ['Source: symlink escape test'],
        })).rejects.toThrow(/escapes repo|symlink/i);

        expect(existsSync(join(outsidePath, 'symlink-escape.md'))).toBe(false);
        expect(await ctx.engine.getPage('concepts/symlink-escape')).toBeNull();
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
        rmSync(outsidePath, { recursive: true, force: true });
      }
    });
  });

  test('oversized markdown-first put_page leaves the existing file and DB projection unchanged', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-oversized-repo-'));
      const slug = 'concepts/oversized-markdown-first';
      const initial = pageContent(
        'Oversized Markdown First',
        'Original compiled truth.',
        '- 2026-04-25 | Initial evidence.',
      );

      try {
        await put.handler(ctx, {
          slug,
          content: initial,
          repo: repoPath,
          session_id: 'put-page-oversized-markdown-first-seed',
        });
        const filePath = join(repoPath, 'concepts', 'oversized-markdown-first.md');
        const before = await ctx.engine.getPage(slug);
        expect(before?.content_hash).toBeTruthy();

        const result = await put.handler(ctx, {
          slug,
          content: `${'x'.repeat(5_000_001)} ${DEFAULT_PAGE_SOURCE}`,
          repo: repoPath,
          session_id: 'put-page-oversized-markdown-first-session',
          source_refs: ['Source: oversized markdown-first test'],
        }) as any;

        expect(result).toMatchObject({
          slug,
          status: 'skipped',
          chunks: 0,
        });
        expect(result.error).toContain('Content too large');
        expect(readFileSync(filePath, 'utf-8')).toBe(initial);
        const after = await ctx.engine.getPage(slug);
        expect(after?.content_hash).toBe(before?.content_hash);
        expect(after?.compiled_truth).toBe(before?.compiled_truth);

        const events = await ctx.engine.listMemoryMutationEvents({
          session_id: 'put-page-oversized-markdown-first-session',
        });
        expect(events).toHaveLength(1);
        expect(events[0].result).toBe('failed');
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('markdown-first put_page restores the file when applied ledger recording fails', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-ledger-rollback-repo-'));
      const slug = 'concepts/markdown-ledger-rollback';
      const initial = pageContent(
        'Markdown Ledger Rollback',
        'Original compiled truth.',
        '- 2026-04-25 | Initial evidence.',
      );
      const update = pageContent(
        'Markdown Ledger Rollback',
        'This update should roll back when ledger recording fails.',
        '- 2026-04-25 | Ledger failure attempted update.',
      );

      try {
        await put.handler(ctx, {
          slug,
          content: initial,
          repo: repoPath,
          session_id: 'put-page-markdown-ledger-rollback-seed',
        });
        const before = await ctx.engine.getPage(slug);
        expect(before?.content_hash).toBeTruthy();
        const filePath = join(repoPath, 'concepts', 'markdown-ledger-rollback.md');
        expect(readFileSync(filePath, 'utf-8')).toBe(initial);

        const originalCreateMemoryMutationEvent = ctx.engine.createMemoryMutationEvent.bind(ctx.engine);
        ctx.engine.createMemoryMutationEvent = async (input) => {
          if (input.session_id === 'put-page-markdown-ledger-rollback-session') {
            throw new Error('ledger write failed');
          }
          return originalCreateMemoryMutationEvent(input);
        };

        await expect(put.handler(ctx, {
          slug,
          content: update,
          repo: repoPath,
          expected_content_hash: before?.content_hash,
          session_id: 'put-page-markdown-ledger-rollback-session',
          source_refs: ['Source: markdown ledger rollback test'],
        })).rejects.toThrow(/ledger write failed/);

        expect(readFileSync(filePath, 'utf-8')).toBe(initial);
        const after = await ctx.engine.getPage(slug);
        expect(after?.content_hash).toBe(before?.content_hash);
        expect(after?.compiled_truth).toBe(before?.compiled_truth);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('markdown-first put_page does not rewrite the file when content is unchanged', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-unchanged-repo-'));
      const slug = 'concepts/unchanged-markdown-first';
      const content = pageContent(
        'Unchanged Markdown First',
        'The file content is already current.',
        '- 2026-04-25 | Initial unchanged markdown-first evidence.',
      );

      try {
        await put.handler(ctx, {
          slug,
          content,
          repo: repoPath,
          session_id: 'put-page-unchanged-markdown-first-seed',
        });

        const filePath = join(repoPath, 'concepts', 'unchanged-markdown-first.md');
        const oldDate = new Date('2026-01-01T00:00:00.000Z');
        utimesSync(filePath, oldDate, oldDate);
        const beforeMtime = statSync(filePath).mtimeMs;

        const result = await put.handler(ctx, {
          slug,
          content,
          repo: repoPath,
          session_id: 'put-page-unchanged-markdown-first-session',
          source_refs: ['Source: unchanged markdown-first optimization test'],
        }) as any;

        expect(result).toMatchObject({
          slug,
          status: 'skipped',
          chunks: 0,
        });
        expect(readFileSync(filePath, 'utf-8')).toBe(content);
        expect(statSync(filePath).mtimeMs).toBe(beforeMtime);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('matching expected_content_hash with unchanged content records an applied ledger event', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-unchanged';
      const sessionId = 'put-page-unchanged-session';
      const content = pageContent(
        'Precondition Unchanged',
        'Compiled truth stays the same.',
        '- 2026-04-25 | Initial unchanged evidence.',
      );

      await put.handler(ctx, { slug, content });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      const result = await put.handler(ctx, {
        slug,
        content,
        expected_content_hash: before?.content_hash,
        session_id: sessionId,
        source_refs: ['Source: unchanged precondition test'],
      }) as any;

      expect(result).toMatchObject({ slug, status: 'skipped', chunks: 0 });

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBe(before?.content_hash);

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        result: 'applied',
        expected_target_snapshot_hash: before?.content_hash,
        current_target_snapshot_hash: before?.content_hash,
        source_refs: ['Source: unchanged precondition test'],
      });
      expect(events[0].conflict_info).toBeNull();
      expect(events[0].metadata).toMatchObject({
        import_status: 'skipped',
        skipped_reason: 'content_hash_unchanged',
      });
    });
  });

  test('expected_content_hash reads the page through the write-lock path', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-write-lock-path';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Precondition Write Lock Path',
          'Original compiled truth.',
          '- 2026-04-25 | Initial evidence.',
        ),
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      let getPageForUpdateCalls = 0;
      const originalGetPage = ctx.engine.getPage.bind(ctx.engine);
      (ctx.engine as BrainEngine & {
        getPageForUpdate?: BrainEngine['getPage'];
      }).getPageForUpdate = async (requestedSlug) => {
        getPageForUpdateCalls += 1;
        return originalGetPage(requestedSlug);
      };

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Precondition Write Lock Path',
          'Updated compiled truth.',
          '- 2026-04-25 | Updated evidence.',
        ),
        expected_content_hash: before?.content_hash,
        session_id: 'put-page-write-lock-path-session',
      });

      expect(getPageForUpdateCalls).toBe(1);
    });
  });

  test('string-list source_refs are accepted and normalized for put_page audit', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/string-list-source-refs';
      const sessionId = 'put-page-string-list-source-refs-session';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'String List Source Refs',
          'String-list source refs should be accepted.',
          '- 2026-04-25 | String list source refs test.',
        ),
        session_id: sessionId,
        source_refs: 'Source: string list one\nSource: string list two',
      });

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0].source_refs).toEqual([
        'Source: string list one',
        'Source: string list two',
      ]);
    });
  });

  test('JSON-array string source_refs are accepted and normalized for put_page audit', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/json-string-source-refs';
      const sessionId = 'put-page-json-string-source-refs-session';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'JSON String Source Refs',
          'JSON-array string source refs should be accepted.',
          '- 2026-04-25 | JSON string source refs test.',
        ),
        session_id: sessionId,
        source_refs: '["Source: JSON string one", " Source: JSON string two "]',
      });

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0].source_refs).toEqual([
        'Source: JSON string one',
        'Source: JSON string two',
      ]);
    });
  });

  test('bracketed MBrain source citation string is accepted as one put_page source ref', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/bracketed-mbrain-source-ref';
      const sessionId = 'put-page-bracketed-mbrain-source-ref-session';
      const sourceRef = '[Source: User, direct message, 2026-04-26 KST]';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Bracketed MBrain Source Ref',
          'Bracketed MBrain source citations should be accepted.',
          '- 2026-04-26 | Bracketed source ref test.',
        ),
        session_id: sessionId,
        source_refs: sourceRef,
      });

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0].source_refs).toEqual([sourceRef]);
    });
  });

  test('comma-containing non-bracket source citation string is accepted as one put_page source ref', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/comma-containing-source-ref';
      const sessionId = 'put-page-comma-containing-source-ref-session';
      const sourceRef = 'Source: User, direct message, 2026-04-26 KST';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Comma Containing Source Ref',
          'Comma-containing source citations should be accepted.',
          '- 2026-04-26 | Comma-containing source ref test.',
        ),
        session_id: sessionId,
        source_refs: sourceRef,
      });

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0].source_refs).toEqual([sourceRef]);
    });
  });

  test('non-string array source_refs reject before page mutation or ledger recording', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/non-string-array-source-refs';
      const sessionId = 'put-page-non-string-array-source-refs-session';

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent(
            'Non String Array Source Refs',
            'This page should not be written.',
            '- 2026-04-25 | Non-string array source refs test.',
          ),
          session_id: sessionId,
          source_refs: [123],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toContain('source_refs');
      expect(await ctx.engine.getPage(slug)).toBeNull();
      expect(await ctx.engine.listMemoryMutationEvents({ session_id: sessionId })).toEqual([]);
    });
  });

  test('non-string JSON-array string source_refs reject before page mutation or ledger recording', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/non-string-json-source-refs';
      const sessionId = 'put-page-non-string-json-source-refs-session';

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent(
            'Non String JSON Source Refs',
            'This page should not be written.',
            '- 2026-04-25 | Non-string JSON source refs test.',
          ),
          session_id: sessionId,
          source_refs: '[123]',
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toContain('source_refs');
      expect(await ctx.engine.getPage(slug)).toBeNull();
      expect(await ctx.engine.listMemoryMutationEvents({ session_id: sessionId })).toEqual([]);
    });
  });

  test('normal put_page without audit params records an applied ledger event using defaults', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/default-audit';

      const result = await put.handler(ctx, {
        slug,
        content: pageContent(
          'Default Audit',
          'Default audit fields should be used.',
          '- 2026-04-25 | Default audit test.',
        ),
      }) as any;
      expect(result).toMatchObject({ slug, status: 'created_or_updated' });

      const page = await ctx.engine.getPage(slug);
      const events = await ctx.engine.listMemoryMutationEvents({ target_id: slug });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        realm_id: 'work',
        actor: 'mbrain:put_page',
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        scope_id: 'workspace:default',
        source_refs: ['Source: mbrain put_page operation'],
        expected_target_snapshot_hash: null,
        current_target_snapshot_hash: page?.content_hash,
        result: 'applied',
        dry_run: false,
      });
      expect(events[0].session_id).toMatch(/^put_page:direct:/);
    });
  });

  test('default audit session ids are unique for unrelated direct writes', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');

      await put.handler(ctx, {
        slug: 'concepts/default-session-one',
        content: pageContent(
          'Default Session One',
          'First direct write.',
          '- 2026-04-25 | First default session id test.',
        ),
      });
      await put.handler(ctx, {
        slug: 'concepts/default-session-two',
        content: pageContent(
          'Default Session Two',
          'Second direct write.',
          '- 2026-04-25 | Second default session id test.',
        ),
      });

      const one = await ctx.engine.listMemoryMutationEvents({ target_id: 'concepts/default-session-one' });
      const two = await ctx.engine.listMemoryMutationEvents({ target_id: 'concepts/default-session-two' });
      expect(one).toHaveLength(1);
      expect(two).toHaveLength(1);
      expect(one[0].session_id).toMatch(/^put_page:direct:/);
      expect(two[0].session_id).toMatch(/^put_page:direct:/);
      expect(one[0].session_id).not.toBe(two[0].session_id);
    });
  });

  test('explicit audit session_id is preserved', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/explicit-session-preserved';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Explicit Session Preserved',
          'Explicit audit session ids should be preserved.',
          '- 2026-04-25 | Explicit session id test.',
        ),
        session_id: 'put-page-explicit-session',
      });

      const events = await ctx.engine.listMemoryMutationEvents({ target_id: slug });
      expect(events).toHaveLength(1);
      expect(events[0].session_id).toBe('put-page-explicit-session');
    });
  });

  test('applied ledger failure rolls back the page mutation', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/applied-ledger-rollback';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Applied Ledger Rollback',
          'Original compiled truth.',
          '- 2026-04-25 | Initial evidence.',
        ),
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      const originalCreateMemoryMutationEvent = ctx.engine.createMemoryMutationEvent.bind(ctx.engine);
      ctx.engine.createMemoryMutationEvent = async (input) => {
        if (input.session_id === 'put-page-applied-ledger-failure-session') {
          throw new Error('ledger write failed');
        }
        return originalCreateMemoryMutationEvent(input);
      };

      await expect(put.handler(ctx, {
        slug,
        content: pageContent(
          'Applied Ledger Rollback',
          'This update should roll back when ledger recording fails.',
          '- 2026-04-25 | Ledger failure attempted update.',
        ),
        expected_content_hash: before?.content_hash,
        session_id: 'put-page-applied-ledger-failure-session',
        source_refs: ['Source: applied ledger failure test'],
      })).rejects.toThrow(/ledger write failed/);

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBe(before?.content_hash);
      expect(after?.compiled_truth).toBe(before?.compiled_truth);
      expect(await ctx.engine.listMemoryMutationEvents({
        session_id: 'put-page-applied-ledger-failure-session',
      })).toEqual([]);
    });
  });

  test('oversized content returns import error and records a failed ledger event', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/oversized-content';
      const sessionId = 'put-page-oversized-session';

      const result = await put.handler(ctx, {
        slug,
        content: `${'x'.repeat(5_000_001)} ${DEFAULT_PAGE_SOURCE}`,
        session_id: sessionId,
        source_refs: ['Source: oversized content test'],
      }) as any;

      expect(result).toMatchObject({
        slug,
        status: 'skipped',
        chunks: 0,
      });
      expect(result.error).toContain('Content too large');
      expect(await ctx.engine.getPage(slug)).toBeNull();

      const events = await ctx.engine.listMemoryMutationEvents({ session_id: sessionId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        result: 'failed',
        current_target_snapshot_hash: null,
        source_refs: ['Source: oversized content test'],
      });
      expect(events[0].metadata).toMatchObject({
        error: result.error,
      });
    });
  });

  test('ctx.dryRun does not write and does not record', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const dryCtx = { ...ctx, dryRun: true };
      const slug = 'concepts/dry-run-precondition';

      const result = await put.handler(dryCtx, {
        slug,
        content: pageContent(
          'Dry Run Precondition',
          'This dry run should not be written.',
          '- 2026-04-25 | Dry run attempted update.',
        ),
        expected_content_hash: MISSING_HASH,
        session_id: 'put-page-dry-run-session',
      }) as any;

      expect(result).toEqual({ dry_run: true, action: 'put_page', slug });
      expect(await ctx.engine.getPage(slug)).toBeNull();
      expect(await ctx.engine.listMemoryMutationEvents({ session_id: 'put-page-dry-run-session' })).toEqual([]);
    });
  });
});
