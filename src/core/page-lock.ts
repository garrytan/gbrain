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
 * File contents: `{pid}\n{iso-timestamp}\n{owner-token}`. Staleness = mtime
 * older than `LOCK_TTL_MS` (5 min) — nothing else. PID-liveness
 * (`process.kill(pid, 0)`) is deliberately NOT consulted (#2840): across PID
 * namespaces (two containers sharing GBRAIN_HOME) a live holder's PID reads
 * as ESRCH, so a liveness fast-steal silently steals a live lock. Same
 * philosophy as the #2348 pglite-lock: never steal a possibly-live holder.
 * Holders `refresh()` to stay fresh; a crashed holder ages out via the TTL.
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
import { createHash, randomUUID } from 'node:crypto';
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

/** Third line of the lock file. Ownership checks use this token, not the PID:
 * PID numbers are meaningless identity across PID namespaces (container A's
 * pid 7 and container B's pid 7 are different processes on a shared volume). */
function tokenOf(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf-8').trim().split('\n')[2] ?? null;
  } catch {
    return null;
  }
}

function tryAcquireOnce(slug: string, lockPath: string): PageLockHandle | null {
  const dir = join(lockPath, '..');
  mkdirSync(dir, { recursive: true });

  if (existsSync(lockPath)) {
    try {
      const st = statSync(lockPath);
      const ageMs = Date.now() - st.mtimeMs;
      // #2840: staleness is mtime-TTL ONLY. Do NOT fast-steal on a
      // dead-looking PID — process.kill(pid, 0) returns ESRCH for LIVE
      // holders in another PID namespace (containerized serve + jobs-work
      // sharing GBRAIN_HOME), so "PID dead" is not evidence the lock is free.
      if (ageMs < LOCK_TTL_MS) {
        return null; // fresh lock — assume live holder
      }
      // TTL expired — stale, fall through to overwrite.
    } catch {
      // Stat error (file vanished mid-check) → treat as stale.
    }
  }

  const ownerToken = randomUUID();
  const write = () =>
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n${ownerToken}\n`);
  write();

  return {
    slug,
    refresh: async () => {
      try {
        // Only refresh if the on-disk lock is still ours — a stale handle
        // must never clobber a new owner's lock (same rule as pglite-lock).
        if (tokenOf(lockPath) === ownerToken) write();
      } catch {
        /* non-fatal — next acquirer will see it as stale */
      }
    },
    release: async () => {
      try {
        if (tokenOf(lockPath) === ownerToken) unlinkSync(lockPath);
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
