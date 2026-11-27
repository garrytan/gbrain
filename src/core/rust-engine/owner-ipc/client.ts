/**
 * The client side of the Rust engine owner socket. A process that opens a Rust brain another process owns connects
 * here (election.ts) and its engine sends every forwarded BrainEngine member to the owner (routes.ts). One persistent
 * connection carries all of the process's calls at once.
 *
 * - A call carries the caller's deadline (the read deadline and the statement deadline of its async context) as
 *   `deadline_at`; the owner ends it there with `timeout`, queued (`not_started`) or running (`outcome_unknown`: a
 *   running write is not interrupted). The client keeps a short grace timer of its own in case the owner is stuck;
 *   it re-arms past 2^31-1 ms (timer.ts), so a deadline weeks away never ends the call at once.
 * - An owner hello of another protocol version fails the connect with `owner_ipc_protocol` (`version_mismatch`), which
 *   the election does not retry. An answer this process cannot decode fails only its call (`result_undecodable`).
 * - The caller's access record (`callerAccessRecord()`) goes with each call as `access`, so the owner reads as that caller.
 * - The caller's AbortSignals (the request signal of request-signal.ts and any signal argument) end the call at once
 *   with `cancelled`, or `timeout` when the signal's reason is a TimeoutError, and tell the owner to stop it.
 * - When the owner goes away, every call in flight ends with `owner_unavailable` (`outcome_unknown`) and every later
 *   call with `owner_unavailable` (`not_sent`), unless the engine passed `rejoin` (RustEngine does): then the next call
 *   runs the election again and goes to the new owner, or runs in this process when it became the owner.
 * - Before it connects, the client checks the socket: a socket file owned by this OS user with no group or other
 *   permission bits, else `owner_ipc_peer_refused` (`socket_owner`, `socket_mode`). After it connects, it reads the
 *   owner's uid from the kernel and refuses any other (`peer_uid`). An owner that refuses the connection (another user,
 *   or `owner_busy` with too many connections) sends a `refused` frame, and the connect rejects with its error. None
 *   of these is retried by the election. Where peer uids cannot be read (Windows, other Unixes) only the socket checks
 *   run.
 * - A remote caller (callerIsRemote) sends only the read members of OWNER_IPC_REMOTE_READS; any other member is
 *   refused here with `engine_capability_missing` and nothing is sent. A local caller's calls are unchanged.
 * - The socket holds the event loop open only while a call is in flight, so a finished CLI command exits.
 */
import net, { type Socket } from 'node:net';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { engineKey } from '../../engine-key.ts';
import { requestSignal } from '../../request-signal.ts';
import { OperationError } from '../../ops/contract.ts';
import { readDeadline } from '../../read-deadline.ts';
import { currentStatementDeadline } from '../../statement-deadline.ts';
import { callerAccessRecord } from '../../search/private-visibility.ts';
import { isRemoteCaller } from '../../remote-caller.ts';
import { currentSubmissionAuthority } from '../../minions/submission-authority.ts';
import { currentVerifiedLocalWriter } from '../../persistence/identity.ts';
import { isWindowsIpcPipe, prepareLocalIpcPath } from '../../context/ipc-path.ts';
import { peerCredSupport, peerUid, type PeerCredSupport } from '../../peer-cred.ts';
import type { Capability } from '../../engine-capabilities.ts';
import { capabilityMissing } from '../errors.ts';
import { RUST_ENGINE_MEMBERS } from '../members.ts';
import { STORE_MEMBERS } from '../store-members/index.ts';
import { decodeError, decodeValue, encodeValue, OwnerIpcEncodeError, type Wire } from './codec.ts';
import {
  OWNER_IPC_MAX_FRAME_BYTES, OWNER_IPC_VERSION, frameLine, ownerSocketPath, readFrames, type OwnerHello,
} from './protocol.ts';
import {
  OWNER_IPC_CALLBACK_KEYS, OWNER_IPC_REMOTE_READS, OWNER_IPC_ROUTES, ownerCallCancelled, ownerCallTimeout, ownerGone, ownerIpcProtocol, ownerIpcRefusal,
  ownerPeerRefused, isOwnerHandoff, ownerHandoff, ownerMemberOnlyReads,
} from './routes.ts';
import { rustMultiuserFromEnv } from '../multiuser-switch.ts';
import { ownerEngineCapabilities, remoteFrameMark } from './remote-check.ts';
import { HELD_ROW_HOOK, HELD_ROW_MEMBERS, HELD_ROW_TAG, withHeldRowHook } from './held-row.ts';
import { setDeadlineTimer, type DeadlineTimer } from './timer.ts';

/** How long past `deadline_at` the client waits for the owner's own timeout before it ends the call itself. */
const CLIENT_DEADLINE_GRACE_MS = 2_000;

export interface OwnerConnection {
  readonly hello: OwnerHello;
  readonly closed: boolean;
  /** Sends one member call (`call`) or one whole operation (`fn`) and resolves with the owner's result. */
  request(kind: 'call' | 'fn', member: string, args: unknown[]): Promise<unknown>;
  /** Number of calls waiting for the owner; tests read it to prove nothing is left behind. */
  pending(): number;
  close(): void;
}

interface Pending {
  member: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  callbacks: Map<string, (...args: unknown[]) => void>;
  cleanup(): void;
}

const connections = new WeakMap<object, OwnerConnection>();
/**
 * Waits until the old owner has closed `connection` (it does right after it finished its handoff), at most
 * HANDOFF_CLOSE_WAIT_MS, so the election that follows looks for the next owner, not the one leaving.
 */
export const HANDOFF_CLOSE_WAIT_MS = 2_000;
export async function untilOwnerClosed(connection: OwnerConnection): Promise<void> {
  const until = Date.now() + HANDOFF_CLOSE_WAIT_MS;
  while (!connection.closed && Date.now() < until) await new Promise(r => setTimeout(r, 10));
}

/** The election rerun of the engine a connection serves (InstallOwnerClientOptions.rejoin). */
const rejoins = new WeakMap<OwnerConnection, () => Promise<void>>();
/** countPagesBy grouper functions the client resolved to a fixed table; they cross the socket as that table. */
const grouperTables = new WeakMap<object, { types: string[]; groups: string[] }>();

/** The fixed table a countPagesBy grouper crosses as (protocol v3 client, served/client.ts), or undefined. */
export function grouperTableOf(fn: object): { types: string[]; groups: string[] } | undefined {
  return grouperTables.get(fn);
}

/** The owner connection an engine reaches its brain through, or undefined when the engine owns it (or is no client). */
export function ownerConnectionFor(engine: object): OwnerConnection | undefined {
  return connections.get(engineKey(engine));
}

/** The election rerun registered for `connection`, if its engine takes the brain over when the owner goes. */
export function ownerRejoinFor(connection: OwnerConnection): (() => Promise<void>) | undefined {
  return rejoins.get(connection);
}

/**
 * True when the code running now serves a caller that is not the trusted local CLI: an agent-facing MCP request
 * (remote-caller.ts), a job whose submission authority is not the application, or a remote verified writer. The owner
 * socket does not carry that authority, so such a caller's writes and whole operations are not sent.
 */
export function callerIsRemote(): boolean {
  const authority = currentSubmissionAuthority();
  return isRemoteCaller() || (authority !== undefined && authority !== null && authority.kind !== 'application')
    || currentVerifiedLocalWriter()?.remote === true;
}

function lastKey(path: string): string {
  const at = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['));
  return at === -1 ? path : path.slice(at + 1).replace(/\]$/, '');
}

export function callDeadline(): { deadlineAt?: number; readDeadlineAt?: number } {
  const read = readDeadline();
  const statement = currentStatementDeadline()?.deadlineAt ?? undefined;
  const candidates = [read, statement].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return {
    ...(candidates.length ? { deadlineAt: Math.min(...candidates) } : {}),
    ...(typeof read === 'number' ? { readDeadlineAt: read } : {}),
  };
}

function abortError(member: string, signal: AbortSignal, startedAt: number, sent: boolean): Error {
  const reason = signal.reason as { name?: unknown } | undefined;
  return reason?.name === 'TimeoutError'
    ? ownerCallTimeout(member, Date.now() - startedAt, sent ? 'sent' : 'not_sent')
    : ownerCallCancelled(member, sent);
}

/** The signals that end a call: the request's own and any `AbortSignal` in its arguments (looked for three levels deep). */
function callerSignals(args: unknown[]): AbortSignal[] {
  const found = new Set<AbortSignal>();
  const ambient = requestSignal();
  if (ambient) found.add(ambient);
  const walk = (value: unknown, depth: number): void => {
    if (value instanceof AbortSignal) { found.add(value); return; }
    if (depth === 0 || value === null || typeof value !== 'object') return;
    for (const inner of Array.isArray(value) ? value : Object.values(value)) walk(inner, depth - 1);
  };
  walk(args, 3);
  return [...found];
}

/**
 * What the caller asked for, taken before a wait, so the check the function returns can end the call afterwards: it
 * throws the call's own `cancelled` or `timeout` (`not_sent`) once a signal in its arguments or on its request has
 * aborted, or its deadline has passed. A call that waits for an election to settle, and then runs in process where
 * nothing else checks it, calls this first.
 */
export function callEndCheck(member: string, args: unknown[]): () => void {
  const startedAt = Date.now();
  const signals = callerSignals(args);
  const { deadlineAt } = callDeadline();
  return () => {
    for (const signal of signals) if (signal.aborted) throw abortError(member, signal, startedAt, false);
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw ownerCallTimeout(member, Date.now() - startedAt, 'not_sent');
  };
}

/**
 * Waits for `wait` (an election or a store open this call cannot start without) for only as long as the caller still
 * wants the call: a signal in its arguments or on its request that aborts, or its deadline, ends the call at once with
 * its own `cancelled` or `timeout` (`not_sent`), while the wait itself goes on for the other callers that share it.
 */
export function untilCallEnds<T>(member: string, args: unknown[], wait: Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const signals = callerSignals(args);
  const { deadlineAt } = callDeadline();
  return new Promise<T>((resolve, reject) => {
    let timer: DeadlineTimer | undefined;
    const listeners: Array<() => void> = [];
    const finish = (settle: () => void) => {
      timer?.clear();
      for (const remove of listeners) remove();
      listeners.length = 0;
      settle();
    };
    for (const signal of signals) {
      if (signal.aborted) { finish(() => reject(abortError(member, signal, startedAt, false))); wait.catch(() => undefined); return; }
      const onAbort = () => finish(() => reject(abortError(member, signal, startedAt, false)));
      signal.addEventListener('abort', onAbort, { once: true });
      listeners.push(() => signal.removeEventListener('abort', onAbort));
    }
    if (deadlineAt !== undefined) {
      timer = setDeadlineTimer(() => finish(() => reject(ownerCallTimeout(member, Date.now() - startedAt, 'not_sent'))), deadlineAt - Date.now());
    }
    wait.then(value => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

/** A frame field as text for an error detail: scalars only, so a hostile object never runs its own conversion. */
function fieldText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).slice(0, 64) : typeof value;
}

export interface ConnectOwnerOptions {
  timeoutMs?: number;
  /** This process's uid and the peer-uid reader (default: the platform's); tests inject another user. */
  uid?: () => number | undefined;
  peerCred?: PeerCredSupport;
}

const octal = (mode: number) => `0${(mode & 0o777).toString(8).padStart(3, '0')}`;

/**
 * The socket file is this user's and no other user can open it, or the refusal that says why not. A missing socket
 * throws its ENOENT, which the election retries. Group or other bits on the socket are allowed only inside a directory
 * this user owns with none: the owner binds inside its private 0700 directory and narrows the socket to 0600 just after
 * listen, so a client that arrives in between is not refused.
 */
function socketFileProblem(socketPath: string, uid: number): Error | null {
  const stat = lstatSync(socketPath);
  if (!stat.isSocket()) return ownerPeerRefused('socket_owner', `path_is_not_a_socket socket_uid=${stat.uid} uid=${uid}`);
  if (stat.uid !== uid) return ownerPeerRefused('socket_owner', `socket_uid=${stat.uid} uid=${uid}`);
  if ((stat.mode & 0o077) === 0) return null;
  const dir = lstatSync(dirname(socketPath));
  if (dir.isDirectory() && dir.uid === uid && (dir.mode & 0o077) === 0) return null;
  return ownerPeerRefused('socket_mode', `mode=${octal(stat.mode)} dir_mode=${octal(dir.mode)} dir_uid=${dir.uid}`);
}

/**
 * Connects to the owner socket and reads its hello. Rejects with the socket error (ENOENT, ECONNREFUSED), a timeout,
 * `owner_ipc_peer_refused` when the socket or the owner is not this OS user's, or the error of an owner `refused` frame.
 */
export function connectOwner(legacySocketPath: string, opts: ConnectOwnerOptions = {}): Promise<OwnerConnection> {
  const socketPath = prepareLocalIpcPath(legacySocketPath, false, true);
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const uid = isWindowsIpcPipe(socketPath) || process.platform === 'win32' ? undefined : (opts.uid ?? (() => process.getuid?.()))();
  if (uid !== undefined) {
    try {
      const problem = socketFileProblem(socketPath, uid);
      if (problem) return Promise.reject(problem);
    } catch (error) { return Promise.reject(error); }
  }
  const peerCred = uid === undefined ? undefined : (opts.peerCred ?? peerCredSupport());
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let hello: OwnerHello | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('The brain owner did not answer its hello.'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    // Before the hello an error waits for the close: an owner that refused the connection sent a `refused` frame
    // first, and its error (not the EPIPE of our hello write) is the one the connect rejects with.
    let early: unknown;
    socket.once('error', error => { clearTimeout(timer); if (!hello) early ??= error; });
    socket.once('connect', () => {
      if (peerCred?.ok) {
        const peer = peerUid(socket, peerCred.read);
        if (peer !== uid) {
          clearTimeout(timer);
          socket.destroy();
          reject(ownerPeerRefused('peer_uid', `owner_uid=${peer ?? 'unreadable'} uid=${uid}`));
          return;
        }
      }
      socket.write(frameLine({ t: 'hello', version: OWNER_IPC_VERSION })!);
    });
    const pending = new Map<number, Pending>();
    let closed = false;
    // A multi-user owner's last frame when it hands the brain over: it read nothing after it, so a call still unanswered
    // (or sent after it) never ran, and ends `owner_handoff` for the next owner instead of `outcome_unknown`.
    let bye = false;
    let nextId = 1;
    const refresh = () => { if (pending.size) socket.ref(); else socket.unref(); };
    const send = (frame: object) => { if (!socket.destroyed) socket.write(frameLine(frame, Number.MAX_SAFE_INTEGER)!); };
    readFrames(socket, frame => {
      if (frame.t === 'refused') {
        if (hello) return;
        // The owner refused this connection before its hello (another user, too many connections); nothing was sent.
        clearTimeout(timer);
        try { early = decodeError(frame.error as Wire); }
        catch (cause) { early = ownerIpcProtocol('result_undecodable', null, `refused_frame ${cause instanceof Error ? cause.message : String(cause)}`); }
        reject(early);
        socket.destroy();
        return;
      }
      if (frame.t === 'hello') {
        if (hello) return;
        if (frame.version !== OWNER_IPC_VERSION) {
          // Another protocol version reads frames differently: no call is sent, and the election does not retry it.
          clearTimeout(timer);
          socket.destroy();
          reject(ownerIpcProtocol('version_mismatch', null,
            `client_version=${OWNER_IPC_VERSION} owner_version=${fieldText(frame.version)} owner_pid=${fieldText(frame.pid)}`));
          return;
        }
        hello = frame as unknown as OwnerHello;
        clearTimeout(timer);
        socket.on('error', () => { /* close ends the calls */ });
        resolve(connection);
        refresh();
        return;
      }
      if (frame.t === 'bye') { bye = true; return; }
      // Ids and keys are read as scalars only: an object field would run its own conversion and throw out of this callback.
      const call = typeof frame.id === 'number' ? pending.get(frame.id) : undefined;
      if (!call) return;
      if (frame.t === 'cb') {
        const fn = typeof frame.key === 'string' ? call.callbacks.get(frame.key) : undefined;
        try { if (fn) fn(...(decodeValue(frame.args as Wire) as unknown[])); } catch { /* a notification never fails the call */ }
        return;
      }
      if (frame.t !== 'result') return;
      pending.delete(frame.id as number);
      call.cleanup();
      refresh();
      // An answer this process cannot read fails only its own call; the connection and other calls go on.
      let decoded: unknown;
      try { decoded = frame.ok === true ? decodeValue(frame.value as Wire) : decodeError(frame.error as Wire); }
      catch (error) {
        call.reject(ownerIpcProtocol('result_undecodable', call.member, `id=${fieldText(frame.id)} ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (frame.ok === true) call.resolve(decoded);
      else call.reject(decoded);
    }, () => {}, OWNER_IPC_MAX_FRAME_BYTES);
    socket.once('close', () => {
      clearTimeout(timer);
      closed = true;
      if (!hello) { reject(early ?? Object.assign(new Error('The brain owner closed the connection before its hello.'), { code: 'ECONNRESET' })); return; }
      for (const call of pending.values()) { call.cleanup(); call.reject(bye ? ownerHandoff(call.member, hello.pid) : ownerGone(call.member, hello.pid, true)); }
      pending.clear();
    });

    const request = (kind: 'call' | 'fn', member: string, args: unknown[]): Promise<unknown> => {
      // A remote caller's write would run on the owner with the owner's authority; refuse it before anything is sent.
      if (kind === 'call' && !OWNER_IPC_REMOTE_READS.has(member) && callerIsRemote()) {
        return Promise.reject(ownerIpcRefusal(member, 'a remote caller\'s write is not sent to the brain owner'));
      }
      if (closed || !hello) return Promise.reject(ownerGone(member, hello?.pid ?? null, false));
      if (bye) return Promise.reject(ownerHandoff(member, hello.pid));
      const id = nextId++;
      const startedAt = Date.now();
      const callbacks = new Map<string, (...args: unknown[]) => void>();
      const signals = new Set<AbortSignal>();
      const ambient = requestSignal();
      if (ambient) signals.add(ambient);
      let wireArgs: Wire;
      try {
        wireArgs = encodeValue(args, {
          onSignal: signal => { signals.add(signal); return { $t: 'signal' }; },
          onFunction: (fn, path): Wire => {
            const table = grouperTables.get(fn);
            if (table) return { $t: 'fn', grouper: table };
            if (fn === HELD_ROW_HOOK) return HELD_ROW_TAG;
            const key = lastKey(path);
            if (!OWNER_IPC_CALLBACK_KEYS.has(key)) throw ownerIpcRefusal(member, `its argument ${path.replace(/^value/, 'args')} is a function, and functions do not cross the owner socket`);
            const k = String(callbacks.size);
            callbacks.set(k, fn as (...a: unknown[]) => void);
            return { $t: 'fn', k };
          },
        }, 'value');
      } catch (error) {
        if (error instanceof OwnerIpcEncodeError) return Promise.reject(ownerIpcRefusal(member, error.message.replace(/\.$/, '')));
        return Promise.reject(error);
      }
      for (const signal of signals) {
        if (signal.aborted) return Promise.reject(abortError(member, signal, startedAt, false));
      }
      const { deadlineAt, readDeadlineAt } = callDeadline();
      // The caller's access record (who it is, what it may read) goes with the call, so the owner reads as this caller.
      const record = callerAccessRecord();
      const access = record ? encodeValue(record) : undefined;
      const line = frameLine({ t: kind, id, [kind === 'fn' ? 'name' : 'member']: member, args: wireArgs,
        ...(deadlineAt !== undefined ? { deadline_at: deadlineAt } : {}),
        ...(readDeadlineAt !== undefined ? { read_deadline_at: readDeadlineAt } : {}),
        ...(access ? { access } : {}), ...remoteFrameMark(callerIsRemote(), hello.capabilities) });
      if (line === null) return Promise.reject(ownerIpcRefusal(member, `its arguments are larger than ${OWNER_IPC_MAX_FRAME_BYTES} bytes, the most the owner socket carries`));
      return new Promise((resolveCall, rejectCall) => {
        let grace: DeadlineTimer | undefined;
        const listeners: Array<[AbortSignal, () => void]> = [];
        const cleanup = () => {
          grace?.clear();
          for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
        };
        const endLocally = (error: unknown) => {
          if (!pending.delete(id)) return;
          cleanup();
          refresh();
          send({ t: 'cancel', id });
          rejectCall(error);
        };
        for (const signal of signals) {
          const listener = () => endLocally(abortError(member, signal, startedAt, true));
          signal.addEventListener('abort', listener, { once: true });
          listeners.push([signal, listener]);
        }
        if (deadlineAt !== undefined) {
          const ms = Math.max(0, deadlineAt - Date.now());
          grace = setDeadlineTimer(() => endLocally(ownerCallTimeout(member, ms, 'sent')), ms + CLIENT_DEADLINE_GRACE_MS);
        }
        pending.set(id, { member, resolve: resolveCall, reject: rejectCall, callbacks, cleanup });
        refresh();
        socket.write(line);
      });
    };

    const connection: OwnerConnection = {
      get hello() { return hello!; },
      get closed() { return closed; },
      request,
      pending: () => pending.size,
      close: () => { socket.destroy(); },
    };
  });
}

/**
 * Who owns a Rust brain, read from its owner socket's hello (the shape of pglite-lock.ts `inspectLockHolder`): held
 * with the owner's pid and whether it is a `gbrain serve`, or not held when nothing answers.
 */
export async function inspectRustOwner(databasePath: string, timeoutMs = 1_000): Promise<{
  held: boolean; pid?: number; serve?: boolean; subcommand?: string; kind?: string; capabilities?: string[];
}> {
  let connection: OwnerConnection;
  try { connection = await connectOwner(ownerSocketPath(databasePath), { timeoutMs }); }
  catch { return { held: false }; }
  const { pid, serve, kind, capabilities } = connection.hello;
  connection.close();
  return { held: true, pid, serve: serve === true, kind, capabilities: [...capabilities], ...(serve ? { subcommand: 'serve' } : {}) };
}

/**
 * True when a Rust brain's owner can serve the persistence socket: its engine reports `persistence_journal`. The
 * persistence provider runs SQL (persistence/context.ts, writer-versions.ts), so a Rust engine without that capability
 * would fail every call there; until it reports it, no persistence listener starts and callers use the engine path.
 */
export function rustOwnerServesPersistence(capabilities: Iterable<string> | undefined): boolean {
  return [...(capabilities ?? [])].includes('persistence_journal');
}

/**
 * The capability a member needs on a Rust owner that does not report it, or null when the call may be sent. Such a
 * member is refused here with the error the Rust engine gives in process (rust-engine.ts), so the client never asks
 * an owner for what it said it cannot do (executeRaw with no `raw_sql`). An owner of another kind (tests host PGLite)
 * is asked as before. A member the Rust store serves (store-members/) runs on the owner even when the rest of its
 * capability does not, exactly as it runs in the owner's own process.
 */
export function missingOnRustOwner(hello: { kind: string; capabilities: readonly string[] }, member: string): Capability | null {
  if (hello.kind !== 'rust' || member in STORE_MEMBERS) return null;
  const cls = (RUST_ENGINE_MEMBERS as Record<string, string>)[member];
  if (cls === undefined || cls === 'implemented') return null;
  return hello.capabilities.includes(cls) ? null : cls as Capability;
}

type EngineRecord = Record<string, unknown>;

/**
 * countPagesBy takes a synchronous grouper over the brain's page types. The client asks the owner for the per-type
 * counts, runs the grouper here, and sends its answer as a fixed table. A type created between the two calls maps to
 * itself (the same as a type the grouper leaves unchanged).
 */
async function countPagesByThroughOwner(connection: OwnerConnection, args: unknown[]): Promise<unknown> {
  const [query, grouper] = args;
  if (typeof grouper !== 'function') return connection.request('call', 'countPagesBy', args);
  const first = await connection.request('call', 'countPagesBy', [query]) as { bySourceType?: Array<{ type: string }> };
  const types = [...new Set((first.bySourceType ?? []).map(row => row.type))];
  const groups = (grouper as (types: string[]) => string[])(types);
  const table = (input: string[]) => input.map(type => { const at = types.indexOf(type); return at === -1 ? type : groups[at]!; });
  grouperTables.set(table, { types, groups: [...groups] });
  return connection.request('call', 'countPagesBy', [query, table]);
}

export interface InstallOwnerClientOptions {
  /**
   * Runs the election again once the owner has gone (RustEngine: the engine becomes the new owner or a client of it,
   * and replaces the installed members). A call made after the connection closed awaits it, then runs on whatever the
   * engine now has; a call it cannot place still ends `owner_unavailable` (`not_sent`).
   */
  rejoin?: () => Promise<void>;
}

/**
 * Makes `engine` a client of the owner on `connection`: each forwarded member becomes an own property that sends the
 * call, each refused member rejects with `engine_capability_missing`, and the engine's capability set mirrors the
 * owner's. Returns the function that undoes it (on disconnect or when the owner goes away), which also restores the
 * engine's own capability set.
 */
export function installOwnerClient(engine: object, connection: OwnerConnection, opts: InstallOwnerClientOptions = {}): () => void {
  const record = engine as EngineRecord;
  const installed: string[] = [];
  const { rejoin } = opts;
  for (const [member, route] of Object.entries(OWNER_IPC_ROUTES)) {
    if (route === 'local') continue;
    const missing = missingOnRustOwner(connection.hello, member);
    const direct = missing !== null
      ? () => Promise.reject(capabilityMissing(missing, member))
      : route === 'refuse'
      ? () => Promise.reject(ownerIpcRefusal(member, 'transactions, reserved connections and engine callbacks do not cross the owner socket'))
      : member === 'countPagesBy'
        ? (...args: unknown[]) => countPagesByThroughOwner(connection, args)
        : HELD_ROW_MEMBERS.has(member)
        ? (...args: unknown[]) => withHeldRowHook(member, args, sent => connection.request('call', member, sent))
        : (...args: unknown[]) => connection.request('call', member, args);
    const value = !rejoin ? direct : async function viaOwner(...args: unknown[]): Promise<unknown> {
      if (connection.closed) {
        // Once this process is the owner the call runs in process, where nothing else checks it, so a call cancelled or
        // past its deadline during the election must end here.
        const stillWanted = callEndCheck(member, args);
        // An election that fails ends this call with its own error (a store that would not open, a disconnect that won),
        // not with the `engine_closed` the emptied engine would give; a call the election could not place still ends
        // `owner_unavailable` (`not_sent`) below. A call cancelled or past its deadline while the election still runs ends
        // at once; the election goes on for the calls that share it.
        const failure = await untilCallEnds(member, args, rejoin()).then(() => null, (error: unknown) => ({ error }));
        if (failure && !(failure.error instanceof OperationError && failure.error.code === 'owner_unavailable')) throw failure.error;
        const now = record[member];
        if (now !== value && typeof now === 'function') {
          stillWanted();
          return (now as (...a: unknown[]) => unknown).apply(engine, args);
        }
      }
      // Multi-user mode: a call the old owner handed over (`owner_handoff`: it never ran, and only a multi-user owner
      // sends it), or a read in flight when the owner went away, goes to the next owner. A write whose outcome is
      // unknown is never sent again: it may have run.
      return (direct(...args) as Promise<unknown>).catch(async (error: unknown) => {
        const readLost = ownerMemberOnlyReads(member) && connection.closed && rustMultiuserFromEnv()
          && error instanceof OperationError && error.code === 'owner_unavailable' && (error as { reason?: unknown }).reason === 'outcome_unknown';
        if (!isOwnerHandoff(error) && !readLost) throw error;
        await untilOwnerClosed(connection);
        const failure = await untilCallEnds(member, args, rejoin()).then(() => null, (e: unknown) => ({ error: e }));
        if (failure && !(failure.error instanceof OperationError && failure.error.code === 'owner_unavailable')) throw failure.error;
        const now = record[member];
        if (now === value || typeof now !== 'function') throw error;
        return (now as (...a: unknown[]) => unknown).apply(engine, args);
      });
    };
    Object.defineProperty(record, member, { value, writable: true, configurable: true, enumerable: false });
    installed.push(member);
  }
  const capabilities = record.capabilities as Set<string> | undefined;
  const own = capabilities instanceof Set ? [...capabilities] : [];
  if (capabilities instanceof Set) { capabilities.clear(); for (const c of ownerEngineCapabilities(connection.hello.capabilities)) capabilities.add(c); }
  const key = engineKey(engine);
  connections.set(key, connection);
  if (rejoin) rejoins.set(connection, rejoin);
  return () => {
    for (const member of installed) delete record[member];
    if (capabilities instanceof Set) { capabilities.clear(); for (const c of own) capabilities.add(c); }
    if (connections.get(key) === connection) connections.delete(key);
    connection.close();
  };
}
