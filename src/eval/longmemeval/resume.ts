/**
 * resume.ts — reading a prior run's JSONL back: row scanning, the
 * `retrieval_config_hash` mixed-run check, expansion-variant replay maps, and
 * re-scoring per-type buckets from rows + the dataset's gold.
 *
 * INVARIANT: recall is RECOMPUTED, never trusted. On resume every row's
 * recall_all/any is re-derived from its `retrieved[]` (top-k chunk rows →
 * distinct RAW session ids) or, for older rows, `retrieved_session_ids`,
 * joined against the dataset's gold. A pre-stamp row whose ids are slug-tail
 * normalized (lowercased, `_`/`.` → `-`) is mapped back to the RAW haystack id
 * through `SeedContext.haystackByQid` when the harness supplies it (the
 * dataset is loaded on resume); without that map such a row scores false
 * instead of poisoning the summary. There is no legacy any-only counter
 * (plan 0g).
 *
 * INVARIANT: pure given its inputs (file reads are the only I/O; no engine).
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  addRowToBucket,
  isAbstentionQuestion,
  newBucket,
  normalizeSessionId,
  scoreRecall,
  type RecallBucket,
} from './metrics.ts';

/**
 * Parse a JSONL file into rows; corrupt lines are skipped (SIGKILL tail).
 * Question rows are deduped LAST-WINS per question_id (a same-file resume
 * APPENDS judged-backfill rows and retries as newer duplicates and compacts
 * only at run end — see emit.ts compactJsonlByQuestionId), keeping the
 * first-seen position; non-question rows (summary) pass through in place.
 */
export function readJsonlRows(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  const slot = new Map<string, number>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!(row && typeof row === 'object' && !Array.isArray(row))) continue;
      const r = row as Record<string, unknown>;
      if (typeof r.question_id === 'string' && r.kind !== 'by_type_summary') {
        const at = slot.get(r.question_id);
        if (at === undefined) { slot.set(r.question_id, out.length); out.push(r); }
        else out[at] = r;
      } else out.push(r);
    } catch {
      // corrupt line — the resume loader logs these; here we just skip
    }
  }
  return out;
}

/** A per-question row (not a summary, not an error row awaiting retry). */
export function isScoredQuestionRow(row: Record<string, unknown>): boolean {
  if (row.kind === 'by_type_summary') return false;
  if (typeof row.question_id !== 'string') return false;
  if (typeof row.error === 'string' && (!row.hypothesis || row.hypothesis === '')) return false;
  return true;
}

export interface ResumeHashCheck {
  /** Rows stamped with a DIFFERENT retrieval_config_hash than this run's. */
  mismatched: number;
  /** Rows with no hash at all (written before the stamp existed). */
  unstamped: number;
  /** Distinct foreign hashes seen (for the refusal message). */
  foreign: string[];
}

/**
 * Plan D33: a resume file whose rows were produced under different retrieval
 * pins must not be silently merged with this run's rows. Unstamped rows are
 * reported but tolerated (pre-stamp files carry no evidence either way).
 */
export function checkResumeConfigHash(
  rows: ReadonlyArray<Record<string, unknown>>,
  currentHash: string,
): ResumeHashCheck {
  let mismatched = 0;
  let unstamped = 0;
  const foreign = new Set<string>();
  for (const row of rows) {
    if (!isScoredQuestionRow(row)) continue;
    const h = row.retrieval_config_hash;
    if (typeof h !== 'string') { unstamped++; continue; }
    if (h !== currentHash) { mismatched++; foreign.add(h); }
  }
  return { mismatched, unstamped, foreign: [...foreign].sort() };
}

/**
 * `--expansion-replay FILE`: question_id → recorded `expansion_variants`
 * (the full list the live `expandFn` returned, original included). Rows
 * without a variants array (keyword-only runs, error rows) are ignored.
 */
export function loadExpansionReplay(path: string): Map<string, string[]> {
  if (!existsSync(path)) throw new Error(`--expansion-replay file not found: ${path}`);
  const map = new Map<string, string[]>();
  for (const row of readJsonlRows(path)) {
    if (typeof row.question_id !== 'string') continue;
    const v = row.expansion_variants;
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) continue;
    map.set(row.question_id, v as string[]);
  }
  return map;
}

/**
 * Distinct session ids over the row's top-k CHUNK rows. Prefers `retrieved[]`
 * (rank-ordered chunk rows with RAW session ids); falls back to
 * `retrieved_session_ids` (already distinct, first-occurrence order — the
 * pre-`retrieved[]` row shape, where every returned row was a top-k row).
 */
export function retrievedIdsAtK(row: Record<string, unknown>, k: number): string[] {
  const retrieved = row.retrieved;
  if (Array.isArray(retrieved)) {
    const ids: string[] = [];
    for (const r of retrieved.slice(0, k)) {
      const sid = (r as { session_id?: unknown })?.session_id;
      if (typeof sid === 'string' && !ids.includes(sid)) ids.push(sid);
    }
    return ids;
  }
  const flat = row.retrieved_session_ids;
  if (Array.isArray(flat)) return (flat.filter(x => typeof x === 'string') as string[]).slice(0, k);
  return [];
}

export interface SeedContext {
  /** question_id → RAW gold session ids (from the dataset loaded on resume). */
  goldByQid: ReadonlyMap<string, readonly string[]>;
  k: number;
  includeAbstention: boolean;
  /**
   * question_id → RAW haystack session ids. When present, a retrieved id that
   * is not a raw id but equals the slug-normalized form of exactly one raw id
   * is scored as that raw id (legacy pre-stamp rows carried normalized ids).
   */
  haystackByQid?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Map legacy normalized ids back to RAW haystack ids. An id already present in
 * the haystack passes through; otherwise the unique raw id whose normalized
 * form equals it is used; an ambiguous (colliding) or unknown id is kept as-is
 * (and so scores as a miss, never as a false hit).
 */
export function rawifyRetrievedIds(ids: readonly string[], haystack: readonly string[] | undefined): string[] {
  if (!haystack || haystack.length === 0) return [...ids];
  const raw = new Set(haystack);
  const byNormalized = new Map<string, string[]>();
  for (const h of haystack) {
    const n = normalizeSessionId(h);
    const list = byNormalized.get(n);
    if (list) { if (!list.includes(h)) list.push(h); } else byNormalized.set(n, [h]);
  }
  const out: string[] = [];
  for (const id of ids) {
    if (raw.has(id)) { if (!out.includes(id)) out.push(id); continue; }
    const cands = byNormalized.get(id);
    const mapped = cands && cands.length === 1 ? cands[0] : id;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export interface SeedResult {
  /** Rows folded into a bucket. */
  seeded: number;
  excludedAbstention: number;
  /** Rows skipped: not in the dataset, no gold, error/summary rows. */
  skipped: number;
  /** Per-seeded-row distinct_sessions_in_top_k (for mean_distinct_sessions). */
  distinct: number[];
  /**
   * Rows whose gold names a session absent from their haystack. Counted over
   * EVERY question row (abstention, no-gold and error rows included) — the
   * same set the live harness counts — so `run_config.gold_missing_from_haystack`
   * is identical for a fresh run and a resume of the same file.
   */
  goldMissing: number;
  /** Rows with at least one slug collision (same row set as `goldMissing`; a collision-abort error row counts). */
  collisions: number;
}

/**
 * Fold prior rows into per-type buckets by RECOMPUTING both metrics from the
 * row's retrieved ids + the dataset's gold. Abstention rows (`_abs` id or
 * `abstention: true`) stay out of the denominators unless `includeAbstention`.
 */
export function seedBucketsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  buckets: Record<string, RecallBucket>,
  ctx: SeedContext,
): SeedResult {
  const res: SeedResult = { seeded: 0, excludedAbstention: 0, skipped: 0, distinct: [], goldMissing: 0, collisions: 0 };
  for (const row of rows) {
    if (row.kind === 'by_type_summary' || typeof row.question_id !== 'string') { res.skipped++; continue; }
    if (Array.isArray(row.gold_missing_from_haystack) && row.gold_missing_from_haystack.length > 0) res.goldMissing++;
    if (typeof row.slug_collision === 'number' && row.slug_collision > 0) res.collisions++;
    if (!isScoredQuestionRow(row) || typeof row.question_type !== 'string') { res.skipped++; continue; }
    const qid = row.question_id as string;
    const gold = ctx.goldByQid.get(qid);
    if (!gold) { res.skipped++; continue; }
    const abstention = isAbstentionQuestion(qid) || row.abstention === true;
    if (abstention && !ctx.includeAbstention) { res.excludedAbstention++; continue; }
    if (gold.length === 0) { res.skipped++; continue; }
    const score = scoreRecall(rawifyRetrievedIds(retrievedIdsAtK(row, ctx.k), ctx.haystackByQid?.get(qid)), gold, ctx.k);
    const bucket = buckets[row.question_type] ?? (buckets[row.question_type] = newBucket());
    addRowToBucket(bucket, { recall_all_hit: score.recall_all_hit, recall_any_hit: score.recall_any_hit });
    res.seeded++;
    res.distinct.push(score.distinct_sessions_in_top_k);
  }
  return res;
}

/**
 * `--resume-from`: the question_ids already answered in `resumePath`. Rows
 * whose `hypothesis` is empty AND carry an `error` are NOT counted — those
 * are previous-run failures that should be retried. Missing file → empty set
 * (a first run with the flag behaves exactly like no flag).
 */
export function loadResumeSet(resumePath: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(resumePath)) return done;
  let lineNo = 0;
  // Last row per question_id decides (an appended retry supersedes an error row).
  const last = new Map<string, boolean>();
  for (const line of readFileSync(resumePath, 'utf8').split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    let row: { question_id?: string; hypothesis?: string; error?: string; kind?: string };
    try {
      row = JSON.parse(line);
    } catch {
      process.stderr.write(`[longmemeval] resume: skipping corrupt line ${lineNo}\n`);
      continue;
    }
    if (typeof row.question_id !== 'string' || row.kind === 'by_type_summary') continue;
    last.set(row.question_id, !(row.error && (!row.hypothesis || row.hypothesis === '')));
  }
  for (const [qid, ok] of last) if (ok) done.add(qid);
  return done;
}

/**
 * Seed per-type buckets from an existing output file so the by_type_summary
 * is cumulative across resume runs. Both metrics are RECOMPUTED from each
 * row's retrieved ids + the dataset's gold (`goldByQid`); nothing is trusted
 * from the row's own recall fields. Summary rows and error rows are skipped.
 */
export function seedRecallByTypeFromFile(
  outputPath: string,
  buckets: Record<string, RecallBucket>,
  ctx: { goldByQid: ReadonlyMap<string, readonly string[]>; k: number; includeAbstention?: boolean; haystackByQid?: ReadonlyMap<string, readonly string[]> },
): SeedResult {
  return seedBucketsFromRows(readJsonlRows(outputPath), buckets, {
    goldByQid: ctx.goldByQid,
    k: ctx.k,
    includeAbstention: ctx.includeAbstention ?? false,
    ...(ctx.haystackByQid ? { haystackByQid: ctx.haystackByQid } : {}),
  });
}

// ---------------------------------------------------------------------------
// Silent-degradation classification (shared by the live row and the resume re-scan)
// ---------------------------------------------------------------------------

/** The `search_meta` shape the harness stamps on every row (also read back on resume). */
export interface RowSearchMeta {
  vector_enabled?: boolean;
  degraded?: Array<{ stage?: string }>;
}

const VECTOR_DEGRADED_STAGES: ReadonlySet<string> = new Set(['embed_unavailable', 'embed_timeout']);
const EXPANSION_FAILED_STAGES: ReadonlySet<string> = new Set(['expansion_failed', 'expansion_partial']);
const RERANKER_SKIPPED_STAGES: ReadonlySet<string> = new Set(['reranker_skipped', 'rerank_passthrough']);

/**
 * Silent-degradation classifier shared by the live row and the resume
 * re-scan. hybridSearch swallows an embed/expansion failure into `degraded`
 * and scores the row keyword-only — for a like-for-like receipt that row is
 * NOT the configured arm, so the run must not exit 0.
 */
export function classifyDegradation(meta: RowSearchMeta | undefined, opts: { keywordOnly: boolean; expansion: boolean }): {
  rerankerSkipped: boolean; vectorDegraded: boolean; expansionFailed: boolean;
} {
  const stages = new Set((meta?.degraded ?? []).map(d => d.stage).filter((x): x is string => typeof x === 'string'));
  const has = (set: ReadonlySet<string>) => [...stages].some(st => set.has(st));
  return {
    rerankerSkipped: has(RERANKER_SKIPPED_STAGES),
    vectorDegraded: !opts.keywordOnly && (meta?.vector_enabled === false || has(VECTOR_DEGRADED_STAGES)),
    expansionFailed: !opts.keywordOnly && opts.expansion && has(EXPANSION_FAILED_STAGES),
  };
}


/** Re-scan prior rows (resume) for the three silent-degradation counters. */
export function countDegradation(
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: { keywordOnly: boolean; expansion: boolean },
): { rerankerSkipped: number; vectorDegraded: number; expansionFailed: number } {
  const out = { rerankerSkipped: 0, vectorDegraded: 0, expansionFailed: 0 };
  for (const row of rows) {
    if (row.kind === 'by_type_summary' || typeof row.question_id !== 'string') continue;
    const c = classifyDegradation(row.search_meta as RowSearchMeta | undefined, opts);
    if (c.rerankerSkipped) out.rerankerSkipped++;
    if (c.vectorDegraded) out.vectorDegraded++;
    if (c.expansionFailed) out.expansionFailed++;
  }
  return out;
}

