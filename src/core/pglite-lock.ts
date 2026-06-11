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

import { randomBytes } from 'crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, renameSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';

const LOCK_DIR_NAME = '.gbrain-lock';
const LOCK_FILE = 'lock';
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes — embed jobs can be long
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const INIT_GRACE_MS = 1000;
const DEAD_PID_GRACE_MS = 60 * 1000;
const WAIT_RETRY_MS = 50;

type ProcessState = 'alive' | 'dead' | 'unknown';

interface LockRecord {
  pid: number;
  acquired_at: number;
  command?: string;
  owner_id?: string;
  host?: string;
  last_refreshed_at?: number;
}

interface AcquireLockOpts {
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
  staleThresholdMs?: number;
  initGraceMs?: number;
  deadPidGraceMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => ProcessState;
  host?: string;
}

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
  ownerId?: string;
  pid?: number;
  host?: string;
  heartbeat?: ReturnType<typeof setInterval>;
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

function defaultProcessState(pid: number): ProcessState {
  try {
    // Sending signal 0 checks existence without actually sending a signal
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    // EPERM means the process exists but this user cannot signal it.
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function ownerId(): string {
  return `${process.pid}-${randomBytes(8).toString('hex')}`;
}

function lockPath(lockDir: string): string {
  return join(lockDir, LOCK_FILE);
}

function readLockRecord(lockDir: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(lockDir), 'utf-8')) as Partial<LockRecord>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.acquired_at === 'number' &&
      (parsed.owner_id === undefined || typeof parsed.owner_id === 'string') &&
      (parsed.host === undefined || typeof parsed.host === 'string') &&
      (parsed.last_refreshed_at === undefined || typeof parsed.last_refreshed_at === 'number') &&
      (parsed.command === undefined || typeof parsed.command === 'string')
    ) {
      return parsed as LockRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function writeLockRecordAtomic(lockDir: string, record: LockRecord): void {
  const tempPath = join(lockDir, `${LOCK_FILE}.${process.pid}.${record.owner_id ?? 'unknown'}.tmp`);
  writeFileSync(tempPath, JSON.stringify(record), { mode: 0o644 });
  renameSync(tempPath, lockPath(lockDir));
}

function sameOwner(record: LockRecord | null, lock: LockHandle): boolean {
  return !!(
    record &&
    lock.ownerId &&
    record.owner_id === lock.ownerId &&
    record.pid === lock.pid &&
    record.host === lock.host
  );
}

function lockDirAgeMs(lockDir: string, now: number): number {
  try {
    return Math.max(0, now - statSync(lockDir).mtimeMs);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function quarantineAndRemoveLockDir(lockDir: string): void {
  const quarantineDir = `${lockDir}.reap.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lockDir, quarantineDir);
  } catch {
    // Missing or raced with another waiter; retry the acquire loop.
    return;
  }
  try {
    rmSync(quarantineDir, { recursive: true, force: true });
  } catch {
    // A quarantine directory is no longer an active lock; best-effort cleanup.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeHolder(record: LockRecord | null, now: number): string {
  if (!record) return 'metadata is missing or corrupt';
  const refreshed = record.last_refreshed_at ?? record.acquired_at;
  const refreshedAge = Math.max(0, now - refreshed);
  const parts = [
    `pid ${record.pid}`,
    `host ${record.host ?? 'unknown'}`,
    `held since ${new Date(record.acquired_at).toISOString()}`,
    `last refreshed ${Math.round(refreshedAge / 1000)}s ago`,
  ];
  if (record.command) parts.push(`command: ${record.command}`);
  return parts.join(', ');
}

function refreshLock(lock: LockHandle, now: () => number): boolean {
  if (!lock.lockDir || !lock.acquired) return false;
  const current = readLockRecord(lock.lockDir);
  if (!current || !sameOwner(current, lock)) return false;
  writeLockRecordAtomic(lock.lockDir, {
    ...current,
    last_refreshed_at: now(),
  });
  return true;
}

function startHeartbeat(lock: LockHandle, intervalMs: number, now: () => number): ReturnType<typeof setInterval> | undefined {
  if (!lock.lockDir || !lock.acquired || intervalMs <= 0) return undefined;
  let timer: ReturnType<typeof setInterval>;
  timer = setInterval(() => {
    try {
      if (!refreshLock(lock, now)) clearInterval(timer);
    } catch {
      // The heartbeat is best-effort; the next waiter will fail closed unless
      // the holder is provably dead.
    }
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 * Returns { acquired: true } if the lock was obtained, { acquired: false } otherwise.
 * Stale locks (from dead processes) are automatically cleaned up.
 */
export async function acquireLock(dataDir: string | undefined, opts: AcquireLockOpts = {}): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);

  // In-memory PGLite — no lock needed (process-scoped, can't be shared)
  if (!lockDir) {
    return { lockDir: '', acquired: true };
  }

  // `lockDir` being set implies `dataDir` is set (see getLockDir), but TS
  // can't derive that across helper boundaries.
  mkdirSync(dataDir as string, { recursive: true });

  const timeoutMs = opts.timeoutMs ?? 30_000; // 30 second default timeout
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const staleThresholdMs = opts.staleThresholdMs ?? STALE_THRESHOLD_MS;
  const initGraceMs = opts.initGraceMs ?? INIT_GRACE_MS;
  const deadPidGraceMs = opts.deadPidGraceMs ?? DEAD_PID_GRACE_MS;
  const now = opts.now ?? Date.now;
  const host = opts.host ?? hostname();
  const processState = opts.isProcessAlive ?? defaultProcessState;
  const startTime = Date.now();
  let lastSeen: LockRecord | null = null;

  while (Date.now() - startTime < timeoutMs) {
    if (existsSync(lockDir)) {
      const record = readLockRecord(lockDir);
      lastSeen = record;
      const currentNow = now();

      if (!record) {
        if (lockDirAgeMs(lockDir, currentNow) >= initGraceMs) {
          quarantineAndRemoveLockDir(lockDir);
          continue;
        }
        await wait(Math.min(WAIT_RETRY_MS, Math.max(1, timeoutMs - (Date.now() - startTime))));
        continue;
      }

      const sameHost = !record.host || record.host === host;
      const holderState = sameHost ? processState(record.pid) : 'alive';
      const deadEligible = holderState === 'dead' && currentNow - record.acquired_at >= deadPidGraceMs;

      if (deadEligible) {
        quarantineAndRemoveLockDir(lockDir);
        continue;
      }

      // A stale heartbeat is diagnostic only for PGLite. A live process may
      // still have the embedded database open even if its JS timer is starved.
      const lastRefreshedAt = record.last_refreshed_at ?? record.acquired_at;
      if (currentNow - lastRefreshedAt > staleThresholdMs) lastSeen = record;
      await wait(Math.min(WAIT_RETRY_MS, Math.max(1, timeoutMs - (Date.now() - startTime))));
      continue;
    }

    // Try to acquire lock (atomic mkdir)
    try {
      mkdirSync(lockDir, { recursive: false });
      const id = ownerId();
      const acquiredAt = now();
      const lock: LockHandle = {
        lockDir,
        acquired: true,
        ownerId: id,
        pid: process.pid,
        host,
      };
      writeLockRecordAtomic(lockDir, {
        pid: process.pid,
        host,
        owner_id: id,
        acquired_at: acquiredAt,
        last_refreshed_at: acquiredAt,
        command: process.argv.slice(1).join(' '),
      });
      lock.heartbeat = startHeartbeat(lock, heartbeatIntervalMs, now);

      return lock;
    } catch (e: unknown) {
      // mkdir failed — someone else grabbed it between our check and mkdir
      // This is fine, we'll retry
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(
          `GBrain: Timed out waiting for PGLite lock (${describeHolder(readLockRecord(lockDir) ?? lastSeen, now())}). ` +
          `If that process is dead, remove ${lockDir} and try again.`
        );
      }
      // Brief wait before retry
      await wait(Math.min(WAIT_RETRY_MS, Math.max(1, timeoutMs - (Date.now() - startTime))));
    }
  }

  // Should not reach here, but just in case
  throw new Error(
    `GBrain: Timed out waiting for PGLite lock (${describeHolder(readLockRecord(lockDir) ?? lastSeen, now())}). ` +
    `If that process is dead, remove ${lockDir} and try again.`
  );
}

/**
 * Release a previously acquired lock.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  if (!lock.lockDir || !lock.acquired) return;
  if (lock.heartbeat) clearInterval(lock.heartbeat);

  try {
    const current = readLockRecord(lock.lockDir);
    if (!sameOwner(current, lock)) return;
    quarantineAndRemoveLockDir(lock.lockDir);
  } catch {
    // Lock file already removed (e.g., by stale cleanup) — that's fine.
  }
}
