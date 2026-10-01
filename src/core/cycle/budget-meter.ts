/**
 * v0.28: cumulative cost meter for dream-cycle phases (auto-think + drift).
 *
 * v0.37.x: kept as a thin adapter over `BudgetTracker` semantics. The public
 * class shape (`BudgetMeter`, `SubmitEstimate`, `BudgetCheckResult`) is
 * preserved so every existing dream-cycle call site keeps working. The
 * audit JSONL grew a `schema_version: 1` field on every line (A2 amended:
 * schema-stable, not byte-stable — reorderings are tolerated, field
 * renames are breaking). `test/fixtures/dream-budget-schema-v1.jsonl`
 * pins the documented field set.
 *
 * Per Codex P1 #10: each subagent submit estimates max-cost from
 * `model + max_output_tokens`, accumulates per-cycle, refuses next submit
 * if cumulative > budget. Pricing resolves through the canonical chat table
 * (`canonicalLookup`), so any provider carried there is gated. A model absent
 * from canonical (a router or proxy alias) is metered at a conservative
 * Sonnet-tier fallback rate with a `BUDGET_METER_NO_PRICING` warn (once per
 * process); `dream.budget.allow_unpriced=true` restores the old bypass.
 * Local model servers (Ollama, LM Studio, llama-server) cost $0.
 *
 * Budget values: 0 spends nothing, `Infinity` (config `unlimited`) is no cap.
 *
 * Ledger lives at `~/.gbrain/audit/dream-budget-YYYY-Www.jsonl` (ISO-week
 * rotation, same pattern as shell-audit; filename math now goes through
 * `src/core/audit-week-file.ts` per T4). Each line is one submit's cost
 * estimate + actual usage when reported back.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isoWeekFilename, resolveAuditDir } from '../audit-week-file.ts';
import { estimateMaxCostUsd, ANTHROPIC_PRICING } from '../anthropic-pricing.ts';
import { canonicalLookup, type ModelPricing } from '../model-pricing.ts';
import type { BrainEngine } from '../engine.ts';
import { splitProviderModelId } from '../model-id.ts';
import { overrideFor, type PricingOverrides } from '../budget/reservation-cost.ts';
// Re-exported beside loadAllowUnpriced so meter call sites read both knobs from one module.
export { loadPricingOverrides } from '../budget/budget-tracker.ts';

/** Local model servers bill nothing; their models are priced at $0, never at the fallback. */
const LOCAL_MODEL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llama-server']);

/** Rate for models absent from the canonical table: Sonnet tier, derived from canonical. */
const FALLBACK_PRICING: ModelPricing = canonicalLookup('anthropic:claude-sonnet-4-6') ?? { input: 3.0, output: 15.0 };

/**
 * Parse a dream budget config value. `0` (or a negative value) spends
 * nothing, `unlimited` is no cap (Infinity); an empty or non-numeric value
 * uses `fallback`.
 */
export function parseBudgetUsd(raw: string | number | null | undefined, fallback: number): number {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'unlimited') return Infinity;
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/** `dream.budget.allow_unpriced=true` lets unpriced models bypass the gate. */
export async function loadAllowUnpriced(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  // An unreadable config keeps the default: unpriced models are metered.
  const raw = await Promise.resolve(engine.getConfig?.('dream.budget.allow_unpriced')).catch(() => null);
  return typeof raw === 'string' && ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export interface BudgetMeterOpts {
  /** USD cap for the whole cycle. 0 (or negative) spends nothing; Infinity is no cap. */
  budgetUsd: number;
  /** Let models absent from the pricing table bypass the gate (default: meter them at the fallback rate). */
  allowUnpriced?: boolean;
  /** Phase label for telemetry: 'auto_think' | 'drift'. */
  phase: string;
  /**
   * #4312 operator price overrides (`pricing.overrides`, parsed by
   * parsePricingOverrides). Consulted before the shipped tables, the same
   * lookup BudgetTracker uses, so a rate the operator declared (a proxy
   * route, or $0 for a flat-rate subscription lane) prices dream-cycle gates
   * the same way it prices every other cost cap.
   */
  pricingOverrides?: PricingOverrides;
  /** Optional override for the audit file path (tests). */
  auditPath?: string;
}

export interface SubmitEstimate {
  /** Resolved Anthropic model id (e.g. 'claude-opus-4-7'). */
  modelId: string;
  /** Best-guess input token count. Caller computes from prompt size. */
  estimatedInputTokens: number;
  /** Max output tokens passed to the LLM call. Upper-bounds the output cost. */
  maxOutputTokens: number;
  /** Logical label for the submit (synthesize / verdict / drift / ...). */
  label?: string;
}

export interface BudgetCheckResult {
  allowed: boolean;
  estimatedCostUsd: number;
  cumulativeCostUsd: number;
  budgetUsd: number;
  reason?: string;
  /** True when the model wasn't in the pricing map (metered at the fallback rate, or bypassed when allowed). */
  unpriced?: boolean;
}

/** One-process memo: warn-once on missing pricing per model. */
const _unpricedWarnings = new Set<string>();

function auditFilePath(override?: string): string {
  if (override) return override;
  return join(resolveAuditDir(), isoWeekFilename('dream-budget'));
}

function writeLedgerLine(path: string, entry: object): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort. Audit failure must not gate the cycle.
  }
}

export class BudgetMeter {
  private cumulativeUsd = 0;
  private readonly auditPath: string;
  private unpricedSubmitsThisCycle = 0;

  constructor(private readonly opts: BudgetMeterOpts) {
    this.auditPath = auditFilePath(opts.auditPath);
  }

  /**
   * Max-cost estimate for a planned submit.
   *
   * Prices through `canonicalLookup` first. `estimateMaxCostUsd` reads
   * ANTHROPIC_PRICING, which CLAUDE.md defines as a DERIVED view of the one
   * canonical chat-pricing table — so reaching for it directly made every
   * non-Anthropic model unpriceable here even when the canonical table has
   * its rates, and an unpriceable model disables the gate entirely (see
   * `check`). Anthropic ids resolve identically either way, since the derived
   * view is generated from canonical.
   *
   * Returns null only for models absent from the canonical table too; the
   * caller keeps the existing warn-and-allow behaviour for those.
   */
  private estimateCost(estimate: SubmitEstimate): number | null {
    // #4312: an operator override wins over every table, as in BudgetTracker.
    const override = overrideFor(estimate.modelId, this.opts.pricingOverrides);
    if (override) {
      const cost = (estimate.estimatedInputTokens / 1_000_000) * override.input +
        (estimate.maxOutputTokens / 1_000_000) * override.output;
      return Number.isFinite(cost) ? cost : null;
    }
    if (LOCAL_MODEL_PROVIDERS.has(splitProviderModelId(estimate.modelId).provider ?? '')) return 0;
    const p = canonicalLookup(estimate.modelId);
    const raw = p
      ? (estimate.estimatedInputTokens / 1_000_000) * p.input +
        (estimate.maxOutputTokens      / 1_000_000) * p.output
      : estimateMaxCostUsd(
          estimate.modelId,
          estimate.estimatedInputTokens,
          estimate.maxOutputTokens,
        );
    // A non-finite estimate must not reach the accumulator. Both tables are
    // plain object literals, so a model id colliding with an inherited key
    // ('constructor', 'toString', '__proto__') resolves to a truthy
    // Object.prototype value whose .input/.output are undefined, and the
    // arithmetic yields NaN. `cumulative + NaN` is NaN, `NaN > budget` is
    // false, so a single such submit would silently disable the gate for the
    // rest of the cycle. Treated as unpriceable instead, which routes into
    // the documented warn-and-allow branch for that one submit and leaves
    // the running total intact. (The same shape exists on the
    // estimateMaxCostUsd path today; not changed here.)
    return raw !== null && Number.isFinite(raw) ? raw : null;
  }

  /**
   * Check whether a planned submit fits within the remaining budget.
   * Records the attempt to the ledger regardless of allow/deny.
   * Caller is responsible for skipping the actual LLM call when allowed=false.
   */
  check(estimate: SubmitEstimate): BudgetCheckResult {
    const priced = this.estimateCost(estimate);
    const budgetUsd = Math.max(0, this.opts.budgetUsd);

    if (priced === null) {
      this.unpricedSubmitsThisCycle++;
      if (!_unpricedWarnings.has(estimate.modelId)) {
        _unpricedWarnings.add(estimate.modelId);
        process.stderr.write(
          `[budget] BUDGET_METER_NO_PRICING: model "${estimate.modelId}" has no canonical pricing. ` +
          (this.opts.allowUnpriced
            ? `Budget gate disabled for this model (dream.budget.allow_unpriced=true).\n`
            : `Metering it at the Sonnet-tier fallback rate; set dream.budget.allow_unpriced=true to bypass.\n`),
        );
      }
    }
    // An unpriced model bypasses the gate only when the operator opted in.
    if (priced === null && this.opts.allowUnpriced) {
      writeLedgerLine(this.auditPath, {
        schema_version: 1,
        phase: this.opts.phase,
        ts: new Date().toISOString(),
        event: 'submit_unpriced',
        model: estimate.modelId,
        label: estimate.label,
        allowed: true,
        estimated_input_tokens: estimate.estimatedInputTokens,
        max_output_tokens: estimate.maxOutputTokens,
      });
      return {
        allowed: true,
        estimatedCostUsd: 0,
        cumulativeCostUsd: this.cumulativeUsd,
        budgetUsd,
        unpriced: true,
      };
    }
    const cost = priced ?? (
      (estimate.estimatedInputTokens / 1_000_000) * FALLBACK_PRICING.input +
      (estimate.maxOutputTokens / 1_000_000) * FALLBACK_PRICING.output
    );

    if (priced === null) {
      const allowed = this.cumulativeUsd + cost <= budgetUsd;
      if (allowed) this.cumulativeUsd += cost;
      writeLedgerLine(this.auditPath, {
        schema_version: 1,
        phase: this.opts.phase,
        ts: new Date().toISOString(),
        event: 'submit_unpriced',
        model: estimate.modelId,
        label: estimate.label,
        allowed,
        estimated_input_tokens: estimate.estimatedInputTokens,
        max_output_tokens: estimate.maxOutputTokens,
        estimated_cost_usd: cost,
        cumulative_cost_usd: this.cumulativeUsd,
        budget_usd: budgetUsd,
      });
      return {
        allowed,
        estimatedCostUsd: cost,
        cumulativeCostUsd: this.cumulativeUsd,
        budgetUsd,
        unpriced: true,
        ...(allowed ? {} : { reason: `BUDGET_EXHAUSTED: projected $${(this.cumulativeUsd + cost).toFixed(4)} > cap $${budgetUsd.toFixed(2)} (unpriced model at fallback rate)` }),
      };
    }

    const projected = this.cumulativeUsd + cost;
    if (projected > budgetUsd) {
      writeLedgerLine(this.auditPath, {
        schema_version: 1,
        phase: this.opts.phase,
        ts: new Date().toISOString(),
        event: 'submit_denied',
        model: estimate.modelId,
        label: estimate.label,
        estimated_cost_usd: cost,
        cumulative_cost_usd: this.cumulativeUsd,
        budget_usd: budgetUsd,
      });
      return {
        allowed: false,
        estimatedCostUsd: cost,
        cumulativeCostUsd: this.cumulativeUsd,
        budgetUsd,
        reason: `BUDGET_EXHAUSTED: projected $${projected.toFixed(4)} > cap $${budgetUsd.toFixed(2)}`,
      };
    }

    this.cumulativeUsd += cost;
    writeLedgerLine(this.auditPath, {
      schema_version: 1,
      phase: this.opts.phase,
      ts: new Date().toISOString(),
      event: 'submit',
      model: estimate.modelId,
      label: estimate.label,
      estimated_cost_usd: cost,
      cumulative_cost_usd: this.cumulativeUsd,
      budget_usd: budgetUsd,
    });
    return { allowed: true, estimatedCostUsd: cost, cumulativeCostUsd: this.cumulativeUsd, budgetUsd };
  }

  /** Cumulative cost spent so far this cycle. */
  get totalSpent(): number { return this.cumulativeUsd; }

  /** Count of submits whose model had no canonical pricing. */
  get unpricedSubmits(): number { return this.unpricedSubmitsThisCycle; }
}

/** Test helper: reset the once-per-process warning memo. */
export function _resetBudgetMeterWarningsForTest(): void {
  _unpricedWarnings.clear();
}

/** Re-export the pricing map for callers that need to introspect it. */
export { ANTHROPIC_PRICING };
