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
import { loadConfig } from '../config.ts';
import type { AIGatewayConfig } from './types.ts';
import { mergedProviderEnv } from './provider-env.ts';

/**
 * #3350: fold FILE-plane `provider_base_urls.{anthropic,openai}` into the
 * gateway env as `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, same shape as the
 * credential folds (env wins for keys carrying a real value). Native
 * providers read their base URL exclusively from env via
 * `resolveNativeBaseUrl` (which also normalizes the `/v1` suffix), so before
 * this fold a config.json `provider_base_urls.anthropic` was silently ignored
 * by native chat/embed calls.
 *
 * MOUNT SAFETY (gateway.ts `reconfigureGatewayWithEngine` rationale): the
 * fold takes the FILE config explicitly — never a DB-merged config — so
 * DB-plane `provider_base_urls.*` (which can be merged from a shared brain)
 * can never steer this process's native bearer keys to an attacker URL.
 * `buildGatewayConfig` therefore re-reads `loadConfig()` for this fold even
 * when its caller passed a DB-merged config.
 *
 * @internal exported for tests + gateway's file-plane env refresh.
 */
export function foldNativeBaseUrlsFromFilePlane(
  fileCfg: Pick<GBrainConfig, 'provider_base_urls'> | null,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const urls = fileCfg?.provider_base_urls;
  if (!urls) return env;
  const out = { ...env };
  for (const [provider, envKey] of [
    ['anthropic', 'ANTHROPIC_BASE_URL'],
    ['openai', 'OPENAI_BASE_URL'],
  ] as const) {
    const fileUrl = urls[provider];
    // Env wins: only fold when the env carries no real value.
    if (fileUrl && fileUrl.trim() && !(out[envKey] && out[envKey]!.trim())) {
      out[envKey] = fileUrl.trim();
    }
  }
  return out;
}

export function buildGatewayConfig(c: GBrainConfig): AIGatewayConfig {
  // The file-plane key fold + env merge live in mergedProviderEnv
  // (src/core/ai/provider-env.ts) — the single canonical mapping shared with
  // detectCapabilities and the key-aware model resolution. Config keys are a
  // fallback for daemons / launchd-spawned subprocesses that don't propagate
  // ~/.zshrc-sourced keys; process env wins for keys carrying a real value.

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

  // #3350: native base-URL fold — MUST read the file plane directly, not `c`
  // (callers can pass a DB-merged config; see foldNativeBaseUrlsFromFilePlane's
  // mount-safety note). Fail-open: an unreadable config folds nothing.
  let fileCfg: GBrainConfig | null = null;
  try {
    fileCfg = loadConfig();
  } catch {
    fileCfg = null;
  }

  return {
    embedding_model: c.embedding_model,
    embedding_dimensions: c.embedding_dimensions,
    embedding_multimodal_model: c.embedding_multimodal_model,
    expansion_model: c.expansion_model,
    chat_model: c.chat_model,
    chat_fallback_chain: c.chat_fallback_chain,
    base_urls: { ...envBaseUrls, ...(c.provider_base_urls ?? {}) }, // config wins over env
    provider_chat_options: c.provider_chat_options,
    // #1249 empty-string drop + GEMINI alias applied inside mergedProviderEnv.
    // #3350 file-plane native base-URL fold layered on top (env wins).
    env: foldNativeBaseUrlsFromFilePlane(fileCfg, mergedProviderEnv(c, process.env)),
  };
}
