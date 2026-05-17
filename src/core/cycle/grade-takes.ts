/**
 * v0.36.0.0 (T4) — grade_takes cycle phase.
 *
 * Walks unresolved takes that are old enough to have outcome data, retrieves
 * evidence from the brain, asks a judge model to verdict each one. Writes
 * verdicts to take_grade_cache. Optionally — only when operator has flipped
 * the opt-in config flag — auto-applies high-confidence verdicts to the
 * canonical takes table via engine.resolveTake.
 *
 * Auto-resolve posture (D17 — auto-resolve disabled by default):
 *   On a fresh install, grade_takes runs and writes verdicts to the cache,
 *   but `applied=false` on every row. Operator reviews the queue, then flips
 *   `cycle.grade_takes.auto_resolve.enabled: true` once trust is earned.
 *
 * Conservative threshold (D12):
 *   When auto_resolve.enabled is true, a verdict auto-applies only when
 *   confidence >= 0.95 (single-judge path; T5 ensemble path tightens this
 *   further). Schema enforces monotonic config tightening: tightening
 *   thresholds is always free, loosening requires --allow-loosen-confidence
 *   flag because relaxing after data accumulates silently shifts which
 *   historical resolutions count as auto-applied.
 *
 * Evidence retrieval status (v0.36.0.0 ship state):
 *   The default evidence retriever returns an "evidence-retrieval not yet
 *   wired" placeholder. Most verdicts produced by the stub-judge against
 *   the stub-evidence will be 'unresolvable'. Real retrieval (hybrid search
 *   over pages newer than the take's since_date, optionally augmented by a
 *   gateway web-search recipe in v0.37+) lands as a follow-up. The phase
 *   ships now so the wiring is real and the cache table accumulates
 *   verdicts even if early ones are conservative; operators get the
 *   end-to-end loop running ahead of the tuned-prompt arrival.
 *
 * Test seam: opts.judge + opts.evidenceRetriever are injected so the
 * phase runs hermetically in unit tests.
 */

import { createHash } from 'node:crypto';
import { BaseCyclePhase, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { GBrainError } from '../types.ts';
import type { OperationContext } from '../operations.ts';
import type { BrainEngine, Take, TakeResolution } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';

/**
 * Bump when the judge prompt or the JSON output shape changes. Old verdicts
 * stay valid (composite cache key includes prompt_version); new runs re-spend
 * LLM tokens.
 */
export const GRADE_TAKES_PROMPT_VERSION = 'v0.36.0.0-stub';

export const GRADE_TAKE_PROMPT = `[v0.36.0.0-stub] You are grading a single forecasting take. The author
made this claim on the given date. Based on the evidence provided, did the
claim turn out to be:
- correct        (the world plays out as predicted)
- incorrect      (the world clearly contradicts the prediction)
- partial        (some aspects right, some wrong; or right direction wrong magnitude)
- unresolvable   (insufficient evidence; outcome still pending)

Output ONLY one JSON object with these fields:
- verdict        ('correct' | 'incorrect' | 'partial' | 'unresolvable')
- confidence     (number in [0,1]) — your self-reported confidence in this verdict.
- reasoning      (string, <=400 chars) — one short paragraph explaining what evidence drove the verdict.

If the evidence is sparse or ambiguous, return verdict='unresolvable' with
confidence reflecting the lack of evidence (NOT certainty of unresolvable).

TAKE:
  Claim:    {CLAIM}
  Kind:     {KIND}
  Holder:   {HOLDER}
  Made on:  {SINCE_DATE}
  Weight:   {WEIGHT}

EVIDENCE:
{EVIDENCE_BLOCK}
`;

/** Verdict from a single judge model. */
export interface JudgeVerdict {
  verdict: 'correct' | 'incorrect' | 'partial' | 'unresolvable';
  confidence: number;
  reasoning: string;
}

/** Judge function signature — injected for tests. */
export type JudgeFn = (input: {
  take: Take;
  evidence: string;
  modelHint?: string;
}) => Promise<JudgeVerdict>;

/** Evidence retriever signature — injected for tests. */
export type EvidenceRetrieverFn = (take: Take, scope: ScopedReadOpts) => Promise<string>;

export interface GradeTakesOpts extends BasePhaseOpts {
  /** Minimum age in months before a take is eligible for grading. Default 6. */
  minAgeMonths?: number;
  /** Limit takes processed in this cycle. Default 50. */
  takeLimit?: number;
  /** Inject the judge model call (tests). */
  judge?: JudgeFn;
  /** Inject the evidence retriever (tests). */
  evidenceRetriever?: EvidenceRetrieverFn;
  /** Override prompt_version (tests). */
  promptVersion?: string;
  /** Judge model id; defaults to the configured chat model. */
  model?: string;
  /**
   * Auto-resolve verdicts above the confidence threshold. D17 default: false.
   * When false, every verdict lands in take_grade_cache with applied=false
   * (review-queue posture). When true, verdicts with confidence >= the
   * configured threshold get applied via engine.resolveTake.
   */
  autoResolve?: boolean;
  /**
   * Confidence threshold for auto-resolve. D12 default: 0.95. Schema-level
   * monotonic-tightening guard (loosening requires --allow-loosen-confidence)
   * lives in the takes resolution layer, not here.
   */
  autoResolveThreshold?: number;
  /** Identifier recorded as resolved_by when auto-applying. Default 'gbrain:grade_takes'. */
  resolvedByLabel?: string;
}

export interface GradeTakesResult {
  takes_scanned: number;
  cache_hits: number;
  verdicts_written: number;
  auto_applied: number;
  too_recent: number;
  budget_exhausted: boolean;
  warnings: string[];
}

/**
 * Compute the evidence_signature for the cache. SHA-256 of evidence text +
 * judge_model_id keeps the cache invalidation honest: re-running with new
 * evidence OR a different judge produces a fresh row.
 */
export function evidenceSignature(evidence: string, judgeModelId: string): string {
  return createHash('sha256').update(judgeModelId + '|' + evidence).digest('hex');
}

/**
 * Parse the judge model's JSON output. Tolerant of fence wrapping and
 * leading prose; returns null on unrecoverable parse failure.
 */
export function parseJudgeOutput(raw: string): JudgeVerdict | null {
  if (!raw || raw.trim().length === 0) return null;
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  const firstObj = text.indexOf('{');
  if (firstObj === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(firstObj));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  const validVerdicts = ['correct', 'incorrect', 'partial', 'unresolvable'] as const;
  const verdict = validVerdicts.includes(r.verdict as never) ? (r.verdict as JudgeVerdict['verdict']) : null;
  if (!verdict) return null;
  const confRaw = typeof r.confidence === 'number' ? r.confidence : Number.parseFloat(String(r.confidence ?? ''));
  if (!Number.isFinite(confRaw)) return null;
  const confidence = Math.max(0, Math.min(1, confRaw));
  const reasoning = typeof r.reasoning === 'string' ? r.reasoning.slice(0, 400) : '';
  return { verdict, confidence, reasoning };
}

/**
 * Default evidence retriever — v0.36.0.0 ship-state placeholder. Real
 * retrieval lands in v0.37+ via hybrid search over pages newer than the
 * take's since_date. Documented limitation per CDX-8 + D17.
 */
export async function defaultEvidenceRetriever(take: Take, _scope: ScopedReadOpts): Promise<string> {
  return `[evidence retrieval not yet wired — v0.36.0.0 ship-state]
Take claim text (the only "evidence" available pre-T-retrieval-impl):
  ${take.claim}
Made on: ${take.since_date ?? 'unknown'}
`;
}

/**
 * Production judge — calls gateway.chat with the GRADE_TAKE_PROMPT.
 */
export async function defaultJudge(input: {
  take: Take;
  evidence: string;
  modelHint?: string;
}): Promise<JudgeVerdict> {
  const prompt = GRADE_TAKE_PROMPT
    .replace('{CLAIM}', input.take.claim)
    .replace('{KIND}', input.take.kind)
    .replace('{HOLDER}', input.take.holder)
    .replace('{SINCE_DATE}', input.take.since_date ?? 'unknown')
    .replace('{WEIGHT}', String(input.take.weight))
    .replace('{EVIDENCE_BLOCK}', input.evidence);

  const result = await gatewayChat({
    messages: [{ role: 'user', content: prompt }],
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens: 600,
  });
  const parsed = parseJudgeOutput(result.text);
  if (!parsed) {
    // Failed parse — treat as unresolvable at low confidence so the row
    // still lands in the cache (operator sees the LLM's parse failure
    // surfaced via warnings) rather than disappearing silently.
    return {
      verdict: 'unresolvable',
      confidence: 0.0,
      reasoning: 'judge_output_parse_failed',
    };
  }
  return parsed;
}

/**
 * Determine whether a take is old enough to grade. Defaults to 6 months.
 * Takes without since_date are NOT graded (we'd be hallucinating context).
 */
export function takeIsOldEnough(take: Take, minAgeMonths: number, now: Date = new Date()): boolean {
  if (!take.since_date) return false;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - minAgeMonths);
  // Tolerant date parsing — since_date can be YYYY-MM-DD or YYYY-MM.
  const sinceStr = take.since_date.length === 7 ? take.since_date + '-15' : take.since_date;
  const sinceDate = new Date(sinceStr);
  if (Number.isNaN(sinceDate.getTime())) return false;
  return sinceDate.getTime() <= cutoff.getTime();
}

/**
 * Derive the TakeResolution for a verdict. 'unresolvable' DOES NOT auto-apply
 * — only correct/incorrect/partial do.
 */
function verdictToResolution(verdict: JudgeVerdict, resolvedByLabel: string): TakeResolution | null {
  if (verdict.verdict === 'unresolvable') return null;
  return {
    quality: verdict.verdict,
    resolvedBy: resolvedByLabel,
    source: `grade_takes:${GRADE_TAKES_PROMPT_VERSION}`,
  };
}

class GradeTakesPhase extends BaseCyclePhase {
  readonly name = 'grade_takes' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.grade_takes.budget_usd';
  protected readonly budgetUsdDefault = 3.0;

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof GBrainError) return err.problem;
    if (err instanceof Error) {
      if (err.message.includes('budget') || err.message.includes('Budget')) return 'CALIBRATION_GRADE_BUDGET_EXHAUSTED';
      if (err.message.includes('parse')) return 'CALIBRATION_GRADE_PARSE_FAIL';
    }
    return 'GRADE_TAKES_UNKNOWN';
  }

  protected async process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    _ctx: OperationContext,
    opts: GradeTakesOpts,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }> {
    const judge = opts.judge ?? defaultJudge;
    const evidenceRetriever = opts.evidenceRetriever ?? defaultEvidenceRetriever;
    const promptVersion = opts.promptVersion ?? GRADE_TAKES_PROMPT_VERSION;
    const minAgeMonths = opts.minAgeMonths ?? 6;
    const takeLimit = opts.takeLimit ?? 50;
    const autoResolve = opts.autoResolve ?? false; // D17 default OFF
    const autoResolveThreshold = opts.autoResolveThreshold ?? 0.95; // D12 conservative
    const resolvedByLabel = opts.resolvedByLabel ?? 'gbrain:grade_takes';
    const judgeModelId = opts.model ?? 'claude-sonnet-4-6';

    const result: GradeTakesResult = {
      takes_scanned: 0,
      cache_hits: 0,
      verdicts_written: 0,
      auto_applied: 0,
      too_recent: 0,
      budget_exhausted: false,
      warnings: [],
    };

    // Load unresolved active takes, oldest-first.
    const takes = await engine.listTakes({
      resolved: false,
      active: true,
      sortBy: 'since_date',
      limit: takeLimit,
    });

    if (opts.reporter) {
      opts.reporter.start('grade_takes.takes' as never, takes.length);
    }

    const now = new Date();
    for (const take of takes) {
      result.takes_scanned += 1;
      this.tick(opts);

      if (!takeIsOldEnough(take, minAgeMonths, now)) {
        result.too_recent += 1;
        continue;
      }

      // Retrieve evidence first — the signature depends on it.
      const evidence = await evidenceRetriever(take, scope);
      const sig = evidenceSignature(evidence, judgeModelId);

      // Idempotency: skip when (take_id, prompt_version, judge_model_id, evidence_signature) exists.
      const cached = await engine.executeRaw<{ verdict: string; confidence: number; applied: boolean }>(
        `SELECT verdict, confidence, applied FROM take_grade_cache
         WHERE take_id = $1 AND prompt_version = $2 AND judge_model_id = $3 AND evidence_signature = $4
         LIMIT 1`,
        [take.id, promptVersion, judgeModelId, sig],
      );
      if (cached.length > 0) {
        result.cache_hits += 1;
        continue;
      }

      // Budget pre-check.
      const budget = this.checkBudget({
        modelId: judgeModelId,
        estimatedInputTokens: 1200,
        maxOutputTokens: 400,
      });
      if (!budget.allowed) {
        result.budget_exhausted = true;
        result.warnings.push(
          `budget exhausted at take ${result.takes_scanned}/${takes.length} (cumulative $${budget.cumulativeCostUsd.toFixed(4)} / cap $${budget.budgetUsd.toFixed(2)})`,
        );
        break;
      }

      // Call the judge. Errors on a single take log warning + continue.
      let verdict: JudgeVerdict;
      try {
        verdict = await judge({ take, evidence, modelHint: opts.model });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings.push(`judge failed on take ${take.id}: ${msg}`);
        continue;
      }

      // Decide auto-resolve eligibility BEFORE writing to cache so the
      // `applied` column reflects the decision.
      const resolution = verdictToResolution(verdict, resolvedByLabel);
      const shouldApply =
        autoResolve &&
        resolution !== null &&
        verdict.confidence >= autoResolveThreshold;

      // Write the verdict to the cache. Idempotency conflict means another
      // run beat us to it; either way the row exists with consistent state.
      await engine.executeRaw(
        `INSERT INTO take_grade_cache
           (take_id, prompt_version, judge_model_id, evidence_signature, verdict, confidence, applied)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (take_id, prompt_version, judge_model_id, evidence_signature) DO NOTHING`,
        [take.id, promptVersion, judgeModelId, sig, verdict.verdict, verdict.confidence, shouldApply],
      );
      result.verdicts_written += 1;

      // Apply to canonical takes if eligible.
      if (shouldApply && resolution) {
        try {
          await engine.resolveTake(take.page_id, take.row_num, resolution);
          result.auto_applied += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.warnings.push(`auto-apply failed on take ${take.id}: ${msg}`);
        }
      }
    }

    if (opts.reporter) opts.reporter.finish();

    const summary =
      `grade_takes: scanned ${result.takes_scanned} takes ` +
      `(${result.too_recent} too recent, ${result.cache_hits} cached, ` +
      `${result.verdicts_written} new verdicts, ${result.auto_applied} auto-applied)`;
    return {
      summary,
      details: {
        ...result,
        prompt_version: promptVersion,
        auto_resolve: autoResolve,
        auto_resolve_threshold: autoResolveThreshold,
      },
      status: result.budget_exhausted ? 'warn' : 'ok',
    };
  }
}

export async function runPhaseGradeTakes(
  ctx: OperationContext,
  opts: GradeTakesOpts = {},
) {
  return new GradeTakesPhase().run(ctx, opts);
}

export const __testing = {
  GradeTakesPhase,
  parseJudgeOutput,
  evidenceSignature,
  takeIsOldEnough,
  verdictToResolution,
};
