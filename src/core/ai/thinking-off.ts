/**
 * `ChatOpts.thinking: 'off'` (#5331): one provider-agnostic way for a call
 * with a strict output contract and a small `maxTokens` (an eval judge) to
 * opt out of a deployment-wide or model-default thinking mode, without the
 * call site knowing each provider's option shape.
 *
 * Routes with a documented per-call switch get `thinking: { type: 'disabled' }`
 * in their own provider-options namespace, REPLACING any configured thinking
 * object (a merged `{type:'disabled', budgetTokens}` would be forwarded
 * verbatim to an openai-compatible body) while sibling options such as
 * Anthropic `cacheControl` survive:
 *   - native Anthropic (`anthropic`)
 *   - DeepSeek (`deepseek`; thinking is on by default for v4)
 *   - OpenRouter-hosted DeepSeek (`openrouter` with a `deepseek/` model)
 * Every other route is left untouched. When such a route still thinks by
 * default (`isThinkingModel`: Claude 5 behind claude-cli, a local reasoning
 * family, GLM), the call cannot turn thinking off, so its output cap is raised
 * to the thinking-model headroom: reasoning bills against the cap and a
 * judge-sized cap would come back empty.
 */

import { splitProviderModelId } from '../model-id.ts';

const THINKING_OFF_RECIPES: ReadonlySet<string> = new Set(['anthropic', 'deepseek']);

/** The provider-options namespace that carries a per-call thinking switch for this route, or undefined. */
export function thinkingOffNamespace(modelStr: string): string | undefined {
  const { provider, model } = splitProviderModelId(modelStr);
  if (!provider) return undefined;
  if (THINKING_OFF_RECIPES.has(provider)) return provider;
  if (provider === 'openrouter' && model.trim().toLowerCase().startsWith('deepseek/')) return provider;
  return undefined;
}

/** Disable thinking in `providerOptions` for routes that have the switch; returns the same object. */
export function applyThinkingOff(
  providerOptions: Record<string, any>,
  modelStr: string,
): Record<string, any> {
  const namespace = thinkingOffNamespace(modelStr);
  if (!namespace) return providerOptions;
  providerOptions[namespace] = { ...(providerOptions[namespace] ?? {}), thinking: { type: 'disabled' } };
  return providerOptions;
}

/**
 * A call's output cap: the requested cap, unless `thinking: 'off'` was asked
 * of a thinking-by-default model (`offOnThinkingModel`) whose route has no
 * switch, which gets at least `headroom`.
 */
export function thinkingOffMaxOutputTokens(
  modelStr: string,
  requested: number,
  offOnThinkingModel: boolean,
  headroom: number,
): number {
  if (!offOnThinkingModel || thinkingOffNamespace(modelStr)) return requested;
  return Math.max(requested, headroom);
}
