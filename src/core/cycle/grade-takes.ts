/**
 * v0.36.1.0 (T4) — grade_takes cycle phase.
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
 * Evidence retrieval (#2811):
 *   The default evidence retriever runs a real hybrid search on the take's
 *   claim (expansion off, source-scoped, the take's own page excluded) and
 *   formats the hits via the pure `formatEvidenceBlock` — each item carries
 *   its slug + effective_date and is annotated relative to the take's
 *   since_date (evidence dated BEFORE the claim is context, not outcome).
 *   Items clamp at ~500 chars; the whole block caps at 4k. Zero hits and
 *   retrieval failures fall back to explicit notes steering the judge to
 *   'unresolvable' rather than fabricating.
 *
 * Test seam: opts.judge + opts.evidenceRetriever are injected so the
 * phase runs hermetically in unit tests.
 */

import { createHash } from 'node:crypto';
import { BaseCyclePhase, effectivePhaseDeadlineMs, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { hybridSearch } from '../search/hybrid.ts';
import type { SearchResult } from '../types.ts';
import { chat as gatewayChat, getChatModel } from '../ai/gateway.ts';
import { createGlobalLlmHaltTracker, haltedClassOf, type GlobalLlmErrorClass } from '../ai/errors.ts';
import { splitProviderModelId } from '../model-id.ts';
import { GBrainError } from '../types.ts';
import type { OperationContext } from '../operations.ts';
import type { BrainEngine, Take, TakeResolution } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';

/**
 * Bump when the judge prompt or the JSON output shape changes. Old verdicts
 * stay valid (composite cache key includes prompt_version); new runs re-spend
 * LLM tokens.
 */
export const GRADE_TAKES_PROMPT_VERSION = 'hybrid-evidence-v1';

export const GRADE_TAKE_PROMPT = `[hybrid-evidence-v1] You are grading a single forecasting take. The author
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
  /** Override the phase wall-clock deadline (tests). Default: 30 min, clamped to the job deadline (gbrain#4168). */
  deadlineMs?: number;
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
   * v0.36.1.0 (T11 / E4) — gstack-learnings coupling on incorrect/partial
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
   * Defaults to [openai:gpt-5.2, anthropic:claude-sonnet-4-6, google:gemini-2.0-flash]
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
  /**
   * Set when the take loop broke on a whole-run LLM failure (#3044):
   * auth/billing on the first hit, rate_limit after RATE_LIMIT_HALT_STREAK
   * consecutive hits — from the single-model judge OR a rejected ensemble
   * judge. The phase reports 'warn' ('fail' when NO judge call succeeded)
   * so the condition can't hide behind a green summary.
   */
  aborted_global_error?: GlobalLlmErrorClass;
  /** Single-model judge calls that returned (cache hits don't count). */
  judge_calls_succeeded: number;
  /** Single-model judge calls that threw (global or per-take alike). */
  judge_calls_failed: number;
  warnings: string[];
  /** E2 ensemble (T5): count of takes where the ensemble tiebreaker fired. */
  ensemble_invoked: number;
  /** E2 ensemble (T5): count of takes where ensemble produced 3/3 unanimous. */
  ensemble_unanimous: number;
  /** gbrain#4168: true when the phase deadline fired mid-loop (partial result). */
  deadline_hit: boolean;
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

/** #2811 — evidence retrieval knobs. */
export const EVIDENCE_SEARCH_LIMIT = 8;
export const EVIDENCE_ITEM_CLAMP_CHARS = 500;
export const EVIDENCE_BLOCK_CAP_CHARS = 4000;

/** The narrow slice of a SearchResult the evidence formatter reads. */
export type EvidenceHit = Pick<SearchResult, 'slug' | 'title' | 'chunk_text' | 'effective_date'>;

/**
 * #2811 — pure evidence-block formatter (unit-testable, no engine).
 *
 * Each hit renders as one item carrying its slug + effective_date, annotated
 * relative to the take's since_date: evidence dated BEFORE the claim can only
 * be context (it cannot prove an outcome), evidence dated on/after can. Items
 * clamp at EVIDENCE_ITEM_CLAMP_CHARS; the whole block caps at
 * EVIDENCE_BLOCK_CAP_CHARS. Zero hits produce an explicit no-evidence note
 * that steers the judge toward 'unresolvable'.
 */
export function formatEvidenceBlock(take: Take, hits: EvidenceHit[]): string {
  const sinceDate = take.since_date ?? 'unknown';
  if (hits.length === 0) {
    return (
      `No evidence found in the brain for this claim (hybrid search returned zero results).\n` +
      `The claim was made on: ${sinceDate}. With nothing in the brain mentioning the ` +
      `subject, grade 'unresolvable' — do not fabricate an outcome.`
    );
  }
  const lines: string[] = [];
  for (const h of hits) {
    const itemDate = h.effective_date ? String(h.effective_date).slice(0, 10) : null;
    let recency = '';
    if (itemDate && take.since_date) {
      // Lexicographic compare works for ISO prefixes (YYYY-MM vs YYYY-MM-DD:
      // compare on the shorter's length so a same-month hit counts as after).
      const cmpLen = Math.min(itemDate.length, take.since_date.length);
      recency = itemDate.slice(0, cmpLen) >= take.since_date.slice(0, cmpLen)
        ? ' (dated after the claim)'
        : ' (dated BEFORE the claim — context only, not outcome evidence)';
    }
    const text = (h.chunk_text ?? '').replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_ITEM_CLAMP_CHARS);
    if (!text) continue;
    lines.push(`- [${h.slug} • ${itemDate ?? 'undated'}]${recency}\n  ${text}`);
  }
  if (lines.length === 0) {
    return (
      `No usable evidence text found in the brain for this claim.\n` +
      `The claim was made on: ${sinceDate}. Grade 'unresolvable' — do not fabricate an outcome.`
    );
  }
  let block = lines.join('\n');
  if (block.length > EVIDENCE_BLOCK_CAP_CHARS) {
    block = block.slice(0, EVIDENCE_BLOCK_CAP_CHARS) + '\n[evidence truncated]';
  }
  return block;
}

/**
 * Default evidence retriever (#2811) — real hybrid search on the take's
 * claim text: expansion off (deterministic, no extra LLM spend), source
 * scope threaded (federated array beats scalar per sourceScopeOpts), and
 * the take's OWN page excluded (its body restates the claim — feeding it
 * back in would let the judge grade a claim against itself). Fail-open:
 * a retrieval error degrades to a claim-only note steering the judge to
 * 'unresolvable' rather than aborting the phase.
 *
 * Takes the engine explicitly; process() binds it so the injected-seam
 * type (EvidenceRetrieverFn) is unchanged.
 */
export async function defaultEvidenceRetriever(
  engine: BrainEngine,
  take: Take,
  scope: ScopedReadOpts,
): Promise<string> {
  try {
    const hits = await hybridSearch(engine, take.claim, {
      limit: EVIDENCE_SEARCH_LIMIT,
      expansion: false,
      ...(scope.sourceIds && scope.sourceIds.length > 0
        ? { sourceIds: scope.sourceIds }
        : scope.sourceId
          ? { sourceId: scope.sourceId }
          : {}),
      ...(take.page_slug ? { exclude_slugs: [take.page_slug] } : {}),
    });
    // Belt-and-suspenders on top of exclude_slugs.
    const filtered = hits.filter((h) => h.slug !== take.page_slug);
    return formatEvidenceBlock(take, filtered);
  } catch (err) {
    return (
      `[evidence retrieval failed: ${(err as Error).message}]\n` +
      `Claim: ${take.claim}\n` +
      `Made on: ${take.since_date ?? 'unknown'}\n` +
      `With no retrievable evidence, grade 'unresolvable' — do not fabricate an outcome.`
    );
  }
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

/**
 * Hard wall-clock deadline for the grade_takes phase (gbrain#4168). Same
 * clean-partial-exit contract as propose_takes: judge calls have long tails,
 * and without a phase deadline the worker's job timeout killed the phase
 * mid-write instead of letting it bank completed verdicts.
 */
const GRADE_TAKES_PHASE_DEADLINE_MS = 30 * 60 * 1000;

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
    // #2811: bind the engine here so the injected-seam type stays
    // (take, scope) => Promise<string>.
    const evidenceRetriever: EvidenceRetrieverFn =
      opts.evidenceRetriever ??
      ((take: Take, takeScope: ScopedReadOpts) => defaultEvidenceRetriever(engine, take, takeScope));
    const promptVersion = opts.promptVersion ?? GRADE_TAKES_PROMPT_VERSION;
    const minAgeMonths = opts.minAgeMonths ?? 6;
    const takeLimit = opts.takeLimit ?? 50;
    const autoResolve = opts.autoResolve ?? false; // D17 default OFF
    const autoResolveThreshold = opts.autoResolveThreshold ?? 0.95; // D12 conservative
    const resolvedByLabel = opts.resolvedByLabel ?? 'gbrain:grade_takes';
    // One resolved string drives the judge call, the verdict-cache key, and
    // the stored judge_model_id — the convention propose_takes adopted in
    // v0.42.62. Previously the default judge call passed NO model hint (it
    // rode the gateway's chat_model) while 'claude-sonnet-4-6' was hardcoded
    // into judge_model_id, the evidence signature, and budget metering — on
    // brains with a different chat_model, telemetry priced and recorded a
    // model that never ran.
    const judgeModelFull = opts.model ?? getChatModel();
    // Bare tail for the stored judge_model_id + evidence signature
    // (historical convention). Stock installs are unchanged: getChatModel()
    // defaults to 'anthropic:claude-sonnet-4-6', whose tail equals the old
    // hardcoded value — zero verdict-cache invalidation. A genuinely
    // different chat_model invalidates, which is correct: the judge really
    // changed.
    const judgeModelId = splitProviderModelId(judgeModelFull).model || judgeModelFull;

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
      judge_calls_succeeded: 0,
      judge_calls_failed: 0,
      warnings: [],
      ensemble_invoked: 0,
      ensemble_unanimous: 0,
      deadline_hit: false,
    };

    // gbrain#4168: relative phase deadline clamped to the job's absolute
    // deadline minus the reserve — same clean partial-exit contract as
    // propose_takes (break, bank verdicts already written, report).
    const phaseStartMs = Date.now();
    const deadlineMs = effectivePhaseDeadlineMs(
      opts.deadlineMs ?? GRADE_TAKES_PHASE_DEADLINE_MS,
      opts.deadlineAtMs,
      phaseStartMs,
    );
    if (deadlineMs <= 0) {
      // Job budget already inside the reserve — exit before ANY judge call.
      result.warnings.push('phase skipped: job deadline already inside the reserve window');
      result.deadline_hit = true;
      return {
        summary: 'grade_takes: skipped — job deadline inside the reserve window',
        details: { ...result, prompt_version: promptVersion, auto_resolve: autoResolve, auto_resolve_threshold: autoResolveThreshold },
        status: 'warn',
      };
    }

    // #3044 — shared halt policy over single-model judge AND ensemble
    // rejections (rate limits counted at most once per take via
    // rateLimitedThisTake). A take that completes without one resets the
    // streak; auth/billing halt on the first hit.
    const llmHalt = createGlobalLlmHaltTracker();

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
      // Phase deadline check (gbrain#4168). Break, not throw: verdicts
      // already cached stay banked, and the phase reports partial cleanly
      // before the worker's kill switch fires.
      const elapsedMs = Date.now() - phaseStartMs;
      if (elapsedMs > deadlineMs) {
        result.warnings.push(
          `phase deadline hit at take ${result.takes_scanned}/${takes.length} ` +
          `after ${(elapsedMs / 1000).toFixed(0)}s (cap ${(deadlineMs / 1000).toFixed(0)}s); partial completion`,
        );
        result.deadline_hit = true;
        break;
      }

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

      // Budget pre-check. #2811: the input estimate is size-derived — real
      // evidence blocks vary from a one-line no-evidence note to the 4k cap,
      // and the old fixed 1200 underestimated a full block by ~2x.
      const budget = this.checkBudget({
        modelId: judgeModelId,
        estimatedInputTokens: Math.ceil(
          (GRADE_TAKE_PROMPT.length + take.claim.length + evidence.length) / 4,
        ),
        maxOutputTokens: 400,
      });
      if (!budget.allowed) {
        result.budget_exhausted = true;
        result.warnings.push(
          `budget exhausted at take ${result.takes_scanned}/${takes.length} (cumulative $${budget.cumulativeCostUsd.toFixed(4)} / cap $${budget.budgetUsd.toFixed(2)})`,
        );
        break;
      }

      // Call the single-model judge. Per-take errors log a warning and
      // continue — UNLESS they classify as a whole-run condition (#3044):
      // auth/billing halts on the first hit; a bare rate_limit halts only
      // after RATE_LIMIT_HALT_STREAK consecutive hits.
      let rateLimitedThisTake = false;
      let verdict: JudgeVerdict;
      try {
        verdict = await judge({ take, evidence, modelHint: judgeModelFull });
      } catch (err) {
        result.judge_calls_failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        const detail = `judge failed on take ${take.id}: ${msg}`;
        const decision = llmHalt.observe(err);
        if (decision !== 'continue') {
          result.aborted_global_error = haltedClassOf(decision)!;
          result.warnings.push(
            `aborting phase at take ${result.takes_scanned}/${takes.length}: ` +
            `${llmHalt.note()} (${detail})`,
          );
          break;
        }
        result.warnings.push(detail);
        continue;
      }
      result.judge_calls_succeeded += 1;

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

        // #3044: Promise.allSettled flattens judge rejections into null
        // verdicts below, so a whole-run condition (revoked key, exhausted
        // spend limit) inside an ensemble judge would vanish into a
        // "(failed)" note in the reasoning string. Classify each rejection
        // with the same two-tier policy as the single-model path:
        // auth/billing halts immediately; rate_limit (counted at most once
        // per take) feeds the consecutive-streak counter.
        let ensembleHaltClass: GlobalLlmErrorClass | null = null;
        let ensembleHaltDetail = '';
        for (let i = 0; i < ensembleResults.length; i++) {
          const res = ensembleResults[i];
          if (!res || res.status !== 'rejected') continue;
          const decision = llmHalt.observe(res.reason, { countRateLimit: !rateLimitedThisTake });
          if (llmHalt.lastClass() === null) continue;
          if (llmHalt.lastClass() === 'rate_limit') rateLimitedThisTake = true;
          const judgeId = opts.ensembleJudges[i]?.modelId ?? 'unknown';
          const rmsg = res.reason instanceof Error ? res.reason.message : String(res.reason);
          const detail = `ensemble judge ${judgeId} failed on take ${take.id}: ${rmsg}`;
          if (decision !== 'continue') {
            ensembleHaltClass = haltedClassOf(decision);
            ensembleHaltDetail = detail;
            break;
          }
          result.warnings.push(detail);
        }
        if (ensembleHaltClass) {
          result.aborted_global_error = ensembleHaltClass;
          result.warnings.push(
            `aborting phase at take ${result.takes_scanned}/${takes.length}: ` +
            `${llmHalt.note()} (${ensembleHaltDetail})`,
          );
          break;
        }

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

      // #3044: a take that completed without any rate_limit-classified LLM
      // failure breaks the consecutive streak. (Cache hits / too-recent
      // takes `continue` before the judge call and neither extend nor
      // reset it.)
      if (!rateLimitedThisTake) llmHalt.reset();

      // Tally is silent — the caller surfaces it via the GradeTakesResult.
      void recordedVerdict;
    }

    if (opts.reporter) opts.reporter.finish();

    // Status folds warnings in (the extract_facts precedent from #1928): a
    // run with swallowed per-take failures must not read as a clean 'ok'.
    // Severity split (#3044): a global halt with ZERO successful judge calls
    // means the whole LLM lane is down — phase 'fail' (deriveStatus turns
    // one failed phase into a 'partial' cycle; the autopilot handler
    // deliberately does not throw on partial). A halt after some successes
    // is a partial run → 'warn'.
    const warningCount = result.warnings.length;
    // A deadline-hit run halted mid-list the same way a budget-exhausted one
    // does (matches the propose_takes #4168 posture) — folded into `halted`
    // so both the details field and the status derivation see it.
    const halted =
      result.budget_exhausted ||
      result.deadline_hit === true ||
      result.aborted_global_error !== undefined;
    const phaseFailed =
      result.aborted_global_error !== undefined && result.judge_calls_succeeded === 0;
    const summary =
      `grade_takes: scanned ${result.takes_scanned} takes ` +
      `(${result.too_recent} too recent, ${result.cache_hits} cached, ` +
      `${result.verdicts_written} new verdicts, ${result.auto_applied} auto-applied)` +
      (result.deadline_hit ? ' [deadline hit — partial]' : '') +
      (result.aborted_global_error
        ? `; aborted on ${result.aborted_global_error} error after ${result.takes_scanned} take(s)`
        : '') +
      (warningCount > 0 ? ` (${warningCount} warning(s))` : '');
    return {
      summary,
      details: {
        ...result,
        halted,
        prompt_version: promptVersion,
        auto_resolve: autoResolve,
        auto_resolve_threshold: autoResolveThreshold,
      },
      status: phaseFailed ? 'fail' : halted || warningCount > 0 ? 'warn' : 'ok',
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
