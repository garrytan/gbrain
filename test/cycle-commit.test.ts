/**
 * test/cycle-commit.test.ts
 *
 * Integration tests for runPhaseCommit against real temporary git repos.
 * Uses fs.mkdtempSync + execFileSync to create hermetic git fixtures.
 * Zero DB, zero network (push fails non-fatally by design).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { runPhaseCommit } from '../src/core/cycle/commit.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Collect temp dirs for cleanup */
const tmpDirs: string[] = [];

function makeTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-commit-test-'));
  tmpDirs.push(dir);
  // Init repo with a local user identity so git commit doesn't fail on CI.
  execFileSync('git', ['init', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@gbrain.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'GBrain Test']);
  return dir;
}

function writeAndStage(repoDir: string, filename: string, content: string): void {
  writeFileSync(join(repoDir, filename), content, 'utf-8');
  // Don't stage here — let commit's `git add -A` stage everything.
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('runPhaseCommit', () => {
  test('a. uncommitted file → ok, committed=true, commit_sha truthy, git log shows gbrain autopilot [', async () => {
    const dir = makeTmpRepo();
    writeAndStage(dir, 'brain.md', '# Brain note\n');

    const result = await runPhaseCommit(dir, false);

    expect(result.status).toBe('ok');
    expect(result.details.committed).toBe(true);
    expect(typeof result.details.commit_sha).toBe('string');
    expect((result.details.commit_sha as string).length).toBeGreaterThan(0);
    expect(result.details.commit_sha).not.toBe('(unknown)');

    // Verify git log message
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline', '-1'], { encoding: 'utf-8' }).trim();
    expect(log).toContain('gbrain autopilot [');
  });

  test('b. clean repo (nothing staged) → ok, committed=false, summary mentions nothing to commit', async () => {
    const dir = makeTmpRepo();
    // Create and commit an initial file so there's a clean HEAD.
    writeFileSync(join(dir, 'initial.md'), '# Init\n', 'utf-8');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-m', 'initial']);

    const result = await runPhaseCommit(dir, false);

    expect(result.status).toBe('ok');
    expect(result.details.committed).toBe(false);
    expect(result.summary).toContain('nothing');
  });

  test('c. dryRun=true → status skipped', async () => {
    const dir = makeTmpRepo();
    writeAndStage(dir, 'file.md', '# file\n');

    const result = await runPhaseCommit(dir, true);

    expect(result.status).toBe('skipped');
    expect(result.details.dryRun).toBe(true);
  });

  test('d. signal already aborted → status skipped', async () => {
    const dir = makeTmpRepo();
    writeAndStage(dir, 'file.md', '# file\n');

    const ac = new AbortController();
    ac.abort(new Error('test abort'));

    const result = await runPhaseCommit(dir, false, ac.signal);

    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('aborted');
  });

  test('e. repo with changes but NO remote → push fails non-fatally: ok, committed=true, pushed=false, push_error truthy', async () => {
    const dir = makeTmpRepo();
    writeAndStage(dir, 'page.md', '# page\n');

    const result = await runPhaseCommit(dir, false);

    // The commit should succeed; push to "origin" should fail (no remote configured).
    expect(result.status).toBe('ok');
    expect(result.details.committed).toBe(true);
    expect(result.details.pushed).toBe(false);
    expect(typeof result.details.push_error).toBe('string');
    expect((result.details.push_error as string).length).toBeGreaterThan(0);
  });

  test('f. pre-commit hook exits 1 → commit fails: status fail, details.reason git_commit_failed', async () => {
    const dir = makeTmpRepo();
    writeAndStage(dir, 'page.md', '# page\n');

    // Write a failing pre-commit hook.
    const hooksDir = join(dir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    // Ensure executable bit is set explicitly (some systems may not honor mode in writeFileSync).
    chmodSync(hookPath, 0o755);

    const result = await runPhaseCommit(dir, false);

    expect(result.status).toBe('fail');
    expect(result.details.reason).toBe('git_commit_failed');
  });
});
