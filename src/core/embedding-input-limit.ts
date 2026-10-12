/**
 * #4530 — per-model embedding INPUT token limits.
 *
 * Some hosted encoders enforce a hard cap per single input, far below their
 * batch budget: NVIDIA NIM's `nvidia/nv-embedqa-e5-v5` rejects any input over
 * 512 tokens with a non-transient 400 ("Input length N exceeds maximum
 * allowed token size 512"). The chunker historically calibrated to
 * OpenAI/Voyage-class limits (8K-32K), so on a 512-token model ~35% of chunks
 * in a typical vault could NEVER embed — every sweep re-failed them.
 *
 * This module resolves the effective chunk-token cap for the ACTIVE embedding
 * model so the chunkers split (never truncate) at a size the model accepts:
 *
 *   GBRAIN_MAX_CHUNK_TOKENS env (escape hatch for models not in a recipe)
 *     → recipe per-model `max_input_tokens` × EMBED_INPUT_SAFETY
 *     → DEFAULT_MAX_CHUNK_TOKENS (2000 — unchanged for every other provider)
 *
 * The result is measured in estimateEmbedTokens units (cl100k + CJK-weighted
 * overestimate). EMBED_INPUT_SAFETY covers the mismatch between that estimate
 * and the model's own tokenizer: e5-family models use BERT-style wordpiece,
 * which counts MORE tokens than cl100k on English prose (~1.3-1.5x) and far
 * more on URL/code-dense text. 0.6 × 512 = 307 estimated tokens ≈ 1.2-1.5K
 * chars of prose — consistent with the field-tested 1,100-char safe bound
 * from the issue report. Fail-open: any resolution error returns the default
 * (a resolver bug must never change chunking for unaffected installs).
 */

import { DEFAULT_MAX_CHUNK_TOKENS } from './chunkers/token-estimate.ts';
import { getEmbeddingModel } from './ai/gateway.ts';
import { resolveRecipe } from './ai/model-resolver.ts';
import type { Recipe } from './ai/types.ts';

/** Utilization ceiling applied to a recipe-declared per-input token limit. */
export const EMBED_INPUT_SAFETY = 0.6;

/** Hard floor so a tiny declared limit can't produce confetti chunks. */
const MIN_CHUNK_TOKENS = 64;

/**
 * wave-g: warn once per distinct invalid value, not once per call — the
 * resolver runs per chunkText site, so a typo'd env var would otherwise
 * emit one stderr line per page across a whole backfill. Keyed by value so
 * a CHANGED (still-invalid) value warns again.
 */
let warnedInvalidRaw: string | undefined;

/**
 * Per-model `max_input_tokens` lookup, mirroring model_dims' case-fold rule
 * (#4123): exact match first, then a case-insensitive scan; configured ids
 * arrive cased and recipe tables can carry cased keys.
 */
export function maxInputTokensForModel(recipe: Recipe, modelId: string): number | undefined {
  const table = recipe.touchpoints?.embedding?.max_input_tokens;
  if (!table) return undefined;
  const direct = table[modelId];
  if (typeof direct === 'number' && direct > 0) return direct;
  const folded = modelId.trim().toLowerCase();
  for (const [k, v] of Object.entries(table)) {
    if (k.toLowerCase() === folded && typeof v === 'number' && v > 0) return v;
  }
  return undefined;
}

/**
 * [R13] (PR #5347): chunk caps LEARNED from a provider's single-input
 * over-length rejection for a model that declares no `max_input_tokens`
 * (`src/core/embed-overlength-heal.ts` derives them). Process-lifetime by
 * design, like the embed quarantine: a long-lived sweep splits every later
 * page the same way, a restart re-derives the same cap from the same
 * failure. Keyed by the full `provider:model` string; an operator
 * GBRAIN_MAX_CHUNK_TOKENS and a recipe declaration both win over it.
 */
const _learnedChunkCaps = new Map<string, number>();

export function learnChunkCap(model: string, cap: number): void {
  const current = _learnedChunkCaps.get(model);
  if (current === undefined || cap < current) _learnedChunkCaps.set(model, cap);
}

export function learnedChunkCap(model: string): number | undefined {
  return _learnedChunkCaps.get(model);
}

/** Test seam: forget every learned cap. */
export function _resetLearnedChunkCapsForTest(): void {
  _learnedChunkCaps.clear();
}

/**
 * Effective chunk-token cap for the active embedding model (or `model`). See module doc.
 * Never exceeds DEFAULT_MAX_CHUNK_TOKENS (existing downstream sizing —
 * tsvector limits, context assembly — calibrates to it) and never goes below
 * MIN_CHUNK_TOKENS.
 */
export function resolveMaxChunkTokens(env: Record<string, string | undefined> = process.env, model?: string): number {
  const raw = env.GBRAIN_MAX_CHUNK_TOKENS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(DEFAULT_MAX_CHUNK_TOKENS, Math.max(MIN_CHUNK_TOKENS, Math.floor(n)));
    }
    // Lenient: a typo'd env var must not change chunking silently mid-vault.
    // Once per process per value (wave-g) — not once per chunkText call.
    if (warnedInvalidRaw !== raw) {
      warnedInvalidRaw = raw;
      console.error(
        `[chunker] ignoring invalid GBRAIN_MAX_CHUNK_TOKENS=${JSON.stringify(raw)} — using model/default resolution`,
      );
    }
  }
  try {
    const modelStr = model ?? getEmbeddingModel();
    const { parsed, recipe } = resolveRecipe(modelStr);
    const declared = maxInputTokensForModel(recipe, parsed.modelId);
    if (declared !== undefined) {
      return Math.min(
        DEFAULT_MAX_CHUNK_TOKENS,
        Math.max(MIN_CHUNK_TOKENS, Math.floor(declared * EMBED_INPUT_SAFETY)),
      );
    }
    const learned = _learnedChunkCaps.get(modelStr);
    if (learned !== undefined) return Math.min(DEFAULT_MAX_CHUNK_TOKENS, Math.max(MIN_CHUNK_TOKENS, learned));
  } catch {
    // Gateway not configured (tests, engine-free paths) or unknown provider —
    // keep the historical default.
  }
  return DEFAULT_MAX_CHUNK_TOKENS;
}
