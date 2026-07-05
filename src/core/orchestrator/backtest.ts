/**
 * orchestrator/backtest.ts — a COMPOSABLE temporal walk-forward test for the
 * patient orchestrator.
 *
 * The idea (from the Task 2 flowchart's feedback loop, applied to history):
 *
 *   1. Take a patient's chronological timeline.
 *   2. Cut it at a point T ("data to date"). Everything ≤ T is history the system
 *      is allowed to see; the events just after T are the GROUND TRUTH next step.
 *   3. Hand the history to our system — it runs the orchestrator (rank skills, run
 *      agents) and ESTIMATES the next clinical step(s).
 *   4. Compare the estimate against what actually happened next. NOT word-for-word:
 *      the key MEDICAL TERMS must be accurate (medical-terms.ts).
 *   5. Step T forward and repeat — a walk-forward backtest over the whole timeline.
 *
 * Everything is injected so this file has zero DB / LLM dependency and runs in a
 * plain unit test:
 *   - `PredictNextStep` — how the system turns sliced history into an estimate.
 *     The live wiring (orchestrator + real skills/LLM) lives in backtest-live.ts;
 *     tests pass a fake.
 *   - `score` — how an estimate is graded. Defaults to the medical-term scorer;
 *     override to plug in a real ontology.
 */

import type { SkillRecommendation } from './types.ts';
import {
  scoreTerms,
  resolveTerms,
  extractMedicalTerms,
  type MedicalTerm,
  type TermScore,
  type ScoreOpts,
} from './medical-terms.ts';

/** One point on a patient's timeline. */
export interface TimelineEvent {
  /** ISO date/datetime (or any sortable string). Used for ordering + as-of labels. */
  at: string;
  /** Free text of what happened: a note, an order, a result, a disposition. */
  text: string;
  /** Optional event kind (e.g. 'note' | 'order' | 'result' | 'plan'). */
  kind?: string;
  /** Optional id (page id / event slug) for traceability. */
  id?: string;
  /**
   * Is this event eligible to be a "next step" ground truth? Default true. Set
   * false for pure context events (e.g. an administrative note) that shouldn't be
   * something the system is expected to predict.
   */
  isStep?: boolean;
  /**
   * Optional explicit key-term expectation for THIS event, overriding lexicon
   * extraction from `text`. Lets a fixture pin exactly which terms must be hit.
   */
  expectTerms?: string[];
}

/** A patient's ordered timeline. Assumed chronological; sorted defensively. */
export interface PatientTimeline {
  patientId: string;
  events: TimelineEvent[];
  /** Optional human label for reporting. */
  label?: string;
}

/** A history/ground-truth split at one cut point. */
export interface Slice {
  cutIndex: number;
  /** `at` of the last history event — the "as of" timestamp. */
  asOf: string;
  /** Events ≤ cut — the only thing the system may see. */
  history: TimelineEvent[];
  /** The next `horizon` step-events after the cut — the ground truth. */
  groundTruth: TimelineEvent[];
}

export interface SliceOpts {
  /** How many future step-events count as "the next step" (default 1). */
  horizon?: number;
  /** Minimum history length before we bother predicting (default 1). */
  minHistory?: number;
  /** Cap the number of cut points evaluated (default: all eligible). */
  maxCuts?: number;
  /** Which events can be a ground-truth "next step". Default: `isStep !== false`. */
  stepFilter?: (e: TimelineEvent) => boolean;
}

/** The system's estimate of the next clinical step. */
export interface NextStepPrediction {
  /** Free-text estimate — what the scorer extracts key terms from. */
  text: string;
  /** The ranked skills behind the estimate, if the predictor exposes them. */
  recommendations?: SkillRecommendation[];
  /** Anything else the predictor wants to keep for the record (report/loop result). */
  raw?: unknown;
}

/** Turns a history slice into a next-step estimate. Injected (live or fake). */
export type PredictNextStep = (
  slice: Slice,
  timeline: PatientTimeline,
) => Promise<NextStepPrediction>;

export interface BacktestDeps {
  predict: PredictNextStep;
  /**
   * Grade one estimate against the slice's ground truth. Default: extract key
   * medical terms from the prediction and from the ground-truth events (honoring
   * any `expectTerms`) and score the overlap.
   */
  score?: (prediction: NextStepPrediction, groundTruth: TimelineEvent[]) => TermScore;
}

export interface BacktestOpts extends SliceOpts {
  /** Passed through to the default term scorer (thresholds / extractor). */
  scoreOpts?: ScoreOpts;
}

export interface CutResult {
  cutIndex: number;
  asOf: string;
  /** The free-text estimate the system produced. */
  predicted: string;
  /** The concatenated ground-truth next-step text. */
  actual: string;
  score: TermScore;
  recommendations?: SkillRecommendation[];
}

export interface BacktestAggregate {
  cuts: number;
  meanRecall: number;
  meanPrecision: number;
  meanF1: number;
  /** Mean recall over critical terms — the headline "key terms accurate" number. */
  meanCriticalRecall: number;
  /** Fraction of cuts whose score.passed is true. */
  passRate: number;
  /** Every critical term missed anywhere, for a quick "what did we systematically miss". */
  criticalMissed: string[];
}

export interface BacktestResult {
  patientId: string;
  label?: string;
  cuts: CutResult[];
  aggregate: BacktestAggregate;
}

/** Defensive chronological sort (does not mutate the input). */
function sortedEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Produce the walk-forward slices for a timeline. A cut sits AFTER index i (history
 * = events[0..i]) when there is at least one eligible step-event after it.
 */
export function sliceTimeline(timeline: PatientTimeline, opts: SliceOpts = {}): Slice[] {
  const horizon = Math.max(1, opts.horizon ?? 1);
  const minHistory = Math.max(1, opts.minHistory ?? 1);
  const isStep = opts.stepFilter ?? ((e: TimelineEvent) => e.isStep !== false);

  const events = sortedEvents(timeline.events);
  const slices: Slice[] = [];

  for (let cut = minHistory - 1; cut < events.length - 1; cut++) {
    const history = events.slice(0, cut + 1);
    if (history.length < minHistory) continue;

    // The next `horizon` STEP events strictly after the cut.
    const future = events.slice(cut + 1).filter(isStep).slice(0, horizon);
    if (future.length === 0) continue; // nothing to predict against

    slices.push({
      cutIndex: cut,
      asOf: history[history.length - 1].at,
      history,
      groundTruth: future,
    });
  }

  return typeof opts.maxCuts === 'number' ? slices.slice(0, opts.maxCuts) : slices;
}

/**
 * Default scorer: extract key medical terms from the prediction text and from the
 * ground-truth events, then compare. Honors per-event `expectTerms` when present
 * (a fixture pinning exactly which terms must be hit), otherwise extracts from the
 * event text — so it works on both hand-authored fixtures and raw DB timelines.
 */
export function makeDefaultScorer(scoreOpts: ScoreOpts = {}) {
  const extractor = scoreOpts.extractor ?? extractMedicalTerms;
  return (prediction: NextStepPrediction, groundTruth: TimelineEvent[]): TermScore => {
    const predicted = extractor(prediction.text);
    const explicit = groundTruth.flatMap((e) => e.expectTerms ?? []);
    const actual: MedicalTerm[] =
      explicit.length > 0
        ? resolveTerms(explicit, extractor)
        : extractor(groundTruth.map((e) => e.text).join(' \n '));
    return scoreTerms(predicted, actual, scoreOpts);
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Run the walk-forward backtest for a single patient timeline. */
export async function backtestPatient(
  timeline: PatientTimeline,
  deps: BacktestDeps,
  opts: BacktestOpts = {},
): Promise<BacktestResult> {
  const score = deps.score ?? makeDefaultScorer(opts.scoreOpts);
  const slices = sliceTimeline(timeline, opts);

  const cuts: CutResult[] = [];
  for (const slice of slices) {
    const prediction = await deps.predict(slice, timeline);
    const s = score(prediction, slice.groundTruth);
    cuts.push({
      cutIndex: slice.cutIndex,
      asOf: slice.asOf,
      predicted: prediction.text,
      actual: slice.groundTruth.map((e) => e.text).join(' \n '),
      score: s,
      recommendations: prediction.recommendations,
    });
  }

  const criticalMissed = [...new Set(cuts.flatMap((c) => c.score.criticalMissed))].sort();
  const aggregate: BacktestAggregate = {
    cuts: cuts.length,
    meanRecall: mean(cuts.map((c) => c.score.recall)),
    meanPrecision: mean(cuts.map((c) => c.score.precision)),
    meanF1: mean(cuts.map((c) => c.score.f1)),
    meanCriticalRecall: mean(cuts.map((c) => c.score.criticalRecall)),
    passRate: cuts.length === 0 ? 0 : cuts.filter((c) => c.score.passed).length / cuts.length,
    criticalMissed,
  };

  return { patientId: timeline.patientId, label: timeline.label, cuts, aggregate };
}

export interface SuiteAggregate {
  patients: number;
  cuts: number;
  meanRecall: number;
  meanPrecision: number;
  meanF1: number;
  meanCriticalRecall: number;
  passRate: number;
}

export interface BacktestSuiteResult {
  patients: BacktestResult[];
  aggregate: SuiteAggregate;
}

/** Run the backtest across many patients and aggregate over ALL cuts (cut-weighted). */
export async function backtestSuite(
  timelines: PatientTimeline[],
  deps: BacktestDeps,
  opts: BacktestOpts = {},
): Promise<BacktestSuiteResult> {
  const patients: BacktestResult[] = [];
  for (const tl of timelines) {
    patients.push(await backtestPatient(tl, deps, opts));
  }
  const allCuts = patients.flatMap((p) => p.cuts);
  const aggregate: SuiteAggregate = {
    patients: patients.length,
    cuts: allCuts.length,
    meanRecall: mean(allCuts.map((c) => c.score.recall)),
    meanPrecision: mean(allCuts.map((c) => c.score.precision)),
    meanF1: mean(allCuts.map((c) => c.score.f1)),
    meanCriticalRecall: mean(allCuts.map((c) => c.score.criticalRecall)),
    passRate: allCuts.length === 0 ? 0 : allCuts.filter((c) => c.score.passed).length / allCuts.length,
  };
  return { patients, aggregate };
}
