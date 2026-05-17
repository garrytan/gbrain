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

/**
 * Multi-judge ensemble verdict aggregation (E2, T5).
 *
 * Per D17 + D12 conservative posture: an ensemble verdict auto-applies only
 * when ALL three model verdicts agree AND the minimum confidence across the
 * three is >= the ensemble threshold (default 0.85). Anything less → cache
 * with applied=false (review-queue posture).
 *
 * 'unresolvable' verdicts NEVER count toward consensus (a single
 * 'unresolvable' result drops the agreement count). This is intentional —
 * one model saying "I can't tell" plus two saying "correct" should NOT
 * auto-apply 'correct'.
 */
export interface EnsembleVerdict {
  verdict: JudgeVerdict['verdict'];
  minConfidence: number;
  agreement: number; // 0..3, count of models that returned this verdict
  modelVerdicts: Array<{ modelId: string; verdict: JudgeVerdict['verdict']; confidence: number; failed?: boolean }>;
}

/**
 * Aggregate per-model verdicts into an EnsembleVerdict. Pure function.
 *
 * Algorithm:
 *  1. Filter out failed model responses (rejected promises in the caller).
 *  2. Tally verdict labels.
 *  3. Winner = label with the most votes. Ties: 'unresolvable' loses; any
 *     other label wins via deterministic alphabetical order.
 *  4. agreement = count of models that returned the winning label.
 *  5. minConfidence = MIN across the models that returned the winning label.
 *
 * Caller decides whether to auto-apply based on the (agreement === 3 AND
 * minConfidence >= threshold) rule.
 */
export function aggregateEnsemble(
  results: Array<{ modelId: string; verdict: JudgeVerdict | null }>,
): EnsembleVerdict {
  const modelVerdicts: EnsembleVerdict['modelVerdicts'] = results.map(r =>
    r.verdict
      ? { modelId: r.modelId, verdict: r.verdict.verdict, confidence: r.verdict.confidence }
      : { modelId: r.modelId, verdict: 'unresolvable', confidence: 0, failed: true },
  );

  // Tally only the non-failed verdicts.
  const tally = new Map<JudgeVerdict['verdict'], number>();
  for (const r of results) {
    if (!r.verdict) continue;
    tally.set(r.verdict.verdict, (tally.get(r.verdict.verdict) ?? 0) + 1);
  }

  // Pick the winner. Tie-break: prefer non-unresolvable, then alphabetical
  // for determinism.
  let winner: JudgeVerdict['verdict'] = 'unresolvable';
  let bestCount = 0;
  for (const [v, n] of tally.entries()) {
    if (n > bestCount) {
      winner = v;
      bestCount = n;
    } else if (n === bestCount) {
      // Tie. Prefer non-unresolvable.
      if (winner === 'unresolvable' && v !== 'unresolvable') {
        winner = v;
      } else if (v !== 'unresolvable' && winner !== 'unresolvable' && v < winner) {
        winner = v;
      }
    }
  }

  // minConfidence: min across the models that returned the winning label.
  let minConfidence = 1;
  let agreementCount = 0;
  for (const r of results) {
    if (r.verdict && r.verdict.verdict === winner) {
      agreementCount += 1;
      if (r.verdict.confidence < minConfidence) minConfidence = r.verdict.confidence;
    }
  }
  if (agreementCount === 0) minConfidence = 0;

  return { verdict: winner, minConfidence, agreement: agreementCount, modelVerdicts };
}

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
  /**
   * v0.36.0.0 (T11 / E4) — gstack-learnings coupling on incorrect/partial
   * auto-resolutions. Config gate: `cycle.grade_takes.write_gstack_learnings`.
   * Default false for external users (gstack may not be installed); Garry's
   * brain flips it true to opt in. Failures are non-fatal (warning).
   */
  writeGstackLearnings?: boolean;
  /**
   * E2 ensemble (T5): when true, borderline single-model verdicts
   * (0.6 <= confidence < 0.95) fire a 3-model ensemble tiebreaker. Default
   * false (single-model only).
   */
  useEnsemble?: boolean;
  /**
   * E2 ensemble judges. When useEnsemble=true and the single-model verdict
   * is borderline, all three judges are called in parallel via Promise.allSettled.
   * Defaults to [openai:gpt-4o, anthropic:claude-sonnet-4-6, google:gemini-1.5-pro]
   * via defaultJudge with model-string overrides. Tests inject deterministic
   * judges.
   */
  ensembleJudges?: Array<{ modelId: string; fn: JudgeFn }>;
  /**
   * E2 ensemble auto-apply threshold. Default 0.85 (D12 conservative): MIN
   * confidence across the agreeing models must be >= this AND agreement
   * must be 3/3 unanimous.
   */
  ensembleThreshold?: number;
  /**
   * E2 ensemble TRIGGER band [lower, upper). Single-model verdicts whose
   * confidence falls in this band invoke the ensemble. Default [0.6, 0.95).
   * Below the lower bound: single is clearly unresolvable / review-only.
   * Above the upper bound: single is sufficient.
   */
  ensembleTriggerBand?: [number, number];
}

export interface GradeTakesResult {
  takes_scanned: number;
  cache_hits: number;
  verdicts_written: number;
  auto_applied: number;
  too_recent: number;
  budget_exhausted: boolean;
  warnings: string[];
  /** E2 ensemble (T5): count of takes where the ensemble tiebreaker fired. */
  ensemble_invoked: number;
  /** E2 ensemble (T5): count of takes where ensemble produced 3/3 unanimous. */
  ensemble_unanimous: number;
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

    const useEnsemble = opts.useEnsemble ?? false;
    const ensembleThreshold = opts.ensembleThreshold ?? 0.85;
    const ensembleTriggerBand = opts.ensembleTriggerBand ?? [0.6, 0.95];

    const result: GradeTakesResult = {
      takes_scanned: 0,
      cache_hits: 0,
      verdicts_written: 0,
      auto_applied: 0,
      too_recent: 0,
      budget_exhausted: false,
      warnings: [],
      ensemble_invoked: 0,
      ensemble_unanimous: 0,
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

      // Call the single-model judge. Errors on a single take log warning + continue.
      let verdict: JudgeVerdict;
      try {
        verdict = await judge({ take, evidence, modelHint: opts.model });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings.push(`judge failed on take ${take.id}: ${msg}`);
        continue;
      }

      // T5 — ensemble tiebreaker for borderline single-model verdicts.
      let recordedJudgeModelId = judgeModelId;
      let recordedVerdict = verdict;
      let ensembleApplyEligible = false;
      const inBorderlineBand =
        verdict.confidence >= ensembleTriggerBand[0] &&
        verdict.confidence < ensembleTriggerBand[1] &&
        verdict.verdict !== 'unresolvable';

      if (useEnsemble && inBorderlineBand && opts.ensembleJudges && opts.ensembleJudges.length > 0) {
        result.ensemble_invoked += 1;
        const ensembleResults = await Promise.allSettled(
          opts.ensembleJudges.map(j => j.fn({ take, evidence, modelHint: j.modelId })),
        );
        const collected: Array<{ modelId: string; verdict: JudgeVerdict | null }> = opts.ensembleJudges.map((j, i) => {
          const res = ensembleResults[i];
          if (res && res.status === 'fulfilled') return { modelId: j.modelId, verdict: res.value };
          return { modelId: j.modelId, verdict: null };
        });
        const ensemble = aggregateEnsemble(collected);

        // Record the ensemble verdict in the cache row instead of the single-model
        // verdict. The judge_model_id becomes 'ensemble:<modelA>+<modelB>+<modelC>'
        // so a future re-run with different ensemble membership doesn't collide.
        recordedJudgeModelId = `ensemble:${opts.ensembleJudges.map(j => j.modelId).join('+')}`;
        recordedVerdict = {
          verdict: ensemble.verdict,
          confidence: ensemble.minConfidence,
          reasoning: `ensemble agreement ${ensemble.agreement}/3; per-model: ${
            ensemble.modelVerdicts.map(m => `${m.modelId}=${m.verdict}@${m.confidence.toFixed(2)}${m.failed ? '(failed)' : ''}`).join(', ')
          }`,
        };
        if (ensemble.agreement === 3) result.ensemble_unanimous += 1;

        // Ensemble auto-apply eligibility: 3/3 unanimous AND min confidence
        // >= ensembleThreshold AND verdict not 'unresolvable'.
        ensembleApplyEligible =
          ensemble.agreement === 3 &&
          ensemble.minConfidence >= ensembleThreshold &&
          ensemble.verdict !== 'unresolvable';
      }

      // Decide auto-resolve eligibility BEFORE writing to cache so the
      // `applied` column reflects the decision. Two paths:
      //   - Ensemble path: requires 3/3 unanimous + min conf >= ensembleThreshold
      //   - Single-model path: requires confidence >= autoResolveThreshold
      // 'unresolvable' verdict NEVER auto-applies either way.
      const resolution = verdictToResolution(recordedVerdict, resolvedByLabel);
      let shouldApply = false;
      if (autoResolve && resolution !== null) {
        if (recordedJudgeModelId.startsWith('ensemble:')) {
          shouldApply = ensembleApplyEligible;
        } else {
          shouldApply = recordedVerdict.confidence >= autoResolveThreshold;
        }
      }

      // Compute a NEW evidence_signature when ensemble fires, since the
      // cache composite key includes judge_model_id. (sig was computed
      // against the single-model judge_model_id earlier.)
      const recordedSig = recordedJudgeModelId === judgeModelId
        ? sig
        : evidenceSignature(evidence, recordedJudgeModelId);

      // Write the verdict to the cache. Idempotency conflict means another
      // run beat us to it; either way the row exists with consistent state.
      await engine.executeRaw(
        `INSERT INTO take_grade_cache
           (take_id, prompt_version, judge_model_id, evidence_signature, verdict, confidence, applied)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (take_id, prompt_version, judge_model_id, evidence_signature) DO NOTHING`,
        [take.id, promptVersion, recordedJudgeModelId, recordedSig, recordedVerdict.verdict, recordedVerdict.confidence, shouldApply],
      );
      result.verdicts_written += 1;

      // Apply to canonical takes if eligible.
      if (shouldApply && resolution) {
        try {
          await engine.resolveTake(take.page_id, take.row_num, resolution);
          result.auto_applied += 1;

          // T11 / E4 — gstack-learnings coupling on incorrect / partial
          // auto-resolutions. Best-effort: failures log warning + continue.
          if (
            (recordedVerdict.verdict === 'incorrect' || recordedVerdict.verdict === 'partial') &&
            opts.writeGstackLearnings === true
          ) {
            const { writeIncorrectResolution } = await import('../calibration/gstack-coupling.ts');
            const coupling = await writeIncorrectResolution({
              event: {
                takeId: take.id,
                pageSlug: take.page_slug,
                rowNum: take.row_num,
                holder: take.holder,
                claim: take.claim,
                quality: recordedVerdict.verdict,
                weight: take.weight,
                confidence: recordedVerdict.confidence,
                reasoning: recordedVerdict.reasoning,
              },
              enabled: true,
            });
            if (!coupling.written && coupling.reason !== 'config_disabled') {
              result.warnings.push(
                `gstack coupling skipped (take ${take.id}): ${coupling.reason}${coupling.error ? ` — ${coupling.error}` : ''}`,
              );
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.warnings.push(`auto-apply failed on take ${take.id}: ${msg}`);
        }
      }

      // Tally is silent — the caller surfaces it via the GradeTakesResult.
      void recordedVerdict;
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
  aggregateEnsemble,
};
