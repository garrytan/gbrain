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
import { withEngineScope } from '../../engine-scope.ts';
import { ENGINE_ROOT } from '../../engine-root.ts';
import { noteSchemaVersion } from '../../migrate-pending.ts';
import { encodeError, encodeValue, type Wire } from '../owner-ipc/codec.ts';
import {
  OWNER_IPC_VERSION_V3, SERVED_SERVER_CAPS, parsePositionToken, positionToken, type OwnerHello,
} from '../owner-ipc/protocol.ts';
import { OWNER_IPC_REMOTE_READS, ownerIpcRefusal, ownerMemberOnlyReads } from '../owner-ipc/routes.ts';
import { OWNER_RUN_OPERATION } from '../owner-ipc/whole-op.ts';
import { remoteWholeOperationCall } from './remote-whole-ops.ts';
import { LOCAL_OWNER, RECHECK_MS, authenticateToken, effectiveRemote, recheckToken, type AuthenticatedPrincipal, type VerifyDeps } from './auth.ts';
import {
  servedAdminPath, servedAuthRefused, servedPositionNotReached, servedPositionRefused, servedProtocol, servedReqConflict,
  servedOutcomeUnknown,
} from './errors.ts';
import {
  SERVED_MAX_FRAME_BYTES, SERVED_PREAUTH_FRAME_BYTES, byteBudget, encodeLengthFrame, extractTail, readLengthFrames, restoreTail,
  type ByteBudget,
} from './framing.ts';
import { storePositionReader, waitForPosition, type PositionReader } from './positions.ts';
import { sessionCalls } from './session-calls.ts';
import { primaryFollowerSession, type FollowerServeOptions, type PrimaryFollowerSession } from './follower-serve.ts';
import { FOLLOWER_CAP } from './follower-frames.ts';
import { MAX_REQUEST_WAITERS, REQUEST_ID, RequestTable, type StoredOutcome } from './requests.ts';
import { ownerBusy, ownerResponseTooLarge } from '../owner-ipc/routes.ts';

/** Whole operations a network client may not send: they name paths on the server host (decision 9). */
/** How long a token recheck may run before the connection stops taking new work. */
const RECHECK_HUNG_MS = 30_000;

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
  /** How long a token recheck may run before the connection stops taking new work (default 30 s). */
  recheckHungMs?: number;
  /** Following (follower-serve.ts): present only with multi-user Rust on; offered only to an owner server token. */
  follower?: FollowerServeOptions;
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

/** Scope objects for one session, one per schema version, each keyed to itself (ENGINE_ROOT). */
function scopeCache(): (sv: unknown) => object {
  const scopes = new Map<number | null, object>();
  return (sv: unknown): object => {
    const version = typeof sv === 'number' && Number.isInteger(sv) ? sv : null;
    let scope = scopes.get(version);
    if (!scope) {
      scope = {};
      Object.defineProperty(scope, ENGINE_ROOT, { value: scope });
      if (version !== null) noteSchemaVersion(scope, version);
      scopes.set(version, scope);
    }
    return scope;
  };
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
  // Frames are handled in arrival order: a call whose preparation waits (a position, nothing else) holds back later
  // frames of the same connection, as one FIFO lane does on the owner.
  let chain: Promise<void> = Promise.resolve();
  // Calls whose preparation has not reached the dispatcher yet, so a cancel can still stop them.
  const preparing = new Map<number, AbortController>();
  let follower: PrimaryFollowerSession | null = null;
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
      follower = primaryFollowerSession({ engine: side.engine, principal: who, network, offered: offered.has(FOLLOWER_CAP), opts: opts.follower, socket, refuse: refuseConnection, log: opts.log });
      if (follower) caps.add(FOLLOWER_CAP);
      const answer = { ...ctx.hello, t: 'hello', v: OWNER_IPC_VERSION_V3, version: OWNER_IPC_VERSION_V3, caps: [...caps], server_id: state.serverId };
      writeFrame(answer);
      if (who.kind === 'owner_token' && token !== null) {
        recheckTimer = setInterval(() => {
          if (closed || invalid || checkingSince !== null) return;
          checkingSince = Date.now();
          void recheckToken(side.engine, token!, principal!, opts.verify)
            .then(p => { principal = p; }, (error: unknown) => { invalid = error as Error; })
            .finally(() => { checkingSince = null; });
        }, RECHECK_MS);
        recheckTimer.unref?.();
      }
    };
    if (!network && presented === undefined) { done(LOCAL_OWNER); return; }
    authenticating = true;
    token = typeof presented === 'string' ? presented : null;
    void authenticateToken(side.engine, presented, opts.verify).then(
      who => { authenticating = false; if (!closed) done(who); },
      (error: unknown) => { authenticating = false; refuseConnection(error); });
  };

  // When the running recheck started: one that has not answered within RECHECK_HUNG_MS stops new work too (review G2).
  // A recheck that is merely late (a busy event loop) does not: it is the verifier that must answer, not the timer.
  let checkingSince: number | null = null;
  const staleCredential = (): Error | null => {
    if (invalid) return invalid;
    if (checkingSince !== null && Date.now() - checkingSince > (opts.recheckHungMs ?? RECHECK_HUNG_MS)) return servedAuthRefused('token_expired', null);
    if (principal?.expiresAt !== undefined && principal.expiresAt <= Date.now()) return (invalid = servedAuthRefused('token_expired', null));
    return null;
  };

  // ---- the caller's engine scope ----
  // A call made in its engine's scope on the client runs in a scope here that answers what that one did: the schema
  // version the client's engine recorded. One scope object per version and session, keyed to itself (ENGINE_ROOT), so
  // what a client recorded never changes the owner engine's own record.
  const scopeFor = scopeCache();

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
    // A remote write crosses only as a whole operation of the closed list, and only for the owner's floor until A1 lifts
    // (served/remote-whole-ops.ts); any other principal's remote whole operation is refused before anything runs.
    if (remote && remoteWholeOperationCall(kind, member, frame.args) && !ownerFloor(principal!)) {
      replyDirect(id, member, ownerIpcRefusal(member, 'a remote whole operation of a principal other than the brain owner waits for per-user access'));
      return;
    }
    if (remote && !remoteWholeOperationCall(kind, member, frame.args) && (kind === 'fn' || !OWNER_IPC_REMOTE_READS.has(member))) {
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
    if (frame.txn !== undefined) {
      const scoped = frame.scope && typeof frame.scope === 'object' ? (frame.scope as { sv?: unknown }).sv : undefined;
      void runInTransaction(id, member, String(frame.txn), args, remote, scoped === undefined ? undefined : <T>(fn: () => T) => withEngineScope(scopeFor(scoped), fn),
        { access, deadlineAt: typeof frame.deadline_at === 'number' ? frame.deadline_at : undefined });
      return;
    }
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
      // Replay is bound to everything that shapes the answer: the call, its arguments, the caller access record, the
      // remote mark and the engine scope (review G4).
      const ph = createHash('sha256').update(`${kind}\u0000${member}\u0000`).update(JSON.stringify(args))
        .update(`\u0000${JSON.stringify(access ?? null)}\u0000${remote}\u0000${JSON.stringify(frame.scope ?? null)}`).digest('hex');
      entry = state.requests.begin(principal!.key, req, ph, member, frame.retry === true, ownerMemberOnlyReads(member) || journaled);
      if (entry.kind === 'conflict') { replyDirect(id, member, servedReqConflict(member, req)); return; }
      if (entry.kind === 'busy') { replyDirect(id, member, ownerBusy('queue_full', member, MAX_REQUEST_WAITERS)); return; }
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
    // Until the call reaches the dispatcher this preparation owns its request record: every way out before that
    // forgets it, so a retry never waits on a call that will not run (review G5).
    let handed = false;
    const abort = new AbortController();
    preparing.set(id, abort);
    try {
      // Read-your-writes (I-2): wait for the published position before the call is queued.
      if (frame.min_position !== undefined && caps.has('positions')) {
        const wanted = parsePositionToken(frame.min_position);
        if (!wanted) { replyDirect(id, member, servedPositionRefused(member, 'malformed')); return; }
        const reader = state.positions;
        const now = reader ? await reader() : null;
        if (!now || !now.exact) { replyDirect(id, member, servedPositionRefused(member, 'unsupported')); return; }
        const deadlineAt = typeof frame.deadline_at === 'number' ? frame.deadline_at : Date.now() + (opts.positionWaitMs ?? 30_000);
        const waited = await waitForPosition(reader!, wanted, deadlineAt, abort.signal);
        if (abort.signal.aborted) return;
        if (!waited.reached) {
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
        wrapRun: fn => {
          const inScope = frame.scope && typeof frame.scope === 'object' ? () => withEngineScope(scopeFor((frame.scope as { sv?: unknown }).sv), fn) : fn;
          return remote ? withRemoteCaller(true, inScope) : inScope();
        },
        staleCredential,
        rebuildFunction: (wire, call) => rebuildFunction(wire, call),
      };
      if (closed || abort.signal.aborted) return;
      handed = true;
      side.admit({ ...frame, args, ...(access !== undefined ? { access } : {}) }, bytes, calls, writeFrame, hooks);
    } finally {
      preparing.delete(id);
      if (!handed && tracked) state.requests.abandon(tracked);
    }
  };

  // Returning callbacks and transactions over the wire (session-calls.ts).
  const { rebuildFunction, onCallbackResult, runInTransaction, onTxnFrame, closeCalls } = sessionCalls({
    side, opts, caps: () => caps, closed: () => closed, writeFrame, encodeErr, replyDirect, staleCredential,
  });

  // ---- frames ----
  function onFrame(frame: Record<string, unknown>, tail: Buffer | null, bytes: number): void {
    if (closed) return;
    if (!principal) {
      if (frame.t === 'hello' && !authenticating) { onHello(frame); return; }
      // Nothing but the hello runs before the hello is answered: the client waits for it, and the server holds no
      // frame of a connection it has not authenticated (review G1).
      if (authenticating) { refuseConnection(servedProtocol('frame_malformed', 'reason=frame_before_hello_answer')); return; }
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
      case 'repl_follow': case 'repl_ack': case 'repl_snap_window': follower?.onFrame(frame, tail); return;
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
      closeCalls();
      follower?.close();
    },
  };
}

/** The brain owner's floor: the local owner or an owner server token, with no store-built record (B3) and not remote. */
function ownerFloor(principal: AuthenticatedPrincipal): boolean {
  return (principal.kind === 'local_owner' || principal.kind === 'owner_token') && !principal.floorRemote
    && (principal as { record?: unknown }).record === undefined;
}
