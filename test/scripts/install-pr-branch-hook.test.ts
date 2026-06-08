/**
 * Fixture-driven unit tests for scripts/install-pr-branch-hook.sh.
 *
 * This does not try to run a real push. Instead it proves the installer
 * writes a pre-push hook that:
 *   - targets fork/origin pushes,
 *   - skips other remotes,
 *   - and dispatches to scripts/check-pr-branch-base.sh with --fetch.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const INSTALL_SH = resolve(REPO_ROOT, 'scripts/install-pr-branch-hook.sh');

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-branch-hook-'));
  execFileSync('git', ['-c', 'init.defaultBranch=master', 'init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  return dir;
}

describe('install-pr-branch-hook.sh', () => {
  it('installs a pre-push hook that calls the ancestry guard', () => {
    const dir = initRepo();
    execFileSync('bash', [INSTALL_SH], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env },
    });

    const hookPath = join(dir, '.git', 'hooks', 'pre-push');
    expect(existsSync(hookPath)).toBe(true);
    expect((statSync(hookPath).mode & 0o111) !== 0).toBe(true);

    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('# gbrain check-pr-branch-base');
    expect(content).toContain('fork|origin|""');
    expect(content).toContain('GBRAIN_SKIP_PR_BRANCH_BASE_CHECK');
    expect(content).toContain('exec "$ROOT/scripts/check-pr-branch-base.sh" --fetch');

    rmSync(dir, { recursive: true, force: true });
  });
});
