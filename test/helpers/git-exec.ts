/**
 * test/helpers/git-exec.ts — #4230.
 *
 * execSync git wrapper for test fixture setup. Two problems it solves:
 *
 * 1. **Transient flake under the pooled serial lane (pool=4).** git
 *    init/add/commit in a fresh tmp repo occasionally fails transiently
 *    when four bun workers hammer spawn + the filesystem at once. The
 *    wrapper retries twice with a small jittered backoff, so one blip
 *    doesn't fail a whole serial suite.
 * 2. **Undiagnosable failures.** `execSync(..., { stdio: 'pipe' })` throws
 *    an error whose message is just "Command failed" — git's actual stderr
 *    is buried in a Buffer property that the test reporter never prints.
 *    On final failure the wrapper throws a single Error carrying the
 *    command, cwd, exit status, stderr, and stdout, so the NEXT flake is a
 *    one-minute diagnosis instead of a re-run guessing game.
 *
 * Deliberately test-only: production git use goes through the repo's own
 * runners; this helper exists so fixture setup keeps pool=4 without flaking.
 */

import { execSync } from 'node:child_process';

interface ExecError {
  status?: number | null;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  message?: string;
}

/** Total attempts = 1 + GIT_EXEC_RETRIES. */
const GIT_EXEC_RETRIES = 2;

/**
 * Run a git command in `cwd`, retrying transient failures with jittered
 * backoff and surfacing git's stderr in the thrown error on final failure.
 */
export function gitExec(cmd: string, cwd: string): string {
  let lastErr: ExecError | null = null;
  for (let attempt = 0; attempt <= GIT_EXEC_RETRIES; attempt++) {
    if (attempt > 0) {
      // Jittered backoff: 50-200ms on the first retry, 100-400ms on the
      // second — enough to ride out a spawn/fs contention blip without
      // meaningfully slowing a genuinely-broken setup's failure.
      Bun.sleepSync((50 + Math.random() * 150) * attempt);
    }
    try {
      return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      lastErr = e as ExecError;
    }
  }
  const stderr = lastErr?.stderr?.toString().trim();
  const stdout = lastErr?.stdout?.toString().trim();
  throw new Error(
    `git exec failed after ${GIT_EXEC_RETRIES + 1} attempts: \`${cmd}\` ` +
      `(cwd: ${cwd}, exit: ${lastErr?.status ?? 'unknown'})` +
      (stderr ? `\nstderr: ${stderr}` : '') +
      (stdout ? `\nstdout: ${stdout}` : ''),
  );
}
