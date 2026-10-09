/**
 * decide-lane.ts — System One arms for `gbrain eval longmemeval` (shared
 * plumbing in src/eval/decide-eval-flags.ts; this module holds the
 * LongMemEval-specific parts so the harness facade only delegates):
 *
 *   - the `--decide*` flags and the eval-only `--eval-pool-depth N` (recall
 *     experiment: lifts the per-arm cap to N for this run, and sets
 *     `search.reranker.top_n_in=N` unless a `--search-pin` already set it);
 *   - eval-half restriction: with `--decide-dataset`, only question ids whose
 *     family (the longmemeval builder uses family = question_id) is in the
 *     dataset's eval half run;
 *   - eval validity: a `--decide` arm refuses trajectory routing, which reads
 *     the dataset's question_type labels (run both arms with --no-trajectory);
 *   - the per-row `decide` receipt, and `--decide answerable=on` harness-reader
 *     abstention (the S4 verdict `abstain` replaces the reader call).
 *
 * All-off: every helper is a no-op when no slot is on or shadow.
 */
import type { PGLiteEngine } from '../../core/pglite-engine.ts';
import type { HybridSearchMeta } from '../../core/types.ts';
import type { ReaderAnswer } from './reader.ts';
import { EVAL_POOL_DEPTH_MAX, setEvalPoolDepth } from '../../core/search/eval-pool-depth.ts';
import {
  DECIDE_EVAL_FLAGS, applyDecideEvalFlag, decideRowReceipt, decideSpendTotals, prepareDecideEval, spendDelta,
  type DecideEvalOptions, type DecideEvalRun, type DecideSpend,
} from '../decide-eval-flags.ts';

export { configureDecideBrain, newDecideEvalOptions, summarizeDecideReceipts, type DecideEvalOptions, type DecideEvalRun } from '../decide-eval-flags.ts';

interface LmeDecideArgs {
  decide: DecideEvalOptions;
  evalPoolDepth?: number;
  searchPins?: Record<string, string>;
  noTrajectory: boolean;
}

/** LME_FLAGS entries (the harness spreads these into its one flag table). */
export const LME_DECIDE_FLAGS: Array<{ name: string; arg?: string; help: string[]; apply: (o: LmeDecideArgs, value: string) => void }> = [
  ...DECIDE_EVAL_FLAGS.map((f) => ({ ...f, apply: (o: LmeDecideArgs, v: string) => { applyDecideEvalFlag(o.decide, f.name, v); } })),
  { name: '--eval-pool-depth', arg: 'N', help: [
      `Eval-only recall experiment: every retrieval arm fetches N candidates (N <= ${EVAL_POOL_DEPTH_MAX};`,
      'production caps each arm at 100) and search.reranker.top_n_in=N unless a',
      '--search-pin sets it. Folds into retrieval_config_hash. Pair with --capture-pool',
      'for pool_recall at fused depths 30/50/100/300.'],
    apply: (o, v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > EVAL_POOL_DEPTH_MAX) throw new Error(`--eval-pool-depth must be an integer from 1 to ${EVAL_POOL_DEPTH_MAX} (got: ${v})`);
      o.evalPoolDepth = n;
      o.searchPins = { 'search.reranker.top_n_in': String(n), ...(o.searchPins ?? {}) };
    } },
];

/**
 * Before pins resolve: set the eval pool depth, prepare the decide run, add
 * its search pins, and restrict the questions to the dataset's eval half.
 * Throws (flag errors, eval validity, split_mismatch) with the message to print.
 */
export function prepareLmeDecide<Q extends { question_id: string }>(opts: LmeDecideArgs, questions: Q[]): { run: DecideEvalRun | null; questions: Q[] } {
  setEvalPoolDepth(opts.evalPoolDepth ?? null);
  const run = prepareDecideEval(opts.decide, { command: 'gbrain eval longmemeval', throwaway: true });
  if (!run) return { run, questions };
  if (!opts.noTrajectory) {
    throw new Error('--decide arms need --no-trajectory: trajectory routing reads the dataset question_type labels, and a matched pair must route with text-only classifiers (run the baseline arm with --no-trajectory too)');
  }
  opts.searchPins = { ...(opts.searchPins ?? {}), ...run.searchPins };
  if (!run.dataset) return { run, questions };
  const kept = questions.filter((q) => run.dataset!.evalFamilies.has(q.question_id));
  process.stderr.write(`[longmemeval] decide split holdout: ${kept.length}/${questions.length} question(s) in the eval half of ${run.dataset.name}\n`);
  return { run, questions: kept };
}

/** decide_spend totals before a question's search (null when no arm is active). */
export async function lmeSpendBefore(engine: PGLiteEngine, run: DecideEvalRun | null | undefined): Promise<DecideSpend | null> {
  return run ? decideSpendTotals(engine) : null;
}

/** hybridSearch opts the arm needs (S4 answerability on the query path). */
export function lmeDecideSearchOpts(run: DecideEvalRun | null | undefined): { decide?: { answerability: true } } {
  return run?.slots.answerable ? { decide: { answerability: true } } : {};
}

/** The row's `decide` field (absent on all-off rows). */
export async function lmeDecideRow(engine: PGLiteEngine, run: DecideEvalRun | null | undefined, meta: HybridSearchMeta | undefined, before: DecideSpend | null): Promise<Record<string, unknown>> {
  if (!run || !before) return {};
  const receipt = decideRowReceipt(run, meta?.decide, spendDelta(before, await decideSpendTotals(engine)));
  return { decide: { ...receipt, ...(meta?.answerability ? { answerability: meta.answerability } : {}), ...(lmeAbstention(run, meta) ? { reader_abstained: true } : {}) } };
}

export const LME_ABSTAIN_HYPOTHESIS = 'I cannot answer this: the conversation history does not contain the information needed.';

/**
 * `--decide answerable=on`: the harness reader abstains when S4 acted with
 * verdict abstain (scored by the judge on the `_abs` questions). The returned
 * answer stands in for the reader call; the row's decide block says so.
 */
export function lmeAbstention(run: DecideEvalRun | null | undefined, meta: HybridSearchMeta | undefined): ReaderAnswer | null {
  if (run?.slots.answerable !== 'on' || meta?.decide?.answerable?.effective !== 'on' || meta.answerability?.verdict !== 'abstain') return null;
  return { text: LME_ABSTAIN_HYPOTHESIS, finish_reason: 'end_turn', usage: null, response_model: null, context_chars: 0, context_sessions: 0, sessions_truncated: 0 };
}
