/**
 * capture.ts — the `--capture-pool` receipt fields the LongMemEval harness
 * stamps on a row (plan D24): the post-rerank pool `hybridSearch` hands to
 * `applyAutocut`, and the exact kept set when autocut recorded a decision.
 * Peeled from src/commands/eval-longmemeval.ts (module-size ratchet).
 *
 * INVARIANT: the captured pool mirrors hybrid.ts's autocut inputs field for
 * field — unscored alias-hop / exact-lookup rows (no rerank_score; the
 * replay's preserve predicate keeps them as the live cut did) and pinned
 * relational rows (`relational_pinned`, preserved AND excluded from the cliff
 * math) — so `scripts/replay-autocut-floor.ts` can reproduce the live
 * decision byte-for-byte before any other floor is read.
 */

import type { HybridSearchMeta, SearchResult } from '../../core/types.ts';
import { estimateTokens } from '../../core/search/token-budget.ts';
import { rawSessionId, type SlugToRawMap } from './metrics.ts';

/** `slug#chunk_id` — the identity the autocut replay validates kept sets on. */
export function poolKey(r: SearchResult): string {
  return `${r.slug}#${r.chunk_id}`; // exact template the replay (autocut-replay.ts poolKey) compares against
}

export interface CapturedPoolRow {
  slug: string;
  chunk_id: SearchResult['chunk_id'];
  session_id: string;
  /** Pre-rerank RRF position when the hook supplied it (cliff attribution: fusion vs reranking), else the pool position. */
  rrf_rank: number;
  /** 1-based position in the captured pool. */
  pool_rank: number;
  rerank_score?: number;
  alias_hit?: true;
  exact_lookup?: true;
  relational_pinned?: true;
  est_tokens: number;
}

export interface CaptureExtrasInput {
  pool: readonly SearchResult[] | undefined;
  preRerank: readonly SearchResult[] | undefined;
  meta: HybridSearchMeta | undefined;
  results: readonly SearchResult[];
  slugToRaw: SlugToRawMap;
  /** Answer session ids: when present, the row gains `pool_recall` over the fused (pre-rerank) pool. */
  gold?: readonly string[];
}

/** Fused-pool depths `pool_recall` reports (the recall experiment's 30/50/100/300). */
export const POOL_RECALL_DEPTHS = [30, 50, 100, 300] as const;

export interface PoolRecall {
  /** Rows in the fused pool (pre-rerank, post-dedup). */
  fused_pool_size: number;
  /** 1-based rank of each answer session's first chunk in the fused pool; null when absent. */
  gold_rank: Record<string, number | null>;
  /** Per depth: answer sessions present in the first `depth` rows, and whether all / any are. */
  at: Record<string, { present: number; all: boolean; any: boolean }>;
}

/** Whether each answer session is present in the fused pool at depths 30/50/100/300. */
export function poolRecall(fused: readonly SearchResult[], gold: readonly string[], slugToRaw: SlugToRawMap): PoolRecall {
  const rank = new Map<string, number>();
  fused.forEach((r, i) => { const sid = rawSessionId(r.slug, slugToRaw); if (!rank.has(sid)) rank.set(sid, i + 1); });
  const goldRank = Object.fromEntries(gold.map((g) => [g, rank.get(g) ?? null]));
  const at = Object.fromEntries(POOL_RECALL_DEPTHS.map((d) => {
    const present = gold.filter((g) => (goldRank[g] ?? Infinity) <= d).length;
    return [String(d), { present, all: present === gold.length, any: present > 0 }];
  }));
  return { fused_pool_size: fused.length, gold_rank: goldRank, at };
}

/**
 * `rerank_pool`: EVERY row of the pool in pool order. `autocut_kept_keys`:
 * only when autocut recorded a decision AND the kept count equals the rows
 * returned — then the returned rows ARE the kept set and the replay validates
 * the cut byte-for-byte (a further limit/budget slice would hide the exact
 * set, so the replay falls back to count/gap-level validation).
 * `pool_recall`: only when answer session ids are passed (a gold-less or
 * abstention row has none).
 */
export function buildCaptureExtras(input: CaptureExtrasInput): { rerank_pool?: CapturedPoolRow[]; autocut_kept_keys?: string[]; pool_recall?: PoolRecall } {
  const { pool, preRerank, meta, results, slugToRaw, gold } = input;
  if (!pool) return {};
  const rrfRank = new Map<string, number>();
  (preRerank ?? []).forEach((r, i) => rrfRank.set(poolKey(r), i + 1));
  const out: { rerank_pool?: CapturedPoolRow[]; autocut_kept_keys?: string[]; pool_recall?: PoolRecall } = {
    rerank_pool: pool.map((r, i) => ({
      slug: r.slug,
      chunk_id: r.chunk_id,
      session_id: rawSessionId(r.slug, slugToRaw),
      rrf_rank: rrfRank.get(poolKey(r)) ?? i + 1,
      pool_rank: i + 1,
      ...(Number.isFinite(r.rerank_score) ? { rerank_score: r.rerank_score as number } : {}),
      ...(r.alias_hit === true ? { alias_hit: true as const } : {}),
      ...(r.exact_lookup !== undefined ? { exact_lookup: true as const } : {}),
      ...(r.relational_pinned === true ? { relational_pinned: true as const } : {}),
      est_tokens: estimateTokens(r.chunk_text),
    })),
  };
  if (meta?.autocut && meta.autocut.kept === results.length) out.autocut_kept_keys = results.map(poolKey);
  if (gold && gold.length > 0) out.pool_recall = poolRecall(preRerank ?? pool, gold, slugToRaw);
  return out;
}
