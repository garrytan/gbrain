import { getRecipe } from './recipes/index.ts';
import { parseModelId } from './model-resolver.ts';
import { DEFAULT_RERANKER_MODEL } from './defaults.ts';

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
  selfHosted: boolean;
  /** Everything above is green: a rerank call would actually be issued. */
  ready: boolean;
}

export interface RerankerReadinessOpts {
  /** Provider ids with a base-URL override (self-hosted endpoints). */
  baseUrlOverrides?: Record<string, string | undefined> | null;
}

/**
 * Evaluate readiness for `model` against `env`. Pure; never throws;

 */
export function rerankerReadiness(
  model: string,
  env: Record<string, string | undefined>,
  opts: RerankerReadinessOpts = {},
): RerankerReadiness {
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
  const selfHosted = !!provider && !!opts.baseUrlOverrides?.[provider];
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
    selfHosted,
    ready: !!recipe && !!tp && listed && keyPresent,
  };
}

/**
 * Paste-ready fix for a not-ready reranker, one line, no trailing newline.
 * Returns null when `r.ready` (nothing to fix). Order matters: a dead
 * provider needs a model switch before any key talk.
 */
export function describeRerankerFix(r: RerankerReadiness): string | null {
  if (r.ready) return null;
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
