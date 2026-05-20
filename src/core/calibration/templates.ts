/**
 * v0.36.1.0 (T6) — voice-gate fallback templates.
 *
 * D11 (CEO review): when the voice gate fails twice on an LLM-generated
 * surface, we fall back to a hand-written template rather than ship academic-
 * sounding text OR suppress the surface silently. Predictable output beats
 * voice-quality roulette.
 *
 * Each template gets the data it needs via slot fill. Templates intentionally
 * sound a little "robotic" (acceptable; users see the SAME shape twice when
 * both regens fail, NOT random voice degradation). Real conversational voice
 * comes from the LLM path; templates are the safety net.
 *
 * Mode parity: every voice gate `Mode` MUST have an entry here. The
 * VOICE_GATE_MODES export pins this contract for the test suite.
 */

export const VOICE_GATE_MODES = [
  'pattern_statement',
  'nudge',
  'forecast_blurb',
  'dashboard_caption',
  'morning_pulse',
] as const;

export type VoiceGateMode = (typeof VOICE_GATE_MODES)[number];

export interface PatternStatementSlots {
  domain: string;
  nRight: number;
  nWrong: number;
  /** Optional one-word direction tag e.g. 'over-confident' / 'late' */
  direction?: string;
}

export interface NudgeSlots {
  domain: string;
  conviction: number;
  nRecentMisses: number;
  nRecentTotal: number;
  hushPattern: string;
}

export interface ForecastBlurbSlots {
  domain: string;
  conviction: number;
  bucketBrier: number;
  overallBrier: number;
  bucketN: number;
}

export interface DashboardCaptionSlots {
  /** e.g. 'Brier trend' or 'Per-domain accuracy' */
  surface: string;
  /** Single short fact for the chart caption */
  fact: string;
}

export interface MorningPulseSlots {
  brier: number;
  trend: 'improving' | 'declining' | 'stable';
  topPattern: string;
}

/**
 * Pattern statement template — what `calibration_profile` writes when the
 * voice gate fails on an LLM narrative. Intentionally short; the dashboard
 * surfaces it as a single subhead.
 */
export function patternStatementTemplate(s: PatternStatementSlots): string {
  const total = s.nRight + s.nWrong;
  if (total === 0) {
    return `Not enough resolved ${s.domain} calls yet to spot a pattern.`;
  }
  const direction = s.direction ?? (s.nWrong > s.nRight ? 'mixed' : 'mostly right');
  return `Your ${s.domain} calls have a ${direction} record — ${s.nRight} of ${total} held up.`;
}

/** E7 nudge template — stderr line on sync after a take is committed. */
export function nudgeTemplate(s: NudgeSlots): string {
  return (
    `[gbrain] You just committed a ${s.domain} take at conviction ${s.conviction.toFixed(2)}. ` +
    `Recent record on similar calls: ${s.nRecentMisses} of ${s.nRecentTotal} missed. ` +
    `Hush this pattern for 14 days: gbrain takes nudge --hush ${s.hushPattern}`
  );
}

/** E5 inline forecast on a new take (queue + takes show). */
export function forecastBlurbTemplate(s: ForecastBlurbSlots): string {
  if (s.bucketN < 5) {
    return `Forecast unavailable: only ${s.bucketN} resolved ${s.domain} takes at this conviction yet.`;
  }
  const note = s.bucketBrier > s.overallBrier ? 'worse than your average' : 'on par with your average';
  return (
    `Predicted Brier in ${s.domain} at conviction ${s.conviction.toFixed(2)}: ` +
    `${s.bucketBrier.toFixed(2)} (${note}, n=${s.bucketN}).`
  );
}

/** E6 dashboard chart caption. */
export function dashboardCaptionTemplate(s: DashboardCaptionSlots): string {
  return `${s.surface}: ${s.fact}`;
}

/** Recall morning pulse Brier+pattern line. */
export function morningPulseTemplate(s: MorningPulseSlots): string {
  const trendWord =
    s.trend === 'improving' ? 'improving' : s.trend === 'declining' ? 'declining' : 'stable';
  return (
    `Brier ${s.brier.toFixed(2)} (${trendWord}). ` +
    (s.topPattern ? `Top pattern: ${s.topPattern}.` : '')
  );
}
