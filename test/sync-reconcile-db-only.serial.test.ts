/**
 * #2426 (bug 3) — `sync --full` delete-reconcile preserves DB-only pages.
 *
 * Bug class: the full-sync reconcile soft-deleted ANY file-backed page whose
 * `source_path` was absent from the working tree — including pages whose
 * markdown was NEVER committed to git (write-through that never made it to
 * the remote, then a fresh clone). "Absent from git" is the SYMPTOM of the
 * missing write-through commit, not evidence the content is disposable; one
 * production pass soft-deleted thousands of genuine pages this way.
 *
 * Fix: the reconcile partitions stale pages by git history — a path that ever
 * appeared as an ADD was genuinely deleted (reconcile as before); a path with
 * NO history is DB-only write-through: keep the page and re-export its
 * markdown to the working tree so it's file-backed again.
 *
 * Builds on the #2828 mass-delete valve (this guard covers the below-valve
 * cases the ratio check can't see).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { listEverCommittedPaths, type SyncResult } from '../src/commands/sync.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let repoPath: string;
let brainHome: string;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
}

function operationContext(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as OperationContext['logger'],
    dryRun: false,
    remote: false,
    sourceId,
  };
}

async function fullSyncThroughOperation(): Promise<SyncResult> {
  return withEnv({ GBRAIN_HOME: brainHome }, () =>
    operationsByName.sync_brain.handler(operationContext(), {
      repo: repoPath,
      full: true,
      no_pull: true,
      no_embed: true,
    }) as Promise<SyncResult>,
  );
}

async function defaultSourceBookmark(): Promise<string | null> {
  const rows = await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id = 'default'`,
  );
  return rows[0]?.last_commit ?? null;
}

async function activePageCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default' AND deleted_at IS NULL`,
  );
  return rows[0]?.n ?? 0;
}

describe('listEverCommittedPaths (#2426)', () => {
  test('returns every path ever added, including later-deleted ones; null for non-git dirs', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-ecp-'));
    try {
      gitInit(repo);
      writeFileSync(join(repo, 'kept.md'), 'kept\n');
      writeFileSync(join(repo, 'gone.md'), 'gone\n');
      execSync('git add -A && git commit -m add', { cwd: repo, stdio: 'pipe' });
      execSync('git rm -q gone.md && git commit -m rm', { cwd: repo, stdio: 'pipe' });

      const set = listEverCommittedPaths(repo);
      expect(set).not.toBeNull();
      expect(set!.has('kept.md')).toBe(true);
      expect(set!.has('gone.md')).toBe(true); // deleted, but WAS committed
      expect(set!.has('never-committed.md')).toBe(false);

      const plain = mkdtempSync(join(tmpdir(), 'gbrain-ecp-plain-'));
      try {
        expect(listEverCommittedPaths(plain)).toBeNull();
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('#2426 — full-sync reconcile keeps never-committed (DB-only) pages', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-dbonly-'));
    brainHome = mkdtempSync(join(tmpdir(), 'gbrain-dbonly-home-'));
    gitInit(repoPath);
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/keep.md'), [
      '---', 'type: concept', 'title: Keep', '---', '', 'still here',
    ].join('\n'));
    writeFileSync(join(repoPath, 'topics/gone.md'), [
      '---', 'type: concept', 'title: Gone', '---', '', 'will be git-rm-ed',
    ].join('\n'));
    execSync('git add -A && git commit -m initial', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    if (brainHome) rmSync(brainHome, { recursive: true, force: true });
  });

  test('genuinely-deleted pages reconcile; never-committed pages are kept and re-exported', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // Full sync #1: both file-backed pages land.
    const first = await withEnv({ GBRAIN_HOME: brainHome }, () => performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    }));
    expect(['first_sync', 'synced']).toContain(first.status);
    expect(await engine.getPage('topics/keep')).not.toBeNull();
    expect(await engine.getPage('topics/gone')).not.toBeNull();

    // A DB-only write-through casualty: the page row exists with a
    // source_path, but its file was never committed and is absent from the
    // clone (e.g. write-through was never pushed, then the repo was re-cloned).
    await engine.putPage('memories/lost', {
      type: 'concept',
      title: 'Lost write-through',
      compiled_truth: 'Years of content that must not be reconciled away.',
      timeline: '',
      frontmatter: { type: 'concept' },
    });
    await engine.executeRaw(
      `UPDATE pages SET source_path = $1 WHERE slug = $2 AND source_id = $3`,
      ['memories/lost.md', 'memories/lost', 'default'],
    );

    // A genuine deletion: topics/gone.md removed via git.
    execSync('git rm -q topics/gone.md && git commit -m "rm gone"', { cwd: repoPath, stdio: 'pipe' });
    await engine.setConfig('sync.repo_path', repoPath);

    // Full sync #2 runs the delete-reconcile.
    const second = await withEnv({ GBRAIN_HOME: brainHome }, () => performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    }));
    expect(['first_sync', 'synced']).toContain(second.status);

    // The genuinely-deleted page is reconciled away…
    expect(await engine.getPage('topics/gone')).toBeNull();
    // …the still-present page survives…
    expect(await engine.getPage('topics/keep')).not.toBeNull();
    // …and the DB-only page is PRESERVED (pre-fix: soft-deleted here)…
    const lost = await engine.getPage('memories/lost');
    expect(lost).not.toBeNull();
    expect(lost?.compiled_truth).toContain('must not be reconciled');
    // …and re-exported to the working tree so it is file-backed again.
    expect(existsSync(join(repoPath, 'memories/lost.md'))).toBe(true);
  }, 120_000);

  test('actual sync_brain handler returns a retryable block and preserves bookmark on mass refusal', async () => {
    mkdirSync(join(repoPath, 'bulk'), { recursive: true });
    const bulkPaths: string[] = [];
    for (let i = 0; i < 19; i++) {
      const rel = `bulk/page-${String(i).padStart(2, '0')}.md`;
      bulkPaths.push(rel);
      writeFileSync(join(repoPath, rel), [
        '---', 'type: concept', `title: Bulk ${i}`, '---', '', `bulk page ${i}`,
      ].join('\n'));
    }
    execSync('git add -A && git commit -m "add bulk fixture"', { cwd: repoPath, stdio: 'pipe' });

    const first = await fullSyncThroughOperation();
    expect(first.status).toBe('first_sync');
    const beforeRefusal = await defaultSourceBookmark();
    expect(beforeRefusal).not.toBeNull();
    expect(await activePageCount()).toBe(21);

    // Delete 11/21 (>50%, and population >20) so the safety valve refuses.
    rmSync(join(repoPath, 'topics/gone.md'));
    for (const rel of bulkPaths.slice(0, 10)) rmSync(join(repoPath, rel));
    execSync('git add -A && git commit -m "intentional mass removal"', { cwd: repoPath, stdio: 'pipe' });
    const deletionHead = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();

    const blocked = await withEnv(
      { GBRAIN_ALLOW_MASS_RECONCILE: undefined },
      () => fullSyncThroughOperation(),
    );
    expect(blocked.status).toBe('blocked_by_reconcile');
    expect(blocked.reconcile).toMatchObject({
      reason: 'mass_delete_refused',
      plannedDeletes: 11,
      completedDeletes: 0,
      failedDeletes: 11,
    });
    expect(await defaultSourceBookmark()).toBe(beforeRefusal);
    expect(await activePageCount()).toBe(21);

    // The operator override retries the same convergence step and advances
    // only after every genuine deletion is verified absent.
    const retried = await withEnv(
      { GBRAIN_ALLOW_MASS_RECONCILE: '1' },
      () => fullSyncThroughOperation(),
    );
    expect(retried.status).toBe('first_sync');
    expect(retried.deleted).toBe(11);
    expect(await defaultSourceBookmark()).toBe(deletionHead);
    expect(await activePageCount()).toBe(10);
  }, 180_000);

  test('delete failure is structured, leaves bookmark unchanged, and succeeds on retry', async () => {
    const first = await fullSyncThroughOperation();
    expect(first.status).toBe('first_sync');
    const beforeFailure = await defaultSourceBookmark();

    rmSync(join(repoPath, 'topics/gone.md'));
    execSync('git add -A && git commit -m "remove gone"', { cwd: repoPath, stdio: 'pipe' });
    const deletionHead = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();

    const originalDeletePages = engine.deletePages;
    const originalDeletePage = engine.deletePage;
    engine.deletePages = async () => { throw new Error('injected batch delete failure'); };
    engine.deletePage = async () => { throw new Error('injected scalar delete failure'); };
    const blocked = await (async () => {
      try {
        return await fullSyncThroughOperation();
      } finally {
        engine.deletePages = originalDeletePages;
        engine.deletePage = originalDeletePage;
      }
    })();

    expect(blocked.status).toBe('blocked_by_reconcile');
    expect(blocked.reconcile).toMatchObject({
      reason: 'delete_failed',
      plannedDeletes: 1,
      completedDeletes: 0,
      failedDeletes: 1,
    });
    expect(await defaultSourceBookmark()).toBe(beforeFailure);
    expect(await engine.getPage('topics/gone')).not.toBeNull();

    const retried = await fullSyncThroughOperation();
    expect(retried.status).toBe('first_sync');
    expect(retried.deleted).toBe(1);
    expect(await defaultSourceBookmark()).toBe(deletionHead);
    expect(await engine.getPage('topics/gone')).toBeNull();
  }, 180_000);
});
