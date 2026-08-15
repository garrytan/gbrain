/**
 * Regression guard for scripts/check-no-tracked-symlinks.sh.
 *
 * Commit faf5cdba tracked `node_modules -> /tmp/fleet/repo/node_modules`.
 * That path exists on one build sandbox and nowhere else, so every other
 * clone got a dangling symlink and `bun install` aborted with
 * `ENOENT: could not open the "node_modules" directory` — which also took
 * out `gbrain upgrade`'s bun-link path, since it shells out to bun install.
 *
 * `.gitignore` did not stop it: a `node_modules/` pattern with a trailing
 * slash matches directories only, so the symlink was never ignored. The
 * pattern is fixed, but `git add -f` still bypasses .gitignore entirely,
 * so the shell guard is the real backstop. These tests pin (1) the guard
 * detects a tracked symlink, (2) it stays green on this repo, and (3) it
 * is actually wired into `bun run verify`.
 */

import { describe, it, expect } from 'bun:test';
import { existsSync, statSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(import.meta.dir, '..');
const GUARD = resolve(REPO_ROOT, 'scripts/check-no-tracked-symlinks.sh');
const VERIFY_DISPATCHER = resolve(REPO_ROOT, 'scripts/run-verify-parallel.sh');

describe('check-no-tracked-symlinks.sh', () => {
  it('exists and is executable', () => {
    expect(existsSync(GUARD)).toBe(true);
    expect((statSync(GUARD).mode & 0o100) !== 0).toBe(true);
  });

  it('passes on this repo (no tracked symlinks)', () => {
    const r = spawnSync('bash', [GUARD], { cwd: REPO_ROOT, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('fails and names the offender when a symlink is tracked', () => {
    // Build a throwaway repo rather than poisoning this one's index.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-symlink-guard-'));
    try {
      const git = (...args: string[]) =>
        spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });

      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');

      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      // Absolute target that does not exist — the exact shape of the bug.
      symlinkSync('/tmp/does-not-exist/node_modules', join(dir, 'node_modules'));
      git('add', '-A');

      const r = spawnSync('bash', [GUARD], { cwd: dir, encoding: 'utf-8' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('node_modules -> /tmp/does-not-exist/node_modules');
      expect(r.stdout).toContain('git rm --cached');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is wired into the verify dispatcher', () => {
    const r = spawnSync('bash', [VERIFY_DISPATCHER, '--dry-list'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(new Set(r.stdout.trim().split('\n'))).toContain('check:no-tracked-symlinks');
  });
});

describe('.gitignore node_modules patterns', () => {
  it('match symlinks too (no trailing slash)', () => {
    const lines = require('fs')
      .readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf-8')
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('#'));

    // A trailing slash restricts the pattern to directories, which is how
    // the symlink slipped through. Every node_modules rule must be bare.
    const offenders = lines.filter((l: string) => /node_modules\/$/.test(l));
    expect(offenders).toEqual([]);
    expect(lines).toContain('node_modules');
  });
});
