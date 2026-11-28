/**
 * Returning callbacks and transactions over the wire for one protocol v3 session (session.ts; decisions 2a and 2b of
 * the L3 plan).
 *
 * - A function argument the client marks returning (`{ $t: 'fn', k, r: 1 }`) becomes an async function on the server
 *   that sends `cbcall` and waits for `cbresult`, bounded by callbackTimeoutMs. An engine handle among its arguments
 *   (an open transaction) crosses as `{ $t: 'txref', id }`; the client's calls on it carry `txn` and run on it here,
 *   outside the permit queue (the call that lent it holds a permit).
 * - `txn` frames open a transaction on the server engine (or a savepoint in an open one), bound to this connection,
 *   committed or rolled back by the client, rolled back at transactionMaxMs and when the connection closes.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { withRemoteCaller } from '../../remote-caller.ts';
import { decodeError, decodeValue, encodeValue, type Wire } from '../owner-ipc/codec.ts';
import { OWNER_IPC_ROUTES, ownerCallTimeout, ownerIpcRefusal, ownerMemberOnlyReads } from '../owner-ipc/routes.ts';
import { withCallerAccess, withoutCallerAccess, type CallerAccess } from '../../search/private-visibility.ts';
import { heldRowHook } from '../owner-ipc/held-row.ts';
import { SERVED_TXN_CONFLICT_REASON, servedCallbackTimeout, servedProtocol, servedTransactionConflict, servedTransactionDeadline } from './errors.ts';
import { newTransactionRerun, noteLostConflict, OPTIMISTIC_TRANSACTION_RETRIES, withTransactionRerun, type TransactionRerun } from '../optimistic-transaction.ts';
import { restoreTail } from './framing.ts';
import type { ServedCall, ServedServerOptions, ServedServerSide } from './session.ts';
import { STORE_RETURNING_MEMBERS as STORE_MEMBERS_RETURNING, servedBrainMethod } from './store-returning.ts';

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

/** Lost transactions a connection keeps for its client's reruns (one per transaction the client is running again). */
const MAX_KEPT_RERUNS = 256;

interface OpenTxn {
  engine: BrainEngine;
  /** Ends a transaction the client opened: commit (resolve) or roll back (reject). Absent for a borrowed handle. */
  end?: { commit(): void; rollback(error: unknown): void; settled: Promise<unknown>; timer: ReturnType<typeof setTimeout> };
  /** What the top-level transaction's runs learned for a rerun (shared by its savepoints); absent for a borrowed handle. */
  rerun?: CarriedRerun;
}

/** A top-level transaction's rerun state, and whether a call inside it lost a conflict (the client then runs it again). */
interface CarriedRerun { state: TransactionRerun; lostInCall: boolean }

export interface SessionCallsContext {
  side: ServedServerSide;
  opts: ServedServerOptions;
  caps: () => ReadonlySet<string>;
  closed: () => boolean;
  writeFrame(frame: object, member?: string): void;
  encodeErr(error: unknown): Wire;
  replyDirect(id: number, member: string, error: unknown): void;
  /** The connection's credential refusal, or null while it still works (session.ts). */
  staleCredential(): Error | null;
}

export function sessionCalls(ctx: SessionCallsContext) {
  const { side, opts, writeFrame, encodeErr, replyDirect } = ctx;
  const txns = new Map<string, OpenTxn>();
  // Top-level transactions of this connection that lost their commit, by id: what their runs kept (the keys they lost on,
  // their age), so the client's rerun, which names the lost id in its begin (`rerun_of`), keeps its place in line as a
  // rerun does in process. Taken once; only this connection's own ids are found here; the oldest goes past the bound.
  // A chain keeps its place for at most the rerun bound (OPTIMISTIC_TRANSACTION_RETRIES, the client's bound too): a
  // client that runs a transaction again past it starts fresh, so no client can stay the oldest writer by never stopping.
  const reruns = new Map<string, { state: TransactionRerun; losses: number }>();
  const callbacks = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout>; call: ServedCall }>();
  let nextCallback = 1;
  const caps = { has: (c: string) => ctx.caps().has(c) };

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
    if (wire.heldRow === true) return heldRowHook(call.member); // the client keeps the policy's decide hook (held-row.ts)
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
      if (call.done || ctx.closed()) { reject(servedCallbackTimeout(call.member, 0)); return; }
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
    // A callback answer resumes work: once the credential stopped working the call fails instead (review G2).
    const stale = ctx.staleCredential();
    if (stale) { cb.reject(stale); return; }
    try {
      const raw = (frame.ok === true ? frame.value : frame.error) as Wire;
      const restored = tail ? restoreTail(raw, tail) : raw;
      if (frame.ok === true) cb.resolve(decodeValue(restored)); else cb.reject(decodeError(restored));
    } catch (error) { cb.reject(error); }
  };

  // ---- transactions over the wire (decision 2b) ----
  const runInTransaction = async (id: number, member: string, ref: string, args: Wire, remote: boolean, inScope?: <T>(fn: () => T) => T,
    frameOpts: { access?: Wire; deadlineAt?: number } = {}) => {
    const open = txns.get(ref);
    if (!open) { replyDirect(id, member, ownerIpcRefusal(member, 'its transaction is not open on this connection')); return; }
    // The dispatcher's rules hold here too (review G8): the caller's deadline, and a caller access record that is an
    // object with an identity list; a plain member must be one the owner forwards (owner-ipc/routes.ts).
    if (frameOpts.deadlineAt !== undefined && Date.now() >= frameOpts.deadlineAt) { replyDirect(id, member, ownerCallTimeout(member, 0, 'queued')); return; }
    let access: CallerAccess | null = null;
    if (frameOpts.access !== undefined) {
      const decodedAccess = (() => { try { return decodeValue(frameOpts.access!); } catch { return undefined; } })();
      if (!decodedAccess || typeof decodedAccess !== 'object' || !Array.isArray((decodedAccess as { identity?: unknown }).identity)) {
        replyDirect(id, member, ownerIpcRefusal(member, 'its caller access record is not an object with an identity list'));
        return;
      }
      access = decodedAccess as CallerAccess;
    }
    let method: unknown;
    let self: unknown = open.engine;
    try {
      // `<member>.<method>`: a method of the store a member returns (served/engine.ts STORE_RETURNING_MEMBERS).
      const dot = member.indexOf('.');
      if (member.startsWith('brain.')) {
        // A store method on the transaction's own store (served/store-returning.ts SERVED_BRAIN_METHODS).
        const name = member.slice(6);
        if (!servedBrainMethod(name)) throw ownerIpcRefusal(member, 'it is not a store method a client may call');
        self = (await (open.engine as unknown as { storeFor(m: string): Promise<{ brain: Record<string, unknown> }> }).storeFor(name)).brain;
        method = (self as Record<string, unknown>)[name];
      } else if (dot > 0 && STORE_MEMBERS_RETURNING.has(member.slice(0, dot))) {
        self = await (open.engine as unknown as Record<string, () => Promise<Record<string, unknown>>>)[member.slice(0, dot)]!();
        const name = member.slice(dot + 1);
        method = Object.hasOwn(self as object, name) ? (self as Record<string, unknown>)[name] : undefined;
      } else if (Object.hasOwn(OWNER_IPC_ROUTES, member) && (OWNER_IPC_ROUTES as Record<string, string>)[member] === 'forward') {
        method = (open.engine as unknown as Record<string, unknown>)[member];
      } else throw ownerIpcRefusal(member, 'it is not sent across the owner socket');
    } catch (error) { replyDirect(id, member, error); return; }
    if (typeof method !== 'function') { replyDirect(id, member, ownerIpcRefusal(member, 'it is not a member of the transaction handle')); return; }
    const fake: ServedCall = { id, member, write: !ownerMemberOnlyReads(member), done: false, reply: f => { fake.done = true; writeFrame(f, member); } };
    let decoded: unknown;
    try {
      decoded = decodeValue(args, { onFunction: wire => rebuildFunction(wire, fake), onTxRef: wire => txns.get(String(wire.id))?.engine });
    } catch (error) { replyDirect(id, member, error); return; }
    if (!Array.isArray(decoded)) { replyDirect(id, member, servedProtocol('frame_malformed', 'reason=args')); return; }
    const invoke = () => (method as (...a: unknown[]) => Promise<unknown>).apply(self, decoded as unknown[]);
    const call = () => access ? withCallerAccess(access, invoke) : withoutCallerAccess(invoke);
    const run = inScope ? () => inScope(call) : call;
    try {
      const value = await (remote ? withRemoteCaller(true, run) : run());
      writeFrame({ t: 'result', id, ok: true, value: encodeValue(value) }, member);
    } catch (error) {
      // A call the store refused `write_conflict` makes the client run the transaction again: keep the key for that rerun.
      if (open.rerun && noteLostConflict(open.rerun.state, error)) open.rerun.lostInCall = true;
      writeFrame({ t: 'result', id, ok: false, error: encodeErr(error) }, member);
    }
  };

  const onTxnFrame = (frame: Record<string, unknown>) => {
    const id = Number(frame.id);
    const op = frame.op;
    // Begin and commit do work: once the credential stopped working they refuse, and a commit rolls back instead
    // (review G2). Rollback always runs, so cleanup never needs a working credential.
    const stale = op === 'rollback' ? null : ctx.staleCredential();
    if (stale && op === 'begin') { replyDirect(id, 'transaction', stale); return; }
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
      let runs = 0;
      // A top-level rerun of a transaction this connection lost keeps that transaction's keys and age; any other begin
      // starts fresh. A savepoint's lost commit is its top-level transaction's, so a savepoint carries nothing.
      const rerunOf = parentRef === undefined && typeof frame.rerun_of === 'string' ? frame.rerun_of : undefined;
      const kept = rerunOf !== undefined ? reruns.get(rerunOf) : undefined;
      if (rerunOf !== undefined) reruns.delete(rerunOf);
      const losses = kept?.losses ?? 0;
      const rerun = parentRef === undefined ? kept?.state ?? newTransactionRerun() : null;
      const carried: CarriedRerun | undefined = rerun ? { state: rerun, lostInCall: false } : txns.get(parentRef!)?.rerun;
      const readOnly = frame.read_only === true ? { readOnly: true } : undefined;
      const settled = parent.transaction(async tx => {
        // A second run means the first run's commit was lost and the engine would run the callback again. The callback
        // here only waits for the client, so a second run would commit nothing and answer success: end it, and the
        // client runs its own callback again (served/engine.ts runTransaction).
        if (++runs > 1) throw servedTransactionConflict();
        // A begin that got the writer after its connection closed rolls back at once (review G9).
        if (ctx.closed()) throw servedTransactionDeadline(0);
        const timer = setTimeout(() => rollback(servedTransactionDeadline(maxMs)), maxMs);
        timer.unref?.();
        txns.set(ref, { engine: tx, end: { commit, rollback, settled: ended, timer }, ...(carried ? { rerun: carried } : {}) });
        answered = true;
        writeFrame({ t: 'result', id, ok: true, value: ref });
        try { await ended; } finally { clearTimeout(timer); txns.delete(ref); }
      }, rerun ? withTransactionRerun(readOnly, rerun) : readOnly);
      // A lost commit (the engine would run the callback again): keep what its runs learned for the client's rerun.
      if (rerun) settled.catch((error: unknown) => {
        if ((error as { reason?: unknown } | null)?.reason !== SERVED_TXN_CONFLICT_REASON && !carried?.lostInCall) return;
        if (losses + 1 > OPTIMISTIC_TRANSACTION_RETRIES) return;
        reruns.set(ref, { state: rerun, losses: losses + 1 });
        if (reruns.size > MAX_KEPT_RERUNS) reruns.delete(reruns.keys().next().value!);
      });
      // A begin that failed before its callback ran is answered here; a later failure answers the commit.
      settled.catch((error: unknown) => { if (!answered) { answered = true; writeFrame({ t: 'result', id, ok: false, error: encodeErr(error) }); } });
      txnSettled.set(ref, settled);
      // Every way a transaction ends drops its bookkeeping, a deadline rollback included (review G9).
      settled.then(() => undefined, () => undefined).finally(() => { txnSettled.delete(ref); });
      return;
    }
    const ref = String(frame.txn);
    const open = txns.get(ref);
    const settled = txnSettled.get(ref);
    if (!open?.end || !settled) { replyDirect(id, 'transaction', ownerIpcRefusal('transaction', 'it is not open on this connection')); return; }
    if (stale) {
      open.end.rollback(stale);
      void settled.then(() => undefined, () => undefined).finally(() => replyDirect(id, 'transaction', stale));
      return;
    }
    if (op === 'commit') open.end.commit(); else open.end.rollback(Object.assign(new Error('rolled back by the client'), { rolledBackByClient: true }));
    void settled.then(
      // A commit answers the position its transaction committed at (the client's handle reports it after the end).
      async () => writeFrame({ t: 'result', id, ok: true, value: op === 'commit' ? encodeValue(await committedPosition(open.engine)) : null }),
      (error: unknown) => writeFrame(op === 'rollback' && (error as { rolledBackByClient?: boolean })?.rolledBackByClient
        ? { t: 'result', id, ok: true, value: null }
        : { t: 'result', id, ok: false, error: encodeErr(error) }),
    );
  };
  const txnSettled = new Map<string, Promise<unknown>>();

  /** The position a committed transaction's engine reports (`lastCommitPosition`), or null (no commit log, or none). */
  const committedPosition = async (engine: unknown): Promise<unknown> => {
    const read = (engine as { lastCommitPosition?: () => Promise<unknown> } | null)?.lastCommitPosition;
    if (typeof read !== 'function') return null;
    // A brain with no commit log refuses the read; the commit reply then carries null, as it always did.
    try { return (await read.call(engine)) ?? null; } catch { return null; }
  };

  const closeCalls = () => {
    for (const [cb, pending] of callbacks) { clearTimeout(pending.timer); callbacks.delete(cb); pending.reject(servedCallbackTimeout(pending.call.member, 0)); }
    // A transaction the client held rolls back with its connection.
    for (const open of txns.values()) open.end?.rollback(servedTransactionDeadline(0));
    reruns.clear();
  };

  return { rebuildFunction, onCallbackResult, runInTransaction, onTxnFrame, closeCalls };
}
