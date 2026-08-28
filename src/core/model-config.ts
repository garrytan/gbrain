/**
 * v0.28: Unified model configuration.
 *
 * One resolver replaces every hardcoded `claude-*-X` string + every per-phase
 * `dream.<phase>.model` config key. Hierarchy (highest precedence first):
 *
 *   1. CLI flag (--model)
 *   2. New-key config (e.g. models.dream.synthesize)
 *   3. Old-key config (deprecated dream.synthesize.model, dream.patterns.model)
 *      — read with stderr deprecation warning, one-per-process
 *   4. Global default (models.default)
 *   5. Env var (process.env[envVar] or GBRAIN_MODEL)
 *   6. Hardcoded fallback (caller-supplied)
 *
 * Aliases (`opus`, `sonnet`, `haiku`, `gemini`, `gpt`) resolve at the end so any
 * tier can use a short name. Unknown alias passes through unchanged so users can
 * pass full provider IDs without registering aliases.
 *
 * Per Codex P1 #11: deprecated keys are honored but stderr-warn once per process
 * AND lose to new-key config when both are set.
 */

import type { ConfigReader } from './config-snapshot.ts';
import { splitProviderModelId } from './model-id.ts';
import type { GBrainConfig } from './config.ts';
import { loadConfig } from './config.ts';
import { mergedProviderEnv } from './ai/provider-env.ts';
import { RECIPES } from './ai/recipes/index.ts';
import { latestOpenAITiers, rankOpenAIChatModels } from './ai/openai-latest.ts';

export type ModelTier = 'utility' | 'reasoning' | 'deep' | 'subagent';

export interface ResolveModelOpts {
  /** CLI flag value (e.g. `--model opus` → 'opus'). Highest precedence. */
  cliFlag?: string;
  /** New-key config name (e.g. 'models.dream.synthesize'). */
  configKey?: string;
  /** Deprecated old-key config name (e.g. 'dream.synthesize.model'). */
  deprecatedConfigKey?: string;
  /** Env var to consult after global default. Defaults to `GBRAIN_MODEL`. */
  envVar?: string;
  /**
   * Tier classification (v0.31.12). Looked up after the per-feature config
   * keys and BEFORE `models.default` (#3873 — tier-specific beats generic),
   * then before the env var. Routing groups: `utility` (haiku-class,
   * classification + expansion + verdict), `reasoning` (sonnet-class,
   * default chat + synthesis + fact extraction), `deep` (opus-class,
   * expensive reasoning), `subagent` (Anthropic-only multi-turn tool loop —
   * never inherits a non-Anthropic `models.default`; falls back to
   * TIER_DEFAULTS.subagent with a one-shot stderr warn instead).
   */
  tier?: ModelTier;
  /** Hardcoded last-resort fallback. */
  fallback: string;
}

/** Default aliases shipped in code. Users override via `models.aliases.<name>` config.
 *  Values include the `provider:` prefix so resolved model strings always
 *  carry an explicit provider — required by the v0.40.8+ subagent queue's
 *  classifyCapabilities() validation. Bare model ids (e.g. `claude-opus-4-7`)
 *  cause `resolveRecipe()` to throw "unknown provider" and the queue rejects
 *  the submit. */
export const DEFAULT_ALIASES: Record<string, string> = {
  opus:   'anthropic:claude-opus-4-7',
  sonnet: 'anthropic:claude-sonnet-4-6',
  haiku:  'anthropic:claude-haiku-4-5-20251001',
  // `gemini` repointed (#2507): `gemini-3-pro` only ever existed as a preview
  // id (`gemini-3-pro-preview`) and was shut down — it was never chat-listed
  // in the google recipe nor priced. 2.5-flash is the recipe's chat models[0];
  // there is NO GA pro-class Gemini chat target today, so the alias
  // deliberately sits a capability class below the opus convention until
  // Google ships a GA pro. Guarded by test/default-alias-liveness.test.ts.
  gemini: 'google:gemini-2.5-flash',
  // `gpt` resolves DYNAMICALLY in resolveAlias (account-discovered OpenAI
  // flagship, recipe-ranked static floor) — this entry keeps the alias
  // enumerable but the value here is only the documentation floor; a pinned
  // id would 404 within months (the previous 'openai:gpt-5' already did).
  gpt:    'openai:gpt-5.6',
};

/**
 * Default model for each tier. Used as the hardcoded fallback when no
 * `models.tier.<tier>` config + no `models.default` is set. Subagent gets
 * Sonnet (Anthropic Messages API tool-loop shape required); reasoning gets
 * Sonnet (default workhorse); deep gets Opus 4.7 (expensive reasoning);
 * utility gets Haiku (fast classification).
 *
 * Users override via `gbrain config set models.tier.<tier> <model>`.
 */
export const TIER_DEFAULTS: Record<ModelTier, string> = {
  utility:   'anthropic:claude-haiku-4-5-20251001',
  reasoning: 'anthropic:claude-sonnet-4-6',
  deep:      'anthropic:claude-opus-4-7',
  subagent:  'anthropic:claude-sonnet-4-6',
};

/**
 * OpenAI static tier fallback — NO literal model pins. Derived from the
 * openai recipe's chat list through the SAME ranking grammar latest-model
 * discovery uses (openai-latest.ts), so there is exactly one place a human
 * updates OpenAI entry points (the recipe) and one function that classifies
 * them. The RUNTIME default overlays this with the account-discovered cache
 * in resolveTierDefault below. Computed lazily + memoized: recipes are static
 * data, so this is pure.
 */
let _openaiStaticTiers: Record<ModelTier, string> | null = null;
export function openaiStaticTierFallback(): Record<ModelTier, string> {
  if (!_openaiStaticTiers) {
    const recipeModels = RECIPES.get('openai')?.touchpoints.chat?.models ?? [];
    const ranked = rankOpenAIChatModels(recipeModels, () => true).tiers;
    // A recipe list that defeats its own grammar would be a build bug; the
    // Anthropic tier defaults are the never-null floor.
    _openaiStaticTiers = ranked ?? { ...TIER_DEFAULTS };
  }
  return _openaiStaticTiers;
}

/**
 * Key-aware tier defaults. The FIRST entry whose env key is present (merged
 * env: config-file keys folded, env wins, empty strings dropped) supplies the
 * tier default. Anthropic first preserves today's behavior byte-for-byte on
 * every keyed install; OpenAI second makes an OPENAI_API_KEY-only install
 * actually work (fact extraction, expansion, synthesis) instead of routing
 * every default to a provider whose key is absent. No key at all →
 * TIER_DEFAULTS unchanged (keyless installs degrade honestly downstream).
 *
 * OpenAI tiers are RESOLVED PER CALL, never pinned: the account-discovered
 * latest (openai-latest.ts cache, refreshed at gateway connect) wins, the
 * recipe-derived static ranking is the offline floor. The subagent tier runs
 * without prompt caching on OpenAI → enforceSubagentCapable emits the
 * degraded:no_caching cost warn.
 *
 * Adding a provider here needs a curated per-tier model choice — see the
 * TODOS.md follow-up before extending.
 */
/** Account-discovered latest for a tier, else the recipe-ranked static floor. */
function discoveredOrStaticOpenAITier(tier: ModelTier): string {
  const discovered = latestOpenAITiers(tier);
  return typeof discovered === 'string' ? discovered : openaiStaticTierFallback()[tier];
}

export const PROVIDER_TIER_DEFAULTS: ReadonlyArray<{
  provider: 'anthropic' | 'openai';
  envKey: string;
  tiers: (tier: ModelTier) => string;
}> = [
  { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', tiers: (tier) => TIER_DEFAULTS[tier] },
  { provider: 'openai', envKey: 'OPENAI_API_KEY', tiers: discoveredOrStaticOpenAITier },
];

/** loadConfig, throw-safe (the hasAnthropicKey pattern): unreadable config = env-only. */
function throwSafeLoadConfig(): GBrainConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

/** Drop ''/undefined entries (#1249) from an injected env. */
function realEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  ) as Record<string, string>;
}

/**
 * Resolve the default model for a tier, honoring which provider keys are
 * actually present. When `env` is passed it is used EXCLUSIVELY (no config
 * read — hermetic for tests and pre-merged callers); when omitted, the merged
 * env is computed from the file-plane config + process.env.
 */
export function resolveTierDefault(
  tier: ModelTier,
  env?: Record<string, string | undefined>,
): string {
  const merged = env ? realEnv(env) : mergedProviderEnv(throwSafeLoadConfig(), process.env);
  for (const entry of PROVIDER_TIER_DEFAULTS) {
    if (merged[entry.envKey]) return entry.tiers(tier);
  }
  return TIER_DEFAULTS[tier];
}

/**
 * True when `model`'s provider can serve CHAT and has every required auth
 * env var present in `env` (per its recipe's auth_env.required). Bare model
 * ids (no provider prefix) and unknown providers return false — an
 * unverifiable pin is not a servable pin. A keyed but chat-less recipe
 * (e.g. an embedding-only provider pinned as chat_model) is also not ready:
 * every caller of this function resolves a chat-shaped tier, and honoring
 * such a pin would install a model `isAvailable('chat')` rejects instead of
 * falling back to the key-aware default. Recipes with no required keys
 * (e.g. local Ollama) are always ready.
 */
export function providerKeyReady(model: string, env: Record<string, string>): boolean {
  const { provider } = splitProviderModelId(model);
  if (!provider) return false;
  const recipe = RECIPES.get(provider.trim().toLowerCase());
  if (!recipe) return false;
  if (!recipe.touchpoints?.chat) return false;
  const required = recipe.auth_env?.required ?? [];
  if (required.length === 0) return true;
  return required.every((k) => !!env[k]);
}

const _unservablePinWarningsEmitted = new Set<string>();

export type EffectiveModelSource = 'env_model' | 'file_pin' | 'tier_default';

/**
 * Engine-free effective-model resolution for a chat-shaped tier. ONE shared
 * function — `reconfigureGatewayWithEngine`'s fallback layer and
 * `detectCapabilities`' extraction probe both call it, so runtime routing and
 * the capability report cannot diverge by construction.
 *
 * Reads the RAW file-plane config — never gateway state, which stamps
 * defaults at boot and makes an explicit pin indistinguishable from a
 * fabricated one. Precedence: GBRAIN_MODEL env > servable file pin (its
 * provider's keys are present) > key-aware tier default. An unservable pin
 * (init-era pin whose key is gone, or a provider switch) falls through with
 * one stderr warn per (pin, process) — availability-aware, never a hard fail.
 */
function resolveEffectiveModelForTier(
  tier: ModelTier,
  pin: string | undefined,
  fileCfg: GBrainConfig | null,
  env: Record<string, string | undefined>,
): { model: string; source: EffectiveModelSource } {
  const merged = mergedProviderEnv(fileCfg, env);
  const envModel = merged.GBRAIN_MODEL?.trim();
  if (envModel) {
    // Same `gpt` discovery routing as the pin branch below and
    // resolveAlias — GBRAIN_MODEL=gpt must not resolve differently
    // depending on which resolver ran.
    const model = envModel === 'gpt'
      ? discoveredOrStaticOpenAITier('deep')
      : DEFAULT_ALIASES[envModel] ?? envModel;
    return { model, source: 'env_model' };
  }
  const rawPin = pin?.trim();
  if (rawPin) {
    // A bare `gpt` alias pin resolves through the same discovery path as
    // resolveAlias('gpt') — the DEFAULT_ALIASES entry is only the
    // documentation floor and would silently bypass the account-discovered
    // flagship.
    const fullPin = rawPin === 'gpt'
      ? discoveredOrStaticOpenAITier('deep')
      : DEFAULT_ALIASES[rawPin] ?? rawPin;
    if (providerKeyReady(fullPin, merged)) return { model: fullPin, source: 'file_pin' };
    if (!_unservablePinWarningsEmitted.has(fullPin)) {
      _unservablePinWarningsEmitted.add(fullPin);
      // Explicit tier→config-key map: an unmapped future caller mislabeling
      // the warn would be a silent doc bug with a ternary.
      const PIN_KEY_BY_TIER: Record<ModelTier, string> = {
        utility: 'expansion_model', reasoning: 'chat_model', deep: 'chat_model', subagent: 'chat_model',
      };
      // A prefix-less pin is a DIFFERENT problem than a missing key — saying
      // "no usable provider key" for `chat_model: "claude-sonnet-4-6"` sends
      // the user hunting for a key problem they may not have.
      const diagnosis = splitProviderModelId(fullPin).provider === null
        ? `has no provider prefix, so its key can't be verified — prefix it (e.g. "anthropic:${fullPin}")`
        : `has no usable provider key — set the provider's API key, update the pin`;
      process.stderr.write(
        `[models] configured ${PIN_KEY_BY_TIER[tier]} "${fullPin}" ${diagnosis}, ` +
        `or remove it from ~/.gbrain/config.json. Falling back to the key-aware default.\n`,
      );
    }
  }
  return { model: resolveTierDefault(tier, merged), source: 'tier_default' };
}

/** Effective chat model (reasoning tier) from raw file config + env. */
export function resolveEffectiveChatModel(
  fileCfg: GBrainConfig | null,
  env: Record<string, string | undefined> = process.env,
): { model: string; source: EffectiveModelSource } {
  return resolveEffectiveModelForTier('reasoning', fileCfg?.chat_model, fileCfg, env);
}

/** Effective expansion model (utility tier) from raw file config + env. */
export function resolveEffectiveExpansionModel(
  fileCfg: GBrainConfig | null,
  env: Record<string, string | undefined> = process.env,
): { model: string; source: EffectiveModelSource } {
  return resolveEffectiveModelForTier('utility', fileCfg?.expansion_model, fileCfg, env);
}

/**
 * v0.31.12 subagent runtime enforcement (layer 2).
 *
 * Returns true if a resolved `provider:model` (or bare model id) points at
 * an Anthropic-shape API. The subagent loop in
 * `src/core/minions/handlers/subagent.ts` makes Anthropic Messages API calls
 * with prompt caching on system + tools; routing it elsewhere silently
 * breaks. When `tier === 'subagent'` resolves to a non-Anthropic provider,
 * we log a stderr warn AND fall back to `TIER_DEFAULTS.subagent`.
 */
export function isAnthropicProvider(modelString: string): boolean {
  if (!modelString) return false;
  // v0.41.21.0: route through splitProviderModelId so slash form
  // (`anthropic/claude-sonnet-4-6`) also classifies as Anthropic.
  // Pre-fix the inline `:`-only split silently returned false for slash
  // form → subagent guard bypass → silent fallback to TIER_DEFAULTS.
  const { provider, model } = splitProviderModelId(modelString);
  if (provider !== null) {
    return provider.trim().toLowerCase() === 'anthropic';
  }
  // Bare model id (no separator): known Anthropic models start with `claude-`.
  // Conservative: we'd rather warn-on-Anthropic-typo than silently route
  // gpt-5 to the subagent loop.
  return model.toLowerCase().startsWith('claude-');
}

/**
 * OpenRouter Anthropic routes (`openrouter:anthropic/…`). These are NOT
 * native Anthropic (`isAnthropicProvider` stays false — the Messages SDK
 * cannot speak OR). The legacy `!useGatewayLoop && !isAnthropicProvider`
 * pin treats them as an exception and auto-routes through gateway.toolLoop().
 */
export function isOpenRouterAnthropic(modelString: string): boolean {
  if (!modelString) return false;
  const { provider, model } = splitProviderModelId(modelString);
  return provider?.trim().toLowerCase() === 'openrouter'
    && model.toLowerCase().startsWith('anthropic/');
}

const _subagentTierWarningsEmitted = new Set<string>();

// Module-level set of deprecated config keys we've already warned about.
// Reset on process restart; one warning per (key, process) per Codex P1 #11.
const _deprecationWarningsEmitted = new Set<string>();

function emitDeprecationWarning(oldKey: string, newKey: string, ignored: boolean): void {
  if (_deprecationWarningsEmitted.has(oldKey)) return;
  _deprecationWarningsEmitted.add(oldKey);
  if (ignored) {
    process.stderr.write(
      `[models] deprecated config "${oldKey}" ignored; "${newKey}" is set and wins. ` +
      `Remove "${oldKey}" from your config in v0.30.\n`,
    );
  } else {
    process.stderr.write(
      `[models] deprecated config "${oldKey}" honored; rename to "${newKey}" before v0.30.\n`,
    );
  }
}

/** Which step of the resolution chain produced the model. */
export type ResolveSource =
  | 'cli_flag'
  | 'config_key'
  | 'deprecated_key'
  | 'models_default'
  | 'tier_config'
  | 'env'
  | 'tier_default'
  | 'fallback';

/**
 * Resolve a model name through the precedence chain, reporting WHICH step
 * produced it. Async because it reads config from the engine. Pass
 * `engine: null` for callsites that don't have an engine (rare; usually CLI
 * bootstrap before connect). Step 7 (tier default) is key-aware: it routes
 * through `resolveTierDefault`, so an install whose only key is
 * OPENAI_API_KEY resolves tier defaults to OpenAI models instead of an
 * unservable Anthropic default.
 */
export async function resolveModelDetailed(
  engine: ConfigReader | null,
  opts: ResolveModelOpts,
): Promise<{ model: string; source: ResolveSource }> {
  const envVar = opts.envVar ?? 'GBRAIN_MODEL';

  // 1. CLI flag wins
  if (opts.cliFlag && opts.cliFlag.trim()) {
    return { model: await resolveAlias(engine, opts.cliFlag.trim()), source: 'cli_flag' };
  }

  if (engine) {
    // 2. New-key config
    if (opts.configKey) {
      const v = await engine.getConfig(opts.configKey);
      if (v && v.trim()) {
        // If a deprecated key is also set, warn that it's being ignored.
        if (opts.deprecatedConfigKey) {
          const old = await engine.getConfig(opts.deprecatedConfigKey);
          if (old && old.trim()) {
            emitDeprecationWarning(opts.deprecatedConfigKey, opts.configKey, /*ignored=*/ true);
          }
        }
        return { model: await resolveAlias(engine, v.trim()), source: 'config_key' };
      }
    }

    // 3. Old-key (deprecated) config
    if (opts.deprecatedConfigKey) {
      const v = await engine.getConfig(opts.deprecatedConfigKey);
      if (v && v.trim()) {
        emitDeprecationWarning(opts.deprecatedConfigKey, opts.configKey ?? '<no replacement>', /*ignored=*/ false);
        return { model: await resolveAlias(engine, v.trim()), source: 'deprecated_key' };
      }
    }

    // 4. Tier override (v0.31.12; hoisted above models.default by #3873).
    //    `models.tier.<tier>` is strictly more specific than the generic
    //    `models.default`, so it must win — pre-fix, setting a cheap utility
    //    tier was silently ignored on any brain that also set models.default.
    if (opts.tier) {
      const tierVal = await engine.getConfig(`models.tier.${opts.tier}`);
      if (tierVal && tierVal.trim()) {
        const resolved = await resolveAlias(engine, tierVal.trim());
        return { model: enforceSubagentCapable(resolved, opts.tier, `models.tier.${opts.tier}`), source: 'tier_config' };
      }
    }

    // 5. Global default
    const def = await engine.getConfig('models.default');
    if (def && def.trim()) {
      const resolved = await resolveAlias(engine, def.trim());
      return { model: enforceSubagentCapable(resolved, opts.tier, 'models.default'), source: 'models_default' };
    }
  }

  // 6. Env var
  const env = process.env[envVar];
  if (env && env.trim()) {
    const resolved = await resolveAlias(engine, env.trim());
    return { model: enforceSubagentCapable(resolved, opts.tier, `env:${envVar}`), source: 'env' };
  }

  // 7. Key-aware tier default — when no override beats us, the tier's
  //    canonical model for the first env-ready provider wins over the
  //    caller-supplied fallback.
  if (opts.tier && TIER_DEFAULTS[opts.tier]) {
    const resolved = await resolveAlias(engine, resolveTierDefault(opts.tier));
    return { model: enforceSubagentCapable(resolved, opts.tier, 'tier-default'), source: 'tier_default' };
  }

  // 8. Hardcoded fallback (caller-supplied)
  return { model: await resolveAlias(engine, opts.fallback), source: 'fallback' };
}

/**
 * Resolve a model name through the precedence chain. Thin wrapper over
 * `resolveModelDetailed` for the ~30 callers that don't care which step won.
 */
export async function resolveModel(
  engine: ConfigReader | null,
  opts: ResolveModelOpts,
): Promise<string> {
  return (await resolveModelDetailed(engine, opts)).model;
}

/**
 * v0.31.12 subagent runtime enforcement (layer 2): if `tier === 'subagent'`
 * resolved to a non-Anthropic model, warn once per (source, model) and fall
 * back to `TIER_DEFAULTS.subagent`. Source is the resolution-chain step that
 * produced the bad value (`models.default`, `models.tier.subagent`, etc.) so
 * the user sees where to fix it.
 *
 * Returns the resolved value unchanged for non-subagent tiers or when the
 * resolved value is already Anthropic.
 */
/**
 * v0.38 (D7) — replaces the legacy `enforceSubagentAnthropic` with a
 * capability-based gate. The check now asks "can this model run a subagent
 * tool loop?" via the recipe-driven capability classifier instead of "is
 * this Anthropic?". Result:
 *
 *   - `unusable:no_tools` → fall back to TIER_DEFAULTS.subagent + warn (the
 *     loop literally cannot dispatch tools, so the resolved model is wrong)
 *   - `unusable:no_subagent_loop` → fall back to TIER_DEFAULTS.subagent + warn
 *     (the recipe declares tool_call_ids unstable across crash/replay, so the
 *     loop can't reconcile — same refusal class as no_tools)
 *   - `unknown` → fall back to TIER_DEFAULTS.subagent + warn (unknown provider
 *     — defensive: don't burn money on a model we can't verify supports tools)
 *   - `degraded:no_caching` → return resolved; warn once per (source, model)
 *     about cost regression
 *   - `degraded:no_parallel` → return resolved; info-log
 *   - `ok` → return resolved unchanged
 *
 * Once-per-(source, model) warn seam preserved from v0.31.12 (same Set, same
 * suppression key) so doctor + first-call surfaces don't double-warn.
 */
function enforceSubagentCapable(resolved: string, tier: ModelTier | undefined, source: string): string {
  if (tier !== 'subagent') return resolved;

  // Lazy import keeps capabilities.ts out of model-config's eager-load surface
  // (capabilities → model-resolver → recipes; this would create a cycle if
  // model-config itself were imported by recipes, which it isn't, but
  // defensive against future drift).
  let verdict: 'ok' | 'degraded:no_caching' | 'degraded:no_parallel' | 'unusable:no_tools' | 'unusable:no_subagent_loop' | 'unknown';
  try {
    // Synchronous-style import via require shim isn't available in ESM; the
    // helper is pure, so a synchronous static import is fine here. Pulling
    // from capabilities.ts directly:
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cap = require('./ai/capabilities.ts') as typeof import('./ai/capabilities.ts');
    verdict = cap.classifyCapabilities(resolved);
  } catch {
    // If the import fails (e.g. malformed recipe registry during boot), be
    // permissive and just return the resolved model — surface the underlying
    // issue at gateway call time.
    return resolved;
  }

  const key = `${source}:${resolved}`;
  if (verdict === 'unusable:no_tools' || verdict === 'unusable:no_subagent_loop' || verdict === 'unknown') {
    if (!_subagentTierWarningsEmitted.has(key)) {
      _subagentTierWarningsEmitted.add(key);
      const reason = verdict === 'unusable:no_tools'
        ? `lacks tool-calling support`
        : verdict === 'unusable:no_subagent_loop'
          ? `declares the subagent loop unsupported (supports_subagent_loop: false)`
          : `is an unrecognized provider`;
      process.stderr.write(
        `[models] tier.subagent resolved to "${resolved}" via "${source}", which ${reason}. ` +
        `The subagent tool loop cannot run on this model — falling back to ${TIER_DEFAULTS.subagent}. ` +
        `Fix: gbrain config set models.tier.subagent <provider>:<model> ` +
        `(the provider's recipe must declare supports_subagent_loop: true)\n`,
      );
    }
    return TIER_DEFAULTS.subagent;
  }

  if (verdict === 'degraded:no_caching') {
    if (!_subagentTierWarningsEmitted.has(key)) {
      _subagentTierWarningsEmitted.add(key);
      process.stderr.write(
        `[models] tier.subagent resolved to "${resolved}" via "${source}" — provider does not support prompt caching. ` +
        `The loop will run hot (cost scales linearly with conversation length). ` +
        `For lower cost on long loops, set models.tier.subagent to an Anthropic model.\n`,
      );
    }
  }
  // degraded:no_parallel and ok return resolved unchanged (no warn).
  return resolved;
}

/**
 * @deprecated v0.38 — renamed to `enforceSubagentCapable`. The old name and
 * Anthropic-only semantics are preserved as a thin wrapper for any external
 * callers (extensions, plugins) that imported it. New code MUST call
 * `enforceSubagentCapable` instead.
 */
function enforceSubagentAnthropic(resolved: string, tier: ModelTier | undefined, source: string): string {
  return enforceSubagentCapable(resolved, tier, source);
}
// Keep `enforceSubagentAnthropic` available for back-compat consumers that
// imported it. Marked unused-but-needed so the linter doesn't flag it.
void enforceSubagentAnthropic;

/**
 * Resolve a name (possibly an alias) to its full provider model id. Order:
 *   1. User-defined alias via `models.aliases.<name>` config
 *   2. DEFAULT_ALIASES map
 *   3. Pass-through (treat as already-full model id)
 *
 * Cycles in user-defined aliases are broken at depth 2 — if `opus` aliases
 * to `super-opus` which aliases to `opus`, we return `super-opus` and stop.
 */
export async function resolveAlias(
  engine: ConfigReader | null,
  name: string,
  depth = 0,
): Promise<string> {
  if (depth > 2) return name; // cycle break
  if (engine) {
    const userAlias = await engine.getConfig(`models.aliases.${name}`);
    if (userAlias && userAlias.trim() && userAlias.trim() !== name) {
      return await resolveAlias(engine, userAlias.trim(), depth + 1);
    }
  }
  if (name in DEFAULT_ALIASES) {
    // `gpt` tracks the CURRENT OpenAI flagship (discovered from the account,
    // recipe-ranked static floor) instead of a pinned id that goes stale.
    const next = name === 'gpt' ? discoveredOrStaticOpenAITier('deep') : DEFAULT_ALIASES[name];
    if (next && next !== name) return await resolveAlias(engine, next, depth + 1);
  }
  return name;
}

/** Test-only helper: clear the deprecation-warning memo so tests re-emit. */
export function _resetDeprecationWarningsForTest(): void {
  _deprecationWarningsEmitted.clear();
  _subagentTierWarningsEmitted.clear();
  _unservablePinWarningsEmitted.clear();
}
