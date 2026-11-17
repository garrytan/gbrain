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
      // Opt-in. The loader fetches and checks the addon on first use; nobody on another engine reaches it.
      const { loadRustAddon } = await import('./rust-engine/addon-loader.ts');
      const { openRustEngine } = await import('./rust-engine.ts');
      const { opError } = await import('./ops/contract.ts');
      const databasePath = config.database_path;
      if (!databasePath || !isAbsolute(databasePath)) {
        throw opError('config_error', 'A rust brain needs an absolute database_path in its config.', 'Set database_path in ~/.gbrain/config.json to the brain\'s store directory.');
      }
      const addon = await loadRustAddon();
      return openRustEngine({ addon, databasePath });
    }
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, pglite, rust.` +
        (engineType === 'sqlite' ? ' SQLite is not supported. Use pglite instead.' : '')
      );
  }
}
