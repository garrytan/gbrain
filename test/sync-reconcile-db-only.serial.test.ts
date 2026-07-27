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
import { listEverCommittedPaths } from '../src/commands/sync.ts';

let engine: PGLiteEngine;
let repoPath: string;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
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
  });

  test('genuinely-deleted pages reconcile; never-committed pages are kept and re-exported', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // Full sync #1: both file-backed pages land.
    const first = await performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    });
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
    const second = await performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    });
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
});
