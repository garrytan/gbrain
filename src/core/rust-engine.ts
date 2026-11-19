/**
 * The optional Rust engine shell (docs/designs/RUST_ENGINE.md, plan PR 8).
 *
 * `openRustEngine` is the one seam: the addon loader calls it after it has loaded and verified the native addon, and
 * gets back the engine. It has every BrainEngine member; its `kind` is `'rust'`, which `BrainEngine.kind` admits once
 * the `rust` config value lands with the addon loader. Selecting the engine, loading the addon and refusing a missing or mismatched addon live in
 * the loader, not here. `connect` opens the brain store (rust-engine/store.ts); the members the store answers exactly
 * are served from it (rust-engine/store-members/). Every other BrainEngine member rejects with a typed
 * `engine_capability_missing` naming the capability it needs (rust-engine/members.ts), before any work. The engine
 * reports a capability only when it serves every member of it (rust-engine/store-capabilities.ts).
 *
 * One process owns a Rust brain at a time (rust-engine/owner-ipc/). `connect` takes the brain's owner lock, opens the
 * store and serves this engine on the owner socket, or, when another process holds the lock, makes this engine a
 * client of that owner without opening the store: its data members then run on the owner, and the members that need
 * a transaction refuse (owner-ipc/routes.ts). When the owner goes away, the calls it had not answered end with
 * `owner_unavailable` (`outcome_unknown`, never sent again), and the next call runs the election again: this process
 * becomes the owner or a client of the new one, and the call runs there.
 */
import type { BrainEngine } from './engine.ts';
import type { Capability, EngineCapabilities } from './engine-capabilities.ts';
import type { EngineConfig } from './types.ts';
import type { GBrainConfig } from './config.ts';
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
  /** The election in progress (the first connect, or a takeover after the owner went away). */
  private _opening: Promise<void> | null = null;
  /** Bumped by every `disconnect`, so an election that started before it knows it was abandoned. */
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

  /** `owner` when this process owns the brain, `client` when it reaches the owner, null before connect or mid-takeover. */
  get ownerRole(): 'owner' | 'client' | null { return this._owner?.role ?? null; }

  /** The owner's call pool, when this process owns the brain. */
  ownerStats(): OwnerServerStats | null { return this._owner?.role === 'owner' ? this._owner.server.stats() : null; }

  /**
   * Becomes the brain's owner (opens the store, serves the owner socket) or a client of the process that owns it. A
   * second `connect` while connected changes nothing, and connects that overlap share one election. A `disconnect`
   * that comes while the election is still running wins: what the election produced is closed, the engine stays
   * disconnected, and that `connect` rejects `engine_closed`.
   */
  async connect(config: EngineConfig): Promise<void> {
    this._savedConfig = config;
    if (this._owner) return;
    this._connected = true;
    try { await this._elect(); }
    catch (error) { if (!this._owner) this._connected = false; throw error; }
  }

  /** Runs the election once for every caller that needs it at the same time. */
  private _elect(): Promise<void> {
    if (this._opening) return this._opening;
    const generation = this._generation;
    const opening: Promise<void> = this._runElection(generation)
      .finally(() => { if (this._opening === opening) this._opening = null; });
    this._opening = opening;
    return opening;
  }

  private async _runElection(generation: number): Promise<void> {
    let opened: RustStore | null = null;
    const role = await electOwner(this as unknown as BrainEngine, this.databasePath, {
      wholeOperations: ownerWholeOperations({ config: (this._savedConfig ?? undefined) as GBrainConfig | undefined }),
      ...(this._ownerWaitMs !== undefined ? { waitMs: this._ownerWaitMs } : {}),
      // Holding the owner lock: stop forwarding to any owner that went away, then open the store before the socket
      // serves, so no call reaches this engine without it. A call that comes meanwhile waits for this election.
      onLock: async () => {
        this._leaveClient();
        const store = await openRustStore(this.addon, this.databasePath);
        if (generation !== this._generation) {
          await store.close().catch(() => undefined);
          throw mapStoreError({ code: 'store_closed' }, { member: 'connect' });
        }
        opened = store;
        this._store = store;
        return async () => {
          opened = null;
          if (this._store === store) this._store = null;
          await store.close().catch(() => undefined);
        };
      },
    });
    if (generation !== this._generation) {
      if (role.role === 'owner') {
        await role.server.close();
        const store = opened as RustStore | null;
        if (store && this._store === store) this._store = null;
        await store?.close().catch(() => undefined);
        await role.lock.release();
      } else role.connection.close();
      throw mapStoreError({ code: 'store_closed' }, { member: 'connect' });
    }
    if (role.role === 'client') {
      this._leaveClient();
      this._leaveOwner = installOwnerClient(this, role.connection, { recover: () => this._takeOver(role) });
    }
    this._owner = role;
  }

  /** The owner on `lost` went away: run the election again, once, for every call that saw it. */
  private _takeOver(lost: OwnerRole): Promise<void> {
    if (this._owner === lost) this._owner = null;
    if (!this._connected) return Promise.reject(mapStoreError({ code: 'store_closed' }, { member: 'connect' }));
    return this._owner ? Promise.resolve() : this._elect();
  }

  private _leaveClient(): void {
    const leave = this._leaveOwner;
    this._leaveOwner = null;
    leave?.();
  }

  async disconnect(): Promise<void> {
    // Abandon a pending election first, before any await: an election that finishes while a stop hook is still running
    // must see the new generation, close what it made, and reject its `connect`. The store that is already open stays
    // reachable until the hooks have run, since a hook may still need it.
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
    this._connected = false;
    this._leaveClient();
    // The owner stops serving and drains its calls, then closes the store, and only then frees the owner lock: the
    // next owner opens the store as soon as it holds the lock.
    if (owner?.role === 'owner') await owner.server.close();
    const store = this._store;
    this._store = null;
    await store?.close();
    if (owner?.role === 'owner') await owner.lock.release();
    await opening?.catch(() => undefined);
  }

  /** The open store a served member runs on; rejects `engine_closed` when the engine is not connected. */
  openStore(member: string): RustStore {
    if (!this._store) throw mapStoreError({ code: 'store_closed' }, { member });
    return this._store;
  }

  /** The open store, or null. */
  openStoreIfOpen(): RustStore | null { return this._store; }

  /**
   * The store a served member runs on, after any election in progress (a takeover once the owner went away). Null
   * when that election made this engine a client: the member then runs on the new owner.
   */
  async storeAfterElection(member: string): Promise<RustStore | null> {
    while (!this._store && this._connected) {
      if (this._owner?.role === 'client') return null;
      await this._elect();
    }
    return this.openStore(member);
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
      const store = this.openStoreIfOpen() ?? await this.storeAfterElection(member);
      if (!store) {
        // A client forwards the member with an own property (owner-ipc/client.ts); without one it cannot run here.
        if (!Object.hasOwn(this, member)) throw mapStoreError({ code: 'store_closed' }, { member });
        return ((this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!)(...args);
      }
      return (impl as (brain: unknown, ...rest: unknown[]) => Promise<unknown>)(store.brain, ...args);
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
