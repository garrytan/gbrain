/**
 * Git invocation for directories gbrain does not trust (a user-chosen checkout,
 * a candidate clone): the repository's own configuration must not run code or
 * reach the network. Every call scrubs `GIT_*` from the environment, ignores
 * system and global config, and disables fsmonitor, hooks, the untracked
 * cache, submodule recursion, protocols, credential helpers and automatic
 * maintenance. Arguments are an argv array, never a shell string. Callers
 * bound time and output (`company-brain/revision.ts` streams with its own
 * caps; `hardenedGitSync` takes a timeout and a byte cap).
 */
import { spawnSync } from 'node:child_process';

export const HARDENED_GIT_ARGS: readonly string[] = ['--no-pager', '--no-optional-locks', '--no-replace-objects',
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
  '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'credential.helper=',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

export function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C' };
}

export type HardenedGitResult = { ok: true; stdout: Buffer } | { ok: false; reason: 'exit' | 'timeout' | 'too_large' | 'unavailable' };

/** Runs `git -C <root> <args>` synchronously under the hardening above, within `timeoutMs` and `maxBytes` of stdout. */
export function hardenedGitSync(root: string, args: string[], limits: { timeoutMs: number; maxBytes: number }): HardenedGitResult {
  const run = spawnSync('git', [...HARDENED_GIT_ARGS, '-C', root, ...args],
    { env: hardenedGitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], timeout: limits.timeoutMs, maxBuffer: limits.maxBytes, killSignal: 'SIGKILL' });
  const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
  if (code === 'ENOBUFS') return { ok: false, reason: 'too_large' };
  if (run.error) return { ok: false, reason: 'unavailable' };
  if (run.status !== 0) return { ok: false, reason: 'exit' };
  return { ok: true, stdout: run.stdout };
}
