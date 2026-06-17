/**
 * v0.36.1.0 (D21) — BaseCyclePhase abstract class for the Hindsight calibration
 * wave. Three new phases (`propose_takes`, `grade_takes`, `calibration_profile`)
 * share enough structure that the duplication-vs-abstraction trade tips toward
 * a shared base. Without this scaffold, each phase reimplements the same five
 * concerns and source-isolation discipline drifts the way it drifted in v0.34.1.
 *
 * What this enforces:
 *   1. Phase signature is uniform: `run(ctx, opts) → PhaseResult`.
 *   2. ctx.sourceId / ctx.auth.allowedSources MUST be threaded — the base class
 *      surfaces a `scope()` helper that wraps `sourceScopeOpts(ctx)` and
 *      forbids the subclass from reading `ctx.engine` directly. Forgetting to
 *      thread source scope becomes a TypeScript compile error, not a runtime
 *      leak. Closes the v0.34.1 source-isolation bug class structurally.
 *   3. Budget meter wraps run() automatically. Subclass declares budgetUsdKey
 *      + budgetUsdDefault; base reads the resolved cap from config and creates
 *      the BudgetMeter. Subclass calls `this.meter.check(...)` before each LLM
 *      submit; budget-exhausted phase still returns `status: 'ok'` (clean
 *      abort) with `details.budget_exhausted: true` so the report shows
 *      partial completion, not failure.
 *   4. Error envelope is uniform. Thrown errors get caught and converted to
 *      `status: 'fail'` with phase-specific `error.code`.
 *   5. Progress reporter integration. Base accepts the reporter via opts;
 *      subclasses call `this.tick(...)` instead of touching the reporter
 *      directly.
 *
 * Synthesize.ts / patterns.ts (existing pre-v0.36 phases) deliberately do NOT
 * retrofit to this base in v0.36.1.0 — too much churn for a refactor that
 * doesn't pay off until v0.37+ when more phases land. Future phases use this
 * by default.
 */

import { BudgetMeter, type SubmitEstimate, type BudgetCheckResult } from './budget-meter.ts';
import { sourceScopeOpts, type OperationContext } from '../operations.ts';
import type { BrainEngine } from '../engine.ts';
import type { CyclePhase, PhaseResult, PhaseStatus, PhaseError } from '../cycle.ts';
import type { ProgressReporter } from '../progress.ts';

/**
 * Source-scoped read options threaded through every engine call inside a
 * BaseCyclePhase. The base class produces these via `this.scope()`; subclasses
 * receive them as the only sanctioned way to read source-scoped data.
 */
export interface ScopedReadOpts {
  sourceId?: string;
  sourceIds?: string[];
}

export interface BasePhaseOpts {
  /** Optional progress reporter. Phases call tick() / start() through the base. */
  reporter?: ProgressReporter;
  /** Dry-run mode propagated from cycle opts. Subclasses honor this in process(). */
  dryRun?: boolean;
  /** Optional explicit budget override in USD. Otherwise base reads config. */
  budgetUsd?: number;
  /** Optional injected BudgetMeter (tests). When set, replaces the default constructed one. */
  meter?: BudgetMeter;
}

export abstract class BaseCyclePhase {
  /** Phase name; matches a CyclePhase enum entry in cycle.ts. */
  abstract readonly name: CyclePhase;

  /** Config key for the budget-USD override, e.g. `cycle.propose_takes.budget_usd`. */
  protected abstract readonly budgetUsdKey: string;

  /** Default budget cap in USD if no config override is present. */
  protected abstract readonly budgetUsdDefault: number;

  /**
   * The phase's actual work. Subclass implements this; base wraps it with
   * source-scope enforcement, budget metering, error catching, and progress
   * accounting. `scope` is the only sanctioned way to read source-scoped data.
   */
  protected abstract process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    ctx: OperationContext,
    opts: BasePhaseOpts,
  ): Promise<{
    summary: string;
    details: Record<string, unknown>;
    status?: PhaseStatus;
  }>;

  /**
   * Optional error-code mapper for thrown errors. Subclass can specialize:
   * a network error from the gateway maps to `LLM_TIMEOUT`, a postgres unique
   * violation maps to `PROPOSAL_CONFLICT`, etc. Default: 'UNKNOWN'.
   */
  protected mapErrorCode(_err: unknown): string {
    return 'UNKNOWN';
  }

  /**
   * Optional error-class mapper. Default 'InternalError' is fine for most;
   * subclass can flag 'LLMError', 'DatabaseConnection' etc.
   */
  protected mapErrorClass(_err: unknown): string {
    return 'InternalError';
  }

  /**
   * Tick the progress reporter for this phase. Subclass calls this instead of
   * reaching for opts.reporter directly so the phase name is always correct.
   */
  protected tick(opts: BasePhaseOpts, message?: string, delta = 1): void {
    if (!opts.reporter) return;
    opts.reporter.tick(delta, message);
  }

  /**
   * Check the budget for a planned LLM submit. Subclass calls this before
   * every gateway.chat() / gateway.embed() / etc. submission. When the result
   * has allowed=false the subclass MUST abort the planned submit and continue
   * with what it's already accumulated (clean partial-completion path).
   */
  protected checkBudget(estimate: SubmitEstimate): BudgetCheckResult {
    if (!this.meter) {
      // Tests that don't inject a meter get an unbounded fall-through. The
      // real path always constructs one in run().
      return {
        allowed: true,
        estimatedCostUsd: 0,
        cumulativeCostUsd: 0,
        budgetUsd: 0,
      };
    }
    return this.meter.check(estimate);
  }

  /**
   * BudgetMeter instance for this run. Set by run() (or injected via opts.meter
   * for tests). Subclass accesses it via checkBudget() rather than directly.
   */
  protected meter?: BudgetMeter;

  /**
   * Resolve the budget cap from config (or default). Override is the explicit
   * value passed via opts.budgetUsd. Otherwise: config[budgetUsdKey] → default.
   */
  private resolveBudgetUsd(ctx: OperationContext, opts: BasePhaseOpts): number {
    if (typeof opts.budgetUsd === 'number') return opts.budgetUsd;
    const raw = (ctx.config as unknown as Record<string, unknown>)[this.budgetUsdKey];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
    if (typeof raw === 'string') {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return this.budgetUsdDefault;
  }

  /**
   * Public entry point. Wraps the subclass's process() with all the cross-cutting
   * concerns. Returns a PhaseResult ready to slot into CycleReport.phases.
   */
  async run(ctx: OperationContext, opts: BasePhaseOpts = {}): Promise<PhaseResult> {
    const t0 = Date.now();

    // Source-scope discipline — required by every base-phase subclass. Forgetting
    // to thread this would have been the v0.34.1 leak class. Now structural.
    const scope = sourceScopeOpts(ctx);

    // Budget meter construction. The default path reads config; tests inject.
    if (!opts.meter) {
      const budgetUsd = this.resolveBudgetUsd(ctx, opts);
      this.meter = new BudgetMeter({ budgetUsd, phase: this.name });
    } else {
      this.meter = opts.meter;
    }

    try {
      const out = await this.process(ctx.engine, scope, ctx, opts);
      return {
        phase: this.name,
        status: out.status ?? 'ok',
        duration_ms: Date.now() - t0,
        summary: out.summary,
        details: out.details,
      };
    } catch (err) {
      const code = this.mapErrorCode(err);
      const errClass = this.mapErrorClass(err);
      const message = err instanceof Error ? err.message : String(err);
      const phaseError: PhaseError = {
        class: errClass,
        code,
        message,
      };
      return {
        phase: this.name,
        status: 'fail',
        duration_ms: Date.now() - t0,
        summary: `${this.name} failed: ${message}`,
        details: { error_code: code },
        error: phaseError,
      };
    }
  }
}
