/**
 * Fixture-driven unit tests for scripts/check-pr-branch-base.sh.
 *
 * This guards the real behavior the pre-push hook depends on:
 *   - a branch based on origin/master passes,
 *   - a branch that is not based on origin/master fails,
 *   - master/main bypass the feature-branch check.
 *
 * The tests build tiny tmp git repos so the ancestry proof is real but
 * still fast and hermetic.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const GUARD_SH = resolve(REPO_ROOT, 'scripts/check-pr-branch-base.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-branch-base-'));
  execFileSync('git', ['-c', 'init.defaultBranch=master', 'init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  return dir;
}

function commitFile(dir: string, rel: string, contents: string, message: string): string {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  execFileSync('git', ['-C', dir, 'add', rel]);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message]);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function runGuard(dir: string, env: NodeJS.ProcessEnv = {}): RunResult {
  const r = spawnSync('bash', [GUARD_SH], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

describe('check-pr-branch-base.sh', () => {
  it('returns 0 on master without requiring an origin/master ancestry check', () => {
    const dir = initRepo();
    commitFile(dir, 'README.md', '# base\n', 'base');

    const r = runGuard(dir);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('on master; no feature-branch PR base check needed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 when a feature branch is based on origin/master', () => {
    const dir = initRepo();
    const baseSha = commitFile(dir, 'base.txt', 'base\n', 'base commit');
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/master', baseSha]);
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'feature']);
    commitFile(dir, 'feature.txt', 'feature\n', 'feature commit');

    const r = runGuard(dir);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('ok (feature contains origin/master)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 1 and prints the branch-only commits when a branch is behind origin/master', () => {
    const dir = initRepo();
    const baseSha = commitFile(dir, 'upstream.txt', 'base\n', 'upstream base');
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/master', baseSha]);
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'stale-pr']);
    commitFile(dir, 'stale.txt', 'stale\n', 'stale branch commit');
    execFileSync('git', ['-C', dir, 'checkout', '-q', 'master']);
    const newBaseSha = commitFile(dir, 'upstream-2.txt', 'upstream-2\n', 'upstream advanced');
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/master', newBaseSha]);
    execFileSync('git', ['-C', dir, 'checkout', '-q', 'stale-pr']);

    const r = runGuard(dir);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing PR branch 'stale-pr'");
    expect(r.stderr).toContain('origin/master');
    expect(r.stderr).toContain('not an ancestor of HEAD');
    expect(r.stderr).toContain('stale branch commit');
    rmSync(dir, { recursive: true, force: true });
  });
});
