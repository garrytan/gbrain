/**
 * Pure reranker readiness — the ONE predicate behind "is the reranker actually
 * running?" for `gbrain search modes`, `gbrain doctor`'s `reranker_health`
 * check, and init's reranker-default write (v0.48.2).
 *
 * Why a leaf: init cannot use the gateway (it runs before `configureGateway`)
 * and must not pull provider SDKs; doctor and the modes dashboard want the
 * same answer the gateway will give at search time. So this module takes the
 * env snapshot from the CALLER (gateway `cfg.env`; doctor/modes
 * `mergedProviderEnv(await loadConfigWithEngine(engine, loadConfig()), process.env)`
 * — the DB-merged plane, because the CLI folds DB-plane provider keys into
 * the gateway too; init `mergedProviderEnv(loadConfigFileOnly(), process.env)`)
 * and never reads `process.env` itself. A `provider_base_urls` override for
 * the provider marks it self-hosted, so a passed sunset does not block. `test/ai/reranker-readiness.test.ts` pins that this
 * predicate and `isAvailable('reranker', model)` agree on an env matrix so
 * the two cannot drift.
 *
 *   configured ──▶ recipe known? ──▶ touchpoint? ──▶ model listed? ──▶ key present?
 *        │             │ no              │ no            │ no             │ no
 *        │             ▼                 ▼               ▼                ▼
 *        │        ready=false       ready=false     ready=false     NO_KEY (fail-open
 *        │        (fix: set a valid provider:model)                  at search time)
 *        └── sunset passed (zeroentropyai:* on/after 2026-09-04) ──▶ SUNSET (short-circuit)
 */

import { getRecipe } from './recipes/index.ts';
import { parseModelId } from './model-resolver.ts';
import { DEFAULT_RERANKER_MODEL, rerankerSunset, sunsetDateHasPassed, type RerankerSunset } from './defaults.ts';

export interface RerankerReadiness {
  /** The provider:model string that was evaluated. */
  model: string;
  /** Provider id as `parseModelId` resolves it (`:` or `/` separator), or '' when unparseable. */
  provider: string;
  /** Canonical model id (recipe alias resolved), or '' when unparseable. */
  modelId: string;
  /** A recipe with this provider id is registered. */
  recipeKnown: boolean;
  /** The recipe declares a reranker touchpoint. */
  hasTouchpoint: boolean;
  /** The model id is on the touchpoint's allowlist (or the list is open). */
  modelListed: boolean;
  /** The env var the recipe needs for auth (first `auth_env.required`), or null. */
  requiredKey: string | null;
  /** Every required key is present in the caller-supplied env. */
  keyPresent: boolean;
  /** Sunset entry when the model family has an announced shutdown, else null. */
  sunset: RerankerSunset | null;
  /** The sunset date is today or in the past. */
  sunsetPassed: boolean;
  /**
   * A base-URL override routes this provider id to a self-hosted
   * wire-compatible endpoint (`provider_base_urls.<provider>` on any config
   * plane) — the hosted shutdown does not apply, exactly as the gateway's
   * short-circuit suppression treats it.
   */
  selfHosted: boolean;
  /** The sunset actually blocks calls: passed AND not self-hosted. */
  sunsetBlocks: boolean;
  /** Everything above is green: a rerank call would actually be issued. */
  ready: boolean;
}

export interface RerankerReadinessOpts {
  /** Clock for the sunset comparison (tests inject a fixed date). */
  now?: Date;
  /** Provider ids with a base-URL override (self-hosted endpoints). */
  baseUrlOverrides?: Record<string, string | undefined> | null;
}

/**
 * Evaluate readiness for `model` against `env`. Pure; never throws;
 * `opts.now` defaults to the wall clock (tests pass a fixed date).
 */
export function rerankerReadiness(
  model: string,
  env: Record<string, string | undefined>,
  opts: RerankerReadinessOpts = {},
): RerankerReadiness {
  const now = opts.now ?? new Date();
  let provider = '';
  let modelId = '';
  try {
    const parsed = parseModelId(model);
    provider = parsed.providerId;
    modelId = parsed.modelId;
  } catch {
    // Unparseable (no `provider:model` shape) — every flag below stays false.
  }
  const recipe = provider ? getRecipe(provider) : undefined;
  const tp = recipe?.touchpoints.reranker;
  const required = recipe?.auth_env?.required ?? [];
  // A recipe with a custom resolveAuth (e.g. Azure Entra) mints its own
  // credential — mirror the gateway: no env key is required from us.
  const needsEnvKey = !!recipe && !recipe.resolveAuth && required.length > 0;
  const keyPresent = !!recipe && (!needsEnvKey || required.every((k) => !!env[k]));
  // Alias canonicalization mirrors resolveRecipe(): a recipe alias key is
  // accepted wherever the gateway accepts it.
  const canonicalModelId = recipe?.aliases?.[modelId] ?? modelId;
  const listed = !!tp && (tp.models.length === 0 || tp.models.includes(canonicalModelId));
  const sunset = rerankerSunset(model);
  const sunsetPassed = !!sunset && sunsetDateHasPassed(sunset.date, now);
  const selfHosted = !!provider && !!opts.baseUrlOverrides?.[provider];
  const sunsetBlocks = sunsetPassed && !selfHosted;
  return {
    model,
    provider,
    modelId: canonicalModelId,
    recipeKnown: !!recipe,
    hasTouchpoint: !!tp,
    modelListed: listed,
    // Name the key that is actually missing (multi-key recipes), else the first.
    requiredKey: needsEnvKey ? (required.find((k) => !env[k]) ?? required[0]!) : null,
    keyPresent,
    sunset,
    sunsetPassed,
    selfHosted,
    sunsetBlocks,
    ready: !!recipe && !!tp && listed && keyPresent && !sunsetBlocks,
  };
}

/**
 * Paste-ready fix for a not-ready reranker, one line, no trailing newline.
 * Returns null when `r.ready` (nothing to fix). Order matters: a dead
 * provider needs a model switch before any key talk.
 */
export function describeRerankerFix(r: RerankerReadiness): string | null {
  if (r.ready) return null;
  if (r.sunsetBlocks && r.sunset) {
    return (
      `${r.model} passed its ${r.sunset.date} provider sunset — switch: ` +
      `gbrain config set search.reranker.model ${r.sunset.replacement}`
    );
  }
  if (!r.recipeKnown || !r.hasTouchpoint || !r.modelListed) {
    return (
      `${r.model} is not a known reranker (provider:model) — set one: ` +
      `gbrain config set search.reranker.model ${DEFAULT_RERANKER_MODEL}`
    );
  }
  if (!r.keyPresent && r.requiredKey) {
    return (
      `${r.requiredKey} not set — export ${r.requiredKey}=… ` +
      `(or turn reranking off: gbrain config set search.reranker.enabled false)`
    );
  }
  return `reranker ${r.model} is not ready`;
}
