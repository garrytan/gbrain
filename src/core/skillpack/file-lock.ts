/**
 * skillpack/file-lock.ts — exclusive lock files for the skillpack writers.
 *
 * Two locks, always taken in this order when both are needed:
 *   1. the workspace writer lock, `.gbrain-skillpack.lock` in the directory
 *      that holds the skills root (the same file `installer.ts` takes), and
 *   2. the shared state lock, `skillpack-state.json.lock` beside
 *      `~/.gbrain/skillpack-state.json`.
 *
 * Mutual exclusion comes from an O_EXCL create. Line 1 is the pid (what the
 * installer's reader parses), line 2 a per-acquire token that release() checks,
 * so a process never removes a lock it does not hold. A lock file older than
 * `staleMs` is reclaimed: the holder died (the commands that take these locks
 * finish in seconds). Liveness is mtime only, never pid, for the reason
 * page-lock.ts gives.
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { OperationError } from '../ops/contract.ts';

export const WORKSPACE_LOCK_FILENAME = '.gbrain-skillpack.lock';
const DEFAULT_STALE_MS = 10 * 60 * 1000;

export interface FileLock {
  path: string;
  release(): void;
}

export function workspaceLockPath(skillsRoot: string): string {
  return join(dirname(skillsRoot), WORKSPACE_LOCK_FILENAME);
}

function tryAcquire(path: string, staleMs: number): FileLock | null {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (Date.now() - statSync(path).mtimeMs >= staleMs) unlinkSync(path);
  } catch { /* absent, or released between the stat and the unlink */ }
  const token = randomUUID();
  try {
    writeFileSync(path, `${process.pid}\n${token}\n`, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  return {
    path,
    release: () => {
      try {
        if (readFileSync(path, 'utf-8').split('\n')[1] === token) unlinkSync(path);
      } catch { /* already gone */ }
    },
  };
}

/**
 * Take the lock at `path`, polling until `timeoutMs` elapses. Throws
 * `code` (an OperationError) naming the lock file when it stays held.
 */
export async function acquireFileLock(
  path: string,
  opts: { code: 'skillpack_workspace_locked' | 'skillpack_state_locked'; timeoutMs?: number; staleMs?: number },
): Promise<FileLock> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    const lock = tryAcquire(path, staleMs);
    if (lock) return lock;
    if (Date.now() >= deadline) {
      throw new OperationError(opts.code, `Another gbrain skillpack command holds ${path}.`,
        `Wait for it to finish and run the command again. If no gbrain skillpack command is running, the lock is left from a crash and is reclaimed after ${Math.round(staleMs / 60000)} minutes.`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
