/**
 * v0.41.x (#1698) — single shared Anthropic key-presence probe.
 *
 * Consolidates three byte-identical private copies that had drifted apart over
 * time (`think/index.ts`, `cycle/synthesize.ts`, `conversation-parser/llm-base.ts`).
 * Same drift class as the four colon-only model-id normalizers — one source of truth.
 *
 * Resolution precedence (#2119 read-side added the middle layer):
 *   1. env `ANTHROPIC_API_KEY` — the operator escape hatch;
 *   2. the gateway env snapshot — pushed by `configureGateway()` (push seam:
 *      gateway.ts imports this module, never the reverse, so no import cycle).
 *      This is how a DB-plane `anthropic_api_key` — merged by
 *      `loadConfigWithEngine()` into the gateway env — becomes visible to
 *      `probeChatModel` and the direct-`Anthropic`-client subagent path,
 *      which are deliberately gateway-config-independent otherwise;
 *   3. the gbrain config file (`anthropic_api_key` set via `gbrain config
 *      set`) so stdio MCP launches that don't inherit shell env keep working.
 *      `loadConfig` can throw on first-run installs; that is swallowed and
 *      treated as "no key available."
 *
 * Lives in `src/core/ai/` (not gateway.ts) to keep the gateway module's surface
 * lean and to avoid any import-cycle risk — the three consumers already import
 * from gateway.ts.
 */

import { loadConfig } from '../config.ts';

/**
 * The Anthropic key the AI gateway was configured with, when it did NOT come
 * verbatim from `process.env` (env-verbatim values are filtered out at the
 * stash site: the env layer above already serves them, and stashing them
 * would let a captured process.env leak past hermetic tests that scrub
 * `ANTHROPIC_API_KEY`). Cleared by the gateway reset paths via the stash.
 */
let _gatewayEnvKeySnapshot: string | undefined;

/**
 * Push seam for `configureGateway()`: stash the gateway env's Anthropic key
 * (post-filter, see above) so a DB-plane `anthropic_api_key` merged by
 * `loadConfigWithEngine()` into the gateway env becomes visible to
 * `resolveAnthropicKey`. Pass `undefined` to clear (the gateway reset paths
 * do). Production code outside src/core/ai/gateway.ts must not call this —
 * the gateway owns the snapshot's lifecycle.
 */
export function stashGatewayAnthropicKeyFromEnv(
  env: Record<string, string | undefined> | undefined,
): void {
  const key = env?.ANTHROPIC_API_KEY;
  _gatewayEnvKeySnapshot = key !== process.env.ANTHROPIC_API_KEY ? key : undefined;
}

/**
 * Direct snapshot setter — test seam for pinning the resolution-layer order
 * without a full `configureGateway()`. Same clear semantics as the stash.
 */
export function setGatewayAnthropicKeySnapshot(key: string | undefined): void {
  _gatewayEnvKeySnapshot = key;
}

/**
 * Read-only view of the gateway env snapshot for presence probes (#3944
 * follow-up: chatApiKeyConfigured). A non-undefined value means a DB-plane
 * key was merged into the RUNNING gateway env — i.e. chat is actually
 * servable — without exposing a raw engine.getConfig read to the planner.
 */
export function getGatewayAnthropicKeySnapshot(): string | undefined {
  return _gatewayEnvKeySnapshot;
}

export function hasAnthropicKey(): boolean {
  return resolveAnthropicKey() !== undefined;
}

/**
 * Resolve the actual key value: env first, then the gateway env snapshot,
 * then the gbrain config file. Callers constructing an Anthropic client
 * directly (e.g. the legacy subagent path) must pass this as `apiKey` — a
 * bare `new Anthropic()` only sees env, so launchd/MCP workers with
 * config-stored keys fail.
 */
export function resolveAnthropicKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (_gatewayEnvKeySnapshot) return _gatewayEnvKeySnapshot;
  try {
    const cfg = loadConfig();
    if (cfg?.anthropic_api_key) return cfg.anthropic_api_key;
  } catch {
    // loadConfig may throw on first-run installs; treat as no key available.
  }
  return undefined;
}
