/**
 * Provider-agnostic chat-model probe (id-validity + declared key), kept out of
 * gateway.ts so the gateway module stays inside its size ratchet.
 */

import { loadConfig } from '../config.ts';
import { requireConfig, validateModelId, type ChatModelProbe } from './gateway.ts';
import { mergedProviderEnv } from './provider-env.ts';

/** The live gateway env snapshot, or nothing when the gateway is unconfigured. */
function gatewayEnv(): Record<string, string | undefined> {
  try {
    return requireConfig().env ?? {};
  } catch {
    return {};
  }
}

/**
 * Provider-agnostic variant of the probe: id-validity PLUS a key check for
 * WHATEVER provider the model resolves to, read from the recipe's own
 * `auth_env.required` rather than a hardcoded vendor.
 *
 * Deliberately NOT folded into `probeChatModel`. That function's lazy
 * non-Anthropic behavior is a pinned contract — the per-transcript-degrade
 * rule (A9, `test/ai/gateway-probe-chat-model.test.ts`: "non-anthropic
 * provider passes the probe even with no key") lets a keyless judge for ONE
 * transcript build a client and fail at call time instead of the builder
 * refusing up front. Making the shared predicate strict would regress
 * `tryBuildGatewayClient` and `makeJudgeClient` along with it.
 *
 * Use this one where a phase wants the CHEAP KEYLESS SKIP: it would rather
 * report `skipped: no <Provider> API key configured` than run and hard-fail.
 * That is the nightly-cron contract (keyless `gbrain dream` exits 0), which
 * only held for Anthropic chat models while the probe pre-checked Anthropic
 * alone.
 *
 * Key resolution mirrors `resolveAnthropicKey`'s planes, generalized:
 * process env → gateway env snapshot → config file, via `mergedProviderEnv`
 * (the canonical config-key → env-name fold). A recipe with no declared
 * `auth_env.required` (local runtimes like ollama / llama-server) is keyless by
 * construction and passes.
 */
export function probeChatModelWithKey(modelStr: string): ChatModelProbe {
  const v = validateModelId(modelStr);
  if (!v.ok) return { ok: false, reason: v.reason, detail: v.detail, fix: v.fix };

  const required = v.recipe?.auth_env?.required ?? [];
  if (required.length === 0) return { ok: true };

  let merged: Record<string, string> = {};
  try {
    merged = mergedProviderEnv(loadConfig(), { ...process.env, ...gatewayEnv() });
  } catch {
    // loadConfig can throw on a first-run install; env alone still decides.
    merged = mergedProviderEnv(null, { ...process.env, ...gatewayEnv() });
  }
  const missing = required.filter((name) => !merged[name]);
  if (missing.length === 0) return { ok: true };

  const provider = v.recipe?.name ?? v.parsed.providerId;
  const configKey = `${v.parsed.providerId}_api_key`;
  return {
    ok: false,
    reason: 'unavailable',
    detail:
      `no ${provider} API key configured ` +
      `(set ${missing.join(' / ')} or run: gbrain config set ${configKey} ...)`,
  };
}
