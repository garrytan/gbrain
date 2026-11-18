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
import { RUST_ENGINE_MEMBERS } from './rust-engine/members.ts';
import { openRustStore, type RustStore, type StoreBrain } from './rust-engine/store.ts';
import { opError } from './ops/contract.ts';
import { transactionAborted } from './postgres-engine/transaction-abort.ts';
import { mapStoreError } from './rust-engine/store-errors.ts';
import { STORE_MEMBERS } from './rust-engine/store-members/index.ts';
import { servedCapabilities } from './rust-engine/store-capabilities.ts';
import { electOwner, type OwnerRole } from './rust-engine/owner-ipc/election.ts';
import { installOwnerClient } from './rust-engine/owner-ipc/client.ts';
import { ownerWholeOperations } from './rust-engine/owner-ipc/owner-ops.ts';
import type { OwnerServerStats } from './rust-engine/owner-ipc/server.ts';

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
export class RustEngine {
  readonly kind = 'rust' as const;
  /** The capabilities whose every member the store serves (rust-engine/store-capabilities.ts). */
  readonly capabilities: EngineCapabilities = servedCapabilities();

  readonly addon: RustEngineAddonHandle;
  readonly databasePath: string;
  private _savedConfig: EngineConfig | null = null;
  private _connected = false;
  private _store: RustStore | null = null;
  private _opening: Promise<void> | null = null;
  /** Bumped by every `disconnect`, so an open that started before it knows it was abandoned. */
  private _generation = 0;
  private readonly _beforeDisconnect = new Set<() => Promise<void>>();
  private readonly _ownerWaitMs: number | undefined;
  private _owner: OwnerRole | null = null;
  private _leaveOwner: (() => void) | null = null;
  /** Set on a transaction-bound clone (store-members/transactions.ts); null on the engine itself. */
  _txScope: RustTransactionScope | null = null;
  /** The open transaction and the promise that settles when it ends: the writer gate. */
  private _writer: { scope: RustTransactionScope; done: Promise<void> } | null = null;
  /** The transaction executor's pool, made on the first transaction and shut down by `disconnect`. */
  private _txPool: { shutdown(waitMs: number): Promise<unknown> } | null = null;

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
    if (!this._opening) {
      const generation = this._generation;
      const opening: Promise<void> = this._open(generation)
        .finally(() => { if (this._opening === opening) this._opening = null; });
      this._opening = opening;
    }
    await this._opening;
  }

  private async _open(generation: number): Promise<void> {
    const abandoned = () => mapStoreError({ code: 'store_closed' }, { member: 'connect' });
    const role = await electOwner(this as unknown as BrainEngine, this.databasePath, {
      wholeOperations: ownerWholeOperations(), ...(this._ownerWaitMs !== undefined ? { waitMs: this._ownerWaitMs } : {}),
    });
    if (generation !== this._generation) { await leaveRole(role); throw abandoned(); }
    if (role.role === 'client') {
      this._owner = role;
      this._leaveOwner = installOwnerClient(this, role.connection);
      this._connected = true;
      return;
    }
    // The owner socket already answers; a call that reaches it before the store is open waits for it (`storeFor`).
    this._owner = role;
    let store: RustStore;
    try {
      store = await openRustStore(this.addon, this.databasePath);
    } catch (error) {
      if (this._owner === role) this._owner = null;
      await leaveRole(role);
      throw error;
    }
    if (generation !== this._generation) {
      await store.close().catch(() => undefined);
      if (this._owner === role) this._owner = null;
      await leaveRole(role);
      throw abandoned();
    }
    this._store = store;
    this._connected = true;
  }

  async disconnect(): Promise<void> {
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
    await this._endOpenTransaction();
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
    // The owner stops taking calls before its store closes, and gives up the lock last.
    if (owner?.role === 'owner') await owner.server.close();
    const txPool = this._txPool;
    this._txPool = null;
    await txPool?.shutdown(TRANSACTION_SHUTDOWN_WAIT_MS).catch(() => undefined);
    await store?.close();
    if (owner?.role === 'owner') await owner.lock.release();
    await opening?.catch(() => undefined);
  }

  /** The open store a served member runs on, waiting for an open in progress; rejects `engine_closed` otherwise. */
  async storeFor(member: string): Promise<RustStore> {
    if (!this._store && this._opening && this._owner?.role === 'owner') await this._opening.catch(() => undefined);
    return this.openStore(member);
  }

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
    if (transactionContext.getStore()?.some((scope) => scope.root === this && scope.live)) {
      throw opError('internal_error', `${member} was called on the engine from inside its own transaction(fn), and would wait forever for the writer that transaction holds.`,
        'Make every call inside transaction(fn) on the engine passed to fn, not on the outer engine.', { reason: 'transaction_reentry', detail: `member=${member}` });
    }
    if (SELF_ADMITTED.has(member) || isReadMember(member)) return;
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
    const scope: RustTransactionScope = { root: this, brain, live: true, ended: false };
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
        await brain.commitTransaction();
      } catch (error) {
        await brain.rollbackTransaction().catch(() => undefined);
        throw mapStoreError(error, { member: 'transaction' });
      }
      return value;
    } finally {
      scope.live = false;
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
      await this._admit(member);
      return (impl as (this: RustEngine, brain: unknown, ...rest: unknown[]) => Promise<unknown>).call(this, (await this.storeFor(member)).brain, ...args);
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
