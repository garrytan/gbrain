/**
 * LongMemEval strict-recall metrics: raw-id join, recall_all@k / recall_any@k,
 * per-type buckets, the schema-v2 by_type_summary, and the per-question row
 * assembler.
 *
 * INVARIANT: pure. No engine, no I/O, no LLM. Every function here is a
 * deterministic transform over search rows + dataset fields, so the harness
 * (src/commands/eval-longmemeval.ts) and the tests score the same bytes.
 *
 * INVARIANT: the join is on RAW session ids. `haystackToPages` lowercases and
 * hyphenates ids to build slugs (`sharegpt_yywfIrx_0` -> `chat/sharegpt-yywfirx-0`),
 * so a slug-tail compared against `answer_session_ids` never matches on the
 * public _s split. `buildSlugToRawMap` inverts the slug construction per
 * question and `distinctRetrievedSessions` joins through it; `normalizeSessionId`
 * exists only for slug construction / fallback, never for the gold compare.
 *
 * INVARIANT: k semantics. `recall_*@k` is scored over the DISTINCT sessions
 * among the top-k CHUNK rows returned at `limit: k` (the receipt's
 * "distinct sessions in the top 5" reading), not over k distinct sessions.
 * The caller slices `results.slice(0, k)` BEFORE calling `scoreRecall`.
 */

import type { SearchResult } from '../../core/types.ts';
import {
  normalizeSessions,
  sanitizeSessionIdForSlug,
  type LongMemEvalQuestion,
} from './adapter.ts';

/** Slug prefix `haystackToPages` stamps on every session page. */
export const SESSION_SLUG_PREFIX = 'chat/';

/**
 * Slug-side normalization of a raw session id. Identical to the adapter's
 * `sanitizeSessionIdForSlug` — kept under a metrics-facing name so call sites
 * that build a slug for a raw id say what they mean. NOT for gold comparison.
 */
export const normalizeSessionId: (sessionId: string) => string = sanitizeSessionIdForSlug;

/**
 * Slug tail after `chat/`. Falls back to the tail after the first `/`, then to
 * the slug itself, so a non-`chat/` slug still yields a stable id. Returns the
 * NORMALIZED id (lowercase, hyphenated); use `distinctRetrievedSessions` with a
 * `SlugToRawMap` to recover the raw dataset id.
 */
export function sessionIdFromSlug(slug: string): string {
  if (slug.startsWith(SESSION_SLUG_PREFIX)) return slug.slice(SESSION_SLUG_PREFIX.length);
  const idx = slug.indexOf('/');
  return idx >= 0 ? slug.slice(idx + 1) : slug;
}

/** LongMemEval abstention questions carry an `_abs` suffix on question_id. */
export function isAbstentionQuestion(questionId: string): boolean {
  return /_abs$/.test(questionId);
}

/** `chat/<normalized>` slug -> the raw session id(s) that produced it (haystack order, deduped). */
export type SlugToRawMap = Map<string, string[]>;

/**
 * Per-question inverse of the slug construction in `haystackToPages`: every
 * haystack session's raw id is filed under the slug it imports as. Two raw
 * ids that normalize to the same slug (`a_b` / `a-b`, `Foo` / `foo`) share one
 * entry; identical raw ids repeated in the haystack are deduped (that is a
 * duplicate page, not a join ambiguity).
 */
export function buildSlugToRawMap(question: LongMemEvalQuestion): SlugToRawMap {
  const map: SlugToRawMap = new Map();
  for (const session of normalizeSessions(question)) {
    const slug = `${SESSION_SLUG_PREFIX}${normalizeSessionId(session.session_id)}`;
    const list = map.get(slug);
    if (!list) map.set(slug, [session.session_id]);
    else if (!list.includes(session.session_id)) list.push(session.session_id);
  }
  return map;
}

/** Slugs that more than one distinct raw session id normalizes to (sorted). */
export function detectSlugCollisions(map: SlugToRawMap): string[] {
  const out: string[] = [];
  for (const [slug, raws] of map) if (raws.length > 1) out.push(slug);
  return out.sort();
}

/**
 * Colliding slugs whose raw-id set contains a gold id. A collision here makes
 * the join ambiguous for the metric, so the harness emits an error row for
 * the question instead of scoring it (plan D32).
 */
export function collisionsTouchingGold(map: SlugToRawMap, goldRaw: readonly string[]): string[] {
  const gold = new Set(goldRaw);
  return detectSlugCollisions(map).filter(slug => (map.get(slug) ?? []).some(r => gold.has(r)));
}

/** Gold raw ids that no haystack session carries (dataset defect, counted per row + in the summary). */
export function goldMissingFromHaystack(map: SlugToRawMap, goldRaw: readonly string[]): string[] {
  const present = new Set<string>();
  for (const raws of map.values()) for (const r of raws) present.add(r);
  return uniq(goldRaw).filter(g => !present.has(g));
}

export interface RetrievedSession {
  /** RAW dataset session id when the slug is in the map; normalized slug tail otherwise. */
  session_id: string;
  /** 1-based rank over DISTINCT sessions in first-occurrence order. */
  rank: number;
  /** Score of the session's best (first-seen) chunk row. */
  score: number;
  rerank_score?: number;
}

/**
 * Collapse chunk rows to distinct sessions in first-occurrence order. The
 * session id is resolved through `slugToRaw` (raw dataset id); a slug absent
 * from the map (or no map) falls back to the normalized slug tail. On a
 * colliding slug the FIRST raw id in haystack order is reported — the harness
 * refuses to score gold-touching collisions, so this only affects non-gold
 * sessions in replay rows.
 */
export function distinctRetrievedSessions(
  results: readonly SearchResult[],
  slugToRaw?: SlugToRawMap,
): RetrievedSession[] {
  const seen = new Set<string>();
  const out: RetrievedSession[] = [];
  for (const r of results) {
    const sid = rawSessionId(r.slug, slugToRaw);
    if (seen.has(sid)) continue;
    seen.add(sid);
    const entry: RetrievedSession = { session_id: sid, rank: out.length + 1, score: r.score };
    if (Number.isFinite(r.rerank_score)) entry.rerank_score = r.rerank_score;
    out.push(entry);
  }
  return out;
}

export interface RecallScore {
  /** Every gold session is among the distinct sessions (false when gold is empty). */
  recall_all_hit: boolean;
  /** At least one gold session is among the distinct sessions. */
  recall_any_hit: boolean;
  /** Distinct gold ids. */
  gold_total: number;
  /** Gold ids found among the distinct retrieved sessions. */
  gold_found: number;
  /** Distinct sessions among the top-k chunk rows (0 when nothing was retrieved). */
  distinct_sessions_in_top_k: number;
}

/**
 * Score recall_all@k / recall_any@k.
 *
 * `retrievedRawIds` is the DISTINCT session list (first-occurrence order)
 * derived from the top-k CHUNK rows — the caller passes
 * `distinctRetrievedSessions(results.slice(0, k), map)` ids. `k` is a guard
 * only: the list can never exceed k entries when the caller sliced rows
 * first, and a k larger than the row count simply scores what came back.
 * Empty gold scores both hits false (NOT vacuously true); the harness keeps
 * such rows out of the recall denominator.
 */
export function scoreRecall(
  retrievedRawIds: readonly string[],
  goldRaw: readonly string[],
  k: number,
): RecallScore {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`scoreRecall: k must be a positive integer (got ${k})`);
  const distinct = uniq(retrievedRawIds).slice(0, k);
  const retrieved = new Set(distinct);
  const gold = uniq(goldRaw);
  const found = gold.filter(g => retrieved.has(g)).length;
  return {
    recall_all_hit: gold.length > 0 && found === gold.length,
    recall_any_hit: found > 0,
    gold_total: gold.length,
    gold_found: found,
    distinct_sessions_in_top_k: distinct.length,
  };
}

export interface RecallBucket {
  total: number;
  any_hit: number;
  all_hit: number;
  /** Rows that carried only the deprecated `recall_hit` (any-only; no all_hit contribution). */
  legacy_rows: number;
}

export function newBucket(): RecallBucket {
  return { total: 0, any_hit: 0, all_hit: 0, legacy_rows: 0 };
}

export type BucketAddOutcome = 'scored' | 'legacy' | 'skipped';

/**
 * Fold one per-question row into a bucket. A v2 row (`recall_all_hit` +
 * `recall_any_hit` booleans) counts toward both; a legacy row with only
 * `recall_hit` counts toward `total` + `any_hit` and bumps `legacy_rows`
 * (its all_rate is therefore a lower bound); a row with neither is skipped
 * (no gold — not in the denominator).
 */
export function addRowToBucket(
  bucket: RecallBucket,
  row: { recall_all_hit?: unknown; recall_any_hit?: unknown; recall_hit?: unknown },
): BucketAddOutcome {
  if (typeof row.recall_all_hit === 'boolean' && typeof row.recall_any_hit === 'boolean') {
    bucket.total++;
    if (row.recall_any_hit) bucket.any_hit++;
    if (row.recall_all_hit) bucket.all_hit++;
    return 'scored';
  }
  const legacyAny = typeof row.recall_any_hit === 'boolean' ? row.recall_any_hit
    : typeof row.recall_hit === 'boolean' ? row.recall_hit
    : undefined;
  if (legacyAny === undefined) return 'skipped';
  bucket.total++;
  bucket.legacy_rows++;
  if (legacyAny) bucket.any_hit++;
  return 'legacy';
}

export interface RecallTypeStats {
  total: number;
  all_hit: number;
  all_rate: number | null;
  any_hit: number;
  any_rate: number | null;
}

/**
 * Minimum shape of the judged-answer block on the summary. The full block is
 * `QaAccuracyBlock` (./qa-accuracy.ts) — a type alias, so it satisfies this
 * index-signature interface structurally.
 */
export interface QaAccuracySummary {
  judged: number;
  correct: number;
  accuracy: number | null;
  judge_errors: number;
  [extra: string]: unknown;
}

export interface ByTypeSummaryV2 {
  schema_version: 2;
  kind: 'by_type_summary';
  metric: 'recall_all@k';
  k: number;
  /** Abstention (`_abs`) rows kept out of the recall denominators. */
  excluded_abstention: number;
  recall_by_type: Record<string, RecallTypeStats>;
  aggregate: RecallTypeStats;
  /** Rows folded from the deprecated any-only `recall_hit` (0 on a fresh v2 run). */
  legacy_rows: number;
  /** Questions whose gold names a session absent from their haystack. */
  gold_missing_from_haystack: number;
  /** Questions with at least one slug collision. */
  slug_collisions: number;
  mean_distinct_sessions?: number;
  run_config: Record<string, unknown>;
  qa_accuracy?: QaAccuracySummary;
}

export interface ByTypeSummaryContext {
  k: number;
  excludedAbstention: number;
  goldMissingFromHaystack: number;
  slugCollisions: number;
  runConfig: Record<string, unknown>;
  /** Per-scored-row `distinct_sessions_in_top_k`; mean emitted when non-empty. */
  distinctSessionsInTopK?: readonly number[];
  qa?: QaAccuracySummary;
}

/** Schema-v2 by_type_summary (replaces v1; sorted type keys; null rates on empty buckets). */
export function buildByTypeSummaryV2(
  buckets: Record<string, RecallBucket>,
  ctx: ByTypeSummaryContext,
): ByTypeSummaryV2 {
  const recall: Record<string, RecallTypeStats> = {};
  const agg = newBucket();
  for (const type of Object.keys(buckets).sort()) {
    const b = buckets[type];
    recall[type] = bucketStats(b);
    agg.total += b.total;
    agg.any_hit += b.any_hit;
    agg.all_hit += b.all_hit;
    agg.legacy_rows += b.legacy_rows;
  }
  const summary: ByTypeSummaryV2 = {
    schema_version: 2,
    kind: 'by_type_summary',
    metric: 'recall_all@k',
    k: ctx.k,
    excluded_abstention: ctx.excludedAbstention,
    recall_by_type: recall,
    aggregate: bucketStats(agg),
    legacy_rows: agg.legacy_rows,
    gold_missing_from_haystack: ctx.goldMissingFromHaystack,
    slug_collisions: ctx.slugCollisions,
    run_config: ctx.runConfig,
  };
  if (ctx.distinctSessionsInTopK && ctx.distinctSessionsInTopK.length > 0) {
    const xs = ctx.distinctSessionsInTopK;
    summary.mean_distinct_sessions = xs.reduce((a, b) => a + b, 0) / xs.length;
  }
  if (ctx.qa) summary.qa_accuracy = ctx.qa;
  return summary;
}

export interface RetrievedRow {
  slug: string;
  chunk_id: number;
  /** RAW session id via the map (normalized tail when unmapped). */
  session_id: string;
  /** 1-based rank over CHUNK rows. */
  rank: number;
  score: number;
  rerank_score?: number;
  alias_hit?: boolean;
}

export interface BuildRowInput {
  question: LongMemEvalQuestion;
  hypothesis: string;
  /** Chunk rows returned at `limit: k`, in returned order (NOT pre-sliced; buildRow slices). */
  results: readonly SearchResult[];
  k: number;
  slugToRaw: SlugToRawMap;
  mode?: string;
  /** Harness-owned passthrough fields (trajectory, search_meta, run_config_hash, ...). */
  extra?: Record<string, unknown>;
}

export interface LongMemEvalRow {
  question_id: string;
  question: string;
  question_type: string;
  answer?: string;
  hypothesis: string;
  abstention: boolean;
  /** Present only when the question has gold session ids. */
  recall_all_hit?: boolean;
  recall_any_hit?: boolean;
  /** Deprecated alias of `recall_any_hit` (back-compat for v1 readers). */
  recall_hit?: boolean;
  gold_total: number;
  gold_found: number;
  distinct_sessions_in_top_k: number;
  /** Every returned chunk row, rank 1-based. */
  retrieved: RetrievedRow[];
  /** Distinct RAW session ids in first-occurrence order over ALL returned rows. */
  retrieved_session_ids: string[];
  gold_missing_from_haystack: string[];
  /** Number of colliding slugs in this question's haystack. */
  slug_collision: number;
  mode?: string;
  [extra: string]: unknown;
}

/**
 * Assemble the per-question JSONL row. Recall fields are scored over the
 * distinct sessions in `results.slice(0, k)`; `retrieved` /
 * `retrieved_session_ids` cover every returned row so replay can re-score at
 * any k' <= rows. `extra` keys are spread last but never override the scored
 * fields.
 */
export function buildRow(input: BuildRowInput): LongMemEvalRow {
  const { question: q, results, k, slugToRaw } = input;
  const goldRaw = q.answer_session_ids ?? [];
  const topK = results.slice(0, k);
  const distinct = distinctRetrievedSessions(topK, slugToRaw);
  const score = scoreRecall(distinct.map(s => s.session_id), goldRaw, k);
  const retrieved: RetrievedRow[] = results.map((r, i) => {
    const row: RetrievedRow = {
      slug: r.slug,
      chunk_id: r.chunk_id,
      session_id: rawSessionId(r.slug, slugToRaw),
      rank: i + 1,
      score: r.score,
    };
    if (Number.isFinite(r.rerank_score)) row.rerank_score = r.rerank_score;
    if (r.alias_hit === true) row.alias_hit = true;
    return row;
  });
  const scored: LongMemEvalRow = {
    ...(input.extra ?? {}),
    question_id: q.question_id,
    question: q.question,
    question_type: q.question_type,
    ...(q.answer !== undefined ? { answer: q.answer } : {}),
    hypothesis: input.hypothesis,
    abstention: isAbstentionQuestion(q.question_id),
    ...(score.gold_total > 0
      ? { recall_all_hit: score.recall_all_hit, recall_any_hit: score.recall_any_hit, recall_hit: score.recall_any_hit }
      : {}),
    gold_total: score.gold_total,
    gold_found: score.gold_found,
    answer_session_ids: goldRaw,
    distinct_sessions_in_top_k: score.distinct_sessions_in_top_k,
    retrieved,
    retrieved_session_ids: distinctRetrievedSessions(results, slugToRaw).map(s => s.session_id),
    gold_missing_from_haystack: goldMissingFromHaystack(slugToRaw, goldRaw),
    slug_collision: detectSlugCollisions(slugToRaw).length,
    ...(input.mode ? { mode: input.mode } : {}),
  };
  return scored;
}

/**
 * RAW dataset session id for a slug through the per-question map; the
 * normalized slug tail when the slug is unmapped (or no map is given). On a
 * colliding slug the FIRST raw id in haystack order is returned. The ONE
 * slug→raw resolver: the reader, the capture receipt and the miss
 * diagnostics all join through this function.
 */
export function rawSessionId(slug: string, slugToRaw?: SlugToRawMap): string {
  const raws = slugToRaw?.get(slug);
  return raws && raws.length > 0 ? raws[0] : sessionIdFromSlug(slug);
}

// ---------------------------------------------------------------------------

function bucketStats(b: RecallBucket): RecallTypeStats {
  return {
    total: b.total,
    all_hit: b.all_hit,
    all_rate: b.total === 0 ? null : b.all_hit / b.total,
    any_hit: b.any_hit,
    any_rate: b.total === 0 ? null : b.any_hit / b.total,
  };
}

function uniq<T>(xs: readonly T[]): T[] {
  return Array.from(new Set(xs));
}
