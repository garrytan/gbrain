/** Kernel ownership for a persistent PGLite datastore; metadata is diagnostic. */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, realpathSync, readlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  constructor(message: string) { super(message, 'live_serve'); this.name = 'LiveServeLockError'; }
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
function readPidNs(): string | null {
  try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; }
}
function readBootId(): string | null {
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
function getLockDir(dataDir: string | undefined): string {
  return dataDir ? join(dataDir, '.gbrain-lock') : '';
}

/** PID is used for diagnostics and legacy migration, never kernel takeover. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Decode CIM's Windows command line without splitting quoted paths. */
function parseWindowsArgs(command: string): string[] | null {
  const argv: string[] = [];
  let arg = '', quoted = false, started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (started) argv.push(arg);
      arg = ''; started = false;
      continue;
    }
    started = true;
    if (ch === '\\') {
      let count = 1;
      while (command[i + 1] === '\\') { count++; i++; }
      // Only backslashes immediately before a quote are escapes on Windows.
      if (command[i + 1] === '"') {
        arg += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) { arg += '"'; i++; }
      } else arg += '\\'.repeat(count);
    } else if (ch === '"') {
      if (quoted && command[i + 1] === '"') { arg += '"'; i++; }
      else quoted = !quoted;
    } else arg += ch;
  }
  if (quoted) return null; // malformed/truncated evidence cannot authorize a reap
  if (started) argv.push(arg);
  return argv.length > 0 && argv[0].length > 0 ? argv : null;
}

/**
 * Prefer /proc's NUL-delimited argv: flattening it loses argument boundaries.
 * Windows CIM carries quoting; ps on macOS/minimal containers does not, so
 * mark that fallback as lossy. Null means unknowable, never proof of death.
 */
function readProcessArgs(pid: number, deps?: ProcessCommandProbeDeps): { argv: string[]; exact: boolean } | null {
  if ((deps?.platform ?? process.platform) === 'win32') {
    const command = readProcessCommand(pid, deps);
    const argv = command === null ? null : parseWindowsArgs(command);
    return argv === null ? null : { argv, exact: true };
  }
  try {
    const raw = (deps?.readCmdlineFile ?? readFileSync)(`/proc/${pid}/cmdline`).toString();
    if (raw.length > 0) {
      if (!raw.endsWith('\0')) return null; // incomplete argv
      const argv = raw.slice(0, -1).split('\0');
      return argv[0].length > 0 ? { argv, exact: true } : null;
    }
  } catch { /* no /proc or unreadable — fall through to ps */ }
  const exec = deps?.execFile ?? execFileSync;
  try {
    const out = exec('ps', ['-ww', '-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    if (out.length > 0) return { argv: out.split(/\s+/), exact: false };
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
  const live = readProcessArgs(pid, deps);
  if (live === null) return false; // unknowable — cannot prove reuse
  const isWin32 = (deps?.platform ?? process.platform) === 'win32';
  const normalize = (s: string) => isWin32 ? s.toLowerCase().replace(/\\/g, '/') : s;
  const basename = (s: string) => normalize(s).split(/[\\/]/).pop()!;
  const scriptName = basename(recordedArgv[0]);
  if (!scriptName) return false;
  // ps does not quote/escape argv. A basename containing whitespace cannot
  // be recovered from its rendering, so a mismatch would not prove reuse.
  if (!live.exact && /\s/.test(scriptName)) return false;
  // Keep the absolute/relative invocation fallback, but compare WHOLE names:
  // cli.ts.bak, not-gbrain and /tmp/gbrain/other.ts are not holder identities.
  return !live.argv.some(arg => {
    if (arg.startsWith('-')) return false; // e.g. --log=/tmp/gbrain is not a program
    const name = basename(arg);
    return name === scriptName || name === 'gbrain' || (isWin32 && name === 'gbrain.exe');
  });
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
  const lockDir = getLockDir(dataDir);
  if (!lockDir || !existsSync(lockDir)) return { held: false };
  const metadata = readMetadata(lockDir);
  if (!metadata) return { held: true };
  const pid = typeof metadata.pid === 'number' ? metadata.pid : undefined;
  if (pid !== undefined && !isProcessAlive(pid)) return { held: false, pid };
  return { held: true, pid, serve: isServeCommand(metadata),
    subcommand: typeof metadata.subcommand === 'string' ? metadata.subcommand : undefined };
}
export interface LockPeekResult { held: boolean; isServe?: boolean; pid?: number; }
export function peekLock(dataDir: string | undefined): LockPeekResult {
  const holder = inspectLockHolder(dataDir);
  return { held: holder.held, isServe: holder.serve, pid: holder.pid };
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
    return new LiveServeLockError(`GBrain's local database is already open through \`gbrain serve\` (MCP, PID ${metadata.pid ?? 'unknown'}). Use the live serve's IPC/MCP tools or stop it before opening this PGLite datastore. Never remove a live holder's lock.`);
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
          heartbeat: startHeartbeat(lockPath, ownerToken) };
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
