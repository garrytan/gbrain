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
 *   owner -> client  { t: 'bye' }                                   multi-user owner only, last frame as it hands the brain
 *                                                                    over: it read nothing after it, so a call still unanswered
 *                                                                    never ran and the client sends it to the next owner
 *                                                                    (`owner_handoff`); an older client ignores the frame
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

/**
 * Protocol v3 (docs/designs/rust-engine/multi-user-server.md, "M1 as built"; interface I-7). Spoken only with
 * multi-user Rust on (multiuser.ts); off, a v3 hello gets the v2 refusal above. A v3 hello names both `v` and
 * `version`, so a v2 owner answers it with its own hello and closes, and the client names both versions.
 *
 *   client -> server  { t: 'hello', v: 3, version: 3, caps, auth?: { scheme: 'bearer', token } }
 *   server -> client  { t: 'hello', v: 3, version: 3, pid, kind, capabilities, serve, caps, server_id }
 *   client -> server  call/fn frames add `req` (UUID v7, reused on a resend), `retry` (true on a resend), `remote`,
 *                     `min_position` (`cp1:<sequence>.<index>`), `txn` (a transaction id the server gave), `ph`
 *                     (a hash of member and arguments, for idempotency conflicts)
 *   server -> client  result frames add `position` ({ sequence, index }) for writes, `cid` (correlation id) for errors
 *   server -> client  { t: 'cbcall', id, cb, key, args }    a callback of call `id` that returns a value
 *   client -> server  { t: 'cbresult', cb, ok, value | error }
 *   client -> server  { t: 'txn', id, op: 'begin' | 'commit' | 'rollback', txn?, read_only?, rerun_of? }   (cap `txn`)
 *                     `rerun_of` (begin, top level): the id of this connection's transaction that lost its commit and that
 *                     this begin runs again; the server starts it with that run's lost keys and age. An unknown id is ignored.
 *
 * Over TCP each frame is a u32 big-endian length, then the JSON header, then `tail_len` bytes of binary tail when the
 * header names one (served/framing.ts). The Unix socket keeps JSON lines. Unknown top-level fields are ignored by
 * both decoders; an unknown value tag refuses.
 */
export const OWNER_IPC_VERSION_V3 = 3;

/** What a v3 server offers; a session uses the intersection with the client's list. */
export const SERVED_SERVER_CAPS = ['request_ids', 'positions', 'whole_ops', 'binary_tail', 'remote_check', 'callbacks', 'txn'] as const;
export type ServedCap = typeof SERVED_SERVER_CAPS[number];

export interface ServedHello extends OwnerHello {
  v: 3;
  caps: string[];
  /** A random id of this server process, so a client can tell a restarted server from the one it lost. */
  server_id: string;
}

/** The I-2 position of a commit; ordered by (sequence, index). */
export interface CommitPositionWire { sequence: number; index: number }

const POSITION_TOKEN = /^cp1:(\d{1,20})\.(\d{1,10})$/;
const U32_MAX = 0xffff_ffff;

/** Parses a read token `cp1:<sequence>.<index>`; null when it is not one (checked before any wait). */
export function parsePositionToken(token: unknown): CommitPositionWire | null {
  if (typeof token !== 'string') return null;
  const m = POSITION_TOKEN.exec(token);
  if (!m) return null;
  const sequence = Number(m[1]);
  const index = Number(m[2]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(index) || index > U32_MAX) return null;
  return { sequence, index };
}

export function positionToken(position: CommitPositionWire): string {
  return `cp1:${position.sequence}.${position.index}`;
}

/** Negative when `a` is before `b`, zero when equal. */
export function comparePositions(a: CommitPositionWire, b: CommitPositionWire): number {
  return a.sequence !== b.sequence ? a.sequence - b.sequence : a.index - b.index;
}
