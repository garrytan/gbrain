/**
 * #6377 the paid tier of the content-repair lane: one metered judgment call
 * per slug-conflict candidate, under the fence repair's caps and ledger.
 *
 * Model: `models.content_repair` when set (an explicit choice always runs,
 * new and unpriced models included), else `models.fence_repair` when set,
 * else the first model of `CONTENT_REPAIR_MEASURED_MODELS` the brain has a
 * provider key for, else the fence repair's measured list the same way, else
 * none (`no_measured_model`: the model tier stays off until the user picks).
 *
 * Spend (Codex #9): the lane is one budget. Every call reserves against the
 * fence repair's daily ledger identity (`FENCE_REPAIR_LEDGER`, so a fences
 * spend earlier today counts) under `fences.repair.max_usd_per_day`, is
 * checked against `fences.repair.max_usd_per_page` and the run's own
 * allowance (`--max-usd`), and uses the same thinking-off control and output
 * ceiling as the fence tier: a short JSON answer plus a reasoning allowance
 * for a model whose reasoning the call cannot switch off, so the estimate
 * reserves what the gateway will send.
 *
 * Memo: the fence repair's attempt store (`fence-repair/attempts.ts`) under
 * its own candidate key (`slug-conflict:<path>`, so it never overwrites a
 * fence attempt of the same file) with a memo of sha256(held bytes),
 * sha256(named page content or `none`), both page ids, the model and
 * `JUDGMENT_PROMPT_VERSION`: a verdict already given for these exact inputs
 * (rejected: `merge_into`, `needs_human`, an unusable answer) is returned at
 * $0 until one of them changes; `llm_unavailable` is transient and does not
 * consume it. A published `remove_slug` changes the bytes, so its memo never
 * matches again.
 *
 * Messages carry reason codes, slugs, hashes and dollar amounts only.
 */
import type { BrainEngine } from '../engine.ts';
import { chat, isThinkingModel, THINKING_MODEL_MAX_OUTPUT_TOKENS, type ChatResult } from '../ai/gateway.ts';
import { thinkingOffControl, thinkingOffMaxOutputTokens } from '../ai/thinking-off.ts';
import { mergedProviderEnv } from '../ai/provider-env.ts';
import { loadConfig, type GBrainConfig } from '../config.ts';
import { providerKeyReady, resolveModel, TIER_DEFAULTS } from '../model-config.ts';
import { chatCallUsd, dailyLedger, estimateChatCallUsd, FENCE_REPAIR_LEDGER, type DailyLedger } from '../budget/daily-ledger.ts';
import type { PricingOverrides } from '../budget/reservation-cost.ts';
import type { NoPricingGuidance } from '../budget/no-pricing.ts';
import type { CapSource } from '../consent.ts';
import { attemptStore, type AttemptClaim, type AttemptStore } from '../fence-repair/attempts.ts';
import { FENCE_REPAIR_MEASURED_MODELS } from '../fence-repair/measured.ts';
import { FENCE_REPAIR_MODEL_KEY } from '../fence-repair/model.ts';
import { TIER3_REASONING_TOKENS } from '../fence-repair/llm.ts';
import { sha256, stableJson } from '../persistence/digest.ts';
import { buildJudgmentPrompt, JUDGMENT_PROMPT_VERSION, parseJudgmentAnswer, type JudgmentFailureReason, type JudgmentInput, type JudgmentVerdict } from './judgment.ts';
import { CONTENT_REPAIR_MEASURED_MODELS } from './measured.ts';

export const CONTENT_REPAIR_MODEL_KEY = 'models.content_repair';
/** Output tokens the JSON answer needs; a reasoning model adds TIER3_REASONING_TOKENS. */
const ANSWER_TOKENS = 256;

export type ContentRepairModelSource = 'config' | 'fence_config' | 'measured';

/** The judgment model and where it came from; `env` replaces the environment and config-file keys (tests). */
export async function resolveContentRepairModelWithSource(engine: Pick<BrainEngine, 'getConfig'>, env?: Record<string, string | undefined>): Promise<{ model: string | null; source: ContentRepairModelSource }> {
  const read = (key: string) => engine.getConfig(key).catch(() => null);
  if ((await read(CONTENT_REPAIR_MODEL_KEY))?.trim()) return { model: await resolveModel(engine, { configKey: CONTENT_REPAIR_MODEL_KEY, tier: 'deep', fallback: TIER_DEFAULTS.deep }), source: 'config' };
  if ((await read(FENCE_REPAIR_MODEL_KEY))?.trim()) return { model: await resolveModel(engine, { configKey: FENCE_REPAIR_MODEL_KEY, tier: 'deep', fallback: TIER_DEFAULTS.deep }), source: 'fence_config' };
  const keys = env ? Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => !!e[1])) : mergedProviderEnv(fileConfig(), process.env);
  const measured = [...CONTENT_REPAIR_MEASURED_MODELS, ...FENCE_REPAIR_MEASURED_MODELS].find(model => providerKeyReady(model, keys)) ?? null;
  return { model: measured, source: 'measured' };
}

export async function resolveContentRepairModel(engine: Pick<BrainEngine, 'getConfig'>, env?: Record<string, string | undefined>): Promise<string | null> {
  return (await resolveContentRepairModelWithSource(engine, env)).model;
}

function fileConfig(): GBrainConfig | null {
  try { return loadConfig(); } catch { return null; }
}

/** The model may reason whatever the call asks: a thinking-by-default model, or a route whose thinking-off option does not turn reasoning fully off. */
function mayReason(model: string): boolean {
  return isThinkingModel(model) || !thinkingOffControl(model)?.disables;
}

/** Token bounds for one call: the prompt's size and the output ceiling the gateway will send. */
export function judgmentTokenBudget(input: JudgmentInput, model: string): { inputTokens: number; maxOutputTokens: number } {
  const chars = buildJudgmentPrompt(input).reduce((sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0), 0);
  const requested = ANSWER_TOKENS + (mayReason(model) ? TIER3_REASONING_TOKENS : 0);
  return { inputTokens: Math.ceil(chars / 3) + 64, maxOutputTokens: thinkingOffMaxOutputTokens(model, requested, isThinkingModel(model), THINKING_MODEL_MAX_OUTPUT_TOKENS) };
}

/** The worst-case estimate of one judgment call (what the preview lists and the ledger reserves). */
export function judgmentEstimate(input: JudgmentInput, pricing: { model: string; overrides?: PricingOverrides; capSource: CapSource }):
  { ok: true; usd: number; estimated: boolean } | { ok: false; reason: 'no_pricing'; guidance: NoPricingGuidance } {
  const budget = judgmentTokenBudget(input, pricing.model);
  const quote = estimateChatCallUsd({ model: pricing.model, inputTokens: budget.inputTokens, maxOutputTokens: budget.maxOutputTokens, overrides: pricing.overrides, capSource: pricing.capSource });
  return quote.ok ? { ok: true, usd: quote.quote.usd, estimated: quote.quote.estimated } : quote;
}

/** The memo parts of one candidate: everything whose change earns a new call. */
export interface JudgmentMemoParts { heldSha256: string; namedSha256: string | null; heldPageId: number | null; namedPageId: number | null; model: string }

export function judgmentMemoKey(parts: JudgmentMemoParts): string {
  return sha256(stableJson({ held: parts.heldSha256, named: parts.namedSha256 ?? 'none', held_id: parts.heldPageId, named_id: parts.namedPageId, model: parts.model, prompt: String(JUDGMENT_PROMPT_VERSION) }));
}

/** The attempt-store candidate of a held file (its own key space beside the fence repair's `path:` keys). */
export function judgmentCandidate(sourceId: string, incarnation: string, path: string) {
  return { sourceId, incarnation, key: `slug-conflict:${path}` };
}

/** The memo reason a verdict is stored under (the hold carries the same code). */
export function judgmentMemoReason(verdict: JudgmentVerdict): 'remove_slug' | 'merge_recommended' | 'content_repair_needs_human' {
  return verdict.action === 'remove_slug' ? 'remove_slug' : verdict.action === 'merge_into' ? 'merge_recommended' : 'content_repair_needs_human';
}

export type JudgmentAnswer =
  | { ok: true; verdict: JudgmentVerdict; text: string; result: ChatResult }
  | { ok: false; reason: JudgmentFailureReason; text?: string; result?: ChatResult; error?: string };

/** One gateway call (no tools, no fallback model, thinking off where the route allows), classified. */
export async function askJudgment(input: JudgmentInput, opts: { model: string; timeoutMs?: number; signal?: AbortSignal }): Promise<JudgmentAnswer> {
  const [system, ...messages] = buildJudgmentPrompt(input);
  const budget = judgmentTokenBudget(input, opts.model);
  let result: ChatResult;
  try {
    result = await chat({ model: opts.model, system: typeof system!.content === 'string' ? system!.content : '', messages, maxTokens: budget.maxOutputTokens, allowFallback: false,
      thinking: 'off', purpose: 'content_repair', ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.signal ? { abortSignal: opts.signal } : {}) });
  } catch (error) {
    return { ok: false, reason: 'llm_unavailable', error: error instanceof Error ? error.name : 'Error' };
  }
  const parsed = parseJudgmentAnswer(result, { held: input.held.slug, named: input.named?.slug ?? null });
  if (!parsed.ok) return { ok: false, reason: parsed.reason, text: result.text, result };
  return { ok: true, verdict: parsed, text: result.text, result };
}

export interface JudgmentCallOptions {
  /** The candidate (memo identity and attempt claim). */
  sourceId: string; incarnation: string; path: string;
  memo: Omit<JudgmentMemoParts, 'model'>;
  overrides?: PricingOverrides;
  capSource: CapSource;
  perPageUsd: number;
  perDayUsd: number;
  /** What is left of the run's own paid-model allowance (`--max-usd`); undefined = none. */
  allowanceUsd?: number;
  timeoutMs: number;
  now?: () => Date;
  /** Injectable for tests; default the fence repair's ledger identity and attempt store on `engine`. */
  ledger?: DailyLedger;
  store?: AttemptStore;
}

export type JudgmentOutcome =
  /** The model answered; the claim is `settled` and the caller publishes it (after a write) or rejects it (a verdict that writes nothing). */
  | { ok: true; verdict: JudgmentVerdict; spentUsd: number; claim: AttemptClaim }
  | { ok: false; reason: JudgmentFailureReason | 'budget_exhausted' | 'ledger_unavailable' | 'no_pricing' | 'claimed_elsewhere' | string; spentUsd: number; message: string;
    /** The whole run should stop (the daily ledger or the run allowance refused the call). */
    stop?: boolean; resetsAt?: string;
    /** The stored verdict of an earlier call on these exact inputs ($0). */
    memoHit?: boolean; guidance?: NoPricingGuidance };

/**
 * One metered judgment: claim the attempt (a stored verdict for these exact
 * inputs returns at $0), check the per-page cap and the run allowance,
 * reserve on the daily ledger, call, settle the actual cost. On a verdict
 * the claim is left `settled` for the caller; on an unusable answer it is
 * rejected (the memo is consumed); on a provider failure it is transient.
 */
export async function callJudgment(engine: BrainEngine, model: string, input: JudgmentInput, opts: JudgmentCallOptions): Promise<JudgmentOutcome> {
  const now = opts.now ?? (() => new Date());
  const ledger = opts.ledger ?? dailyLedger(engine, FENCE_REPAIR_LEDGER, { now });
  const store = opts.store ?? attemptStore(engine, { now });
  const claimed = await store.claim(judgmentCandidate(opts.sourceId, opts.incarnation, opts.path), judgmentMemoKey({ ...opts.memo, model }));
  if (!claimed.ok) {
    if (claimed.reason === 'claimed_elsewhere') return { ok: false, reason: 'claimed_elsewhere', spentUsd: 0, message: 'Another repair run holds this candidate; it is left to that run.' };
    if (claimed.reason === 'store_unavailable') return { ok: false, reason: 'ledger_unavailable', spentUsd: 0, message: 'The repair attempt store could not be read, so no model call was made.' };
    const reason = claimed.record.reason ?? 'llm_malformed';
    return { ok: false, reason, spentUsd: 0, memoHit: true, message: `The model already judged these exact bytes (${reason}); no new call is made until the file, the named page, the model or the prompt changes.` };
  }
  let claim = claimed.claim;
  const transient = async (reason: string, message: string, extra: Partial<Extract<JudgmentOutcome, { ok: false }>> = {}): Promise<JudgmentOutcome> => {
    await store.transient(claim, reason);
    return { ok: false, reason, spentUsd: 0, message, ...extra };
  };
  const budget = judgmentTokenBudget(input, model);
  const quote = estimateChatCallUsd({ model, inputTokens: budget.inputTokens, maxOutputTokens: budget.maxOutputTokens, overrides: opts.overrides, capSource: opts.capSource });
  if (!quote.ok) return transient('no_pricing', `A spend cap is set but gbrain has no price for ${model}; no call was made.`, { guidance: quote.guidance });
  const estimate = quote.quote.usd;
  if (estimate > opts.perPageUsd + 1e-9) return transient('budget_exhausted', `The estimated model cost ($${estimate.toFixed(4)}) exceeds fences.repair.max_usd_per_page ($${opts.perPageUsd.toFixed(2)}).`);
  if (opts.allowanceUsd !== undefined && estimate > opts.allowanceUsd + 1e-9) {
    return transient('budget_exhausted', `This run's paid-model allowance ($${opts.allowanceUsd.toFixed(4)} left) cannot cover the estimate ($${estimate.toFixed(4)}).`, { stop: true });
  }
  const reserved = await ledger.reserve(estimate, { capUsd: opts.perDayUsd });
  if (!reserved.ok) {
    if (reserved.reason === 'ledger_unavailable') return transient('ledger_unavailable', 'The spend ledger could not be read, so no model call was made; the next run retries.');
    return transient('budget_exhausted', `The daily content-repair budget is spent ($${(reserved.committedUsd + reserved.reservedUsd).toFixed(4)} of $${reserved.capUsd.toFixed(2)} committed or reserved today; `
      + `this call needs $${reserved.estimateUsd.toFixed(4)}). It resets at ${reserved.resetsAt}.`, { stop: true, resetsAt: reserved.resetsAt });
  }
  const moved = await store.dispatched(claim, reserved.reservation.id);
  if (!moved.ok) {
    await ledger.release(reserved.reservation.id);
    if (moved.reason === 'lost_claim') return { ok: false, reason: 'claimed_elsewhere', spentUsd: 0, message: 'Another repair run took over this candidate.' };
    await store.reject(claim, { reason: 'llm_malformed' });
    return { ok: false, reason: 'llm_malformed', spentUsd: 0, message: 'The attempt reached its call limit.' };
  }
  claim = moved.claim;
  if (!await ledger.dispatch(reserved.reservation.id)) {
    await ledger.release(reserved.reservation.id);
    await store.settled(claim).then(r => { if (r.ok) claim = r.claim; });
    return transient('ledger_unavailable', 'The spend ledger refused to dispatch the reservation, so no model call was made.');
  }
  const answer = await askJudgment(input, { model, timeoutMs: opts.timeoutMs });
  const actual = answer.result ? chatCallUsd(model, { inputTokens: answer.result.usage.input_tokens, outputTokens: answer.result.usage.output_tokens }, opts.overrides).usd : estimate;
  const settle = await ledger.settle(reserved.reservation.id, actual);
  const spent = settle.settled ? settle.actualUsd : actual;
  const done = await store.settled(claim);
  if (done.ok) claim = done.claim;
  if (!answer.ok && answer.reason === 'llm_unavailable') {
    await store.transient(claim, 'llm_unavailable');
    return { ok: false, reason: 'llm_unavailable', spentUsd: spent, message: `The judgment model was unavailable (${answer.error ?? 'provider error'}); the next run retries.` };
  }
  if (!answer.ok) {
    await store.reject(claim, { reason: answer.reason });
    return { ok: false, reason: answer.reason, spentUsd: spent, message: answer.reason === 'llm_declined' ? 'The judgment model declined; a person decides.' : `The judgment model's answer was unusable (${answer.reason}).` };
  }
  return { ok: true, verdict: answer.verdict, spentUsd: spent, claim };
}
