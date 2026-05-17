import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';

/**
 * Create an engine instance based on config.
 * Uses dynamic imports so PGLite WASM is never loaded for Postgres users.
 */
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
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
    case 'graphbrain': {
      const { GraphBrainRestEngine } = await import('./graphbrain-engine.ts');
      return new GraphBrainRestEngine();
    }
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, pglite, graphbrain.` +
        (engineType === 'sqlite' ? ' SQLite is not supported. Use pglite instead.' : '')
      );
  }
}
