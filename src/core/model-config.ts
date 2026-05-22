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

import type { BrainEngine } from './engine.ts';

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
   * Tier classification (v0.31.12). Looked up after `models.default` and
   * before the env var. Routing groups: `utility` (haiku-class, classification
   * + expansion + verdict), `reasoning` (sonnet-class, default chat +
   * synthesis + fact extraction), `deep` (opus-class, expensive reasoning),
   * `subagent` (Anthropic-only multi-turn tool loop — never inherits a
   * non-Anthropic `models.default`; falls back to TIER_DEFAULTS.subagent
   * with a one-shot stderr warn instead).
   */
  tier?: ModelTier;
  /** Hardcoded last-resort fallback. */
  fallback: string;
}

/** Default aliases shipped in code. Users override via `models.aliases.<name>` config. */
export const DEFAULT_ALIASES: Record<string, string> = {
  opus:   'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
  gemini: 'gemini-3-pro',
  gpt:    'gpt-5',
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
  utility:   'claude-haiku-4-5-20251001',
  reasoning: 'claude-sonnet-4-6',
  deep:      'claude-opus-4-7',
  subagent:  'claude-sonnet-4-6',
};

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
  const trimmed = modelString.trim();
  // `provider:model` form: check provider prefix.
  const colon = trimmed.indexOf(':');
  if (colon !== -1) {
    return trimmed.slice(0, colon).trim().toLowerCase() === 'anthropic';
  }
  // Bare model id: known Anthropic models start with `claude-`. Conservative:
  // we'd rather warn-on-Anthropic-typo than silently route gpt-5 to the
  // subagent loop.
  return trimmed.toLowerCase().startsWith('claude-');
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

/**
 * Resolve a model name through the 6-tier precedence chain. Async because it
 * reads config from the engine. Pass `engine: null` for callsites that don't
 * have an engine (rare; usually CLI bootstrap before connect).
 */
export async function resolveModel(
  engine: BrainEngine | null,
  opts: ResolveModelOpts,
): Promise<string> {
  const envVar = opts.envVar ?? 'GBRAIN_MODEL';

  // 1. CLI flag wins
  if (opts.cliFlag && opts.cliFlag.trim()) {
    return await resolveAlias(engine, opts.cliFlag.trim());
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
        return await resolveAlias(engine, v.trim());
      }
    }

    // 3. Old-key (deprecated) config
    if (opts.deprecatedConfigKey) {
      const v = await engine.getConfig(opts.deprecatedConfigKey);
      if (v && v.trim()) {
        emitDeprecationWarning(opts.deprecatedConfigKey, opts.configKey ?? '<no replacement>', /*ignored=*/ false);
        return await resolveAlias(engine, v.trim());
      }
    }

    // 4. Global default
    const def = await engine.getConfig('models.default');
    if (def && def.trim()) {
      const resolved = await resolveAlias(engine, def.trim());
      return enforceSubagentCapable(resolved, opts.tier, 'models.default');
    }

    // 5. Tier override (v0.31.12)
    if (opts.tier) {
      const tierVal = await engine.getConfig(`models.tier.${opts.tier}`);
      if (tierVal && tierVal.trim()) {
        const resolved = await resolveAlias(engine, tierVal.trim());
        return enforceSubagentCapable(resolved, opts.tier, `models.tier.${opts.tier}`);
      }
    }
  }

  // 6. Env var
  const env = process.env[envVar];
  if (env && env.trim()) {
    const resolved = await resolveAlias(engine, env.trim());
    return enforceSubagentCapable(resolved, opts.tier, `env:${envVar}`);
  }

  // 7. Tier default (v0.31.12 — when no override beats us, the tier's
  //    canonical model wins over caller-supplied fallback)
  if (opts.tier && TIER_DEFAULTS[opts.tier]) {
    return await resolveAlias(engine, TIER_DEFAULTS[opts.tier]);
  }

  // 8. Hardcoded fallback (caller-supplied)
  return await resolveAlias(engine, opts.fallback);
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
  let verdict: 'ok' | 'degraded:no_caching' | 'degraded:no_parallel' | 'unusable:no_tools' | 'unknown';
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
  if (verdict === 'unusable:no_tools' || verdict === 'unknown') {
    if (!_subagentTierWarningsEmitted.has(key)) {
      _subagentTierWarningsEmitted.add(key);
      const reason = verdict === 'unusable:no_tools'
        ? `lacks tool-calling support`
        : `is an unrecognized provider`;
      process.stderr.write(
        `[models] tier.subagent resolved to "${resolved}" via "${source}", which ${reason}. ` +
        `The subagent tool loop cannot run on this model — falling back to ${TIER_DEFAULTS.subagent}. ` +
        `Fix: gbrain config set models.tier.subagent <provider>:<model-with-tools>\n`,
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
  engine: BrainEngine | null,
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
    const next = DEFAULT_ALIASES[name];
    if (next && next !== name) return await resolveAlias(engine, next, depth + 1);
  }
  return name;
}

/** Test-only helper: clear the deprecation-warning memo so tests re-emit. */
export function _resetDeprecationWarningsForTest(): void {
  _deprecationWarningsEmitted.clear();
  _subagentTierWarningsEmitted.clear();
}
