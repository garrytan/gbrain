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

/**
 * File-plane API keys and the env variable each fills. The GEMINI_API_KEY
 * alias also fills GOOGLE_GENERATIVE_AI_API_KEY (see mergedProviderEnv).
 * TypeSafe has no config-plane key: TYPESAFE_API_KEY and its
 * JEV_TYPESAFE_API_KEY alias are read from the environment only.
 */
export const CONFIG_API_KEY_ENV = [
  ['openai_api_key', 'OPENAI_API_KEY'],
  ['anthropic_api_key', 'ANTHROPIC_API_KEY'],
  ['openrouter_api_key', 'OPENROUTER_API_KEY'],
  ['voyage_api_key', 'VOYAGE_API_KEY'],
  ['dashscope_api_key', 'DASHSCOPE_API_KEY'],
  ['deepseek_api_key', 'DEEPSEEK_API_KEY'],
  // Same seam for LiteLLM + Together, closed alongside litellm's chat
  // touchpoint (v0.42.61.0 made litellm a full chat provider, so the
  // config-plane gap started biting daemon/launchd/MCP contexts the same
  // way voyage's #2662 did).
  ['litellm_api_key', 'LITELLM_API_KEY'],
  ['together_api_key', 'TOGETHER_API_KEY'],
  ['nous_api_key', 'NOUS_API_KEY'],
  ['google_api_key', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  // #4031: the Azure key was the only member of the group below left unfolded,
  // so a config.json-only setup failed every embed from keyless shells
  // (launchd/cron/MCP) while `config show` looked complete.
  ['azure_openai_api_key', 'AZURE_OPENAI_API_KEY'],
] as const satisfies ReadonlyArray<readonly [keyof GBrainConfig, string]>;

const realEnv = (env: Record<string, string | undefined>, name: string): string | undefined =>
  env[name] === undefined || env[name] === '' ? undefined : env[name];

/** The env variable that supplies `name`'s value: the canonical name, or the GEMINI alias for Google. */
function suppliedBy(env: Record<string, string | undefined>, name: string): string {
  return name === 'GOOGLE_GENERATIVE_AI_API_KEY' && !realEnv(env, name) && realEnv(env, 'GEMINI_API_KEY') ? 'GEMINI_API_KEY' : name;
}

export function mergedProviderEnv(
  cfg: GBrainConfig | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const fromConfig: Record<string, string> = {};
  for (const [configKey, name] of CONFIG_API_KEY_ENV) {
    const value = cfg?.[configKey];
    if (value) fromConfig[name] = value;
  }
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

/** #5137: an env variable whose real value shadows a different config-plane key. Names only, never values. */
export interface ProviderKeyShadow {
  variable: string;
  config_key: string;
}

/**
 * #5137: every config-plane key that an environment value overrides with a
 * different value (env wins, as in mergedProviderEnv). Pure. `fileCfg` must be
 * the file-only config (`loadConfigFileOnly`): `loadConfig` already folds
 * OPENAI/ANTHROPIC/OPENROUTER env values into the config fields.
 */
export function providerKeyShadows(
  fileCfg: GBrainConfig | null,
  env: Record<string, string | undefined> = process.env,
): ProviderKeyShadow[] {
  const shadows: ProviderKeyShadow[] = [];
  for (const [configKey, name] of CONFIG_API_KEY_ENV) {
    const fromConfig = fileCfg?.[configKey];
    const variable = suppliedBy(env, name);
    const fromEnv = realEnv(env, variable);
    if (fromConfig && fromEnv && fromEnv !== fromConfig) shadows.push({ variable, config_key: configKey });
  }
  return shadows;
}

/** #5137: where the key a recipe reads from `name` comes from, by name only. */
export type ProviderKeySource =
  | { kind: 'env'; variable: string; config_key?: string; shadows_config: boolean }
  | { kind: 'config'; variable: string; config_key: string }
  | { kind: 'missing'; variable: string; config_key?: string };

export function providerKeySource(
  fileCfg: GBrainConfig | null,
  env: Record<string, string | undefined>,
  name: string,
): ProviderKeySource {
  const configKey = CONFIG_API_KEY_ENV.find(([, envName]) => envName === name)?.[0];
  const variable = suppliedBy(env, name);
  const fromEnv = realEnv(env, variable);
  const fromConfig = configKey ? fileCfg?.[configKey] : undefined;
  if (fromEnv) return { kind: 'env', variable, ...(configKey ? { config_key: configKey } : {}), shadows_config: !!fromConfig && fromConfig !== fromEnv };
  if (configKey && fromConfig) return { kind: 'config', variable, config_key: configKey };
  return { kind: 'missing', variable, ...(configKey ? { config_key: configKey } : {}) };
}
