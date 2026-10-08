/**
 * `ChatOpts.thinking: 'off'` (#5331): one provider-agnostic way for a call
 * with a strict output contract and a small `maxTokens` (an eval judge) to
 * opt out of a deployment-wide or model-default thinking mode, without the
 * call site knowing each provider's option shape.
 *
 * `thinkingOffControl` is the per-model capability table: which
 * provider-options namespace carries the per-call option, what to put there,
 * and whether that option turns reasoning fully off or only sets its floor.
 * The runtime (`applyThinkingOff`, `thinkingOffMaxOutputTokens`, both used by
 * `chat()`) and the judge cost estimates (`thinkingOffOutputCap` in
 * gateway.ts) read the same table, so a preflight prices the cap the call
 * sends.
 *
 * Routes whose option turns reasoning off keep the requested cap:
 *   - native Anthropic (`anthropic`) and DeepSeek (`deepseek`; thinking is on
 *     by default for v4): `thinking: { type: 'disabled' }`
 *   - OpenRouter-hosted DeepSeek (`openrouter` with a `deepseek/` model): same
 *   - Gemini 2.5 Flash and Flash-Lite: `thinkingConfig: { thinkingBudget: 0 }`
 *   - OpenAI models that accept `reasoningEffort: 'none'` (gpt-5.1, 5.2, 5.4,
 *     5.5 and the 5.6 family)
 * Routes that cannot turn reasoning off send their floor and get the
 * thinking-model output headroom, because reasoning bills against the cap and
 * a judge-sized cap could come back empty:
 *   - Gemini 2.5 Pro: `thinkingBudget: 128` (never `thinkingLevel`)
 *   - Gemini 3.x: the lowest `thinkingLevel` the model accepts (`minimal` is
 *     a 400 on 3.7/3.8 Flash and 3.x Pro, so those get `low`; never a budget)
 *   - OpenAI gpt-5/-mini/-nano (`minimal`) and the o-series (`low`)
 *   - other Gemini 3+ and OpenAI gpt-5/o-series reasoning ids: no option
 *     (an unsupported level or effort is a 400), headroom only.
 * gpt-6 ids have no row: the pinned @ai-sdk/openai (3.0.58) does not know
 * gpt-6 is a reasoning model and drops `reasoningEffort` with a warning, so
 * no option would arrive, and no live check measured how much a gpt-6 call
 * reasons under a small cap. They keep the requested cap, which fence
 * repair's measured default (`openai:gpt-6.1-sol`) is costed against.
 * The option REPLACES any configured value under the same key: a configured
 * Anthropic `{type:'enabled', budgetTokens}` would otherwise be forwarded
 * verbatim, and a configured Google `thinkingConfig.thinkingLevel` merged
 * with `thinkingBudget` is a 400. Sibling options such as Anthropic
 * `cacheControl` or OpenAI `promptCacheKey` survive. A provider namespace
 * alone is not an off switch: only the native recipes listed here get an
 * option. Every other route is untouched; when it still thinks by default
 * (`isThinkingModel`: Claude 5 behind claude-cli, a local reasoning family,
 * GLM) its cap gets the headroom.
 *
 * Gemini rows follow Google's generateContent thinking docs; OpenAI rows
 * follow the reasoning guide. Both were checked live on 2026-10-07
 * (docs/fix-wave-notes/capy-wave-9-followups.md).
 */

import { splitProviderModelId } from '../model-id.ts';

export interface ThinkingOffControl {
  /** The provider-options namespace and the keys set there; absent when the route has no per-call option. */
  set?: { namespace: string; options: Record<string, unknown> };
  /** True when `set` turns reasoning fully off; false when the model keeps reasoning, so the cap gets headroom. */
  disables: boolean;
}

const THINKING_DISABLED: Record<string, unknown> = { thinking: { type: 'disabled' } };

const GEMINI_ID_RE = /^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)(?:-|$)/;
const GEMINI_NON_CHAT_RE = /-(?:image|tts|audio|live|transcribe|computer-use)(?:-|$)/;
const GEMINI_THINKING_LEVEL_FLOOR: Readonly<Record<string, 'minimal' | 'low'>> = {
  '3-flash': 'minimal',
  '3.5-flash': 'minimal',
  '3.6-flash': 'minimal',
  '3.7-flash': 'low',
  '3.8-flash': 'low',
  '3.1-flash-lite': 'minimal',
  '3.5-flash-lite': 'minimal',
  '3-pro': 'low',
  '3.1-pro': 'low',
};

function googleControl(model: string): ThinkingOffControl | undefined {
  if (GEMINI_NON_CHAT_RE.test(model)) return undefined;
  const m = GEMINI_ID_RE.exec(model);
  if (!m) return /^gemini-(?:flash|flash-lite|pro)-latest$/.test(model) ? { disables: false } : undefined;
  const version = Number.parseFloat(m[1]!);
  const tier = m[2]!;
  if (version < 2.5) return undefined;
  if (version === 2.5) {
    return tier === 'pro'
      ? { set: { namespace: 'google', options: { thinkingConfig: { thinkingBudget: 128 } } }, disables: false }
      : { set: { namespace: 'google', options: { thinkingConfig: { thinkingBudget: 0 } } }, disables: true };
  }
  if (version < 3) return { disables: false };
  const level = GEMINI_THINKING_LEVEL_FLOOR[`${m[1]}-${tier}`];
  return level
    ? { set: { namespace: 'google', options: { thinkingConfig: { thinkingLevel: level } } }, disables: false }
    : { disables: false };
}

const OPENAI_DATE_SUFFIX = '(?:-\\d{4}-\\d{2}-\\d{2})?$';
const OPENAI_EFFORT_NONE_RE = new RegExp(`^gpt-(?:5\\.[1245](?:-mini|-nano)?|5\\.6-(?:luna|sol|terra))${OPENAI_DATE_SUFFIX}`);
const OPENAI_EFFORT_MINIMAL_RE = new RegExp(`^gpt-5(?:-mini|-nano)?${OPENAI_DATE_SUFFIX}`);
const OPENAI_EFFORT_LOW_RE = new RegExp(`^(?:o1|o3|o3-mini|o4-mini)${OPENAI_DATE_SUFFIX}`);
const OPENAI_REASONING_RE = /^(?:gpt-5|o\d)/;
const OPENAI_NON_REASONING_RE = /-chat(?:-|$)/;

function openaiControl(model: string): ThinkingOffControl | undefined {
  const effort = (reasoningEffort: string) => ({ namespace: 'openai', options: { reasoningEffort } });
  if (OPENAI_EFFORT_NONE_RE.test(model)) return { set: effort('none'), disables: true };
  if (OPENAI_EFFORT_MINIMAL_RE.test(model)) return { set: effort('minimal'), disables: false };
  if (OPENAI_EFFORT_LOW_RE.test(model)) return { set: effort('low'), disables: false };
  if (OPENAI_REASONING_RE.test(model) && !OPENAI_NON_REASONING_RE.test(model)) return { disables: false };
  return undefined;
}

/** The thinking-off capability of a route, or undefined when the table has no row for it. */
export function thinkingOffControl(modelStr: string): ThinkingOffControl | undefined {
  const { provider, model: rawModel } = splitProviderModelId(modelStr);
  if (!provider) return undefined;
  const model = rawModel.trim().toLowerCase();
  if (provider === 'anthropic' || provider === 'deepseek') return { set: { namespace: provider, options: THINKING_DISABLED }, disables: true };
  if (provider === 'openrouter') return model.startsWith('deepseek/') ? { set: { namespace: provider, options: THINKING_DISABLED }, disables: true } : undefined;
  if (provider === 'google') return googleControl(model);
  if (provider === 'openai') return openaiControl(model);
  return undefined;
}

/** Set the route's thinking-off option in `providerOptions`; returns the same object. */
export function applyThinkingOff(
  providerOptions: Record<string, any>,
  modelStr: string,
): Record<string, any> {
  const set = thinkingOffControl(modelStr)?.set;
  if (!set) return providerOptions;
  providerOptions[set.namespace] = { ...(providerOptions[set.namespace] ?? {}), ...set.options };
  return providerOptions;
}

/**
 * A `thinking: 'off'` call's output cap: the requested cap where the route's
 * option turns reasoning off, otherwise at least `headroom` for a model that
 * keeps reasoning (a table row without a full off switch, or a route with no
 * row whose model thinks by default, `thinkingByDefault`).
 */
export function thinkingOffMaxOutputTokens(
  modelStr: string,
  requested: number,
  thinkingByDefault: boolean,
  headroom: number,
): number {
  const control = thinkingOffControl(modelStr);
  const keepsReasoning = control ? !control.disables : thinkingByDefault;
  return keepsReasoning ? Math.max(requested, headroom) : requested;
}
