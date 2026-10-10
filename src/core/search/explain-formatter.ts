/**
 * v0.40.4.0 — `gbrain search --explain` per-stage attribution formatter.
 *
 * Renders a SearchResult[] as a multi-line per-result breakdown of how
 * the final score was formed. Reads the boost_* / base_score / *_hits
 * fields populated by every boost stage (T6 stamp + T4 graph signals).
 *
 * Output shape per result:
 *
 *   1. people/alice-example (score=12.4)
 *      base=10.2 (rrf+cosine)
 *      + backlink ×1.08 (12 inbound)            ← when backlink_boost > 1
 *      + salience ×1.05 (mattering)             ← when salience_boost > 1
 *      + recency  ×1.00 (no decay applied)      ← when recency_boost > 1
 *      + exact-match ×1.50                      ← when exact_match_boost > 1
 *      + adjacency ×1.05 (hits=3)               ← when graph_adjacency_boost set
 *      + cross_source ×1.10 (other_sources=2)   ← when graph_cross_source_boost set
 *      - session_demote ×0.95 (prefix=chat/x)   ← when session_demote_factor set
 *      ↑ reranker rank +2 (head improved)       ← when reranker_delta > 0
 *      ↓ reranker rank -1 (head moved down)     ← when reranker_delta < 0
 *      = final 12.4
 *
 * Empty path: when no stage stamped anything, prints
 *   "no boosts applied" + "= final {score}".
 *
 * JSON envelope: the same SearchResult fields are surfaced verbatim in
 * the existing `--json` output (operations layer JSON.stringify); no
 * separate JSON formatter needed.
 */

import type { SearchResult, HybridSearchMeta } from '../types.ts';
import type { DeliveryMeta } from './evidence-delivery.ts';
import type { AutocutDecision } from './autocut.ts';

/**
 * Format a single result with per-stage attribution. Returns a string
 * (multi-line, no trailing newline; caller joins with '\n' if rendering
 * many).
 */
export function formatResultExplain(
  result: SearchResult,
  rank: number,  // 1-based for human display
): string {
  const lines: string[] = [];
  lines.push(`${rank}. ${result.slug} (score=${fmt(result.score)})`);

  // base_score is the pre-boost RRF+cosine result. When undefined
  // (result wasn't routed through runPostFusionStages), fall back to
  // final score and label "no boosts applied" downstream.
  const base = result.base_score ?? result.score;
  // Which retrieval arm instances found this row, at what rank, and their
  // RRF contribution (page votes on the lead chunk, own votes otherwise).
  if (result.rrf && result.rrf.arms.length > 0) {
    const found = result.rrf.arms.map(v => `${v.arm} #${v.rank + 1} (+${fmt(v.contribution)})`).join(', ');
    lines.push(`   found by: ${found}`);
  }
  lines.push(`   base=${fmt(base)} (rrf+cosine)`);
  // v0.46.15: raw query↔chunk cosine (the calibrated semantic signal evidence
  // keys off). Absent on keyword-only / no-embedding paths.
  if (typeof result.cosine === 'number') {
    lines.push(`   cosine=${fmt(result.cosine)} (raw query↔chunk similarity)`);
  }

  let anyBoost = false;

  if (result.backlink_boost !== undefined && result.backlink_boost !== 1.0) {
    anyBoost = true;
    const inbound = result.backlink_count !== undefined ? ` (${result.backlink_count} inbound)` : '';
    lines.push(`   + backlink ×${fmt(result.backlink_boost)}${inbound}`);
  }
  if (result.salience_boost !== undefined && result.salience_boost !== 1.0) {
    anyBoost = true;
    lines.push(`   + salience ×${fmt(result.salience_boost)}`);
  }
  if (result.recency_boost !== undefined && result.recency_boost !== 1.0) {
    anyBoost = true;
    lines.push(`   + recency  ×${fmt(result.recency_boost)}`);
  }
  if (result.exact_match_boost !== undefined && result.exact_match_boost !== 1.0) {
    anyBoost = true;
    lines.push(`   + exact-match ×${fmt(result.exact_match_boost)}`);
  }
  if (result.graph_adjacency_boost !== undefined) {
    anyBoost = true;
    const hits = result.graph_adjacency_hits ?? '?';
    lines.push(`   + adjacency ×${fmt(result.graph_adjacency_boost)} (hits=${hits})`);
  }
  if (result.graph_cross_source_boost !== undefined) {
    anyBoost = true;
    const cs = result.graph_cross_source_hits ?? '?';
    lines.push(`   + cross_source ×${fmt(result.graph_cross_source_boost)} (other_sources=${cs})`);
  }
  if (result.session_demote_factor !== undefined) {
    anyBoost = true;
    const prefix = result.graph_session_prefix ?? '?';
    lines.push(`   - session_demote ×${fmt(result.session_demote_factor)} (prefix=${prefix})`);
  }
  if (result.feedback_boost !== undefined && result.feedback_boost !== 1.0) {
    anyBoost = true;
    lines.push(`   + feedback ×${fmt(result.feedback_boost)} (use-attributed ratings)`);
  }
  if (result.reranker_delta !== undefined && result.reranker_delta !== 0) {
    anyBoost = true;
    const arrow = result.reranker_delta > 0 ? '↑' : '↓';
    lines.push(`   ${arrow} reranker rank ${result.reranker_delta > 0 ? '+' : ''}${result.reranker_delta}`);
  }
  // v0.42.3.0 — show the cross-encoder rerank score (the signal autocut cuts
  // on). Surfacing it per result makes the autocut cliff legible: every kept
  // result sits at or above the cut threshold.
  if (result.rerank_score !== undefined) {
    anyBoost = true;
    lines.push(`   • rerank score=${fmt(result.rerank_score)}`);
  }

  if (!anyBoost) {
    lines.push(`   no boosts applied`);
  }

  lines.push(`   = final ${fmt(result.score)}`);
  // Evidence delivery: the unit this result was delivered as, and under auto why.
  const d = result.delivered;
  if (d) {
    const why = [d.reason, d.fallback_reason ? `fallback ${d.fallback_reason}` : null].filter(Boolean).join(', ');
    lines.push(`   evidence: ${d.unit}${why ? ` (${why})` : ''}${d.truncated ? ', truncated' : ''}`);
  }
  return lines.join('\n');
}

/**
 * v0.42.3.0 — one-line autocut summary for `--explain`. Returns null when
 * autocut didn't run (no decision in meta) so callers can omit it cleanly.
 */
export function formatAutocutSummary(decision: AutocutDecision | undefined): string | null {
  if (!decision) return null;
  if (!decision.applied) {
    return `autocut: no cut (signal=${decision.signal}, gap=${fmt(decision.gapRatio)} < threshold) — full ${decision.total} returned`;
  }
  return `autocut: cut at the rerank cliff (gap=${fmt(decision.gapRatio)}) — kept ${decision.kept}/${decision.total}`;
}

/**
 * v0.48.2 — one-line degraded summary for `--explain` (null when the run was
 * clean). Reads the closed `degraded[]` vocabulary, e.g.
 * `degraded: reranker_skipped (no_key)` — the only place a silently skipped
 * reranker is visible from the CLI.
 */
export function formatDegradedSummary(degraded: HybridSearchMeta['degraded'] | undefined): string | null {
  if (!degraded || degraded.length === 0) return null;
  return `degraded: ${degraded.map((d) => (d.reason ? `${d.stage} (${d.reason})` : d.stage)).join(', ')}`;
}

/**
 * W3 — one-line rerank gate summary for `--explain` (null when the gate is
 * off, so gate-off explain output is byte-identical).
 */
export function formatRerankGateSummary(gate: HybridSearchMeta['rerank_gate'] | undefined): string | null {
  if (!gate) return null;
  if (!gate.eligible) return `rerank gate (${gate.mode}): not graded (${gate.ineligible_reason})`;
  const signal = [
    gate.top_cosine !== undefined ? `cosine ${fmt(gate.top_cosine)}` : null,
    gate.gap !== undefined ? `gap ${fmt(gate.gap)}` : null,
    `${gate.candidates} candidates`,
  ].filter(Boolean).join(', ');
  const verdict = gate.would_skip ? 'would skip' : gate.skip_blocked ? `would rerank (${gate.skip_blocked})` : 'would rerank';
  return `rerank gate (${gate.mode}): ${gate.grade} ${gate.reason} — ${verdict} (${signal})`;
}

/** One-line evidence-delivery summary for `--explain` (null when the stage did not run). */
export function formatDeliverySummary(delivery: DeliveryMeta | undefined): string | null {
  if (!delivery) return null;
  const fallbacks = delivery.fallbacks.length > 0 ? `; fallbacks: ${delivery.fallbacks.join(', ')}` : '';
  const dropped = delivery.dropped > 0 ? `; dropped ${delivery.dropped} (${Object.entries(delivery.dropped_reasons).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  return `evidence: ${delivery.applied_unit} — ${delivery.blocks} blocks, ${delivery.budget_used}/${delivery.budget_tokens} tokens (${delivery.tokenizer})${dropped}${fallbacks}`;
}

/**
 * System One: one line per slot that ran in shadow or on (null when none did,
 * so all-off explain output is byte-identical).
 */
export function formatDecideSummary(decide: HybridSearchMeta['decide'] | undefined): string | null {
  if (!decide) return null;
  const lines = Object.entries(decide).filter(([, m]) => m).map(([slot, m]) => {
    const mode = m!.effective === m!.mode ? m!.mode : `${m!.mode} (inactive: ${m!.skipped ?? 'unknown'})`;
    const who = m!.provider ? ` — ${m!.provider}${m!.model_resolved ? ` (resolved ${m!.model_resolved})` : ''}` : '';
    const parts: string[] = [];
    if (m!.answer) parts.push(m!.answer);
    if (m!.judged !== undefined) parts.push(`judged ${m!.judged}`);
    if (m!.threshold !== undefined) parts.push(`threshold ${fmt(m!.threshold)}`);
    if (m!.outcomes) parts.push(Object.entries(m!.outcomes).map(([o, n]) => `${o} ${n}`).join(', '));
    if (m!.agreement) parts.push(`top-1 ${m!.agreement.top1 ? 'agrees' : 'differs'}, tau ${fmt(m!.agreement.kendall_tau)}`);
    if (m!.skipped && m!.effective === m!.mode) parts.push(`skipped: ${m!.skipped}`);
    return `decide ${slot}: ${mode}${who}${parts.length ? `; ${parts.join('; ')}` : ''}`;
  });
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Format a full result list. Caller passes the SearchResult[] directly;
 * the formatter handles enumeration. Returns a single string (multi-line
 * with trailing newline so callers can `process.stdout.write(out)`).
 */
export function formatResultsExplain(
  results: SearchResult[],
  meta?: HybridSearchMeta & { delivery?: DeliveryMeta },
): string {
  if (results.length === 0) return 'No results.\n';
  const body = results.map((r, i) => formatResultExplain(r, i + 1)).join('\n\n') + '\n';
  // v0.42.3.0 — prepend the autocut summary when meta carries a decision;
  // v0.48.2 — and the degraded summary when any stage was skipped.
  const head = [formatAutocutSummary(meta?.autocut), formatDegradedSummary(meta?.degraded), formatRerankGateSummary(meta?.rerank_gate), formatDeliverySummary(meta?.delivery), formatDecideSummary(meta?.decide)]
    .filter((l): l is string => l !== null);
  return head.length > 0 ? `${head.join('\n')}\n\n${body}` : body;
}

/** A ranking stage's state in score_details: it ran, was skipped (with why), or never ran on this path. */
export type StageState<T> = ({ state: 'applied' } & T) | { state: 'skipped' | 'not_run'; reason: string };

/** Stable per-result score breakdown returned by `search`/`query` with `explain: true`. */
export interface ScoreDetails {
  /** The row's final score. */
  final: number;
  /** Arm-instance votes; `rank` is 1-based for display, `fusion_rank` the 0-based rank RRF used. */
  arms: Array<{ arm: string; rank: number; fusion_rank: number; k: number; weight: number; contribution: number; vote: 'page' | 'chunk'; chunk_id?: number }>;
  rrf: StageState<{ raw: number; normalized: number; compiled_truth_boost: number }>;
  blend: StageState<{ rrf_weight: number; norm_rrf: number; cosine_weight: number; cosine: number }>;
  /** Score entering the post-fusion boost stages. */
  base_score: number | null;
  /** Multiplicative factors applied after fusion, by stage (only stages that changed this row). */
  boosts: Record<string, { factor: number } & Record<string, unknown>>;
  rerank: StageState<{ score: number; delta: number | null; pinned: boolean }>;
}

/**
 * Pure projection of the stamps every ranking stage leaves on a row into one
 * stable object. Absent stamps become `not_run`/`skipped` states rather than
 * invented values, so the breakdown never claims a stage it did not observe.
 */
export function buildScoreDetails(result: SearchResult): ScoreDetails {
  const arms = (result.rrf?.arms ?? []).map(v => ({
    arm: v.arm, rank: v.rank + 1, fusion_rank: v.rank, k: v.k, weight: v.weight,
    contribution: v.contribution, vote: v.vote, ...(v.chunk_id !== undefined ? { chunk_id: v.chunk_id } : {}),
  }));
  const rrf: ScoreDetails['rrf'] = result.rrf
    ? { state: 'applied', raw: result.rrf.raw, normalized: result.rrf.normalized, compiled_truth_boost: result.rrf.compiled_truth_boost }
    : { state: 'not_run', reason: 'single_arm_path' };
  const blend: ScoreDetails['blend'] = result.blend_norm_rrf !== undefined && typeof result.cosine === 'number'
    ? { state: 'applied', rrf_weight: 0.7, norm_rrf: result.blend_norm_rrf, cosine_weight: 0.3, cosine: result.cosine }
    : { state: 'not_run', reason: 'no_query_embedding' };
  const boosts: ScoreDetails['boosts'] = {};
  const add = (name: string, factor: number | undefined, detail: Record<string, unknown> = {}) => {
    if (factor === undefined || factor === 1) return;
    const clean = Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined));
    boosts[name] = { factor, ...clean };
  };
  add('backlink', result.backlink_boost, { inbound: result.backlink_count });
  add('salience', result.salience_boost);
  add('recency', result.recency_boost);
  add('chronicle', result.chronicle_boost);
  add('title', result.title_match_boost);
  add('adjacency', result.graph_adjacency_boost, { hits: result.graph_adjacency_hits });
  add('cross_source', result.graph_cross_source_boost, { other_sources: result.graph_cross_source_hits });
  add('session_demote', result.session_demote_factor, { prefix: result.graph_session_prefix });
  add('alias_resolved', result.alias_resolved_boost);
  add('supersede', result.supersede_penalty, { superseded_by: result.superseded_by });
  add('exact_match', result.exact_match_boost);
  const rerank: ScoreDetails['rerank'] = result.rerank_score !== undefined
    ? { state: 'applied', score: result.rerank_score, delta: result.reranker_delta ?? null, pinned: result.relational_pinned === true }
    : { state: 'not_run', reason: 'reranker_off_or_outside_head' };
  return { final: result.score, arms, rrf, blend, base_score: result.base_score ?? null, boosts, rerank };
}

/**
 * Compact number formatter. Drops trailing zeros for readability; 4
 * decimal places of precision is plenty for ranking scores (RRF lands
 * in the 0.01-0.05 band; backlink/salience boosts in the 1.0-1.6 band).
 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // 4 decimals, then trim trailing zeros and an optional trailing dot.
  return n.toFixed(4).replace(/\.?0+$/, '');
}
