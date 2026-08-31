/**
 * Build-once git repo fixture. Model: dream.test.ts's makeGitRepo, but the
 * expensive part (init + config + initial commit) runs ONCE; tests call
 * `reset()` between cases instead of re-initializing — the same
 * pay-cold-start-once shape as reset-pglite.ts.
 *
 * Constraints:
 *   - Caller owns `dir` (mkdtempSync it, rmSync it after) — the fixture never
 *     creates or deletes the directory itself.
 *   - reset() = `git clean -ffdx` + `git reset --hard`: removes untracked
 *     files/dirs (ignored ones too) and restores tracked content to HEAD. It
 *     does NOT rewind commits — HEAD stays wherever commitAll left it.
 *   - execFileSync (no shell) so commit messages and paths need no quoting;
 *     stdio piped so output stays quiet, git errors still throw with stderr.
 *   - Signing is not disabled here: under bun test the git-hermetic-preload
 *     already injects commit.gpgsign=false via GIT_CONFIG_COUNT.
 */
import { execFileSync } from 'node:child_process';

export interface GitFixture {
  dir: string;
  /** Remove untracked files and restore tracked files to HEAD. */
  reset(): void;
  /** Stage everything and commit. Throws if there is nothing to commit. */
  commitAll(msg: string): void;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function makeGitFixture(dir: string): Promise<GitFixture> {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.co']);
  git(dir, ['config', 'user.name', 't']);
  // Empty initial commit so rev-parse HEAD and reset --hard work immediately.
  git(dir, ['commit', '--allow-empty', '-q', '-m', 'init']);
  return {
    dir,
    reset(): void {
      // -ff (double force): a single -f skips untracked NESTED git repos,
      // which would then contaminate later cases.
      git(dir, ['clean', '-ffdx', '-q']);
      git(dir, ['reset', '--hard', '-q']);
    },
    commitAll(msg: string): void {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', msg]);
    },
  };
}
