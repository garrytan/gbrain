/**
 * The transaction-aware shadow wrapper over the primary engine (plan PR S1; docs/designs/RUST_ENGINE.md, "What shadow
 * mode does").
 *
 * A Proxy over the primary BrainEngine. Every member reads through to the primary, bound to it, so the primary's own
 * code runs unchanged. For an allowlisted read (reads.ts) the wrapper calls the primary, returns the primary's promise
 * outcome to the caller unchanged, and, after the primary resolves and before the caller sees the result, offers the
 * sink a capture of `{ op, args, result, primary_ms }`. A sampled read encodes its arguments (codec.ts `encodeValue`)
 * before the primary call and its result inside that capture, so neither the primary nor the caller can change what
 * the shadow compares; unsampled reads encode nothing. Nothing awaits the sink and a sink or encode error never
 * reaches the caller. Writes are not mirrored as reads.
 *
 * `transaction` and `transactionDirect` hand the callback a wrapped transaction engine whose reads are counted as
 * `skipped_in_transaction` and not mirrored: a read inside an open transaction may see uncommitted state the shadow
 * cannot have. Reads with a function argument are counted `shed_unmirrorable` (a callback cannot cross the pipe).
 *
 * With the `follow` option the wrapper also watches writes (follow.ts): every committed write is published as an
 * invalidation batch after the outermost commit. Without it, writes pass through bound and untouched.
 */
import { AsyncResource } from 'node:async_hooks';
import type { BrainEngine } from '../core/engine.ts';
import { registerEngineView } from '../core/persistence/switches.ts';
import { callerAccessRecord } from '../core/search/private-visibility.ts';
import { CAPTURE_BUDGET_BYTES, CaptureTooLargeError, encodeArgs, encodeValue } from './codec.ts';
import { followRaw, followScope, followWrite, laneCall, newTxLane, startedWithin, type FollowContext, type FollowOptions, type Frame, type LaneEntry, type TxLane } from './follow.ts';
import type { CapturedRead, MirrorCounters, UsageField } from './mirror.ts';
import { isShadowReadMember, SHADOW_TRANSACTION_MEMBERS } from './reads.ts';
import { sqlWrites } from './sql-writes.ts';
import type { TxScope, WriteSampler } from './write-capture.ts';
import { IGNORED_WRITE_MEMBERS, memberKind } from './write-map.ts';

export interface ShadowSink {
  readonly counters: MirrorCounters;
  /** Takes a capture function; the sink calls it synchronously when it accepts the read (mirror.ts). */
  offer(capture: () => CapturedRead, op?: string): void;
  /** Notes one call of an operation class on the per-operation meter (mirror.ts `UsageMeter`); a sink without one skips it. */
  use?(op: string, field: UsageField): void;
  /** The generation and freshness token known BEFORE a read starts (mirror.ts `MirrorQueue.token`); a sink without one leaves the sample unproven. */
  token?(): { gen?: number; lsn?: string };
  /** False once mirroring stopped in this process (state off, restart budget spent, privacy pause). */
  active(): boolean;
}

export interface ShadowWrapperOptions {
  /** Share of eligible reads mirrored, 0..1. */
  sampleRate: number;
  /** Seam for tests; default Math.random. */
  random?: () => number;
  /** Seam for tests; default performance.now. */
  now?: () => number;
  /**
   * Shadow follow (follow.ts): when set, committed primary writes are published to this sink as invalidation batches.
   * Active only while the shadow sink is active; when off, writes cost nothing extra.
   */
  follow?: FollowOptions;
  /**
   * Swap eligibility (writer-observations.ts): called after each committed write, outside any transaction or when the
   * outermost transaction that wrote resolves. Independent of `follow` and of the sink's health.
   */
  onCommittedWrite?: () => void;
  /** Write comparisons (write-capture.ts): sampled writes are copied, counted and replayed on a scratch store. Left out when the brain was never seeded. */
  writes?: WriteSampler;
}

/** Whether the outermost transaction saw a write, and (with write comparisons on) the sampler's scope of it; shared by the transaction engine proxies it hands out. `nested`: inside a savepoint. */
interface TxWrites { wrote: boolean; scope?: TxScope; nested: boolean; /** Ids of the nested transactions (savepoints) this proxy runs in, outermost first: the writes it notes are dropped if one of them rolls back. */ path: number[]; /** The outermost transaction's call lane (follow.ts): a follow pre-read holds it while its savepoint is open. Set when follow is on. */ lane?: TxLane }

const TX_MEMBERS: ReadonlySet<PropertyKey> = new Set(SHADOW_TRANSACTION_MEMBERS);
/** How long a transaction's end waits for calls its callback started and did not await (`drained`). */
const DRAIN_MS = 2_000;
/** The members that return a value, not a promise: `registerBeforeDisconnect` is the only one BrainEngine declares (read off its type), `holdsDatastoreLock` the only one an engine class adds that callers reach. */
const SYNC_MEMBERS: ReadonlySet<PropertyKey> = new Set(['registerBeforeDisconnect', 'holdsDatastoreLock']);

/** Call order of the member calls the hold point sees (`held`): a held call waits in this order, whichever gate holds it. */
let callOrder = 0;
type Held = (() => void) & { order?: number };
/** Queues a held call by call order, so one the other gate held first keeps its place ahead of later calls. */
function enqueue(queue: Array<() => void>, order: number, start: () => void): void {
  const at = queue.findIndex((w) => ((w as Held).order ?? -Infinity) > order);
  const item: Held = Object.assign(start, { order });
  if (at < 0) queue.push(item); else queue.splice(at, 0, item);
}

function hasFunctionArg(args: unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg === 'function') return true;
    if (arg && typeof arg === 'object' && !Array.isArray(arg) && !ArrayBuffer.isView(arg)) {
      for (const [key, value] of Object.entries(arg)) if (key !== 'signal' && typeof value === 'function') return true;
    }
  }
  return false;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

/** Wraps `engine` for shadow mode. The result is registered as a view of `engine` (persistence/switches.ts). */
export function wrapShadowEngine<E extends BrainEngine>(engine: E, sink: ShadowSink, opts: ShadowWrapperOptions): E {
  return buildProxy(engine, sink, opts, false, null, null);
}

/** Whether a member call may write: a mapped or unmapped member, schema work, a reserved connection, raw SQL with a write statement, or an ignored member that writes the database (locks, logs, caches). A false yes only notes a process that writes anyway. */
function mayWrite(name: string, args: unknown[]): boolean {
  const kind = memberKind(name);
  if (kind === 'ignored') return IGNORED_WRITE_MEMBERS.has(name);
  if (kind === 'read_name') return false;
  if (kind === 'raw') {
    try { return typeof args[0] !== 'string' || sqlWrites(args[0]).length > 0; } catch { return true; }
  }
  return true;
}

/** A real method, not an accessor: `get sql()` hands out the driver client, a function with its own properties that a bound copy would lose. */
function isMethod(target: object, prop: PropertyKey): boolean {
  for (let o: object | null = target; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, prop);
    if (d) return !d.get && !d.set;
  }
  return true;
}

function buildProxy<E extends BrainEngine>(engine: E, sink: ShadowSink, opts: ShadowWrapperOptions, inTransaction: boolean, frame: Frame | null, txWrites: TxWrites | null): E {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => performance.now());
  const sampleRate = Math.min(1, Math.max(0, opts.sampleRate));
  // Bound functions cached per member, re-bound when the primary replaces a member (the factory wraps disconnect).
  const cache = new Map<PropertyKey, { original: Function; wrapped: Function }>();

  const use = (op: string, field: UsageField): void => { try { sink.use?.(op, field); } catch { /* fail open */ } };

  const wrapRead = (op: string, fn: Function): Function => function shadowRead(this: unknown, ...args: unknown[]) {
    if (!sink.active()) return fn.apply(engine, args);
    use(op, 'offered');
    if (inTransaction) {
      sink.counters.skipped_in_transaction++;
      use(op, 'skipped_in_transaction');
      return fn.apply(engine, args);
    }
    if (sampleRate < 1 && random() >= sampleRate) {
      sink.counters.sampled_out++;
      use(op, 'sampled_out');
      return fn.apply(engine, args);
    }
    if (hasFunctionArg(args)) {
      sink.counters.shed_unmirrorable++;
      use(op, 'unmirrorable');
      return fn.apply(engine, args);
    }
    let encodedArgs: unknown;
    try {
      encodedArgs = encodeArgs(args, { left: CAPTURE_BUDGET_BYTES });
    } catch (error) {
      const tooLarge = error instanceof CaptureTooLargeError;
      try { sink.counters[tooLarge ? 'shed_too_large' : 'encode_error']++; } catch { /* fail open */ }
      use(op, tooLarge ? 'shed' : 'unmirrorable');
      return fn.apply(engine, args);
    }
    const access = callerAccessRecord() ?? undefined; // frozen; none outside a caller's record, and then Rust runs under none (a record changes the page policy text Rust serves)
    let token: { gen?: number; lsn?: string } = {};
    try { token = sink.token?.() ?? {}; } catch { /* no token: the sample is never proven unchanged */ } // taken BEFORE the call: never newer than the snapshot the answer is read from
    const started = now();
    const out = fn.apply(engine, args);
    if (!isThenable(out)) return out;
    return out.then((result: unknown) => {
      const primaryMs = now() - started;
      try {
        sink.offer(() => ({ op, args: encodedArgs, result: encodeValue(result, undefined, { left: CAPTURE_BUDGET_BYTES }), primary_ms: primaryMs, at: Date.now(), access, gen: token.gen, lsn: token.lsn }), op);
      } catch { /* the shadow never fails a call */ }
      return result;
    }, (error: unknown) => {
      try { sink.counters.primary_error++; } catch { /* fail open */ }
      throw error;
    });
  };

  const follow = opts.follow;
  const followCtx = (target: unknown, at: Frame | null, inTx: boolean): FollowContext =>
    ({ follow: follow!, shadowActive: () => sink.active(), engine: target, frame: at, inTransaction: inTx, lane: inTx ? txWrites?.lane : undefined });

  const wrapTransaction = (fn: Function): Function => function shadowTransaction(this: unknown, callback: unknown, ...rest: unknown[]) {
    if (typeof callback !== 'function') return fn.apply(engine, [callback, ...rest]);
    // A nested transaction (a savepoint) keeps its own mark and hands it to the enclosing one only when it succeeds, so a write
    // that a caught inner rollback undid does not make the outer transaction look like it wrote.
    const outer = txWrites;
    const scope = outer ? outer.scope : opts.writes?.scope(engine);
    const writes: TxWrites = { wrote: false, scope, nested: !!outer, path: outer && scope ? [...outer.path, scope.open()] : [], lane: outer ? outer.lane : follow ? newTxLane() : undefined };
    const call = (scope: Frame | null) => fn.apply(engine, [
      (tx: BrainEngine) => beforeCommit(drained(() => (callback as (tx: BrainEngine) => unknown)(tx && typeof tx === 'object' ? buildProxy(tx, sink, opts, true, scope, writes) : tx), writes.scope, writes.lane, !outer), tx, outer ? undefined : writes.scope),
      ...rest,
    ]);
    const out = follow ? followScope(followCtx(engine, frame, inTransaction), false, call) : call(null);
    if (!outer) return committed(afterCommit(out, () => writes.wrote), writes.scope);
    const merge = (value: unknown): unknown => { if (writes.wrote) outer.wrote = true; return value; };
    const dropped = (error: unknown): never => { try { if (scope) scope.drop(writes.path.at(-1)!); } catch { /* the shadow never fails a call */ } throw error; }; // a rolled-back savepoint's writes are not in the final state
    return isThenable(out) ? out.then(merge, dropped) : merge(out);
  };

  /** Calls onCommittedWrite once `out` resolves (a thenable) or now (a plain value), when `wrote()` says so. */
  const afterCommit = (out: unknown, wrote: () => boolean): unknown => {
    const observe = opts.onCommittedWrite;
    if (!observe) return out;
    const notify = (): void => { try { if (wrote()) observe(); } catch { /* the shadow never fails a call */ } };
    if (!isThenable(out)) { notify(); return out; }
    return out.then((value: unknown) => { notify(); return value; });
  };

  /**
   * Runs a transaction callback and holds its outcome, resolved, rejected or thrown at once, until no sampled write holds the sampler's gate (write-capture.ts
   * `holdGate`), no follow pre-read holds the call lane (follow.ts `holdLane`), and every call the callback started and did not await has been sent: a call
   * that takes no callback is waited for until it settles (at most DRAIN_MS; a followed write sends its statement only after its own pre-read, a held call
   * only once its gate opens). So a held write, and a write still on its way, reach the connection before the transaction's COMMIT or ROLLBACK (or its
   * savepoint's), as they would without the shadow, never after it.
   */
  const drained = (callback: () => unknown, scope: TxScope | undefined, lane: TxLane | undefined, outermost: boolean): unknown => {
    if (!scope && !lane) return callback();
    // A callback that throws at once is drained too: its calls may already be held or waiting, and the ROLLBACK must not go first.
    let out: unknown;
    try { out = callback(); } catch (error) { out = Promise.reject(error); }
    // The outermost transaction waits for every unawaited call. A nested one waits only for the lane calls started inside it: the sampler's scope and the
    // lane also hold the enclosing transaction's other calls, which may be waiting for it.
    const mine = outermost || !lane ? undefined : laneCall.getStore();
    const sampled = (): Array<{ done: Promise<void> }> => (scope && outermost ? [...scope.running].filter((c) => !c.callback) : []);
    const laneCalls = (): LaneEntry[] => (lane ? [...lane.running].filter((c) => !c.callback && (outermost || (mine !== undefined && c !== mine && startedWithin(c, mine)))) : []);
    // With no sampler scope, a callback that returned a plain value and left nothing held or running ends at once, as it would without the shadow.
    if (!scope && !isThenable(out) && !lane?.gate && !laneCalls().length) return out;
    const drain = async (): Promise<void> => {
      const until = Date.now() + DRAIN_MS;
      for (;;) {
        if (scope?.gate) { await scope.gate; continue; }
        if (lane?.gate) { await lane.gate; continue; }
        const open = [...sampled(), ...laneCalls()];
        if (!open.length) return;
        if (Date.now() >= until) { if (sampled().length) { try { scope!.unsettled('drain_timeout'); } catch { /* the shadow never fails a call */ } } return; } // the transaction ends as it would without the shadow; its unfinished samples are uncomparable
        await Promise.race([Promise.all(open.map((c) => c.done)), new Promise((r) => { setTimeout(r, Math.max(0, until - Date.now())); })]);
      }
    };
    return Promise.resolve(out).then(async (value: unknown) => { await drain(); return value; }, async (error: unknown) => { await drain(); throw error; });
  };

  /** Gives the sampler its last look inside the outermost transaction, once its callback has finished and before the commit (TxScope.beforeCommit); a callback that rejected is rolled back and gets none. Never fails the write. */
  const beforeCommit = (out: unknown, tx: BrainEngine, scope: TxScope | undefined): unknown => {
    if (!scope || !tx || typeof tx !== 'object' || !isThenable(out)) return out;
    return out.then(async (value: unknown) => { try { await scope.beforeCommit(tx); } catch { /* the shadow never fails a call */ } return value; });
  };

  /** Hands the outermost transaction's sampled writes to the sampler once it has committed; a rejection hands over nothing, so a rolled-back write is never compared. */
  const committed = (out: unknown, scope: TxScope | undefined): unknown => {
    if (!scope) return out;
    const done = (): void => { try { scope.commit(); } catch { /* the shadow never fails a call */ } };
    if (!isThenable(out)) { done(); return out; }
    return out.then((value: unknown) => { done(); return value; });
  };

  /** Tells the sampler's scope each write member the transaction makes (before it runs); an ignored member (locks, logs, caches) changes nothing the comparison reads. */
  const noted = (name: string, fn: Function, scope: TxScope, path: number[]): Function => function notedWrite(this: unknown, ...args: unknown[]) {
    try { if (memberKind(name) !== 'ignored' && mayWrite(name, args)) scope.note(name, args, path); } catch { /* the shadow never fails a call */ }
    return fn.apply(this, args);
  };

  /**
   * Every member call of a transaction passes one hold point. While a sampled write waits for the calls ahead of it and reads its preimage (the sampler's gate,
   * write-capture.ts `holdGate`), or a follow pre-read holds the call lane (follow.ts `holdLane`), the call waits, so the statements keep their order on the connection;
   * held calls queue in call order across both gates and start one by one when the gate holding them opens. A call joins `lane.running` and `scope.running` only once it
   * passes both gates: a call one gate holds is never counted as running by the other, so a sampled write and a pre-read never wait for a call that waits for them
   * (a pipelined version row, edit and chunk delete). A member that returns a plain value (never a statement) is never held: held, it would return a promise.
   */
  const held = (name: PropertyKey, fn: Function, scope: TxScope | undefined, lane: TxLane | undefined): Function => SYNC_MEMBERS.has(name) ? fn : function heldMember(this: unknown, ...args: unknown[]) {
    const order = ++callOrder;
    const callback = hasFunctionArg(args);
    if (scope) scope.inflight++; // counted from the call to the settling of its promise, queued ones included (beforeCommit pins nothing while one is open)
    const start = (): unknown => {
      // A held call starts later from whichever call opens its gate: bound to its own caller's async context, so request-scoped state (a stored slug spelling, a caller record) stays its own.
      const queue = scope?.gate ? scope.waiters : lane?.gate ? lane.waiters : undefined;
      if (queue) return new Promise((resolve, reject) => { enqueue(queue, order, AsyncResource.bind(() => { try { resolve(start()); } catch (error) { reject(error); } })); });
      // In the lane from before the member is entered (a callback member can run its callback at once), until it settles; its own pre-read finds this entry and does not wait for it.
      let settle!: () => void;
      const entry: LaneEntry | undefined = lane ? { callback, done: new Promise<void>((r) => { settle = r; }), parent: laneCall.getStore() } : undefined;
      const leaveLane = (): void => { lane!.running.delete(entry!); settle(); };
      if (entry) lane!.running.add(entry);
      let sent: unknown;
      try { sent = entry ? laneCall.run(entry, () => fn.apply(this, args)) : fn.apply(this, args); } catch (error) { if (entry) leaveLane(); throw error; }
      if (!isThenable(sent)) { if (entry) leaveLane(); return sent; }
      if (entry) sent.then(leaveLane, leaveLane); // registered before the caller's own await, so a call that settled is gone when the caller goes on
      // In the sampler's set only after the member is entered: a sampled write's own wait (taken as it is entered) never counts itself.
      if (scope) { const call = { name: String(name), callback, done: Promise.resolve() }; const leave = (): void => { scope.running.delete(call); }; call.done = sent.then(leave, leave); scope.running.add(call); }
      return sent;
    };
    let out: unknown;
    try { out = start(); } catch (error) { if (scope) scope.inflight--; throw error; }
    if (scope) { if (isThenable(out)) out.then(() => { scope.inflight--; }, () => { scope.inflight--; }); else scope.inflight--; }
    return out;
  };

  /** A member that may write: inside a transaction it marks the transaction, outside it notes after it resolves. */
  const wrapObserved = (name: string, fn: Function): Function => function shadowObserved(this: unknown, ...args: unknown[]) {
    if (!mayWrite(name, args)) return fn.apply(this, args);
    if (txWrites) { txWrites.wrote = true; return fn.apply(this, args); }
    return afterCommit(fn.apply(this, args), () => true);
  };

  /** `withReservedConnection`: the callback's connection gets a raw-SQL wrapper whose writes publish when the callback ends. */
  const wrapReserved = (fn: Function): Function => function shadowReserved(this: unknown, callback: unknown, ...rest: unknown[]) {
    if (typeof callback !== 'function') return fn.apply(engine, [callback, ...rest]);
    return followScope(followCtx(engine, frame, inTransaction), true, (scope) => fn.apply(engine, [
      (conn: any) => (callback as (conn: unknown) => unknown)(
        scope && conn && typeof conn.executeRaw === 'function'
          ? new Proxy(conn, { get: (target, prop) => (prop === 'executeRaw' ? followRaw(followCtx(target, scope, false), target.executeRaw) : Reflect.get(target, prop, target)) })
          : conn),
      ...rest,
    ]));
  };

  /**
   * The warm single-write lane (`withReservedConnection`'s connection, whose `transaction` the persistence consumer lends to its writers): the transaction it
   * opens is handed the sampler's scope exactly like `transaction`, so a page write in it is compared on the same fail-closed rules. Only the sampler: reads, follow and
   * the writer observer stay as they were for it (the inactive sink passes reads through). The caller's options, `pipelineFirst` included, go through untouched and nothing
   * is sent before the first statement, so the preimage reads can only follow it.
   */
  const laneConnection = (conn: any): unknown => {
    if (!opts.writes || !conn || typeof conn.transaction !== 'function') return conn;
    const quiet = { ...opts, follow: undefined, onCommittedWrite: undefined };
    const quietSink: ShadowSink = { ...sink, active: () => false };
    return new Proxy(conn, { get: (target, prop) => (prop !== 'transaction' ? Reflect.get(target, prop, target) : function laneTransaction(callback: unknown, ...rest: unknown[]) {
      if (typeof callback !== 'function') return target.transaction(callback, ...rest);
      const scope = opts.writes!.scope(engine, { followed: false }); // the lane's writes are not published to the follower: they do not move the write counter
      const writes: TxWrites = { wrote: false, scope, nested: false, path: [] };
      return committed(target.transaction((tx: BrainEngine) => beforeCommit(drained(() => (callback as (tx: BrainEngine) => unknown)(tx && typeof tx === 'object' ? buildProxy(tx, quietSink, quiet, true, null, writes) : tx), scope, undefined, true), tx, scope), ...rest), scope);
    }) });
  };

  /** A member outside the mirrored reads: ignored and read-named ones stay bound; raw SQL and writes publish invalidations. */
  const wrapFollowed = (name: string, fn: Function, target: E): Function => {
    const kind = memberKind(name);
    if (kind === 'ignored' || kind === 'read_name') return fn.bind(target);
    if (kind === 'reserved') return wrapReserved(fn);
    const ctx = followCtx(target, frame, inTransaction);
    return kind === 'raw' ? followRaw(ctx, fn) : followWrite(ctx, name, fn);
  };

  const proxy = new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || !isMethod(target, prop)) return value;
      const hit = cache.get(prop);
      if (hit && hit.original === value) return hit.wrapped;
      let wrapped: Function;
      if (isShadowReadMember(prop)) wrapped = wrapRead(prop, value);
      else if (TX_MEMBERS.has(prop)) wrapped = wrapTransaction(value);
      else if (follow && typeof prop === 'string') wrapped = wrapFollowed(prop, value, target);
      else wrapped = value.bind(target);
      const scope = txWrites?.scope;
      if (scope && typeof prop === 'string' && !isShadowReadMember(prop) && !TX_MEMBERS.has(prop)) wrapped = noted(prop, wrapped, scope, txWrites!.path);
      if (opts.writes && typeof prop === 'string' && !isShadowReadMember(prop) && !TX_MEMBERS.has(prop)) wrapped = opts.writes.wrap(prop, wrapped, { engine, inTransaction, mayWrite, scope, nested: txWrites?.nested });
      if (opts.onCommittedWrite && typeof prop === 'string' && !isShadowReadMember(prop) && !TX_MEMBERS.has(prop)) wrapped = wrapObserved(prop, wrapped);
      if (scope || txWrites?.lane) wrapped = held(prop, wrapped, scope, txWrites?.lane);
      if (prop === 'withReservedConnection' && opts.writes && !inTransaction) { const reserved = wrapped; wrapped = function laneReserved(this: unknown, callback: unknown, ...rest: unknown[]) { return reserved.call(this, typeof callback === 'function' ? (conn: unknown) => (callback as (conn: unknown) => unknown)(laneConnection(conn)) : callback, ...rest); }; }
      cache.set(prop, { original: value, wrapped });
      return wrapped;
    },
  });
  return registerEngineView(proxy, engine);
}
