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

/** The loaded, verified addon exports. Opaque to the shell: the typed methods later PRs add call into it. */
export type RustEngineAddonHandle = object;

export interface OpenRustEngineOptions {
  /** The addon exports, already loaded and checked (target, ABI, build) by the loader. */
  addon: RustEngineAddonHandle;
  /** Absolute path of the brain's store directory (the config's database_path). */
  databasePath: string;
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

  constructor(opts: OpenRustEngineOptions) {
    this.addon = opts.addon;
    this.databasePath = opts.databasePath;
  }

  /** True between `connect()` and `disconnect()`. */
  get connected(): boolean { return this._connected; }

  /**
   * Opens the brain store at `databasePath`. A second `connect` while connected changes nothing, and connects that
   * overlap share one open (the store takes the directory's lock once). A `disconnect` that comes while the open is
   * still running wins: the store the open produces is closed, the engine stays disconnected, and that `connect`
   * rejects `engine_closed` instead of resolving into an engine that was told to close.
   */
  async connect(config: EngineConfig): Promise<void> {
    this._savedConfig = config;
    if (this._store) return;
    if (!this._opening) {
      const generation = this._generation;
      const opening: Promise<void> = openRustStore(this.addon, this.databasePath)
        .then(async (store) => {
          if (generation !== this._generation) {
            await store.close().catch(() => undefined);
            throw mapStoreError({ code: 'store_closed' }, { member: 'connect' });
          }
          this._store = store;
          this._connected = true;
        })
        .finally(() => { if (this._opening === opening) this._opening = null; });
      this._opening = opening;
    }
    await this._opening;
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
    const store = this._store;
    this._store = null;
    this._connected = false;
    await store?.close();
    await opening?.catch(() => undefined);
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
      return (impl as (brain: unknown, ...rest: unknown[]) => Promise<unknown>)(this.openStore(member).brain, ...args);
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
