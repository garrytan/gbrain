// v0.40.6.0 Schema Cathedral v3 — per-pack file lock primitive.
//
// `withPackLock(packName, opts, fn)` serializes concurrent mutations of
// the same pack file across processes. Two `gbrain schema add-type foo`
// invocations on the same pack are made safe: the second blocks until the
// first releases (or refuses with `LOCK_BUSY` if a timeout is set).
//
// Design (codex C8 from /plan-eng-review):
//   - Atomic acquire via `openSync(lockPath, 'wx')` — the 'wx' flag is
//     POSIX `O_CREAT | O_EXCL`, kernel-level atomic. The acquire either
//     creates the file or throws EEXIST. There is NO check-then-write
//     window. Do NOT copy `src/core/page-lock.ts:79+96`'s
//     `existsSync` + `writeFileSync` shape — that's TOCTOU.
//   - Stale-lock detection: a holder process may crash without releasing.
//     On EEXIST, read the lockfile, check `kill(pid, 0)` for liveness,
//     and check `Date.now() - ts > ttlMs`. If either is true, steal.
//   - TTL refresh: long-running DB-aware lint/stats can outlive the
//     default 60s ttl. While `fn()` runs, a background `setInterval`
//     rewrites `ts` every 10s so the lock stays fresh.
//   - `--force` semantics: "steal stale lock", NOT "skip locking". Even
//     forced acquires go through the same atomic open path — the only
//     difference is that on EEXIST + non-stale, force succeeds by
//     stealing instead of throwing.
//   - Cleanup: `try/finally` unconditionally releases. Refresh interval
//     is cleared. Lockfile is unlinked.
//
// Lock path: `~/.gbrain/schema-packs/.locks/<packName>.lock`. Per-pack
// so two different packs never block each other. Honors `GBRAIN_HOME`
// via the shared `gbrainPath()` helper.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gbrainPath } from '../config.ts';

export const DEFAULT_LOCK_TTL_MS = 60_000;
export const REFRESH_INTERVAL_MS = 10_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 0; // 0 = fail-immediately on EEXIST

export type LockOutcome = 'acquired' | 'stolen_stale' | 'forced';

export interface PackLockOpts {
  /** TTL in ms before another acquirer considers the lock stale. Default 60s. */
  ttlMs?: number;
  /** Steal the lock even if non-stale + live PID. Default false. */
  force?: boolean;
  /** Override the lock directory for tests. */
  lockDir?: string;
  /**
   * Inject a clock for tests (returns ms since epoch).
   * Production callers leave undefined.
   */
  now?: () => number;
  /**
   * Inject a PID-liveness probe for tests. Returns true if the PID is alive.
   * Production callers leave undefined (defaults to `kill(pid, 0)`).
   */
  isPidAlive?: (pid: number) => boolean;
}

export interface LockFileRecord {
  /** Holder process PID. */
  pid: number;
  /** Holder hostname (informational only). */
  hostname: string;
  /** Last refresh timestamp (ms since epoch). */
  ts: number;
  /** Holder's declared TTL in ms. */
  ttlMs: number;
}

export class PackLockBusyError extends Error {
  readonly code = 'LOCK_BUSY' as const;
  readonly heldBy: number;
  readonly ageMs: number;
  readonly ttlMs: number;
  constructor(message: string, opts: { heldBy: number; ageMs: number; ttlMs: number }) {
    super(message);
    this.name = 'PackLockBusyError';
    this.heldBy = opts.heldBy;
    this.ageMs = opts.ageMs;
    this.ttlMs = opts.ttlMs;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver, but throws ESRCH if the process is dead.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission to signal.
    return code === 'EPERM';
  }
}

function resolveLockPath(packName: string, lockDir?: string): string {
  const dir = lockDir ?? gbrainPath('schema-packs', '.locks');
  return join(dir, `${packName}.lock`);
}

function readLockFile(path: string): LockFileRecord | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LockFileRecord>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.ts === 'number' &&
      typeof parsed.ttlMs === 'number' &&
      typeof parsed.hostname === 'string'
    ) {
      return parsed as LockFileRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function writeLockRecord(path: string, fd: number, record: LockFileRecord): void {
  // We hold an open fd from the atomic create; truncate-and-write via fd.
  // Bun's fs.writeFileSync(path, ...) when the file exists is fine here
  // because we already own the lock (exclusive create succeeded).
  writeFileSync(path, JSON.stringify(record), 'utf-8');
  // Keep the fd open until release so file is held by this process; some
  // FS layers prefer this for crash detection. (Functionally a no-op on
  // POSIX where unlink() works regardless.)
  closeSync(fd);
}

/**
 * Try to atomically acquire the lock. Returns the descriptor on success;
 * throws on EEXIST (caller decides whether to steal). Handles ENOENT on
 * the parent dir by creating it once.
 */
function atomicAcquire(lockPath: string): number {
  try {
    return openSync(lockPath, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      mkdirSync(dirname(lockPath), { recursive: true });
      return openSync(lockPath, 'wx');
    }
    throw err;
  }
}

/**
 * Decide whether a held lock is stale based on TTL + PID liveness.
 * Exported for unit testing the policy in isolation.
 */
export function isLockStale(
  record: LockFileRecord,
  now: number,
  isPidAlive: (pid: number) => boolean,
): { stale: boolean; reason: 'ttl_expired' | 'pid_dead' | 'live' } {
  const ageMs = now - record.ts;
  if (ageMs > record.ttlMs) return { stale: true, reason: 'ttl_expired' };
  if (!isPidAlive(record.pid)) return { stale: true, reason: 'pid_dead' };
  return { stale: false, reason: 'live' };
}

/**
 * Acquire the lock OR throw `PackLockBusyError`. Steals stale locks
 * (per TTL + PID liveness) or when `opts.force` is set. Returns the
 * outcome so callers can audit how the acquire resolved.
 */
export function acquirePackLock(
  packName: string,
  opts: PackLockOpts = {},
): { lockPath: string; outcome: LockOutcome; record: LockFileRecord } {
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const now = opts.now ?? Date.now;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const lockPath = resolveLockPath(packName, opts.lockDir);

  const tryOnce = (): number | 'EEXIST' => {
    try {
      return atomicAcquire(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'EEXIST';
      throw err;
    }
  };

  const writeNew = (fd: number, outcome: LockOutcome): { lockPath: string; outcome: LockOutcome; record: LockFileRecord } => {
    const record: LockFileRecord = {
      pid: process.pid,
      hostname: process.env.HOSTNAME ?? 'unknown',
      ts: now(),
      ttlMs,
    };
    writeLockRecord(lockPath, fd, record);
    return { lockPath, outcome, record };
  };

  // First attempt: clean acquire.
  const first = tryOnce();
  if (first !== 'EEXIST') return writeNew(first, 'acquired');

  // EEXIST: inspect.
  const existing = readLockFile(lockPath);
  if (existing === null) {
    // Lockfile is corrupt — treat as stale and steal.
    try { unlinkSync(lockPath); } catch { /* race with another stealer; retry below */ }
    const retry = tryOnce();
    if (retry === 'EEXIST') {
      throw new PackLockBusyError(
        `pack ${packName} lock is corrupt and another process re-acquired it during recovery`,
        { heldBy: -1, ageMs: 0, ttlMs },
      );
    }
    return writeNew(retry, 'stolen_stale');
  }

  const staleness = isLockStale(existing, now(), isPidAlive);
  if (staleness.stale || opts.force) {
    try { unlinkSync(lockPath); } catch { /* race with another stealer; retry below */ }
    const retry = tryOnce();
    if (retry === 'EEXIST') {
      // Another stealer won. Surface as busy with the current holder.
      const current = readLockFile(lockPath);
      const ageMs = current ? now() - current.ts : 0;
      throw new PackLockBusyError(
        `pack ${packName} lock was stolen by another process during our recovery (pid=${current?.pid ?? '?'})`,
        { heldBy: current?.pid ?? -1, ageMs, ttlMs: current?.ttlMs ?? ttlMs },
      );
    }
    return writeNew(retry, opts.force ? 'forced' : 'stolen_stale');
  }

  // Live and non-stale: refuse.
  throw new PackLockBusyError(
    `pack ${packName} is locked by pid=${existing.pid} (held ${Math.round((now() - existing.ts) / 1000)}s, ttl=${Math.round(existing.ttlMs / 1000)}s; --force to steal)`,
    { heldBy: existing.pid, ageMs: now() - existing.ts, ttlMs: existing.ttlMs },
  );
}

/**
 * Refresh the lock's `ts` field so long-running operations don't appear
 * stale to a concurrent acquirer. Best-effort: write failures are
 * swallowed silently. Returns true on success, false if the lockfile is
 * gone (we lost the lock).
 */
function refreshLock(lockPath: string, record: LockFileRecord, now: number): boolean {
  try {
    const next: LockFileRecord = { ...record, ts: now };
    writeFileSync(lockPath, JSON.stringify(next), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the lock by unlinking the file. Idempotent — missing file is
 * not an error (the holder may have crashed and another process stole).
 */
function releasePackLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Don't throw from a finally path — log to stderr and move on.
      process.stderr.write(`[pack-lock] release failed for ${lockPath}: ${(err as Error).message}\n`);
    }
  }
}

/**
 * Run `fn()` with exclusive access to `packName`. Acquires the lock,
 * starts a TTL refresh timer, runs `fn`, then unconditionally releases.
 *
 * Throws `PackLockBusyError` if the lock is held by a live process and
 * neither stale nor forced.
 */
export async function withPackLock<T>(
  packName: string,
  opts: PackLockOpts,
  fn: () => Promise<T> | T,
): Promise<T> {
  const acquired = acquirePackLock(packName, opts);
  const now = opts.now ?? Date.now;
  let currentRecord = acquired.record;
  const refresh = setInterval(() => {
    currentRecord = { ...currentRecord, ts: now() };
    refreshLock(acquired.lockPath, currentRecord, now());
  }, REFRESH_INTERVAL_MS);
  // Don't keep the process alive just for the refresh timer.
  if (typeof (refresh as NodeJS.Timer).unref === 'function') (refresh as NodeJS.Timer).unref();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    releasePackLock(acquired.lockPath);
  }
}
