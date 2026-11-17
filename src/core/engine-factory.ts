import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import { registerChatUsageSink, makeEngineChatUsageSink } from './ai/chat-usage.ts';
import { constructEngine } from './engine-construct.ts';
import { shadowStateFor } from '../shadow/state.ts';

/**
 * Create an engine instance based on config.
 * Uses dynamic imports so PGLite WASM is never loaded for Postgres users.
 */
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
  const engine = await constructEngine(config);

  // #4218: route gateway.chat() usage accounting into this engine's
  // chat_usage_log. Every production engine flows through this factory, so
  // registering here covers CLI, MCP serve, and the minion worker without
  // per-caller wiring. #4480: registration is a STACK entry, deregistered on
  // engine.disconnect — a short-lived secondary engine (migrate target,
  // doctor probe) no longer permanently steals the ledger, and records never
  // route to a closed engine. Concurrent multi-engine attribution remains
  // top-of-stack best-effort; the sink is fail-open, so a not-yet-migrated
  // engine never breaks a chat call. An engine opened from settings never
  // comes through here (engine-open.ts): its sink is its own.
  const deregisterUsageSink = registerChatUsageSink(makeEngineChatUsageSink(engine), engine);
  const origDisconnect = engine.disconnect.bind(engine);
  engine.disconnect = async (): Promise<void> => {
    deregisterUsageSink();
    await origDisconnect();
  };

  // Rust engine shadow mode (docs/ENGINES.md "Rust engine shadow mode"): off unless `gbrain engine shadow start`
  // turned it on for this brain. Off costs one existsSync.
  const shadow = shadowStateFor(config);
  if (shadow) {
    const { attachShadow } = await import('../shadow/attach.ts');
    return attachShadow(engine, shadow.dir, shadow.state);
  }

  return engine;
}
