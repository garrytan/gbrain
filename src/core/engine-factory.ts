import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import { registerChatUsageSink, makeEngineChatUsageSink } from './ai/chat-usage.ts';

/**
 * Create an engine instance based on config.
 * Uses dynamic imports so PGLite WASM is never loaded for Postgres users.
 */
export async function createEngine(config: EngineConfig, options: { pgliteWorker?: boolean } = {}): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';

  const engine = await (async (): Promise<BrainEngine> => { switch (engineType) {
    case 'pglite': {
      if (options.pgliteWorker) {
        const { WorkerPgliteEngine } = await import('../product/database/worker-engine.ts');
        return new WorkerPgliteEngine() as unknown as BrainEngine;
      }
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
  } })();

  const deregister = registerChatUsageSink(makeEngineChatUsageSink(engine));
  const disconnect = engine.disconnect.bind(engine);
  engine.disconnect = async () => {
    deregister();
    await disconnect();
  };
  return engine;
}
