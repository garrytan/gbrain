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
 * Prices verified 2026-07-26 against published provider pricing:
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
  /**
   * #4218 — USD per 1M prompt-cache-READ tokens. Optional: present only for
   * providers whose published cache pricing we've verified (Anthropic:
   * 0.1x input). Consumers that price cache tokens fall back to the input
   * rate when absent (conservative over-estimate for reads).
   */
  cache_read?: number;
  /**
   * #4218 — USD per 1M prompt-cache-WRITE tokens at the default 5-minute
   * TTL (Anthropic: 1.25x input; the 1h TTL bills 2x and is NOT modeled —
   * gbrain's gateway requests the default TTL unless config overrides it,
   * so 5m is the honest best-effort rate). Fall back to input rate when
   * absent (under-estimate for writes; documented, not silent).
   */
  cache_write?: number;
}

/** Anthropic prompt-cache multipliers (verified 2026-08 against published
 * provider pricing): reads bill 0.1x the base input rate; 5-minute-TTL
 * writes bill 1.25x. Exported so the drift guard can assert every
 * anthropic: row's cache fields stay derived from its input rate. */
export const ANTHROPIC_CACHE_READ_MULT = 0.1;
export const ANTHROPIC_CACHE_WRITE_5M_MULT = 1.25;
function anthro(input: number, output: number): ModelPricing {
  return {
    input,
    output,
    cache_read: input * ANTHROPIC_CACHE_READ_MULT,
    cache_write: input * ANTHROPIC_CACHE_WRITE_5M_MULT,
  };
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
  // All Anthropic rows carry derived cache_read/cache_write fields (#4218);
  // see the anthro() helper + multiplier constants above.
  // Fable 5: Anthropic's top tier, above Opus. $10 in / $50 out.
  'anthropic:claude-fable-5':             anthro(10.00, 50.00),
  // Opus 4.x/5: $5 in / $25 out. Opus 5 (new generation) shares the same
  // per-token rate as 4.8 (released 2026-05-28) — closes gbrain#1819.
  'anthropic:claude-opus-5':              anthro( 5.00, 25.00),
  'anthropic:claude-opus-4-8':            anthro( 5.00, 25.00),
  'anthropic:claude-opus-4-7':            anthro( 5.00, 25.00),
  'anthropic:claude-opus-4-6':            anthro( 5.00, 25.00),
  // Sonnet 5 (released 2026-06-29): same $3/$15 sticker as 4.6. The launch
  // intro discount ($2/$10 through 2026-08-31) is deliberately NOT modeled —
  // the table carries standard rates so estimates stay conservative and
  // don't need a time-bombed edit when the promo lapses.
  'anthropic:claude-sonnet-5':            anthro( 3.00, 15.00),
  'anthropic:claude-sonnet-4-6':          anthro( 3.00, 15.00),
  // Haiku 4.5 — both the dateless canonical id and the dated snapshot.
  'anthropic:claude-haiku-4-5':           anthro( 1.00,  5.00),
  'anthropic:claude-haiku-4-5-20251001':  anthro( 1.00,  5.00),
  'anthropic:claude-3-5-sonnet-20241022': anthro( 3.00, 15.00),
  'anthropic:claude-3-5-haiku-20241022':  anthro( 0.80,  4.00),

  // ── OpenAI ─────────────────────────────────────────────────────────────
  'openai:gpt-4o':                        { input:  2.50, output: 10.00 },
  'openai:gpt-4o-mini':                   { input:  0.15, output:  0.60 },
  'openai:gpt-5':                         { input:  5.00, output: 20.00 },
  // gpt-5.2: rates from the OpenAI recipe chat touchpoint (verified
  // 2026-04-20). Needed here because it's the cross-modal DEFAULT_SLOTS
  // slot-A model — without a canonical entry estimateCost silently drops
  // slot A from the --max-usd pre-flight and est_cost_usd audit rows.
  'openai:gpt-5.2':                       { input:  1.25, output: 10.00 },
  'openai:gpt-5.5':                       { input:  4.00, output: 16.00 },
  // gpt-5.6 family (GA 2026-07-09; rates cross-checked 2026-08-17 across
  // aggregator trackers — re-verify against platform.openai.com/pricing at
  // next release). The bare `gpt-5.6` id is OpenAI's rolling alias for the
  // family flagship (sol). These rows are LOAD-BEARING for latest-model
  // discovery (src/core/ai/openai-latest.ts): only priced ids are eligible
  // as defaults, so budget caps never fail closed on a discovered model.
  'openai:gpt-5.6':                       { input:  5.00, output: 30.00 },
  'openai:gpt-5.6-sol':                   { input:  5.00, output: 30.00 },
  'openai:gpt-5.6-terra':                 { input:  2.50, output: 15.00 },
  'openai:gpt-5.6-luna':                  { input:  1.00, output:  6.00 },

  // ── Google ─────────────────────────────────────────────────────────────
  // `gemini-1.5-pro` was retired by Google (#3510); kept so historical
  // usage/audit rows still price. Not a valid default — it's deliberately
  // absent from the google recipe's chat list.
  'google:gemini-1.5-pro':                { input:  1.25, output:  5.00 },
  // Gemini 2.0 Flash: $0.10 in / $0.40 out (verified 2026-06-03). Reconciled
  // from a stale $0.30/$1.20 entry that had drifted in takes-quality-eval.
  // `gemini-2-flash` kept as an alias for the legacy id spelling.
  'google:gemini-2.0-flash':              { input:  0.10, output:  0.40 },
  'google:gemini-2-flash':                { input:  0.10, output:  0.40 },

  // ── Together / DeepSeek (cross-modal-eval panel) ───────────────────────
  'together:meta-llama/Llama-3.3-70B-Instruct-Turbo': { input: 0.88, output: 0.88 },
  // `deepseek-chat` was retired by DeepSeek 2026-07-24 (#1255); kept so
  // historical usage/audit rows still price. New calls use the v4 names.
  'deepseek:deepseek-chat':               { input:  0.14, output:  0.28 },
  // DeepSeek v4 (verified 2026-07-27 at api-docs.deepseek.com): cache-miss rates.
  'deepseek:deepseek-v4-flash':           { input:  0.14, output:  0.28 },
  'deepseek:deepseek-v4-pro':             { input:  0.435, output: 0.87 },
  // ── Z.ai / GLM (via LiteLLM proxy) ───────────────────────────────────
  // GLM-5.2 from Z.ai: $1.40/M input, $4.40/M output (verified 2026-08-16
  // against OpenRouter provider listings — z.ai's own direct rates).
  'litellm:z-ai/glm-5.2':                 { input: 1.40, output: 4.40 },

  // ── OpenRouter (router-prefixed, own catalogue rate) ────────────────────
  // Static entries pulled from OpenRouter's published `/api/v1/models`
  // catalogue (verified 2026-08-17), NOT aliased to the inner vendor's
  // direct rate — a router bills its own spread, and canonicalLookup's
  // nested-id miss (see doc comment below) exists precisely to stop a
  // router-prefixed id from silently matching the vendor's key instead.
  // These are exact-key entries for the router id itself, so that miss
  // path is untouched; only ids listed here resolve, everything else still
  // returns undefined and the caller's no-pricing refusal still applies.
  //
  // Scoped to the three models this fork's OpenRouter fallback tier
  // actually routes through (model-fallback-probe.ts's FALLBACK map) —
  // add more entries here as needed rather than fetching the catalogue
  // live; see PR discussion on gbrain#3848 for why a dynamic fetch/cache
  // didn't merge (default-on network behavior, new pricing-source surface).
  //
  // deepseek/deepseek-v4-flash-0731 matches deepseek:deepseek-v4-flash
  // above to the cent — OpenRouter passing DeepSeek through at vendor
  // rate, not a coincidence worth losing to an alias shortcut.
  'openrouter:deepseek/deepseek-v4-flash-0731': { input: 0.14,  output: 0.28 },
  'openrouter:qwen/qwen3.7-flash':              { input: 0.03,  output: 0.13 },
  'openrouter:qwen/qwen3.6-plus':               { input: 0.325, output: 1.95 },
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
  const normalized = CANONICAL_PRICING[key];
  if (normalized) return normalized;
  // 3. #4123 (TODOS P3 case-sensitivity): case-insensitive fallback, folding
  //    BOTH sides — some canonical keys carry cased model tails verbatim
  //    (Llama-3.3-70B-...), so folding only the probe would miss those. Exact
  //    matches above stay first, so all-lowercase lookups pay nothing new.
  //    Safe only while no two canonical keys collide case-insensitively —
  //    pinned by test/model-pricing.test.ts.
  const folded = canonicalFoldedView();
  return folded[modelId.toLowerCase()] ?? folded[key.toLowerCase()];
}

let _canonicalFoldedView: Record<string, ModelPricing> | null = null;
function canonicalFoldedView(): Record<string, ModelPricing> {
  if (!_canonicalFoldedView) {
    _canonicalFoldedView = {};
    for (const [k, v] of Object.entries(CANONICAL_PRICING)) {
      _canonicalFoldedView[k.toLowerCase()] = v;
    }
  }
  return _canonicalFoldedView;
}
