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
import type { BrainEngine } from './engine.ts';
import type { Capability, EngineCapabilities } from './engine-capabilities.ts';
import type { EngineConfig } from './types.ts';
import { capabilityMissing } from './rust-engine/errors.ts';
import { RUST_ENGINE_MEMBERS } from './rust-engine/members.ts';
import { openRustStore, type RustStore } from './rust-engine/store.ts';
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
  private readonly _ownerWaitMs: number | undefined;
  private _owner: OwnerRole | null = null;
  private _leaveOwner: (() => void) | null = null;

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
      return (impl as (brain: unknown, ...rest: unknown[]) => Promise<unknown>)((await this.storeFor(member, args)).brain, ...args);
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
