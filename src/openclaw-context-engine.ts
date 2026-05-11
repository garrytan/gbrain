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

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createGBrainContextEngine, ENGINE_ID } from './core/context-engine.ts';

export default definePluginEntry({
  id: 'gbrain-context-engine',
  name: 'GBrain Context Engine',
  description: 'Deterministic temporal/spatial context injection on every turn',

  register(api) {
    api.registerContextEngine(ENGINE_ID, (ctx) =>
      createGBrainContextEngine({
        workspaceDir: ctx.workspaceDir,
      }),
    );
  },
});
