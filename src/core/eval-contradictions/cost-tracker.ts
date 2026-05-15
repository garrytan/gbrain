/**
 * eval-contradictions/cost-tracker — A2 + P3 cumulative cost accounting.
 *
 * Per the v0.32.6 plan: --budget-usd is a soft ceiling enforced two ways:
 *   1. Pre-flight estimate. Refuses to start (exit 1) without --yes if the
 *      conservative upper bound exceeds the cap.
 *   2. Mid-run cumulative tracker. After every judge call, if the running
 *      total exceeds the cap, the orchestrator stops with a partial report.
 *
 * Codex correctly flagged that "hard ceiling" is overclaimed since token
 * estimates are approximate until the provider returns actual usage. The
 * tracker uses actual post-call accounting from the gateway response; the
 * pre-flight estimate is a function of declared per-call budgets and pair
 * counts. Both are documented in the output via `cost_usd.estimate_note`.
 *
 * Codex finding P3: include embedding cost so the budget cap is honest. The
 * probe pays a tiny per-query embedding fee on --query and --queries-file
 * paths (eval_candidates rows from --from-capture are pre-embedded). Tiny
 * in absolute dollars but the contract matters.
 */

import type { CostBreakdown } from './types.ts';

/**
 * Per-million-token prices (USD). Update when models bump. These are
 * approximate — provider accounting after the call is authoritative.
 */
const ANTHROPIC_PRICING: Record<string, { input: number; output: number }> = {
  // Haiku 4.5: ~$1/Mtok in, $5/Mtok out (current as of 2026-05).
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'anthropic:claude-haiku-4-5': { input: 1.0, output: 5.0 },
  // Sonnet 4.6: ~$3/Mtok in, $15/Mtok out.
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'anthropic:claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  // Opus 4.7: ~$5/Mtok in, $25/Mtok out.
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'anthropic:claude-opus-4-7': { input: 5.0, output: 25.0 },
};

/** OpenAI text-embedding-3-large: ~$0.13/Mtok (current as of 2026-05). */
const OPENAI_EMBEDDING_PRICE_PER_MTOK = 0.13;

/** Default per-call token budget for the judge. ~500 in, ~80 out. Tunable. */
const DEFAULT_PER_CALL_INPUT_TOKENS = 500;
const DEFAULT_PER_CALL_OUTPUT_TOKENS = 80;

const ESTIMATE_NOTE =
  'approximate; provider accounting is post-call. --budget-usd is a soft ceiling — mid-run stop on cumulative > cap.';

function pricingFor(modelId: string): { input: number; output: number } {
  return ANTHROPIC_PRICING[modelId] ?? ANTHROPIC_PRICING['claude-haiku-4-5'];
}

/**
 * Conservative upper-bound estimate. Used pre-flight to decide whether to
 * refuse without --yes. NEVER use this number as "actual cost" — that's
 * the cumulative tracker's job.
 */
export function estimateUpperBoundCost(opts: {
  pairCount: number;
  queryCount: number;
  judgeModel: string;
  perCallInputTokens?: number;
  perCallOutputTokens?: number;
}): number {
  const judgePricing = pricingFor(opts.judgeModel);
  const inTok = opts.perCallInputTokens ?? DEFAULT_PER_CALL_INPUT_TOKENS;
  const outTok = opts.perCallOutputTokens ?? DEFAULT_PER_CALL_OUTPUT_TOKENS;
  const judgeCost =
    opts.pairCount * ((inTok / 1_000_000) * judgePricing.input + (outTok / 1_000_000) * judgePricing.output);
  // Conservative embedding cost: assume ~50 tokens per query.
  const embedCost = opts.queryCount * (50 / 1_000_000) * OPENAI_EMBEDDING_PRICE_PER_MTOK;
  return judgeCost + embedCost;
}

/** Mutable accumulator. Use for mid-run tracking + final breakdown. */
export class CostTracker {
  private judgeUsd = 0;
  private embeddingUsd = 0;
  private cap: number;

  constructor(opts: { capUsd: number }) {
    this.cap = Math.max(0, opts.capUsd);
  }

  recordJudgeCall(modelId: string, usage: { inputTokens: number; outputTokens: number }): void {
    const p = pricingFor(modelId);
    this.judgeUsd +=
      (usage.inputTokens / 1_000_000) * p.input + (usage.outputTokens / 1_000_000) * p.output;
  }

  recordEmbeddingCall(tokens: number): void {
    this.embeddingUsd += (tokens / 1_000_000) * OPENAI_EMBEDDING_PRICE_PER_MTOK;
  }

  judge(): number { return this.judgeUsd; }
  embedding(): number { return this.embeddingUsd; }
  total(): number { return this.judgeUsd + this.embeddingUsd; }
  capUsd(): number { return this.cap; }

  /** Returns true iff cumulative spend exceeds the configured cap. */
  exceededCap(): boolean {
    return this.total() > this.cap;
  }

  /** Final breakdown for the ProbeReport. */
  finalize(): CostBreakdown {
    return {
      judge: round6(this.judgeUsd),
      embedding: round6(this.embeddingUsd),
      total: round6(this.total()),
      estimate_note: ESTIMATE_NOTE,
    };
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
