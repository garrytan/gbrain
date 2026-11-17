/**
 * The Rust engine addon without the network (plan PR S1).
 *
 * The real loader (src/core/rust-engine/addon-loader.ts) fetches and verifies the addon on first use. The shadow
 * child and the `rust_engine_addon` doctor check must never reach the network on their own, so they load through
 * here: the development override (GBRAIN_RUST_ENGINE_ADDON) or an addon already installed under the gbrain home goes
 * to the real loader with fetching turned off; anything else is reported as `rust_engine_addon_missing` with the
 * status reason `not_installed` and no loader call. `gbrain engine shadow start --yes` (and eval `--engine rust`)
 * run the real loader in the foreground, so a fetch only ever happens on a command the user typed.
 */
import { existsSync } from 'node:fs';
import { addonPath, readCachedManifest } from '../core/rust-engine/addon-fetch.ts';
import {
  defaultRustAddonLoaderDeps, loadRustEngineAddon, type RustAddonLoaderDeps, type RustEngineAddonLoad,
} from '../core/rust-engine/addon-loader.ts';

/** A loader result, or the offline status `not_installed` (an addon would have to be fetched first). */
export type OfflineAddonLoad = RustEngineAddonLoad;

export type RustEngineAddonLoaderFn = () => Promise<RustEngineAddonLoad>;

/** True when an addon can load with no network: the override is set, or this version's addon is in the gbrain home. */
export function rustAddonInstalled(deps: Pick<RustAddonLoaderDeps, 'env' | 'rustDir' | 'version' | 'target'>): boolean {
  if (deps.env.GBRAIN_RUST_ENGINE_ADDON?.trim()) return true;
  if (!deps.target) return false;
  const cached = readCachedManifest(deps.rustDir, deps.version);
  if (!cached?.targets[deps.target]) return false;
  return existsSync(addonPath(deps.rustDir, cached.engine_build, deps.target));
}

/** Loads the addon only when it needs no fetch. Never reaches the network. */
export async function loadRustEngineAddonOffline(overrides: Partial<RustAddonLoaderDeps> = {}): Promise<OfflineAddonLoad> {
  const deps: RustAddonLoaderDeps = { ...defaultRustAddonLoaderDeps(), ...overrides };
  if (!rustAddonInstalled(deps)) {
    return {
      ok: false, code: 'rust_engine_addon_missing', reason: 'not_installed',
      message: 'The Rust engine addon is not installed in this gbrain home yet; gbrain engine shadow start --yes fetches and verifies it.',
    };
  }
  // A cached addon whose checksum no longer matches would make the loader fetch; with no release reader it refuses.
  return loadRustEngineAddon({ ...deps, fetchRelease: async () => null });
}
