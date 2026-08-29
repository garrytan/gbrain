import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import { registerChatUsageSink, makeEngineChatUsageSink } from './ai/chat-usage.ts';

/**
 * Create an engine instance based on config.
 * Uses dynamic imports so PGLite WASM is never loaded for Postgres users.
 */
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';

  const engine = await (async (): Promise<BrainEngine> => {
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
  })();

  // #4218: route gateway.chat() usage accounting into this engine's
  // chat_usage_log. Every production engine flows through this factory, so
  // registering here covers CLI, MCP serve, and the minion worker without
  // per-caller wiring. #4480: registration is a STACK entry, deregistered on
  // engine.disconnect — a short-lived secondary engine (migrate target,
  // doctor probe) no longer permanently steals the ledger, and records never
  // route to a closed engine. Concurrent multi-engine attribution remains
  // top-of-stack best-effort; the sink is fail-open, so a not-yet-migrated
  // engine never breaks a chat call.
  const deregisterUsageSink = registerChatUsageSink(makeEngineChatUsageSink(engine));
  const origDisconnect = engine.disconnect.bind(engine);
  engine.disconnect = async (): Promise<void> => {
    deregisterUsageSink();
    await origDisconnect();
  };

  return engine;
}
