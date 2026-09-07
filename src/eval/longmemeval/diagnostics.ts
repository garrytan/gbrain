/**
 * diagnostics.ts — ranker wave Phase B1: locate WHERE a LongMemEval strict
 * miss is lost before any fix is chosen (plan D27, "B1 locates causes").
 *
 * Input is a harness receipt (`gbrain eval longmemeval` ndjson) plus the
 * dataset. For every scored question with `recall_all_hit=false` (or every
 * question with `all: true`) the question's brain is re-created EXACTLY as the
 * harness built it — one in-memory PGLite for the run, `resetTables` per
 * question, `haystackToPages` → `importFromContent`, the embed cache installed
 * through the same seam so every vector is a cache hit — and each gold session
 * missing from the receipt's top-k is located in every arm:
 *
 *   vector_rank      first chunk row of the session in `engine.searchVector`
 *                    (paged to `depth`, default 200; the engine caps one call
 *                    at MAX_SEARCH_LIMIT so depth is reached by offset paging)
 *   keyword_rank     same for `engine.searchKeyword` (orFallback as hybrid)
 *   title_rank       page-grain title arm (`engine.searchTitles`), one page
 *   fused_rank_*     pre-rerank RRF order of ONE `hybridSearch` call at
 *                    `fusedLimit` (default 50) under the same pins, captured
 *                    through `onRerankPool(pool, preRerank)`
 *   post_rerank_*    the post-rerank pool order from that same call
 *   final_rank_rows  the rows the call actually returned (post autocut/limit)
 *
 * Classes (frozen in the plan, B1/B2): (i) absent from every arm's top-depth,
 * (ii) in an arm pool but outside the fused top-k pre-rerank, (iii) in the
 * fused top-k pre-rerank but reranked out, (iv) ceiling (more gold sessions
 * than k). Two observational classes keep the receipt honest: `rerun_hit`
 * (the re-created run places the gold inside the top-k — the receipt's miss did
 * not reproduce under these pins) and `autocut_dropped` / `post_fusion_dropped`
 * (the gold survived fusion + rerank inside the top-k and a later trim removed
 * it — Phase C territory, not Phase B).
 *
 * Hypothesis probes (also frozen): the H1 "second-event starvation" signature
 * (≥2 gold, one at fused session rank 1-3, the missing one at 6-15), the
 * counterfactual clause sub-queries (`splitClauses`, the plan's frozen pattern
 * list; H1 is *supported* when a clause's own vector top-5 contains the
 * missing gold), and the H3 split — H3a candidate generation (gold in the
 * vector top-depth but outside the pre-fusion pool `innerLimit`) vs H3b
 * reranker depth (gold in the fused pool but beyond `reranker_top_n_in`).
 *
 * INVARIANT: the clause sub-query embeds run with the embed cache BYPASSED so
 * a diagnostics run never adds rows to the shared like-for-like cache (its
 * canonical hash is a receipt field; D9/D18).
 *
 * INVARIANT: pure helpers (`classifyMiss`, `splitClauses`, `h1Signature`,
 * `h3Candidates`, rank builders, receipt parsing, split membership, the
 * summary + markdown renderers) take plain data and touch no engine, so the
 * tests pin them without PGLite. `runDiagnostics` is the only engine-touching
 * entry point; the CLI lives in scripts/lme-miss-diagnostics.ts.
 */

import type { GBrainConfig } from '../../core/config.ts';
import { loadConfigWithEngine } from '../../core/config.ts';
import { MAX_SEARCH_LIMIT } from '../../core/engine.ts';
import { importFromContent } from '../../core/import-file.ts';
import { embedQuery, __setEmbedTransportForTests } from '../../core/ai/gateway.ts';
import { getMetricGloss } from '../../core/eval/metric-glossary.ts';
import { hybridSearch, PRE_FUSION_POOL_FLOOR, type HybridSearchOpts } from '../../core/search/hybrid.ts';
import { resolveEmbeddingColumn } from '../../core/search/embedding-column.ts';
import {
  loadSearchModeConfig,
  resolveSearchMode,
  type ResolvedSearchKnobs,
  type SearchMode,
} from '../../core/search/mode.ts';
import type { PGLiteEngine } from '../../core/pglite-engine.ts';
import type { HybridSearchMeta, SearchOpts, SearchResult } from '../../core/types.ts';
import { haystackToPages, type LongMemEvalQuestion } from './adapter.ts';
import { resetTables } from './harness.ts';
import { buildSlugToRawMap, isAbstentionQuestion, rawSessionId, type SlugToRawMap } from './metrics.ts';
import { classifyDegradation } from './resume.ts';
import { redactSecrets } from './run-config.ts';
import { EmbeddingCache, installEmbedCache, type EmbedTransportFn, type InstalledEmbedCache } from '../shared/embed-cache.ts';

export const DEFAULT_DEPTH = 200;
export const DEFAULT_FUSED_LIMIT = 50;

// ---------------------------------------------------------------------------
// Classes, ranks, hypotheses (pure)
// ---------------------------------------------------------------------------

export type MissClass =
  | 'i_absent_all_arms'
  | 'ii_in_pool_fused_out'
  | 'iii_reranked_out'
  | 'iv_ceiling'
  | 'autocut_dropped'
  | 'post_fusion_dropped'
  | 'rerun_hit'
  | 'hit'
  | 'gold_absent_from_haystack';

export const MISS_CLASSES: readonly MissClass[] = [
  'i_absent_all_arms',
  'ii_in_pool_fused_out',
  'iii_reranked_out',
  'iv_ceiling',
  'autocut_dropped',
  'post_fusion_dropped',
  'rerun_hit',
  'hit',
  'gold_absent_from_haystack',
];

export interface ArmRanks {
  /** First chunk-row rank (1-based) of the session in the vector arm, or null when absent within depth. */
  vector_rank: number | null;
  keyword_rank: number | null;
  /** True when the keyword hit came from the AND→OR relaxed fallback (hybrid drops such rows pre-fusion when vector is healthy). */
  keyword_relaxed: boolean;
  title_rank: number | null;
  /** Pre-rerank fused (RRF) order of the limit-50 hybridSearch call: first chunk-row rank. */
  fused_rank_rows: number | null;
  /** Same order, rank over DISTINCT sessions (the H1 signature reads this). */
  fused_rank_sessions: number | null;
  /** Post-rerank pool order (pre-autocut). Null when the reranker did not run. */
  post_rerank_rank_rows: number | null;
  post_rerank_rank_sessions: number | null;
  /** Rank among the rows the fused call actually returned (post autocut / limit). */
  final_rank_rows: number | null;
}

export function emptyRanks(): ArmRanks {
  return {
    vector_rank: null,
    keyword_rank: null,
    keyword_relaxed: false,
    title_rank: null,
    fused_rank_rows: null,
    fused_rank_sessions: null,
    post_rerank_rank_rows: null,
    post_rerank_rank_sessions: null,
    final_rank_rows: null,
  };
}

export interface ClassifyInput {
  ranks: ArmRanks;
  /** The receipt's k (recall_all@k is scored over the distinct sessions in the top-k CHUNK rows). */
  k: number;
  gold_total: number;
  /** The reranker actually reordered the fused pool in the re-created call. */
  reranker_ran: boolean;
  in_receipt_top_k: boolean;
  in_haystack: boolean;
}

/**
 * Plan B1 classes, decided in this order: dataset defect → receipt hit →
 * ceiling → rerun hit (inside the returned top-k) → post-rerank trims →
 * reranked out → present in some arm → absent everywhere.
 */
export function classifyMiss(input: ClassifyInput): MissClass {
  const { ranks: r, k } = input;
  if (!input.in_haystack) return 'gold_absent_from_haystack';
  if (input.in_receipt_top_k) return 'hit';
  if (input.gold_total > k) return 'iv_ceiling';
  const within = (x: number | null): boolean => x !== null && x <= k;
  if (within(r.final_rank_rows)) return 'rerun_hit';
  if (input.reranker_ran) {
    if (within(r.post_rerank_rank_rows)) return 'autocut_dropped';
    if (within(r.fused_rank_rows)) return 'iii_reranked_out';
  } else if (within(r.fused_rank_rows)) {
    return 'post_fusion_dropped';
  }
  const inAnyArm =
    r.vector_rank !== null || r.keyword_rank !== null || r.title_rank !== null || r.fused_rank_rows !== null;
  return inAnyArm ? 'ii_in_pool_fused_out' : 'i_absent_all_arms';
}

/**
 * H1 "second-event starvation" signature (plan B2): a question with ≥ 2 gold
 * sessions where some OTHER gold sits at fused (distinct-session) rank 1-3 and
 * the missing gold sits at rank 6-15.
 */
export function h1Signature(otherGoldFusedSessionRanks: ReadonlyArray<number | null>, missingFusedSessionRank: number | null): boolean {
  if (missingFusedSessionRank === null) return false;
  if (missingFusedSessionRank < 6 || missingFusedSessionRank > 15) return false;
  return otherGoldFusedSessionRanks.some(x => x !== null && x >= 1 && x <= 3);
}

export interface H3Input {
  vector_rank: number | null;
  fused_rank_rows: number | null;
  /** The receipt run's pre-fusion pool size: `computeInnerLimit(k)`. */
  inner_limit: number;
  reranker_top_n_in: number;
}

/**
 * H3 split (plan D27): H3a = the gold is in the vector top-depth but outside
 * the pre-fusion pool (candidate generation — `innerLimit` /
 * PRE_FUSION_POOL_FLOOR would have to grow); H3b = the gold is in the fused
 * pool but beyond the reranker's `top_n_in` (the reranker never saw it).
 */
export function h3Candidates(input: H3Input): { h3a: boolean; h3b: boolean } {
  return {
    h3a: input.vector_rank !== null && input.vector_rank > input.inner_limit,
    h3b: input.fused_rank_rows !== null && input.fused_rank_rows > input.reranker_top_n_in,
  };
}

/** hybrid.ts's pre-fusion pool size for a call at `limit` (offset 0). */
export function computeInnerLimit(limit: number): number {
  return Math.min(Math.max(limit * 2, PRE_FUSION_POOL_FLOOR, limit), MAX_SEARCH_LIMIT);
}

/** First chunk-row rank (1-based) per raw session id. */
export function sessionRowRanks(rows: ReadonlyArray<{ slug: string }>, slugToRaw?: SlugToRawMap): Map<string, number> {
  const out = new Map<string, number>();
  rows.forEach((r, i) => {
    const sid = rawSessionId(r.slug, slugToRaw);
    if (!out.has(sid)) out.set(sid, i + 1);
  });
  return out;
}

/** Rank over DISTINCT sessions in first-occurrence order (1-based). */
export function sessionDistinctRanks(rows: ReadonlyArray<{ slug: string }>, slugToRaw?: SlugToRawMap): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const sid = rawSessionId(r.slug, slugToRaw);
    if (!out.has(sid)) out.set(sid, out.size + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clause splitter (pure) — the plan's frozen H1 pattern list
// ---------------------------------------------------------------------------

export type ClausePattern = 'how_many_between' | 'between' | 'first_or' | 'before_after';

export interface ClauseSplit {
  /** Exactly 2 clauses when the splitter fired, else []. */
  clauses: string[];
  pattern: ClausePattern | null;
  /** Why it did not fire (null when it fired). */
  reason: 'no_pattern' | 'no_connector' | 'clause_too_short' | null;
}

const TEMPORAL_SIGNAL =
  /\b(?:how (?:long|many|much)|days?|weeks?|months?|years?|hours?|minutes?|when|time|dates?|passed|elapsed|earlier|later|first|last|before|after|ago|gap|interval|apart|since|until|prior|following)\b/i;

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'mine', 'you', 'your', 'we', 'our', 'us', 'he', 'she', 'it', 'its', 'they', 'them',
  'their', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'and', 'or', 'but', 'did', 'do', 'does', 'done',
  'was', 'were', 'is', 'are', 'am', 'be', 'been', 'being', 'that', 'this', 'these', 'those', 'which', 'what', 'when',
  'where', 'who', 'how', 'many', 'much', 'there', 'then', 'than', 'if', 'so', 'as', 'up', 'out', 'about', 'into',
  'over', 'again', 'just', 'also', 'not', 'no', 'yes', 'have', 'has', 'had', 'get', 'got',
]);

/** Lowercase word tokens that are not function words. */
export function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(t => !STOPWORDS.has(t));
}

type Span = readonly [number, number];

/** Inclusive index spans of quoted text: "…", “…”, ‘…’, and whitespace-delimited '…'. */
function quotedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const quotePairs: RegExp[] = [/"[^"]*"/g, /“[^”]*”/g, /‘[^’]*’/g, /(?<=^|\s)'[^']+'(?=$|[\s.,;:?!])/g];
  for (const re of quotePairs) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length - 1]);
  }
  return spans;
}

function insideQuotes(spans: readonly Span[], idx: number): boolean {
  return spans.some(([a, b]) => idx > a && idx < b);
}

function isCapitalizedWord(raw: string): boolean {
  const w = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  return w.length > 1 && /^[A-Z][A-Za-z'&.-]*$/.test(w) && w !== 'I';
}

/** `Procter and Gamble`: the connector sits between two Capitalized words. */
function capitalizedBigramFlanked(text: string, idx: number, len: number): boolean {
  const before = /(\S+)\s*$/.exec(text.slice(0, idx))?.[1];
  const after = /^\s*(\S+)/.exec(text.slice(idx + len))?.[1];
  return !!before && !!after && isCapitalizedWord(before) && isCapitalizedWord(after);
}

/**
 * Iterate every match of a `g`-flagged literal pattern. `matchAll` clones the
 * regex, so a shared module-level literal never leaks `lastIndex` state, and no
 * RegExp is ever constructed from a runtime string (all patterns below are
 * source literals).
 */
function eachMatch(text: string, re: RegExp): IterableIterator<RegExpExecArray> {
  if (!re.global) throw new Error(`diagnostics: pattern ${re} must carry the g flag`);
  return text.matchAll(re);
}

/** First occurrence of `re` (global) that is neither inside quotes nor a Capitalized-Bigram bridge. */
function findConnector(text: string, re: RegExp, spans: readonly Span[]): { index: number; length: number } | null {
  for (const m of eachMatch(text, re)) {
    const wordStart = m.index + (m[0].length - m[0].trimStart().length);
    if (insideQuotes(spans, wordStart)) continue;
    if (capitalizedBigramFlanked(text, m.index, m[0].length)) continue;
    return { index: m.index, length: m[0].length };
  }
  return null;
}

/** First match of `re` (global) whose start is not inside a quoted span. */
function firstMarker(text: string, re: RegExp, spans: readonly Span[]): RegExpExecArray | null {
  for (const m of eachMatch(text, re)) {
    if (!insideQuotes(spans, m.index)) return m;
  }
  return null;
}

/** Trim punctuation, drop a leading auxiliary/subordinator so the clause reads as a sub-query. */
export function cleanClause(raw: string): string {
  let s = raw.replace(/^[\s,;:]+/, '').replace(/[\s?.!,;:]+$/, '');
  s = s.replace(/^(?:that|when|the (?:time|day|moment|date))\s+/i, '');
  s = s.replace(/^(?:did|do|does|was|were|had|have|has|is|are|am)\s+/i, '');
  return s.trim();
}

function pair(left: string, right: string, pattern: ClausePattern): ClauseSplit {
  const a = cleanClause(left);
  const b = cleanClause(right);
  if (contentTokens(a).length < 2 || contentTokens(b).length < 2) return { clauses: [], pattern, reason: 'clause_too_short' };
  return { clauses: [a, b], pattern, reason: null };
}

function splitRest(rest: string, connector: RegExp, spans: readonly Span[], offset: number, pattern: ClausePattern): ClauseSplit {
  // Spans were computed on the whole question; shift them into `rest`'s frame.
  const shifted: Span[] = spans.map(([a, b]) => [a - offset, b - offset] as const);
  const c = findConnector(rest, connector, shifted);
  if (!c) return { clauses: [], pattern, reason: 'no_connector' };
  return pair(rest.slice(0, c.index), rest.slice(c.index + c.length), pattern);
}

/**
 * Split a multi-event question into ≤ 2 sub-queries with the plan's frozen
 * pattern list — `how many (days|weeks|months|...) between X and Y`,
 * `between X and Y` (with a temporal/comparison signal), `first … or …` /
 * `which came first`, and `before`/`after` with two verb phrases (incl.
 * `X before or after Y` and `how long after X did Y`). Guardrails: both
 * clauses ≥ 2 content tokens; never split inside quotes or across a
 * Capitalized-Bigram span (`Procter and Gamble`); never more than 2.
 * Returns [] when it does not fire.
 */
export function splitClauses(question: string): string[] {
  return splitClausesDetailed(question).clauses;
}

export function splitClausesDetailed(question: string): ClauseSplit {
  const text = question.replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
  const spans = quotedSpans(text);
  const AND = /\s(?:and)\s/gi;
  const OR = /\s(?:or)\s/gi;
  // A marker that matched but found no usable connector is remembered so the
  // caller sees `no_connector` (not `no_pattern`) when nothing later fires.
  let markerMiss: ClauseSplit | null = null;

  // 1. how many (days|weeks|months|years|hours|time) … between X and Y
  if (/^how (?:many|much)\s+(?:days?|weeks?|months?|years?|hours?|time)\b/i.test(text)) {
    const m = firstMarker(text, /\bbetween\s+/gi, spans);
    if (m) {
      const off = m.index + m[0].length;
      const r = splitRest(text.slice(off), AND, spans, off, 'how_many_between');
      if (r.clauses.length === 2 || r.reason !== 'no_connector') return r;
      markerMiss = r;
    }
  }
  // 2. between X and Y (temporal / comparison signal required)
  {
    const m = firstMarker(text, /\bbetween\s+/gi, spans);
    if (m && TEMPORAL_SIGNAL.test(text)) {
      const off = m.index + m[0].length;
      const r = splitRest(text.slice(off), AND, spans, off, 'between');
      if (r.clauses.length === 2 || r.reason !== 'no_connector') return r;
      markerMiss = markerMiss ?? r;
    }
  }
  // 3. first … or … / which came first, X or Y
  {
    const m = firstMarker(text, /\b(?:which (?:came|happened|occurred|was|one was) first|first)\b[,:]?\s+/gi, spans);
    if (m) {
      const off = m.index + m[0].length;
      const r = splitRest(text.slice(off), OR, spans, off, 'first_or');
      if (r.clauses.length === 2 || r.reason !== 'no_connector') return r;
      markerMiss = markerMiss ?? r;
    }
  }
  // 4. before / after with two verb phrases
  {
    // 4c. how long|many N after X did Y
    const m = /^how (?:long|many \w+|much time)\s+(before|after)\s+(.+?)\s+(did|do|does|was|were|had|have|has|am|is|are)\s+(.+)$/i.exec(text);
    if (m && !insideQuotes(spans, m.index + m[0].search(/\b(?:before|after)\b/i))) {
      const r = pair(m[2], `${m[3]} ${m[4]}`, 'before_after');
      if (r.clauses.length === 2) return r;
    }
    // 4a. X before or after Y
    const boa = firstMarker(text, /\bbefore or after\b/gi, spans);
    if (boa) {
      const r = pair(text.slice(0, boa.index), text.slice(boa.index + boa[0].length), 'before_after');
      if (r.clauses.length === 2 || r.reason !== 'no_connector') return r;
    }
    // 4b. generic X before|after Y
    const c = findConnector(text, /\s(?:before|after)\s/gi, spans);
    if (c) return pair(text.slice(0, c.index), text.slice(c.index + c.length), 'before_after');
  }
  return markerMiss ?? { clauses: [], pattern: null, reason: 'no_pattern' };
}

// ---------------------------------------------------------------------------
// Receipt + splits (pure)
// ---------------------------------------------------------------------------

export interface ReceiptRetrievedRow {
  slug?: string;
  chunk_id?: number;
  session_id?: string;
  rank?: number;
  rerank_score?: number;
}

export interface ReceiptRow {
  question_id: string;
  question_type?: string;
  question?: string;
  recall_all_hit?: boolean;
  recall_any_hit?: boolean;
  abstention?: boolean;
  retrieved?: ReceiptRetrievedRow[];
  retrieved_session_ids?: string[];
  rerank_pool?: ReceiptRetrievedRow[];
  expansion_variants?: string[];
  error?: string;
  retrieval_config_hash?: string;
}

/**
 * The pins a receipt was produced under, as read back from its
 * `by_type_summary.run_config`. The harness (`run-config.ts:buildRunConfig`)
 * writes them FLAT on `run_config` (`mode`, `reranker: {enabled, model}`,
 * `autocut`, `expansion`, `expansion_variant_budget`, `embedder`, `topK`);
 * `pinsFromReceipt` normalizes that shape here (`topK` → `top_k`) and still
 * accepts the legacy nested `run_config.pins` block.
 */
export interface ReceiptSummaryPins {
  mode?: string;
  reranker?: { enabled?: boolean; model?: string };
  autocut?: boolean;
  expansion?: boolean;
  expansion_variant_budget?: number | null;
  top_k?: number;
  embedder?: string;
}

/** `run_config` as the harness writes it (flat pins, `topK`), plus the legacy nested `pins` block. */
export type ReceiptRunConfig = Omit<ReceiptSummaryPins, 'top_k'> & { topK?: number; pins?: ReceiptSummaryPins; [k: string]: unknown };

export interface ParsedReceipt {
  rows: ReceiptRow[];
  /** The `by_type_summary` line when present (pins are flat on `run_config`). */
  summary: { k?: number; run_config?: ReceiptRunConfig; [k: string]: unknown } | null;
}

/** Parse a harness ndjson receipt; corrupt lines are skipped, the summary line is separated. */
export function parseReceipt(text: string): ParsedReceipt {
  const rows: ReceiptRow[] = [];
  let summary: ParsedReceipt['summary'] = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.kind === 'by_type_summary') {
      summary = obj as ParsedReceipt['summary'];
      continue;
    }
    if (typeof obj.question_id === 'string') rows.push(obj as unknown as ReceiptRow);
  }
  return { rows, summary };
}

/**
 * Pins the receipt was produced under (explicit CLI flags beat these). Reads the
 * flat `run_config` the harness writes (`topK` → `top_k`); a legacy nested
 * `run_config.pins` block fills any key the flat shape leaves undefined. Only
 * keys that are present come back, so an empty summary yields `{}`.
 */
export function pinsFromReceipt(parsed: ParsedReceipt): ReceiptSummaryPins {
  const rc = parsed.summary?.run_config;
  if (!rc) return {};
  const legacy = rc.pins ?? {};
  const out: ReceiptSummaryPins = {};
  const mode = rc.mode ?? legacy.mode;
  if (typeof mode === 'string') out.mode = mode;
  const reranker = rc.reranker ?? legacy.reranker;
  if (reranker && typeof reranker === 'object') out.reranker = reranker;
  const autocut = rc.autocut ?? legacy.autocut;
  if (typeof autocut === 'boolean') out.autocut = autocut;
  const expansion = rc.expansion ?? legacy.expansion;
  if (typeof expansion === 'boolean') out.expansion = expansion;
  if (rc.expansion_variant_budget !== undefined) out.expansion_variant_budget = rc.expansion_variant_budget;
  else if (legacy.expansion_variant_budget !== undefined) out.expansion_variant_budget = legacy.expansion_variant_budget;
  const topK = rc.topK ?? legacy.top_k;
  if (typeof topK === 'number') out.top_k = topK;
  const embedder = rc.embedder ?? legacy.embedder;
  if (typeof embedder === 'string') out.embedder = embedder;
  return out;
}

/**
 * Distinct RAW session ids among the receipt row's top-k chunk rows — the same
 * reading `recall_all@k` was scored on. Falls back to `retrieved_session_ids`
 * (already distinct, first-occurrence order) for rows without `retrieved[]`.
 */
export function receiptTopKSessions(row: ReceiptRow, k: number, slugToRaw?: SlugToRawMap): string[] {
  if (Array.isArray(row.retrieved) && row.retrieved.length > 0) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of row.retrieved.slice(0, k)) {
      const sid = typeof r.session_id === 'string' ? r.session_id : r.slug ? rawSessionId(r.slug, slugToRaw) : null;
      if (sid === null || seen.has(sid)) continue;
      seen.add(sid);
      out.push(sid);
    }
    return out;
  }
  return (row.retrieved_session_ids ?? []).slice(0, k);
}

export type SplitTag = 'dev40' | 'decision430' | 'halfA430' | 'halfB430' | 'halfA470' | 'halfB470';
export const SPLIT_TAGS: readonly SplitTag[] = ['dev40', 'decision430', 'halfA430', 'halfB430', 'halfA470', 'halfB470'];

/** Tag a question with every split list (evals/longmemeval/splits-seed42.json) that contains it. */
export function splitMembership(questionId: string, splits: Record<string, unknown> | null | undefined): SplitTag[] {
  if (!splits) return [];
  const out: SplitTag[] = [];
  for (const tag of SPLIT_TAGS) {
    const list = splits[tag];
    if (Array.isArray(list) && list.includes(questionId)) out.push(tag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row / summary shapes
// ---------------------------------------------------------------------------

export interface GoldDiagnostics {
  session_id: string;
  in_haystack: boolean;
  in_receipt_top_k: boolean;
  ranks: ArmRanks;
  class: MissClass;
  h3a: boolean;
  h3b: boolean;
}

export interface ClauseProbe {
  clause: string;
  /** Distinct sessions among the clause's vector top-5 chunk rows. */
  top5_sessions: string[];
  /** Missing gold ids that appear in that top-5. */
  hits_missing: string[];
}

export interface ClauseDiagnostics {
  fired: boolean;
  pattern: ClausePattern | null;
  reason: ClauseSplit['reason'];
  clauses: string[];
  probes: ClauseProbe[];
  /** H1 supported: some clause's vector top-5 contains a missing gold session. */
  h1_supported: boolean;
}

export interface RerunMeta {
  fused_limit: number;
  inner_limit: number;
  reranker_top_n_in: number;
  reranker_ran: boolean;
  vector_enabled: boolean;
  degraded: string[];
  expansion_replayed: boolean;
  distinct_sessions_fused: number;
}

export interface MissDiagnosticsRow {
  kind: 'lme_miss_diagnostics';
  question_id: string;
  question: string;
  question_type: string;
  splits: SplitTag[];
  k: number;
  gold_total: number;
  gold: string[];
  /** Gold sessions absent from the receipt's top-k. */
  missing: string[];
  receipt_recall_all_hit: boolean | null;
  golds: GoldDiagnostics[];
  /** Class shared by every missing gold, `mixed` when they disagree, `hit` when nothing is missing. */
  primary_class: MissClass | 'mixed';
  h1_signature: boolean;
  clause_split: ClauseDiagnostics;
  rerun: RerunMeta;
  error?: string;
}

export interface DiagnosticsPins {
  mode?: SearchMode;
  reranker?: boolean;
  autocut?: boolean;
  /** undefined = not pinned; null = legacy weighting. */
  expansionVariantBudget?: number | null;
}

export interface DiagnosticsSummary {
  schema_version: 1;
  kind: 'lme_miss_diagnostics_summary';
  k: number;
  depth: number;
  fused_limit: number;
  inner_limit: number;
  reranker_top_n_in: number;
  pins: { mode: SearchMode; reranker: boolean; autocut: boolean; expansion_variant_budget: number | null };
  questions_scanned: number;
  questions_diagnosed: number;
  misses: number;
  errors: number;
  /** Questions by question_type × primary class. */
  by_type_class: Record<string, Record<string, number>>;
  /** Missing gold sessions by class. */
  gold_sessions_by_class: Record<string, number>;
  h1_signature_count: number;
  splitter_fired: number;
  splitter_supported: number;
  h3a_count: number;
  h3b_count: number;
  autocut_dropped_count: number;
  rerun_hit_count: number;
  split_membership: Record<SplitTag | 'unsplit', number>;
  cache: { path: string; hits: number; misses: number; bypassed: number; infra_faults: number } | null;
}

export function summarizeDiagnostics(
  rows: readonly MissDiagnosticsRow[],
  ctx: {
    k: number; depth: number; fusedLimit: number; innerLimit: number; rerankerTopNIn: number;
    pins: DiagnosticsSummary['pins']; questionsScanned: number;
    cache?: DiagnosticsSummary['cache'];
  },
): DiagnosticsSummary {
  const byTypeClass: Record<string, Record<string, number>> = {};
  const goldByClass: Record<string, number> = {};
  const split: Record<SplitTag | 'unsplit', number> = {
    dev40: 0, decision430: 0, halfA430: 0, halfB430: 0, halfA470: 0, halfB470: 0, unsplit: 0,
  };
  let misses = 0, errors = 0, h1 = 0, fired = 0, supported = 0, h3a = 0, h3b = 0, autocut = 0, rerunHit = 0;
  for (const row of rows) {
    if (row.error) errors++;
    const isMiss = row.missing.length > 0;
    if (isMiss) misses++;
    const t = byTypeClass[row.question_type] ?? (byTypeClass[row.question_type] = {});
    t[row.primary_class] = (t[row.primary_class] ?? 0) + 1;
    for (const g of row.golds) {
      if (!row.missing.includes(g.session_id)) continue;
      goldByClass[g.class] = (goldByClass[g.class] ?? 0) + 1;
      if (g.h3a) h3a++;
      if (g.h3b) h3b++;
      if (g.class === 'autocut_dropped') autocut++;
      if (g.class === 'rerun_hit') rerunHit++;
    }
    if (row.h1_signature) h1++;
    if (row.clause_split.fired) fired++;
    if (row.clause_split.h1_supported) supported++;
    if (isMiss) {
      if (row.splits.length === 0) split.unsplit++;
      for (const s of row.splits) split[s]++;
    }
  }
  return {
    schema_version: 1,
    kind: 'lme_miss_diagnostics_summary',
    k: ctx.k,
    depth: ctx.depth,
    fused_limit: ctx.fusedLimit,
    inner_limit: ctx.innerLimit,
    reranker_top_n_in: ctx.rerankerTopNIn,
    pins: ctx.pins,
    questions_scanned: ctx.questionsScanned,
    questions_diagnosed: rows.length,
    misses,
    errors,
    by_type_class: byTypeClass,
    gold_sessions_by_class: goldByClass,
    h1_signature_count: h1,
    splitter_fired: fired,
    splitter_supported: supported,
    h3a_count: h3a,
    h3b_count: h3b,
    autocut_dropped_count: autocut,
    rerun_hit_count: rerunHit,
    split_membership: split,
    cache: ctx.cache ?? null,
  };
}

// ---------------------------------------------------------------------------
// Markdown (pure)
// ---------------------------------------------------------------------------

/**
 * Plain-English glosses for every name the markdown prints. Names that exist
 * in the shared METRIC_GLOSSARY (`recall_all@k`) are read from it; the rest
 * are diagnostics-local (that file is owned by another lane this wave).
 */
export const LOCAL_GLOSSARY: Readonly<Record<string, string>> = Object.freeze({
  vector_rank: 'Position (1 = best) of the first chunk of the gold session in the vector arm alone, searched to `depth` rows. null = not found within depth.',
  keyword_rank: 'Same position in the keyword (full-text) arm alone. `relaxed` marks an AND→OR fallback hit, which hybrid drops before fusion when the vector arm is healthy.',
  title_rank: 'Same position in the page-title arm (session slugs), one page of results.',
  fused_rank: 'Position after Reciprocal Rank Fusion of all arms, BEFORE the reranker — over chunk rows (`rows`) and over distinct sessions (`sessions`). From one hybridSearch call at fused_limit under the receipt pins.',
  post_rerank_rank: 'Position in the cross-encoder reranked pool from that same call, before autocut / the limit slice. null when the reranker did not run.',
  final_rank: 'Position among the rows the fused call actually returned (after autocut and the limit slice).',
  class: '(i) absent from every arm within depth = embedding/lexical recall loss; (ii) present in some arm but outside the fused top-k = fusion demotion / second-clause starvation; (iii) inside the fused top-k but reranked out = reranker limitation; (iv) ceiling = more gold sessions than k, unreachable by construction; rerun_hit = the re-created run puts the gold inside the top-k (the receipt miss did not reproduce under these pins); autocut_dropped / post_fusion_dropped = the gold survived fusion (+rerank) inside the top-k and a later trim removed it.',
  h1_signature: 'Second-event starvation signature: the question has ≥2 gold sessions, one sits at fused session rank 1-3 and the missing one at 6-15.',
  splitter_fired: 'The frozen clause splitter (between X and Y; first … or …; before/after with two verb phrases; how many days/weeks/months between) produced exactly two sub-queries for the question.',
  h1_supported: 'Counterfactual check: some clause sub-query, embedded and searched alone, puts the missing gold session in its vector top-5.',
  h3a: 'Candidate generation: the gold is in the vector arm within depth but beyond the pre-fusion pool (`inner_limit`), so fusion never saw it.',
  h3b: 'Reranker depth: the gold is in the fused pool but beyond `reranker_top_n_in`, so the reranker never scored it.',
  inner_limit: 'Rows each arm hands to fusion for a call at the receipt k: max(2k, PRE_FUSION_POOL_FLOOR) capped at MAX_SEARCH_LIMIT.',
  reranker_top_n_in: 'How many fused rows the mode bundle sends to the reranker.',
  split_membership: 'Which seeded split lists (dev40 / decision430 / halfA430 / halfB430) each missed question belongs to; Phase B chooses a mechanism on half A and confirms on half B.',
});

export function glossFor(name: string): string {
  const shared = getMetricGloss(name);
  if (shared) return shared.eli10;
  return LOCAL_GLOSSARY[name] ?? '(no gloss)';
}

function fmtRank(x: number | null): string {
  return x === null ? '—' : String(x);
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderDiagnosticsMarkdown(rows: readonly MissDiagnosticsRow[], summary: DiagnosticsSummary): string {
  const L: string[] = [];
  L.push('# LongMemEval miss diagnostics (Phase B1)');
  L.push('');
  L.push(
    `Pins: mode=${summary.pins.mode}, reranker=${summary.pins.reranker ? 'on' : 'off'}, autocut=${summary.pins.autocut ? 'on' : 'off'}, ` +
    `expansion_variant_budget=${summary.pins.expansion_variant_budget ?? 'legacy'}; k=${summary.k}, depth=${summary.depth}, ` +
    `fused_limit=${summary.fused_limit}, inner_limit=${summary.inner_limit}, reranker_top_n_in=${summary.reranker_top_n_in}.`,
  );
  L.push(`Questions scanned: ${summary.questions_scanned}; diagnosed: ${summary.questions_diagnosed}; strict misses: ${summary.misses}; errors: ${summary.errors}.`);
  if (summary.cache) {
    L.push(`Embed cache: ${summary.cache.hits} hits, ${summary.cache.misses} misses, ${summary.cache.bypassed} bypassed, ${summary.cache.infra_faults} infra fault(s) (${summary.cache.path}). Clause sub-query embeds bypass the cache and are not counted.`);
  }
  L.push('');
  L.push('## What the numbers mean');
  L.push('');
  L.push(`- **recall_all@k** — ${glossFor('recall_all@k')}`);
  for (const name of ['vector_rank', 'keyword_rank', 'title_rank', 'fused_rank', 'post_rerank_rank', 'final_rank', 'class', 'h1_signature', 'splitter_fired', 'h1_supported', 'h3a', 'h3b', 'inner_limit', 'reranker_top_n_in', 'split_membership']) {
    L.push(`- **${name}** — ${glossFor(name)}`);
  }
  L.push('');
  L.push('## Misses by question_type × class (questions, primary class)');
  L.push('');
  const classes = MISS_CLASSES.filter(c => rows.some(r => r.primary_class === c)) as string[];
  if (rows.some(r => r.primary_class === 'mixed')) classes.push('mixed');
  L.push(`| question_type | ${classes.join(' | ')} | total |`);
  L.push(`|---|${classes.map(() => '---:').join('|')}|---:|`);
  for (const t of Object.keys(summary.by_type_class).sort()) {
    const m = summary.by_type_class[t];
    const total = Object.values(m).reduce((a, b) => a + b, 0);
    L.push(`| ${t} | ${classes.map(c => String(m[c] ?? 0)).join(' | ')} | ${total} |`);
  }
  L.push('');
  L.push('## Missing gold sessions by class');
  L.push('');
  L.push('| class | sessions |');
  L.push('|---|---:|');
  for (const c of Object.keys(summary.gold_sessions_by_class).sort()) L.push(`| ${c} | ${summary.gold_sessions_by_class[c]} |`);
  L.push('');
  L.push('## Hypothesis counters');
  L.push('');
  L.push('| counter | n |');
  L.push('|---|---:|');
  L.push(`| h1_signature | ${summary.h1_signature_count} |`);
  L.push(`| splitter_fired | ${summary.splitter_fired} |`);
  L.push(`| h1_supported (clause top-5 contains missing gold) | ${summary.splitter_supported} |`);
  L.push(`| h3a (vector top-${summary.depth}, outside inner_limit ${summary.inner_limit}) | ${summary.h3a_count} |`);
  L.push(`| h3b (fused pool, beyond reranker_top_n_in ${summary.reranker_top_n_in}) | ${summary.h3b_count} |`);
  L.push(`| autocut_dropped | ${summary.autocut_dropped_count} |`);
  L.push(`| rerun_hit (receipt miss did not reproduce) | ${summary.rerun_hit_count} |`);
  L.push('');
  L.push('## Split membership of the misses');
  L.push('');
  L.push('| split | misses |');
  L.push('|---|---:|');
  for (const tag of [...SPLIT_TAGS, 'unsplit'] as const) L.push(`| ${tag} | ${summary.split_membership[tag]} |`);
  L.push('');
  L.push('## Per-question itemization');
  L.push('');
  L.push('Ranks are `vector / keyword / title / fused(rows;sessions) / post-rerank(rows) / final(rows)` per gold session; `—` = not found. Hypotheses: H1sig, split(pattern), H1sup, H3a, H3b.');
  L.push('');
  L.push('| question_id | type | splits | gold | missing | per-gold ranks | class | hypotheses |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const ranks = r.golds
      .map(g => {
        const k = g.ranks;
        return `${g.session_id}${r.missing.includes(g.session_id) ? '*' : ''}: ${fmtRank(k.vector_rank)}/${fmtRank(k.keyword_rank)}${k.keyword_relaxed ? 'r' : ''}/${fmtRank(k.title_rank)}/${fmtRank(k.fused_rank_rows)};${fmtRank(k.fused_rank_sessions)}/${fmtRank(k.post_rerank_rank_rows)}/${fmtRank(k.final_rank_rows)} [${g.class}${g.h3a ? ' H3a' : ''}${g.h3b ? ' H3b' : ''}]`;
      })
      .join('<br>');
    const hyp: string[] = [];
    if (r.h1_signature) hyp.push('H1sig');
    if (r.clause_split.fired) hyp.push(`split(${r.clause_split.pattern})`);
    if (r.clause_split.h1_supported) hyp.push('H1sup');
    if (r.golds.some(g => g.h3a)) hyp.push('H3a');
    if (r.golds.some(g => g.h3b)) hyp.push('H3b');
    if (r.error) hyp.push(`error: ${mdEscape(redactSecrets(r.error))}`);
    L.push(
      `| ${r.question_id} | ${r.question_type} | ${r.splits.join(', ') || '—'} | ${r.gold.join(', ')} | ${r.missing.join(', ') || '—'} | ${mdEscape(ranks)} | ${r.primary_class} | ${hyp.join(', ') || '—'} |`,
    );
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Engine-touching runner
// ---------------------------------------------------------------------------

export interface DiagnosticsRunOpts {
  /** Caller-owned benchmark brain (createBenchmarkBrain()); config table survives resetTables. */
  engine: PGLiteEngine;
  receipt: ParsedReceipt;
  questions: readonly LongMemEvalQuestion[];
  splits?: Record<string, unknown> | null;
  pins: DiagnosticsPins;
  /** The receipt's k. Default: receipt summary pins.top_k → summary.k → 5. */
  k?: number;
  depth?: number;
  fusedLimit?: number;
  /** Diagnose every scored question, not only strict misses. */
  all?: boolean;
  /** Embed cache path (installed through the harness seam). Omit to run uncached. */
  embedCachePath?: string | null;
  /** Transport the cache serves misses from and that clause probes use (tests inject a fake). */
  embedTransport?: EmbedTransportFn | null;
  /** Only these question_ids (after the miss filter). */
  questionIds?: ReadonlySet<string> | null;
  limit?: number;
  onProgress?: (done: number, total: number, questionId: string) => void;
  onRow?: (row: MissDiagnosticsRow) => void;
}

export interface DiagnosticsRunResult {
  rows: MissDiagnosticsRow[];
  summary: DiagnosticsSummary;
  knobs: ResolvedSearchKnobs;
}

/** Mirror the harness: explicit pins land in the benchmark brain's config table. */
export async function applyPins(engine: PGLiteEngine, pins: DiagnosticsPins): Promise<void> {
  if (pins.mode) await engine.setConfig('search.mode', pins.mode);
  if (pins.reranker !== undefined) await engine.setConfig('search.reranker.enabled', pins.reranker ? 'true' : 'false');
  if (pins.autocut !== undefined) await engine.setConfig('search.autocut', pins.autocut ? 'true' : 'false');
  if (pins.expansionVariantBudget !== undefined) {
    await engine.setConfig('search.expansion_variant_budget', pins.expansionVariantBudget === null ? 'legacy' : String(pins.expansionVariantBudget));
  }
}

/** Depth-paged arm walk: MAX_SEARCH_LIMIT per call, offset paging, dedupe by slug#chunk_id. */
async function walkArm(
  fetch: (limit: number, offset: number, firstPage: boolean) => Promise<SearchResult[]>,
  depth: number,
): Promise<SearchResult[]> {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let first = true;
  while (offset < depth) {
    const limit = Math.min(MAX_SEARCH_LIMIT, depth - offset);
    const page = await fetch(limit, offset, first);
    first = false;
    for (const r of page) {
      const key = `${r.slug}#${r.chunk_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    if (page.length < limit) break;
    offset += limit;
  }
  return out;
}

export async function runDiagnostics(opts: DiagnosticsRunOpts): Promise<DiagnosticsRunResult> {
  const { engine } = opts;
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const fusedLimit = opts.fusedLimit ?? DEFAULT_FUSED_LIMIT;
  const receiptPins = pinsFromReceipt(opts.receipt);
  const k = opts.k ?? receiptPins.top_k ?? opts.receipt.summary?.k ?? 5;
  if (!Number.isInteger(k) || k < 1) throw new Error(`diagnostics: k must be a positive integer (got ${k})`);
  const innerLimit = computeInnerLimit(k);

  await applyPins(engine, opts.pins);
  const modeInput = await loadSearchModeConfig(engine);
  const knobs = resolveSearchMode({
    ...modeInput,
    perCall: {
      expansion: false,
      ...(opts.pins.expansionVariantBudget !== undefined ? { expansion_variant_budget: opts.pins.expansionVariantBudget } : {}),
      ...(opts.pins.reranker !== undefined ? { reranker_enabled: opts.pins.reranker } : {}),
      ...(opts.pins.autocut !== undefined ? { autocut: opts.pins.autocut } : {}),
    },
  });
  const summaryPins: DiagnosticsSummary['pins'] = {
    mode: knobs.resolved_mode,
    reranker: knobs.reranker_enabled,
    autocut: knobs.autocut,
    expansion_variant_budget: knobs.expansion_variant_budget,
  };

  // Embedding column exactly as hybrid.ts resolves it (D7/D11).
  const mergedCfg = await loadConfigWithEngine(engine).catch(() => null);
  const resolvedCol = resolveEmbeddingColumn(undefined, mergedCfg ?? ({ engine: 'pglite' } as GBrainConfig));
  const embedOpts = resolvedCol.embeddingModel
    ? { embeddingModel: resolvedCol.embeddingModel, dimensions: resolvedCol.dimensions }
    : undefined;

  // Embed cache through the harness seam. Clause probes run with it bypassed.
  const cache: EmbeddingCache | null = opts.embedCachePath ? new EmbeddingCache(opts.embedCachePath) : null;
  const realTransport = opts.embedTransport ?? null;
  // Holder object (not a bare `let`): the install handle is re-assigned from
  // inside closures, which TypeScript's flow narrowing cannot see.
  const seam: { installed: InstalledEmbedCache | null } = { installed: null };
  const reinstall = (): void => {
    if (cache) seam.installed = installEmbedCache(cache, { realTransport });
  };
  reinstall();
  const withCacheBypassed = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!cache) return fn();
    seam.installed?.uninstall();
    __setEmbedTransportForTests(realTransport);
    try {
      return await fn();
    } finally {
      reinstall();
    }
  };
  const embedTxn = <T>(fn: () => Promise<T>): Promise<T> => (cache ? cache.withTransaction(fn) : fn());

  const byId = new Map(opts.questions.map(q => [q.question_id, q]));
  let targets = opts.receipt.rows.filter(row => {
    if (row.error) return false;
    if (typeof row.recall_all_hit !== 'boolean') return false;
    if (row.abstention === true || isAbstentionQuestion(row.question_id)) return false;
    if (!opts.all && row.recall_all_hit !== false) return false;
    if (opts.questionIds && !opts.questionIds.has(row.question_id)) return false;
    return byId.has(row.question_id);
  });
  if (opts.limit !== undefined && opts.limit < targets.length) targets = targets.slice(0, opts.limit);

  const rows: MissDiagnosticsRow[] = [];
  try {
    let done = 0;
    for (const receiptRow of targets) {
      const q = byId.get(receiptRow.question_id)!;
      let row: MissDiagnosticsRow;
      try {
        row = await diagnoseOne({
          engine, q, receiptRow, k, depth, fusedLimit, innerLimit, knobs, resolvedCol, embedOpts,
          splits: opts.splits ?? null, pins: opts.pins, embedTxn, withCacheBypassed,
        });
      } catch (err) {
        row = errorRow(q, receiptRow, k, opts.splits ?? null, innerLimit, fusedLimit, knobs, err);
      }
      rows.push(row);
      opts.onRow?.(row);
      done++;
      opts.onProgress?.(done, targets.length, q.question_id);
    }
  } finally {
    if (cache) {
      seam.installed?.uninstall();
      cache.close();
    }
  }

  const cacheStats = cache ? cacheStatsSafe(cache) : null;
  const summary = summarizeDiagnostics(rows, {
    k, depth, fusedLimit, innerLimit, rerankerTopNIn: knobs.reranker_top_n_in, pins: summaryPins,
    questionsScanned: opts.receipt.rows.length, cache: cacheStats,
  });
  return { rows, summary, knobs };
}

function cacheStatsSafe(cache: EmbeddingCache): DiagnosticsSummary['cache'] {
  const s = cache.stats();
  return { path: s.path, hits: s.hits, misses: s.misses, bypassed: s.bypassed, infra_faults: s.infra_faults };
}

/**
 * The row stamped when `diagnoseOne` throws. The error text is secret-redacted
 * (`redactSecrets`) BEFORE it lands on the receipt: a provider/DB failure
 * message can carry a connection string or an API key.
 */
export function errorRow(
  q: LongMemEvalQuestion,
  receiptRow: ReceiptRow,
  k: number,
  splits: Record<string, unknown> | null,
  innerLimit: number,
  fusedLimit: number,
  knobs: ResolvedSearchKnobs,
  err: unknown,
): MissDiagnosticsRow {
  const error = redactSecrets(String((err as Error)?.message ?? err));
  const gold = Array.from(new Set(q.answer_session_ids ?? []));
  const top = new Set(receiptTopKSessions(receiptRow, k, buildSlugToRawMap(q)));
  return {
    kind: 'lme_miss_diagnostics',
    question_id: q.question_id,
    question: q.question,
    question_type: q.question_type,
    splits: splitMembership(q.question_id, splits),
    k,
    gold_total: gold.length,
    gold,
    missing: gold.filter(g => !top.has(g)),
    receipt_recall_all_hit: typeof receiptRow.recall_all_hit === 'boolean' ? receiptRow.recall_all_hit : null,
    golds: [],
    primary_class: 'mixed',
    h1_signature: false,
    clause_split: { fired: false, pattern: null, reason: null, clauses: [], probes: [], h1_supported: false },
    rerun: {
      fused_limit: fusedLimit, inner_limit: innerLimit, reranker_top_n_in: knobs.reranker_top_n_in,
      reranker_ran: false, vector_enabled: false, degraded: [], expansion_replayed: false, distinct_sessions_fused: 0,
    },
    error,
  };
}

interface DiagnoseOneCtx {
  engine: PGLiteEngine;
  q: LongMemEvalQuestion;
  receiptRow: ReceiptRow;
  k: number;
  depth: number;
  fusedLimit: number;
  innerLimit: number;
  knobs: ResolvedSearchKnobs;
  resolvedCol: ReturnType<typeof resolveEmbeddingColumn>;
  embedOpts: { embeddingModel?: string; dimensions?: number } | undefined;
  splits: Record<string, unknown> | null;
  pins: DiagnosticsPins;
  embedTxn: <T>(fn: () => Promise<T>) => Promise<T>;
  withCacheBypassed: <T>(fn: () => Promise<T>) => Promise<T>;
}

async function diagnoseOne(ctx: DiagnoseOneCtx): Promise<MissDiagnosticsRow> {
  const { engine, q, receiptRow, k, depth, fusedLimit, innerLimit, knobs } = ctx;
  const slugToRaw = buildSlugToRawMap(q);
  const gold = Array.from(new Set(q.answer_session_ids ?? []));
  const inHaystack = new Set<string>();
  for (const raws of slugToRaw.values()) for (const r of raws) inHaystack.add(r);
  const receiptTop = new Set(receiptTopKSessions(receiptRow, k, slugToRaw));
  const missing = gold.filter(g => !receiptTop.has(g));

  // Re-create the brain exactly as the harness did.
  await resetTables(engine);
  const pages = haystackToPages(q);

  let meta: HybridSearchMeta | undefined;
  let pool: SearchResult[] = [];
  let preRerank: SearchResult[] = [];
  const variants = Array.isArray(receiptRow.expansion_variants) && receiptRow.expansion_variants.length > 0
    ? receiptRow.expansion_variants
    : null;

  const armOpts: SearchOpts = { embeddingColumn: ctx.resolvedCol };
  const { vectorRows, keywordRows, titleRows, fusedResults } = await ctx.embedTxn(async () => {
    for (const p of pages) await importFromContent(engine, p.slug, p.content, { noEmbed: false });

    // Same gateway path hybridSearch embeds the query through (embedQuery →
    // the cache transport), so under an installed cache this is a hit.
    const emb = await embedQuery(q.question, ctx.embedOpts);
    const vectorRows = await walkArm((limit, offset) => engine.searchVector(emb, { ...armOpts, limit, offset }), depth);
    let firstPageRelaxed = false;
    const keywordRows = await walkArm(async (limit, offset, firstPage) => {
      const rows = await engine.searchKeyword(q.question, {
        ...armOpts, limit, offset,
        // hybrid opts in to the AND→OR fallback; later pages only keep it when the first page was relaxed
        orFallback: firstPage ? knobs.keywordOrFallback : firstPageRelaxed && knobs.keywordOrFallback,
      });
      if (firstPage) firstPageRelaxed = rows.some(r => r.keyword_relaxed === true);
      return rows;
    }, depth);
    let titleRows: SearchResult[] = [];
    try {
      titleRows = await engine.searchTitles(q.question, { ...armOpts, limit: MAX_SEARCH_LIMIT });
    } catch {
      /* title arm is fail-open in hybrid too */
    }

    const searchOpts: HybridSearchOpts = {
      limit: fusedLimit,
      expansion: variants !== null,
      ...(variants ? { expandFn: async () => variants } : {}),
      ...(ctx.pins.expansionVariantBudget !== undefined ? { expansionVariantBudget: ctx.pins.expansionVariantBudget } : {}),
      onMeta: (m) => { meta = m; },
      onRerankPool: (p, pre) => { pool = [...p]; preRerank = [...pre]; },
    };
    const fusedResults = await hybridSearch(engine, q.question, searchOpts);
    return { vectorRows, keywordRows, titleRows, fusedResults };
  });

  const degraded: string[] = (meta?.degraded ?? []).map(d => String(d.stage));
  // resume.ts owns the reranker-skipped stage vocabulary (one definition for the live row, the resume re-scan and this rerun).
  const rerankerRan = pool.some(r => Number.isFinite(r.rerank_score)) && !classifyDegradation(meta, { keywordOnly: false, expansion: false }).rerankerSkipped;

  const vRank = sessionRowRanks(vectorRows, slugToRaw);
  const kRank = sessionRowRanks(keywordRows, slugToRaw);
  const kRelaxed = new Map<string, boolean>();
  for (const r of keywordRows) {
    const sid = rawSessionId(r.slug, slugToRaw);
    if (!kRelaxed.has(sid)) kRelaxed.set(sid, r.keyword_relaxed === true);
  }
  const tRank = sessionRowRanks(titleRows, slugToRaw);
  const fRows = sessionRowRanks(preRerank, slugToRaw);
  const fSess = sessionDistinctRanks(preRerank, slugToRaw);
  const pRows = sessionRowRanks(pool, slugToRaw);
  const pSess = sessionDistinctRanks(pool, slugToRaw);
  const finalRows = sessionRowRanks(fusedResults, slugToRaw);

  const golds: GoldDiagnostics[] = gold.map(sid => {
    const ranks: ArmRanks = {
      vector_rank: vRank.get(sid) ?? null,
      keyword_rank: kRank.get(sid) ?? null,
      keyword_relaxed: kRelaxed.get(sid) ?? false,
      title_rank: tRank.get(sid) ?? null,
      fused_rank_rows: fRows.get(sid) ?? null,
      fused_rank_sessions: fSess.get(sid) ?? null,
      post_rerank_rank_rows: rerankerRan ? (pRows.get(sid) ?? null) : null,
      post_rerank_rank_sessions: rerankerRan ? (pSess.get(sid) ?? null) : null,
      final_rank_rows: finalRows.get(sid) ?? null,
    };
    const cls = classifyMiss({
      ranks, k, gold_total: gold.length, reranker_ran: rerankerRan,
      in_receipt_top_k: receiptTop.has(sid), in_haystack: inHaystack.has(sid),
    });
    const h3 = h3Candidates({ vector_rank: ranks.vector_rank, fused_rank_rows: ranks.fused_rank_rows, inner_limit: innerLimit, reranker_top_n_in: knobs.reranker_top_n_in });
    return { session_id: sid, in_haystack: inHaystack.has(sid), in_receipt_top_k: receiptTop.has(sid), ranks, class: cls, h3a: h3.h3a, h3b: h3.h3b };
  });

  const missingClasses = new Set(golds.filter(g => missing.includes(g.session_id)).map(g => g.class));
  const primary: MissClass | 'mixed' = missing.length === 0 ? 'hit' : missingClasses.size === 1 ? [...missingClasses][0] : 'mixed';

  const h1 = golds.some(g =>
    missing.includes(g.session_id) &&
    h1Signature(golds.filter(o => o.session_id !== g.session_id).map(o => o.ranks.fused_rank_sessions), g.ranks.fused_rank_sessions),
  );

  // Counterfactual clause sub-queries (cache bypassed: never pollute the shared cache).
  const split = splitClausesDetailed(q.question);
  const probes: ClauseProbe[] = [];
  if (split.clauses.length === 2 && missing.length > 0) {
    await ctx.withCacheBypassed(async () => {
      for (const clause of split.clauses) {
        const emb = await embedQuery(clause, ctx.embedOpts);
        const top = await engine.searchVector(emb, { ...armOpts, limit: 5 });
        const sessions = [...sessionDistinctRanks(top, slugToRaw).keys()];
        probes.push({ clause, top5_sessions: sessions, hits_missing: missing.filter(m => sessions.includes(m)) });
      }
    });
  }

  return {
    kind: 'lme_miss_diagnostics',
    question_id: q.question_id,
    question: q.question,
    question_type: q.question_type,
    splits: splitMembership(q.question_id, ctx.splits),
    k,
    gold_total: gold.length,
    gold,
    missing,
    receipt_recall_all_hit: typeof receiptRow.recall_all_hit === 'boolean' ? receiptRow.recall_all_hit : null,
    golds,
    primary_class: primary,
    h1_signature: h1,
    clause_split: {
      fired: split.clauses.length === 2,
      pattern: split.pattern,
      reason: split.reason,
      clauses: split.clauses,
      probes,
      h1_supported: probes.some(p => p.hits_missing.length > 0),
    },
    rerun: {
      fused_limit: fusedLimit,
      inner_limit: innerLimit,
      reranker_top_n_in: knobs.reranker_top_n_in,
      reranker_ran: rerankerRan,
      vector_enabled: meta?.vector_enabled ?? false,
      degraded,
      expansion_replayed: variants !== null,
      distinct_sessions_fused: fSess.size,
    },
  };
}
