/**
 * OpenClaw plugin entry point for gbrain-context engine.
 *
 * Registers a deterministic context engine that injects live temporal/spatial
 * context on every turn. Prevents the "time warp" bug class where compacted
 * sessions lose track of the user's current time, location, and state.
 *
 * Enable in openclaw.json:
 *   plugins.slots.contextEngine: "gbrain-context-engine"
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

import { isAbsolute } from 'node:path';
import { createGBrainContextEngine, ENGINE_ID, ENGINE_NAME, ENGINE_API_VERSION, type ContextEngine } from './core/context-engine.ts';
import type { ResolveEntitiesFn } from './core/context/reflex.ts';

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
  kind: 'context-engine';
  register(api: PluginApi): void;
}

interface PluginApi {
  registerContextEngine(id: string, factory: (ctx?: PluginCtx) => PluginContextEngine): void;
  pluginConfig?: { workspaceDir?: string };
  config?: { agents?: { defaults?: { workspace?: string }; list?: unknown[]; entries?: Record<string, unknown> } };
  logger?: { warn(message: string): void };
}

type PluginContextEngine = ContextEngine & {
  info: ContextEngine['info'] & {
    transcriptSemantics: {
      currentTurnFence: 'before-current-turn-entry-v1';
      turnAdvancementIdempotency: 'atomic-idempotent-v1';
    };
  };
  commitTurn(params: { advancementKey: string; messages: unknown[] }): Promise<{ status: 'committed' }>;
};

interface PluginCtx {
  workspaceDir?: string;
  /**
   * Retrieval Reflex (#1981, D1=A): OPTIONAL host-provided resolve capability.
   * When the OpenClaw host supplies it (backed by the gbrain connection the
   * gateway already holds), the deterministic pointer layer resolves through it
   * — works on every engine, including PGLite where a second connection is
   * impossible. Narrow by contract: candidates in, a pointer block out (no raw
   * SQL crosses the boundary). Absent → the engine falls to the serve-IPC /
   * Postgres-direct ladder. Additive + guarded, so older hosts (which don't
   * provide it) keep working unchanged — no pluginApi floor bump needed.
   */
  resolveEntities?: ResolveEntitiesFn;
  /** Back-compat alias some hosts may use for the same capability. */
  brainQuery?: ResolveEntitiesFn;
  [key: string]: unknown;
}

export function register(api: PluginApi) {
  const factory = (ctx: PluginCtx = {}): ContextEngine => {
    const configuredWorkspace = api.pluginConfig?.workspaceDir
      ?? ((api.config?.agents?.list?.length ?? 0) === 0 && Object.keys(api.config?.agents?.entries ?? {}).length === 0
        ? api.config?.agents?.defaults?.workspace
        : undefined);
    const workspaceDir = ctx.workspaceDir ?? configuredWorkspace;
    if (typeof workspaceDir !== 'string' || !workspaceDir.trim() || !isAbsolute(workspaceDir)) {
      const reason = 'GBrain context unavailable: the host must supply an absolute workspaceDir (or configure plugins.entries.gbrain-context-engine.config.workspaceDir). No brain source was selected.';
      api.logger?.warn(reason);
      return {
        info: { id: ENGINE_ID, name: ENGINE_NAME, version: ENGINE_API_VERSION, ownsCompaction: false },
        async ingest() { return { ingested: false }; },
        async assemble({ messages }) {
          const safeMessages = Array.isArray(messages) ? messages : [];
          return {
            messages: safeMessages,
            estimatedTokens: safeMessages.reduce((sum, message) => {
              const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
              return sum + (typeof text === 'string' ? Math.ceil(text.length / 4) : 0);
            }, 0),
            systemPromptAddition: reason,
          };
        },
        async compact() { return { ok: false, compacted: false, reason: 'workspace-unavailable' }; },
      };
    }
    const hostResolver =
      typeof ctx.resolveEntities === 'function'
        ? ctx.resolveEntities
        : typeof ctx.brainQuery === 'function'
          ? ctx.brainQuery
          : undefined;
    return createGBrainContextEngine({
      workspaceDir,
      resolveEntities: hostResolver,
    });
  };
  for (const id of [ENGINE_ID, 'gbrain-context-engine']) {
    api.registerContextEngine(id, (ctx) => {
      const engine = factory(ctx);
      return {
        ...engine,
        info: {
          ...engine.info,
          id,
          transcriptSemantics: {
            currentTurnFence: 'before-current-turn-entry-v1',
            turnAdvancementIdempotency: 'atomic-idempotent-v1',
          },
        },
        async commitTurn() { return { status: 'committed' }; },
      };
    });
  }
}

const entry: PluginEntry = {
  id: 'gbrain-context-engine',
  name: 'GBrain Context Engine',
  description: 'Deterministic temporal/spatial context injection on every turn',
  kind: 'context-engine',
  register,
};

export default entry;
