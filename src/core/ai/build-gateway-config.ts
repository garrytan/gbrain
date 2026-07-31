/**
 * buildGatewayConfig — translate a stored GBrainConfig into the gateway's
 * AIGatewayConfig (env dict + base_urls + model strings).
 *
 * v0.42 (#1780 Gap 2): extracted from src/cli.ts into a core module so
 * `src/core/init-embed-check.ts` can reuse it without importing the CLI
 * entrypoint (which would create a load-time cycle). cli.ts re-exports
 * `buildGatewayConfig` for back-compat with existing callers + tests that
 * import it from `../../src/cli.ts`.
 *
 * The single ownership site for: (a) folding file-plane API keys
 * (openai/anthropic/zeroentropy/openrouter/voyage/dashscope/google) into the gateway env, and (b) threading
 * local-server `*_BASE_URL` env vars into base_urls. Both matter for the
 * init-time embedding-key probe — without (a) it would false-warn on
 * config.json-keyed users, and without (b) a live probe could hit the wrong
 * endpoint (custom OpenAI base URL, llama-server, etc.).
 */

import type { GBrainConfig } from '../config.ts';
import type { AIGatewayConfig } from './types.ts';

export function buildGatewayConfig(c: GBrainConfig): AIGatewayConfig {
  // v0.32 (#121 reworked): when ~/.gbrain/config.json declares
  // openai_api_key / anthropic_api_key, fold them into the gateway env so
  // recipes that read OPENAI_API_KEY / ANTHROPIC_API_KEY find them. Process
  // env still wins (it's loaded last) — this is a fallback for daemons /
  // launchd-spawned subprocesses that don't propagate ~/.zshrc-sourced keys.
  const envFromConfig: Record<string, string> = {};
  if (c.openai_api_key) envFromConfig.OPENAI_API_KEY = c.openai_api_key;
  if (c.anthropic_api_key) envFromConfig.ANTHROPIC_API_KEY = c.anthropic_api_key;
  // v0.37 fix wave (CDX2-5+6): ZE became the default provider in v0.36 but
  // the env-mapping at this seam never picked it up. `gbrain config set
  // zeroentropy_api_key X` wrote DB plane (ignored by gateway). The file-
  // plane field now exists (GBrainConfig type) and gets mapped here, so
  // setting it via `~/.gbrain/config.json` propagates into the gateway.
  if (c.zeroentropy_api_key) envFromConfig.ZEROENTROPY_API_KEY = c.zeroentropy_api_key;
  // Same seam for OpenRouter: `gbrain config set openrouter_api_key X` (or
  // config.json) must reach the openrouter recipe's OPENROUTER_API_KEY.
  // process.env still wins via the later spread.
  if (c.openrouter_api_key) envFromConfig.OPENROUTER_API_KEY = c.openrouter_api_key;
  // #2662: same seam for Voyage. Before this, config.json's voyage_api_key
  // was accepted at the file plane but never threaded into the gateway env,
  // so launchd/daemon/MCP contexts (no process-env export) silently failed
  // multimodal/image embeds despite config.json looking complete. process.env
  // still wins via the later spread.
  if (c.voyage_api_key) envFromConfig.VOYAGE_API_KEY = c.voyage_api_key;
  // #3500: same seam for DashScope. The dashscope + dashscope-rerank recipes
  // require DASHSCOPE_API_KEY, but the config-plane key was never folded, so
  // daemon/launchd/MCP contexts with no process-env export failed auth
  // despite config.json looking complete. process.env still wins via the
  // later spread.
  if (c.dashscope_api_key) envFromConfig.DASHSCOPE_API_KEY = c.dashscope_api_key;
  // #3500: same seam for Google Gemini. The google recipe reads
  // GOOGLE_GENERATIVE_AI_API_KEY; before this fold, the ONLY way to
  // configure Gemini was exporting that exact env var. (This closes the
  // deferral noted in src/core/brain-score-recommendations.ts, whose
  // HOSTED_EMBED_KEY_CONFIG entry lands in the same change.)
  if (c.google_api_key) envFromConfig.GOOGLE_GENERATIVE_AI_API_KEY = c.google_api_key;
  // Azure OpenAI (keyless/Entra): fold the non-secret endpoint/deployment + the
  // Entra opt-in into the gateway env so the azure-openai recipe works in any
  // shell (incl. non-interactive agent shells). The bearer token is minted at
  // request time via `az`; no secret is stored in config.json.
  if (c.azure_openai_endpoint) envFromConfig.AZURE_OPENAI_ENDPOINT = c.azure_openai_endpoint;
  if (c.azure_openai_deployment) envFromConfig.AZURE_OPENAI_DEPLOYMENT = c.azure_openai_deployment;
  if (c.azure_openai_use_entra) envFromConfig.AZURE_OPENAI_USE_ENTRA = c.azure_openai_use_entra;

  // v0.32 codex finding #4+#5 fix: thread local-server _BASE_URL env vars
  // into base_urls so the gateway hits the user's configured port. Without
  // this, `LLAMA_SERVER_BASE_URL=http://localhost:9000` would let the probe
  // succeed against :9000 but the actual embed call would still go to the
  // recipe's base_url_default (localhost:8080). Same fix applies to
  // OLLAMA_BASE_URL. Caller-provided cfg.provider_base_urls wins.
  const envBaseUrls: Record<string, string> = {};
  if (process.env.LLAMA_SERVER_BASE_URL) envBaseUrls['llama-server'] = process.env.LLAMA_SERVER_BASE_URL;
  // v0.40.6.1: sibling recipe for llama-server in reranking mode. Separate
  // env var because --reranking and --embeddings are mutually exclusive at
  // server launch — users running both will have two llama-server processes
  // on different ports.
  if (process.env.LLAMA_SERVER_RERANKER_BASE_URL) envBaseUrls['llama-server-reranker'] = process.env.LLAMA_SERVER_RERANKER_BASE_URL;
  if (process.env.OLLAMA_BASE_URL) envBaseUrls['ollama'] = process.env.OLLAMA_BASE_URL;
  if (process.env.LMSTUDIO_BASE_URL) envBaseUrls['lmstudio'] = process.env.LMSTUDIO_BASE_URL;
  if (process.env.LITELLM_BASE_URL) envBaseUrls['litellm'] = process.env.LITELLM_BASE_URL;
  if (process.env.OPENROUTER_BASE_URL) envBaseUrls['openrouter'] = process.env.OPENROUTER_BASE_URL;

  return {
    embedding_model: c.embedding_model,
    embedding_dimensions: c.embedding_dimensions,
    embedding_multimodal_model: c.embedding_multimodal_model,
    expansion_model: c.expansion_model,
    chat_model: c.chat_model,
    chat_fallback_chain: c.chat_fallback_chain,
    base_urls: { ...envBaseUrls, ...(c.provider_base_urls ?? {}) }, // config wins over env
    provider_chat_options: c.provider_chat_options,
    // #1249: process.env still wins over the config-plane fallback, BUT only for
    // keys that carry a real value. Claude Code (and some launchers) inject
    // ANTHROPIC_API_KEY='' to neuter subprocess LLM calls; an unconditional
    // `...process.env` lets that empty string clobber a valid config.json key, so
    // every gateway op then throws NO_ANTHROPIC_API_KEY. Drop empty-string /
    // undefined entries before the merge. Only '' and undefined are dropped —
    // '0' and 'false' are legitimate values and survive.
    env: buildEnv(envFromConfig),
  };
}

/**
 * Merge config-plane fallbacks with process.env (env wins for keys carrying a
 * real value — see #1249 note above), then apply the GEMINI_API_KEY alias:
 * Google's own docs/SDKs export GEMINI_API_KEY, but the google recipe (and
 * every gateway read site) uses GOOGLE_GENERATIVE_AI_API_KEY. Precedence:
 * env GOOGLE_GENERATIVE_AI_API_KEY > env GEMINI_API_KEY > config
 * google_api_key — i.e. the alias is still process-env, so it beats the
 * config-plane fallback, but never the canonical env name.
 */
function buildEnv(envFromConfig: Record<string, string>): Record<string, string> {
  const envReal = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''),
  ) as Record<string, string>;
  const merged = { ...envFromConfig, ...envReal };
  if (!envReal.GOOGLE_GENERATIVE_AI_API_KEY && envReal.GEMINI_API_KEY) {
    merged.GOOGLE_GENERATIVE_AI_API_KEY = envReal.GEMINI_API_KEY;
  }
  return merged;
}
