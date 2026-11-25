/**
 * One protocol v3 connection on the owner (docs/designs/rust-engine/multi-user-server.md, "M1 as built"; interface
 * I-7). The owner's dispatcher (owner-ipc/server.ts) is shared by every transport; this module is the v3 layer in
 * front of it: the hello and its credential, request ids, positions, the remote mark, file locality, returning
 * callbacks and transactions over the wire.
 *
 * A session exists only when the owner was started with `served` options, which the owner gets only with multi-user
 * Rust on. Its transports: a network connection (served/listener.ts: TLS, or plain TCP on a loopback address), whose
 * frames are length-prefixed and whose hello must carry an owner server token; or the Unix owner socket, whose peer
 * the kernel already proved is this OS user (JSON lines; a token is not needed).
 *
 * Rules, each tested in test/rust-served-*.test.ts:
 * - Before its hello is authenticated a network connection may send one frame of at most SERVED_PREAUTH_FRAME_BYTES
 *   within helloTimeoutMs, and at most preauthMaxConnections connections wait for a hello at once; parser-held bytes
 *   of every connection come from one budget (framing.ts). Past any bound the connection is closed; nothing ran.
 * - The credential is checked again every RECHECK_MS while the connection lives, and its expiry at every admission;
 *   once it fails, new calls and queued calls that have not started refuse. Work already started is not undone.
 * - A frame's `access` record is a narrowing claim the owner floor allows, as on v2; a frame's `remote: true` runs
 *   the call as a remote caller (the remote read allow-list, no whole operations); `remote: false` refuses for a
 *   principal whose floor is remote.
 * - Errors cross without stacks or causes on a network connection; an error frame carries a correlation id the
 *   server logs for an unexpected failure.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { BrainEngine } from '../../engine.ts';
import { withRemoteCaller } from '../../remote-caller.ts';
import { decodeError, decodeValue, encodeError, encodeValue, type Wire } from '../owner-ipc/codec.ts';
import {
  OWNER_IPC_VERSION_V3, SERVED_SERVER_CAPS, parsePositionToken, positionToken, type OwnerHello,
} from '../owner-ipc/protocol.ts';
import { OWNER_IPC_REMOTE_READS, ownerIpcRefusal, ownerMemberOnlyReads } from '../owner-ipc/routes.ts';
import { OWNER_RUN_OPERATION } from '../owner-ipc/whole-op.ts';
import { LOCAL_OWNER, RECHECK_MS, authenticateToken, effectiveRemote, recheckToken, type AuthenticatedPrincipal, type VerifyDeps } from './auth.ts';
import {
  servedAdminPath, servedAuthRefused, servedCallbackTimeout, servedPositionNotReached, servedPositionRefused, servedProtocol,
  servedReqConflict, servedOutcomeUnknown, servedTransactionDeadline,
} from './errors.ts';
import {
  SERVED_MAX_FRAME_BYTES, SERVED_PREAUTH_FRAME_BYTES, byteBudget, encodeLengthFrame, extractTail, readLengthFrames, restoreTail,
  type ByteBudget,
} from './framing.ts';
import { storePositionReader, waitForPosition, type PositionReader } from './positions.ts';
import { REQUEST_ID, RequestTable, type StoredOutcome } from './requests.ts';
import { ownerResponseTooLarge } from '../owner-ipc/routes.ts';

/** Whole operations a network client may not send: they name paths on the server host (decision 9). */
const SERVER_PATH_OPERATIONS: ReadonlySet<string> = new Set(['importFromFile', 'importImageFile', 'importManagedFiles', 'snapshotStore']);
/** Registry operations the write journal admits with a request id, so a retry after a restart runs them again safely. */
const JOURNALED_OPERATIONS: ReadonlySet<string> = new Set(['put_page']);

export interface ServedServerOptions {
  /** The bearer check (tests inject one). */
  verify?: VerifyDeps;
  /** The published commit position (default: the Rust store's). */
  positions?: PositionReader;
  /** Whether interactive transactions over the wire are answered (L1's `multi_writer`, or the test sub-switch). */
  transactions?: () => boolean;
  helloTimeoutMs?: number;
  preauthMaxConnections?: number;
  /** Parser-held bytes across every network connection. */
  parserBudgetBytes?: number;
  callbackTimeoutMs?: number;
  /** The longest a transaction over the wire may stay open. */
  transactionMaxMs?: number;
  /** How long a `min_position` read waits when the caller gave no deadline. */
  positionWaitMs?: number;
  /** Server log line (an unexpected error with its correlation id). */
  log?: (line: string) => void;
}

/** What a session needs of the owner it runs in (owner-ipc/server.ts). */
export interface ServedServerSide {
  engine: BrainEngine;
  admit(frame: Record<string, unknown>, bytes: number, calls: Map<number, ServedCall>, send: (frame: object, member?: string) => void, hooks: ServedHooks): void;
  cancel(calls: Map<number, ServedCall>, id: number): void;
}

/** The fields of an owner call a session reads; owner-ipc/server.ts PendingCall has them. */
export interface ServedCall {
  id: number;
  member: string;
  write: boolean;
  done: boolean;
  reply(frame: object): void;
}

/** The v3 hooks of one call, read by the dispatcher. */
export interface ServedHooks {
  encodeError(error: unknown): Wire;
  /** The call never ran (refused, cancelled or expired while queued): forget its request id. */
  neverRan?(call: ServedCall | null): void;
  /** The engine call settled: keep the outcome, add the position, answer when the caller still waits. */
  settle(call: ServedCall, ok: boolean, value: unknown): Promise<void>;
  wrapRun<T>(fn: () => T): T;
  /** The refusal for a call whose connection's credential stopped working, or null. */
  staleCredential?(): Error | null;
  rebuildFunction?(wire: { [key: string]: Wire }, call: ServedCall): unknown;
}

export interface ServedSession {
  onFrame(frame: Record<string, unknown>, tail: Buffer | null, bytes: number): void;
  close(): void;
}

export interface SessionContext {
  transport: 'unix' | 'tcp';
  socket: Socket;
  calls: Map<number, ServedCall>;
  /** The Unix socket's JSON-line writer; a network session writes length-prefixed frames itself. */
  send?: (frame: object, member?: string) => void;
  hello: OwnerHello;
}

interface ServerState {
  requests: RequestTable;
  budget: ByteBudget;
  preauth: number;
  serverId: string;
  positions: PositionReader | null;
}

const states = new WeakMap<ServedServerOptions, ServerState>();

function stateOf(opts: ServedServerOptions, engine: BrainEngine): ServerState {
  let state = states.get(opts);
  if (!state) {
    state = {
      requests: new RequestTable(), budget: byteBudget(opts.parserBudgetBytes ?? 512 * 1024 * 1024), preauth: 0,
      serverId: randomUUID(), positions: opts.positions ?? storePositionReader(engine),
    };
    states.set(opts, state);
  }
  return state;
}

/** True for a transaction-bound engine handle (or any BrainEngine-shaped object) the server holds. */
function isEngineHandle(value: object): value is BrainEngine {
  try {
    const v = value as { kind?: unknown; getPage?: unknown; transaction?: unknown };
    return typeof v.kind === 'string' && typeof v.getPage === 'function' && typeof v.transaction === 'function';
  } catch {
    // A handle that refuses every read (a store member's "no database here" handle) crosses as a reference too: the
    // client's calls on it reach it on the server and refuse there, as in process.
    return true;
  }
}

interface OpenTxn {
  engine: BrainEngine;
  /** Ends a transaction the client opened: commit (resolve) or roll back (reject). Absent for a borrowed handle. */
  end?: { commit(): void; rollback(error: unknown): void; settled: Promise<unknown>; timer: ReturnType<typeof setTimeout> };
}

export function servedSession(side: ServedServerSide, opts: ServedServerOptions, ctx: SessionContext): ServedSession {
  const state = stateOf(opts, side.engine);
  const { socket, calls, transport } = ctx;
  const network = transport === 'tcp';
  let caps = new Set<string>();
  let principal: AuthenticatedPrincipal | null = null;
  let token: string | null = null;
  let invalid: Error | null = null;
  let authenticating = false;
  let preauthCounted = false;
  let closed = false;
  const backlog: Array<[Record<string, unknown>, Buffer | null, number]> = [];
  // Frames are handled in arrival order: a call whose preparation waits (a position, nothing else) holds back later
  // frames of the same connection, as one FIFO lane does on the owner.
  let chain: Promise<void> = Promise.resolve();
  // Calls whose preparation has not reached the dispatcher yet, so a cancel can still stop them.
  const preparing = new Map<number, AbortController>();
  const txns = new Map<string, OpenTxn>();
  const callbacks = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout>; call: ServedCall }>();
  let nextCallback = 1;
  let recheckTimer: ReturnType<typeof setInterval> | null = null;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseReader: (() => void) | null = null;

  // ---- writing frames ----
  const writeFrame = (frame: object, member?: string) => {
    if (socket.destroyed) return;
    if (!network) { ctx.send!(frame, member); return; }
    let wire: Wire = frame as unknown as Wire;
    let tail: Buffer | null = null;
    if (caps.has('binary_tail')) ({ value: wire, tail } = extractTail(wire));
    const buf = encodeLengthFrame(wire as object, tail);
    if (buf) { socket.write(buf); return; }
    const id = (frame as { id?: number }).id;
    if ((frame as { t?: string }).t === 'result' && member !== undefined) {
      socket.write(encodeLengthFrame({ t: 'result', id, ok: false, error: encodeErr(ownerResponseTooLarge(member, SERVED_MAX_FRAME_BYTES)) })!);
    }
  };

  /** An error in v3 form: on a network connection, without stack or cause. */
  const encodeErr = (error: unknown): Wire => {
    const wire = encodeError(error);
    if (!network || !wire || typeof wire !== 'object' || Array.isArray(wire) || !Array.isArray(wire.props)) return wire;
    return { ...wire, props: (wire.props as Wire[]).filter(p => !(Array.isArray(p) && (p[0] === 'stack' || p[0] === 'cause'))) };
  };

  const refuseConnection = (error: unknown) => {
    if (socket.destroyed) return;
    const frame = { t: 'refused', error: encodeErr(error) };
    const drain = setTimeout(() => socket.destroy(), 1000);
    drain.unref();
    socket.once('close', () => clearTimeout(drain));
    if (network) socket.end(encodeLengthFrame(frame)!);
    else { ctx.send!(frame); socket.end(); }
  };

  const leavePreauth = () => { if (preauthCounted) { preauthCounted = false; state.preauth--; } };

  // ---- the network transport reads its own frames ----
  if (network) {
    if (state.preauth >= (opts.preauthMaxConnections ?? 32)) {
      refuseConnection(servedProtocol('budget_exhausted', 'reason=preauth_connections'));
    } else {
      state.preauth++;
      preauthCounted = true;
      helloTimer = setTimeout(() => {
        if (principal || closed) return;
        refuseConnection(servedProtocol('hello_timeout', `timeout_ms=${opts.helloTimeoutMs ?? 5000}`));
      }, opts.helloTimeoutMs ?? 5000);
      helloTimer.unref?.();
      releaseReader = readLengthFrames(socket, {
        maxFrameBytes: () => principal ? SERVED_MAX_FRAME_BYTES : SERVED_PREAUTH_FRAME_BYTES,
        budget: state.budget,
        onFrame: (frame, tail, bytes) => onFrame(frame, tail, bytes),
        onBad: why => {
          // The reader destroys the socket; a refusal frame is best effort.
          const reason = why === 'frame_too_large' ? (principal ? 'frame_malformed' : 'hello_too_large') : why === 'budget_exhausted' ? 'budget_exhausted' : 'frame_malformed';
          try { socket.write(encodeLengthFrame({ t: 'refused', error: encodeErr(servedProtocol(reason, `why=${why}`)) })!); } catch { /* closing */ }
        },
      });
    }
  }

  // ---- hello ----
  const onHello = (frame: Record<string, unknown>) => {
    if (principal || authenticating) { refuseConnection(servedProtocol('frame_malformed', 'reason=second_hello')); return; }
    const offered = Array.isArray(frame.caps) ? new Set(frame.caps.filter((c): c is string => typeof c === 'string')) : new Set<string>();
    caps = new Set(SERVED_SERVER_CAPS.filter(c => offered.has(c) && (c !== 'binary_tail' || network) && (c !== 'txn' || opts.transactions?.() === true)));
    const auth = frame.auth as { scheme?: unknown; token?: unknown } | undefined;
    const presented = auth && typeof auth === 'object' && auth.scheme === 'bearer' ? auth.token : undefined;
    const done = (who: AuthenticatedPrincipal) => {
      principal = who;
      leavePreauth();
      if (helloTimer) clearTimeout(helloTimer);
      const answer = { ...ctx.hello, t: 'hello', v: OWNER_IPC_VERSION_V3, version: OWNER_IPC_VERSION_V3, caps: [...caps], server_id: state.serverId };
      writeFrame(answer);
      if (who.kind === 'owner_token' && token !== null) {
        recheckTimer = setInterval(() => {
          if (closed || invalid) return;
          void recheckToken(side.engine, token!, principal!, opts.verify).then(p => { principal = p; }, (error: unknown) => { invalid = error as Error; });
        }, RECHECK_MS);
        recheckTimer.unref?.();
      }
      for (const [f, t, b] of backlog.splice(0)) onFrame(f, t, b);
    };
    if (!network && presented === undefined) { done(LOCAL_OWNER); return; }
    authenticating = true;
    token = typeof presented === 'string' ? presented : null;
    void authenticateToken(side.engine, presented, opts.verify).then(
      who => { authenticating = false; if (!closed) done(who); },
      (error: unknown) => { authenticating = false; backlog.length = 0; refuseConnection(error); });
  };

  const staleCredential = (): Error | null => {
    if (invalid) return invalid;
    if (principal?.expiresAt !== undefined && principal.expiresAt <= Date.now()) return (invalid = servedAuthRefused('token_expired', null));
    return null;
  };

  // ---- one call ----
  const replyDirect = (id: number, member: string, error: unknown) => writeFrame({ t: 'result', id, ok: false, error: encodeErr(error) }, member);

  const prepareCall = async (frame: Record<string, unknown>, tail: Buffer | null, bytes: number): Promise<void> => {
    const id = Number(frame.id);
    const kind = frame.t === 'fn' ? 'fn' : 'call';
    const member = String(kind === 'fn' ? frame.name : frame.member);
    const stale = staleCredential();
    if (stale) { replyDirect(id, member, stale); return; }
    let remote: boolean;
    try { remote = effectiveRemote(principal!, frame.remote, member); } catch (error) { replyDirect(id, member, error); return; }
    if (remote && (kind === 'fn' || !OWNER_IPC_REMOTE_READS.has(member))) {
      replyDirect(id, member, ownerIpcRefusal(member, kind === 'fn'
        ? 'a remote caller\'s whole operation is not sent to the brain owner'
        : 'a remote caller\'s write is not sent to the brain owner'));
      return;
    }
    if (kind === 'fn' && network && SERVER_PATH_OPERATIONS.has(member)) { replyDirect(id, member, servedAdminPath(member)); return; }
    let args = frame.args as Wire;
    let access = frame.access as Wire | undefined;
    try {
      if (tail) { args = restoreTail(args, tail); if (access !== undefined) access = restoreTail(access, tail); }
    } catch { replyDirect(id, member, servedProtocol('frame_malformed', 'reason=tail_reference')); return; }
    // A call inside a transaction the client holds runs on that transaction at once, outside the permit queue: the
    // call that holds the transaction already holds a permit (a borrowed handle) or the writer (a client's own).
    // Not awaited: such a call may call back into the client, whose own calls on the transaction arrive behind it.
    if (frame.txn !== undefined) { void runInTransaction(id, member, String(frame.txn), args, remote); return; }
    // Request ids (decision 6).
    let entry: ReturnType<RequestTable['begin']> | null = null;
    const req = frame.req;
    if (req !== undefined && caps.has('request_ids')) {
      if (typeof req !== 'string' || !REQUEST_ID.test(req)) { replyDirect(id, member, servedProtocol('frame_malformed', 'reason=req')); return; }
      const journaled = kind === 'fn' && member === OWNER_RUN_OPERATION && Array.isArray(args) && typeof args[0] === 'string' && JOURNALED_OPERATIONS.has(args[0]);
      if (journaled && Array.isArray(args) && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1]) && (args[1] as Record<string, Wire>).request_id === undefined) {
        // The journal's request id is the wire's: a retry after a restart is answered by the journal's own receipt.
        args = [args[0]!, { ...(args[1] as Record<string, Wire>), request_id: req }, ...(args as Wire[]).slice(2)];
      }
      const ph = createHash('sha256').update(`${kind}\u0000${member}\u0000`).update(JSON.stringify(args)).digest('hex');
      entry = state.requests.begin(principal!.key, req, ph, member, frame.retry === true, ownerMemberOnlyReads(member) || journaled);
      if (entry.kind === 'conflict') { replyDirect(id, member, servedReqConflict(member, req)); return; }
      if (entry.kind === 'unknown') { replyDirect(id, member, servedOutcomeUnknown(member, req)); return; }
      if (entry.kind === 'stored') { writeFrame({ t: 'result', id, ...entry.outcome }, member); return; }
      if (entry.kind === 'attach') {
        // Answered when the running call ends; later frames of this connection do not wait for it.
        void entry.outcome.then(outcome => writeFrame(outcome ? { t: 'result', id, ...outcome }
          : { t: 'result', id, ok: false, error: encodeErr(servedOutcomeUnknown(member, req)) }, member));
        return;
      }
    }
    const tracked = entry && (entry.kind === 'fresh' || entry.kind === 'replay') ? entry.entry : null;
    // Read-your-writes (I-2): wait for the published position before the call is queued.
    if (frame.min_position !== undefined && caps.has('positions')) {
      const wanted = parsePositionToken(frame.min_position);
      if (!wanted) { if (tracked) state.requests.abandon(tracked); replyDirect(id, member, servedPositionRefused(member, 'malformed')); return; }
      const reader = state.positions;
      const now = reader ? await reader() : null;
      if (!now || !now.exact) { if (tracked) state.requests.abandon(tracked); replyDirect(id, member, servedPositionRefused(member, 'unsupported')); return; }
      const deadlineAt = typeof frame.deadline_at === 'number' ? frame.deadline_at : Date.now() + (opts.positionWaitMs ?? 30_000);
      const abort = new AbortController();
      preparing.set(id, abort);
      const waited = await waitForPosition(reader!, wanted, deadlineAt, abort.signal);
      preparing.delete(id);
      if (abort.signal.aborted) { if (tracked) state.requests.abandon(tracked); return; }
      if (!waited.reached) {
        if (tracked) state.requests.abandon(tracked);
        replyDirect(id, member, servedPositionNotReached(member, positionToken(wanted), waited.published ? positionToken(waited.published) : null, Math.max(0, deadlineAt - Date.now())));
        return;
      }
    }
    const hooks: ServedHooks = {
      encodeError: encodeErr,
      neverRan: () => { if (tracked) state.requests.abandon(tracked); },
      settle: async (call, ok, value) => {
        let outcome: StoredOutcome;
        if (ok) {
          try { outcome = { ok: true, value: encodeValue(value) }; } catch (error) { outcome = { ok: false, error: encodeErr(error) }; }
        } else outcome = { ok: false, error: encodeErr(value) };
        if (outcome.ok && call.write && caps.has('positions') && state.positions) {
          try { const p = await state.positions(); if (p?.exact) outcome.position = { sequence: p.sequence, index: p.index }; } catch { /* no position */ }
        }
        if (!outcome.ok && !(value instanceof Error && 'code' in value)) {
          const cid = randomUUID();
          (opts.log ?? ((line: string) => console.error(line)))(`[gbrain serve] served call failed cid=${cid} member=${call.member}: ${value instanceof Error ? value.stack ?? value.message : String(value)}`);
          (outcome as StoredOutcome & { cid?: string }).cid = cid;
        }
        if (tracked) state.requests.finish(tracked, outcome);
        if (!call.done) call.reply({ t: 'result', id: call.id, ...outcome });
      },
      wrapRun: fn => remote ? withRemoteCaller(true, fn) : fn(),
      staleCredential,
      rebuildFunction: (wire, call) => rebuildFunction(wire, call),
    };
    side.admit({ ...frame, args, ...(access !== undefined ? { access } : {}) }, bytes, calls, writeFrame, hooks);
  };

  // ---- callbacks that return a value (decision 2a) ----
  const encodeCallbackArgs = (args: unknown[], borrowed: string[]): Wire => encodeValue(args, {
    onObject: value => {
      if (!isEngineHandle(value)) return undefined;
      const ref = randomUUID();
      txns.set(ref, { engine: value });
      borrowed.push(ref);
      return { $t: 'txref', id: ref };
    },
  });

  const rebuildFunction = (wire: { [key: string]: Wire }, call: ServedCall): unknown => {
    if (wire.grouper && typeof wire.grouper === 'object' && !Array.isArray(wire.grouper)) {
      const types = (wire.grouper.types as string[] | undefined) ?? [];
      const groups = (wire.grouper.groups as string[] | undefined) ?? [];
      return (input: string[]) => input.map(type => { const at = types.indexOf(type); return at === -1 ? type : groups[at]; });
    }
    const key = typeof wire.k === 'string' ? wire.k : '';
    if (wire.r !== 1 || !caps.has('callbacks')) {
      return (...args: unknown[]) => {
        if (call.done) return;
        try { writeFrame({ t: 'cb', id: call.id, key, args: encodeValue(args) }); } catch { /* a notification never fails the call */ }
      };
    }
    return (...args: unknown[]) => new Promise<unknown>((resolve, reject) => {
      if (call.done || closed) { reject(servedCallbackTimeout(call.member, 0)); return; }
      const cb = nextCallback++;
      const borrowed: string[] = [];
      const finish = () => { for (const ref of borrowed) txns.delete(ref); };
      const ms = opts.callbackTimeoutMs ?? 10_000;
      const timer = setTimeout(() => { callbacks.delete(cb); finish(); reject(servedCallbackTimeout(call.member, ms)); }, ms);
      timer.unref?.();
      callbacks.set(cb, { resolve: v => { finish(); resolve(v); }, reject: e => { finish(); reject(e); }, timer, call });
      let encoded: Wire;
      try { encoded = encodeCallbackArgs(args, borrowed); } catch (error) { clearTimeout(timer); callbacks.delete(cb); finish(); reject(error); return; }
      writeFrame({ t: 'cbcall', id: call.id, cb, key, args: encoded });
    });
  };

  const onCallbackResult = (frame: Record<string, unknown>, tail: Buffer | null) => {
    const cb = typeof frame.cb === 'number' ? callbacks.get(frame.cb) : undefined;
    if (!cb) return;
    callbacks.delete(frame.cb as number);
    clearTimeout(cb.timer);
    try {
      const raw = (frame.ok === true ? frame.value : frame.error) as Wire;
      const restored = tail ? restoreTail(raw, tail) : raw;
      if (frame.ok === true) cb.resolve(decodeValue(restored)); else cb.reject(decodeError(restored));
    } catch (error) { cb.reject(error); }
  };

  // ---- transactions over the wire (decision 2b) ----
  const runInTransaction = async (id: number, member: string, ref: string, args: Wire, remote: boolean) => {
    const open = txns.get(ref);
    if (!open) { replyDirect(id, member, ownerIpcRefusal(member, 'its transaction is not open on this connection')); return; }
    let method: unknown;
    try { method = (open.engine as unknown as Record<string, unknown>)[member]; } catch (error) { replyDirect(id, member, error); return; }
    if (typeof method !== 'function') { replyDirect(id, member, ownerIpcRefusal(member, 'it is not a member of the transaction handle')); return; }
    const fake: ServedCall = { id, member, write: !ownerMemberOnlyReads(member), done: false, reply: f => { fake.done = true; writeFrame(f, member); } };
    let decoded: unknown;
    try {
      decoded = decodeValue(args, { onFunction: wire => rebuildFunction(wire, fake), onTxRef: wire => txns.get(String(wire.id))?.engine });
    } catch (error) { replyDirect(id, member, error); return; }
    if (!Array.isArray(decoded)) { replyDirect(id, member, servedProtocol('frame_malformed', 'reason=args')); return; }
    const run = () => (method as (...a: unknown[]) => Promise<unknown>).apply(open.engine, decoded as unknown[]);
    try {
      const value = await (remote ? withRemoteCaller(true, run) : run());
      writeFrame({ t: 'result', id, ok: true, value: encodeValue(value) }, member);
    } catch (error) {
      writeFrame({ t: 'result', id, ok: false, error: encodeErr(error) }, member);
    }
  };

  const onTxnFrame = (frame: Record<string, unknown>) => {
    const id = Number(frame.id);
    const op = frame.op;
    if (op === 'begin') {
      if (!caps.has('txn')) { replyDirect(id, 'transaction', ownerIpcRefusal('transaction', 'transactions do not cross the connection to this brain server yet')); return; }
      const parentRef = frame.txn === undefined ? undefined : String(frame.txn);
      const parent = parentRef === undefined ? side.engine : txns.get(parentRef)?.engine;
      if (!parent) { replyDirect(id, 'transaction', ownerIpcRefusal('transaction', 'its parent transaction is not open on this connection')); return; }
      const ref = randomUUID();
      const maxMs = opts.transactionMaxMs ?? 30_000;
      let commit!: () => void; let rollback!: (e: unknown) => void;
      const ended = new Promise<void>((resolve, reject) => { commit = resolve; rollback = reject; });
      ended.catch(() => undefined);
      let answered = false;
      const settled = parent.transaction(async tx => {
        const timer = setTimeout(() => rollback(servedTransactionDeadline(maxMs)), maxMs);
        timer.unref?.();
        txns.set(ref, { engine: tx, end: { commit, rollback, settled: ended, timer } });
        answered = true;
        writeFrame({ t: 'result', id, ok: true, value: ref });
        try { await ended; } finally { clearTimeout(timer); txns.delete(ref); }
      }, frame.read_only === true ? { readOnly: true } : undefined);
      // A begin that failed before its callback ran is answered here; a later failure answers the commit.
      settled.catch((error: unknown) => { if (!answered) { answered = true; writeFrame({ t: 'result', id, ok: false, error: encodeErr(error) }); } });
      txnSettled.set(ref, settled);
      return;
    }
    const ref = String(frame.txn);
    const open = txns.get(ref);
    const settled = txnSettled.get(ref);
    if (!open?.end || !settled) { replyDirect(id, 'transaction', ownerIpcRefusal('transaction', 'it is not open on this connection')); return; }
    if (op === 'commit') open.end.commit(); else open.end.rollback(Object.assign(new Error('rolled back by the client'), { rolledBackByClient: true }));
    void settled.then(
      () => writeFrame({ t: 'result', id, ok: true, value: null }),
      (error: unknown) => writeFrame(op === 'rollback' && (error as { rolledBackByClient?: boolean })?.rolledBackByClient
        ? { t: 'result', id, ok: true, value: null }
        : { t: 'result', id, ok: false, error: encodeErr(error) }),
    ).finally(() => { txnSettled.delete(ref); });
  };
  const txnSettled = new Map<string, Promise<unknown>>();

  // ---- frames ----
  function onFrame(frame: Record<string, unknown>, tail: Buffer | null, bytes: number): void {
    if (closed) return;
    if (!principal) {
      if (frame.t === 'hello' && !authenticating) { onHello(frame); return; }
      if (authenticating) { backlog.push([frame, tail, bytes]); return; }
      refuseConnection(servedProtocol('frame_malformed', 'reason=hello_missing'));
      return;
    }
    switch (frame.t) {
      case 'call': case 'fn': {
        const id = Number(frame.id);
        chain = chain.then(() => prepareCall(frame, tail, bytes)).catch(error => {
          replyDirect(id, String(frame.t === 'fn' ? frame.name : frame.member), error);
        });
        return;
      }
      case 'cancel': {
        const id = Number(frame.id);
        preparing.get(id)?.abort();
        side.cancel(calls, id);
        return;
      }
      case 'cbresult': onCallbackResult(frame, tail); return;
      case 'txn': onTxnFrame(frame); return;
      case 'hello': refuseConnection(servedProtocol('frame_malformed', 'reason=second_hello')); return;
      default: return; // unknown frame types are ignored (I-7)
    }
  }

  return {
    onFrame,
    close: () => {
      if (closed) return;
      closed = true;
      leavePreauth();
      if (helloTimer) clearTimeout(helloTimer);
      if (recheckTimer) clearInterval(recheckTimer);
      releaseReader?.();
      for (const abort of preparing.values()) abort.abort();
      for (const [cb, pending] of callbacks) { clearTimeout(pending.timer); callbacks.delete(cb); pending.reject(servedCallbackTimeout(pending.call.member, 0)); }
      // A transaction the client held rolls back with its connection.
      for (const open of txns.values()) open.end?.rollback(servedTransactionDeadline(0));
    },
  };
}
