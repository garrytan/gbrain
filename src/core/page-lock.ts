/**
 * v0.28: per-page file lock for atomic markdown read-modify-write.
 *
 * Scoped per page so two parallel `gbrain takes add` calls + a refresh-mode
 * `takes seed` running in autopilot can't race on the same `<slug>.md` file.
 *
 * Lock file path: `~/.gbrain/page-locks/<sha256-of-slug>.lock`. SHA-256
 * keeps filenames safe regardless of slug content (slashes, unicode, etc.).
 *
 * File contents: `{pid}\n{iso-timestamp}\n{ownership-token}`. The pid line
 * is DIAGNOSTIC ONLY. Locks are never stolen automatically: portable Node
 * filesystems do not expose an atomic compare-and-unlink, so TTL reclamation
 * can delete a newly-created live lock under a two-reclaimer race. A crashed
 * holder therefore fails closed until an operator quiesces writers and removes
 * the orphaned lock. This trades availability after a crash for data integrity.
 *
 * Ownership for release()/refresh() is the per-acquire random token, never
 * the bare PID — PIDs collide across namespaces, so a same-pid lockfile is
 * not proof it is ours (#2840 false-self direction).
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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gbrainPath } from './config.ts';

export interface PageLockHandle {
  /** Release the lock if we still hold it. Idempotent. */
  release: () => Promise<void>;
  /** Refresh the timestamp for diagnostics while a long operation is active. */
  refresh: () => Promise<void>;
  /** Slug the lock was acquired for (for diagnostics). */
  slug: string;
  /** Source owning the page. Lock identity is the pair (sourceId, slug). */
  sourceId: string;
}

export interface AcquirePageLockOpts {
  /** Total wait budget before giving up. Default 0 (no wait — fail fast). */
  timeoutMs?: number;
  /** Polling interval while waiting. Default 200ms. */
  pollMs?: number;
  /** Override lock root for tests. */
  lockRoot?: string;
  /** Source owning the page. Defaults to `default` for legacy callers. */
  sourceId?: string;
}

function lockPathFor(slug: string, lockRoot?: string, sourceId = 'default'): string {
  // A slug is only unique inside a source. Hash an unambiguous composite so
  // same-slug pages in federated sources can mutate independently while every
  // writer for one concrete page still serializes on the same lock.
  const sha = createHash('sha256').update(sourceId).update('\0').update(slug).digest('hex');
  const dir = lockRoot ?? gbrainPath('page-locks');
  return join(dir, `${sha}.lock`);
}

/** Line 3 of the lock file. Empty string when absent (pre-#2840 format). */
function tokenOf(content: string): string {
  return content.trim().split('\n')[2] ?? '';
}

function tryAcquireOnce(slug: string, sourceId: string, lockPath: string): PageLockHandle | null {
  const dir = join(lockPath, '..');
  mkdirSync(dir, { recursive: true });
  const pid = process.pid;
  // Namespace-stable per-acquire identity. Release/refresh ownership keys on
  // this, never on the PID (#2840: PIDs collide across PID namespaces).
  const token = randomUUID();
  if (existsSync(lockPath)) {
    return null;
  }

  // Exclusive create: mutual exclusion comes from O_EXCL, not from the
  // (racy) existence check above. Losing the create race = lock not held.
  try {
    writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n${token}\n`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw e;
  }

  return {
    slug,
    sourceId,
    refresh: async () => {
      try {
        // Only heartbeat a lock we still own — if our TTL lapsed and another
        // process reclaimed it, overwriting would clobber ITS heartbeat.
        if (tokenOf(readFileSync(lockPath, 'utf-8')) !== token) return;
        writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n${token}\n`);
      } catch {
        /* non-fatal — next acquirer will see it as stale */
      }
    },
    release: async () => {
      try {
        // Token match, not PID match: a foreign-namespace process can share
        // our PID number, and unlinking its lock reopens the #2840 race.
        if (tokenOf(readFileSync(lockPath, 'utf-8')) === token) unlinkSync(lockPath);
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
  const sourceId = opts.sourceId ?? 'default';
  const lockPath = lockPathFor(slug, opts.lockRoot, sourceId);
  const deadline = Date.now() + (opts.timeoutMs ?? 0);
  const pollMs = opts.pollMs ?? 200;

  let attempt = tryAcquireOnce(slug, sourceId, lockPath);
  if (attempt) return attempt;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    attempt = tryAcquireOnce(slug, sourceId, lockPath);
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
  // Keep diagnostics current while projection/embedding work is in flight.
  const heartbeat = setInterval(() => { void handle.refresh(); }, 60_000);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await handle.release();
  }
}
