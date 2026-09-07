/**
 * qa-accuracy.ts — the `qa_accuracy` summary block for the judged-answer
 * lane, rebuilt from ALL rows (prior + new) on every run.
 *
 * INVARIANT: pure over row objects; no I/O, no LLM. The LAST row per
 * question_id wins (a resume file may carry an older error row above a
 * retried row for the same question).
 *
 * Denominators (plan D16, outside-voice round 2):
 *   - `accuracy_headline` = correct / total_questions — EVERY question in
 *     the run counts, including `_abs`; a judge_error, a budget-skipped row,
 *     a reader-error row and a never-judged row all score INCORRECT. This is
 *     the number that is published (and it is never more lenient than the
 *     official scorer, which sees exactly one label per hypothesis).
 *   - `accuracy_excluding_errors` = correct / judged — secondary; errors out
 *     of the denominator.
 *   - `accuracy_470` = headline-style over the non-`_abs` questions (the
 *     retrieval-metric denominator), for the like-for-like reader.
 *   - `complete` = no judge_error, no skipped_budget, no reader_error, no
 *     unjudged row: the publishability bit the run-end gate reads (a
 *     reader-error row scores incorrect without ever being judged, so a run
 *     that carries one is not publishable either).
 *   - `ci95_bootstrap` = percentile bootstrap over the headline 0/1 vector,
 *     labelled question-sampling only (D8/D17).
 */

import { bootstrapMeanCi, type BootstrapCi } from '../shared/bootstrap.ts';
import { hasJudgeAttempt } from './judge-lane.ts';
import { isAbstentionQuestion } from './metrics.ts';

export interface QaRowLike {
  question_id?: unknown;
  question_type?: unknown;
  kind?: unknown;
  hypothesis?: unknown;
  error?: unknown;
  abstention?: unknown;
  judge_correct?: unknown;
  judge_error?: unknown;
  judge_skipped?: unknown;
  judge_cost_usd?: unknown;
  [k: string]: unknown;
}

export interface QaTypeStats {
  total: number;
  judged: number;
  correct: number;
  judge_errors: number;
  skipped_budget: number;
  reader_errors: number;
  unjudged: number;
  accuracy_headline: number | null;
  accuracy_excluding_errors: number | null;
}

export type QaAccuracyBlock = {
  /** Every question row in the run (deduped by question_id; _abs included). */
  total_questions: number;
  judged: number;
  correct: number;
  judge_errors: number;
  skipped_budget: number;
  /** Rows whose reader call failed (empty hypothesis + error); never judged. */
  reader_errors: number;
  /** Rows with a hypothesis that carry no judge attempt at all. */
  unjudged: number;
  /** Alias of accuracy_headline (the ONE published accuracy). */
  accuracy: number | null;
  accuracy_headline: number | null;
  accuracy_excluding_errors: number | null;
  /** Headline-style over non-_abs questions. */
  accuracy_470: number | null;
  non_abstention_total: number;
  by_type: Record<string, QaTypeStats>;
  abstention: { total: number; judged: number; correct: number; judge_errors: number; accuracy_headline: number | null };
  ci95_bootstrap: BootstrapCi;
  /** judge_error class → count. */
  judge_error_classes: Record<string, number>;
  complete: boolean;
  judge_model: string;
  judge_prompt_version: string;
  /**
   * The ONE `judge_config_hash` stamped on the judged rows when they agree;
   * this run's hash when no row carries one (or the rows disagree — see
   * `mixed_judge_config`). Derived from the ROWS, never from the launch flags
   * alone, so a backfill launched without the original `--model` cannot
   * relabel a homogeneous file.
   */
  judge_config_hash: string;
  /** More than one distinct `judge_config_hash` across the judged rows. */
  mixed_judge_config: boolean;
  est_cost_usd: number | null;
  /** Summed over every row's `judge_cost_usd` (the receipt's cumulative judge spend across resumes). */
  actual_cost_usd: number;
  /** THIS run's judge spend from the ledger (null when the lane did not run). */
  run_cost_usd: number | null;
  methodology_note: string;
};

export interface QaAccuracyOpts {
  judgeModel: string;
  judgePromptVersion: string;
  /** This run's hash — published only when no row carries a hash or the rows disagree. */
  judgeConfigHash: string;
  estCostUsd: number | null;
  /** Summed over the rows' own `judge_cost_usd` when omitted. */
  actualCostUsd?: number;
  runCostUsd?: number | null;
  methodologyNote: string;
  seed?: number;
  resamples?: number;
}

function isQuestionRow(row: QaRowLike): boolean {
  return row.kind !== 'by_type_summary' && typeof row.question_id === 'string';
}

function newTypeStats(): QaTypeStats {
  return { total: 0, judged: 0, correct: 0, judge_errors: 0, skipped_budget: 0, reader_errors: 0, unjudged: 0, accuracy_headline: null, accuracy_excluding_errors: null };
}

function finalizeType(t: QaTypeStats): QaTypeStats {
  t.accuracy_headline = t.total === 0 ? null : t.correct / t.total;
  t.accuracy_excluding_errors = t.judged === 0 ? null : t.correct / t.judged;
  return t;
}

/** Last row per question_id wins; summary rows ignored. */
export function dedupeQuestionRows<T extends QaRowLike>(rows: ReadonlyArray<T>): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    if (!isQuestionRow(row)) continue;
    byId.set(row.question_id as string, row);
  }
  return [...byId.values()];
}

export function buildQaAccuracy(rows: ReadonlyArray<QaRowLike>, opts: QaAccuracyOpts): QaAccuracyBlock {
  const deduped = dedupeQuestionRows(rows);
  const byType: Record<string, QaTypeStats> = {};
  const agg = newTypeStats();
  const abs = { total: 0, judged: 0, correct: 0, judge_errors: 0 };
  const errorClasses: Record<string, number> = {};
  const headline: number[] = [];
  let nonAbsTotal = 0;
  let nonAbsCorrect = 0;
  let actual = 0;
  const hashes = new Set<string>();

  for (const row of deduped) {
    const type = typeof row.question_type === 'string' ? row.question_type : 'unknown';
    const t = byType[type] ?? (byType[type] = newTypeStats());
    const isAbs = isAbstentionQuestion(row.question_id as string) || row.abstention === true;
    const readerError = typeof row.error === 'string' && (typeof row.hypothesis !== 'string' || row.hypothesis === '');
    const correct = row.judge_correct === true;
    const judged = typeof row.judge_correct === 'boolean';
    const judgeError = typeof row.judge_error === 'string';
    const skipped = row.judge_skipped === 'budget';
    if (typeof row.judge_cost_usd === 'number' && Number.isFinite(row.judge_cost_usd)) actual += row.judge_cost_usd;
    if (typeof row.judge_config_hash === 'string') hashes.add(row.judge_config_hash);

    for (const s of [t, agg]) {
      s.total++;
      if (judged) { s.judged++; if (correct) s.correct++; }
      else if (judgeError) s.judge_errors++;
      else if (skipped) s.skipped_budget++;
      else if (readerError) s.reader_errors++;
      else s.unjudged++;
    }
    if (judgeError) errorClasses[row.judge_error as string] = (errorClasses[row.judge_error as string] ?? 0) + 1;
    headline.push(correct ? 1 : 0);
    if (isAbs) {
      abs.total++;
      if (judged) { abs.judged++; if (correct) abs.correct++; }
      else if (judgeError) abs.judge_errors++;
    } else {
      nonAbsTotal++;
      if (correct) nonAbsCorrect++;
    }
  }

  const sortedTypes: Record<string, QaTypeStats> = {};
  for (const k of Object.keys(byType).sort()) sortedTypes[k] = finalizeType(byType[k]);
  finalizeType(agg);
  const headlineAcc = agg.accuracy_headline;
  const [onlyHash] = hashes;
  return {
    total_questions: agg.total,
    judged: agg.judged,
    correct: agg.correct,
    judge_errors: agg.judge_errors,
    skipped_budget: agg.skipped_budget,
    reader_errors: agg.reader_errors,
    unjudged: agg.unjudged,
    accuracy: headlineAcc,
    accuracy_headline: headlineAcc,
    accuracy_excluding_errors: agg.accuracy_excluding_errors,
    accuracy_470: nonAbsTotal === 0 ? null : nonAbsCorrect / nonAbsTotal,
    non_abstention_total: nonAbsTotal,
    by_type: sortedTypes,
    abstention: { ...abs, accuracy_headline: abs.total === 0 ? null : abs.correct / abs.total },
    ci95_bootstrap: bootstrapMeanCi(headline, { seed: opts.seed, resamples: opts.resamples }),
    judge_error_classes: errorClasses,
    complete: agg.judge_errors === 0 && agg.skipped_budget === 0 && agg.reader_errors === 0 && agg.unjudged === 0,
    judge_model: opts.judgeModel,
    judge_prompt_version: opts.judgePromptVersion,
    judge_config_hash: hashes.size === 1 ? onlyHash : opts.judgeConfigHash,
    mixed_judge_config: hashes.size > 1,
    est_cost_usd: opts.estCostUsd,
    actual_cost_usd: opts.actualCostUsd ?? actual,
    run_cost_usd: opts.runCostUsd ?? null,
    methodology_note: opts.methodologyNote,
  };
}

/** True when any question row carries a judge attempt (`hasJudgeAttempt`: verdict, error, or budget skip). */
export function anyRowJudged(rows: ReadonlyArray<QaRowLike>): boolean {
  return rows.some(r => isQuestionRow(r) && hasJudgeAttempt(r));
}
