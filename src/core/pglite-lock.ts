/** Kernel ownership for a persistent PGLite datastore; metadata is diagnostic. */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, realpathSync, readlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from './spawn.ts';
import { readProcessCommand, type ProcessCommandProbeDeps } from './autopilot-lock.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { parseGlobalFlags } from './cli-options.ts';
import { tryAcquireNativeLock, type NativeLockHandle } from './persistence/native-lock.ts';

const HEARTBEAT_INTERVAL_MS = 30_000;
const LOCK_FILE = 'lock';
// A dropped engine reference must never let GC release a still-open datastore.
const retainedOwners = new Set<LockHandle>();

export class PgliteBusyError extends Error {
  readonly code = 'pglite_busy';
  readonly retryable = true;
  constructor(message: string, public reason: 'timeout' | 'live_serve' = 'timeout') {
    super(message); this.name = 'PgliteBusyError';
  }
}
export class LiveServeLockError extends PgliteBusyError {
  /** The live serve holding the lock, for the two-step recovery plan (A7 `exclusiveFix`). */
  readonly ownerPid?: number;
  readonly ownerTransport?: 'stdio' | 'http';
  constructor(message: string, owner: { pid?: number; transport?: 'stdio' | 'http' } = {}) {
    super(message, 'live_serve'); this.name = 'LiveServeLockError';
    this.ownerPid = owner.pid;
    this.ownerTransport = owner.transport;
  }
}

export interface LockHandle {
  /** Legacy metadata directory. It is never the ownership authority. */
  lockDir: string;
  acquired: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
  lockPath?: string;
  ownerToken?: string;
  /** A dead legacy holder was encountered during protocol migration. */
  reaped?: boolean;
  nativeLock?: NativeLockHandle;
  /** Epoch ms when this process took the lock (diagnostic). */
  acquiredAt?: number;
}

interface LockMetadata {
  pid?: number;
  acquired_at?: number;
  refreshed_at?: number;
  command?: string;
  argv?: string[];
  subcommand?: string;
  owner_token?: string;
  protocol?: string;
  pid_ns?: string | null;
  boot_id?: string | null;
}
const protocol = 'kernel-v1';
function tokenOf(metadata: LockMetadata): string {
  return metadata.owner_token ?? `${metadata.pid}:${metadata.acquired_at}`;
}
function isServeCommand(metadata: LockMetadata): boolean {
  if (typeof metadata.subcommand === 'string') return metadata.subcommand === 'serve';
  const parts = typeof metadata.command === 'string' ? metadata.command.trim().split(/\s+/) : [];
  return parts[0] === 'serve' || parts[1] === 'serve';
}
function readMetadata(lockDir: string): LockMetadata | null {
  try { return JSON.parse(readFileSync(join(lockDir, LOCK_FILE), 'utf8')); } catch { return null; }
}
export function readPidNs(): string | null {
  try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; }
}
export function readBootId(): string | null {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
}

/** Resolve existing ancestors without creating the datastore during inspection. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalPath(parent), basename(absolute));
  }
}
/** Stable sibling survives datastore replacement. Never unlink this file. */
export function getPgliteKernelLockPath(dataDir: string | undefined): string | undefined {
  return dataDir ? `${canonicalPath(dataDir)}.gbrain-owner.lock` : undefined;
}
/** Orchestration lock for `gbrain apply-migrations`; separate from the datastore lock above. */
export function getPgliteMigrationLockPath(dataDir: string): string {
  return `${canonicalPath(dataDir)}.gbrain-migrations.lock`;
}
function getLockDir(dataDir: string | undefined): string {
  return dataDir ? join(dataDir, '.gbrain-lock') : '';
}

/** PID is used for diagnostics and legacy migration, never kernel takeover. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Compatibility process diagnostics; never an ownership or takeover authority. */
function readProcessArgs(pid: number, deps?: ProcessCommandProbeDeps): string | null {
  if ((deps?.platform ?? process.platform) === 'win32') return readProcessCommand(pid, deps);
  const exec = deps?.execFile ?? execFileSync;
  try {
    const out = exec('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    if (out.length > 0) return out;
  } catch { /* fall through to /proc */ }
  try {
    const raw = (deps?.readCmdlineFile ?? readFileSync)(`/proc/${pid}/cmdline`);
    const args = raw.toString().replace(/\0/g, ' ').trim();
    if (args.length > 0) return args;
  } catch { /* unreadable — unknowable */ }
  return null;
}

/**
 * Report a possible mismatch between a recorded legacy command and its PID.
 * Keep structured argv, namespace checks and native Windows CIM diagnostics.
 * Neither acquireLock nor read-only holder routing uses this heuristic: command
 * changes and PID reuse cannot release a kernel owner or migrate a live legacy
 * holder. Stop older processes before upgrading the datastore's lock protocol.
 */
export function isPidReusedByOtherProgram(
  pid: number,
  recordedArgv: unknown,
  recordedPidNs: unknown,
  recordedBootId: unknown,
  deps?: ProcessCommandProbeDeps,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Same-process re-acquire: WE are the recorded holder, so the PID is by
  // definition not recycled. (Also keeps non-gbrain test harnesses that hold a
  // lock with their own PID from reaping themselves.)
  if (pid === process.pid) return false;
  if (!Array.isArray(recordedArgv) || recordedArgv.length === 0
    || !recordedArgv.every(arg => typeof arg === 'string')
    || recordedArgv[0].trim().length === 0) return false;
  if ((deps?.platform ?? process.platform) === 'linux') {
    // Linux: cmdline evidence is only meaningful within one PID namespace on
    // one host, so EVERY marker must be readable AND matching — pid_ns rules
    // out other containers, boot_id rules out other hosts (pid_ns inode
    // numbers can collide across machines sharing a data dir). An unreadable
    // local marker, a legacy lock without markers, or any mismatch all make
    // the diagnostic inconclusive.
    const ourNs = readPidNs();
    const ourBoot = readBootId();
    if (ourNs === null || ourBoot === null) return false;
    if (recordedPidNs !== ourNs) return false;
    if (recordedBootId !== ourBoot) return false;
  }
  const cmdline = readProcessArgs(pid, deps);
  if (cmdline === null) return false; // unknowable — cannot prove reuse
  const isWin32 = (deps?.platform ?? process.platform) === 'win32';
  const normalize = (s: string) => isWin32 ? s.toLowerCase().replace(/\\/g, '/') : s;
  const normalizedCommand = normalize(cmdline);
  if (normalizedCommand.includes('gbrain')) return false;
  const scriptPath = recordedArgv[0];
  if (normalizedCommand.includes(normalize(scriptPath))) return false;
  const scriptName = scriptPath.split(/[\\/]/).pop();
  return !!scriptName && !normalizedCommand.includes(normalize(scriptName));
}

export interface LockHolderInfo {
  /** Conservative diagnostic hint. Only acquireLock establishes ownership. */
  held: boolean;
  pid?: number;
  serve?: boolean;
  subcommand?: string;
}
/** Read-only compatibility seam for engine-free IPC delegation and status. */
export function inspectLockHolder(dataDir: string | undefined): LockHolderInfo {
  return inspectHolderMetadata(dataDir).holder;
}
function inspectHolderMetadata(dataDir: string | undefined): { holder: LockHolderInfo; metadata: LockMetadata | null } {
  const lockDir = getLockDir(dataDir);
  if (!lockDir || !existsSync(lockDir)) return { holder: { held: false }, metadata: null };
  const metadata = readMetadata(lockDir);
  if (!metadata) return { holder: { held: true }, metadata };
  const pid = typeof metadata.pid === 'number' ? metadata.pid : undefined;
  if (pid !== undefined && !isProcessAlive(pid)) return { holder: { held: false, pid }, metadata };
  return { holder: { held: true, pid, serve: isServeCommand(metadata),
    subcommand: typeof metadata.subcommand === 'string' ? metadata.subcommand : undefined }, metadata };
}
export interface LockPeekResult {
  held: boolean; isServe?: boolean; pid?: number;
  /** The holder is `gbrain serve --http` (read from its recorded argv). */
  http?: boolean;
  /** Epoch ms the holder recorded at acquisition. */
  acquiredAt?: number;
}
export function peekLock(dataDir: string | undefined): LockPeekResult {
  const { holder, metadata } = inspectHolderMetadata(dataDir);
  if (!holder.held || !holder.serve || !metadata) return { held: holder.held, isServe: holder.serve, pid: holder.pid };
  const args = Array.isArray(metadata.argv) ? metadata.argv : (metadata.command ?? '').split(/\s+/);
  return { held: true, isServe: true, pid: holder.pid, http: args.includes('--http'),
    ...(typeof metadata.acquired_at === 'number' ? { acquiredAt: metadata.acquired_at } : {}) };
}
/**
 * The lock this process itself holds on `dataDir`, from in-memory state only
 * (no file access while this process holds no lock at all).
 */
export function heldLockFor(dataDir: string | undefined): LockHandle | null {
  if (!dataDir || retainedOwners.size === 0) return null;
  let lockDir: string;
  try { lockDir = getLockDir(canonicalPath(dataDir)); } catch { return null; }
  for (const owner of retainedOwners) if (owner.acquired && owner.lockDir === lockDir) return owner;
  return null;
}
/** Compatibility with repair quarantine markers from older releases. */
export function msSinceLastReap(dataDir: string | undefined): number | null {
  if (!dataDir) return null;
  try {
    const marker = JSON.parse(readFileSync(`${dataDir}.lock-reap.json`, 'utf8'));
    return typeof marker.ts === 'number' && Number.isFinite(marker.ts) ? Date.now() - marker.ts : null;
  } catch { return null; }
}

function writeMetadata(path: string, metadata: LockMetadata): void {
  const temporary = `${path}.tmp-${metadata.owner_token}`;
  try {
    writeFileSync(temporary, JSON.stringify(metadata), { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
function startHeartbeat(path: string, ownerToken: string): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      const metadata = JSON.parse(readFileSync(path, 'utf8')) as LockMetadata;
      if (tokenOf(metadata) !== ownerToken) { clearInterval(timer); return; }
      metadata.refreshed_at = Date.now();
      writeMetadata(path, metadata);
    } catch { /* Metadata failure cannot change kernel ownership. */ }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
function busy(lockDir: string): PgliteBusyError {
  const metadata = readMetadata(lockDir);
  if (metadata && isServeCommand(metadata) && isProcessAlive(metadata.pid!)) {
    const args = Array.isArray(metadata.argv) ? metadata.argv : (metadata.command ?? '').split(/\s+/);
    return new LiveServeLockError(`GBrain's local database is already open through \`gbrain serve\` (MCP, PID ${metadata.pid ?? 'unknown'}). Use the live serve's IPC/MCP tools or stop it before opening this PGLite datastore. Never remove a live holder's lock.`,
      { pid: metadata.pid, transport: args.includes('--http') ? 'http' : 'stdio' });
  }
  return new PgliteBusyError(`GBrain: Timed out waiting for PGLite data-dir lock at ${lockDir}. Retry after the holder finishes. Stop all older GBrain processes before upgrading this datastore's lock protocol; unreadable legacy ownership is never stolen. Never remove a live holder's lock. This lock is separate from \`gbrain sync --break-lock\`.`);
}

/**
 * First kernel acquisition also claims the legacy mkdir lock. A live or
 * unreadable legacy holder blocks migration. After migration, pid/mtime/
 * metadata corruption cannot authorize or prevent native ownership.
 * All older GBrain processes must be stopped before the protocol upgrade.
 */
export async function acquireLock(dataDir: string | undefined, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LockHandle> {
  if (!dataDir) return { lockDir: '', acquired: true };
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2 ** 31 - 1) throw new RangeError('Invalid PGLite lock timeout');
  const canonical = canonicalPath(dataDir);
  const kernelPath = getPgliteKernelLockPath(canonical)!;
  const markerPath = `${canonical}.gbrain-owner.json`;
  const lockDir = getLockDir(canonical);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    opts.signal?.throwIfAborted();
    const nativeLock = await tryAcquireNativeLock(kernelPath);
    if (nativeLock) {
      let accepted = false;
      try {
        let migrated = false;
        try { migrated = JSON.parse(readFileSync(markerPath, 'utf8')).protocol === protocol; } catch { /* first upgrade */ }
        mkdirSync(canonical, { recursive: true });
        let reaped = false;
        try { mkdirSync(lockDir); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const metadata = readMetadata(lockDir);
          if (!migrated || (metadata && metadata.protocol !== protocol)) {
            // Legacy death requires matching namespace evidence on Linux;
            // ESRCH from another container's PID namespace proves nothing.
            const comparable = process.platform !== 'linux' || (metadata?.pid_ns === readPidNs()
              && metadata?.boot_id === readBootId() && metadata?.pid_ns != null && metadata?.boot_id != null);
            if (!metadata || !comparable || isProcessAlive(metadata.pid!)) throw busy(lockDir);
            reaped = true;
          }
        }
        opts.signal?.throwIfAborted();
        writeFileSync(markerPath, JSON.stringify({ protocol }), { mode: 0o600 });
        const now = Date.now(), ownerToken = randomUUID(), lockPath = join(lockDir, LOCK_FILE);
        writeMetadata(lockPath, { pid: process.pid, acquired_at: now, refreshed_at: now,
          command: process.argv.slice(1).join(' '), argv: process.argv.slice(1), subcommand: parseGlobalFlags(process.argv.slice(2)).rest[0],
          owner_token: ownerToken, protocol, pid_ns: readPidNs(), boot_id: readBootId() });
        const result = { lockDir, acquired: true, lockPath, ownerToken, reaped, nativeLock,
          heartbeat: startHeartbeat(lockPath, ownerToken), acquiredAt: now };
        retainedOwners.add(result);
        accepted = true;
        return result;
      } catch (error) {
        if (!(error instanceof PgliteBusyError) || error instanceof LiveServeLockError || performance.now() >= deadline) throw error;
      } finally { if (!accepted) await nativeLock.release(); }
    } else {
      const error = busy(lockDir);
      if (error instanceof LiveServeLockError) throw error;
    }
    if (performance.now() >= deadline) throw busy(lockDir);
    await delay(Math.min(25, deadline - performance.now()), undefined, { signal: opts.signal });
  }
}

/**
 * Engine graduation: take only the stable sibling kernel lock of `dataDir`,
 * without creating the data dir or its metadata (the path may hold a
 * graduation tombstone file, or nothing while the datastore sits at its
 * moved-aside path). `lockDir` names where the datastore's metadata now
 * lives so release and a later move retarget it correctly.
 */
export async function acquireKernelLockOnly(dataDir: string, opts: { lockDir: string; timeoutMs?: number; signal?: AbortSignal }): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2 ** 31 - 1) throw new RangeError('Invalid PGLite lock timeout');
  const kernelPath = getPgliteKernelLockPath(dataDir)!;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    opts.signal?.throwIfAborted();
    const nativeLock = await tryAcquireNativeLock(kernelPath);
    if (nativeLock) {
      const result: LockHandle = { lockDir: opts.lockDir, acquired: true, nativeLock, acquiredAt: Date.now() };
      retainedOwners.add(result);
      return result;
    }
    if (performance.now() >= deadline) throw busy(getLockDir(canonicalPath(dataDir)));
    await delay(Math.min(25, deadline - performance.now()), undefined, { signal: opts.signal });
  }
}

/** The metadata dir `acquireLock` uses for `dataDir`; a held handle for that datastore carries it as `lockDir`. */
export function pgliteLockDirFor(dataDir: string): string {
  return getLockDir(canonicalPath(dataDir));
}

/** Metadata removal is optional; kernel release is mandatory and never unlinks. */
export async function releaseLock(lock: LockHandle): Promise<void> {
  if (!lock.acquired) return;
  if (lock.heartbeat) { clearInterval(lock.heartbeat); lock.heartbeat = undefined; }
  if (lock.lockDir && lock.ownerToken) {
    const metadata = readMetadata(lock.lockDir);
    if (metadata && tokenOf(metadata) === lock.ownerToken) {
      try { rmSync(lock.lockDir, { recursive: true, force: true }); } catch { /* diagnostic only */ }
    }
  }
  await lock.nativeLock?.release();
  lock.acquired = false;
  retainedOwners.delete(lock);
}
