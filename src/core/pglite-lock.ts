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
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes — embed jobs can be long

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

  mkdirSync(dataDir, { recursive: true });

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
        } else if (Date.now() - lockTime > STALE_THRESHOLD_MS) {
          // Lock held for too long — assume stale (e.g., process hung)
          // Still alive but probably stuck — force remove
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition */ }
        } else {
          // Lock is held by a live process — wait and retry
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
