/**
 * v0.36.0.0 (T6) — calibration_profile cycle phase.
 *
 * Aggregates the resolved takes subset into a calibration profile per holder:
 *  - quantitative: TakesScorecard (Brier, accuracy, partial_rate, per-domain)
 *  - qualitative: 2-4 narrative pattern statements via the voice gate
 *  - bias tags: short kebab-case labels (e.g. 'over-confident-geography')
 *    used by E3 (calibration-aware contradictions) and E7 (real-time nudges)
 *
 * grade_completion (F1):
 *   When grade_takes aborts mid-cycle on budget cap, this phase still runs
 *   but tags the profile row with `grade_completion: REAL` (fraction of
 *   eligible-and-old-enough takes the grade phase processed). Dashboard
 *   surfaces "60% graded" badge when < 0.9. Default 1.0 (full completion).
 *
 * Voice gate (D11 / D24):
 *   Pattern statements pass through gateVoice() with mode='pattern_statement'.
 *   Two regeneration attempts, then fall back to a hand-written template.
 *   `voice_gate_passed` + `voice_gate_attempts` get recorded on the row for
 *   audit; failed-pass-but-template-OK rows surface to a review queue
 *   (lands in Lane C).
 *
 * Source-scope: BaseCyclePhase enforces sourceScopeOpts threading.
 * Profiles are per (source_id, holder) so a multi-source brain gets distinct
 * profiles per source for the same holder.
 */

import { BaseCyclePhase, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { gateVoice, type VoiceGateGenerator, type VoiceGateJudge } from '../calibration/voice-gate.ts';
import { patternStatementTemplate, type PatternStatementSlots } from '../calibration/templates.ts';
import { GBrainError } from '../types.ts';
import type { OperationContext } from '../operations.ts';
import type { BrainEngine, TakesScorecard } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';

export const CALIBRATION_PROFILE_PROMPT_VERSION = 'v0.36.0.0-stub';

const PATTERN_STATEMENTS_PROMPT = `[v0.36.0.0-stub] You are summarizing a forecaster's track record so they
can see their patterns. Below is a JSON snapshot of how they performed —
per-domain scorecards over the resolved subset.

Write 2 to 4 short pattern statements, ONE per line. Each statement:
- Names a domain (e.g. "macro tech", "geography", "hiring decisions").
- States the direction (right / wrong / late / early / over-confident /
  under-calibrated).
- Includes ONE concrete number a reader can verify ("2 of 5 missed").
- Sounds like a smart friend recapping the record, not a doctor or HR.
- Under 25 words.

EXAMPLES of the voice we want:
- "You called early-stage tactics well — 8 of 10 held up."
- "Geography is your blind spot. High-conviction calls missed 4 of 6."
- "On macro tech you tend to be ~18 months early; calls land, just later."

DO NOT use phrases like "the data shows", "our analysis indicates", "Brier
score", or "conviction bucket". DO NOT preach. Be plain.

Output the 2-4 pattern statements only, one per line. No numbering, no
prose around them.

SCORECARD:
{SCORECARD_JSON}
`;

const BIAS_TAGS_PROMPT = `Based on the pattern statements below, emit 1-4
kebab-case bias tags. Each tag combines an axis (over-confident,
under-confident, early, late, hedged-correctly) with a domain
(tactics, macro, geography, hiring, market-timing, founder-behavior,
ai, other).

Examples: "over-confident-geography", "late-on-macro-tech",
"hedged-correctly-on-hiring".

Output ONLY a JSON array of strings. No prose. If no clear bias pattern
emerges, return [].

PATTERN STATEMENTS:
{PATTERNS_BULLETS}
`;

/** Generator function for pattern statements (test seam). */
export type PatternStatementsGenerator = (input: {
  scorecard: TakesScorecard;
  holder: string;
  attempt: number;
  feedback?: string;
}) => Promise<string[]>;

/** Generator function for bias tags (test seam). */
export type BiasTagsGenerator = (patterns: string[]) => Promise<string[]>;

export interface CalibrationProfileOpts extends BasePhaseOpts {
  /** Holder to generate the profile for. Default 'garry'. */
  holder?: string;
  /** Inject the patterns generator (tests). */
  patternsGenerator?: PatternStatementsGenerator;
  /** Inject the bias-tags generator (tests). */
  biasTagsGenerator?: BiasTagsGenerator;
  /** Inject the voice gate judge (tests). */
  voiceGateJudge?: VoiceGateJudge;
  /** grade_completion from grade_takes phase that ran in the same cycle. Default 1.0. */
  gradeCompletion?: number;
  /** Override prompt version (tests). */
  promptVersion?: string;
  /** Override model id; default Sonnet. */
  model?: string;
}

export interface CalibrationProfileResult {
  profile_written: boolean;
  voice_gate_passed: boolean;
  voice_gate_attempts: number;
  pattern_statements: string[];
  active_bias_tags: string[];
  total_resolved: number;
  brier: number | null;
  warnings: string[];
}

/** Production patterns generator — calls Sonnet with the SCORECARD_JSON prompt. */
export async function defaultPatternsGenerator(input: {
  scorecard: TakesScorecard;
  holder: string;
  attempt: number;
  feedback?: string;
  modelHint?: string;
}): Promise<string[]> {
  const prompt = PATTERN_STATEMENTS_PROMPT.replace(
    '{SCORECARD_JSON}',
    JSON.stringify({ holder: input.holder, ...input.scorecard }, null, 2),
  );
  const feedbackSuffix = input.feedback
    ? `\n\nPrior attempt was rejected for: ${input.feedback}. Try again, more conversational.`
    : '';
  const result = await gatewayChat({
    messages: [{ role: 'user', content: prompt + feedbackSuffix }],
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens: 500,
  });
  return parsePatternStatementsOutput(result.text);
}

/** Production bias-tags generator. */
export async function defaultBiasTagsGenerator(patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const prompt = BIAS_TAGS_PROMPT.replace(
    '{PATTERNS_BULLETS}',
    patterns.map(p => `- ${p}`).join('\n'),
  );
  const result = await gatewayChat({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 200,
  });
  return parseBiasTagsOutput(result.text);
}

/** Parse a newline-separated pattern-statement block. */
export function parsePatternStatementsOutput(raw: string): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const lines = raw
    .split('\n')
    .map(l => l.trim())
    // Strip leading numbering/bullets the LLM may emit despite the prompt.
    .map(l => l.replace(/^[-*•]\s+|^\d+[.)]\s+/, ''))
    .filter(l => l.length > 0 && l.length <= 200);
  return lines.slice(0, 4);
}

/** Parse a JSON-array bias-tags block, tolerant of fence wrapping. */
export function parseBiasTagsOutput(raw: string): string[] {
  if (!raw || raw.trim().length === 0) return [];
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  const firstArr = text.indexOf('[');
  if (firstArr === -1) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(firstArr));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim().toLowerCase())
    .filter(t => /^[a-z]+(?:-[a-z0-9]+)*$/.test(t))
    .slice(0, 4);
}

/** Pick the "loudest" pattern slot for the template fallback. */
function pickFallbackSlots(scorecard: TakesScorecard): PatternStatementSlots {
  if (!scorecard || scorecard.resolved === 0) {
    return { domain: 'overall', nRight: 0, nWrong: 0 };
  }
  const direction = scorecard.brier !== null && scorecard.brier > 0.25 ? 'over-confident' : 'mostly right';
  return {
    domain: 'overall',
    nRight: scorecard.correct,
    nWrong: scorecard.incorrect,
    direction,
  };
}

class CalibrationProfilePhase extends BaseCyclePhase {
  readonly name = 'calibration_profile' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.calibration_profile.budget_usd';
  protected readonly budgetUsdDefault = 0.5;

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof GBrainError) return err.problem;
    if (err instanceof Error) {
      if (err.message.includes('voice_gate')) return 'CALIBRATION_VOICE_GATE_EXHAUSTED';
    }
    return 'CALIBRATION_PROFILE_UNKNOWN';
  }

  protected async process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    _ctx: OperationContext,
    opts: CalibrationProfileOpts,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }> {
    const holder = opts.holder ?? 'garry';
    const promptVersion = opts.promptVersion ?? CALIBRATION_PROFILE_PROMPT_VERSION;
    const modelId = opts.model ?? 'claude-sonnet-4-6';
    const gradeCompletion = opts.gradeCompletion ?? 1.0;
    const patternsGenerator = opts.patternsGenerator ?? defaultPatternsGenerator;
    const biasTagsGenerator = opts.biasTagsGenerator ?? defaultBiasTagsGenerator;

    const result: CalibrationProfileResult = {
      profile_written: false,
      voice_gate_passed: false,
      voice_gate_attempts: 0,
      pattern_statements: [],
      active_bias_tags: [],
      total_resolved: 0,
      brier: null,
      warnings: [],
    };

    // Load the holder's scorecard.
    const scorecard = await engine.getScorecard({ holder }, undefined);
    result.total_resolved = scorecard.resolved;
    result.brier = scorecard.brier;

    // Cold-brain branch: not enough resolved takes for a profile yet.
    if (scorecard.resolved < 5) {
      return {
        summary: `calibration_profile: holder=${holder} has only ${scorecard.resolved} resolved takes (need >=5 for a profile)`,
        details: { ...result, skipped: 'insufficient_data' },
        status: 'ok',
      };
    }

    // Generate pattern statements via the voice gate.
    const generate: VoiceGateGenerator = async ({ attempt, feedback }) => {
      const lines = await patternsGenerator({
        scorecard,
        holder,
        attempt,
        ...(feedback !== undefined ? { feedback } : {}),
      });
      return lines.join('\n');
    };

    // Budget gate before invoking the LLM-driven gate.
    const budget = this.checkBudget({
      modelId,
      estimatedInputTokens: 800,
      maxOutputTokens: 500,
    });
    if (!budget.allowed) {
      result.warnings.push(`budget exhausted before profile generation (cap $${budget.budgetUsd.toFixed(2)})`);
      return {
        summary: `calibration_profile: skipped — budget exhausted`,
        details: { ...result, budget_exhausted: true },
        status: 'warn',
      };
    }

    const gateInput: Parameters<typeof gateVoice<PatternStatementSlots>>[0] = {
      mode: 'pattern_statement',
      generate,
      templateFallback: {
        fn: patternStatementTemplate,
        slots: pickFallbackSlots(scorecard),
      },
    };
    if (opts.voiceGateJudge) gateInput.judge = opts.voiceGateJudge;
    const gated = await gateVoice<PatternStatementSlots>(gateInput);

    result.voice_gate_passed = gated.passed;
    result.voice_gate_attempts = gated.attempts;

    // Split the final text into lines (the LLM emits multiple patterns on
    // separate lines; the template fallback is a single line).
    result.pattern_statements = gated.text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    // Bias tags from the patterns. Best-effort; failure is non-fatal.
    try {
      result.active_bias_tags = await biasTagsGenerator(result.pattern_statements);
    } catch (err) {
      result.warnings.push(`bias_tags_generator failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Write the profile row.
    const sourceId = scope.sourceId ?? 'default';
    await engine.executeRaw(
      `INSERT INTO calibration_profiles (
         source_id, holder, generated_at, published,
         total_resolved, brier, accuracy, partial_rate, grade_completion,
         domain_scorecards, pattern_statements,
         voice_gate_passed, voice_gate_attempts,
         active_bias_tags, model_id, cost_usd, judge_model_agreement
       ) VALUES ($1, $2, now(), false,
                 $3, $4, $5, $6, $7,
                 $8::jsonb, $9::text[],
                 $10, $11,
                 $12::text[], $13, NULL, NULL)`,
      [
        sourceId,
        holder,
        scorecard.resolved,
        scorecard.brier,
        scorecard.accuracy,
        scorecard.partial_rate,
        gradeCompletion,
        // domain_scorecards: per-domain breakdown placeholder — v0.36.0.0
        // ships with the overall scorecard only; per-domain comes when
        // batchGetTakesScorecards (F12) lands in Lane C.
        JSON.stringify({}),
        result.pattern_statements,
        result.voice_gate_passed,
        result.voice_gate_attempts,
        result.active_bias_tags,
        modelId,
      ],
    );
    result.profile_written = true;

    return {
      summary:
        `calibration_profile: holder=${holder} brier=${(scorecard.brier ?? 0).toFixed(2)} ` +
        `(${scorecard.resolved} resolved, ${result.pattern_statements.length} patterns, ` +
        `${result.active_bias_tags.length} bias tags, gate ${gated.passed ? 'passed' : 'fell back to template'})`,
      details: { ...result },
      status: 'ok',
    };
  }
}

export async function runPhaseCalibrationProfile(
  ctx: OperationContext,
  opts: CalibrationProfileOpts = {},
) {
  return new CalibrationProfilePhase().run(ctx, opts);
}

export const __testing = {
  CalibrationProfilePhase,
  parsePatternStatementsOutput,
  parseBiasTagsOutput,
  pickFallbackSlots,
};
