/**
 * deletePageThrough reaches git on durability-hardened repos.
 *
 * Bug class (the delete-side twin of #2426): `delete_page` unlinked the
 * write-through `.md` in `sync.repo_path` but NOTHING ever committed the
 * removal. The post-commit hook only fires after a commit, so the deletion sat
 * in the working tree as an uncommitted ` D` — invisible to commit-driven
 * sync, which then warned "N uncommitted file(s) invisible to commit-driven
 * sync" every tick until a human committed it by hand.
 *
 * Fix: `deletePageThrough` best-effort commits the removal (path-limited) when
 * the repo carries the gbrain durability post-commit hook, exactly as
 * `writePageThrough` does for writes. Unhardened repos keep the old
 * unlink-only behavior.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { writePageThrough, deletePageThrough } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}

/** Hook file carrying the gbrain durability banner (what `isDurabilityHardened`
 *  looks for) with a no-op body so tests never attempt a real push. */
function installFakeDurabilityHook(repoPath: string): void {
  const hooksDir = join(repoPath, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'post-commit');
  writeFileSync(hookPath, [
    '#!/usr/bin/env bash',
    '# gbrain brain-durability post-commit hook (v0.42.44+)',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(hookPath, 0o755);
}

async function seedPage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'concept',
    title: 'Page that will be deleted',
    compiled_truth: 'Content whose removal must reach git.',
    timeline: '',
    frontmatter: { type: 'concept' },
  });
}

describe('deletePageThrough auto-commit on durability-hardened repos', () => {
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
    repo = mkdtempSync(join(tmpdir(), 'gbrain-dwt-'));
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'seed.md'), 'seed\n');
    execSync('git add -A && git commit -m init', { cwd: repo, stdio: 'pipe' });
    await engine.setConfig('sync.repo_path', repo);
  });

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test('on a hardened repo, the removal is committed (path-limited)', async () => {
    installFakeDurabilityHook(repo);
    await seedPage('notes/hello');
    const written = await writePageThrough(engine, 'notes/hello');
    expect(written.committed).toBe(true);
    // Unrelated dirty edit — must NOT be swept into the delete commit.
    writeFileSync(join(repo, 'seed.md'), 'dirty unrelated edit\n');

    const result = await deletePageThrough(engine, 'notes/hello');

    expect(result.removed).toBe(true);
    expect(result.committed).toBe(true);
    expect(existsSync(join(repo, 'notes', 'hello.md'))).toBe(false);
    // The removal is committed…
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('gbrain: delete write-through notes/hello');
    expect(git(repo, 'log', '-1', '--name-only', '--format=')).toBe('notes/hello.md');
    expect(git(repo, 'status', '--porcelain', 'notes/hello.md')).toBe('');
    // …and the unrelated edit stays uncommitted (explicit-path discipline).
    expect(git(repo, 'status', '--porcelain', 'seed.md')).not.toBe('');
  }, 60_000);

  test('on an unhardened repo, the file is unlinked but NOT committed (no behavior change)', async () => {
    await seedPage('notes/plain');
    await writePageThrough(engine, 'notes/plain');
    // Track the page so the unlink shows up as a working-tree deletion.
    execSync('git add -A && git commit -m seed-page', { cwd: repo, stdio: 'pipe' });

    const result = await deletePageThrough(engine, 'notes/plain');

    expect(result.removed).toBe(true);
    expect(result.committed).toBeUndefined();
    expect(existsSync(join(repo, 'notes', 'plain.md'))).toBe(false);
    // Deleted in the working tree, uncommitted — the pre-existing contract.
    // (`git()` trims, so porcelain's leading worktree-column space is gone.)
    expect(git(repo, 'status', '--porcelain', 'notes/plain.md')).toMatch(/^ ?D notes\/plain\.md$/);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('seed-page');
  }, 60_000);

  test('hardened AFTER the write: the never-committed page is unlinked with nothing to commit (no empty commit)', async () => {
    // Written while unhardened → the artifact is untracked (pre-#2426 contract).
    await seedPage('notes/late');
    const written = await writePageThrough(engine, 'notes/late');
    expect(written.committed).toBeUndefined();
    expect(git(repo, 'status', '--porcelain', 'notes/late.md')).toContain('?? notes/late.md');
    // Harden between the write and the delete.
    installFakeDurabilityHook(repo);

    const result = await deletePageThrough(engine, 'notes/late');

    expect(result.removed).toBe(true);
    expect(existsSync(join(repo, 'notes', 'late.md'))).toBe(false);
    // `git add -- <vanished untracked path>` fails → the best-effort commit
    // reports false → no `committed`, no empty commit, and nothing left behind.
    expect(result.committed).toBeUndefined();
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('init');
  }, 60_000);
});
