/**
 * Pure helpers for spawning the gbrain worker, optionally wrapped in tini.
 *
 * Background: zombie children spawned by the worker (shell jobs, embed
 * batches, sub-agents) need a SIGCHLD handler to be reaped. The cli.ts
 * SIGCHLD handler covers JS-spawned children that exit while the parent is
 * alive; tini wraps the worker process tree to also reap native-addon
 * descendants and orphans. Together the two layers compose with AlphaClaw's
 * container-level tini-as-PID-1.
 *
 * `detectTini()` is called once at supervisor / autopilot startup. The
 * resolved path is reused on every respawn — we do NOT shell out per spawn.
 * `buildSpawnInvocation()` is a pure function describing the (cmd, args)
 * tuple to pass to `child_process.spawn`. Tests call it directly without
 * any module mocking.
 */

import { execFileSync } from 'child_process';

/**
 * Resolve a runnable tini binary path, or return an empty string when no
 * compatible executable is on PATH. Discovery alone is insufficient: some
 * container images expose an `/init` (s6-overlay) alias named `tini` which
 * cannot run outside PID 1. Probe `--version` once at startup, then reuse the
 * verified path on every respawn.
 */
export function detectTini(): string {
  try {
    // Pass `env: process.env` explicitly: Bun's execFileSync does NOT
    // inherit the current process env by default (Bun snapshots env at
    // startup). Without this, runtime mutations to PATH (including in
    // tests) are invisible to `which`.
    const tiniPath = execFileSync('which', ['tini'], {
      encoding: 'utf8',
      timeout: 2000,
      env: process.env,
    }).trim();
    if (!tiniPath) return '';

    // `which tini` can resolve an unrelated container init shim. Only wrap
    // workers when the candidate can actually execute as a normal child.
    execFileSync(tiniPath, ['--version'], {
      stdio: 'ignore',
      timeout: 2000,
      env: process.env,
    });
    return tiniPath;
  } catch {
    return '';
  }
}

/**
 * Build the (cmd, args) tuple for spawning the gbrain worker, optionally
 * wrapped in tini. When `tiniPath` is non-empty, returns
 *   { cmd: tiniPath, args: ['--', cliPath, ...args] }
 * which makes tini PID 1 of the spawned subtree. When empty, returns
 *   { cmd: cliPath, args }
 * for a direct spawn. Pure function, no side effects.
 */
export function buildSpawnInvocation(
  tiniPath: string,
  cliPath: string,
  args: string[],
): { cmd: string; args: string[] } {
  return tiniPath
    ? { cmd: tiniPath, args: ['--', cliPath, ...args] }
    : { cmd: cliPath, args };
}
