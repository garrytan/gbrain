/**
 * Frames of the Rust engine owner socket. One persistent connection per client process carries many calls at once:
 * each frame is one JSON object on one line, and every call has an id the reply and any cancel name.
 *
 *   client -> owner  { t: 'hello', version }                       first frame; the owner answers with its hello
 *   client -> owner  { t: 'call', id, member, args, deadline_at?, read_deadline_at?, access? }  one BrainEngine member
 *   client -> owner  { t: 'fn', id, name, args, deadline_at?, read_deadline_at?, access? }     one whole operation (whole-op.ts)
 *
 * `deadline_at` (epoch ms) is the caller's deadline: the owner ends the call with `timeout` there, queued or running;
 * a running call is not interrupted, so that timeout's outcome is unknown.
 * A started write holds back, on every connection, the later calls of the members that confirm it (also after its
 * caller stopped waiting, which the owner may learn late) (confirming-reads.ts `membersWaitingFor`) until it ends, so a confirming read
 * answers with the final state; a held call that reaches its deadline ends `owner_unavailable` (`earlier_call_running`).
 * `read_deadline_at` is the caller's read deadline (read-deadline.ts), restored around the call in the owner.
 * `access` is the caller's access record (search/private-visibility.ts CallerAccess), absent when it had none; the owner
 * runs the call under it, so a restricted caller (a labelled-only member, a remote grant) reads no more over the socket
 * than in process. The socket is owner-only (mode 0600), so a client is as trusted as the CLI that could open the brain.
 *   client -> owner  { t: 'cancel', id }                            the caller's AbortSignal fired
 *   owner -> client  { t: 'hello', version, pid, kind, capabilities, serve }
 *   owner -> client  { t: 'cb', id, key, args }                     a void notification callback of call `id`
 *   owner -> client  { t: 'result', id, ok, value | error }         the call's end; exactly one per call
 *   owner -> client  { t: 'refused', error }                        the connection is refused before its hello
 *                                                                    (another OS user, or too many connections); it closes
 *
 * Each call needs a hello of OWNER_IPC_VERSION first, an id not open on its connection, and a list as `args`; the owner
 * refuses anything else with `owner_ipc_protocol` and runs nothing. A hello of another version gets the owner's hello
 * (so the client can name both versions) and then the connection closes.
 * Values are tagged (codec.ts); a tag the decoder does not know, or a segmented-body guard outside a guarded body
 * field, fails the decode (`owner_ipc_protocol`), never a plain object.
 * A closed connection ends every call on it: the owner aborts them, and the client rejects them with
 * `owner_unavailable`. Frames over OWNER_IPC_MAX_FRAME_BYTES are refused (`response_too_large` for a reply).
 * The owner bounds its memory across every client: past OWNER_IPC_MAX_QUEUED waiting calls, OWNER_IPC_MAX_INFLIGHT_BYTES
 * of held call frames, or OWNER_IPC_MAX_CONNECTIONS connections it refuses with `owner_busy` (retryable) and runs nothing.
 */
import type { Socket } from 'node:net';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Wire } from './codec.ts';

/**
 * 2: values may carry the segmented-body guard (`{ $t: 'guard', site }`), which a version 1 decoder read as a plain
 * object, and a decoder refuses any tag it does not know. Version 1 and version 2 peers refuse each other at the hello.
 */
export const OWNER_IPC_VERSION = 2;
/** The largest frame either side sends or accepts. */
export const OWNER_IPC_MAX_FRAME_BYTES = 128 * 1024 * 1024;
/** Calls the owner runs at once across every client; more wait in a FIFO queue within their own deadline. */
export const OWNER_IPC_DEFAULT_PERMITS = 32;
/** Calls that may wait in the owner queue at once, across every client; one more is refused with `owner_busy`. */
export const OWNER_IPC_MAX_QUEUED = 1024;
/** Bytes of call frames the owner holds at once (queued and running calls); a frame past it is refused with `owner_busy`. */
export const OWNER_IPC_MAX_INFLIGHT_BYTES = 256 * 1024 * 1024;
/** Client connections the owner keeps open at once; one more gets a `refused` frame and is closed. */
export const OWNER_IPC_MAX_CONNECTIONS = 256;
/** Refusals the owner holds open at once, and how long it waits for a refused peer to close before it destroys the socket. */
export const OWNER_IPC_REFUSED_LIMIT = 64;
export const OWNER_IPC_REFUSED_DRAIN_MS = 1000;

/**
 * The store directory with symlinks resolved, so every alias of one brain names one owner lock and one socket. A
 * directory not created yet resolves through its nearest existing ancestor (the rule of pglite-lock.ts `canonicalPath`,
 * which keys the PGLite lock the same way).
 */
export function canonicalDatabasePath(databasePath: string): string {
  const absolute = resolve(databasePath);
  const missing: string[] = [];
  for (let at = absolute; ; at = dirname(at)) {
    try { return join(realpathSync(at), ...missing.reverse()); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) return absolute;
      missing.push(basename(at));
    }
  }
}

/** The owner lock: a kernel lock beside the store directory, dropped by the OS when the owner process dies. */
export function ownerLockPath(databasePath: string): string {
  return `${canonicalDatabasePath(databasePath)}.gbrain-owner.lock`;
}

/** The discovery path of the owner socket (ipc-path.ts maps a path over the socket byte budget to a private one). */
export function ownerSocketPath(databasePath: string): string {
  return join(canonicalDatabasePath(databasePath), '.gbrain-owner.sock');
}

export interface OwnerHello {
  t: 'hello';
  version: number;
  pid: number;
  kind: string;
  capabilities: string[];
  /** True when the owner is a `gbrain serve`, which also answers whole MCP operations on the persistence socket. */
  serve: boolean;
}

export type ClientFrame =
  | { t: 'hello'; version: number }
  | { t: 'call'; id: number; member: string; args: Wire; deadline_at?: number; read_deadline_at?: number; access?: Wire }
  | { t: 'fn'; id: number; name: string; args: Wire; deadline_at?: number; read_deadline_at?: number; access?: Wire }
  | { t: 'cancel'; id: number };

export type OwnerFrame =
  | OwnerHello
  | { t: 'cb'; id: number; key: string; args: Wire }
  | { t: 'result'; id: number; ok: true; value: Wire }
  | { t: 'result'; id: number; ok: false; error: Wire }
  | { t: 'refused'; error: Wire };

/** Serializes a frame; null when it is over the frame cap. */
export function frameLine(frame: object, maxBytes = OWNER_IPC_MAX_FRAME_BYTES): string | null {
  const line = JSON.stringify(frame) + '\n';
  return Buffer.byteLength(line) > maxBytes ? null : line;
}

/**
 * Reads newline-delimited frames from a socket. A frame over the cap (partial or finished), or a line that is not JSON, calls
 * `onBad` once and the socket is destroyed: the peer is a different release or not a gbrain process. `onFrame` gets each
 * frame with its size in bytes, newline included, so the owner can bound the bytes it holds.
 */
export function readFrames(socket: Socket, onFrame: (frame: Record<string, unknown>, bytes: number) => void, onBad: (why: string) => void,
  maxBytes = OWNER_IPC_MAX_FRAME_BYTES): void {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let bad = false;
  const fail = (why: string) => {
    if (bad) return;
    bad = true;
    onBad(why);
    socket.destroy();
  };
  socket.on('data', (data: Buffer | string) => {
    if (bad) return;
    let chunk = typeof data === 'string' ? Buffer.from(data) : data;
    for (;;) {
      const newline = chunk.indexOf(10);
      if (newline === -1) {
        bytes += chunk.length;
        if (bytes > maxBytes) { fail('frame_too_large'); return; }
        if (chunk.length) chunks.push(chunk);
        return;
      }
      // The cap counts the newline, as frameLine does: a finished frame over it is refused like a partial one.
      bytes += newline + 1;
      if (bytes > maxBytes) { fail('frame_too_large'); return; }
      chunks.push(chunk.subarray(0, newline));
      const line = Buffer.concat(chunks).toString('utf8');
      const size = bytes;
      chunks = [];
      bytes = 0;
      chunk = chunk.subarray(newline + 1);
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { fail('malformed_frame'); return; }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { fail('malformed_frame'); return; }
      onFrame(frame as Record<string, unknown>, size);
      if (bad || socket.destroyed) return;
    }
  });
}
