/**
 * OpenClaw plugin entry point for gbrain-context engine.
 *
 * Registers a deterministic context engine that injects live temporal/spatial
 * context on every turn. Prevents the "time warp" bug class where compacted
 * sessions lose track of the user's current time, location, and state.
 *
 * Enable in openclaw.json:
 *   plugins.slots.contextEngine: "gbrain-context"
 *
 * @module
 */

/**
 * OpenClaw plugin entry — registers gbrain-context engine.
 *
 * This file is discovered via the `openclaw.extensions` field in package.json.
 * It requires the OpenClaw plugin SDK at runtime (available when loaded by the
 * gateway). The core engine logic in `./core/context-engine.ts` is SDK-free
 * and independently testable.
 */

// @ts-ignore — openclaw/plugin-sdk is resolved at runtime by the OpenClaw host; not a build-time dep.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createGBrainContextEngine, ENGINE_ID } from './core/context-engine.ts';

interface PluginApi {
  registerContextEngine(id: string, factory: (ctx: PluginCtx) => unknown): void;
}

interface PluginCtx {
  workspaceDir: string;
  [key: string]: unknown;
}

export default definePluginEntry({
  id: 'gbrain-context-engine',
  name: 'GBrain Context Engine',
  description: 'Deterministic temporal/spatial context injection on every turn',

  register(api: PluginApi) {
    api.registerContextEngine(ENGINE_ID, (ctx: PluginCtx) =>
      createGBrainContextEngine({
        workspaceDir: ctx.workspaceDir,
      }),
    );
  },
});
