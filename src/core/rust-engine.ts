/**
 * The optional Rust engine shell (docs/designs/RUST_ENGINE.md, plan PR 8).
 *
 * `openRustEngine` is the one seam: `constructEngine` calls it after the addon loader has loaded and verified the
 * native addon, and gets back the engine. It has every BrainEngine member; its `kind` is `'rust'`, which
 * `BrainEngine.kind` admits. Selecting the engine, loading the addon and refusing a missing or mismatched addon live in
 * the loader, not here. The members the store answers exactly are served from it (rust-engine/store-members/). Every
 * other BrainEngine member rejects with a typed `engine_capability_missing` naming the capability it needs
 * (rust-engine/members.ts), before any work. The engine reports a capability only when it serves every member of it
 * (rust-engine/store-capabilities.ts).
 *
 * One process owns a Rust brain at a time (rust-engine/owner-ipc/). `connect` takes the brain's owner lock, opens the
 * brain store (rust-engine/store.ts) and serves this engine on the owner socket, or, when another process holds the
 * lock, makes this engine a client of that owner: its data members then run on the owner, and the members that need a
 * transaction refuse (owner-ipc/routes.ts). A client never opens the store.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine, TransactionOptions } from './engine.ts';
import type { Capability, EngineCapabilities } from './engine-capabilities.ts';
import type { EngineConfig } from './types.ts';
import { capabilityMissing } from './rust-engine/errors.ts';
import { opError } from './ops/contract.ts';
import { transactionAborted } from './postgres-engine/transaction-abort.ts';
import { RUST_ENGINE_MEMBERS } from './rust-engine/members.ts';
import { isReadMember, SELF_ADMITTED_MEMBERS as SELF_ADMITTED } from './rust-engine/member-access.ts';
import { openRustStore, type RustStore, type StoreBrain } from './rust-engine/store.ts';
import { mapStoreError } from './rust-engine/store-errors.ts';
import { STORE_MEMBERS } from './rust-engine/store-members/index.ts';
import { servedCapabilities } from './rust-engine/store-capabilities.ts';
import { electOwner, type OwnerRole } from './rust-engine/owner-ipc/election.ts';
import { callEndCheck, installOwnerClient, untilCallEnds } from './rust-engine/owner-ipc/client.ts';
import { ownerWholeOperations } from './rust-engine/owner-ipc/owner-ops.ts';
import type { OwnerServerStats } from './rust-engine/owner-ipc/server.ts';

/**
 * The empty async context: no request, job, deadline, signal or caller mark. The engine runs its election, and the
 * owner server and store open that follow it, inside it, so the owner never runs with the authority, deadline or
 * signal of the caller whose call happened to start the election, wherever this module was first loaded.
 *
 * A context is only reachable from inside itself, so the empty one is taken where no caller's context reaches: a
 * MessagePort listener, which Bun runs at the root of the async context. A private probe store checks that on every
 * take: when the listener sees the probe (a runtime that carries the context into it), the take refuses rather than
 * hand back the caller's context.
 *
 * Runtime assumption: this relies on Bun (checked on 1.4.4) running MessagePort listeners with no caller context. A
 * runtime or Bun release that carries the context into the listener makes every take refuse, so every connect() of a
 * Rust brain fails closed with this refusal until the runtime changes; nothing runs in a caller's context.
 * test/rust-engine-owner-context.test.ts pins both the assumption and the refusal.
 */
const contextProbe = new AsyncLocalStorage<true>();
let emptyContextTaken: Promise<<R>(fn: () => R) => R> | undefined;

/** The empty async context's runner (see above), taken once. */
export function emptyAsyncContext(): Promise<<R>(fn: () => R) => R> {
  if (emptyContextTaken) return emptyContextTaken;
  const taking = contextProbe.run(true, () => new Promise<<R>(fn: () => R) => R>((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      if (contextProbe.getStore() !== undefined) {
        reject(new Error('The Rust engine could not take an empty async context: this runtime carries the caller\'s context into a MessagePort listener.'));
        return;
      }
      resolve(AsyncLocalStorage.snapshot());
    };
    channel.port2.postMessage(null);
  }));
  // A refusal is not kept: the next take tries again. The memo is cleared after the take settles, never inside the
  // listener, which a runtime may call before this function has stored the take.
  emptyContextTaken = taking;
  taking.catch(() => { if (emptyContextTaken === taking) emptyContextTaken = undefined; });
  return taking;
}

/** The loaded, verified addon exports. Opaque to the shell: the typed methods later PRs add call into it. */
export type RustEngineAddonHandle = object;

export interface OpenRustEngineOptions {
  /** The addon exports, already loaded and checked (target, ABI, build) by the loader. */
  addon: RustEngineAddonHandle;
  /** Absolute path of the brain's store directory (the config's database_path). */
  databasePath: string;
  /** How long `connect` waits to become the owner or reach it (owner-ipc/election.ts); tests shorten it. */
  ownerWaitMs?: number;
}

/**
 * One open transaction (store-members/transactions.ts). `live` is true while its callback runs; `ended` once the
 * disconnect rolled it back, so a later call on its engine rejects `engine_closed`.
 */
export interface RustTransactionScope {
  readonly root: RustEngine;
  readonly brain: StoreBrain;
  live: boolean;
  ended: boolean;
  /**
   * Set when a savepoint inside the transaction failed and could not be rolled back, or could not be released
   * (store-members/transactions.ts):
   * the transaction then rolls back instead of committing, so the failed savepoint's writes are never kept.
   */
  savepointRollbackFailed?: unknown;
  /** The attribution and source-scope settings applied in it (store-members/transactions.ts); trust ones live in the store. */
  readonly settings: Map<string, string>;
}

/** The transactions whose callback the current async context runs inside, innermost first. */
const transactionContext = new AsyncLocalStorage<RustTransactionScope[]>();
/** How long `disconnect` waits for an open transaction to finish before it rolls it back (milliseconds). */
const TRANSACTION_SHUTDOWN_WAIT_MS = 5_000;

function transactionCancelledWhileWaiting(): Error {
  return opError('cancelled', 'The transaction was cancelled while it waited for the open transaction to finish; nothing was written.',
    'Retry the transaction, or give it a signal that allows a longer wait.', { detail: 'member=transaction' });
}
/** Threads of the transaction executor: one, so the calls of the transaction that holds the writer never wait for the pool. */
const TRANSACTION_POOL_THREADS = 1;
/** Builds the Rust engine around an addon the loader has already verified. Nothing is opened or written yet. */
export function openRustEngine(opts: OpenRustEngineOptions): RustEngine {
  return new RustEngine(opts);
}

// The class implements the lifecycle members; the members it does not implement yet are installed on its prototype
// below from RUST_ENGINE_MEMBERS, so the interface half of this merge is honest about the full BrainEngine surface.
export interface RustEngine extends Omit<BrainEngine, 'kind'> {}
export class RustEngine implements BrainEngine {
  readonly kind = 'rust' as const;
  /** The capabilities whose every member the store serves (rust-engine/store-capabilities.ts). */
  readonly capabilities: EngineCapabilities = servedCapabilities();

  readonly addon: RustEngineAddonHandle;
  readonly databasePath: string;
  private _savedConfig: EngineConfig | null = null;
  private _connected = false;
  private _store: RustStore | null = null;
  private _opening: Promise<void> | null = null;
  /**
   * Settles as soon as the owner's store open ends, before the open gives up its role. A served member waits on this,
   * never on `_opening`: giving up the role drains the running members, so a member waiting on the whole open would
   * wait for itself.
   */
  private _storeReady: Promise<void> | null = null;
  /** Bumped by every `disconnect`, so an open that started before it knows it was abandoned. */
  private _generation = 0;
  /** Above zero while a `disconnect` runs: no election may start then, so none can outlive the disconnect. */
  private _disconnecting = 0;
  private readonly _beforeDisconnect = new Set<() => Promise<void>>();
  /** True from the first synchronous step of `disconnect()`, which also captures the stop hooks: no work that needs a hook may start after it. */
  get disconnecting(): boolean { return this._disconnecting > 0; }
  private readonly _ownerWaitMs: number | undefined;
  private _owner: OwnerRole | null = null;
  private _leaveOwner: (() => void) | null = null;
  /** Set on a transaction-bound clone (store-members/transactions.ts); null on the engine itself. */
  _txScope: RustTransactionScope | null = null;
  /** Transaction setting names set on this engine's connection so far (store-members/transactions.ts). */
  readonly _seenSettings = new Set<string>();
  /** The open transaction and the promise that settles when it ends: the writer gate. */
  /** The open transaction, if any. `release` frees the gate; it is idempotent, so a forced shutdown and the transaction's own end can both call it. */
  private _writer: { scope: RustTransactionScope; done: Promise<void>; release: () => void } | null = null;
  /** The transaction executor's pool, made on the first transaction and shut down by `disconnect`. */
  private _txPool: { shutdown(waitMs: number): Promise<unknown> } | null = null;
  /**
   * Set by `disconnect` before it waits for the open transaction, cleared by the next connect: a transaction or write
   * still waiting at the gate then rejects `engine_closed` and writes nothing, instead of taking the writer when the
   * open transaction ends and running on a store that `disconnect` is about to close.
   */
  private _gateClosed = false;
  /**
   * Root writes admitted at the gate and not yet finished. A transaction waits for them to finish before it takes the
   * writer: a write admitted before it, but dispatched after it opened, would otherwise wait in the store for the
   * writer on one of the root store's worker threads, and enough of them would leave no thread for any read.
   */
  private _writesInFlight = 0;
  private _writesDrained: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(opts: OpenRustEngineOptions) {
    this.addon = opts.addon;
    this.databasePath = opts.databasePath;
    this._ownerWaitMs = opts.ownerWaitMs;
  }

  /** True between `connect()` and `disconnect()`. */
  get connected(): boolean { return this._connected; }

  /** `owner` when this process owns the brain, `client` when it reaches the owner, null before connect. */
  get ownerRole(): 'owner' | 'client' | null { return this._owner?.role ?? null; }

  /** The owner's call pool, when this process owns the brain. */
  ownerStats(): OwnerServerStats | null { return this._owner?.role === 'owner' ? this._owner.server.stats() : null; }

  /**
   * Becomes the brain's owner and opens its store at `databasePath`, or becomes a client of the process that owns it.
   * A second `connect` while connected changes nothing, and connects that overlap share one open (the store takes the
   * directory's lock once). A `disconnect` that comes while the open is still running wins: the store the open
   * produces is closed, the owner role is given up, the engine stays disconnected, and that `connect` rejects
   * `engine_closed` instead of resolving into an engine that was told to close.
   */
  async connect(config: EngineConfig): Promise<void> {
    this._savedConfig = config;
    if (this._connected) return;
    await this._electOnce();
  }

  /** The one open in progress, started if there is none: connects that overlap, and takeovers, share it. */
  private _electOnce(): Promise<void> {
    if (!this._opening) {
      const generation = this._generation;
      // The election and the owner server it starts run in the empty async context, not the caller's: a takeover a
      // remote job's call starts must not hand that job's authority, deadline or signal to the owner every later caller
      // reaches.
      const opening: Promise<void> = emptyAsyncContext().then(run => run(() => this._open(generation)))
        .finally(() => { if (this._opening === opening) this._opening = null; });
      this._opening = opening;
    }
    return this._opening;
  }

  /**
   * A client whose owner has gone runs the election again on its next call (client.ts `rejoin`): it becomes the owner
   * and opens the store, or a client of the process that did. A disconnected engine does nothing.
   */
  private _takeOver(from: object): Promise<void> {
    // Only the connection this engine is a client of now may start the election. A member kept from an earlier
    // connection (a bound method) finds the engine already elected, and does nothing: a second election would make the
    // owner a client of its own socket and drop the owner lock it holds.
    const current = this._owner?.role === 'client' && this._owner.connection === from;
    return current && this._connected && !this._disconnecting ? this._electOnce() : Promise.resolve();
  }

  private async _open(generation: number): Promise<void> {
    const abandoned = () => mapStoreError({ code: 'store_closed' }, { member: 'connect' });
    const role = await electOwner(this as unknown as BrainEngine, this.databasePath, {
      wholeOperations: ownerWholeOperations(), ...(this._ownerWaitMs !== undefined ? { waitMs: this._ownerWaitMs } : {}),
    });
    if (generation !== this._generation) { await leaveRole(role); throw abandoned(); }
    // A takeover keeps the members of the owner that went away until this election is decided, then replaces them.
    const prior = this._leaveOwner;
    this._leaveOwner = null;
    if (role.role === 'client') {
      this._owner = role;
      prior?.();
      this._leaveOwner = installOwnerClient(this, role.connection, { rejoin: () => this._takeOver(role.connection) });
      this._gateClosed = false;
      this._connected = true;
      return;
    }
    // The owner socket already answers; a call that reaches it before the store is open waits for it (`storeFor`).
    let storeSettled!: () => void;
    const storeReady = new Promise<void>(resolve => { storeSettled = resolve; });
    this._storeReady = storeReady;
    this._owner = role;
    if (prior) {
      // The members of the owner that went away give way to this engine's own, which wait for the store (`storeFor`).
      prior();
      for (const capability of servedCapabilities()) (this.capabilities as Set<Capability>).add(capability);
    }
    try {
      let store: RustStore;
      try {
        store = await openRustStore(this.addon, this.databasePath);
      } catch (error) {
        if (this._owner === role) this._owner = null;
        this._connected = false;
        storeSettled();
        await leaveRole(role);
        throw error;
      }
      if (generation !== this._generation) {
        storeSettled();
        await store.close().catch(() => undefined);
        if (this._owner === role) this._owner = null;
        await leaveRole(role);
        throw abandoned();
      }
      this._store = store;
      this._gateClosed = false;
      this._connected = true;
    } finally {
      storeSettled();
      if (this._storeReady === storeReady) this._storeReady = null;
    }
  }

  async disconnect(): Promise<void> {
    // Counted before any await: a call that finds the owner gone while this runs must not start an election that
    // publishes a store after `disconnect` has resolved.
    this._disconnecting++;
    try { await this._disconnect(); } finally { this._disconnecting--; }
  }

  private async _disconnect(): Promise<void> {
    // Abandon a pending open first, before any await: an open that finishes while a stop hook is still running must see
    // the new generation, close the store it made, and reject its `connect` (it would otherwise publish the store and
    // resolve `connected`). The store that is already open stays reachable until the hooks have run, since a hook may
    // still need it.
    this._generation++;
    const opening = this._opening;
    this._opening = null;
    const stops = [...this._beforeDisconnect];
    this._beforeDisconnect.clear();
    for (const stop of stops) {
      try { await stop(); } catch { /* a stop barrier never blocks shutdown */ }
    }
    // An open still in flight owns its role until it settles: it sees the new generation, closes the store it made and
    // leaves the role itself. Reading `_owner` before that would release the owner lock while the store is still
    // opening, and another process could then open the same brain.
    await opening?.catch(() => undefined);
    await this._endOpenTransaction();
    const txPool = this._txPool;
    this._txPool = null;
    const owner = this._owner;
    this._owner = null;
    const leave = this._leaveOwner;
    this._leaveOwner = null;
    if (leave) {
      leave();
      // Leaving the owner empties the capability set; this engine reports what its own store serves again.
      for (const capability of servedCapabilities()) (this.capabilities as Set<Capability>).add(capability);
    }
    const store = this._store;
    this._store = null;
    this._connected = false;
    // The owner stops taking calls before its store closes, and gives up the lock last. The lock is released even when
    // a close fails, and the close error is rethrown after it, so a failed close never strands the brain.
    try {
      try {
        if (owner?.role === 'owner') await owner.server.close();
      } finally {
        await txPool?.shutdown(TRANSACTION_SHUTDOWN_WAIT_MS).catch(() => undefined);
        await store?.close();
      }
    } finally {
      if (owner?.role === 'owner') await owner.lock.release();
    }
  }

  /** The open store a served member runs on, waiting for an open in progress; rejects `engine_closed` otherwise. */
  async storeFor(member: string, args: unknown[] = []): Promise<RustStore> {
    if (!this._store && this._storeReady && this._owner?.role === 'owner') {
      // A call that waited for the open is checked again before it runs: nothing else ends one that was cancelled or
      // went past its deadline while the store opened, and it may be a write.
      // A call cancelled or past its deadline while the open still runs ends at once; the open goes on.
      const stillWanted = callEndCheck(member, args);
      await untilCallEnds(member, args, this._storeReady);
      stillWanted();
    }
    return this.openStore(member);
  }

  /** The open store a served member runs on; rejects `engine_closed` when the engine is not connected. */
  openStore(member: string): RustStore {
    if (!this._store) throw mapStoreError({ code: 'store_closed' }, { member });
    return this._store;
  }

  /**
   * The open store a served member runs on, or null when none is open. It goes through `openStore`, so a
   * transaction-bound clone (store-members/transactions.ts) answers with its transaction's handle, never the root
   * store: a member run on the root store inside an open transaction waits for the writer that transaction holds.
   */
  openStoreIfOpen(member: string): RustStore | null { return this._store ? this.openStore(member) : null; }

  /**
   * Admits one served call. On the engine itself (not a transaction-bound clone) a call made from inside one of its own
   * open transactions throws `internal_error` with reason `transaction_reentry` (it would wait for the writer that
   * transaction holds), and a write waits while a transaction is open. Reads never wait.
   */
  async _admit(member: string): Promise<(() => void) | null> {
    if (this._txScope) return null;
    if (transactionContext.getStore()?.some((scope) => scope.root === this && scope.live)) {
      throw opError('internal_error', `${member} was called on the engine from inside its own transaction(fn), and would wait forever for the writer that transaction holds.`,
        'Make every call inside transaction(fn) on the engine passed to fn, not on the outer engine.', { reason: 'transaction_reentry', detail: `member=${member}` });
    }
    if (SELF_ADMITTED.has(member) || isReadMember(member)) return null;
    while (this._writer) {
      await this._writer.done;
      this._throwIfGateClosed(member);
    }
    this._throwIfGateClosed(member);
    // Counted with no await after the check above, so a transaction cannot take the writer between them.
    return this._countWrite();
  }

  /** Counts one admitted root write until the function it returns is called (once; later calls do nothing). */
  private _countWrite(): () => void {
    this._writesInFlight++;
    let counted = true;
    return () => {
      if (!counted) return;
      counted = false;
      if (--this._writesInFlight > 0) return;
      const drained = this._writesDrained;
      this._writesDrained = null;
      drained?.resolve();
    };
  }

  /** Settles when no admitted root write is still running. */
  private _whenWritesDrained(): Promise<void> {
    if (this._writesInFlight === 0) return Promise.resolve();
    if (!this._writesDrained) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      this._writesDrained = { promise, resolve };
    }
    return this._writesDrained.promise;
  }

  /** A call that waited at the gate while `disconnect` ran rejects `engine_closed`; nothing has run. */
  private _throwIfGateClosed(member: string): void {
    if (this._gateClosed) throw mapStoreError({ code: 'store_closed' }, { member });
  }

  /**
   * Waits until no transaction holds the writer and no admitted root write is still running, bounded by `signal`: an
   * abort while waiting rejects `cancelled`.
   */
  private async _awaitWriter(signal: AbortSignal | undefined): Promise<void> {
    while (this._writer || this._writesInFlight > 0) {
      const open = this._writer ? this._writer.done : this._whenWritesDrained();
      if (!signal) { await open; continue; }
      // An abort that came before the listener was added fired no event, so the signal itself is read after adding it.
      if (signal.aborted) throw transactionCancelledWhileWaiting();
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<'aborted'>((resolve) => { onAbort = () => resolve('aborted'); signal.addEventListener('abort', onAbort, { once: true }); });
      if (signal.aborted) onAbort!();
      const outcome = await Promise.race([open.then(() => 'open' as const), aborted]);
      signal.removeEventListener('abort', onAbort!);
      if (outcome === 'aborted' || signal.aborted) throw transactionCancelledWhileWaiting();
    }
  }

  /**
   * Opens the engine's write transaction and runs `run` on the bound store handle, inside the re-entry context: commits
   * when `run` resolves, rolls back and rethrows the original error when it throws. Waits for an open transaction
   * first (the writer gate), bounded by `opts.signal`: an abort while waiting rejects `cancelled`, and an already-aborted
   * signal rejects before anything opens, as PGLite does.
   */
  async _openTransaction<T>(opts: TransactionOptions | undefined, run: (scope: RustTransactionScope) => Promise<T>): Promise<T> {
    const signal = opts?.signal;
    if (signal?.aborted) throw transactionAborted(signal);
    await this._admit('transaction');
    // Every await can let another transaction take the writer, so the check that the writer is free and the claim of
    // it run with no await between them. Otherwise two transactions pass the gate together, and the second one's
    // begin blocks the one-thread transaction pool that the first one needs to commit: both wait forever.
    let rootBrain: StoreBrain;
    for (;;) {
      await this._awaitWriter(signal);
      this._throwIfGateClosed('transaction');
      rootBrain = (await this.storeFor('transaction')).brain;
      this._throwIfGateClosed('transaction');
      if (!this._writer && this._writesInFlight === 0) break;
    }
    // The waits above can end after an abort with no writer left to wait for; nothing has opened yet, so it rejects here.
    if (signal?.aborted) throw transactionCancelledWhileWaiting();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const { Pool, Brain } = this.addon as { Pool: new (threads: number) => { shutdown(waitMs: number): Promise<unknown> }; Brain: new (pool: unknown) => StoreBrain };
    this._txPool ??= new Pool(TRANSACTION_POOL_THREADS);
    const brain = new Brain(this._txPool);
    const scope: RustTransactionScope = { root: this, brain, live: true, ended: false, settings: new Map() };
    const release = (): void => {
      if (this._writer?.scope === scope) this._writer = null;
      resolveDone();
    };
    this._writer = { scope, done, release };
    try {
      try {
        await brain.beginTransaction(rootBrain, opts?.readOnly === true);
      } catch (error) {
        throw mapStoreError(error, { member: 'transaction' });
      }
      let value: T;
      try {
        value = await transactionContext.run([scope, ...(transactionContext.getStore() ?? [])], () => run(scope));
        // A nested transaction that failed and could not be rolled back alone, or whose release was refused, leaves its
        // writes in this one: it rolls back (the catch below) instead of committing them.
        if (scope.savepointRollbackFailed !== undefined) {
          throw opError('internal_error', 'A nested transaction failed and its writes could not be rolled back on their own, so the whole transaction was rolled back; nothing was written.',
            'Let every nested transaction(fn) finish before its parent ends, then retry.', { reason: 'savepoint_rollback_failed', detail: 'member=transaction' });
        }
      } catch (error) {
        scope.live = false;
        await brain.rollbackTransaction().catch(() => undefined);
        throw error;
      }
      scope.live = false;
      if (scope.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'transaction' });
      try {
        await brain.commitTransaction();
      } catch (error) {
        await brain.rollbackTransaction().catch(() => undefined);
        throw mapStoreError(error, { member: 'transaction' });
      }
      return value;
    } finally {
      scope.live = false;
      // The settings end with the transaction, as SET LOCAL does.
      scope.settings.clear();
      await brain.clearWriteTrust().catch(() => undefined);
      await brain.close().catch(() => undefined);
      release();
    }
  }

  /** `disconnect`: waits a bounded time for the open transaction, then rolls it back; its later calls reject `engine_closed`. */
  private async _endOpenTransaction(): Promise<void> {
    // Closed before the wait: a transaction queued behind the open one must not take the writer when the open one ends
    // during the wait, since nothing would then end it before the pool and the store shut down.
    this._gateClosed = true;
    const open = this._writer;
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), TRANSACTION_SHUTDOWN_WAIT_MS); });
    const outcome = await Promise.race([open.done.then(() => 'done' as const), waited]);
    clearTimeout(timer);
    if (outcome === 'done') return;
    open.scope.ended = true;
    await open.scope.brain.rollbackTransaction().catch(() => undefined);
    await open.scope.brain.close().catch(() => undefined);
    // The callback may never return, so the gate is freed here: the writes that wait on it settle, and a reconnected
    // engine starts with no writer. `ended` keeps the old callback from doing any more work in the closed transaction.
    open.release();
  }
  async reconnect(_ctx?: { error?: unknown }): Promise<void> {
    if (!this._savedConfig) return; // never connected; nothing to restore
    const config = this._savedConfig;
    await this.disconnect();
    await this.connect(config);
  }

  registerBeforeDisconnect(stop: () => Promise<void>): () => void {
    this._beforeDisconnect.add(stop);
    return () => { this._beforeDisconnect.delete(stop); };
  }
}

/** Gives up an owner role: the owner stops serving and releases the lock; a client closes its connection. */
async function leaveRole(role: OwnerRole): Promise<void> {
  if (role.role === 'client') { role.connection.close(); return; }
  await role.server.close().catch(() => undefined);
  await role.lock.release().catch(() => undefined);
}

/** The capability a BrainEngine member needs on Rust, or null when the shell implements it. */
export function rustMemberCapability(member: string): Capability | null {
  const cls = (RUST_ENGINE_MEMBERS as Record<string, string>)[member];
  return cls === undefined || cls === 'implemented' || member in STORE_MEMBERS ? null : (cls as Capability);
}

for (const [member, impl] of Object.entries(STORE_MEMBERS)) {
  Object.defineProperty(RustEngine.prototype, member, {
    configurable: true,
    writable: true,
    enumerable: false,
    value: async function served(this: RustEngine, ...args: unknown[]): Promise<unknown> {
      const store = this.openStoreIfOpen(member) ?? await this.storeFor(member, args);
      const finished = await this._admit(member);
      try {
        return await (impl as (this: RustEngine, brain: unknown, ...rest: unknown[]) => Promise<unknown>).call(this, store.brain, ...args);
      } finally {
        finished?.();
      }
    },
  });
}

for (const [member, cls] of Object.entries(RUST_ENGINE_MEMBERS)) {
  if (cls === 'implemented' || member in STORE_MEMBERS) continue;
  const capability = cls as Capability;
  Object.defineProperty(RustEngine.prototype, member, {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function refuse(this: RustEngine): Promise<never> {
      return Promise.reject(capabilityMissing(capability, member));
    },
  });
}
