/**
 * PGLite File Lock — prevents concurrent process access to the same data directory.
 *
 * PGLite uses embedded Postgres (WASM) which only supports one connection at a time.
 * When `gbrain embed` (which can take minutes) is running and another process tries
 * to connect, PGLite throws `Aborted()` because it can't handle concurrent access.
 *
 * This module implements a simple advisory lock using a lock file next to the data
 * directory. It uses atomic `mkdir` (which is POSIX-atomic) combined with PID tracking
 * for stale lock detection.
 *
 * Usage:
 *   const lock = await acquireLock(dataDir);
 *   try { ... } finally { await releaseLock(lock); }
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';

const LOCK_DIR_NAME = '.gbrain-lock';
const LOCK_FILE = 'lock';

// #2058: refresh the lock's `refreshed_at` while held so a long-running but
// LIVE holder (embed jobs run for many minutes) is never mistaken for stale.
const HEARTBEAT_INTERVAL_MS = 30_000;

// #2058: a holder whose heartbeat refreshed within this window is ALIVE and is
// NEVER stolen, regardless of how old the lock is. Only a holder that STOPPED
// refreshing past this grace (hung, crashed without cleanup, or a PID since
// reused by an unrelated process) is reaped. Pairing heartbeat-age with PID
// liveness is what defeats both the WAL-corruption bug (stealing a live
// writer) AND the PID-reuse false-positive (a recycled PID reading as "alive").
// Env-overridable as an incident escape hatch, matching the sync-lock knobs.
function stealGraceMs(): number {
  const env = parseInt(process.env.GBRAIN_PGLITE_LOCK_STEAL_GRACE_SECONDS ?? '', 10);
  return Number.isFinite(env) && env > 0 ? env * 1000 : 10 * 60 * 1000; // default 600s
}

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
  /**
   * #2058: heartbeat timer + lock-file path, set when a real (on-disk) lock is
   * held so `releaseLock` can stop refreshing. Absent for the in-memory engine
   * (no lock file, no concurrent access possible).
   */
  heartbeat?: ReturnType<typeof setInterval>;
  lockPath?: string;
  /**
   * #2058 (codex): our ownership token (`<pid>:<acquired_at>`). If we stall
   * past the steal grace, another process can reap + re-acquire. When we
   * resume, the heartbeat and release MUST verify the on-disk lock is STILL
   * ours before touching it — otherwise a resumed stale holder would refresh
   * or delete the NEW owner's live lock, re-opening the concurrent-writer hole.
   */
  ownerToken?: string;
}

/** The on-disk lock identity, used to detect "we were reaped and replaced". */
function tokenOf(lockData: { pid?: unknown; acquired_at?: unknown }): string {
  return `${lockData.pid}:${lockData.acquired_at}`;
}

/**
 * #2058: keep the held lock's `refreshed_at` current so a concurrent acquirer
 * can tell a live, working holder from a hung/dead one. Best-effort: if the
 * file is gone (we're being reaped) the write simply fails. `.unref()` so the
 * timer never keeps the process alive on its own. Ownership-checked: if the
 * on-disk lock is no longer ours (we were reaped past grace and replaced), stop
 * the heartbeat instead of clobbering the new owner's lock.
 */
function startHeartbeat(lockPath: string, ownerToken: string): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      const raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
      if (tokenOf(raw) !== ownerToken) {
        // We were reaped and someone else owns it now — do NOT refresh their
        // lock. Stand down.
        clearInterval(timer);
        return;
      }
      raw.refreshed_at = Date.now();
      writeFileSync(lockPath, JSON.stringify(raw), { mode: 0o644 });
    } catch { /* best-effort — file removed or transient FS error */ }
  }, HEARTBEAT_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function getLockDir(dataDir: string | undefined): string {
  // Use the parent of the data dir for the lock, or a temp location for in-memory
  if (!dataDir) {
    // In-memory PGLite — no concurrent access possible since it's process-scoped
    // Return a sentinel that we skip
    return '';
  }
  return join(dataDir, LOCK_DIR_NAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks existence without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 * Returns { acquired: true } if the lock was obtained, { acquired: false } otherwise.
 * Stale locks (from dead processes) are automatically cleaned up.
 */
export async function acquireLock(dataDir: string | undefined, opts?: { timeoutMs?: number }): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);

  // In-memory PGLite — no lock needed (process-scoped, can't be shared)
  if (!lockDir) {
    return { lockDir: '', acquired: true };
  }

  // `lockDir` being set implies `dataDir` is set (see getLockDir), but TS
  // can't derive that across helper boundaries.
  mkdirSync(dataDir as string, { recursive: true });

  const timeoutMs = opts?.timeoutMs ?? 30_000; // 30 second default timeout
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check for stale lock first
    if (existsSync(lockDir)) {
      const lockPath = join(lockDir, LOCK_FILE);
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
        const lockPid = lockData.pid as number;
        const lockTime = lockData.acquired_at as number;

        // #2058: classify by PID liveness AND heartbeat freshness. A holder
        // that is alive AND refreshed its heartbeat within the steal grace is
        // genuinely working (e.g. a multi-minute embed) and is NEVER reaped —
        // force-removing it here is what corrupted the single-writer WAL.
        const alive = isProcessAlive(lockPid);
        const lastRefresh = (lockData.refreshed_at as number | undefined) ?? lockTime;
        const sinceRefresh = Date.now() - lastRefresh;
        if (!alive) {
          // Holder process is gone — reap.
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition, try again */ }
        } else if (sinceRefresh > stealGraceMs()) {
          // PID is alive but the heartbeat stopped past the grace window:
          // either the holder hung, or this PID was reused by an unrelated
          // process (the real holder died and stopped refreshing). Reap.
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition */ }
        } else {
          // Live holder refreshing within grace — wait and retry.
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      } catch {
        // Corrupt lock file — remove it
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition */ }
      }
    }

    // Try to acquire lock (atomic mkdir)
    try {
      mkdirSync(lockDir, { recursive: false });
      // We got the lock — write our PID. #2058: seed `refreshed_at` and start
      // the heartbeat so this holder reads as alive-and-working to others.
      const lockPath = join(lockDir, LOCK_FILE);
      const now = Date.now();
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        acquired_at: now,
        refreshed_at: now,
        command: process.argv.slice(1).join(' '),
      }), { mode: 0o644 });

      const ownerToken = tokenOf({ pid: process.pid, acquired_at: now });
      return { lockDir, acquired: true, lockPath, ownerToken, heartbeat: startHeartbeat(lockPath, ownerToken) };
    } catch (e: unknown) {
      // mkdir failed — someone else grabbed it between our check and mkdir
      // This is fine, we'll retry
      if (Date.now() - startTime >= timeoutMs) {
        // Timeout — report which process holds the lock
        const lockPath = join(lockDir, LOCK_FILE);
        try {
          const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
          throw new Error(
            `GBrain: Timed out waiting for PGLite lock. Process ${lockData.pid} has held it since ${new Date(lockData.acquired_at).toISOString()} (command: ${lockData.command}). ` +
            `If that process is dead, remove ${lockDir} and try again.`
          );
        } catch (readErr) {
          if (readErr instanceof Error && readErr.message.startsWith('GBrain')) throw readErr;
          throw new Error(
            `GBrain: Timed out waiting for PGLite lock. Remove ${lockDir} and try again.`
          );
        }
      }
      // Brief wait before retry
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Should not reach here, but just in case
  throw new Error(`GBrain: Timed out waiting for PGLite lock.`);
}

/**
 * Release a previously acquired lock.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  // #2058: stop the heartbeat first so it can't recreate/rewrite the lock file
  // after we remove it.
  if (lock.heartbeat) {
    clearInterval(lock.heartbeat);
    lock.heartbeat = undefined;
  }
  if (!lock.lockDir || !lock.acquired) return;

  // #2058 (codex): only remove the lock if it is STILL ours. If we were reaped
  // past the grace and another process re-acquired, removing its live lock
  // would let a third process in alongside it — the corruption this fix exists
  // to prevent. Unreadable/absent lock falls through to a best-effort remove.
  if (lock.ownerToken) {
    try {
      const raw = JSON.parse(readFileSync(join(lock.lockDir, LOCK_FILE), 'utf-8'));
      if (tokenOf(raw) !== lock.ownerToken) return; // someone else owns it now
    } catch { /* unreadable/gone — fall through to best-effort cleanup */ }
  }

  try {
    rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    // Lock file already removed (e.g., by stale cleanup) — that's fine
  }
}
