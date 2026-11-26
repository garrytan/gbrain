/**
 * How the shadow replay child process starts (docs/guides/shadow-replay.md). Its argv literal (`--no-env-file`) is a
 * Bun runtime flag for the child, not a gbrain flag: scripts/generate-flag-registry.ts skips this module.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How the replay child starts: in its own empty, private working directory inside the run folder (never the parent's,
 * so no `.env`, `bunfig.toml` or preload there is read), and, when it runs on the Bun runtime, with `--no-env-file`
 * (Bun 1.4.4) so no `.env` file is loaded anywhere. A compiled gbrain binary reads neither from an empty directory.
 */
export function replayChildSpawn(command: string[], runDir: string): { argv: string[]; cwd: string } {
  const cwd = join(runDir, 'cwd');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const [exe, ...rest] = command;
  const runtime = /(^|[\\/])bun(-[a-z0-9-]+)?(\.exe)?$/i.test(exe ?? '');
  return { argv: runtime ? [exe!, '--no-env-file', ...rest] : command, cwd };
}

/** Starts the replay child the way `replayChildSpawn` says, with only `env` (childEnv's allowlist). */
export function spawnReplayChild(command: string[], runDir: string, env: Record<string, string>,
  spawn: typeof import('../core/spawn.ts').bunSpawn): { exited: Promise<number>; kill(): void } {
  const child = replayChildSpawn(command, runDir);
  const proc = spawn(child.argv, { env, cwd: child.cwd, stdout: 'ignore', stderr: 'inherit' });
  return { exited: proc.exited, kill: () => proc.kill('SIGKILL') };
}
