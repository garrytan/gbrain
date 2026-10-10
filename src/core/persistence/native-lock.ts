/** Stable OS locks for cooperating writers on one owner host. No TTL takeover. */
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { constants as osConstants } from 'node:os';
import { family, GLIBC, MUSL } from 'detect-libc';

export interface NativeExportPublisher {
  beginExport(absoluteDestination: string): object;
  publishExportFile(handle: object, relativePath: string, data: Buffer): void;
  completeExport(handle: object): void;
  closeExport(handle: object): void;
}

interface NativeBinding extends NativeExportPublisher {
  target: string;
  openLock(path: string): object;
  tryLock(handle: object): boolean;
  close(handle: object): void;
  openIpcMutex?(name: string): object;
  removeWindowsUnixSocket?(handle: object, path: string): boolean;
}

export class NativeLockUnavailableError extends Error {
  readonly code = 'writer_lock_unavailable';
  /** #6305: 'open' when this process could not create or open the lock file itself (its directory or the file), as opposed to an addon, close or IPC failure. */
  readonly stage?: 'open';
  /** #6305: the OS error behind the failure (`EACCES`, `EISDIR`, `os_error_5`), when the cause names one. */
  readonly osError?: string;
  constructor(message = 'Native writer locking is unavailable on this host', cause?: unknown, stage?: 'open') {
    const osError = nativeLockOsError(cause);
    super(osError ? `${message} (${osError})` : message, { cause });
    this.name = 'NativeLockUnavailableError';
    if (stage) this.stage = stage;
    if (osError) this.osError = osError;
  }
}

/** #6305: this process could not create or open the lock file; a busy lock returns null instead. */
/** #6305: the OS error of the last lock-open failure per worktree, so the consumer's release line names it (the request's blocked_reason cannot). */
const openFailures = new Map<string, string>();
export function noteLockOpenFailure(worktreeId: string, error: unknown): void {
  const os = error instanceof NativeLockUnavailableError ? error.osError : undefined;
  if (os) openFailures.set(worktreeId, os); else openFailures.delete(worktreeId);
}
export function lockOpenOsError(worktreeId: string | null | undefined): string | null { return worktreeId ? openFailures.get(worktreeId) ?? null : null; }
export function isLockOpenFailure(error: unknown): error is NativeLockUnavailableError {
  return error instanceof NativeLockUnavailableError && error.stage === 'open';
}

/** A node:fs error code, or the native addon's `(OS error N)` as its errno name (`os_error_N` when the platform has no name). */
export function nativeLockOsError(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) return code;
  const match = /\(OS error (\d+)\)/.exec(cause instanceof Error ? cause.message : '');
  if (!match || match[1] === '0') return undefined;
  const errno = Number(match[1]);
  if (process.platform === 'win32') return `os_error_${errno}`;
  return Object.entries(osConstants.errno).find(([, value]) => value === errno)?.[0] ?? `os_error_${errno}`;
}

export interface NativeLockHandle {
  /** True after release. A released handle must not authorize further work. */
  readonly released: boolean;
  /** Idempotent. Closing the OS handle releases its lock without unlinking. */
  release(): Promise<void>;
}

export interface NativeLockOptions {
  /** A zero budget tries once. Defaults to five seconds. */
  timeoutMs?: number;
  /** Delay between nonblocking attempts; defaults to 25 ms. */
  pollMs?: number;
  signal?: AbortSignal;
}

let bindingPromise: Promise<NativeBinding> | undefined;
const windowsSocketRemovers = new WeakMap<NativeLockHandle, (path: string) => boolean>();

async function loadBinding(): Promise<NativeBinding> {
  const arch = process.arch;
  if (arch !== 'x64' && arch !== 'arm64') throw new NativeLockUnavailableError(`Native writer locking does not support ${process.platform}/${arch}`);
  let binding: NativeBinding;
  let target: string;
  try {
    if (process.platform === 'linux') {
      const libc = await family();
      if (libc !== GLIBC && libc !== MUSL) throw new NativeLockUnavailableError('Cannot identify the Linux C runtime for writer locking');
      target = `linux-${arch}-${libc}`;
      // Literal requires are intentional: Bun embeds each .node asset in its
      // compiled executables. Dynamic prebuild discovery does not embed them.
      if (libc === GLIBC) binding = arch === 'x64'
        ? require('../../../native/locks/prebuilds/linux-x64-glibc.node')
        : require('../../../native/locks/prebuilds/linux-arm64-glibc.node');
      else binding = arch === 'x64'
        ? require('../../../native/locks/prebuilds/linux-x64-musl.node')
        : require('../../../native/locks/prebuilds/linux-arm64-musl.node');
    } else if (process.platform === 'darwin') {
      target = `darwin-${arch}`;
      binding = arch === 'x64'
        ? require('../../../native/locks/prebuilds/darwin-x64.node')
        : require('../../../native/locks/prebuilds/darwin-arm64.node');
    } else if (process.platform === 'win32') {
      target = `win32-${arch}`;
      binding = arch === 'x64'
        ? require('../../../native/locks/prebuilds/win32-x64.node')
        : require('../../../native/locks/prebuilds/win32-arm64.node');
    } else throw new NativeLockUnavailableError(`Native writer locking does not support ${process.platform}/${arch}`);
    if (binding.target !== target || typeof binding.openLock !== 'function' || typeof binding.tryLock !== 'function' || typeof binding.close !== 'function') {
      throw new NativeLockUnavailableError('Installed native writer lock addon has the wrong target or ABI');
    }
    if (process.platform === 'win32' && (typeof binding.openIpcMutex !== 'function' || typeof binding.removeWindowsUnixSocket !== 'function')) {
      throw new NativeLockUnavailableError('Installed native writer lock addon lacks Windows IPC support');
    }
    return binding;
  } catch (cause) {
    if (cause instanceof NativeLockUnavailableError) throw cause;
    throw new NativeLockUnavailableError('Cannot load the native writer lock addon; reinstall this GBrain version', cause);
  }
}

/** Lazy so a nonowner Postgres server can still accept writes and serve reads. */
export async function nativeLockCapability(): Promise<{ target: string; napi: 3 }> {
  const binding = await (bindingPromise ??= loadBinding());
  return { target: binding.target, napi: 3 };
}

export async function nativeExportPublisher(): Promise<NativeExportPublisher> {
  const binding = await (bindingPromise ??= loadBinding());
  if (typeof binding.beginExport !== 'function' || typeof binding.publishExportFile !== 'function' ||
      typeof binding.completeExport !== 'function' || typeof binding.closeExport !== 'function') {
    throw new NativeLockUnavailableError('Installed native addon lacks safe export publication support');
  }
  return binding;
}

function budget(value: number | undefined, fallback: number, minimum: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > 2 ** 31 - 1) throw new RangeError(`Native lock duration must be between ${minimum} and ${2 ** 31 - 1} milliseconds`);
  return result;
}

/** The caller supplies a stable absolute path outside the mutable worktree. */
export async function acquireNativeLock(path: string, options: NativeLockOptions = {}): Promise<NativeLockHandle | null> {
  if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('Native lock path must be absolute and contain no NUL');
  const timeoutMs = budget(options.timeoutMs, 5000, 0);
  const pollMs = budget(options.pollMs, 25, 1);
  const { signal } = options;
  signal?.throwIfAborted();
  const binding = await (bindingPromise ??= loadBinding());
  let handle: object;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    handle = binding.openLock(path);
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw new NativeLockUnavailableError('Cannot open the stable writer lock file', cause, 'open');
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try { binding.close(handle); }
    catch (cause) { throw new NativeLockUnavailableError('Cannot close the writer lock handle; this host must stop publishing', cause); }
  };
  const deadline = performance.now() + timeoutMs;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let acquired: boolean;
      try { acquired = binding.tryLock(handle); }
      catch (cause) { throw new NativeLockUnavailableError('The OS could not acquire the writer lock', cause); }
      if (acquired) {
        const guard = { get released() { return released; }, release };
        if (process.platform === 'win32') windowsSocketRemovers.set(guard, socketPath => {
          if (path !== `${socketPath}.bind.lock`) throw new NativeLockUnavailableError('The retained claim belongs to another IPC path');
          return binding.removeWindowsUnixSocket!(handle, socketPath);
        });
        return guard;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) { await release(); return null; }
      await delay(Math.min(pollMs, remaining), undefined, { signal });
    }
  } catch (error) {
    await release();
    throw error;
  }
}

export function tryAcquireNativeLock(path: string): Promise<NativeLockHandle | null> {
  return acquireNativeLock(path, { timeoutMs: 0 });
}

/** Named pipes share one kernel identity across homes and Windows sessions. */
export async function tryAcquireNativeIpcMutex(name: string): Promise<NativeLockHandle | null> {
  if (process.platform !== 'win32' || !/^[\\/]{2}[.?][\\/]pipe[\\/][^\\/]/i.test(name) || name.includes('\0')) throw new TypeError('Expected a Windows named-pipe address');
  const binding = await (bindingPromise ??= loadBinding());
  let handle: object;
  try { handle = binding.openIpcMutex!(name); }
  catch (cause) { throw new NativeLockUnavailableError('Cannot open the Windows IPC binding claim', cause); }
  let released = false;
  const release = async () => {
    if (released) return;
    try { binding.close(handle); }
    catch (cause) { throw new NativeLockUnavailableError('Cannot close the Windows IPC binding claim; this host must stop publishing', cause); }
    released = true;
  };
  try {
    if (binding.tryLock(handle)) return { get released() { return released; }, release };
    await release();
    return null;
  } catch (cause) {
    await release();
    throw new NativeLockUnavailableError('Cannot acquire the Windows IPC binding claim', cause);
  }
}

/** The native side requires the same still-held opaque file-lock handle. */
export function removeNativeWindowsUnixSocket(path: string, claim: NativeLockHandle): boolean {
  const remove = windowsSocketRemovers.get(claim);
  if (process.platform !== 'win32' || claim.released || !remove || !isAbsolute(path) || path.includes('\0')) {
    throw new NativeLockUnavailableError('Cannot remove an IPC socket without its retained binding claim');
  }
  try { return remove(path); }
  catch (cause) { throw new NativeLockUnavailableError('Cannot verify and remove the stale Windows IPC socket', cause); }
}
