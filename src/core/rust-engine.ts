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
 * transaction refuse (owner-ipc/routes.ts). A client never opens the store. When the owner goes away, the calls it
 * had not answered end with `owner_unavailable` (`outcome_unknown`, never sent again), and the next call runs the
 * election again: this process becomes the owner or a client of the new one, and the call runs there.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine, TransactionOptions } from './engine.ts';
import type { Capability, EngineCapabilities } from './engine-capabilities.ts';
import type { EngineConfig } from './types.ts';
import type { GBrainConfig } from './config.ts';
import { capabilityMissing } from './rust-engine/errors.ts';
import { RUST_ENGINE_MEMBERS } from './rust-engine/members.ts';
import { openRustStore, seedEmbeddingIdentity, type RustStore, type StoreBrain } from './rust-engine/store.ts';
import { opError } from './ops/contract.ts';
import { transactionAborted } from './postgres-engine/transaction-abort.ts';
import { mapStoreError } from './rust-engine/store-errors.ts';
import { STORE_MEMBERS } from './rust-engine/store-members/index.ts';
import { brainWithCallDeadline, endOptimisticTransactions, runOptimisticTransaction, type OptimisticTransactions } from './rust-engine/optimistic-transaction.ts';
import { servedCapabilities, storeCapabilities } from './rust-engine/store-capabilities.ts';
import { rustMultiuserFromEnv, rustMultiuserSubSwitch } from './rust-engine/multiuser-switch.ts';
import { refuseUnfencedLeaseCall } from './rust-engine/fence-dispatch.ts';
import { existingHostIdFor, hostIdFor } from './persistence/identity.ts';
import { noteRustEngine } from './persistence/managed-operations.ts';
import { RECEIPT_STOP_OWNERS } from './rust-engine/receipt-stops.ts';
import { electOwner, type OwnerRole } from './rust-engine/owner-ipc/election.ts';
import { callEndCheck, installOwnerClient, untilCallEnds } from './rust-engine/owner-ipc/client.ts';
import { ownerWholeOperations } from './rust-engine/owner-ipc/owner-ops.ts';
import type { OwnerEngineServer, OwnerServerStats } from './rust-engine/owner-ipc/server.ts';
import { withAccessStore } from './rust-engine/access-self-check.ts';
import { servedServerOptionsFor } from './rust-engine/served/serve-listen.ts';
import type { ServedServerOptions } from './rust-engine/served/session.ts';
import { connectServedEngine, type ServedTarget } from './rust-engine/served/engine.ts';
import type { CommitLogPage, CommitPosition } from './engine-members/commit-log.ts';
import * as commitLog from './rust-engine/store-members/commit-log.ts';

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
  /** Multi-user Rust: the brain server this engine is a client of; it then never opens a store (rust-engine/served/). */
  served?: ServedTarget;
  /** Multi-user Rust, as an owner: protocol v3 options merged over the defaults (tests inject the bearer check). */
  servedOptions?: Partial<ServedServerOptions>;
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
  /** The attribution and source-scope settings applied in it (store-members/transactions.ts); trust ones live in the store. */
  readonly settings: Map<string, string>;
  /** The position its commit got (`lastCommitPosition` on its engine), set once it committed. */
  committedAt?: CommitPosition;
}

/** The transactions whose callback the current async context runs inside, innermost first. */
const transactionContext = new AsyncLocalStorage<RustTransactionScope[]>();
/** How long `disconnect` waits for an open transaction to finish before it rolls it back (milliseconds). */
const TRANSACTION_SHUTDOWN_WAIT_MS = 5_000;
/** Threads of the transaction executor: one, so the calls of the transaction that holds the writer never wait for the pool. */
const TRANSACTION_POOL_THREADS = 1;
/** Members that run on their own admission (the transaction members) rather than the writer gate. */
const SELF_ADMITTED = new Set(['transaction', 'transactionDirect', 'lockPageKeys']);
/**
 * Members that only read: they run on a snapshot and never wait for an open transaction. The member table has no
 * read/write column, so the names decide; a member this does not match counts as a write and waits, which is always
 * safe (the transaction runs on its own executor, so a waiting write can never block it).
 */
const READ_MEMBER = /^(get|list|read|find|count|search|resolve|traverse|has|query|explain|lookup|describe|scan|is)[A-Z]/;
const READ_MEMBERS = new Set([
  'batchLoadEmotionalInputs', 'loadContradictionsTrend', 'sumStaleChunkChars', 'relationalChainHop', 'relationalFanout',
  'keywordBoundedRead',
]);
const WRITE_MEMBERS = new Set(['resolveTake']);
function isReadMember(member: string): boolean {
  return !WRITE_MEMBERS.has(member) && (READ_MEMBERS.has(member) || READ_MEMBER.test(member));
}

/** Builds the Rust engine around an addon the loader has already verified. Nothing is opened or written yet. */
export function openRustEngine(opts: OpenRustEngineOptions): RustEngine {
  return new RustEngine(opts);
}

// The class implements the lifecycle members; the members it does not implement yet are installed on its prototype
// below from RUST_ENGINE_MEMBERS, so the interface half of this merge is honest about the full BrainEngine surface.
export interface RustEngine extends Omit<BrainEngine, 'kind'> {}
export class RustEngine implements BrainEngine {
  readonly kind = 'rust' as const;
  /** The capabilities whose every member the store serves (rust-engine/store-capabilities.ts), plus `multi_writer` while its store runs in multi-user mode. */
  readonly capabilities: EngineCapabilities = servedCapabilities();
  /** The open optimistic transactions (multi-user mode only). */
  readonly _optimistic: OptimisticTransactions = { open: new Map() };

  readonly addon: RustEngineAddonHandle;
  readonly databasePath: string;
  private _savedConfig: EngineConfig | null = null;
  private _connected = false;
  private _store: RustStore | null = null;
  /** The election in progress (the first connect, or a takeover after the owner went away). */
  private _opening: Promise<void> | null = null;
  /**
   * Settles as soon as the store open under the owner lock ends. A served member waits on this, never on `_opening`:
   * giving up the role drains the running members, so a member waiting on the whole election would wait for itself.
   */
  private _storeReady: Promise<void> | null = null;
  /** True from the moment this process holds the owner lock until its socket serves: the store opens in that time. */
  private _claiming = false;
  /** Bumped by every `disconnect`, so an election that started before it knows it was abandoned. */
  private _generation = 0;
  /** Above zero while a `disconnect` runs: no election may start then, so none can outlive the disconnect. */
  private _disconnecting = 0;
  private readonly _beforeDisconnect = new Set<() => Promise<void>>();
  /** True from the first synchronous step of `disconnect()`, which also captures the stop hooks: no work that needs a hook may start after it. */
  get disconnecting(): boolean { return this._disconnecting > 0; }
  private readonly _ownerWaitMs: number | undefined;
  private readonly _served: ServedTarget | undefined;
  private readonly _servedOptions: Partial<ServedServerOptions> | undefined;
  private _owner: OwnerRole | null = null;
  private _leaveOwner: (() => void) | null = null;
  /** Set on a transaction-bound clone (store-members/transactions.ts); null on the engine itself. */
  _txScope: RustTransactionScope | null = null;
  /** Transaction setting names set on this engine's connection so far (store-members/transactions.ts). */
  readonly _seenSettings = new Set<string>();
  /** The open transaction and the promise that settles when it ends: the writer gate. */
  private _writer: { scope: RustTransactionScope; done: Promise<void> } | null = null;
  /** The transaction executor's pool, made on the first transaction and shut down by `disconnect`. */
  private _txPool: { shutdown(waitMs: number): Promise<unknown> } | null = null;

  constructor(opts: OpenRustEngineOptions) {
    this.addon = opts.addon;
    this.databasePath = opts.databasePath;
    this._ownerWaitMs = opts.ownerWaitMs;
    this._served = opts.served;
    this._servedOptions = opts.servedOptions;
  }

  /**
   * Multi-user mode (I-0, rust-engine/multiuser-switch.ts): what the store this process opened decided (the environment
   * switch or the brain's config row). Explicit transactions then run optimistically with no writer gate. False while no
   * store is open here (a client forwards to the owner).
   */
  get multiuser(): boolean { return this._store?.multiuser === true; }

  /** What this engine's own store serves: the served set, plus `multi_writer` in multi-user mode. */
  private _ownCapabilities(): Capability[] {
    // A multi-user store reports the served set less what it withholds (store-capabilities.ts MULTIUSER_WITHHELD).
    return this.multiuser ? [...storeCapabilities({ multiuser: true }), 'multi_writer'] : [...servedCapabilities()];
  }

  /** True between `connect()` and `disconnect()`. */
  get connected(): boolean { return this._connected; }

  /**
   * `owner` when this process owns the brain (also while it holds the lock and opens the store), `client` when it
   * reaches the owner, null before connect or when a takeover failed.
   */
  get ownerRole(): 'owner' | 'client' | null { return this._claiming ? 'owner' : this._owner?.role ?? null; }

  /** The owner's call pool, when this process owns the brain. */
  ownerStats(): OwnerServerStats | null { return this._owner?.role === 'owner' ? this._owner.server.stats() : null; }

  /** The owner socket server, when this process owns the brain (the brain server listener attaches to it). */
  ownerServer(): OwnerEngineServer | null { return this._owner?.role === 'owner' ? this._owner.server : null; }

  /**
   * Becomes the brain's owner (opens the store, serves the owner socket) or a client of the process that owns it. A
   * second `connect` while connected changes nothing, and connects that overlap share one election. A `disconnect`
   * that comes while the election is still running wins: what the election produced is closed, the engine stays
   * disconnected, and that `connect` rejects `engine_closed`.
   */
  async connect(config: EngineConfig): Promise<void> {
    this._savedConfig = config;
    if (this._connected) return;
    if (this._served) { await this._connectServed(this._served); return; }
    await this._electOnce();
  }

  /**
   * A client of a brain server (rust-engine/served/engine.ts): no election, no store, no fallback to one. A disconnect
   * that wins against the connect closes what it made.
   */
  private async _connectServed(target: ServedTarget): Promise<void> {
    const generation = this._generation;
    const leave = await connectServedEngine(this, target);
    if (generation !== this._generation || this._disconnecting) { leave(); throw mapStoreError({ code: 'store_closed' }, { member: 'connect' }); }
    this._leaveOwner = leave;
    this._connected = true;
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
    if (current && this._connected && !this._disconnecting) return this._electOnce();
    // A takeover another call of this engine already started: wait for it, so this call runs on what it elects.
    return this._opening ?? Promise.resolve();
  }

  private async _open(generation: number): Promise<void> {
    const abandoned = () => mapStoreError({ code: 'store_closed' }, { member: 'connect' });
    let opened: RustStore | null = null;
    // Set when the store open under the owner lock failed or was abandoned: the election then ends with that error and
    // this engine no longer reaches the owner it had.
    let storeFailure: { error: unknown } | null = null;
    let role: OwnerRole;
    try {
      // Once the store is open and its multi-user mode resolved, a brain in multi-user mode also speaks protocol v3
      // (rust-engine/served/): the election reads `served` after onLock. Off, it stays undefined.
      let servedOpts: ServedServerOptions | undefined;
      role = await electOwner(this as unknown as BrainEngine, this.databasePath, {
        get served() { return servedOpts; },
        wholeOperations: ownerWholeOperations({ config: (this._savedConfig ?? undefined) as GBrainConfig | undefined }),
        ...(this._ownerWaitMs !== undefined ? { waitMs: this._ownerWaitMs } : {}),
        // Holding the owner lock: open the store before the socket serves, so no client call reaches this engine
        // without it. A call this process makes meanwhile waits for the open (`storeFor`), and ends at once when its
        // caller cancels or its deadline passes.
        onLock: async () => {
          let storeSettled!: () => void;
          const storeReady = new Promise<void>(resolve => { storeSettled = resolve; });
          this._storeReady = storeReady;
          this._claiming = true;
          let store: RustStore;
          try {
            store = await openRustStore(
              this.addon, this.databasePath, await seedEmbeddingIdentity(this),
              this._multiuserOrigin(),
            );
            if (generation !== this._generation) {
              await store.close().catch(() => undefined);
              throw abandoned();
            }
            opened = store;
            this._store = store;
            noteRustEngine(this);
            if (store.multiuser) (this.capabilities as Set<Capability>).add('multi_writer');
            if (store.commitLog) (this.capabilities as Set<Capability>).add('commit_log');
            const served = servedServerOptionsFor(this, store);
            if (served) servedOpts = { ...served, ...this._servedOptions };
          } catch (error) {
            storeFailure = { error };
            throw error;
          } finally {
            storeSettled();
            if (this._storeReady === storeReady) this._storeReady = null;
          }
          return async () => {
            opened = null;
            this._claiming = false;
            if (this._store === store) this._store = null;
            await store.close().catch(() => undefined);
          };
        },
      });
    } catch (error) {
      this._claiming = false;
      const failure = storeFailure as { error: unknown } | null;
      if (failure && this._owner?.role === 'client') {
        // A takeover whose store would not open: the engine ends disconnected, as an open that fails does, and its calls
        // see the store's own error.
        this._owner = null;
        this._connected = false;
        this._leaveClient();
      }
      throw error;
    }
    this._claiming = false;
    if (generation !== this._generation) {
      if (role.role === 'owner') {
        await role.server.close().catch(() => undefined);
        const store = opened as RustStore | null;
        if (store && this._store === store) this._store = null;
        await store?.close().catch(() => undefined);
        await role.lock.release().catch(() => undefined);
      } else role.connection.close();
      throw abandoned();
    }
    // A takeover keeps the members of the owner that went away until this election is decided, then replaces them.
    const prior = this._leaveOwner;
    this._leaveOwner = null;
    if (role.role === 'client') {
      this._owner = role;
      prior?.();
      this._leaveOwner = installOwnerClient(this, role.connection, { rejoin: () => this._takeOver(role.connection) });
      this._connected = true;
      return;
    }
    this._owner = role;
    if (prior) {
      // The members of the owner that went away give way to this engine's own, which run on the store opened above.
      prior();
      for (const capability of this._ownCapabilities()) (this.capabilities as Set<Capability>).add(capability);
      if (this._store?.commitLog) (this.capabilities as Set<Capability>).add('commit_log');
    }
    this._connected = true;
  }

  /** Stops forwarding to an owner; this engine reports what its own store serves again. */
  private _leaveClient(): void {
    const leave = this._leaveOwner;
    this._leaveOwner = null;
    if (!leave) return;
    leave();
    // Leaving the owner empties the capability set; this engine reports what its own store serves again.
    for (const capability of this._ownCapabilities()) (this.capabilities as Set<Capability>).add(capability);
    if (this._store?.commitLog) (this.capabilities as Set<Capability>).add('commit_log');
  }

  /**
   * The host id the multi-user write origin stamps, read only when a sub-switch asks for it. With the switch itself on
   * the identity may be minted (`hostIdFor`); otherwise (a brain that may be on through its config row) only an
   * existing identity is sent, and `mint` names this machine only after the store answered that the brain is on and
   * needs it (`HOST_ID_REQUIRED`), so a brain that is off never mints an identity.
   */
  private _multiuserOrigin(): { hostId?: string; mint: () => string } | undefined {
    const wanted = rustMultiuserSubSwitch('GBRAIN_RUST_WRITE_ORIGIN', { multiuser: true })
      || rustMultiuserSubSwitch('GBRAIN_RUST_COMMIT_LOG', { multiuser: true });
    if (!wanted) return undefined;
    const mint = () => hostIdFor(this);
    if (rustMultiuserFromEnv()) return { hostId: mint(), mint };
    let existing: string | null = null;
    try {
      existing = existingHostIdFor(this);
    } catch (error) {
      // silent-read-ok: an unreadable identity is sent as none; the store refuses the open if it needs one, and the
      // retry mints it through hostIdFor, whose own error then surfaces
      void error;
    }
    return existing ? { hostId: existing, mint } : { mint };
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
    // Multi-user mode (the owner speaks protocol v3): a handoff, first. The owner answers what it has not started as
    // handed over and finishes what it started while everything it runs on is still up: the store, and this process's
    // persistence consumer, which a stop hook below ends (a forwarded write admitted here is applied before it does).
    if (this._owner?.role === 'owner' && this._owner.server.attachServed) await this._owner.server.close();
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
    await endOptimisticTransactions(this._optimistic, TRANSACTION_SHUTDOWN_WAIT_MS);
    const owner = this._owner;
    this._owner = null;
    this._connected = false;
    this._leaveClient();
    const store = this._store;
    this._store = null;
    (this.capabilities as Set<Capability>).delete('multi_writer');
    const txPool = this._txPool;
    this._txPool = null;
    // The owner stops taking calls (and drains them) before its store closes, and gives up the lock last. The lock is
    // released even when a close fails, and the close error is rethrown after it, so a failed close never strands the
    // brain: the next owner opens the store as soon as it holds the lock.
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

  /**
   * The open store a served member runs on, waiting for the open of a store this process is taking over; rejects
   * `engine_closed` otherwise.
   */
  async storeFor(member: string, args: unknown[] = []): Promise<RustStore> {
    if (!this._store && this._storeReady) {
      // A call that waited for the open is checked again before it runs: nothing else ends one that was cancelled or
      // went past its deadline while the store opened, and it may be a write.
      // A call cancelled or past its deadline while the open still runs ends at once; the open goes on.
      const stillWanted = callEndCheck(member, args);
      await untilCallEnds(member, args, this._storeReady);
      stillWanted();
    }
    return this.openStore(member);
  }

  /**
   * The open store a served member runs on, or null when none is open. It goes through `openStore`, so a
   * transaction-bound clone (store-members/transactions.ts) answers with its transaction's handle, never the root
   * store: a member run on the root store inside an open transaction waits for the writer that transaction holds.
   */
  /** The engine this object stands for: a transaction-bound clone answers its root, any other call (through a wrapper too) answers the engine itself. */
  _engineRoot(): RustEngine { return this._txScope?.root ?? this; }

  openStoreIfOpen(member: string): RustStore | null { return this._store ? this.openStore(member) : null; }

  /** The open store a served member runs on; rejects `engine_closed` when the engine is not connected. */
  openStore(member: string): RustStore {
    if (!this._store) throw mapStoreError({ code: 'store_closed' }, { member });
    return this._store;
  }

  /**
   * Admits one served call. On the engine itself (not a transaction-bound clone) a call made from inside one of its own
   * open transactions throws `internal_error` with reason `transaction_reentry` (it would wait for the writer that
   * transaction holds), and a write waits while a transaction is open. Reads never wait.
   */
  async _admit(member: string): Promise<void> {
    if (this._txScope) return;
    // Multi-user mode: a callback that resumes after its transaction ended (a deadline) is refused too, so it
    // cannot write through the outer engine after its caller was told nothing committed.
    if (this.multiuser && transactionContext.getStore()?.some((scope) => scope.root === this && scope.ended)) {
      throw mapStoreError({ code: 'store_closed' }, { member });
    }
    if (transactionContext.getStore()?.some((scope) => scope.root === this && scope.live)) {
      throw opError('internal_error', `${member} was called on the engine from inside its own transaction(fn), and would wait forever for the writer that transaction holds.`,
        'Make every call inside transaction(fn) on the engine passed to fn, not on the outer engine.', { reason: 'transaction_reentry', detail: `member=${member}` });
    }
    if (SELF_ADMITTED.has(member) || isReadMember(member) || this.multiuser) return;
    while (this._writer) await this._writer.done;
  }

  /** Waits until no transaction holds the writer, bounded by `signal`: an abort while waiting rejects `cancelled`. */
  private async _awaitWriter(signal: AbortSignal | undefined): Promise<void> {
    while (this._writer) {
      const open = this._writer.done;
      if (!signal) { await open; continue; }
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<'aborted'>((resolve) => { onAbort = () => resolve('aborted'); signal.addEventListener('abort', onAbort, { once: true }); });
      const outcome = await Promise.race([open.then(() => 'open' as const), aborted]);
      signal.removeEventListener('abort', onAbort!);
      if (outcome === 'aborted' || signal.aborted) {
        throw opError('cancelled', 'The transaction was cancelled while it waited for the open transaction to finish; nothing was written.',
          'Retry the transaction, or give it a signal that allows a longer wait.', { detail: 'member=transaction' });
      }
    }
  }

  /**
   * Opens the engine's write transaction and runs `run` on the bound store handle, inside the re-entry context: commits
   * when `run` resolves, rolls back and rethrows the original error when it throws. Waits for an open transaction
   * first (the writer gate), bounded by `opts.signal`: an abort while waiting rejects `cancelled`, and an already-aborted
   * signal rejects before anything opens, as PGLite does.
   */
  async _openTransaction<T>(opts: TransactionOptions | undefined, run: (scope: RustTransactionScope) => Promise<T>): Promise<T> {
    // The mode is the open store's: a transaction that starts while the store opens waits for it to decide.
    if (!this._store && this._storeReady) await this._storeReady.catch(() => undefined);
    if (this.multiuser) {
      await this._admit('transaction');
      return runOptimisticTransaction(this, this._optimistic, transactionContext, opts, run);
    }
    const signal = opts?.signal;
    if (signal?.aborted) throw transactionAborted(signal);
    await this._admit('transaction');
    // Every await can let another transaction take the writer, so the check that the writer is free and the claim of
    // it run with no await between them. Otherwise two transactions pass the gate together, and the second one's
    // begin blocks the one-thread transaction pool that the first one needs to commit: both wait forever.
    let rootBrain: StoreBrain;
    for (;;) {
      await this._awaitWriter(signal);
      rootBrain = (await this.storeFor('transaction')).brain;
      if (!this._writer) break;
    }
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const { Pool, Brain } = this.addon as { Pool: new (threads: number) => { shutdown(waitMs: number): Promise<unknown> }; Brain: new (pool: unknown) => StoreBrain };
    this._txPool ??= new Pool(TRANSACTION_POOL_THREADS);
    const brain = new Brain(this._txPool);
    const scope: RustTransactionScope = { root: this, brain, live: true, ended: false, settings: new Map() };
    this._writer = { scope, done };
    try {
      try {
        await brain.beginTransaction(rootBrain, opts?.readOnly === true);
      } catch (error) {
        throw mapStoreError(error, { member: 'transaction' });
      }
      let value: T;
      try {
        value = await transactionContext.run([scope, ...(transactionContext.getStore() ?? [])], () => run(scope));
      } catch (error) {
        scope.live = false;
        await brain.rollbackTransaction().catch(() => undefined);
        throw error;
      }
      scope.live = false;
      if (scope.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'transaction' });
      try {
        scope.committedAt = await brain.commitTransaction() as CommitPosition;
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
      if (this._writer?.scope === scope) this._writer = null;
      release();
    }
  }

  /** `disconnect`: waits a bounded time for the open transaction, then rolls it back; its later calls reject `engine_closed`. */
  private async _endOpenTransaction(): Promise<void> {
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
  }

  async reconnect(_ctx?: { error?: unknown }): Promise<void> {
    if (!this._savedConfig) return; // never connected; nothing to restore
    const config = this._savedConfig;
    await this.disconnect();
    await this.connect(config);
  }

  /** engine-members/commit-log.ts; refused naming commit_log unless the store keeps a commit log. */
  readCommitLog(after: CommitPosition | null, limit: number): Promise<CommitLogPage> { return commitLog.readCommitLog(this as never, after, limit); }
  lastCommitPosition(): Promise<CommitPosition | null> { return commitLog.lastCommitPosition(this as never); }

  registerBeforeDisconnect(stop: () => Promise<void>): () => void {
    this._beforeDisconnect.add(stop);
    return () => { this._beforeDisconnect.delete(stop); };
  }
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
      refuseUnfencedLeaseCall(this, member, args); // decision A: a registered process must send its host fence
      await this._admit(member);
      const brain = this.multiuser && !this._txScope ? brainWithCallDeadline(store.brain) : store.brain;
      // Multi-user lane L4: a store in multi-user mode runs the member with its answer in context (access-self-check.ts).
      return withAccessStore(store, this.addon, () =>
        (impl as (this: RustEngine, brain: unknown, ...rest: unknown[]) => Promise<unknown>).call(this, brain, ...args));
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
      return Promise.reject(capabilityMissing(capability, member, 'none', RECEIPT_STOP_OWNERS[member]));
    },
  });
}
