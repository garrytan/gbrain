/**
 * v0.41.21.0 — single source of truth for model-id parsing (PRICING side).
 *
 * Splits `provider:model`, `provider/model`, and bare `model` strings into
 * a `{provider, model}` pair. Five pricing/budget sites across the codebase
 * used to inline their own ad-hoc split (colon-only); the slash-form miss
 * kept refiring as a bug class (#1540 most recently). One helper kills it.
 *
 * **Name disambiguation:** the gateway-side resolver `src/core/ai/model-resolver.ts`
 * has its own `parseModelId` that throws on bare names (a gateway routing
 * decision needs an explicit provider; pricing can fall through to bare-key
 * pricing-table lookup). To avoid in-project name collision, this helper is
 * named `splitProviderModelId`. Both functions accept the same input shapes
 * after v0.41.21.0; they differ in how they handle bare names (this returns
 * `{provider: null, model: 'bare'}`; the gateway one throws).
 *
 * Separator precedence: `:` wins over `/`. The motivating case is
 * OpenRouter's nested form `openrouter:anthropic/claude-sonnet-4.6` —
 * the canonical transport-vs-vendor split is on the leading colon, so the
 * helper returns `{provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6'}`.
 * Downstream pricing lookups that miss on the slash-bearing tail land in
 * the caller's existing "unknown model" path (warn-once or no_pricing,
 * depending on the caller). We do NOT recursively peel inner provider
 * prefixes — that would conflate transport identity with billing identity
 * (OpenRouter markup ≠ native Anthropic pricing).
 *
 * Defensive contract: null / undefined / empty / whitespace-only input
 * returns `{provider: null, model: ''}` rather than throwing. The TypeScript
 * signature reflects this so callers can pass uncertain input without
 * `as any` casts (env-var-unset paths, optional config fields).
 */

export interface SplitProviderModelId {
  /** Provider prefix when separator present; null for bare or empty input. */
  provider: string | null;
  /** Model tail after the separator; '' for empty input. */
  model: string;
}

const EMPTY: SplitProviderModelId = { provider: null, model: '' };

export function splitProviderModelId(input: string | null | undefined): SplitProviderModelId {
  if (input === null || input === undefined) return EMPTY;
  const trimmed = input.trim();
  if (trimmed.length === 0) return EMPTY;

  const colon = trimmed.indexOf(':');
  if (colon !== -1) {
    return {
      provider: trimmed.slice(0, colon),
      model: trimmed.slice(colon + 1),
    };
  }

  const slash = trimmed.indexOf('/');
  if (slash !== -1) {
    return {
      provider: trimmed.slice(0, slash),
      model: trimmed.slice(slash + 1),
    };
  }

  return { provider: null, model: trimmed };
}

/**
 * v0.41.x (#1698) — canonical `provider:model` normalizer shared by every chat-adapter
 * site that used to inline the colon-only `x.includes(':') ? x : `anthropic:${x}`` check.
 * That inline silently mangled slash form: `anthropic/claude-sonnet-4-6` (no colon) became
 * the malformed `anthropic:anthropic/claude-sonnet-4-6`, which `resolveRecipe` accepted at
 * the provider level and only blew up later inside `gateway.chat()`.
 *
 * Behavior (built on `splitProviderModelId`, so it inherits colon-first precedence):
 *   - `anthropic/claude-sonnet-4-6`        → `anthropic:claude-sonnet-4-6`  (slash → colon)
 *   - `claude-sonnet-4-6`                  → `anthropic:claude-sonnet-4-6`  (bare → default)
 *   - `anthropic:claude-sonnet-4-6`        → unchanged                      (colon identity)
 *   - `openrouter:anthropic/claude-4.6`    → unchanged   (nested: inner slash preserved)
 *   - ''/'   ' (empty/whitespace)          → returned as-is (downstream throws loudly)
 *   - `:claude-sonnet-4-6` / `/claude-...` → returned as-is (malformed leading separator —
 *                                            empty-string provider; downstream throws loudly)
 */
export function normalizeModelId(input: string, defaultProvider = 'anthropic'): string {
  const { provider, model } = splitProviderModelId(input);
  // Return unchanged (so resolveRecipe throws loudly — #1698) when:
  //   - empty/whitespace input (`model === ''`), or
  //   - a malformed leading separator (`:foo` / `/foo`) — splitProviderModelId yields an
  //     EMPTY-STRING provider for those. Without this guard the `provider ?` truthiness
  //     below treats `''` as "no provider" and silently coerces the model to the default
  //     (e.g. `:claude-sonnet-4-6` → `anthropic:claude-sonnet-4-6`), masking a typo as a
  //     valid Anthropic model. A `null` provider (bare name like `claude-opus-4-7`) still
  //     defaults — that's the intended path.
  if (!model || provider === '') return input;
  return provider ? `${provider}:${model}` : `${defaultProvider}:${model}`;
}
