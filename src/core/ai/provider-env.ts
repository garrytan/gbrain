/**
 * mergedProviderEnv — THE canonical provider-key/env fold.
 *
 * One function owns the mapping from file-plane config keys
 * (`~/.gbrain/config.json`) to the env names the recipes read, the
 * env-wins-for-real-values merge, and the GEMINI alias. Consumers:
 *
 *   - `buildGatewayConfig` (src/core/ai/build-gateway-config.ts) — gateway env
 *   - `detectCapabilities` (src/core/capability.ts) — capability probe
 *   - `resolveTierDefault` / `resolveEffectiveChatModel`
 *     (src/core/model-config.ts) — key-aware model resolution
 *
 * Rules folded in from the two prior copies:
 *   - #1249: process/injected env wins over config-plane fallbacks, but ONLY
 *     for keys carrying a real value. Launchers inject `ANTHROPIC_API_KEY=''`
 *     to neuter subprocess LLM calls; an unconditional spread would let that
 *     empty string clobber a valid config.json key. '' and undefined are
 *     dropped; '0' and 'false' are legitimate values and survive.
 *   - GEMINI_API_KEY alias: Google's docs/SDKs export GEMINI_API_KEY, but the
 *     google recipe reads GOOGLE_GENERATIVE_AI_API_KEY. Precedence: env
 *     GOOGLE_GENERATIVE_AI_API_KEY > env GEMINI_API_KEY > config
 *     google_api_key — the alias is still process-env, so it beats the
 *     config-plane fallback but never the canonical env name.
 *   - Azure OpenAI (keyless/Entra): non-secret endpoint/deployment + the
 *     Entra opt-in fold so the azure-openai recipe works in any shell. The
 *     bearer token is minted at request time via `az`; no secret stored.
 */

import type { GBrainConfig } from '../config.ts';

export function mergedProviderEnv(
  cfg: GBrainConfig | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const fromConfig: Record<string, string> = {};
  if (cfg?.openai_api_key) fromConfig.OPENAI_API_KEY = cfg.openai_api_key;
  if (cfg?.anthropic_api_key) fromConfig.ANTHROPIC_API_KEY = cfg.anthropic_api_key;
  if (cfg?.zeroentropy_api_key) fromConfig.ZEROENTROPY_API_KEY = cfg.zeroentropy_api_key;
  if (cfg?.openrouter_api_key) fromConfig.OPENROUTER_API_KEY = cfg.openrouter_api_key;
  if (cfg?.voyage_api_key) fromConfig.VOYAGE_API_KEY = cfg.voyage_api_key;
  if (cfg?.dashscope_api_key) fromConfig.DASHSCOPE_API_KEY = cfg.dashscope_api_key;
  // Same seam for LiteLLM + Together, closed alongside litellm's chat
  // touchpoint (v0.42.61.0 made litellm a full chat provider, so the
  // config-plane gap started biting daemon/launchd/MCP contexts the same
  // way voyage's #2662 did).
  if (cfg?.litellm_api_key) fromConfig.LITELLM_API_KEY = cfg.litellm_api_key;
  if (cfg?.together_api_key) fromConfig.TOGETHER_API_KEY = cfg.together_api_key;
  if (cfg?.google_api_key) fromConfig.GOOGLE_GENERATIVE_AI_API_KEY = cfg.google_api_key;
  // #4031: the Azure key was the only member of the group below left unfolded,
  // so a config.json-only setup failed every embed from keyless shells
  // (launchd/cron/MCP) while `config show` looked complete.
  if (cfg?.azure_openai_api_key) fromConfig.AZURE_OPENAI_API_KEY = cfg.azure_openai_api_key;
  if (cfg?.azure_openai_endpoint) fromConfig.AZURE_OPENAI_ENDPOINT = cfg.azure_openai_endpoint;
  if (cfg?.azure_openai_deployment) fromConfig.AZURE_OPENAI_DEPLOYMENT = cfg.azure_openai_deployment;
  if (cfg?.azure_openai_use_entra) fromConfig.AZURE_OPENAI_USE_ENTRA = cfg.azure_openai_use_entra;

  const envReal = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  ) as Record<string, string>;
  const merged = { ...fromConfig, ...envReal };
  if (!envReal.GOOGLE_GENERATIVE_AI_API_KEY && envReal.GEMINI_API_KEY) {
    merged.GOOGLE_GENERATIVE_AI_API_KEY = envReal.GEMINI_API_KEY;
  }
  return merged;
}
