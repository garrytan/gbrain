import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { removeNativeWindowsUnixSocket, tryAcquireNativeIpcMutex, tryAcquireNativeLock } from '../persistence/native-lock.ts';
import { windowsPipeName } from './windows-ipc.ts';

// Darwin sockaddr_un.sun_path is 104 bytes including the terminating NUL.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h
export const UNIX_SOCKET_PATH_MAX_BYTES = 103;
function pipe(path: string): boolean { return process.platform === 'win32' && /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(path); }
function systemRoot(): string { return process.platform === 'darwin' ? '/private/tmp' : '/tmp'; }
function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) throw new Error('Local Unix IPC requires a verified OS user.');
  return value;
}
function canonicalPath(path: string): string {
  let parent = resolve(dirname(path)); const suffix = [basename(path)];
  for (;;) {
    try { return join(realpathSync(parent), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error;
      suffix.unshift(basename(parent)); parent = dirname(parent);
    }
  }
}

/** Discovery is read-only and independent of HOME/TMPDIR and the database engine. */
export function localIpcSocketPath(legacyPath: string): string {
  if (process.platform === 'win32' || fallback(legacyPath)) return legacyPath;
  const canonical = canonicalPath(legacyPath);
  if (Buffer.byteLength(canonical) <= UNIX_SOCKET_PATH_MAX_BYTES) {
    return Buffer.byteLength(legacyPath) <= UNIX_SOCKET_PATH_MAX_BYTES ? legacyPath : canonical;
  }
  const digest = createHash('sha256').update(canonical).digest('hex');
  const path = join(systemRoot(), `gbi-${uid()}-${digest}`, 's');
  if (Buffer.byteLength(path) > UNIX_SOCKET_PATH_MAX_BYTES) throw new Error('Local IPC fallback exceeds the Unix socket path budget.');
  return path;
}
function fallback(path: string): boolean {
  return process.platform !== 'win32' && [systemRoot(), ...(process.platform === 'darwin' ? ['/tmp'] : [])].includes(dirname(dirname(path)))
    && /^gbi-\d+-[a-f0-9]{64}$/.test(basename(dirname(path))) && basename(path) === 's';
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

/** Validate private fallback entries before connect, probe, or bind; never repair a squatted directory. */
export function prepareLocalIpcPath(legacyPath: string, createParent = false, probe = false): string {
  const path = localIpcSocketPath(legacyPath);
  if (pipe(path)) return windowsPipeName(path);
  if (!fallback(path)) {
    if (createParent) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(dirname(path), 0o700);
    }
    return path;
  }
  const root = lstatSync(systemRoot());
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0
    || (root.mode & 0o022) !== 0 && (root.mode & 0o1000) === 0) throw new Error('Unsafe system directory for local IPC.');
  const parent = dirname(path);
  if (createParent) {
    try { mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  try {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid()
      || (directory.mode & 0o777) !== 0o700) throw new Error('Unsafe private directory for local IPC.');
  } catch (error) { if (missing(error) && !createParent) return path; throw error; }
  try {
    const socket = lstatSync(path);
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid()
      || !createParent && !probe && (socket.mode & 0o777) !== 0o600) throw new Error('Unsafe local IPC socket.');
  } catch (error) { if (!missing(error)) throw error; }
  return path;
}

/** A live server retains this kernel claim across probe/unlink/listen and until actual close. */
export async function claimLocalIpcBinding(legacyPath: string): Promise<{ socketPath: string; release(): Promise<void>; removeStaleWindowsSocket?(): void } | null> {
  const socketPath = prepareLocalIpcPath(legacyPath, true);
  // Bun's older Windows pipe listener misclassifies a competing bind and can
  // crash during its failed-listen cleanup. Claim before any probe or listen.
  if (pipe(socketPath)) {
    const lock = await tryAcquireNativeIpcMutex(windowsPipeName(socketPath));
    return lock ? { socketPath, release: () => lock.release() } : null;
  }
  const lock = await tryAcquireNativeLock(`${resolve(socketPath)}.bind.lock`);
  return lock ? { socketPath, release: () => lock.release(),
    ...(process.platform === 'win32' ? { removeStaleWindowsSocket: () => { removeNativeWindowsUnixSocket(resolve(socketPath), lock); } } : {}),
  } : null;
}

export function isWindowsIpcPipe(path: string): boolean { return pipe(path); }


/** Existing Unix socket permissions remain authoritative if a runtime loses the connect errno. */
export function unixSocketProbeState(path: string): 'socket' | 'missing' | 'other' | 'unknown' {
  try {
    if (!lstatSync(path).isSocket()) return 'other';
  } catch (error) { return missing(error) ? 'missing' : 'unknown'; }
  try { accessSync(path, constants.W_OK); }
  catch { return 'unknown'; }
  return 'socket';
}
