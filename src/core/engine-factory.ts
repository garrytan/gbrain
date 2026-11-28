import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import { registerChatUsageSink, makeEngineChatUsageSink } from './ai/chat-usage.ts';
import { constructEngine } from './engine-construct.ts';
import { registerShadowSibling, shadowHomeUsed, shadowSiblingOf, shadowStateFor } from '../shadow/state.ts';

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
  const usageSink = makeEngineChatUsageSink(engine);
  const deregisterUsageSink = registerChatUsageSink(usageSink, engine);
  const origDisconnect = engine.disconnect.bind(engine);
  engine.disconnect = async (): Promise<void> => {
    deregisterUsageSink();
    await usageSink.drain();
    await origDisconnect();
  };

  // Rust engine shadow mode (docs/ENGINES.md "Rust engine shadow mode"): off unless `gbrain engine shadow start`
  // turned it on for this brain. Off costs one existsSync.
  const shadow = shadowStateFor(config);
  let out: BrainEngine = engine;
  if (shadow) {
    const { attachShadow } = await import('../shadow/attach.ts');
    out = attachShadow(engine, shadow.dir, shadow.state);
  }
  // Shadow replay capture (docs/guides/shadow-replay.md): off unless `gbrain engine shadow capture on --yes`.
  // A home that never used shadow mode has no shadow root and loads no capture module (one existsSync, as above).
  const cs = shadowHomeUsed() ? await import('../shadow/capture-state.ts') : null;
  const capture = cs?.captureStateFor(config);
  if (capture) {
    const { attachCapture } = await import('../shadow/capture.ts');
    const sibling = shadowSiblingOf(out);
    out = attachCapture(out, capture.cap);
    if (sibling) registerShadowSibling(out, sibling); // a bulk import's workers are shadowed through the capture view too (not captured: capture records the primary's calls)
  }
  const purgeWatch = cs?.capturePurgeWatchFor(config);
  if (purgeWatch) (await import('../shadow/capture.ts')).watchPurges(purgeWatch);
  return out;
}
