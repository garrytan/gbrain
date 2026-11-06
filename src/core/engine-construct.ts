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
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, pglite.` +
        (engineType === 'sqlite' ? ' SQLite is not supported. Use pglite instead.' : '')
      );
  }
}
