/**
 * Provider-agnostic chat-model probe for phases that promise a cheap keyless
 * skip (#6705): id-validity plus the resolved recipe's `auth_env.required`
 * keys. Kept out of gateway.ts so the gateway module stays inside its size
 * ratchet.
 *
 * Deliberately NOT folded into `probeChatModel`: its lazy non-Anthropic
 * behavior is a pinned contract (A9, test/ai/gateway-probe-chat-model.test.ts)
 * that lets a keyless judge build a client and fail per transcript.
 */

import { loadConfig } from '../config.ts';
import { probeChatModel, requireConfig, validateModelId, type ChatModelProbe } from './gateway.ts';
import { CONFIG_API_KEY_ENV, mergedProviderEnv } from './provider-env.ts';

function gatewayEnv(): Record<string, string | undefined> {
  try {
    return requireConfig().env ?? {};
  } catch {
    return {};
  }
}

/**
 * Like `probeChatModel`, but every keyed provider is checked up front: the key
 * planes are process env, the live gateway env snapshot and the config file
 * (via `mergedProviderEnv`). Anthropic keeps `probeChatModel`'s own check; a
 * recipe with no required key (ollama, llama-server, litellm, claude-cli)
 * passes. The hint names `gbrain config set <key>` only for env variables
 * that have a config-file key.
 */
export function probeChatModelWithKey(modelStr: string): ChatModelProbe {
  const base = probeChatModel(modelStr);
  if (!base.ok) return base;
  const v = validateModelId(modelStr);
  if (!v.ok || v.parsed.providerId === 'anthropic') return base;
  const required = v.recipe?.auth_env?.required ?? [];
  if (required.length === 0) return base;

  const env = { ...process.env, ...gatewayEnv() };
  let merged: Record<string, string>;
  try {
    merged = mergedProviderEnv(loadConfig(), env);
  } catch {
    merged = mergedProviderEnv(null, env);
  }
  const missing = required.filter(name => !merged[name]);
  if (missing.length === 0) return base;

  const configKeys = missing.flatMap(name => CONFIG_API_KEY_ENV.filter(([, envName]) => envName === name).map(([key]) => key));
  const configHint = configKeys.length ? ` or run: ${configKeys.map(key => `gbrain config set ${key} ...`).join(' / ')}` : '';
  return {
    ok: false,
    reason: 'unavailable',
    detail: `no ${v.recipe?.name ?? v.parsed.providerId} API key configured (set ${missing.join(' / ')}${configHint})`,
  };
}
