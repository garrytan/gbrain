/**
 * `chat_fallback_chain` consumer (#5490). `gateway.chat()` delegates here when
 * a chain is configured and the caller did not pin its model with
 * `allowFallback: false`.
 *
 * Attempt order is the call's own model, then each chain entry not already
 * tried. Every attempt is a complete single-model `chat()` call, so budget
 * reservation, the usage ledger, guardrails and error normalization all see
 * the model that actually ran, and `ChatResult.model` names it.
 *
 * The next model runs when an attempt
 *   - throws a provider error: a Claude subscription limit on a claude-cli
 *     model (apiErrorStatus 429), a rate limit, an outage, a timeout, a
 *     rejected key; or
 *   - completes with a structural refusal (`stopReason` 'refusal' or
 *     'content_filter'), the signal `mapStopReason` derives for this purpose.
 * A result a chain entry produced carries `fallbackFrom` (the call's own model),
 * so callers that cache or key on model identity can tell it apart.
 * With `chat_fallback_on_refusal: false` (`onRefusal: false` here) a refusal
 * ends the walk instead: a structural refusal is returned and a provider
 * content block (`providerContentBlockReason`) is thrown, so content one
 * provider refused is never sent to the next one; outages still fall back.
 * The first hop a process takes queues one `chat_fallback_hop` safety notice
 * (`fallback-hop-queue.ts`, drained by MCP dispatch and the CLI).
 * The chain stops on a gbrain policy refusal (an invocation-guard denial or a
 * BudgetTracker `BudgetExhausted`: budget, caps and pricing describe gbrain's
 * own accounting, and the next model is billed by the same ledger)
 * and once the caller's own abort signal has fired, including a cancel that
 * lands while an attempt is refusing (the refusal is returned, not forwarded). When every model fails,
 * a refusal from an earlier attempt is returned in preference to a later
 * attempt's error; otherwise the call's own model's error is thrown, so retry
 * and halt classification (a 429 stays a rate limit) follow the configured
 * model rather than whichever fallback failed last.
 */

import type { ChatOpts, ChatResult } from './gateway.ts';
import type { Notice } from '../agent-output.ts';
import { isAIInvocationPolicyError } from './invocation-guard.ts';
import { providerContentBlockReason } from './errors.ts';
import { BudgetExhausted } from '../budget/budget-tracker.ts';
import { queueFirstFallbackHop } from './fallback-hop-queue.ts';

const HOP_REASON_MAX_CHARS = 200;

/**
 * The configured chain as trimmed model strings. A string value (the env and
 * DB form, also accepted from a hand-edited config.json) is split on commas,
 * so it is never walked one character at a time.
 */
export function normalizeChatFallbackChain(value: unknown): string[] | undefined {
  const entries: unknown[] = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  const chain = entries.map(entry => String(entry).trim()).filter(Boolean);
  return chain.length > 0 ? chain : undefined;
}

/** The primary model followed by each chain entry not already in the list. */
export function chatFallbackAttempts(primary: string, chain: readonly string[]): string[] {
  const attempts = [primary];
  for (const model of chain) {
    if (!attempts.includes(model)) attempts.push(model);
  }
  return attempts;
}

/** The first fallback hop in this process, as one safety notice: which model failed or refused and which one received the request. */
export function chatFallbackHopNotice(failed: string, next: string, cause: string, refusal: boolean): Notice {
  return {
    code: 'chat_fallback_hop',
    kind: 'safety',
    why: `chat_fallback_chain sent a request to another model: ${failed} ${refusal ? `refused it (${cause})` : `failed (${cause})`}, so the request went to ${next}. ` +
      'Every later hop in this process logs to stderr only. ' +
      (refusal
        ? 'Fallback on refusals sends content one provider refused to the next one; `gbrain config set chat_fallback_on_refusal false` keeps outage fallback and stops that.'
        : 'Outage fallback is the configured behavior; `gbrain doctor --only chat_fallback_chain` shows the chain, the providers it reaches and how to remove it.'),
    fix: {
      argv: ['gbrain', 'doctor', '--only', 'chat_fallback_chain', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows the effective chain, the config plane it comes from and per-plane removal guidance; read-only.',
      docs: 'docs/guides/chat-fallback.md',
    },
  };
}

function queueFirstHop(failed: string, next: string, cause: string, refusal: boolean): void {
  queueFirstFallbackHop(() => chatFallbackHopNotice(failed, next, cause, refusal));
}

export interface ChatFallbackOptions {
  /** `chat_fallback_on_refusal` (default true): false ends the walk on a refusal instead of sending the content onward. */
  onRefusal?: boolean;
}

function isStructuralRefusal(result: ChatResult): boolean {
  return result.stopReason === 'refusal' || result.stopReason === 'content_filter';
}

/** First line of an error message, bounded: claude-cli errors carry a raw output blob after it. */
function hopReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n', 1)[0]!.slice(0, HOP_REASON_MAX_CHARS);
}

export async function chatWithFallback(
  opts: ChatOpts,
  primary: string,
  chain: readonly string[],
  attempt: (opts: ChatOpts) => Promise<ChatResult>,
  options: ChatFallbackOptions = {},
): Promise<ChatResult> {
  const onRefusal = options.onRefusal !== false;
  const models = chatFallbackAttempts(primary, chain);
  const answered = (result: ChatResult, model: string): ChatResult =>
    model === models[0] ? result : { ...result, fallbackFrom: models[0] };
  let refused: ChatResult | null = null;
  let primaryError: unknown;
  for (let i = 0; ; i++) {
    const model = models[i]!;
    const next = models[i + 1];
    try {
      const result = await attempt({ ...opts, model, allowFallback: false });
      if (next === undefined || !isStructuralRefusal(result) || !onRefusal || opts.abortSignal?.aborted) return answered(result, model);
      refused ??= answered(result, model);
      console.warn(`[ai.gateway] chat ${result.model} stopped with ${result.stopReason}; trying ${next} from chat_fallback_chain`);
      queueFirstHop(result.model, next, `stopReason ${result.stopReason}`, true);
    } catch (err) {
      if (isAIInvocationPolicyError(err) || err instanceof BudgetExhausted || opts.abortSignal?.aborted) throw err;
      if (model === models[0]) primaryError = err;
      const blocked = providerContentBlockReason(err);
      if (blocked !== undefined && !onRefusal) {
        console.warn(`[ai.gateway] chat ${model} refused the request (${blocked}); chat_fallback_on_refusal is false, so it is not sent to another model`);
        throw primaryError ?? err;
      }
      if (next === undefined) {
        if (refused) {
          console.warn(`[ai.gateway] chat ${model} failed (${hopReason(err)}); returning the earlier refusal from ${refused.model}`);
          return refused;
        }
        if (model !== models[0]) {
          console.warn(`[ai.gateway] chat ${model} failed (${hopReason(err)}); chat_fallback_chain exhausted, surfacing the ${models[0]} error`);
        }
        throw primaryError ?? err;
      }
      console.warn(`[ai.gateway] chat ${model} failed (${hopReason(err)}); trying ${next} from chat_fallback_chain`);
      queueFirstHop(model, next, blocked !== undefined ? `content block ${blocked}` : hopReason(err), blocked !== undefined);
    }
  }
}
