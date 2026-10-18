/**
 * [R13] (PR #5347) — split a chunk the embedder rejected as too long when the
 * model declares NO per-input cap.
 *
 * `healOversizedPageChunks` splits stored chunks to the active model's cap
 * (`resolveMaxChunkTokens`). With no recipe declaration that cap is the
 * 2000-token default, so a provider whose real limit is lower keeps
 * answering the same 400 ("input length exceeds the context length") on
 * every sweep and the page never embeds. Writing `embed_skip` from a sweep is
 * not an option (it advances the page revision outside the write lock), so
 * the answer is a SPLIT, not a park:
 *
 *   1. recognise a single-input over-length rejection
 *      (`embed-overlength-classify.ts`: 400/413/422 with an over-length
 *      message, or a 5xx/statusless error naming a token or context limit;
 *      batch-level token errors, which the gateway's adaptive shrink owns,
 *      are excluded);
 *   2. derive a deterministic smaller cap: the limit the message names ×
 *      EMBED_INPUT_SAFETY, else half the largest failed text's estimate;
 *   3. learn it for the model for the rest of the process
 *      (`learnChunkCap`), so every later heal and import splits the same way;
 *   4. heal the failing page at once with that cap — the pieces are stale
 *      and embed on the next pass through the ordinary chunk upsert.
 *
 * The descent is finite: MAX_OVERLENGTH_HEAL_ATTEMPTS per page per process,
 * never below MIN_USEFUL_CHUNK_TOKENS, and a model whose cap IS declared
 * (recipe `max_input_tokens` or GBRAIN_MAX_CHUNK_TOKENS) is terminal here
 * because the declaration, not the chunking, is what needs fixing.
 */

import { estimateEmbedTokens } from './chunkers/token-estimate.ts';
import { getEmbeddingModel } from './ai/gateway.ts';
import { isSingleInputOverLengthError, overLengthMessage } from './embed-overlength-classify.ts';
import { resolveRecipe } from './ai/model-resolver.ts';
import {
  EMBED_INPUT_SAFETY,
  learnChunkCap,
  maxInputTokensForModel,
  resolveMaxChunkTokens,
} from './embedding-input-limit.ts';
import { healOversizedPageChunks } from './embed-oversize-heal.ts';
import type { BrainEngine } from './engine.ts';

/** Below this a chunk carries too little context to be worth a vector. */
export const MIN_USEFUL_CHUNK_TOKENS = 128;
/** Halvings a page gets per process before the failure is reported as terminal. */
export const MAX_OVERLENGTH_HEAL_ATTEMPTS = 3;

export type OverLengthHealOutcome =
  | { kind: 'healed'; cap: number; splitCount: number }
  | { kind: 'skipped'; reason: 'not_overlength' | 'unresolved_model' | 'declared_cap' | 'attempts_exhausted' | 'cap_floor' | 'nothing_to_split' | 'heal_failed' };

export { statusFromCause, isSingleInputOverLengthError } from './embed-overlength-classify.ts';

/** The token limit an over-length message names, when it names one. */
export function overLengthLimitFromMessage(msg: string): number | undefined {
  const m =
    msg.match(/(?:token\s+size|context\s+length\s+is|limit\s+of|maximum\s+of|up\s+to)\s+(\d{2,7})/i)
    ?? msg.match(/\[\s*\d+\s*,\s*(\d{2,7})\s*\]/)
    ?? msg.match(/(\d{2,7})\s+tokens?\b(?!\s*\()/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The next chunk cap to try, or null when no useful smaller cap exists: the
 * named limit × EMBED_INPUT_SAFETY when the message names one, else half the
 * largest failed text's estimate. Deterministic for the same error and
 * texts. Null when the result is not below `currentCap` (the rejection is
 * not about our chunk size) or below MIN_USEFUL_CHUNK_TOKENS.
 */
export function deriveOverLengthChunkCap(e: unknown, texts: ReadonlyArray<string>, currentCap: number): number | null {
  const named = overLengthLimitFromMessage(overLengthMessage(e));
  const largest = texts.reduce((max, t) => Math.max(max, estimateEmbedTokens(t)), 0);
  const cap = named !== undefined ? Math.floor(named * EMBED_INPUT_SAFETY) : Math.floor(largest / 2);
  if (cap >= currentCap || cap < MIN_USEFUL_CHUNK_TOKENS) return null;
  return cap;
}

const _attempts = new Map<string, number>();

/** Test seam: forget every page's attempt count. */
export function _resetOverLengthHealForTest(): void {
  _attempts.clear();
}

/**
 * After an embed failure on `slug`: when `err` is a single-input over-length
 * rejection and the active model declares no cap, learn a smaller cap and
 * split the page's chunks to it now. Every other case is `skipped` with the
 * reason, and the page is left exactly as it was.
 */
export async function healPageAfterOverLength(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  err: unknown,
  texts: ReadonlyArray<string>,
  env: Record<string, string | undefined> = process.env,
): Promise<OverLengthHealOutcome> {
  if (!isSingleInputOverLengthError(err)) return { kind: 'skipped', reason: 'not_overlength' };
  let model: string;
  let resolved: ReturnType<typeof resolveRecipe>;
  try {
    model = getEmbeddingModel();
    resolved = resolveRecipe(model);
  } catch {
    return { kind: 'skipped', reason: 'unresolved_model' };
  }
  const { parsed, recipe } = resolved;
  const pinned = env.GBRAIN_MAX_CHUNK_TOKENS;
  if ((pinned !== undefined && pinned.trim() !== '') || maxInputTokensForModel(recipe, parsed.modelId) !== undefined) {
    return { kind: 'skipped', reason: 'declared_cap' };
  }
  const key = `${model}::${sourceId}::${slug}`;
  const attempts = _attempts.get(key) ?? 0;
  if (attempts >= MAX_OVERLENGTH_HEAL_ATTEMPTS) return { kind: 'skipped', reason: 'attempts_exhausted' };
  const cap = deriveOverLengthChunkCap(err, texts, resolveMaxChunkTokens(env, model));
  if (cap === null) return { kind: 'skipped', reason: 'cap_floor' };
  _attempts.set(key, attempts + 1);
  learnChunkCap(model, cap);
  let healed: Awaited<ReturnType<typeof healOversizedPageChunks>>;
  try {
    healed = await healOversizedPageChunks(engine, slug, { sourceId, maxTokens: cap });
  } catch {
    // The page moved or the store refused: the next pass heals at the learned cap.
    return { kind: 'skipped', reason: 'heal_failed' };
  }
  if (!healed.changed) return { kind: 'skipped', reason: 'nothing_to_split' };
  return { kind: 'healed', cap, splitCount: healed.splitCount };
}

/** One operator-facing line for the outcome, or null when there is nothing to say. */
export function describeOverLengthOutcome(outcome: OverLengthHealOutcome, slug: string): string | null {
  if (outcome.kind === 'healed') {
    return `  ${slug}: embedder rejected a chunk as too long; split ${outcome.splitCount} chunk(s) to ${outcome.cap} estimated tokens (learned for ${getEmbeddingModel()} this process). The pieces embed on the next pass.`;
  }
  switch (outcome.reason) {
    case 'not_overlength':
    case 'unresolved_model':
      return null;
    case 'heal_failed':
      return `  ${slug}: embedder rejected a chunk as too long; the split could not be stored this pass and is retried at the learned cap on the next one.`;
    case 'declared_cap':
      return `  ${slug}: embedder rejected a chunk as too long although the model's cap is declared (recipe max_input_tokens or GBRAIN_MAX_CHUNK_TOKENS); lower that declaration — the chunker already splits to it.`;
    case 'attempts_exhausted':
    case 'cap_floor':
      return `  ${slug}: embedder keeps rejecting a chunk as too long and no useful smaller cap is left (${outcome.reason}); set GBRAIN_MAX_CHUNK_TOKENS to the model's real per-input limit or declare max_input_tokens in its recipe, or mark the page embed_skip.`;
    case 'nothing_to_split':
      return `  ${slug}: embedder rejected a chunk as too long but every stored chunk already fits the derived cap; the estimate is under-counting for this model — set GBRAIN_MAX_CHUNK_TOKENS lower.`;
  }
}

/** The embed paths' one-liner: heal when the failure is an over-length rejection and print the outcome. */
export async function healAndReportOverLength(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  err: unknown,
  texts: ReadonlyArray<string>,
  log: (line: string) => void,
): Promise<OverLengthHealOutcome> {
  const outcome = await healPageAfterOverLength(engine, slug, sourceId, err, texts);
  const line = describeOverLengthOutcome(outcome, slug);
  if (line) log(line);
  return outcome;
}
