import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { removeNativeWindowsUnixSocket, tryAcquireNativeIpcMutex, tryAcquireNativeLock } from '../persistence/native-lock.ts';
import { windowsPipeName } from './windows-ipc.ts';

// Darwin sockaddr_un.sun_path is 104 bytes including the terminating NUL.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h
export const UNIX_SOCKET_PATH_MAX_BYTES = 103;
// Windows afunix.sys sockaddr_un.sun_path is 108 bytes including the
// terminating NUL; Bun copies the path into it as UTF-8, so a non-ASCII
// profile or data-dir path costs more bytes than characters.
export const WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES = 107;
const PIPE_PREFIX = /^[\\/]{2}[.?][\\/]pipe[\\/]/i;
function pipe(path: string): boolean { return process.platform === 'win32' && PIPE_PREFIX.test(path); }
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

/**
 * Discovery is read-only and independent of HOME/TMPDIR and the database
 * engine. Every caller (serve, hooks, reflex, delegates, bootstrap verify)
 * derives its path here, so server and client agree on the fallback.
 *
 * POSIX: a path over the Unix byte budget moves to the private
 * `/tmp/gbi-<uid>-<sha256>/s` fallback. Windows (#6573): a PGLite data-dir
 * socket (`<data dir>\.gbrain-<kind>.sock`) over the afunix budget moves to
 * the per-user run dir, `%USERPROFILE%\.gbrain\run\<kind>-<hash12(canonical
 * data dir)>.sock`, the scheme Postgres brains use; the turn_context secret
 * stays `.gbrain-ipc-secret` in the data dir. A path that is still too long
 * there is reported by `localIpcPathTooLong` (`ipc_path_too_long`).
 */
export function localIpcSocketPath(legacyPath: string): string {
  if (process.platform === 'win32') return windowsLocalIpcSocketPath(legacyPath, windowsProfileDir(), canonicalPath);
  if (fallback(legacyPath)) return legacyPath;
  const canonical = canonicalPath(legacyPath);
  if (Buffer.byteLength(canonical) <= UNIX_SOCKET_PATH_MAX_BYTES) {
    return Buffer.byteLength(legacyPath) <= UNIX_SOCKET_PATH_MAX_BYTES ? legacyPath : canonical;
  }
  const digest = createHash('sha256').update(canonical).digest('hex');
  const path = join(systemRoot(), `gbi-${uid()}-${digest}`, 's');
  if (Buffer.byteLength(path) > UNIX_SOCKET_PATH_MAX_BYTES) throw new Error('Local IPC fallback exceeds the Unix socket path budget.');
  return path;
}
function windowsProfileDir(): string { return process.env.USERPROFILE || homedir(); }

/**
 * The Windows socket path for `legacyPath`: the data-dir path when it fits
 * afunix, else the per-user run-dir path for a `.gbrain-<kind>.sock` socket.
 * Any other path (a named pipe, a Postgres run-dir socket) is returned as is.
 * Pure over its inputs so the selection is testable off Windows.
 */
export function windowsLocalIpcSocketPath(legacyPath: string, profileDir: string, canonical: (path: string) => string): string {
  if (PIPE_PREFIX.test(legacyPath)) return legacyPath;
  if (Buffer.byteLength(legacyPath, 'utf8') <= WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES) return legacyPath;
  const kind = /^\.gbrain-([a-z]+)\.sock$/.exec(win32.basename(legacyPath))?.[1];
  if (!kind) return legacyPath;
  const dataDir = win32.dirname(canonical(legacyPath)).toLowerCase();
  const key = createHash('sha256').update(dataDir).digest('hex').slice(0, 12);
  return win32.join(profileDir, '.gbrain', 'run', `${kind}-${key}.sock`);
}

/** #6573: the resolved socket path, when it is still over this platform's AF_UNIX byte budget. */
export function localIpcPathTooLong(legacyPath: string): { path: string; bytes: number; limit: number } | null {
  let path: string;
  try { path = localIpcSocketPath(legacyPath); }
  catch { return { path: legacyPath, bytes: Buffer.byteLength(legacyPath, 'utf8'), limit: UNIX_SOCKET_PATH_MAX_BYTES }; }
  if (pipe(path)) return null;
  const limit = process.platform === 'win32' ? WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES : UNIX_SOCKET_PATH_MAX_BYTES;
  const bytes = Buffer.byteLength(path, 'utf8');
  return bytes > limit ? { path, bytes, limit } : null;
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
export async function claimLocalIpcBinding(legacyPath: string): Promise<{ socketPath: string; release(): Promise<void>;
  /** Windows only: verifies the leaf's AF_UNIX reparse tag through the retained claim and deletes it; false when the leaf is not such a socket (left in place). */
  removeStaleWindowsSocket?(): boolean } | null> {
  const socketPath = prepareLocalIpcPath(legacyPath, true);
  // Bun's older Windows pipe listener misclassifies a competing bind and can
  // crash during its failed-listen cleanup. Claim before any probe or listen.
  if (pipe(socketPath)) {
    const lock = await tryAcquireNativeIpcMutex(windowsPipeName(socketPath));
    return lock ? { socketPath, release: () => lock.release() } : null;
  }
  const lock = await tryAcquireNativeLock(`${resolve(socketPath)}.bind.lock`);
  return lock ? { socketPath, release: () => lock.release(),
    ...(process.platform === 'win32' ? { removeStaleWindowsSocket: () => removeNativeWindowsUnixSocket(resolve(socketPath), lock) } : {}),
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
