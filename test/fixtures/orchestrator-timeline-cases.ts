/**
 * orchestrator-timeline-cases.ts — sample chronological PATIENT TIMELINES for the
 * temporal backtest (src/core/orchestrator/backtest.ts).
 *
 * Each timeline is a realistic (synthetic — no real patient) clinical trajectory:
 * note → order → result → plan. The `expectTerms` on the order/plan events pin the
 * KEY MEDICAL TERMS the system's next-step estimate must contain (the backtest does
 * NOT score word-for-word — see medical-terms.ts). Reuse these as the shared
 * definition-of-done for both the unit tier and the live tier.
 */

import type { PatientTimeline } from '../../src/core/orchestrator/backtest.ts';

/** A cardiac trajectory — nurse-triage / general-medicine territory. */
export const CARDIAC_TIMELINE: PatientTimeline = {
  patientId: 'patient-cardiac-example',
  label: 'cardiac chest-pain trajectory',
  events: [
    {
      at: '2026-03-01T09:00:00Z',
      kind: 'note',
      text: '62-year-old with hypertension on lisinopril presents with chest pain and shortness of breath.',
    },
    {
      at: '2026-03-01T09:20:00Z',
      kind: 'order',
      text: 'Obtain a 12-lead ECG and troponin; give aspirin now.',
      expectTerms: ['ecg', 'troponin', 'aspirin'],
    },
    {
      at: '2026-03-01T10:05:00Z',
      kind: 'result',
      text: 'ECG shows ST elevation; troponin markedly elevated — acute myocardial infarction.',
    },
    {
      at: '2026-03-01T10:30:00Z',
      kind: 'plan',
      text: 'Cardiology referral and admission; start anticoagulation.',
      expectTerms: ['cardiology referral', 'admission', 'anticoagulation'],
    },
  ],
};

/** A mental-health trajectory — psychiatrist territory. */
export const PSYCH_TIMELINE: PatientTimeline = {
  patientId: 'patient-psych-example',
  label: 'depression / risk trajectory',
  events: [
    {
      at: '2026-04-02T14:00:00Z',
      kind: 'note',
      text: 'Reports low mood, insomnia and fatigue for several weeks; past history of depression.',
    },
    {
      at: '2026-04-02T14:25:00Z',
      kind: 'order',
      text: 'Administer a PHQ-9 depression screen and a suicide risk assessment.',
      expectTerms: ['phq-9', 'suicide risk assessment'],
    },
    {
      at: '2026-04-02T15:00:00Z',
      kind: 'result',
      text: 'PHQ-9 in the severe range; patient expressing suicidal ideation.',
    },
    {
      at: '2026-04-02T15:20:00Z',
      kind: 'plan',
      text: 'Start sertraline (an SSRI), create a safety plan, and make a psychiatry referral.',
      expectTerms: ['sertraline', 'safety plan', 'psychiatry referral'],
    },
  ],
};

export const TIMELINE_CASES: PatientTimeline[] = [CARDIAC_TIMELINE, PSYCH_TIMELINE];
