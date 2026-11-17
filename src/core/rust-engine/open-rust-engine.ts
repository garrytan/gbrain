/**
 * Seam for the Rust engine itself. constructEngine (engine-construct.ts) calls this once the addon has
 * been found, checked and loaded (addon-loader.ts).
 *
 * TODO(plan PR 8, docs/designs/RUST_ENGINE.md): replace the body with the engine shell, which opens the brain through
 * the addon. Until then selecting `engine: rust` stops here, after the addon is verified and before any write to the brain.
 */
import type { BrainEngine } from '../engine.ts';
import type { EngineConfig } from '../types.ts';
import type { RustAddon } from './addon-loader.ts';

export async function openRustEngine(_config: EngineConfig, _addon: RustAddon): Promise<BrainEngine> {
  throw new Error('the Rust engine is not built yet in this release; switch `engine` back to pglite or postgres');
}
