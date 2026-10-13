/**
 * PGLite File Lock — exclusive single-owner advisory lock for a data directory.
 *
 * PGLite (embedded Postgres/WASM) supports only one process per data directory.
 * This module uses atomic `mkdir` (O_EXCL semantics) plus rich lock metadata so
 * Windows PID reuse, reboot-stale locks, and corrupt metadata can be distinguished
 * from a truly live owner.
 *
 * Usage:
 *   const lock = await acquireLock(dataDir);
 *   try { ... } finally { await releaseLock(lock); }
 *
 * Ownership rules (never use lock age alone to steal):
 * 1. No lock → create.
 * 2. Corrupt metadata → archive, then compete again.
 * 3. Different bootMarker → previous boot residue → archive.
 * 4. PID gone → residue → archive.
 * 5. PID alive but processStartTime mismatch → PID reuse → archive.
 * 6. PID alive but executable is not a PMBrain owner → reuse/mismatch → archive.
 * 7. PID + startTime + token identity of a live PMBrain process → refuse.
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  lstatSync,
  rmSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { parseGlobalFlags } from './cli-options.ts';
import {
  createDefaultProcessInspector,
  looksLikePmbrainExecutable,
  type ProcessInspector,
} from './pglite-process-inspector.ts';
import { DatabaseAlreadyOwnedError, PgliteLockMetadataError } from './pglite-errors.ts';
import { createPgliteDatabaseDirectory } from './pmbrain-adapters/pglite-database-path.ts';

const LOCK_DIR_NAME = '.gbrain-lock';
const LOCK_FILE = 'lock';
const LOCK_SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COMPETE_ATTEMPTS = 8;
const RETRY_WAIT_MS = 500;
export const LOCK_ARCHIVE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const LOCK_ARCHIVE_KEEP_NEWEST = 5;
const ARCHIVE_STAMP_RE =
  /^\.gbrain-lock\.(?:released|stale)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-|$)/;

export type LockOwnerType =
  | 'desktop-sidecar'
  | 'cli'
  | 'probe'
  | 'migration'
  | 'test'
  | 'unknown';

export interface LockMetadataV2 {
  schemaVersion: 2;
  pid: number;
  processStartTime: string | null;
  bootMarker: string;
  ownerToken: string;
  ownerType: LockOwnerType;
  databasePath: string;
  executablePath: string | null;
  command?: string;
  /** Parsed top-level CLI command, retained so `search serve` is not mistaken for a server owner. */
  subcommand?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Legacy field kept for older readers / diagnostics. */
  acquired_at?: number;
}

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
  reaped?: boolean;
  ownerToken?: string;
  metadata?: LockMetadataV2;
  diagnostics?: LockDiagnostics;
}

export function previousOwnerConfirmedDeadFromLock(
  lock: Pick<LockHandle, 'reaped' | 'diagnostics'> | null | undefined,
): boolean {
  if (!lock?.reaped) return false;
  const reason = lock.diagnostics?.reason ?? '';
  return reason === 'after_pid_not_running' || reason === 'after_previous_system_boot';
}

export type LockDecision =
  | 'acquire_new'
  | 'archive_stale_lock'
  | 'reject_active_owner'
  | 'retry_race'
  | 'skip_in_memory';

export interface LockDiagnostics {
  databasePath: string;
  lockPath: string;
  lockExists: boolean;
  lockMetadata: Partial<LockMetadataV2> | null;
  currentBootMarker: string;
  lockBootMarkerMatches: boolean | null;
  pidExists: boolean | null;
  processStartMatches: boolean | null;
  executableMatches: boolean | null;
  decision: LockDecision;
  reason: string;
  archivedTo?: string;
}

export interface AcquireLockOptions {
  timeoutMs?: number;
  ownerType?: LockOwnerType;
  inspector?: ProcessInspector;
  /** When true, throw immediately if a live owner is detected (no wait). */
  failFastIfOwned?: boolean;
  /** Optional command/argv summary for diagnostics (never secrets). */
  command?: string;
}

let defaultInspector: ProcessInspector | null = null;

export function setDefaultProcessInspector(inspector: ProcessInspector | null): void {
  defaultInspector = inspector;
}

function resolveInspector(inspector?: ProcessInspector): ProcessInspector {
  return inspector ?? defaultInspector ?? createDefaultProcessInspector();
}

function getLockDir(dataDir: string | undefined): string {
  if (!dataDir) return '';
  return join(dataDir, LOCK_DIR_NAME);
}

function lockFilePath(lockDir: string): string {
  return join(lockDir, LOCK_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatArchiveStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function archiveStampMs(dataDir: string, name: string): number | null {
  const match = name.match(ARCHIVE_STAMP_RE);
  if (match) {
    const stamp = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ).getTime();
    if (Number.isFinite(stamp)) return stamp;
  }
  try {
    return statSync(join(dataDir, name)).mtimeMs;
  } catch {
    return null;
  }
}

function isLockArchiveName(name: string): boolean {
  return name.startsWith(`${LOCK_DIR_NAME}.stale-`) || name.startsWith(`${LOCK_DIR_NAME}.released-`);
}

export function pruneArchivedLocks(
  dataDir: string,
  nowMs = Date.now(),
): { kept: string[]; deleted: string[] } {
  const kept: string[] = [];
  const deleted: string[] = [];
  if (!dataDir) return { kept, deleted };
  let names: string[];
  try {
    names = readdirSync(dataDir).filter(isLockArchiveName);
  } catch {
    return { kept, deleted };
  }

  const ranked = names
    .map((name) => ({ name, stamp: archiveStampMs(dataDir, name) }))
    .sort((a, b) => (b.stamp ?? 0) - (a.stamp ?? 0));
  const newest = new Set(ranked.slice(0, LOCK_ARCHIVE_KEEP_NEWEST).map((item) => item.name));

  for (const { name, stamp } of ranked) {
    const full = join(dataDir, name);
    try {
      const info = lstatSync(full);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        kept.push(full);
        continue;
      }
    } catch {
      continue;
    }
    const age = stamp == null ? null : nowMs - stamp;
    const keep = newest.has(name) || age == null || age < LOCK_ARCHIVE_RETENTION_MS;
    if (keep) {
      kept.push(full);
      continue;
    }
    try {
      rmSync(full, { recursive: true, force: true });
      deleted.push(full);
    } catch {
      kept.push(full);
    }
  }
  return { kept, deleted };
}

function redactPath(pathValue: string): string {
  // Keep basename context; collapse long user-home prefixes for logs.
  return pathValue
    .replace(/\\/g, '/')
    .replace(/\/Users\/[^/]+/gi, '/Users/<user>')
    .replace(/\/home\/[^/]+/gi, '/home/<user>')
    .replace(/\/[A-Za-z]:\/Users\/[^/]+/gi, '/<drive>/Users/<user>')
    .replace(/[A-Za-z]:\/Users\/[^/]+/gi, '<drive>/Users/<user>');
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeMetadata(raw: unknown, databasePath: string): Partial<LockMetadataV2> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const pid = typeof obj.pid === 'number' ? obj.pid : Number(obj.pid);
  if (!Number.isFinite(pid)) return null;

  const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1;
  const createdAt = typeof obj.createdAt === 'string'
    ? obj.createdAt
    : typeof obj.acquired_at === 'number'
      ? new Date(obj.acquired_at).toISOString()
      : null;

  return {
    schemaVersion: schemaVersion === 2 ? 2 : (schemaVersion as 2),
    pid,
    processStartTime: typeof obj.processStartTime === 'string' ? obj.processStartTime : null,
    bootMarker: typeof obj.bootMarker === 'string' ? obj.bootMarker : '',
    ownerToken: typeof obj.ownerToken === 'string' ? obj.ownerToken : '',
    ownerType: (typeof obj.ownerType === 'string' ? obj.ownerType : 'unknown') as LockOwnerType,
    databasePath: typeof obj.databasePath === 'string' ? obj.databasePath : databasePath,
    executablePath: typeof obj.executablePath === 'string' ? obj.executablePath : null,
    command: typeof obj.command === 'string' ? obj.command : undefined,
    subcommand: typeof obj.subcommand === 'string' ? obj.subcommand : null,
    createdAt: createdAt ?? nowIso(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : createdAt ?? nowIso(),
    acquired_at: typeof obj.acquired_at === 'number' ? obj.acquired_at : undefined,
  };
}

function reapMarkerPath(dataDir: string): string {
  return `${dataDir}.lock-reap.json`;
}

function recordReap(dataDir: string): void {
  try {
    writeFileSync(reapMarkerPath(dataDir), JSON.stringify({ ts: Date.now(), by: process.pid }), { mode: 0o644 });
  } catch { /* best-effort */ }
}

export function clearReapMarker(dataDir: string): void {
  try {
    const marker = reapMarkerPath(dataDir);
    if (existsSync(marker)) rmSync(marker);
  } catch { /* best-effort */ }
}

export function msSinceLastReap(dataDir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(reapMarkerPath(dataDir), 'utf-8')) as { ts?: unknown };
    return typeof parsed.ts === 'number' ? Date.now() - parsed.ts : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Upstream GBrain rejects contenders immediately while `gbrain serve` owns
 * PGLite. A queued process could otherwise acquire the database during a
 * deliberate Sidecar-to-maintenance handoff and block both the maintenance
 * child and the Sidecar reconnect.
 */
function isLongLivedServeOwner(metadata: Partial<LockMetadataV2> | null): boolean {
  if (!metadata) return false;
  if (typeof metadata.subcommand === 'string') return metadata.subcommand === 'serve';

  // Backward compatibility for locks created before subcommand was recorded.
  if (metadata.ownerType === 'desktop-sidecar') return true;
  const command = metadata.command?.trim();
  if (!command) return false;
  return /^(?:serve)(?:\s|$)/i.test(command)
    || /(?:cli\.ts|pmbrain-sidecar\.js)\s+serve(?:\s|$)/i.test(command);
}

async function evaluateExistingLock(
  dataDir: string,
  lockDir: string,
  inspector: ProcessInspector,
): Promise<{ decision: 'active' | 'stale' | 'corrupt'; reason: string; metadata: Partial<LockMetadataV2> | null; diagnostics: LockDiagnostics }> {
  const lockPath = lockFilePath(lockDir);
  const currentBootMarker = await inspector.getBootMarker();
  const baseDiag: LockDiagnostics = {
    databasePath: redactPath(dataDir),
    lockPath: redactPath(lockPath),
    lockExists: existsSync(lockDir),
    lockMetadata: null,
    currentBootMarker,
    lockBootMarkerMatches: null,
    pidExists: null,
    processStartMatches: null,
    executableMatches: null,
    decision: 'retry_race',
    reason: 'unknown',
  };

  if (!existsSync(lockPath)) {
    // Empty lock dir (race during write) — treat as corrupt residue.
    return {
      decision: 'corrupt',
      reason: 'missing_lock_file',
      metadata: null,
      diagnostics: { ...baseDiag, decision: 'archive_stale_lock', reason: 'missing_lock_file' },
    };
  }

  let rawText: string;
  try {
    rawText = readFileSync(lockPath, 'utf-8');
  } catch {
    return {
      decision: 'corrupt',
      reason: 'unreadable_lock_file',
      metadata: null,
      diagnostics: { ...baseDiag, decision: 'archive_stale_lock', reason: 'unreadable_lock_file' },
    };
  }

  const parsed = safeJsonParse(rawText);
  const metadata = normalizeMetadata(parsed, dataDir);
  if (!metadata || !Number.isFinite(metadata.pid)) {
    return {
      decision: 'corrupt',
      reason: 'corrupt_lock_metadata',
      metadata: null,
      diagnostics: { ...baseDiag, decision: 'archive_stale_lock', reason: 'corrupt_lock_metadata' },
    };
  }

  baseDiag.lockMetadata = {
    pid: metadata.pid,
    ownerType: metadata.ownerType,
    createdAt: metadata.createdAt,
    bootMarker: metadata.bootMarker,
    processStartTime: metadata.processStartTime,
    executablePath: metadata.executablePath ? redactPath(metadata.executablePath) : null,
    ownerToken: metadata.ownerToken ? '<redacted>' as unknown as string : '',
  };

  if (metadata.bootMarker && metadata.bootMarker !== currentBootMarker) {
    return {
      decision: 'stale',
      reason: 'previous_system_boot',
      metadata,
      diagnostics: {
        ...baseDiag,
        lockBootMarkerMatches: false,
        decision: 'archive_stale_lock',
        reason: 'previous_system_boot',
      },
    };
  }
  if (metadata.bootMarker) {
    baseDiag.lockBootMarkerMatches = true;
  }

  const pid = metadata.pid as number;
  const pidExists = await inspector.exists(pid);
  baseDiag.pidExists = pidExists;
  if (!pidExists) {
    return {
      decision: 'stale',
      reason: 'pid_not_running',
      metadata,
      diagnostics: { ...baseDiag, decision: 'archive_stale_lock', reason: 'pid_not_running' },
    };
  }

  const liveStart = await inspector.getStartTime(pid);
  if (metadata.processStartTime && liveStart && metadata.processStartTime !== liveStart) {
    return {
      decision: 'stale',
      reason: 'pid_reused_start_time_mismatch',
      metadata,
      diagnostics: {
        ...baseDiag,
        processStartMatches: false,
        decision: 'archive_stale_lock',
        reason: 'pid_reused_start_time_mismatch',
      },
    };
  }
  if (metadata.processStartTime && liveStart) {
    baseDiag.processStartMatches = true;
  } else if (metadata.processStartTime && !liveStart) {
    // Could not read live start time — fall through to executable checks.
    baseDiag.processStartMatches = null;
  }

  const liveExe = await inspector.getExecutablePath(pid);
  const lockExe = metadata.executablePath ?? null;
  const commandHint = metadata.command ?? null;

  if (liveExe && lockExe) {
    const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const matches = normalize(liveExe) === normalize(lockExe);
    baseDiag.executableMatches = matches;
    if (!matches) {
      return {
        decision: 'stale',
        reason: 'executable_path_mismatch',
        metadata,
        diagnostics: {
          ...baseDiag,
          decision: 'archive_stale_lock',
          reason: 'executable_path_mismatch',
        },
      };
    }
  } else if (liveExe && !looksLikePmbrainExecutable(liveExe, commandHint)) {
    baseDiag.executableMatches = false;
    return {
      decision: 'stale',
      reason: 'executable_not_pmbrain',
      metadata,
      diagnostics: {
        ...baseDiag,
        decision: 'archive_stale_lock',
        reason: 'executable_not_pmbrain',
      },
    };
  } else if (liveExe) {
    baseDiag.executableMatches = true;
  }

  // Live owner identity still valid. Age is irrelevant.
  return {
    decision: 'active',
    reason: 'owner_still_active',
    metadata,
    diagnostics: {
      ...baseDiag,
      decision: 'reject_active_owner',
      reason: 'owner_still_active',
    },
  };
}

function archiveLockDir(lockDir: string, reason: string): string {
  const parent = join(lockDir, '..');
  const stamp = formatArchiveStamp();
  const safeReason = reason.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48);
  let target = join(parent, `${LOCK_DIR_NAME}.stale-${stamp}-${safeReason}`);
  let n = 0;
  while (existsSync(target)) {
    n += 1;
    target = join(parent, `${LOCK_DIR_NAME}.stale-${stamp}-${safeReason}-${n}`);
  }
  try {
    renameSync(lockDir, target);
    return target;
  } catch {
    // If rename fails (race), leave it; caller will retry evaluation.
    return target;
  }
}

async function buildMetadata(
  dataDir: string,
  ownerType: LockOwnerType,
  inspector: ProcessInspector,
  command?: string,
): Promise<LockMetadataV2> {
  const createdAt = nowIso();
  const processStartTime = await inspector.getStartTime(process.pid);
  const executablePath = await inspector.getExecutablePath(process.pid);
  const bootMarker = await inspector.getBootMarker();
  const ownerToken = randomBytes(16).toString('hex');
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    processStartTime,
    bootMarker,
    ownerToken,
    ownerType,
    databasePath: dataDir,
    executablePath,
    command: command ?? process.argv.slice(1).join(' ').slice(0, 500),
    subcommand: parseGlobalFlags(process.argv.slice(2)).rest[0] ?? null,
    createdAt,
    updatedAt: createdAt,
    acquired_at: Date.now(),
  };
}

/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 */
export async function acquireLock(
  dataDir: string | undefined,
  opts?: AcquireLockOptions,
): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);
  if (!lockDir) {
    return {
      lockDir: '',
      acquired: true,
      diagnostics: {
        databasePath: '',
        lockPath: '',
        lockExists: false,
        lockMetadata: null,
        currentBootMarker: '',
        lockBootMarkerMatches: null,
        pidExists: null,
        processStartMatches: null,
        executableMatches: null,
        decision: 'skip_in_memory',
        reason: 'in_memory',
      },
    };
  }

  createPgliteDatabaseDirectory(dataDir as string);
  const inspector = resolveInspector(opts?.inspector);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ownerType = opts?.ownerType ?? 'cli';
  const failFast = opts?.failFastIfOwned ?? false;
  const startTime = Date.now();
  let attempts = 0;
  let lastDiagnostics: LockDiagnostics | undefined;
  let reaped = false;

  while (Date.now() - startTime < timeoutMs && attempts < MAX_COMPETE_ATTEMPTS + Math.floor(timeoutMs / RETRY_WAIT_MS)) {
    attempts += 1;

    if (existsSync(lockDir)) {
      const evaluation = await evaluateExistingLock(dataDir as string, lockDir, inspector);
      lastDiagnostics = evaluation.diagnostics;

      if (evaluation.decision === 'active') {
        const serveOwner = isLongLivedServeOwner(evaluation.metadata);
        if (serveOwner || failFast || Date.now() - startTime >= timeoutMs) {
          throw new DatabaseAlreadyOwnedError({
            databasePath: dataDir as string,
            lockPath: lockFilePath(lockDir),
            ownerPid: evaluation.metadata?.pid ?? null,
            ownerType: evaluation.metadata?.ownerType ?? null,
            executablePath: evaluation.metadata?.executablePath ?? null,
            lockCreatedAt: evaluation.metadata?.createdAt ?? null,
            ownerToken: evaluation.metadata?.ownerToken ?? null,
            message: serveOwner
              ? `PMBrain 的本地 PGLite 已由长驻 serve 服务占用（PID ${evaluation.metadata?.pid ?? 'unknown'}）。`
                + ' 当前进程不会排队等待，避免在快速维护让锁时抢占数据库。'
                + ' 请复用正在运行的 Desktop/Admin 服务，或先关闭另一个 PMBrain/Codex/Claude Code 会话后重试。'
              : undefined,
          });
        }
        await sleep(RETRY_WAIT_MS);
        continue;
      }

      // Stale or corrupt → archive (never permanent delete).
      const archivePath = archiveLockDir(lockDir, evaluation.reason);
      reaped = true;
      if (evaluation.decision === 'corrupt') recordReap(dataDir as string);
      lastDiagnostics = {
        ...evaluation.diagnostics,
        decision: 'archive_stale_lock',
        reason: evaluation.reason,
        archivedTo: redactPath(archivePath),
      };
      // Proceed to atomic create below (lock dir should be gone).
    }

    // Build metadata before mkdirSync. The metadata lookup is asynchronous;
    // doing it after the exclusive directory creation leaves a short-lived
    // empty lock directory that a concurrent acquirer could mistake for
    // corrupt residue and archive, allowing two owners through.
    const metadata = await buildMetadata(dataDir as string, ownerType, inspector, opts?.command);
    try {
      mkdirSync(lockDir, { recursive: false });
      writeFileSync(lockFilePath(lockDir), JSON.stringify(metadata, null, 2), { mode: 0o644 });
      const diagnostics: LockDiagnostics = {
        databasePath: redactPath(dataDir as string),
        lockPath: redactPath(lockFilePath(lockDir)),
        lockExists: true,
        lockMetadata: {
          pid: metadata.pid,
          ownerType: metadata.ownerType,
          createdAt: metadata.createdAt,
        },
        currentBootMarker: metadata.bootMarker,
        lockBootMarkerMatches: true,
        pidExists: true,
        processStartMatches: true,
        executableMatches: true,
        decision: 'acquire_new',
        reason: lastDiagnostics?.reason ? `after_${lastDiagnostics.reason}` : 'lock_absent',
        archivedTo: lastDiagnostics?.archivedTo,
      };
      pruneArchivedLocks(dataDir as string);
      return {
        lockDir,
        acquired: true,
        reaped,
        ownerToken: metadata.ownerToken,
        metadata,
        diagnostics,
      };
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Lost the race — loop and re-evaluate.
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          `GBrain: Permission denied creating PGLite lock at ${lockDir}.`,
          { cause: e },
        );
      }
      // Other errors: brief retry then surface.
      if (Date.now() - startTime >= timeoutMs) throw e;
      await sleep(RETRY_WAIT_MS);
    }
  }

  // Timeout — report current owner if any.
  if (existsSync(lockDir)) {
    const evaluation = await evaluateExistingLock(dataDir as string, lockDir, inspector);
    if (evaluation.decision === 'active') {
      throw new DatabaseAlreadyOwnedError({
        databasePath: dataDir as string,
        lockPath: lockFilePath(lockDir),
        ownerPid: evaluation.metadata?.pid ?? null,
        ownerType: evaluation.metadata?.ownerType ?? null,
        executablePath: evaluation.metadata?.executablePath ?? null,
        lockCreatedAt: evaluation.metadata?.createdAt ?? null,
        ownerToken: evaluation.metadata?.ownerToken ?? null,
      });
    }
  }

  throw new Error(
    `GBrain: Timed out waiting for PGLite lock on ${dataDir}.`
    + (lastDiagnostics ? ` Last decision: ${lastDiagnostics.decision}/${lastDiagnostics.reason}.` : '')
    + ` If no PMBrain process is running, inspect archived locks next to the database directory.`,
  );
}

/**
 * Release a previously acquired lock. Only succeeds when ownerToken matches
 * the on-disk lock (prevents an old process from deleting a newer owner's lock).
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  if (!lock.lockDir || !lock.acquired) return;

  const path = lockFilePath(lock.lockDir);
  try {
    if (!existsSync(lock.lockDir)) return;

    if (lock.ownerToken && existsSync(path)) {
      const raw = safeJsonParse(readFileSync(path, 'utf-8'));
      const meta = normalizeMetadata(raw, lock.metadata?.databasePath ?? '');
      if (meta?.ownerToken && meta.ownerToken !== lock.ownerToken) {
        // Another process owns the lock now — do not remove.
        return;
      }
      // Legacy locks without ownerToken: only remove if PID still matches us.
      if (!meta?.ownerToken && meta?.pid != null && meta.pid !== process.pid) {
        return;
      }
    }

    // Prefer renaming to a released archive rather than permanent delete so
    // field diagnostics retain the last owner snapshot. Then remove by
    // renaming out of the active lock path; leave archive on disk.
    let released = join(
      lock.lockDir,
      '..',
      `${LOCK_DIR_NAME}.released-${formatArchiveStamp()}-${process.pid}`,
    );
    let suffix = 0;
    while (existsSync(released)) {
      suffix += 1;
      released = join(
        lock.lockDir,
        '..',
        `${LOCK_DIR_NAME}.released-${formatArchiveStamp()}-${process.pid}-${suffix}`,
      );
    }
    try {
      renameSync(lock.lockDir, released);
    } catch {
      // If rename fails because someone else already moved it, that is fine.
    }
    pruneArchivedLocks(dirname(lock.lockDir));
  } catch {
    // Best-effort release.
  }
}

/**
 * Read lock diagnostics without attempting to acquire.
 */
export async function inspectLock(
  dataDir: string,
  opts?: { inspector?: ProcessInspector },
): Promise<LockDiagnostics> {
  const lockDir = getLockDir(dataDir);
  const inspector = resolveInspector(opts?.inspector);
  if (!lockDir || !existsSync(lockDir)) {
    return {
      databasePath: redactPath(dataDir),
      lockPath: redactPath(lockFilePath(lockDir || join(dataDir, LOCK_DIR_NAME))),
      lockExists: false,
      lockMetadata: null,
      currentBootMarker: await inspector.getBootMarker(),
      lockBootMarkerMatches: null,
      pidExists: null,
      processStartMatches: null,
      executableMatches: null,
      decision: 'acquire_new',
      reason: 'lock_absent',
    };
  }
  const evaluation = await evaluateExistingLock(dataDir, lockDir, inspector);
  return evaluation.diagnostics;
}

/**
 * List archived stale lock directories next to a database path (diagnostics only).
 */
export function listArchivedLocks(dataDir: string): string[] {
  try {
    return readdirSync(dataDir)
      .filter((name) => name.startsWith(`${LOCK_DIR_NAME}.stale-`) || name.startsWith(`${LOCK_DIR_NAME}.released-`))
      .map((name) => join(dataDir, name));
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test helper: force-write a lock directory with given metadata (no live acquire). */
export function writeLockFixture(dataDir: string, metadata: Record<string, unknown>): string {
  mkdirSync(dataDir, { recursive: true });
  const lockDir = getLockDir(dataDir);
  if (existsSync(lockDir)) {
    throw new PgliteLockMetadataError(lockDir, 'lock already exists');
  }
  mkdirSync(lockDir, { recursive: false });
  writeFileSync(lockFilePath(lockDir), JSON.stringify(metadata, null, 2), { mode: 0o644 });
  return lockDir;
}

/** Test helper: check whether the active lock directory currently exists. */
export function lockDirExists(dataDir: string): boolean {
  return existsSync(getLockDir(dataDir));
}

/** Test helper: read raw lock JSON if present. */
export function readLockMetadata(dataDir: string): Partial<LockMetadataV2> | null {
  const path = lockFilePath(getLockDir(dataDir));
  if (!existsSync(path)) return null;
  return normalizeMetadata(safeJsonParse(readFileSync(path, 'utf-8')), dataDir);
}

/** True when a path entry is an active lock dir (not archive). */
export function isActiveLockPath(pathValue: string): boolean {
  try {
    return existsSync(pathValue) && statSync(pathValue).isDirectory() && pathValue.endsWith(LOCK_DIR_NAME);
  } catch {
    return false;
  }
}
