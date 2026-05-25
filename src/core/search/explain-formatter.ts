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

import type { SearchResult } from '../types.ts';

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
  lines.push(`   base=${fmt(base)} (rrf+cosine)`);

  let anyBoost = false;

  if (result.backlink_boost !== undefined && result.backlink_boost !== 1.0) {
    anyBoost = true;
    lines.push(`   + backlink ×${fmt(result.backlink_boost)}`);
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
  if (result.reranker_delta !== undefined && result.reranker_delta !== 0) {
    anyBoost = true;
    const arrow = result.reranker_delta > 0 ? '↑' : '↓';
    lines.push(`   ${arrow} reranker rank ${result.reranker_delta > 0 ? '+' : ''}${result.reranker_delta}`);
  }

  if (!anyBoost) {
    lines.push(`   no boosts applied`);
  }

  lines.push(`   = final ${fmt(result.score)}`);
  return lines.join('\n');
}

/**
 * Format a full result list. Caller passes the SearchResult[] directly;
 * the formatter handles enumeration. Returns a single string (multi-line
 * with trailing newline so callers can `process.stdout.write(out)`).
 */
export function formatResultsExplain(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.\n';
  return results.map((r, i) => formatResultExplain(r, i + 1)).join('\n\n') + '\n';
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
