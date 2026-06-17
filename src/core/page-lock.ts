/**
 * v0.28: per-page file lock for atomic markdown read-modify-write.
 *
 * Eng-review fold: reuses the v0.17 `~/.gbrain/cycle.lock` PID-liveness
 * pattern (src/core/cycle.ts:acquireFileLock) but scoped per page so two
 * parallel `gbrain takes add` calls + a `takes seed --refresh` running in
 * autopilot can't race on the same `<slug>.md` file.
 *
 * Lock file path: `~/.gbrain/page-locks/<sha256-of-slug>.lock`. SHA-256
 * keeps filenames safe regardless of slug content (slashes, unicode, etc.).
 *
 * File contents: `{pid}\n{iso-timestamp}`. Staleness = mtime older than
 * `LOCK_TTL_MS` (5 min) OR the PID is no longer alive on this host.
 *
 * Usage:
 *
 *   const lock = await acquirePageLock(slug, { timeoutMs: 30_000 });
 *   try {
 *     // read-modify-write the markdown file
 *   } finally {
 *     await lock.release();
 *   }
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gbrainPath } from './config.ts';

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches eng-review fold spec

export interface PageLockHandle {
  /** Release the lock if we still hold it. Idempotent. */
  release: () => Promise<void>;
  /** Refresh the mtime + timestamp so the TTL doesn't expire mid-operation. */
  refresh: () => Promise<void>;
  /** Slug the lock was acquired for (for diagnostics). */
  slug: string;
}

export interface AcquirePageLockOpts {
  /** Total wait budget before giving up. Default 0 (no wait — fail fast). */
  timeoutMs?: number;
  /** Polling interval while waiting. Default 200ms. */
  pollMs?: number;
  /** Override lock root for tests. */
  lockRoot?: string;
}

function lockPathFor(slug: string, lockRoot?: string): string {
  const sha = createHash('sha256').update(slug).digest('hex');
  const dir = lockRoot ?? gbrainPath('page-locks');
  return join(dir, `${sha}.lock`);
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  // Note: unlike cycle.ts (single lock per process), page-lock allows
  // multiple concurrent locks per process for DIFFERENT slugs. A same-pid
  // collision on the SAME slug means another concurrent caller in this
  // process holds it — treat as live and let mtime expiry handle stale
  // post-crash cases.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ESRCH = no such process; anything else (e.g. EPERM) = still alive.
    return code !== 'ESRCH';
  }
}

function tryAcquireOnce(slug: string, lockPath: string): PageLockHandle | null {
  const dir = join(lockPath, '..');
  mkdirSync(dir, { recursive: true });
  const pid = process.pid;

  if (existsSync(lockPath)) {
    try {
      const st = statSync(lockPath);
      const ageMs = Date.now() - st.mtimeMs;
      const content = readFileSync(lockPath, 'utf-8').trim();
      const existingPid = parseInt(content.split('\n')[0] || '0', 10);
      const pidAlive = isPidAlive(existingPid);

      if (pidAlive && ageMs < LOCK_TTL_MS) {
        return null; // live holder
      }
      // Stale — fall through to overwrite.
    } catch {
      // Any read/stat error → treat as stale.
    }
  }

  writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n`);

  return {
    slug,
    refresh: async () => {
      try {
        writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n`);
      } catch {
        /* non-fatal — next acquirer will see it as stale */
      }
    },
    release: async () => {
      try {
        const content = readFileSync(lockPath, 'utf-8').trim();
        const heldPid = parseInt(content.split('\n')[0] || '0', 10);
        if (heldPid === pid) unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Acquire a per-page lock. By default fails fast (timeoutMs=0) — a live
 * holder returns null. Pass timeoutMs > 0 to poll until acquired or the
 * deadline expires.
 */
export async function acquirePageLock(
  slug: string,
  opts: AcquirePageLockOpts = {},
): Promise<PageLockHandle | null> {
  const lockPath = lockPathFor(slug, opts.lockRoot);
  const deadline = Date.now() + (opts.timeoutMs ?? 0);
  const pollMs = opts.pollMs ?? 200;

  let attempt = tryAcquireOnce(slug, lockPath);
  if (attempt) return attempt;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    attempt = tryAcquireOnce(slug, lockPath);
    if (attempt) return attempt;
  }

  return null;
}

/**
 * Convenience wrapper: acquire, run fn, release. Throws if the lock
 * cannot be acquired within the timeout.
 */
export async function withPageLock<T>(
  slug: string,
  fn: () => Promise<T>,
  opts: AcquirePageLockOpts = {},
): Promise<T> {
  const handle = await acquirePageLock(slug, { timeoutMs: 30_000, ...opts });
  if (!handle) {
    throw new Error(`acquirePageLock: could not acquire lock for slug "${slug}" within ${opts.timeoutMs ?? 30_000}ms`);
  }
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
