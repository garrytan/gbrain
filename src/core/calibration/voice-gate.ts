/**
 * v0.36.1.0 (T6 / D24) — voice gate: single function, multiple surfaces.
 *
 * Calibration-wave surfaces talk to the user in a conversational voice that
 * sounds like a smart friend, not a clinical scoring system. Every nudge,
 * pattern statement, forecast blurb, dashboard caption, and morning-pulse
 * line passes through this gate before it reaches the user.
 *
 * Mode parameter (D24):
 *   ALL five calibration UX surfaces import THIS function. Mode-specific
 *   tuning lives in the rubric the gate ships to its Haiku judge, NOT in
 *   forked gate implementations. Forking would let voice rubric drift —
 *   fix in one surface, miss four. Five surfaces, one gate.
 *
 * Fallback policy (D11):
 *   Up to 2 regeneration attempts, then fall back to a hand-written
 *   template from src/core/calibration/templates.ts. Voice failures are
 *   recorded to the calibration_profiles row (voice_gate_passed=false +
 *   voice_gate_attempts) so the operator can review the failing examples
 *   and tune the rubric over time. Suppressing the surface silently is
 *   NEVER an option — that would let voice quality silently degrade.
 *
 * Test seam: opts.judge (a JudgeFn returning verdict + reason) is injected
 * by tests so the gate runs hermetically. Production uses a small Haiku
 * call wrapped in opts-resolution.
 */

import { chat as gatewayChat } from '../ai/gateway.ts';
import type { VoiceGateMode } from './templates.ts';

/**
 * Verdict the Haiku judge returns for a candidate string. Pass-through
 * 'conversational'; reject with a short reason for 'academic'.
 */
export interface VoiceGateJudgeVerdict {
  verdict: 'conversational' | 'academic';
  reason: string;
}

export type VoiceGateJudge = (input: {
  candidate: string;
  mode: VoiceGateMode;
  rubric: string;
}) => Promise<VoiceGateJudgeVerdict>;

export interface VoiceGateResult<T = unknown> {
  /** The final text — the LLM output if a generation passed, or the template fallback. */
  text: string;
  /** Did a generation attempt pass the rubric? */
  passed: boolean;
  /** How many generation attempts ran before falling back. 0 means template-only path. */
  attempts: number;
  /** Reason from the LAST judge call (the one that decided pass vs final reject). */
  lastReason?: string;
  /** Template slots used when passed=false (kept for audit). */
  templateSlots?: T;
}

/**
 * Generation function — the caller writes this per-surface. It produces
 * ONE candidate string per call. The gate decides whether to accept or
 * regenerate. Subsequent calls can use `feedback` to nudge regeneration
 * away from the rejected version's failure mode.
 */
export type VoiceGateGenerator = (input: { attempt: number; feedback?: string }) => Promise<string>;

/**
 * Template fallback function — pure. Caller passes slots; template
 * produces the final string. Receives no `attempt` argument because the
 * template never iterates.
 */
export type VoiceGateTemplate<S> = (slots: S) => string;

export interface VoiceGateOpts<S> {
  /** UX surface — drives the rubric tuning. */
  mode: VoiceGateMode;
  /** Generator that produces an LLM candidate per attempt. */
  generate: VoiceGateGenerator;
  /** Template fallback used when both regens fail. */
  templateFallback: { fn: VoiceGateTemplate<S>; slots: S };
  /** Max generation attempts before falling back. Default 2 (D11). */
  maxAttempts?: number;
  /** Inject the judge (tests). Production uses Haiku. */
  judge?: VoiceGateJudge;
  /** Override the rubric per mode (rarely needed). */
  rubric?: string;
}

/**
 * Default rubrics per mode. The gate consults the rubric when deciding
 * whether a candidate sounds conversational vs academic. Tuning the rubric
 * is the V1 lever; tuning the gate code is a v0.37+ concern.
 */
export const DEFAULT_RUBRICS: Record<VoiceGateMode, string> = {
  pattern_statement: `Voice for a calibration pattern statement:
- Sounds like a smart friend recapping your record, not a doctor or HR.
- Uses second person ("your", "you").
- Names numbers grounded in actual takes ("2 of 3 missed"), not abstract
  metrics like "Brier 0.31" or "conviction-bucket 0.8-0.9".
- No preachy/clinical phrasing ("our analysis indicates", "the data shows").
- Short — under 25 words.
- NEVER mentions internal field names like 'Brier' or 'conviction-bucket'
  without translation.`,

  nudge: `Voice for a real-time nudge fired during sync after a take is committed:
- Sounds like a friend tapping you on the shoulder, not an alert system.
- Second person, contractions allowed, casual.
- Grounded in 1-2 concrete past data points the user can verify.
- Always closes with a concrete next step (a CLI command or a question).
- Under 30 words.
- NEVER preachy. NEVER "we recommend." NEVER "according to your data".`,

  forecast_blurb: `Voice for an inline forecast blurb on a new take:
- One short factual line, ~12-20 words.
- Names the past data in concrete terms ("2 of 3 missed" beats "Brier 0.31").
- Acknowledges uncertainty when n is small.
- No "predicted Brier" jargon without translation.
- NEVER condescending.`,

  dashboard_caption: `Voice for a chart caption on the admin dashboard:
- Single short sentence per caption.
- Names ONE concrete fact.
- No marketing copy, no "powerful insights", no "leverage".
- Plain language, no jargon.`,

  morning_pulse: `Voice for a daily morning-pulse line:
- One sentence, sounds like a friend giving you a quick status check.
- Names the trend in plain words ("improving" beats "trending positive").
- Mentions ONE pattern when relevant; skip when no clear pattern.
- Under 25 words.
- NEVER clinical, NEVER preachy, NEVER hedged corporate language.`,
};

const DEFAULT_MAX_ATTEMPTS = 2;

const HAIKU_GATE_PROMPT = `You are the voice gate for a personal AI brain. A surface wants to show
this candidate text to the user. Decide whether it sounds conversational
(friend talking to friend) or academic (clinical / corporate).

Output ONLY a JSON object: {"verdict":"conversational"|"academic","reason":"<<=80 chars>"}.

RUBRIC for this surface:
{RUBRIC}

CANDIDATE:
{CANDIDATE}`;

/**
 * Default judge — Haiku-based rubric verdict. Production path; tests
 * inject a stub.
 */
export async function defaultJudge(input: {
  candidate: string;
  mode: VoiceGateMode;
  rubric: string;
}): Promise<VoiceGateJudgeVerdict> {
  const prompt = HAIKU_GATE_PROMPT
    .replace('{RUBRIC}', input.rubric)
    .replace('{CANDIDATE}', input.candidate);
  const result = await gatewayChat({
    messages: [{ role: 'user', content: prompt }],
    model: 'claude-haiku-4-5',
    maxTokens: 100,
  });
  return parseJudgeOutput(result.text);
}

/**
 * Parse the Haiku judge's JSON output. Robust to fence wrapping +
 * leading prose. On unrecoverable parse failure, treat as 'academic'
 * with reason='parse_failed' so the gate falls back to the template
 * rather than silently passing bad voice.
 */
export function parseJudgeOutput(raw: string): VoiceGateJudgeVerdict {
  if (!raw || raw.trim().length === 0) {
    return { verdict: 'academic', reason: 'empty_judge_output' };
  }
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  const firstObj = text.indexOf('{');
  if (firstObj === -1) return { verdict: 'academic', reason: 'parse_failed' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(firstObj));
  } catch {
    return { verdict: 'academic', reason: 'parse_failed' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { verdict: 'academic', reason: 'parse_failed' };
  }
  const r = parsed as Record<string, unknown>;
  const verdict = r.verdict === 'conversational' ? 'conversational' : 'academic';
  const reason = typeof r.reason === 'string' ? r.reason.slice(0, 80) : 'no_reason';
  return { verdict, reason };
}

/**
 * Gate a single piece of LLM-generated voice. Returns the final text +
 * audit info (pass/fail + attempts).
 */
export async function gateVoice<S>(opts: VoiceGateOpts<S>): Promise<VoiceGateResult<S>> {
  const judge = opts.judge ?? defaultJudge;
  const rubric = opts.rubric ?? DEFAULT_RUBRICS[opts.mode];
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let lastReason: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let candidate: string;
    try {
      candidate = await opts.generate({ attempt, feedback: lastReason });
    } catch (err) {
      // Generator threw — treat as a failed attempt but continue. If both
      // attempts throw we fall through to the template (D11 fallback).
      lastReason = err instanceof Error ? err.message : 'generator_threw';
      continue;
    }
    if (!candidate || candidate.trim().length === 0) {
      lastReason = 'empty_generation';
      continue;
    }
    const verdict = await judge({ candidate, mode: opts.mode, rubric });
    if (verdict.verdict === 'conversational') {
      return { text: candidate, passed: true, attempts: attempt, lastReason: verdict.reason };
    }
    lastReason = verdict.reason;
  }

  // Both attempts failed (or threw) — template fallback.
  const fallback = opts.templateFallback.fn(opts.templateFallback.slots);
  return {
    text: fallback,
    passed: false,
    attempts: maxAttempts,
    ...(lastReason !== undefined ? { lastReason } : {}),
    templateSlots: opts.templateFallback.slots,
  };
}
