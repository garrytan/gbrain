/**
 * v0.41.x (#1698) — single shared Anthropic key-presence probe.
 *
 * Consolidates three byte-identical private copies that had drifted apart over
 * time (`think/index.ts`, `cycle/synthesize.ts`, `conversation-parser/llm-base.ts`).
 * Same drift class as the four colon-only model-id normalizers — one source of truth.
 *
 * Reads BOTH env (`ANTHROPIC_API_KEY`) AND the gbrain config file
 * (`anthropic_api_key` set via `gbrain config set`) so stdio MCP launches that
 * don't inherit shell env keep working. `loadConfig` can throw on first-run
 * installs; that is swallowed and treated as "no key available."
 *
 * Lives in `src/core/ai/` (not gateway.ts) to keep the gateway module's surface
 * lean and to avoid any import-cycle risk — the three consumers already import
 * from gateway.ts.
 */

import { loadConfig } from '../config.ts';

export function hasAnthropicKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const cfg = loadConfig();
    if (cfg?.anthropic_api_key) return true;
  } catch {
    // loadConfig may throw on first-run installs; treat as no key available.
  }
  return false;
}
