/**
 * model-pricing.ts — single source of truth for paid cloud CHAT/completion
 * model pricing (USD per 1M tokens, input | output).
 *
 * Every chat-pricing site in the codebase derives its numbers from this table:
 *   - anthropic-pricing.ts          (bare-keyed Anthropic view + estimateMaxCostUsd)
 *   - takes-quality-eval/pricing.ts (curated fail-closed allowlist)
 *   - eval-contradictions/cost-tracker.ts (silent-Haiku-fallback view)
 *   - cross-modal-eval/runner.ts    (multi-provider eval panel)
 *   - skillopt/preflight.ts         (Sonnet-fallback warn-only estimate)
 * The bare-keyed `ANTHROPIC_PRICING` view is itself consumed by budget/budget-tracker.ts,
 * minions/batch-projection.ts, and cycle/budget-meter.ts — so those inherit canonical too.
 *
 * The dollar amounts live HERE ONCE — update prices in this file only. Each
 * consumer keeps its own key allowlist and miss-handling policy (fail-closed
 * vs warn-only vs null); this module owns the values, not the policy. Because
 * every other table is DERIVED from this one (not a hand-copied duplicate),
 * cross-table price drift — the kind that left Opus 4.7 at $15/$75 in one table
 * for months — is structurally impossible. test/model-pricing.test.ts pins that:
 * its "drift guard" asserts each derived view still equals canonical (a
 * regression trip-wire if anyone later re-hardcodes a view back into a duplicate)
 * and that the cross-modal panel models are all present in canonical.
 *
 * Prices verified 2026-06-03 against published provider pricing:
 *   - Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview
 *   - OpenAI:    https://openai.com/api/pricing
 *   - Google:    https://ai.google.dev/gemini-api/docs/pricing
 * The dream-budget audit JSONL snapshots the rate per call, so historical
 * estimates stay reproducible even after this table changes.
 *
 * Scope: PAID CLOUD chat models only. Free/local providers (llama-server,
 * zero-cost rerankers) are intentionally absent — callers treat those as
 * zero-cost elsewhere. Embeddings live in embedding-pricing.ts (different unit:
 * per-MTok, char-based).
 */

import { splitProviderModelId } from './model-id.ts';

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/**
 * Canonical price table. Keys are provider-prefixed (`provider:model`),
 * matching the exact id strings consumers pass. One physical model may carry
 * more than one key when a provider ships multiple id spellings (e.g.
 * `google:gemini-2.0-flash` plus the legacy `google:gemini-2-flash` alias) —
 * keep aliases in lockstep; the drift guard asserts they agree.
 */
export const CANONICAL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic ──────────────────────────────────────────────────────────
  // Fable 5: Anthropic's top tier, above Opus. $10 in / $50 out.
  'anthropic:claude-fable-5':             { input: 10.00, output: 50.00 },
  // Opus 4.x: $5 in / $25 out. 4.8 (released 2026-05-28) shares 4.7's
  // per-token rate — closes gbrain#1819.
  'anthropic:claude-opus-4-8':            { input:  5.00, output: 25.00 },
  'anthropic:claude-opus-4-7':            { input:  5.00, output: 25.00 },
  'anthropic:claude-opus-4-6':            { input:  5.00, output: 25.00 },
  // Sonnet 5 (released 2026-06-29): same $3/$15 sticker as 4.6. The launch
  // intro discount ($2/$10 through 2026-08-31) is deliberately NOT modeled —
  // the table carries standard rates so estimates stay conservative and
  // don't need a time-bombed edit when the promo lapses.
  'anthropic:claude-sonnet-5':            { input:  3.00, output: 15.00 },
  'anthropic:claude-sonnet-4-6':          { input:  3.00, output: 15.00 },
  // Haiku 4.5 — both the dateless canonical id and the dated snapshot.
  'anthropic:claude-haiku-4-5':           { input:  1.00, output:  5.00 },
  'anthropic:claude-haiku-4-5-20251001':  { input:  1.00, output:  5.00 },
  'anthropic:claude-3-5-sonnet-20241022': { input:  3.00, output: 15.00 },
  'anthropic:claude-3-5-haiku-20241022':  { input:  0.80, output:  4.00 },

  // ── OpenAI ─────────────────────────────────────────────────────────────
  'openai:gpt-4o':                        { input:  2.50, output: 10.00 },
  'openai:gpt-4o-mini':                   { input:  0.15, output:  0.60 },
  'openai:gpt-5':                         { input:  5.00, output: 20.00 },
  'openai:gpt-5.5':                       { input:  4.00, output: 16.00 },

  // ── Google ─────────────────────────────────────────────────────────────
  'google:gemini-1.5-pro':                { input:  1.25, output:  5.00 },
  // Gemini 2.0 Flash: $0.10 in / $0.40 out (verified 2026-06-03). Reconciled
  // from a stale $0.30/$1.20 entry that had drifted in takes-quality-eval.
  // `gemini-2-flash` kept as an alias for the legacy id spelling.
  'google:gemini-2.0-flash':              { input:  0.10, output:  0.40 },
  'google:gemini-2-flash':                { input:  0.10, output:  0.40 },

  // ── Together / DeepSeek (cross-modal-eval panel) ───────────────────────
  'together:meta-llama/Llama-3.3-70B-Instruct-Turbo': { input: 0.88, output: 0.88 },
  'deepseek:deepseek-chat':               { input:  0.14, output:  0.28 },
};

/**
 * Resolve a model id to its canonical pricing, or `undefined` on miss.
 *
 * Accepts bare (`claude-opus-4-8`), colon (`anthropic:claude-opus-4-8`), and
 * slash (`anthropic/claude-opus-4-8`) forms. Bare ids default to the
 * `anthropic:` provider (matching the historical bare-key Anthropic tables);
 * non-Anthropic bare ids therefore miss, preserving the prior null-return
 * contract for ids like `gpt-5`.
 *
 * Nested OpenRouter ids (`openrouter:anthropic/claude-...`) intentionally MISS:
 * splitProviderModelId yields provider `openrouter`, model
 * `anthropic/claude-...`, and `openrouter:anthropic/claude-...` is not a
 * canonical key. OpenRouter markup ≠ native pricing, so we never reprice it as
 * the inner vendor.
 */
export function canonicalLookup(
  modelId: string | null | undefined,
): ModelPricing | undefined {
  if (!modelId) return undefined;
  // 1. Exact key — colon form, already-canonical ids, and slash-bearing model
  //    tails carried verbatim as keys (e.g. together:.../Llama-3.3-70B-...).
  const direct = CANONICAL_PRICING[modelId];
  if (direct) return direct;
  // 2. Normalize bare/slash via the shared splitter (colon-first precedence).
  const { provider, model } = splitProviderModelId(modelId);
  if (!model) return undefined;
  const key = provider ? `${provider}:${model}` : `anthropic:${model}`;
  return CANONICAL_PRICING[key];
}
