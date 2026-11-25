/**
 * The uid of the process on the other end of a connected Unix socket, read
 * from the kernel: getsockopt(SO_PEERCRED) on Linux, getpeereid() on macOS,
 * both through bun:ffi on the socket's file descriptor. Other platforms (and
 * Linux architectures whose SO_PEERCRED constant differs) report unsupported,
 * and the serve then refuses to open the CLI socket at all (fail closed).
 *
 * Shared by the warm CLI socket (src/core/cli-socket/, through its peer-cred.ts re-export) and the Rust engine's
 * owner socket (src/core/rust-engine/owner-ipc/). It lives outside cli-socket/ so a serve with the CLI socket off
 * loads no cli-socket module (test/serve-cli-socket-off.test.ts) even though the owner socket checks peers.
 */
import type { Socket } from 'node:net';

export type PeerUidReader = (fd: number) => number | null;

export type PeerCredSupport = { ok: true; read: PeerUidReader } | { ok: false; reason: string };

let cached: PeerCredSupport | undefined;

function linuxReader(): PeerCredSupport {
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    return { ok: false, reason: `SO_PEERCRED is not wired for linux/${process.arch}` };
  }
  const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const SOL_SOCKET = 1;
  const SO_PEERCRED = 17;
  for (const lib of ['libc.so.6', 'libc.so', `libc.musl-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1`]) {
    try {
      const { symbols } = dlopen(lib, { getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
      return { ok: true, read: (fd) => {
        const ucred = new Int32Array(3);
        const length = new Uint32Array([12]);
        if (symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(ucred), ptr(length)) !== 0 || length[0] !== 12) return null;
        return ucred[1]! >>> 0;
      } };
    } catch { /* try the next libc spelling */ }
  }
  return { ok: false, reason: 'libc could not be loaded through bun:ffi' };
}

function darwinReader(): PeerCredSupport {
  const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  try {
    const { symbols } = dlopen('libSystem.B.dylib', { getpeereid: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
    return { ok: true, read: (fd) => {
      const uid = new Uint32Array(1);
      const gid = new Uint32Array(1);
      return symbols.getpeereid(fd, ptr(uid), ptr(gid)) === 0 ? uid[0]! : null;
    } };
  } catch {
    return { ok: false, reason: 'libSystem could not be loaded through bun:ffi' };
  }
}

/** The platform's peer-credential reader, resolved once per process. */
export function peerCredSupport(): PeerCredSupport {
  if (cached) return cached;
  try {
    if (typeof Bun === 'undefined') cached = { ok: false, reason: 'peer credentials need the Bun runtime (bun:ffi)' };
    else if (process.getuid === undefined) cached = { ok: false, reason: 'this platform has no POSIX uid' };
    else if (process.platform === 'linux') cached = linuxReader();
    else if (process.platform === 'darwin') cached = darwinReader();
    else cached = { ok: false, reason: `no peer-credential call is wired for ${process.platform}` };
  } catch (error) {
    cached = { ok: false, reason: `peer credentials unavailable: ${(error as Error).message}` };
  }
  return cached;
}

/** The connected socket's file descriptor, or null when the runtime does not expose one. */
export function socketFd(socket: Socket): number | null {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  return typeof fd === 'number' && Number.isInteger(fd) && fd >= 0 ? fd : null;
}

/** The peer's uid, or null when it cannot be read (the caller treats that as a rejection). */
export function peerUid(socket: Socket, read: PeerUidReader): number | null {
  const fd = socketFd(socket);
  if (fd === null) return null;
  try { return read(fd); } catch { return null; }
}
