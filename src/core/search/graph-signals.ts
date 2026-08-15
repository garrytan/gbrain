/**
 * v0.40.4.0 — selective graph signals.
 *
 * Three additive signals applied inside `runPostFusionStages`:
 *
 *   1. Adjacency-within-top-K (~1.05×): if a top-K page is linked-to by
 *      >=2 OTHER top-K pages, it's a hub for this query — small bump.
 *
 *   2. Cross-source adjacency (~1.10×): if a top-K page is linked-to from
 *      >=2 distinct OTHER sources (excluding target's own source), it's
 *      a federated-team hub — slightly bigger bump. Dormant on
 *      single-source brains (where cross_source_hits is always 0).
 *
 *   3. Session diversification (~0.95×): if multiple top-K pages share a
 *      session prefix (e.g. `media/chat/2026-05-20-foo/...`), keep
 *      the highest-scoring one at full score and DEMOTE the rest. This
 *      is MMR-lite: the original framing "boost the cluster" was
 *      structurally wrong — the stated motivation was "weak chunks
 *      competing for token budget," which amplification makes worse.
 *      Codex caught it in outside-voice review of the v0.40.4 plan.
 *
 * Conservative magnitudes (D14=B): halved from initial (1.10/1.15/1.05)
 * to (1.05/1.10/0.95) so multiplicative composition can't catastrophically
 * reorder in tight score bands. A score-distribution probe collects
 * data for T-todo-2 (data-driven calibration wave after 30 days).
 *
 * Slot: 4th stage inside `runPostFusionStages` (hybrid.ts), pre-dedup,
 * floor-gated by the v0.35.6.0 `computeFloorThreshold`. The gate is the
 * exact protection this signal class needs: a low-cosine result that
 * happens to be a hub gets shoved past a strong non-hub WITHOUT the
 * gate. Codex T2 / plan `swift-sniffing-nygaard.md` D6 caught this bug
 * class for v0.35.6.0; reintroducing it here would undo that work.
 *
 * Fail-open: any error from `engine.getAdjacencyBoosts` returns input
 * unchanged. Session diversification ALSO skips on failure (predictable
 * all-or-nothing posture). A JSONL audit row is written via the shared
 * createAuditWriter primitive so doctor + search-stats can surface fail
 * rates cross-process.
 */

import type { SearchResult } from '../types.ts';
import type { AdjacencyRow } from '../types.ts';
import type { BrainEngine } from '../engine.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';

// ===========================================================================
// Constants (D14=B halved magnitudes; the score-distribution probe feeds the
// T-todo-2 calibration wave that will tune these against real production data
// after 30 days).
// ===========================================================================

/** Multiplier applied when in-set adjacency hits >= ADJACENCY_MIN_HITS. */
export const ADJACENCY_BOOST = 1.05;
/** Multiplier applied when cross-source hits >= CROSS_SOURCE_MIN_HITS.
 *  STACKS on top of ADJACENCY_BOOST when both fire. */
export const CROSS_SOURCE_BOOST = 1.10;
/** Multiplier applied to non-top-scoring members of a session group.
 *  Sub-1.0 means DEMOTE, not boost (D11=B). */
export const SESSION_DEMOTE = 0.95;
/** How many top-ranked results to consider for graph signals. */
export const DEFAULT_TOP_K = 20;
/** Minimum in-set inbound link count before adjacency boost fires. */
export const ADJACENCY_MIN_HITS = 2;
/** Minimum distinct OTHER source count before cross-source boost fires. */
export const CROSS_SOURCE_MIN_HITS = 2;
/** Minimum group size before session diversification fires. */
export const SESSION_MIN_SHARE = 2;

// ===========================================================================
// Types
// ===========================================================================

/**
 * Score-distribution snapshot over top-K. Surfaced to search-stats so a
 * future calibration wave (T-todo-2) can tune boost magnitudes against
 * actual production score bands. Always emitted when graph_signals is
 * enabled, even when no signal fires — instrumentation-first.
 */
export interface ScoreDistribution {
  top_k_size: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  max: number;
  /** max - min across top-K; the reorder band the boosts have to clear. */
  reorder_band_width: number;
}

export interface GraphSignalsMeta {
  enabled: boolean;
  top_k_size: number;
  adjacency_fires: number;
  cross_source_fires: number;
  session_demotions: number;
  errored: boolean;
  duration_ms: number;
}

export interface GraphSignalsOpts {
  /** Master gate. False short-circuits to no-op with zero-meta emitted. */
  enabled: boolean;
  /** Top-K size (default DEFAULT_TOP_K). */
  topK?: number;
  /**
   * Absolute score floor inherited from runPostFusionStages. Results
   * with score below this skip ALL graph boosts (D1=A floor-gate
   * inheritance). Pass undefined to disable the gate.
   */
  floorThreshold?: number;
  /**
   * Test seam: replaces engine.getAdjacencyBoosts. Matches the
   * applyReranker pattern (opts.rerankerFn) so unit tests drive the
   * helper without an engine.
   */
  adjacencyFn?: (pageIds: number[]) => Promise<Map<number, AdjacencyRow>>;
  /** Observability sink — called once per invocation with fire counts. */
  onMeta?: (meta: GraphSignalsMeta) => void;
  /** Observability sink — called once per invocation with score stats. */
  onScoreDistribution?: (dist: ScoreDistribution) => void;
}

// ===========================================================================
// Failure audit (D5=B / T1 shared writer)
// ===========================================================================

interface GraphSignalsFailureEvent {
  ts: string;
  /** Truncated upstream error message (first 200 chars). */
  error_summary: string;
  /** Number of top-K page_ids submitted when the failure fired. */
  top_k_size: number;
}

const failureWriter = createAuditWriter<GraphSignalsFailureEvent>({
  featureName: 'graph-signals-failures',
  errorLabel: 'gbrain',
  errorTrailer: '; search continues',
});

function truncateErrorSummary(msg: string, max = 200): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max - 1) + '…';
}

/**
 * Read recent graph-signals fail-open events. Consumed by
 * `gbrain doctor`'s graph_signals_coverage check and by
 * `gbrain search stats`'s error-rate rollup.
 */
export function readRecentGraphSignalsFailures(
  days = 7,
  now: Date = new Date(),
): GraphSignalsFailureEvent[] {
  return failureWriter.readRecent(days, now);
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Pattern: session-like slugs have either a `chat/` segment or a YYYY-MM-DD
 * date segment somewhere in the path. Both signal "this is one of many
 * chunks from the same recorded session/transcript/log entry" — the case
 * where multiple result rows from a single weak source dilute a stronger
 * non-session hit.
 *
 * Examples that ARE sessions (return a real session prefix):
 *   - `your-agent/chat/2026-05-20-foo`           → 'your-agent/chat/2026-05-20-foo'
 *   - `daily/2026-05-20/journal-entry-1`         → 'daily/2026-05-20'
 *   - `meetings/2026-04-03/notes`                → 'meetings/2026-04-03'
 *   - `transcripts/chat/funding-discussion`      → 'transcripts/chat/funding-discussion'
 *
 * Examples that are NOT sessions (return null — no diversification):
 *   - `people/alice`, `people/bob`               → entity directory, NOT a session
 *   - `companies/acme`, `companies/stripe`       → entity directory, NOT a session
 *   - `docs/quickstart`, `docs/api`              → topical directory, NOT a session
 *   - `wiki/concepts/auth`                        → topical, not date-anchored
 *
 * This is the codex outside-voice fix: the original v0.40.4 implementation
 * used "any shared parent directory" as the session signal, which silently
 * demoted legitimate same-type entity results in every common entity
 * search (`people/alice` + `people/bob` got grouped, one demoted).
 *
 * Returns `null` when the slug isn't session-shaped (caller skips
 * diversification entirely for this result).
 */
const DATE_SEGMENT_RE = /^\d{4}-\d{2}-\d{2}/;
// Only 'chat' / 'session' / 'sessions' are session MARKERS — words that
// indicate "the next segment is a session id." Words like 'transcripts'
// or 'meetings' are CATEGORIES (parents of sessions, not markers
// themselves). A path like `transcripts/chat/funding-discussion` should
// be the WHOLE thing (parent + marker + session id), which only works
// if 'transcripts' is NOT a marker but 'chat' IS.
const SESSION_MARKERS = new Set(['chat', 'session', 'sessions']);

export function sessionPrefix(slug: string): string | null {
  if (!slug.includes('/')) return null;
  const segments = slug.split('/');
  // Strategy: walk segments left-to-right. Find the first segment that's
  // either a session marker (chat/session/sessions) OR a date prefix.
  // Session prefix shape:
  //   - On marker: everything up to AND INCLUDING the segment after the
  //     marker (that segment is the session id). If the marker is the
  //     last segment (degenerate), include up to the marker itself.
  //   - On date: everything up to and including the date segment.
  //
  // Examples:
  //   your-agent/chat/2026-05-20-foo → 'your-agent/chat/2026-05-20-foo'
  //   media/chat/2026-05-20-foo/chunk-001 → 'media/chat/2026-05-20-foo'
  //   transcripts/chat/funding-discussion → 'transcripts/chat/funding-discussion'
  //   daily/2026-05-20/journal-entry-1 → 'daily/2026-05-20'
  //   meetings/2026-04-03/notes → 'meetings/2026-04-03'
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (SESSION_MARKERS.has(seg)) {
      // Session id is segment i+1 (or the marker itself if i+1 doesn't exist).
      const sessionIdIdx = Math.min(i + 1, segments.length - 1);
      return segments.slice(0, sessionIdIdx + 1).join('/');
    }
    if (DATE_SEGMENT_RE.test(seg)) {
      // Date anchor — session is everything up to and including the date.
      return segments.slice(0, i + 1).join('/');
    }
  }
  // No session marker and no date anchor — entity / topic / docs
  // directory, not a session. Skip diversification.
  return null;
}

/**
 * Compute basic score-distribution percentiles over a sorted-desc array
 * of scores. Pure function — exposed so search-stats can re-aggregate
 * across queries.
 */
export function computeScoreDistribution(scores: number[]): ScoreDistribution {
  const n = scores.length;
  if (n === 0) {
    return {
      top_k_size: 0, min: 0, p25: 0, p50: 0, p75: 0, p95: 0, max: 0,
      reorder_band_width: 0,
    };
  }
  // Conventional ascending percentile math: 25th percentile = score
  // below which 25% of values fall.
  const asc = [...scores].sort((a, b) => a - b);
  const pct = (q: number) => {
    const idx = Math.max(0, Math.min(asc.length - 1, Math.round((asc.length - 1) * q)));
    return asc[idx];
  };
  return {
    top_k_size: n,
    min: asc[0],
    p25: pct(0.25),
    p50: pct(0.50),
    p75: pct(0.75),
    p95: pct(0.95),
    max: asc[asc.length - 1],
    reorder_band_width: asc[asc.length - 1] - asc[0],
  };
}

// ===========================================================================
// Main entry point
// ===========================================================================

/**
 * Apply selective graph signals to a sorted-desc results array. Mutates
 * `score` in place; caller re-sorts (runPostFusionStages already does
 * this at line 807 in hybrid.ts).
 *
 * Behavior:
 *   1. If !enabled or empty results → no-op + zero-meta.
 *   2. Always emit score-distribution probe (instrumentation-first for
 *      T-todo-2 calibration data).
 *   3. Adjacency + cross-source: SQL via engine.getAdjacencyBoosts (or
 *      injected adjacencyFn for tests). Floor-gate skips results below
 *      threshold (D1=A inheritance).
 *   4. Session diversification: single-pass Map<prefix, members>;
 *      highest-scoring keeps full score, others * SESSION_DEMOTE.
 *   5. Fail-open on engine error: stderr audit row + return unchanged.
 *
 * Mutation note (codex #9): score is mutated in place. base_score
 * should be stamped by the caller BEFORE this stage so eval-capture
 * sees the pre-boost score. runPostFusionStages does this in T6.
 */
export async function applyGraphSignals(
  results: SearchResult[],
  engine: BrainEngine,
  opts: GraphSignalsOpts,
): Promise<void> {
  const startedAt = Date.now();
  const meta: GraphSignalsMeta = {
    enabled: opts.enabled,
    top_k_size: 0,
    adjacency_fires: 0,
    cross_source_fires: 0,
    session_demotions: 0,
    errored: false,
    duration_ms: 0,
  };

  if (!opts.enabled || results.length === 0) {
    meta.duration_ms = Date.now() - startedAt;
    opts.onMeta?.(meta);
    return;
  }

  const topKSize = opts.topK ?? DEFAULT_TOP_K;
  const topK = results.slice(0, topKSize);
  meta.top_k_size = topK.length;

  // Score-distribution probe always fires when enabled (instrumentation
  // for T-todo-2 calibration wave, even if no signal subsequently fires).
  if (opts.onScoreDistribution) {
    opts.onScoreDistribution(computeScoreDistribution(topK.map(r => r.score)));
  }

  // ---- Adjacency + cross-source ----
  // Dedup page_ids before the SQL call. Same pattern as
  // runPostFusionStages line 265 uses for slugs. A SearchResult with
  // a missing page_id is treated as invariant-broken upstream
  // (page_id is documented as REQUIRED in SearchResult JSDoc) — skip
  // such rows from the dedup set; they can't be matched in the result
  // Map anyway.
  const uniquePageIds = Array.from(
    new Set(topK.map(r => r.page_id).filter(id => typeof id === 'number' && id > 0)),
  );

  let adjacency: Map<number, AdjacencyRow>;
  try {
    adjacency = opts.adjacencyFn
      ? await opts.adjacencyFn(uniquePageIds)
      : await engine.getAdjacencyBoosts(uniquePageIds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failureWriter.log({
      error_summary: truncateErrorSummary(msg),
      top_k_size: topK.length,
    });
    meta.errored = true;
    meta.duration_ms = Date.now() - startedAt;
    opts.onMeta?.(meta);
    // Fail-open: caller's results are unchanged. Session diversification
    // also skips (predictable all-or-nothing posture).
    return;
  }

  const floorThreshold = opts.floorThreshold;

  for (const r of topK) {
    // Floor-gate: D1=A inheritance. Below-floor results don't accumulate
    // graph boosts even if they're hubs (matches the v0.35.6.0
    // weak-page-becomes-hub protection that motivates putting graph-
    // signals inside runPostFusionStages).
    if (floorThreshold !== undefined && !(r.score >= floorThreshold)) continue;
    const row = adjacency.get(r.page_id);
    if (!row) continue;
    if (row.hits >= ADJACENCY_MIN_HITS) {
      r.score *= ADJACENCY_BOOST;
      r.graph_adjacency_hits = row.hits;
      r.graph_adjacency_boost = ADJACENCY_BOOST;
      meta.adjacency_fires++;
    }
    if (row.cross_source_hits >= CROSS_SOURCE_MIN_HITS) {
      r.score *= CROSS_SOURCE_BOOST;
      r.graph_cross_source_hits = row.cross_source_hits;
      r.graph_cross_source_boost = CROSS_SOURCE_BOOST;
      meta.cross_source_fires++;
    }
  }

  // ---- Session diversification (D9 single-pass Map, D11=B DEMOTE) ----
  // Only fires when sessionPrefix detects a session-like pattern
  // (chat/transcript marker OR date segment). Non-session slugs
  // (entity directories like `people/`, `companies/`, topical dirs
  // like `docs/`) skip diversification entirely — codex outside-voice
  // catch: the original implementation grouped ALL same-parent-directory
  // slugs, which silently demoted legitimate entity-search results.
  const sessionGroups = new Map<string, SearchResult[]>();
  for (const r of topK) {
    const prefix = sessionPrefix(r.slug);
    if (prefix === null) continue;  // not session-shaped — skip diversification
    let group = sessionGroups.get(prefix);
    if (!group) {
      group = [];
      sessionGroups.set(prefix, group);
    }
    group.push(r);
  }
  for (const [prefix, members] of sessionGroups) {
    if (members.length < SESSION_MIN_SHARE) continue;
    // Highest-scoring member keeps full score; others demoted.
    // Sort by current score (post-adjacency boost) descending so the
    // representative is whichever member scored highest AFTER any
    // adjacency boost. Stable for ties via slug for determinism.
    members.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.slug.localeCompare(b.slug);
    });
    for (let i = 1; i < members.length; i++) {
      members[i].score *= SESSION_DEMOTE;
      members[i].graph_session_demoted = true;
      members[i].graph_session_prefix = prefix;
      members[i].session_demote_factor = SESSION_DEMOTE;
      meta.session_demotions++;
    }
    // Stamp the prefix on the representative too so --explain can show
    // "representative of session_x" attribution. graph_session_demoted
    // stays false/undefined on the representative.
    members[0].graph_session_prefix = prefix;
  }

  meta.duration_ms = Date.now() - startedAt;
  opts.onMeta?.(meta);
}
