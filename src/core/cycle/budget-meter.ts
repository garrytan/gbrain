/**
 * v0.28: cumulative cost meter for dream-cycle phases (auto-think + drift).
 *
 * Per Codex P1 #10: each subagent submit estimates max-cost from
 * `model + max_output_tokens`, accumulates per-cycle, refuses next submit
 * if cumulative > budget. Non-Anthropic models bypass the gate with a
 * `BUDGET_METER_NO_PRICING` warn (once per process).
 *
 * Ledger lives at `~/.gbrain/audit/dream-budget-YYYY-Www.jsonl` (ISO-week
 * rotation, same pattern as shell-audit). Each line is one submit's cost
 * estimate + actual usage when reported back.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from '../config.ts';
import { estimateMaxCostUsd, ANTHROPIC_PRICING } from '../anthropic-pricing.ts';

export interface BudgetMeterOpts {
  /** USD cap for the whole cycle. 0 or negative disables the gate. */
  budgetUsd: number;
  /** Phase label for telemetry: 'auto_think' | 'drift'. */
  phase: string;
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
  /** True when the model wasn't in the pricing map (cycle runs unbounded for that submit). */
  unpriced?: boolean;
}

/** One-process memo: warn-once on missing pricing per model. */
const _unpricedWarnings = new Set<string>();

function auditFilePath(override?: string): string {
  if (override) return override;
  // ISO week format: YYYY-Www (2026-W18)
  const now = new Date();
  const year = now.getUTCFullYear();
  // ISO week: Thursday's week. Approximated for filename only.
  const oneJan = new Date(Date.UTC(year, 0, 1));
  const diffDays = Math.floor((now.getTime() - oneJan.getTime()) / 86_400_000);
  const week = Math.ceil((diffDays + oneJan.getUTCDay() + 1) / 7);
  const weekStr = String(week).padStart(2, '0');
  return gbrainPath(`audit/dream-budget-${year}-W${weekStr}.jsonl`);
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
   * Check whether a planned submit fits within the remaining budget.
   * Records the attempt to the ledger regardless of allow/deny.
   * Caller is responsible for skipping the actual LLM call when allowed=false.
   */
  check(estimate: SubmitEstimate): BudgetCheckResult {
    const cost = estimateMaxCostUsd(estimate.modelId, estimate.estimatedInputTokens, estimate.maxOutputTokens);

    // Codex P1 #10: non-Anthropic / unpriced models bypass the gate.
    if (cost === null) {
      this.unpricedSubmitsThisCycle++;
      if (!_unpricedWarnings.has(estimate.modelId)) {
        _unpricedWarnings.add(estimate.modelId);
        process.stderr.write(
          `[budget] BUDGET_METER_NO_PRICING: model "${estimate.modelId}" not in ANTHROPIC_PRICING. ` +
          `Budget gate disabled for this submit. (Per-provider pricing modules: TODO v0.29.)\n`,
        );
      }
      writeLedgerLine(this.auditPath, {
        phase: this.opts.phase,
        ts: new Date().toISOString(),
        event: 'submit_unpriced',
        model: estimate.modelId,
        label: estimate.label,
        estimated_input_tokens: estimate.estimatedInputTokens,
        max_output_tokens: estimate.maxOutputTokens,
      });
      return {
        allowed: true,
        estimatedCostUsd: 0,
        cumulativeCostUsd: this.cumulativeUsd,
        budgetUsd: this.opts.budgetUsd,
        unpriced: true,
      };
    }

    // Budget disabled (<= 0)
    if (this.opts.budgetUsd <= 0) {
      this.cumulativeUsd += cost;
      writeLedgerLine(this.auditPath, {
        phase: this.opts.phase,
        ts: new Date().toISOString(),
        event: 'submit',
        model: estimate.modelId,
        label: estimate.label,
        estimated_cost_usd: cost,
        cumulative_cost_usd: this.cumulativeUsd,
        budget_usd: this.opts.budgetUsd,
      });
      return { allowed: true, estimatedCostUsd: cost, cumulativeCostUsd: this.cumulativeUsd, budgetUsd: this.opts.budgetUsd };
    }

    const projected = this.cumulativeUsd + cost;
    if (projected > this.opts.budgetUsd) {
      writeLedgerLine(this.auditPath, {
        phase: this.opts.phase,
        ts: new Date().toISOString(),
        event: 'submit_denied',
        model: estimate.modelId,
        label: estimate.label,
        estimated_cost_usd: cost,
        cumulative_cost_usd: this.cumulativeUsd,
        budget_usd: this.opts.budgetUsd,
      });
      return {
        allowed: false,
        estimatedCostUsd: cost,
        cumulativeCostUsd: this.cumulativeUsd,
        budgetUsd: this.opts.budgetUsd,
        reason: `BUDGET_EXHAUSTED: projected $${projected.toFixed(4)} > cap $${this.opts.budgetUsd.toFixed(2)}`,
      };
    }

    this.cumulativeUsd += cost;
    writeLedgerLine(this.auditPath, {
      phase: this.opts.phase,
      ts: new Date().toISOString(),
      event: 'submit',
      model: estimate.modelId,
      label: estimate.label,
      estimated_cost_usd: cost,
      cumulative_cost_usd: this.cumulativeUsd,
      budget_usd: this.opts.budgetUsd,
    });
    return { allowed: true, estimatedCostUsd: cost, cumulativeCostUsd: this.cumulativeUsd, budgetUsd: this.opts.budgetUsd };
  }

  /** Cumulative cost spent so far this cycle. */
  get totalSpent(): number { return this.cumulativeUsd; }

  /** Count of submits that bypassed the gate due to missing pricing. */
  get unpricedSubmits(): number { return this.unpricedSubmitsThisCycle; }
}

/** Test helper: reset the once-per-process warning memo. */
export function _resetBudgetMeterWarningsForTest(): void {
  _unpricedWarnings.clear();
}

/** Re-export the pricing map for callers that need to introspect it. */
export { ANTHROPIC_PRICING };
