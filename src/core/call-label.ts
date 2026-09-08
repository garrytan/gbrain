/**
 * Ambient "who is calling" label for gateway LLM calls.
 *
 * The gateway's OpenInference spans carry model + provider + token counts, but
 * nothing about WHICH part of gbrain spent those tokens. Without that
 * dimension a Phoenix dashboard can answer "how many tokens did sonnet burn"
 * but not "how many tokens did the dream cycle's synthesize phase burn" —
 * which is the question operators actually ask.
 *
 * Threading a label through every call site would touch hundreds of
 * signatures. Instead a caller wraps a region once:
 *
 *     await withCallLabel('dream.synthesize', () => runPhaseSynthesize(...))
 *
 * and every `gateway.chat / embed / rerank / expand` span created inside that
 * region resolves the label at span-creation time via `getCurrentCallLabel()`.
 * Nested wraps REPLACE the label (innermost wins) — same semantics as the
 * BudgetTracker ALS in `ai/gateway.ts`.
 *
 * This module deliberately imports NOTHING from gbrain. Both `ai/gateway.ts`
 * (deep in the provider stack) and `cycle.ts` (top of the orchestration stack)
 * depend on it; any gbrain import here risks a cycle. Same reason
 * `ai/anthropic-key.ts` lives outside `gateway.ts`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const __callLabelStore = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `label` as the ambient call label. Every gateway span created
 * inside (including in nested async work) reports it.
 *
 * Empty/whitespace labels are ignored — the region runs unlabeled rather than
 * stamping a meaningless attribute onto every span.
 */
export function withCallLabel<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const trimmed = label?.trim();
  if (!trimmed) return fn();
  return __callLabelStore.run(trimmed, fn);
}

/** The active call label, or null outside any `withCallLabel` region. */
export function getCurrentCallLabel(): string | null {
  return __callLabelStore.getStore() ?? null;
}
