/**
 * judge-runner.ts — prompt-agnostic LLM-as-judge call runner (plan D5/D10).
 *
 * Owns everything about a judge call that is NOT dataset-specific: the chat
 * client seam, bounded retries with backoff, the closed `judge_error`
 * vocabulary, usage capture, per-call cost via the ONE canonical pricing
 * table, and a running spend ledger with a soft-stop. The prompt text and
 * the verdict-parsing rule come from the caller (LongMemEval's live in
 * `src/eval/longmemeval/judge.ts`; LoCoMo/BEAM later reuse this file).
 *
 * INVARIANT (D10/D11): a judge malfunction is a `judge_error`, never a
 * `verdict: 'incorrect'`. Timeouts and 429s are retried twice with
 * exponential backoff; when exhausted they land as `timeout` / `rate_limit`.
 * A refusal / content-filter stop, an empty completion, a completion the
 * caller's parser cannot classify (`malformed`), and any other transport
 * failure (`provider_error`) are errors too. The caller decides how the
 * headline scores them (LongMemEval: as incorrect, plan D16) — this module
 * only keeps the two classes apart.
 *
 * INVARIANT: cost is derived from the RETURNED usage through
 * `canonicalLookup` (model-pricing.ts). An unpriced model yields
 * `cost_usd: null`, never 0 — the ledger counts such calls separately so a
 * budget can refuse to run against a model it cannot price.
 */

import type { ChatOpts, ChatResult } from '../../core/ai/gateway.ts';
import { canonicalLookup } from '../../core/model-pricing.ts';

/** The judge chat seam: the gateway's `chat` in production, a canned fn in tests. */
export type JudgeChatFn = (opts: ChatOpts) => Promise<ChatResult>;

export type JudgeVerdict = 'correct' | 'incorrect';

/** Closed vocabulary; pinned by test/longmemeval-judge.test.ts. */
export type JudgeErrorClass = 'timeout' | 'rate_limit' | 'empty' | 'refusal' | 'malformed' | 'provider_error';
export const JUDGE_ERROR_CLASSES: readonly JudgeErrorClass[] = Object.freeze(['timeout', 'rate_limit', 'empty', 'refusal', 'malformed', 'provider_error']);

export interface JudgeUsage {
  input_tokens: number;
  output_tokens: number;
}

interface JudgeOutcomeBase {
  /** Requested `provider:model` id. */
  model: string;
  /** API-returned model snapshot id when the provider reported one (D30). */
  response_model: string | null;
  /** Completion text of the LAST attempt (empty when every attempt threw). */
  raw: string;
  /** Summed over every attempt — retries cost money too. */
  usage: JudgeUsage;
  /** null when the model is unpriced. */
  cost_usd: number | null;
  attempts: number;
}

export type JudgeOutcome =
  | (JudgeOutcomeBase & { kind: 'verdict'; verdict: JudgeVerdict })
  | (JudgeOutcomeBase & { kind: 'error'; judge_error: JudgeErrorClass; detail: string });

export interface RunJudgeOpts {
  client: JudgeChatFn;
  model: string;
  /** The single user message (the official scorers send exactly one). */
  prompt: string;
  system?: string;
  maxTokens: number;
  temperature: number;
  /**
   * Dataset-specific verdict rule over the trimmed, non-empty completion.
   * Return null when the text is neither a yes nor a no → `malformed`.
   */
  parse: (raw: string) => JudgeVerdict | null;
  /** Retries after the first attempt on timeout / rate_limit (default 2). */
  retries?: number;
  /** Base backoff in ms; attempt i sleeps backoffMs * 2^i (default 500). Test seam. */
  backoffMs?: number;
  /** Sleep seam (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function numericStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; cause?: unknown } | null | undefined;
  if (!e || typeof e !== 'object') return undefined;
  for (const k of ['status', 'statusCode'] as const) {
    if (typeof e[k] === 'number') return e[k] as number;
  }
  return e.cause ? numericStatus(e.cause) : undefined;
}

/** Transport-failure classifier: 429 / rate-limit prose → rate_limit; abort / timeout → timeout; else provider_error. */
export function classifyJudgeTransportError(err: unknown): Extract<JudgeErrorClass, 'timeout' | 'rate_limit' | 'provider_error'> {
  const status = numericStatus(err);
  if (status === 429) return 'rate_limit';
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b429\b|rate.?limit|too many requests|overloaded/.test(msg)) return 'rate_limit';
  if (/timeout|timed.?out|etimedout|deadline exceeded|aborted/.test(msg)) return 'timeout';
  return 'provider_error';
}

/** Cost of one call from returned usage; null when the model has no canonical price. */
export function judgeCallCostUsd(model: string, usage: JudgeUsage): number | null {
  const p = canonicalLookup(model);
  if (!p) return null;
  return (usage.input_tokens / 1_000_000) * p.input + (usage.output_tokens / 1_000_000) * p.output;
}

/** Pre-call estimate from token counts; null when unpriced. */
export function estimateJudgeCallUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  return judgeCallCostUsd(model, { input_tokens: inputTokens, output_tokens: outputTokens });
}

export function isJudgeModelPriced(model: string): boolean {
  return canonicalLookup(model) !== undefined;
}

/**
 * Run one judge call with bounded retries. Never throws for a transport
 * failure — every path returns a `JudgeOutcome`. Only the caller's
 * `AbortSignal` (already-aborted) or a bug in `parse` can surface as a throw.
 */
export async function runJudge(opts: RunJudgeOpts): Promise<JudgeOutcome> {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const usage: JudgeUsage = { input_tokens: 0, output_tokens: 0 };
  let attempts = 0;
  let responseModel: string | null = null;
  const base = (raw: string): JudgeOutcomeBase => ({
    model: opts.model,
    response_model: responseModel,
    raw,
    usage: { ...usage },
    cost_usd: judgeCallCostUsd(opts.model, usage),
    attempts,
  });

  for (let attempt = 0; ; attempt++) {
    attempts++;
    let res: ChatResult;
    try {
      res = await opts.client({
        model: opts.model,
        ...(opts.system !== undefined ? { system: opts.system } : {}),
        messages: [{ role: 'user', content: opts.prompt }],
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      });
    } catch (err) {
      const cls = classifyJudgeTransportError(err);
      const retryable = cls === 'timeout' || cls === 'rate_limit';
      if (retryable && attempt < retries && !opts.signal?.aborted) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      return { kind: 'error', judge_error: cls, detail: err instanceof Error ? err.message : String(err), ...base('') };
    }
    usage.input_tokens += res.usage?.input_tokens ?? 0;
    usage.output_tokens += res.usage?.output_tokens ?? 0;
    responseModel = res.responseModel ?? null;
    const raw = typeof res.text === 'string' ? res.text : '';
    if (res.stopReason === 'refusal' || res.stopReason === 'content_filter') {
      return { kind: 'error', judge_error: 'refusal', detail: `stop_reason=${res.stopReason}`, ...base(raw) };
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { kind: 'error', judge_error: 'empty', detail: `empty completion (stop_reason=${res.stopReason})`, ...base(raw) };
    }
    const verdict = opts.parse(trimmed);
    if (verdict === null) {
      return { kind: 'error', judge_error: 'malformed', detail: 'completion is neither a yes nor a no', ...base(raw) };
    }
    return { kind: 'verdict', verdict, ...base(raw) };
  }
}

/**
 * Running spend ledger for one judge lane. `maxUsd === null` means no cap
 * (`--max-usd off`). The soft-stop is PROJECTED: `canAfford(next)` is false
 * once actual + next would exceed the cap, so a run never overshoots by more
 * than the calls already in flight. Unpriced calls are counted, not summed.
 */
export class BudgetLedger {
  actualUsd = 0;
  calls = 0;
  unpricedCalls = 0;
  skipped = 0;

  constructor(readonly maxUsd: number | null, readonly estimateUsd: number | null) {}

  canAfford(nextUsd: number | null): boolean {
    if (this.maxUsd === null) return true;
    return this.actualUsd + (nextUsd ?? 0) <= this.maxUsd;
  }

  record(costUsd: number | null): void {
    this.calls++;
    if (costUsd === null) this.unpricedCalls++;
    else this.actualUsd += costUsd;
  }

  markSkipped(): void {
    this.skipped++;
  }

  get exhausted(): boolean {
    return this.maxUsd !== null && this.actualUsd > this.maxUsd;
  }

  snapshot(): { max_usd: number | null; estimate_usd: number | null; actual_usd: number; calls: number; unpriced_calls: number; skipped: number } {
    return {
      max_usd: this.maxUsd,
      estimate_usd: this.estimateUsd,
      actual_usd: this.actualUsd,
      calls: this.calls,
      unpriced_calls: this.unpricedCalls,
      skipped: this.skipped,
    };
  }
}
