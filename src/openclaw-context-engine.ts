/**
 * OpenClaw plugin entry point for cortex-context engine.
 *
 * Registers a deterministic context engine that injects live temporal/spatial
 * context on every turn. Prevents the "time warp" bug class where compacted
 * sessions lose track of the user's current time, location, and state.
 *
 * Enable in openclaw.json:
 *   plugins.slots.contextEngine: "cortex-context"
 *
 * @module
 */

/**
 * OpenClaw plugin entry - registers cortex-context engine.
 *
 * This file is discovered via the `openclaw.extensions` field in package.json.
 * It requires the OpenClaw plugin SDK at runtime (available when loaded by the
 * gateway). The core engine logic in `./core/context-engine.ts` is SDK-free
 * and independently testable.
 */

import { createCortexContextEngine, ENGINE_ID } from './core/context-engine.ts';

/**
 * Plugin-entry shape consumed by the OpenClaw host. The host's plugin loader
 * reads `id`, `name`, `description`, and `register` directly off the default
 * export — pre-v0.32.5 we wrapped this in `definePluginEntry` from the
 * OpenClaw plugin SDK, but that created an unnecessary build-time import of
 * a runtime-only package. The wrapper was a type-tag (no behavior), so the
 * bare object is equivalent at the host's consumption point. Codex outside-
 * voice F1 flagged the SDK import as the gate keeping the e2e test brittle;
 * removing it unblocks `mock.module()`-based plugin-shape testing AND removes
 * a class of module-load failures in non-Node-resolving runtimes.
 */
interface PluginEntry {
  id: string;
  name: string;
  description: string;
  register(api: PluginApi): void;
}

interface PluginApi {
  registerContextEngine(id: string, factory: (ctx: PluginCtx) => unknown): void;
}

interface PluginCtx {
  workspaceDir: string;
  [key: string]: unknown;
}

const entry: PluginEntry = {
  id: 'cortex-context-engine',
  name: 'Cortex Context Engine',
  description: 'Deterministic temporal/spatial context injection on every turn',

  register(api: PluginApi) {
    api.registerContextEngine(ENGINE_ID, (ctx: PluginCtx) =>
      createCortexContextEngine({
        workspaceDir: ctx.workspaceDir,
      }),
    );
  },
};

export default entry;
