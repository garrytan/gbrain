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

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const LOCK_DIR_NAME = '.gbrain-lock';
const LOCK_FILE = 'lock';
// IMPORTANT: do not expire locks by age alone.
// Long-running operations (embed/import/autopilot cycles) can legitimately hold
// the lock for many minutes. Age-based eviction can create two live writers and
// corrupt the data directory.

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
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

function getProcessStartMs(pid: number): number | null {
  const safePid = Number.isInteger(pid) && pid > 0 ? String(pid) : null;
  if (!safePid) return null;
  const res = spawnSync('ps', ['-o', 'etimes=', '-p', safePid], { encoding: 'utf-8' });
  if (res.status !== 0) return null;
  const elapsedSec = Number.parseInt(res.stdout.trim(), 10);
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return null;
  return Date.now() - elapsedSec * 1000;
}

function isLikelySameProcess(pid: number, acquiredAtMs: number): boolean {
  if (!Number.isFinite(acquiredAtMs) || acquiredAtMs <= 0) return true;
  const startedAtMs = getProcessStartMs(pid);
  // If we cannot verify start time, fail closed: keep waiting rather than
  // risk deleting a lock owned by a live writer.
  if (startedAtMs == null) return true;
  // If the current PID appears to have started after the lock was acquired,
  // this is likely PID reuse (old owner died; PID got recycled).
  const SKEW_MS = 2_000;
  return startedAtMs <= acquiredAtMs + SKEW_MS;
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

        // Is the locking process still alive?
        if (!isProcessAlive(lockPid)) {
          // Stale lock — clean it up
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition, try again */ }
        } else if (!isLikelySameProcess(lockPid, lockTime)) {
          // PID is alive but appears to have been reassigned since lock creation.
          // Treat as stale lock from a dead owner.
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition */ }
        } else {
          // Lock is held by a live process — wait and retry.
          // Never evict by age alone: long-running jobs are valid and age-based
          // eviction can create concurrent writers.
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
      // We got the lock — write our PID
      const lockPath = join(lockDir, LOCK_FILE);
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        acquired_at: Date.now(),
        command: process.argv.slice(1).join(' '),
      }), { mode: 0o644 });

      return { lockDir, acquired: true };
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
  if (!lock.lockDir || !lock.acquired) return;

  try {
    rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    // Lock file already removed (e.g., by stale cleanup) — that's fine
  }
}
