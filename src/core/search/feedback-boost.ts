/**
 * Use-attributed feedback stage: multiply each result's ordering score by
 * m = 1 + λ·2·(w − 0.5), with w the page's learned feedback weight (0.5 when
 * never rated), so m stays within [1 − λ, 1 + λ] and a brain without ratings
 * ranks exactly as before.
 *
 * It runs on the score that actually orders the list: the reranker's score on
 * the reranked head when the reranker ran (a boost before the cross-encoder
 * would be erased), the fused score otherwise. Raw `score` and `rerank_score`
 * are never modified, so autocut and evidence grading read the same values as
 * without feedback. The same read stamps each page's current content_hash for
 * answer recording. Fail-open: any error leaves the list untouched.
 */
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { effectiveInfluence, loadFeedbackSettings } from '../feedback/settings.ts';
import { NEUTRAL_WEIGHT } from '../feedback/store.ts';
import { rethrowCapabilityMissing } from '../rust-engine/errors.ts';

export interface FeedbackStageMeta {
  applied: boolean;
  boosted: number;
  errored: boolean;
}

let stageErrors = 0;

/** Fail-open errors of the stage in this process (shown by `gbrain feedback status`). */
export function feedbackStageErrors(): number {
  return stageErrors;
}

export function feedbackMultiplier(weight: number, influence: number): number {
  return 1 + influence * 2 * (weight - NEUTRAL_WEIGHT);
}

/**
 * Each page's content hash and its learned weight (`readPageFeedbackWeights`, halved toward neutral after an edit),
 * neutral without a weight row.
 */
async function readPageFeedback(
  engine: BrainEngine,
  pageIds: number[],
): Promise<Map<number, { content_hash: string | null; weight: number }>> {
  const rows = await engine.readPageFeedbackWeights(pageIds);
  const out = new Map<number, { content_hash: string | null; weight: number }>();
  for (const r of rows) out.set(r.id, { content_hash: r.content_hash, weight: r.weight ?? NEUTRAL_WEIGHT });
  return out;
}

/**
 * Apply the stage in place and return the (possibly re-sorted) list.
 * `reranked` says whether the reranker reordered this list.
 */
export async function applyFeedbackStage(
  engine: BrainEngine,
  results: SearchResult[],
  opts: { reranked: boolean; onMeta?: (m: FeedbackStageMeta) => void },
): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  let meta: FeedbackStageMeta = { applied: false, boosted: 0, errored: false };
  try {
    const settings = await loadFeedbackSettings(engine);
    if (!settings.enabled) return results;
    const pageIds = [...new Set(results.map(r => r.page_id).filter(id => Number.isFinite(id)))];
    const byPage = await readPageFeedback(engine, pageIds);
    for (const r of results) {
      const row = byPage.get(r.page_id);
      if (row) r.content_hash = row.content_hash;
    }
    const influence = effectiveInfluence(settings);
    if (influence <= 0) return results;
    const scoreOf = (r: SearchResult): number | undefined =>
      opts.reranked ? r.rerank_score : r.score;
    let boosted = 0;
    const keyed = results.map((r, index) => {
      const base = scoreOf(r);
      const weight = byPage.get(r.page_id)?.weight ?? NEUTRAL_WEIGHT;
      if (base === undefined || !Number.isFinite(base) || weight === NEUTRAL_WEIGHT) {
        return { r, index, key: base, scored: base !== undefined && Number.isFinite(base) };
      }
      const m = feedbackMultiplier(weight, influence);
      r.feedback_boost = Math.round(m * 10_000) / 10_000;
      boosted++;
      return { r, index, key: base >= 0 ? base * m : base / m, scored: true };
    });
    meta = { applied: true, boosted, errored: false };
    if (boosted === 0) return results;
    const scored = keyed.filter(k => k.scored);
    const unscored = keyed.filter(k => !k.scored);
    scored.sort((a, b) => (b.key! - a.key!) || (a.index - b.index));
    return [...scored, ...unscored].map(k => k.r);
  } catch (e) {
    // An engine that cannot serve the read refuses: the refusal surfaces, never a quietly unboosted list.
    rethrowCapabilityMissing(e);
    stageErrors++;
    meta = { applied: false, boosted: 0, errored: true };
    return results;
  } finally {
    opts.onMeta?.(meta);
  }
}
