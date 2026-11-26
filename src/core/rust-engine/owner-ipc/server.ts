/**
 * The owner side of the Rust engine owner socket (docs/designs/RUST_ENGINE.md, "Owner protocol for the Rust engine").
 * The process that holds a brain's owner lock serves its engine here, and every other process on that brain sends its
 * BrainEngine calls through it (client.ts). The server takes any BrainEngine, so tests can host a PGLite engine as the
 * owner while the Rust store is still being built.
 *
 * - Calls run on a permit pool (OWNER_IPC_DEFAULT_PERMITS). A call over the limit waits in its connection's queue,
 *   and a free permit goes to the connections in turn (round-robin, FIFO inside one connection; a call an orphan holds
 *   back, below, is passed over until it may run), so one client that floods the owner does not starve another. At its
 *   `deadline_at` a call ends with `timeout`: reason `not_started` when it never left the queue, `outcome_unknown` when
 *   it was running (the store does not observe the abort, so a running write can still commit). A `cancel` frame ends
 *   it with nothing more sent.
 * - Every call runs under its own AbortController: the request signal of the call (request-signal.ts), any
 *   AbortSignal argument the client sent, and the read deadline of the caller are restored in the owner.
 * - A permit is released only when the engine call itself settles, never when its reply is sent early (a timeout or
 *   a cancel), so the pool never runs more work than its size. `stats()` shows the pool for leak checks.
 * - A connection that closes aborts every call it started. Calls from other connections keep running.
 * - A request already past its `deadline_at` never starts, on arrival or when it leaves the queue. A deadline more
 *   than 2^31-1 ms away waits on a re-armed timer (timer.ts), never ends at once.
 * - Frame rules, each refused with `owner_ipc_protocol`: a client hello of another version gets the owner hello and
 *   then the connection closes, before any later frame runs; a call before the hello is `hello_missing`; a call that
 *   reuses an id still open on its connection is `duplicate_id` (the first call keeps its id, its cancel and its
 *   abort on close); arguments that are not a list are `args_not_array`. None of them runs.
 * - Bounds on the owner's memory across every client, each refused with `owner_busy` (retryable) before anything
 *   runs: more than `maxQueued` calls waiting for a permit (`queue_full`), call frames past `maxInflightBytes` held at
 *   once, waiting or running (`inflight_bytes`), or more than `maxConnections` open connections (`connections`, a
 *   `refused` frame, then the connection closes). A call's bytes and its queue slot come back exactly once: when its
 *   engine call settles, or when it leaves the queue without running (cancel, deadline, closed connection, close()).
 * - Peer identity: the owner reads each connecting process's uid from the kernel (src/core/peer-cred.ts) and refuses
 *   any other uid, or one it cannot read, with a `refused` frame carrying `owner_ipc_peer_refused` (`peer_uid`); no
 *   frame of that connection is read. Peer uids are read on Linux x64 and arm64 and on macOS. On other Unix systems
 *   and other Linux architectures the private 0700 directory and the 0600 socket are the only guard; a Windows named
 *   pipe gets no check.
 * - `close()` aborts every call and resolves only after all engine work that started has settled, so the owner lock
 *   (released by RustEngine.disconnect after close) never frees while the old owner still runs a call. An owner that
 *   exits therefore never leaves a started write running behind a new owner: `ownerGone` after the send stays final.
 * - Started writes: a write the owner started keeps running after its caller stops waiting (deadline, cancel, closed
 *   connection) and can still commit, and the owner may learn of the cancel after a read on another connection
 *   arrives. So until any started write settles, whether or not its caller still waits, the owner holds back every call to a member that would confirm it
 *   (confirming-reads.ts, membersWaitingFor: the members its confirming read names, or the write's own member when
 *   that read goes through it, as for executeRaw). The hold is by member, not by key, so an unrelated read of the same
 *   member waits too; other members run as before. A held call that reaches its deadline ends `owner_unavailable`,
 *   reason `earlier_call_running`, not retryable: it never ran and tells nothing about the earlier write yet.
 */
import net, { type Server, type Socket } from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import type { BrainEngine } from '../../engine.ts';
import { withRequestSignal } from '../../request-signal.ts';
import { withReadDeadline } from '../../read-deadline.ts';
import { withCallerAccess, withoutCallerAccess, type CallerAccess } from '../../search/private-visibility.ts';
import { claimLocalIpcBinding, isWindowsIpcPipe } from '../../context/ipc-path.ts';
import { peerCredSupport, peerUid, type PeerCredSupport } from '../../peer-cred.ts';
import { decodeValue, encodeError, encodeValue, type Wire } from './codec.ts';
import {
  OWNER_IPC_DEFAULT_PERMITS, OWNER_IPC_MAX_CONNECTIONS, OWNER_IPC_MAX_FRAME_BYTES, OWNER_IPC_MAX_INFLIGHT_BYTES, OWNER_IPC_MAX_QUEUED, OWNER_IPC_REFUSED_DRAIN_MS, OWNER_IPC_REFUSED_LIMIT,
  OWNER_IPC_VERSION, OWNER_IPC_VERSION_V3, frameLine, readFrames, type OwnerHello,
} from './protocol.ts';
import {
  OWNER_IPC_ROUTES, ownerBusy, ownerCallTimeout, ownerEarlierCallRunning, ownerIpcProtocol, ownerIpcRefusal, ownerMemberOnlyReads,
  ownerPeerRefused, ownerResponseTooLarge, ownerHandoff,
} from './routes.ts';
import { ownerRemoteRefusal } from './remote-check.ts';
import { membersWaitingFor } from './confirming-reads.ts';
import { setDeadlineTimer, type DeadlineTimer } from './timer.ts';
import { servedSession, type ServedHooks, type ServedServerOptions, type ServedServerSide, type ServedSession, type ServedCall } from '../served/session.ts';
import { encodeLengthFrame } from '../served/framing.ts';
import { IMPORT_CLIENT_FILE } from '../served/client-files.ts';
import { SERVED_BRAIN_CALL, SERVED_STORE_CALL } from '../served/store-returning.ts';

/** Whole operations only a protocol v3 session sends. */
const V3_ONLY_OPERATIONS: ReadonlySet<string> = new Set([IMPORT_CLIENT_FILE, SERVED_STORE_CALL, SERVED_BRAIN_CALL]);

/** A whole operation the owner runs for a client in one request (whole-op.ts); it may open its own transaction. */
export type OwnerWholeOperation = (engine: BrainEngine, ...args: unknown[]) => Promise<unknown>;

export interface OwnerServerOptions {
  permits?: number;
  /** True when this process is a `gbrain serve`; clients then use its persistence socket for MCP operations. */
  serve?: boolean;
  /** Whole operations clients may forward, by name. */
  wholeOperations?: Readonly<Record<string, OwnerWholeOperation>>;
  /** The frame cap; tests lower it to reach `response_too_large`. */
  maxFrameBytes?: number;
  /** Bounds on the owner's memory (OWNER_IPC_MAX_QUEUED and friends); tests lower them to reach `owner_busy`. */
  maxQueued?: number;
  maxInflightBytes?: number;
  maxConnections?: number;
  /** The peer-uid reader (default: the platform's) and this process's uid; tests inject another user. */
  peerCred?: PeerCredSupport;
  uid?: () => number | undefined;
  /**
   * Protocol v3 (served/session.ts): present only with multi-user Rust on. Absent, a v3 hello gets the v2 version
   * refusal and nothing of v3 runs (off is identical).
   */
  served?: ServedServerOptions;
}

export interface OwnerServerStats { active: number; queued: number; connections: number; inflightBytes: number }

export interface OwnerEngineServer {
  socketPath: string;
  stats(): OwnerServerStats;
  close(): Promise<void>;
  /**
   * Serves one network connection (served/listener.ts) with this owner's dispatcher: protocol v3 only, length-prefixed
   * frames, the bearer hello. Undefined unless `served` was given.
   */
  attachServed?: (socket: Socket) => void;
}

export interface PendingCall {
  id: number;
  member: string;
  run: () => Promise<unknown>;
  controller: AbortController;
  done: boolean;
  queued: boolean;
  /** The connection's call table: the key of the lane the call waits in. */
  lane: object;
  /** Size of the call's frame, held against the in-flight byte budget until `released`. */
  bytes: number;
  released: boolean;
  timer?: DeadlineTimer;
  /** Epoch ms after which the call must not start; a call past it ends with `timeout` and never runs. */
  deadlineAt?: number;
  /** The deadline as the caller gave it, in ms from arrival, for the error. */
  deadlineMs?: number;
  /** True for a call that can write: a whole operation, or a member that does not only read. */
  write: boolean;
  /** True once the engine call has settled (its then-handlers ran), whether or not its reply was still wanted. */
  settled: boolean;
  /** True once the call left the queue to run. */
  started?: boolean;
  /** Protocol v3 hooks of the call (served/session.ts); absent on v2. */
  served?: ServedHooks;
  reply(frame: object): void;
}

/**
 * The caller-access record a frame carried, as withCallerAccess takes it. Anything that is not an object with an array
 * `identity` is refused, never read as no record: a caller that had a record never runs with the owner's wider view.
 */
function callerAccessOf(member: string, value: unknown): CallerAccess {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { identity?: unknown }).identity)) {
    throw ownerIpcRefusal(member, 'its caller access record is not an object with an identity list');
  }
  return value as CallerAccess;
}

function timeoutReason(): Error {
  return new DOMException('The call reached its deadline on the brain owner.', 'TimeoutError');
}

/** Rebuilds a client function tag: a void callback that notifies the client, or a countPagesBy grouper. */
function rebuildFunction(wire: { [key: string]: Wire }, call: PendingCall, send: (frame: object) => void): unknown {
  if (wire.grouper && typeof wire.grouper === 'object' && !Array.isArray(wire.grouper)) {
    const types = (wire.grouper.types as string[] | undefined) ?? [];
    const groups = (wire.grouper.groups as string[] | undefined) ?? [];
    return (input: string[]) => input.map(type => { const at = types.indexOf(type); return at === -1 ? type : groups[at]; });
  }
  const key = typeof wire.k === 'string' ? wire.k : '';
  return (...args: unknown[]) => {
    if (call.done) return;
    try { send({ t: 'cb', id: call.id, key, args: encodeValue(args) }); } catch { /* a notification never fails the call */ }
  };
}

/** Claims the owner socket path. The owner lock is held, so a socket left there belongs to an owner that died. */
async function claimOwnerSocket(legacySocketPath: string) {
  const binding = await claimLocalIpcBinding(legacySocketPath);
  if (!binding) return null;
  const socketPath = binding.socketPath;
  try {
    // Never remove a non-socket.
    if (binding.removeStaleWindowsSocket) binding.removeStaleWindowsSocket();
    else if (!isWindowsIpcPipe(socketPath)) {
      if (!lstatSync(socketPath).isSocket()) throw new Error('The owner socket path is not a socket.');
      unlinkSync(socketPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await binding.release(); throw error; }
  }
  return binding;
}

/** A call's error in its protocol's form: v3 strips stacks and causes and adds a correlation id (served/session.ts). */
function callError(call: PendingCall, error: unknown): Wire {
  return call.served ? call.served.encodeError(error) : encodeError(error);
}

function expire(call: PendingCall, queued: boolean): void {
  call.timer?.clear();
  call.reply({ t: 'result', id: call.id, ok: false, error: callError(call, ownerCallTimeout(call.member, 0, queued ? 'queued' : 'sent')) });
  call.controller.abort(timeoutReason());
}

/**
 * A write the owner started whose engine call has not settled can still commit, even after its caller stopped waiting
 * (its deadline, a cancel, a closed connection). The owner may learn of that stop late: the client gives up as soon
 * as it sends its cancel, and a read on another connection can arrive first. So a call that would read the outcome
 * of any started write waits until that write has settled, and a confirming read never answers "not there" for a
 * write that is about to commit (routes.ts, confirmingReadAdvice). Returns the earlier write's member, or undefined
 * when nothing holds `call` back.
 */
function orphanAhead(started: ReadonlySet<PendingCall>, call: PendingCall): string | undefined {
  for (const other of started) {
    if (other.write && !other.settled && membersWaitingFor(other.member).has(call.member)) return other.member;
  }
  return undefined;
}

/** Ends a call an orphan held back until its deadline: nothing ran, and it says which earlier call held it. */
function holdExpired(call: PendingCall, earlier: string): void {
  call.timer?.clear();
  call.reply({ t: 'result', id: call.id, ok: false, error: callError(call, ownerEarlierCallRunning(call.member, earlier, call.deadlineMs ?? 0)) });
  call.controller.abort(timeoutReason());
}

/** Answers a started call with its engine result once it settles, unless the call already ended. */
function answerCall(call: PendingCall, settled: Promise<unknown>): Promise<void> {
  // A v3 call settles through its session: the outcome is kept for its request id even when no one waits for the
  // reply any more, and a write's result carries its commit position (served/session.ts).
  if (call.served) {
    const served = call.served;
    return settled.then(value => { call.settled = true; return served.settle(call, true, value); },
      error => { call.settled = true; return served.settle(call, false, error); });
  }
  return settled.then(
    value => {
      call.settled = true;
      if (call.done) return;
      let encoded: Wire;
      try { encoded = encodeValue(value); }
      catch (error) { call.reply({ t: 'result', id: call.id, ok: false, error: encodeError(error) }); return; }
      call.reply({ t: 'result', id: call.id, ok: true, value: encoded });
    },
    error => {
      call.settled = true;
      if (call.done) return;
      call.reply({ t: 'result', id: call.id, ok: false, error: encodeError(error) });
    },
  );
}

/** Calls waiting for a permit: one FIFO lane per connection, keyed by its call table, in turn order. */
type Lanes = Map<object, PendingCall[]>;

/** Takes a call out of its lane; an empty lane goes with it. */
function laneDequeue(lanes: Lanes, call: PendingCall): void {
  const calls = lanes.get(call.lane);
  if (!calls) return;
  const at = calls.indexOf(call);
  if (at !== -1) calls.splice(at, 1);
  if (!calls.length) lanes.delete(call.lane);
}

/** How many calls wait; `live` leaves out the ones that already ended. */
function queuedCount(lanes: Lanes, live = false): number {
  let n = 0;
  for (const calls of lanes.values()) n += live ? calls.filter(call => !call.done).length : calls.length;
  return n;
}

/**
 * The next call to run, taking turns: the first lane (in turn order) whose `ready` finds a call able to run gives it up,
 * and moves to the end of the order.
 */
function takeInTurn(lanes: Lanes, ready: (calls: PendingCall[]) => PendingCall | undefined): PendingCall | undefined {
  for (const [lane, calls] of [...lanes]) {
    const next = ready(calls);
    if (!next) continue;
    laneDequeue(lanes, next);
    const rest = lanes.get(lane);
    if (rest) { lanes.delete(lane); lanes.set(lane, rest); }
    return next;
  }
  return undefined;
}

/**
 * The first call of one lane that may run now. A call that ended, or ends here (the owner is closing, its deadline
 * passed), leaves the queue on the way; a call an orphan holds back is passed over.
 */
function runnableCall(
  calls: PendingCall[], closing: boolean, started: ReadonlySet<PendingCall>, leaveQueue: (call: PendingCall) => void,
  handoff: ((call: PendingCall) => void) | null = null,
): PendingCall | undefined {
  for (let at = 0; at < calls.length;) {
    const call = calls[at]!;
    if (call.done) { leaveQueue(call); continue; }
    if (closing && handoff) { handoff(call); leaveQueue(call); continue; }
    if (closing) { call.done = true; leaveQueue(call); call.controller.abort(new DOMException('The brain owner is closing.', 'AbortError')); continue; }
    const earlier = orphanAhead(started, call);
    // A timer fires on a later turn, so a call whose deadline passed while it waited is checked here, before it runs.
    if (call.deadlineAt !== undefined && Date.now() >= call.deadlineAt) {
      if (earlier) holdExpired(call, earlier); else expire(call, true);
      leaveQueue(call);
      continue;
    }
    if (earlier) { at++; continue; }
    return call;
  }
  return undefined;
}

/**
 * The JSON-line writer of one Unix-socket connection. `member` names the call a result answers; `reply` passes it
 * because it drops the call from `calls` first. A frame over the cap becomes `response_too_large` for its call.
 */
function lineSender(socket: Socket, calls: Map<number, PendingCall>, maxFrameBytes: number): (frame: object, member?: string) => void {
  return (frame, member) => {
    if (socket.destroyed) return;
    const line = frameLine(frame, maxFrameBytes);
    if (line !== null) { socket.write(line); return; }
    const id = (frame as { id?: number }).id;
    const name = member ?? (id === undefined ? undefined : calls.get(id)?.member);
    if ((frame as { t?: string }).t === 'result' && name !== undefined) {
      socket.write(frameLine({ t: 'result', id, ok: false, error: encodeError(ownerResponseTooLarge(name, maxFrameBytes)) })!);
    }
  };
}

/** A v3 call whose connection's credential stopped working while it waited never runs (served/auth.ts); true if refused. */
function refusedStale(call: PendingCall): boolean {
  const stale = call.served?.staleCredential?.();
  if (!stale) return false;
  call.timer?.clear();
  call.reply({ t: 'result', id: call.id, ok: false, error: callError(call, stale) });
  return true;
}

/** What a protocol v3 session reaches of an owner: its engine and the one dispatcher both transports share. */
function servedSideOf(engine: BrainEngine,
  admit: (frame: Record<string, unknown>, bytes: number, calls: Map<number, PendingCall>, send: (frame: object, member?: string) => void, helloed: boolean, served?: ServedHooks) => void,
  cancel: (calls: Map<number, PendingCall>, id: number) => void): ServedServerSide {
  return {
    engine,
    admit: (frame, bytes, calls, send, hooks) => admit(frame, bytes, calls as unknown as Map<number, PendingCall>, send, true, hooks),
    cancel: (calls, id) => cancel(calls as unknown as Map<number, PendingCall>, id),
  };
}

/** A call the owner will not start because it is handing the brain over: answered as never run (`owner_handoff`). */
function answerHandedOver(call: PendingCall, release: () => void): void {
  call.timer?.clear();
  call.reply({ t: 'result', id: call.id, ok: false, error: callError(call, ownerHandoff(call.member, process.pid)) });
  release();
}

/**
 * The handoff drain: every call that has not started is answered as never run, so its client sends it to the next
 * owner; every call that started is finished (and answered) before any connection closes.
 */
async function drainForHandoff(lanes: Map<unknown, PendingCall[]>, running: Set<Promise<unknown>>, handOff: (call: PendingCall) => void,
  leaveQueue: (call: PendingCall) => void): Promise<void> {
  for (const calls of [...lanes.values()]) for (const call of [...calls]) { if (!call.done) handOff(call); leaveQueue(call); }
  while (running.size) await Promise.allSettled([...running]);
}

/** Ends each connection so the answers just written reach their clients, then cuts what lingers past one second. */
async function endConnections(list: Socket[]): Promise<void> {
  await Promise.all(list.map(socket => new Promise<void>(resolve => {
    if (socket.destroyed) { resolve(); return; }
    const cut = setTimeout(() => { socket.destroy(); resolve(); }, 1_000);
    cut.unref?.();
    socket.once('close', () => { clearTimeout(cut); resolve(); });
    socket.end();
  })));
}

/** The owner server's close: the handoff drain (multi-user mode), the calls left, the connections, the server. */
async function closeOwnerServer(o: {
  server: Server; lanes: Map<unknown, PendingCall[]>; running: Set<Promise<unknown>>;
  handOff: ((call: PendingCall) => void) | null; leaveQueue: (call: PendingCall) => void; live: () => Socket[];
}): Promise<void> {
  const serverClosed = new Promise<void>(resolve => o.server.close(() => resolve()));
  if (o.handOff) await drainForHandoff(o.lanes, o.running, o.handOff, o.leaveQueue);
  for (const calls of [...o.lanes.values()]) {
    for (const call of [...calls]) {
      o.leaveQueue(call);
      if (!call.done) { call.done = true; call.controller.abort(new DOMException('The brain owner is closing.', 'AbortError')); }
    }
  }
  if (o.handOff) await endConnections(o.live());
  for (const socket of o.live()) socket.destroy();
  while (o.running.size) await Promise.allSettled([...o.running]);
  await serverClosed;
}

/** A connection that closes aborts every call it started; calls of other connections keep running. */
function endConnectionCalls(calls: Map<number, PendingCall>, leaveQueue: (call: PendingCall) => void): void {
  for (const call of calls.values()) {
    call.done = true;
    call.timer?.clear();
    leaveQueue(call);
    // A call that started keeps its request record: it may still commit, and a retry learns its outcome (review G3).
    if (!call.started) call.served?.neverRan?.(call);
    call.controller.abort(new DOMException('The client closed its connection.', 'AbortError'));
  }
  calls.clear();
}

/** The caller's cancel: the call ends with nothing more sent; a call that never started forgets its request id. */
function cancelOneCall(calls: Map<number, PendingCall>, id: number, leaveQueue: (call: PendingCall) => void): void {
  const call = calls.get(id);
  if (!call) return;
  calls.delete(call.id);
  call.done = true;
  call.timer?.clear();
  leaveQueue(call);
  if (!call.started) call.served?.neverRan?.(call);
  call.controller.abort(new DOMException('The caller cancelled the call.', 'AbortError'));
}

/**
 * Serves one network connection (served/listener.ts) with the owner's dispatcher: protocol v3 only, with the owner's
 * permits, queue and bounds; past the connection cap it gets a `refused` frame.
 */
function attachServedSocket(socket: Socket, owner: {
  closing: () => boolean; sockets: Set<Socket>; maxConnections: number; side: ServedServerSide; options: ServedServerOptions;
  hello: OwnerHello; endCalls: (calls: Map<number, PendingCall>) => void;
}): void {
  socket.on('error', () => { /* a lost client only ends its own calls */ });
  if (owner.closing()) { socket.destroy(); return; }
  if (owner.sockets.size >= owner.maxConnections) {
    const drain = setTimeout(() => socket.destroy(), OWNER_IPC_REFUSED_DRAIN_MS);
    drain.unref();
    socket.once('close', () => clearTimeout(drain));
    socket.end(encodeLengthFrame({ t: 'refused', error: encodeError(ownerBusy('connections', null, owner.maxConnections)) })!);
    return;
  }
  owner.sockets.add(socket);
  const calls = new Map<number, PendingCall>();
  const session = servedSession(owner.side, owner.options, { transport: 'tcp', socket, calls: calls as unknown as Map<number, ServedCall>, hello: owner.hello });
  socket.once('close', () => {
    owner.sockets.delete(socket);
    session.close();
    owner.endCalls(calls);
  });
}

export async function serveOwnerEngine(
  engine: BrainEngine,
  legacySocketPath: string,
  opts: OwnerServerOptions = {},
): Promise<OwnerEngineServer | null> {
  const binding = await claimOwnerSocket(legacySocketPath);
  if (!binding) return null;
  const socketPath = binding.socketPath;

  const permits = Math.max(1, opts.permits ?? OWNER_IPC_DEFAULT_PERMITS);
  const maxFrameBytes = opts.maxFrameBytes ?? OWNER_IPC_MAX_FRAME_BYTES;
  const maxQueued = Math.max(0, opts.maxQueued ?? OWNER_IPC_MAX_QUEUED);
  const maxInflightBytes = opts.maxInflightBytes ?? OWNER_IPC_MAX_INFLIGHT_BYTES;
  const maxConnections = Math.max(1, opts.maxConnections ?? OWNER_IPC_MAX_CONNECTIONS);
  const uid = process.platform === 'win32' ? undefined : (opts.uid ?? (() => process.getuid?.()))();
  const peerCred = uid === undefined ? undefined : (opts.peerCred ?? peerCredSupport());
  const wholeOperations = opts.wholeOperations ?? {};
  // Calls waiting for a permit, one FIFO lane per connection in turn order: the next permit goes to the first lane that
  // has a call able to run, which then moves to the end. A call leaves its lane when it starts or as soon as it ends
  // without running (leaveQueue).
  const lanes: Lanes = new Map();
  const sockets = new Set<Socket>();
  // Connections refused before their hello, kept only until they close.
  const refused = new Set<Socket>();
  let active = 0;
  let inflightBytes = 0;
  let closing = false;
  // Multi-user mode only (served options): a closing owner hands over what it has not started; off, null (server.ts close).
  const handOff = opts.served ? (call: PendingCall) => answerHandedOver(call, () => releaseBytes(call)) : null;
  let closed: Promise<void> | undefined;
  // Engine work that has started and not settled. close() waits for all of it before the owner lock can be released.
  const running = new Set<Promise<unknown>>();
  // Calls whose engine work has started and not settled, so a later call can see an orphan among them.
  const started = new Set<PendingCall>();

  const releaseBytes = (call: PendingCall) => {
    if (call.released) return;
    call.released = true;
    inflightBytes -= call.bytes;
  };
  // A call that ends while it still waits gives back its queue slot and its bytes at once, never at its turn.
  const leaveQueue = (call: PendingCall) => {
    if (!call.queued) return;
    call.queued = false;
    laneDequeue(lanes, call);
    releaseBytes(call);
  };

  // Calls start in turn order, one connection after another, except that a call an orphan holds back is passed over until
  // the orphan settles.
  const pump = () => {
    while (active < permits) {
      const next = takeInTurn(lanes, calls => runnableCall(calls, closing, started, leaveQueue, handOff));
      if (!next) return;
      start(next);
    }
  };

  const start = (call: PendingCall) => {
    call.queued = false;
    if (refusedStale(call)) { releaseBytes(call); return; }
    call.started = true;
    active++;
    started.add(call);
    let settled: Promise<unknown>;
    try { settled = call.run(); } catch (error) { settled = Promise.reject(error); }
    const tracked = answerCall(call, settled).finally(() => {
      active--;
      call.done = true;
      call.settled = true;
      started.delete(call);
      call.timer?.clear();
      releaseBytes(call);
      running.delete(tracked);
      pump();
    });
    running.add(tracked);
  };

  const hello: OwnerHello = {
    t: 'hello', version: OWNER_IPC_VERSION, pid: process.pid, kind: String(engine.kind),
    capabilities: [...((engine as { capabilities?: Iterable<string> }).capabilities ?? [])].map(String),
    serve: opts.serve === true,
  };

  const closeConnectionCalls = (calls: Map<number, PendingCall>) => endConnectionCalls(calls, leaveQueue);
  const cancelCall = (calls: Map<number, PendingCall>, id: number) => cancelOneCall(calls, id, leaveQueue);

  const onConnection = (socket: Socket) => {
    socket.on('error', () => { /* a lost client only ends its own calls */ });
    if (closing) { socket.destroy(); return; }
    // A refused connection gets one frame naming why, then closes; nothing it sends is read.
    // Half-closed so the client reads what it was sent before the socket goes. A peer that never closes its own half must
    // not hold the socket: it is destroyed after REFUSED_DRAIN_MS, and past REFUSED_LIMIT refusals in flight the next is
    // dropped with no frame, so refusals cost the owner a bounded number of descriptors.
    const holdRefused = (last = () => '') => {
      if (refused.size >= OWNER_IPC_REFUSED_LIMIT) { socket.destroy(); return; }
      refused.add(socket);
      const drain = setTimeout(() => socket.destroy(), OWNER_IPC_REFUSED_DRAIN_MS);
      drain.unref();
      socket.once('close', () => { clearTimeout(drain); refused.delete(socket); });
      socket.end(last());
    };
    const refuseConnection = (error: unknown) => holdRefused(() => frameLine({ t: 'refused', error: encodeError(error) })!);
    if (peerCred?.ok) {
      const peer = peerUid(socket, peerCred.read);
      if (peer !== uid) {
        refuseConnection(ownerPeerRefused('peer_uid', `peer_uid=${peer ?? 'unreadable'} owner_uid=${uid}`));
        return;
      }
    }
    if (sockets.size >= maxConnections) { refuseConnection(ownerBusy('connections', null, maxConnections)); return; }
    sockets.add(socket);
    const calls = new Map<number, PendingCall>();
    // `helloed` turns on with a hello of this version. `refused` turns on with a hello of another version: the owner
    // answers with its own hello so the client can name both versions, then reads nothing more from the connection.
    const conn = { helloed: false, refused: false };
    const send = lineSender(socket, calls, maxFrameBytes);
    // Set by a protocol v3 hello (only when `served` is on); from then on the session reads every frame.
    let session: ServedSession | null = null;
    socket.once('close', () => {
      sockets.delete(socket);
      session?.close();
      closeConnectionCalls(calls);
    });
    readFrames(socket, (frame, bytes) => {
      if (conn.refused) return;
      if (session) { session.onFrame(frame, null, bytes); return; }
      switch (frame.t) {
        case 'hello':
          if (opts.served && !conn.helloed && frame.version === OWNER_IPC_VERSION_V3) {
            session = servedSession(servedSide, opts.served, { transport: 'unix', socket, calls: calls as unknown as Map<number, ServedCall>, send, hello });
            session.onFrame(frame, null, bytes);
            return;
          }
          if (frame.version !== OWNER_IPC_VERSION) {
            conn.refused = true;
            send(hello);
            // No longer a connection of the owner: it holds no slot, and is cut off after the drain like any refusal.
            sockets.delete(socket);
            holdRefused();
            return;
          }
          conn.helloed = true;
          send(hello);
          return;
        case 'cancel': cancelCall(calls, Number(frame.id)); return;
        case 'call': case 'fn': admit(frame, bytes, calls, send, conn.helloed); return;
        default: socket.destroy();
      }
    }, () => { /* the close handler ends this connection's calls */ }, maxFrameBytes);
  };

  const admit = (
    frame: Record<string, unknown>, bytes: number, calls: Map<number, PendingCall>, send: (frame: object, member?: string) => void,
    helloed: boolean, served?: ServedHooks,
  ) => {
    const id = Number(frame.id);
    const member = String(frame.t === 'fn' ? frame.name : frame.member);
    // A v3 call refused before it ran leaves no request-id record, so its retry runs fresh (served/requests.ts).
    const refusedEarly = (error: unknown) => {
      served?.neverRan?.(null);
      send({ t: 'result', id, ok: false, error: served ? served.encodeError(error) : encodeError(error) }, member);
    };
    // A call that arrives while a handoff drains never starts here: the next owner takes it.
    if (closing && handOff) { refusedEarly(ownerHandoff(member, process.pid)); return; }
    // These refusals never touch `calls`: a duplicate id must not take the first call's entry, its cancel or its abort.
    const protocolRefusal = (reason: Parameters<typeof ownerIpcProtocol>[0], detail: string) =>
      refusedEarly(ownerIpcProtocol(reason, member, detail));
    if (!helloed) { protocolRefusal('hello_missing', 'the call came before a hello of this protocol version'); return; }
    if (calls.has(id)) { protocolRefusal('duplicate_id', `id=${id} is still open on this connection`); return; }
    if (frame.args === undefined) { protocolRefusal('args_not_array', 'the call has no argument list'); return; }
    // The bounds are checked before the arguments are decoded, so a refused call costs the owner nothing more.
    const busy = (reason: 'queue_full' | 'inflight_bytes', limit: number) => refusedEarly(ownerBusy(reason, member, limit));
    if (inflightBytes + bytes > maxInflightBytes) { busy('inflight_bytes', maxInflightBytes); return; }
    // A call held behind an orphan waits with permits free, so a non-empty queue counts against the cap too.
    if ((active >= permits || lanes.size > 0) && queuedCount(lanes) >= maxQueued) { busy('queue_full', maxQueued); return; }
    const controller = new AbortController();
    const call: PendingCall = {
      id, member, controller, done: false, queued: false, lane: calls, bytes, released: true, run: () => Promise.resolve(),
      write: frame.t === 'fn' || !ownerMemberOnlyReads(member), settled: false,
      ...(served ? { served } : {}),
      reply: out => {
        if (calls.get(id) === call) calls.delete(id);
        const first = !call.done;
        call.done = true;
        // A call answered before it ran (a refusal, a queued deadline) never ran: its request id is forgotten.
        if (first && !call.started) served?.neverRan?.(call);
        send(out, member);
      },
    };
    calls.set(id, call);
    const refuse = (error: unknown) => call.reply({ t: 'result', id, ok: false, error: served ? served.encodeError(error) : encodeError(error) });
    // Multi-user groundwork K: under its switch the owner refuses a remote caller's write itself (remote-check.ts).
    const remoteRefusal = ownerRemoteRefusal(engine, frame, member);
    if (remoteRefusal) { refuse(remoteRefusal); return; }
    let target: (...args: unknown[]) => Promise<unknown>;
    if (frame.t === 'fn') {
      // An operation of protocol v3 only is, on v2, one the owner does not run (the same refusal as an unknown name).
      const operation = Object.hasOwn(wholeOperations, member) && (served || !V3_ONLY_OPERATIONS.has(member)) ? wholeOperations[member] : undefined;
      if (!operation) { refuse(ownerIpcRefusal(member, 'the owner does not run this operation for other processes')); return; }
      target = (...args) => operation(engine, ...args);
    } else {
      const route = (OWNER_IPC_ROUTES as Record<string, string>)[member];
      const method = (engine as unknown as Record<string, unknown>)[member];
      if (route !== 'forward' || typeof method !== 'function') { refuse(ownerIpcRefusal(member, 'it is not sent across the owner socket')); return; }
      target = (...args) => (method as (...a: unknown[]) => Promise<unknown>).apply(engine, args);
    }
    let args: unknown[];
    try {
      const decoded = decodeValue(frame.args as Wire, {
        onFunction: wire => served?.rebuildFunction ? served.rebuildFunction(wire, call) : rebuildFunction(wire, call, send),
        onSignal: () => controller.signal,
      });
      if (!Array.isArray(decoded)) {
        refuse(ownerIpcProtocol('args_not_array', member, `the arguments decoded to ${decoded === null ? 'null' : typeof decoded}`));
        return;
      }
      args = decoded;
    } catch (error) { refuse(error); return; }
    const deadlineAt = typeof frame.deadline_at === 'number' ? frame.deadline_at : undefined;
    const readDeadlineAt = typeof frame.read_deadline_at === 'number' ? frame.read_deadline_at : undefined;
    let access: CallerAccess | null;
    try { access = frame.access === undefined ? null : callerAccessOf(member, decodeValue(frame.access as Wire)); } catch (error) { refuse(error); return; }
    const invoke = () => readDeadlineAt === undefined ? target(...args) : withReadDeadline(readDeadlineAt, () => target(...args));
    // The call runs under the caller's access record, re-checked by withCallerAccess, or under none when it had none.
    // A v3 call runs inside its session's scope too (served/session.ts: the remote mark, a transaction binding).
    const scoped = () => access ? withCallerAccess(access, invoke) : withoutCallerAccess(invoke);
    call.run = () => withRequestSignal(controller.signal, () => served ? served.wrapRun(scoped) : scoped());
    if (deadlineAt !== undefined) {
      call.deadlineAt = deadlineAt;
      // A request that arrives after its deadline never starts: a fast write would otherwise commit before the timer.
      if (Date.now() >= deadlineAt) { expire(call, true); return; }
      const ms = Math.max(0, deadlineAt - Date.now());
      call.deadlineMs = ms;
      call.timer = setDeadlineTimer(() => {
        if (call.done) return;
        const queued = call.queued;
        // A call still queued behind an orphan never ran, but it cannot say the orphan did not commit either.
        const earlier = queued ? orphanAhead(started, call) : undefined;
        const timedOut = earlier ? ownerEarlierCallRunning(member, earlier, ms) : ownerCallTimeout(member, ms, queued ? 'queued' : 'sent');
        call.reply({ t: 'result', id, ok: false, error: served ? served.encodeError(timedOut) : encodeError(timedOut) });
        leaveQueue(call);
        controller.abort(timeoutReason());
      }, ms, { unref: true });
    }
    call.queued = true;
    call.released = false;
    inflightBytes += bytes;
    const lane = lanes.get(calls);
    if (lane) lane.push(call); else lanes.set(calls, [call]);
    pump();
  };

  const servedSide = servedSideOf(engine, admit, cancelCall);

  const attachServed = opts.served ? (socket: Socket) => attachServedSocket(socket, {
    closing: () => closing, sockets, maxConnections, side: servedSide, options: opts.served!, hello, endCalls: closeConnectionCalls,
  }) : undefined;

  const server: Server = net.createServer(onConnection);
  server.once('close', () => { void binding.release(); });
  let listened = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        listened = true;
        server.off('error', reject);
        server.on('error', () => {});
        try { if (process.platform !== 'win32') chmodSync(socketPath, 0o600); resolve(); }
        catch (error) { reject(error); }
      });
    });
  } catch (error) {
    if (listened) server.close(); else await binding.release();
    throw error;
  }

  return {
    socketPath,
    ...(attachServed ? { attachServed } : {}),
    stats: () => ({ active, queued: queuedCount(lanes, true), connections: sockets.size, inflightBytes }),
    // Stops new work, aborts every queued and running call, and resolves only when the server is closed AND every
    // engine call that started has settled, so the caller cannot release the owner lock while old work still runs.
    // A second close() gets the same promise, so no caller can release the lock before the drain ends.
    close: () => (closed ??= (async () => {
      closing = true;
      await closeOwnerServer({ server, lanes, running, handOff, leaveQueue, live: () => [...sockets, ...refused] });
    })()),
  };
}
