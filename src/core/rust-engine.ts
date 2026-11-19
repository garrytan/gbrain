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
  /**
   * Settles as soon as the owner's store open ends, before the open gives up its role. A served member waits on this,
   * never on `_opening`: giving up the role drains the running members, so a member waiting on the whole open would
   * wait for itself.
   */
  private _storeReady: Promise<void> | null = null;
  /** Bumped by every `disconnect`, so an open that started before it knows it was abandoned. */
  private _generation = 0;
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
    let storeSettled!: () => void;
    const storeReady = new Promise<void>(resolve => { storeSettled = resolve; });
    this._storeReady = storeReady;
    this._owner = role;
    try {
      let store: RustStore;
      try {
        store = await openRustStore(this.addon, this.databasePath);
      } catch (error) {
        if (this._owner === role) this._owner = null;
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
    await store?.close();
    if (owner?.role === 'owner') await owner.lock.release();
    await opening?.catch(() => undefined);
  }

  /** The open store a served member runs on, waiting for an open in progress; rejects `engine_closed` otherwise. */
  async storeFor(member: string): Promise<RustStore> {
    if (!this._store && this._storeReady && this._owner?.role === 'owner') await this._storeReady;
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
      return (impl as (brain: unknown, ...rest: unknown[]) => Promise<unknown>)((await this.storeFor(member)).brain, ...args);
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
