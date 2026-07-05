/**
 * orchestrator-backtest.test.ts — the composable temporal-backtest gate.
 *
 * Proves, with NO DB / LLM / worker (everything injected):
 *   1. Key-medical-term extraction + scoring (the "must be accurate" engine).
 *   2. Timeline slicing (history ≤ T, ground-truth next step after T).
 *   3. The walk-forward backtest end-to-end with a fake predictor — including that
 *      it grades on KEY TERMS, not word-for-word: a paraphrase that keeps the drug
 *      passes; an estimate that drops a critical term fails.
 *   4. The chronicle timeline loader's row→event mapping (with a fake engine).
 */

import { describe, it, expect } from 'bun:test';
import {
  extractMedicalTerms,
  scoreMedicalTerms,
  scoreTerms,
  resolveTerms,
  makeLexiconExtractor,
} from '../src/core/orchestrator/medical-terms.ts';
import {
  sliceTimeline,
  backtestPatient,
  backtestSuite,
  makeDefaultScorer,
  type PredictNextStep,
  type NextStepPrediction,
  type Slice,
} from '../src/core/orchestrator/backtest.ts';
import { loadPatientTimeline } from '../src/core/orchestrator/backtest-live.ts';
import { CARDIAC_TIMELINE, PSYCH_TIMELINE, TIMELINE_CASES } from './fixtures/orchestrator-timeline-cases.ts';

// ---------------------------------------------------------------------------
// 1. Medical-term extraction + scoring
// ---------------------------------------------------------------------------

describe('medical-terms extraction', () => {
  it('extracts canonical terms across categories', () => {
    const terms = extractMedicalTerms('Give aspirin and obtain an ECG for chest pain.');
    const names = terms.map((t) => t.canonical);
    expect(names).toContain('aspirin');
    expect(names).toContain('ecg');
    expect(names).toContain('chest pain');
  });

  it('maps synonyms/abbreviations to the canonical term', () => {
    const terms = extractMedicalTerms('Order an EKG and start Zoloft; refer to psychiatry.');
    const names = terms.map((t) => t.canonical);
    expect(names).toContain('ecg'); // EKG → ecg
    expect(names).toContain('sertraline'); // Zoloft → sertraline
    expect(names).toContain('psychiatry referral'); // "refer to psychiatry"
  });

  it('flags medications/procedures/red-flags/dispositions as critical', () => {
    const terms = extractMedicalTerms('aspirin, ECG, chest pain, admission, low mood');
    const crit = new Map(terms.map((t) => [t.canonical, t.critical]));
    expect(crit.get('aspirin')).toBe(true); // medication
    expect(crit.get('ecg')).toBe(true); // procedure
    expect(crit.get('chest pain')).toBe(true); // red_flag
    expect(crit.get('admission')).toBe(true); // disposition
    expect(crit.get('low mood')).toBe(false); // soft symptom
  });

  it('is injectable — a custom lexicon replaces the default', () => {
    const extract = makeLexiconExtractor([
      { canonical: 'widgetitis', category: 'diagnosis', synonyms: ['widget disease'] },
    ]);
    expect(extract('classic widget disease here').map((t) => t.canonical)).toEqual(['widgetitis']);
    expect(extract('aspirin').length).toBe(0); // default lexicon not consulted
  });
});

describe('medical-terms scoring', () => {
  it('scores on key terms, NOT word-for-word', () => {
    // Different wording, same clinical content → perfect recall.
    const s = scoreMedicalTerms(
      'I would get an electrocardiogram and hand the patient some ASA.',
      'Obtain a 12-lead ECG and give aspirin.',
    );
    expect(s.recall).toBe(1);
    expect(s.criticalRecall).toBe(1);
    expect(s.passed).toBe(true);
  });

  it('fails when a CRITICAL term is missed even if soft terms overlap', () => {
    const s = scoreMedicalTerms(
      'Patient has chest pain, reassure and review later.', // no ECG, no aspirin
      'Chest pain — obtain ECG and give aspirin.',
    );
    expect(s.criticalMissed).toContain('ecg');
    expect(s.criticalMissed).toContain('aspirin');
    expect(s.criticalRecall).toBeLessThan(1);
    expect(s.passed).toBe(false);
  });

  it('resolveTerms + scoreTerms honor an explicit expected set', () => {
    const predicted = extractMedicalTerms('start sertraline and arrange a psychiatry referral');
    const actual = resolveTerms(['sertraline', 'safety plan', 'psychiatry referral']);
    const s = scoreTerms(predicted, actual);
    expect(s.matched).toContain('sertraline');
    expect(s.matched).toContain('psychiatry referral');
    expect(s.missed).toContain('safety plan');
    expect(s.passed).toBe(false); // safety plan is a missed critical disposition
  });
});

// ---------------------------------------------------------------------------
// 2. Timeline slicing
// ---------------------------------------------------------------------------

describe('sliceTimeline', () => {
  it('walks forward: history ≤ cut, ground truth after cut', () => {
    const slices = sliceTimeline(CARDIAC_TIMELINE); // 4 events, horizon 1
    // cuts after events 0,1,2 (each has a future step) → 3 slices
    expect(slices.length).toBe(3);
    expect(slices[0].history.length).toBe(1);
    expect(slices[0].groundTruth.length).toBe(1);
    expect(slices[0].groundTruth[0].text).toContain('ECG');
    // history grows by one each cut
    expect(slices[1].history.length).toBe(2);
    expect(slices[2].history.length).toBe(3);
  });

  it('respects minHistory, horizon and maxCuts', () => {
    const h2 = sliceTimeline(CARDIAC_TIMELINE, { horizon: 2, minHistory: 2 });
    expect(h2[0].history.length).toBe(2);
    expect(h2[0].groundTruth.length).toBe(2);
    const capped = sliceTimeline(CARDIAC_TIMELINE, { maxCuts: 1 });
    expect(capped.length).toBe(1);
  });

  it('sorts defensively when events arrive out of order', () => {
    const slices = sliceTimeline({
      patientId: 'p',
      events: [
        { at: '2026-01-03', text: 'give aspirin' },
        { at: '2026-01-01', text: 'chest pain' },
        { at: '2026-01-02', text: 'obtain ECG' },
      ],
    });
    expect(slices[0].history[0].text).toBe('chest pain');
    expect(slices[0].groundTruth[0].text).toBe('obtain ECG');
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end walk-forward backtest with fake predictors
// ---------------------------------------------------------------------------

/** An oracle predictor that "sees" the ground truth — proves plumbing + high score. */
const oraclePredict: PredictNextStep = async (slice: Slice): Promise<NextStepPrediction> => ({
  text: slice.groundTruth.map((e) => e.text).join(' '),
});

/** A useless predictor that always says the same generic thing — proves discrimination. */
const lazyPredict: PredictNextStep = async (): Promise<NextStepPrediction> => ({
  text: 'monitor the patient and reassess later',
});

describe('backtestPatient', () => {
  it('an oracle predictor passes every cut with full critical recall', async () => {
    const res = await backtestPatient(CARDIAC_TIMELINE, { predict: oraclePredict });
    expect(res.cuts.length).toBe(3);
    expect(res.aggregate.passRate).toBe(1);
    expect(res.aggregate.meanCriticalRecall).toBe(1);
    expect(res.aggregate.criticalMissed).toEqual([]);
  });

  it('a lazy predictor fails and surfaces the critical terms it missed', async () => {
    const res = await backtestPatient(CARDIAC_TIMELINE, { predict: lazyPredict });
    expect(res.aggregate.passRate).toBe(0);
    expect(res.aggregate.meanCriticalRecall).toBeLessThan(1);
    // it missed the ordered work-up + disposition terms
    expect(res.aggregate.criticalMissed).toContain('ecg');
    expect(res.aggregate.criticalMissed).toContain('cardiology referral');
  });

  it('uses expectTerms when present (pinned key terms)', async () => {
    // Predict ONLY the first ground-truth step's terms, missing later ones.
    const partial: PredictNextStep = async (slice) => ({
      text: slice.cutIndex === 0 ? 'obtain ECG, troponin, aspirin' : 'monitor only',
    });
    const res = await backtestPatient(CARDIAC_TIMELINE, { predict: partial });
    expect(res.cuts[0].score.passed).toBe(true); // matched the pinned order terms
    expect(res.cuts[0].score.matched).toContain('troponin');
    expect(res.cuts[res.cuts.length - 1].score.passed).toBe(false);
  });

  it('a custom injected scorer overrides the default', async () => {
    const alwaysPass = makeDefaultScorer({ recallThreshold: 0, criticalThreshold: 0 });
    const res = await backtestPatient(CARDIAC_TIMELINE, {
      predict: lazyPredict,
      score: alwaysPass,
    });
    expect(res.aggregate.passRate).toBe(1); // thresholds relaxed to zero
  });
});

describe('backtestSuite', () => {
  it('aggregates over all cuts across patients (cut-weighted)', async () => {
    const suite = await backtestSuite(TIMELINE_CASES, { predict: oraclePredict });
    expect(suite.aggregate.patients).toBe(2);
    expect(suite.aggregate.cuts).toBe(6); // 3 per 4-event timeline
    expect(suite.aggregate.passRate).toBe(1);
    expect(suite.patients.map((p) => p.patientId)).toEqual([
      CARDIAC_TIMELINE.patientId,
      PSYCH_TIMELINE.patientId,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Chronicle timeline loader mapping (fake engine, no DB)
// ---------------------------------------------------------------------------

describe('loadPatientTimeline', () => {
  it('maps chronicle rows to timeline events, scoped to the patient source', async () => {
    let seenSourceId: string | undefined;
    const fakeEngine = {
      getSince: async (_date: string, o?: { sourceId?: string }) => {
        seenSourceId = o?.sourceId;
        return [
          { date: '2026-03-01', effective_date: '2026-03-01T09:00:00Z', summary: 'chest pain', detail: 'onset 1h ago', kind: 'note', page_id: 7, event_slug: 'evt-1' },
          { date: '2026-03-01', effective_date: null, summary: 'give aspirin', detail: '', kind: 'order', page_id: 8, event_slug: null },
        ];
      },
    };
    const ctx = { engine: fakeEngine } as unknown as Parameters<typeof loadPatientTimeline>[0];

    const tl = await loadPatientTimeline(ctx, 'patient-x');
    expect(seenSourceId).toBe('patient-x');
    expect(tl.patientId).toBe('patient-x');
    expect(tl.events[0]).toMatchObject({ at: '2026-03-01T09:00:00Z', id: 'evt-1', kind: 'note' });
    expect(tl.events[0].text).toBe('chest pain — onset 1h ago');
    expect(tl.events[1].at).toBe('2026-03-01'); // falls back to date when effective_date is null
    expect(tl.events[1].id).toBe('8'); // falls back to page_id
  });

  it('throws a clear error when the engine has no chronicle', async () => {
    const ctx = { engine: {} } as unknown as Parameters<typeof loadPatientTimeline>[0];
    await expect(loadPatientTimeline(ctx, 'p')).rejects.toThrow(/chronicle timeline required/);
  });
});
