// v0.40.6.0 Schema Cathedral v3 — per-pack file lock primitive.
//
// `withPackLock(packName, opts, fn)` serializes concurrent mutations of
// the same pack file across processes. Two `gbrain schema add-type foo`
// invocations on the same pack are made safe: the second blocks until the
// first releases (or refuses with `LOCK_BUSY` if a timeout is set).
//
// Design (codex C8 from /plan-eng-review):
//   - Atomic acquire: the record is written to a private temp file, then
//     hard-linked to the lock path (`linkSync`, which fails with EEXIST when
//     the lock exists). The lock file therefore never exists without its
//     complete record, so a contender can never read an empty file and take
//     it over as corrupt. A filesystem without hard links falls back to
//     `openSync(lockPath, 'wx')` (POSIX `O_CREAT | O_EXCL`). Do NOT copy
//     `src/core/page-lock.ts:79+96`'s `existsSync` + `writeFileSync` shape —
//     that's TOCTOU.
//   - Stale-lock detection: a holder process may crash without releasing.
//     On EEXIST, read the lockfile, check `kill(pid, 0)` for liveness,
//     and check `Date.now() - ts > ttlMs`. If either is true, steal.
//   - TTL refresh: long-running DB-aware lint/stats can outlive the
//     default 60s ttl. While `fn()` runs, a background `setInterval`
//     rewrites `ts` every 10s so the lock stays fresh. The rewrite goes to a
//     temp file renamed over the lock, never a truncating in-place write, and
//     only while the lock still holds this holder's token.
//   - `--force` semantics: "steal stale lock", NOT "skip locking". Even
//     forced acquires go through the same atomic open path — the only
//     difference is that on EEXIST + non-stale, force succeeds by
//     stealing instead of throwing.
//   - Cleanup: `try/finally` unconditionally releases. Refresh interval
//     is cleared. Lockfile is unlinked only while it still holds this
//     holder's token, so a holder that lost its lock never removes the new
//     holder's.
//
// Lock path: `~/.gbrain/schema-packs/.locks/<packName>.lock`. Per-pack
// so two different packs never block each other. Honors `GBRAIN_HOME`
// via the shared `gbrainPath()` helper.

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
  /** Random per-acquire token; refresh and release act only on a lock that still carries it. */
  token?: string;
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

function tempPathFor(lockPath: string): string {
  return `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
}

/** Errors from `linkSync` that mean this filesystem has no hard links, not that the lock exists. */
const NO_HARD_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/**
 * Create the lock file holding `record`, or throw EEXIST when it exists. The record is written to a temp file and
 * hard-linked to the lock path, so the lock never exists half-written. Without hard links it falls back to an
 * exclusive create followed by a write.
 */
function createLockFile(lockPath: string, record: LockFileRecord): void {
  const text = JSON.stringify(record);
  const tmp = tempPathFor(lockPath);
  try {
    writeFileSync(tmp, text, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(tmp, text, { encoding: 'utf-8', flag: 'wx' });
  }
  try {
    linkSync(tmp, lockPath);
  } catch (err) {
    if (!NO_HARD_LINK_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, text, 'utf-8');
    } finally {
      closeSync(fd);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** True when the lock file still carries `record`'s token (a record without a token matches on pid + hostname). */
function stillHolds(lockPath: string, record: LockFileRecord): boolean {
  const current = readLockFile(lockPath);
  if (!current) return false;
  if (record.token !== undefined || current.token !== undefined) return current.token === record.token;
  return current.pid === record.pid && current.hostname === record.hostname;
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

  const tryOnce = (): LockFileRecord | 'EEXIST' => {
    const record: LockFileRecord = {
      pid: process.pid,
      hostname: process.env.HOSTNAME ?? 'unknown',
      ts: now(),
      ttlMs,
      token: randomUUID(),
    };
    try {
      createLockFile(lockPath, record);
      return record;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'EEXIST';
      throw err;
    }
  };

  const writeNew = (record: LockFileRecord, outcome: LockOutcome): { lockPath: string; outcome: LockOutcome; record: LockFileRecord } =>
    ({ lockPath, outcome, record });

  // First attempt: clean acquire.
  const first = tryOnce();
  if (first !== 'EEXIST') return writeNew(first, 'acquired');

  // EEXIST: inspect.
  const existing = readLockFile(lockPath);
  if (existing === null && !existsSync(lockPath)) {
    // The holder released between our create and our read: a clean acquire, and nothing to unlink (unlinking here
    // could remove a lock a third process just created).
    const retry = tryOnce();
    if (retry === 'EEXIST') {
      const current = readLockFile(lockPath);
      throw new PackLockBusyError(
        `pack ${packName} lock was released and re-acquired by another process (pid=${current?.pid ?? '?'})`,
        { heldBy: current?.pid ?? -1, ageMs: current ? now() - current.ts : 0, ttlMs: current?.ttlMs ?? ttlMs },
      );
    }
    return writeNew(retry, 'acquired');
  }
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
 * stale to a concurrent acquirer. The new record goes to a temp file renamed
 * over the lock, so the lock file is never empty or half-written. Best-effort:
 * write failures are swallowed. Returns true on success, false if the lock is
 * gone or now holds another holder's token (we lost the lock), in which case
 * nothing is written.
 */
export function refreshPackLock(lockPath: string, record: LockFileRecord, now: number): boolean {
  if (!stillHolds(lockPath, record)) return false;
  const tmp = tempPathFor(lockPath);
  try {
    const next: LockFileRecord = { ...record, ts: now };
    writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf-8', flag: 'wx' });
    renameSync(tmp, lockPath);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    return false;
  }
}

/**
 * Release the lock by unlinking the file, only while it still holds this
 * holder's token. Idempotent — a missing file, or one another process took
 * over, is not an error and is left alone.
 */
function releasePackLock(lockPath: string, record: LockFileRecord): void {
  if (!stillHolds(lockPath, record)) return;
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
    refreshPackLock(acquired.lockPath, currentRecord, now());
  }, REFRESH_INTERVAL_MS);
  // Don't keep the process alive just for the refresh timer.
  if (typeof (refresh as NodeJS.Timer).unref === 'function') (refresh as NodeJS.Timer).unref();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    releasePackLock(acquired.lockPath, acquired.record);
  }
}
