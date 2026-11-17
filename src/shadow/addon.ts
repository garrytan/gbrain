/**
 * The Rust engine addon for the shadow child and the `rust_engine_addon` doctor check (plan PR S1).
 *
 * Neither may reach the network on its own. The real loader (src/core/rust-engine/addon-loader.ts) only loads the
 * development override (GBRAIN_RUST_ENGINE_ADDON) or an addon already installed under the gbrain home and checked
 * against the cached manifest; it downloads nothing. So this module is the loader itself, named for what its callers
 * rely on: with nothing installed it reports `rust_engine_addon_missing` with the reason `not_installed`.
 */
import { loadRustEngineAddon, type RustAddonLoaderDeps, type RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';

/** A loader result: the addon, or the refusal (`not_installed` when nothing is in the gbrain home). */
export type OfflineAddonLoad = RustEngineAddonLoad;

export type RustEngineAddonLoaderFn = () => Promise<RustEngineAddonLoad>;

/** Loads the installed addon. Never reaches the network. */
export async function loadRustEngineAddonOffline(overrides: Partial<RustAddonLoaderDeps> = {}): Promise<OfflineAddonLoad> {
  return loadRustEngineAddon(overrides);
}
