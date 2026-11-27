import { isAbsolute } from 'node:path';
import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';

/**
 * A new, unconnected engine of `config.engine`, with nothing registered for it. createEngine (engine-factory.ts) adds the
 * process chat-usage sink; openEngine (engine-open.ts) gives its engine a sink of its own instead.
 * Dynamic imports, so PGLite WASM is never loaded for Postgres users.
 */
export async function constructEngine(config: EngineConfig): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';
  switch (engineType) {
    case 'pglite': {
      const { PGLiteEngine } = await import('./pglite-engine.ts');
      return new PGLiteEngine();
    }
    case 'postgres': {
      const { PostgresEngine } = await import('./postgres-engine.ts');
      return new PostgresEngine();
    }
    case 'rust': {
      // Opt-in. The loader loads only a verified cached addon (or the development override); no other engine reaches it.
      const { loadRustEngineAddon } = await import('./rust-engine/addon-loader.ts');
      const { openRustEngine } = await import('./rust-engine.ts');
      const { opError } = await import('./ops/contract.ts');
      const databasePath = config.database_path;
      if (!databasePath || !isAbsolute(databasePath)) {
        throw opError('config_error', 'A rust brain needs an absolute database_path in its config.', 'Set database_path in ~/.gbrain/config.json to the brain\'s store directory.');
      }
      const loaded = await loadRustEngineAddon();
      if (!loaded.ok) {
        // The same code and reason the loader raised, before the shell opens and before the brain is touched.
        const { addonMismatch, addonMissing } = await import('./rust-engine/addon-errors.ts');
        throw loaded.code === 'rust_engine_addon_mismatch'
          ? addonMismatch(loaded.reason as Parameters<typeof addonMismatch>[0], loaded.message)
          : addonMissing(loaded.reason as Parameters<typeof addonMissing>[0], loaded.message);
      }
      let createStore = config.create_store;
      if (createStore === undefined && config.guard_store) {
        // A configured brain opened by a command that did not judge its store (the CLI connect does): a missing store
        // is created only for a brain that never had one.
        const { rustStoreGuard } = await import('../commands/doctor/missing-brain.ts');
        const { configPath } = await import('./config.ts');
        const verdict = rustStoreGuard(databasePath, configPath(), process.argv[2] ?? 'gbrain', true);
        if (typeof verdict !== 'string') throw verdict;
        createStore = verdict === 'create';
      }
      return openRustEngine({ addon: loaded.addon, databasePath, ...(createStore === false ? { createStore: false } : {}) });
    }
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, pglite, rust.` +
        (engineType === 'sqlite' ? ' SQLite is not supported. Use pglite instead.' : '')
      );
  }
}
