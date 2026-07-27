/**
 * discoverGitRoot's `rev-parse --show-toplevel` probe fails routinely (a
 * scratch dir, a not-yet-git-initialized brain dir, `#2964` auto-recovery's
 * own probe). Node's `execFileSync` writes the child's stderr straight
 * through to the parent's real stderr by default, so every one of these
 * *expected* misses used to dump git's raw `fatal: not a git repository
 * (or any of the parent directories): .git` line onto gbrain's own stderr —
 * indistinguishable, to an operator grepping logs for `fatal:` as a crash
 * signature, from an actual crash. `discoverGitRoot` already handles the
 * failure (throws a friendlier `Error`, or `sync.ts`'s `#2964` auto-recovery
 * catches it and git-inits); only the process-level stderr leak was the bug.
 *
 * These tests spawn a real `bun` subprocess (rather than monkeypatching
 * `process.stderr.write` in-process) because the leak happens at the OS file
 * descriptor level — `execFileSync`'s default `stdio: 'inherit'`-for-stderr
 * behavior writes directly to fd 2 of whichever process calls it, bypassing
 * `process.stderr.write()` entirely. A subprocess is the only way to observe
 * (or fail to observe) that write from the test.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';

const SYNC_MODULE = join(import.meta.dir, '..', 'src', 'commands', 'sync.ts');

function runDiscoverGitRootProbe(targetDir: string) {
  return spawnSync(
    'bun',
    [
      '-e',
      `
      import { discoverGitRoot } from ${JSON.stringify(SYNC_MODULE)};
      try {
        // Success path prints to STDOUT only — stderr must stay untouched
        // by both the probe itself and this harness so the tests can make
        // a clean "nothing on stderr" assertion.
        console.log('OK:' + discoverGitRoot(${JSON.stringify(targetDir)}));
      } catch (e) {
        console.error('CAUGHT:' + e.message);
      }
      `,
    ],
    { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } },
  );
}

describe('discoverGitRoot probe stderr hygiene', () => {
  test('an expected probe failure (non-git dir) never leaks git\'s raw "fatal:" line to stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-nogit-'));
    try {
      const res = runDiscoverGitRootProbe(dir);
      expect(res.status).toBe(0);
      // The caller's own friendly error still surfaces...
      expect(res.stderr).toContain('CAUGHT:Not inside a git repository');
      // ...but git's own raw stderr line must not reach the process stderr.
      expect(res.stderr).not.toMatch(/fatal:/i);
      expect(res.stderr).not.toContain('not a git repository (or any of the parent directories)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a successful probe (real git repo) still returns the toplevel and prints nothing to stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-git-'));
    try {
      spawnSync('git', ['init', '--quiet'], { cwd: dir });
      const res = runDiscoverGitRootProbe(dir);
      expect(res.status).toBe(0);
      // The resolved toplevel path lands on stdout, proving the probe
      // actually succeeded (not just "didn't throw"). Compare by basename
      // only — macOS resolves `/tmp`/`/var` symlinks (e.g. to
      // `/private/tmp/...`), so the raw `dir` string may not appear verbatim
      // in git's `--show-toplevel` output even on a clean success.
      expect(res.stdout).toContain('OK:');
      expect(res.stdout).toContain(basename(dir));
      expect(res.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
