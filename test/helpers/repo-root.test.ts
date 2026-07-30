/**
 * Pins the invariants that make `REPO_ROOT` usable as a filesystem path and
 * as a `Bun.spawn` cwd on every platform.
 *
 * Regression: tests used to derive the repo root with
 * `new URL('..', import.meta.url).pathname`. On Windows that yields
 * `/C:/Users/...`, which no Win32 API accepts — so `Bun.spawn({ cwd })` failed
 * with `ENOENT: no such file or directory, uv_spawn 'bun'`. That message names
 * argv[0], not the directory that is actually missing, which is why it read as
 * "bun is not installed" for a long time. Every assertion below fails against
 * the old expression on Windows and passes on POSIX, where the two forms agree.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { REPO_ROOT, repoPath } from './repo-root.ts';

describe('REPO_ROOT', () => {
  test('is an absolute, existing directory', () => {
    expect(isAbsolute(REPO_ROOT)).toBe(true);
    expect(existsSync(REPO_ROOT)).toBe(true);
  });

  test('is a filesystem path, not a URL path', () => {
    // `/C:/Users/...` — the exact shape `.pathname` produces on Windows.
    expect(REPO_ROOT).not.toMatch(/^\/[A-Za-z]:/);
    // `.pathname` leaves percent-encoding in place; a repo checked out under
    // a path with a space would arrive as `%20` and fail every fs call.
    expect(REPO_ROOT).not.toContain('%');
    // No trailing separator, so `${REPO_ROOT}/src/cli.ts` interpolation is safe.
    expect(REPO_ROOT).not.toMatch(/[\\/]$/);
  });

  test('resolves repo files', () => {
    expect(existsSync(repoPath('package.json'))).toBe(true);
    expect(existsSync(repoPath('src', 'cli.ts'))).toBe(true);
  });

  test('works as a Bun.spawn cwd — the case that produced the uv_spawn ENOENT', () => {
    const res = Bun.spawnSync([process.execPath, '--version'], { cwd: REPO_ROOT });
    expect(res.success).toBe(true);
  });
});
