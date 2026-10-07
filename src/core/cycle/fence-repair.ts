/**
 * `fence_repair` cycle phase (#6188): one bounded run of the `fences` repair
 * kind (src/core/repair/fences.ts) in the global maintenance lane, so fences
 * that sync held and malformed fences that pages store are repaired with no
 * operator. The phase has no rule logic of its own: the kind plans from its
 * census, skips sources this host does not own (`owner_unavailable`) or that
 * are mid-sync (`sync_in_progress`), reads `fences.repair.llm` and the daily
 * USD ledger itself, and re-plans on the next run, where items already
 * repaired drop out.
 *
 * The phase gates on `fences.repair.enabled`, runs the kind through the
 * shared trusted repair runner (an apply, or a preview on a dry run) with a
 * deadline of min(300 s, a third of the maintenance job's remaining time),
 * and reports the kind's verification: candidates, repairs per tier, what is
 * still held by reason, model spend, the oldest unresolved hold's age and the
 * USD per model repair. It never fails the cycle: a stop other than the time
 * budget, or an internal error, reports `warn` with the next step. Output is
 * counts and reason codes only, never a path, claim or cell value.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { Action } from '../agent-output.ts';
import { resolveRepairScope, type RepairResult } from '../repair/core.ts';
import { repairRunner, type RepairKindSpec } from '../repair/registry.ts';
import type { FenceRepairVerification } from '../repair/fences.ts';
import { FENCE_REASONS } from '../fence-repair/reasons.ts';
import type { FenceReason } from '../fence-repair/types.ts';
import { FENCE_REPAIR_ENABLED_KEY, FENCE_REPAIR_LLM_KEY, fenceRepairEnabled, fenceRepairLlmEnabled } from '../fence-repair/config.ts';
import { isUncontainedPhaseError } from './phase-containment.ts';

/** The longest one phase run spends repairing fences; inside a maintenance job it is also at most a third of the job's remaining time. */
export const FENCE_REPAIR_PHASE_BUDGET_MS = 300_000;

export interface FenceRepairPhaseOpts {
  dryRun: boolean;
  signal?: AbortSignal;
  /** The enclosing maintenance job's absolute deadline (epoch ms); null or unset for a direct `gbrain dream`. */
  deadlineAtMs?: number | null;
  /** Replaces the registered repair kinds, as `repairRunner` takes it (tests pass stub specs). */
  registry?: readonly RepairKindSpec[];
  now?: () => number;
}

const PREVIEW = 'gbrain repair fences';
const previewFix = (why: string): Action => ({ argv: ['gbrain', 'repair', 'fences'], consent: [], actor: 'agent', why, requires_exclusive: false,
  docs: 'docs/guides/repair.md#fences' });

export async function runFenceRepairPhase(engine: BrainEngine | null, opts: FenceRepairPhaseOpts): Promise<PhaseResult> {
  const base = { phase: 'fence_repair' as const, duration_ms: 0 };
  if (!engine) return { ...base, status: 'skipped', summary: 'no database connected', details: { reason: 'no_database' } };
  if (!(await fenceRepairEnabled(engine))) {
    return { ...base, status: 'skipped', details: { reason: 'disabled' },
      summary: `fence repair is paused (${FENCE_REPAIR_ENABLED_KEY} false), so nothing was repaired. Turn it back on with `
        + `\`gbrain config set ${FENCE_REPAIR_ENABLED_KEY} true\`, or preview and apply by hand with \`${PREVIEW}\`.` };
  }
  const now = opts.now ?? Date.now;
  const start = now();
  const timeBudgetMs = opts.deadlineAtMs == null ? FENCE_REPAIR_PHASE_BUDGET_MS
    : Math.min(FENCE_REPAIR_PHASE_BUDGET_MS, Math.floor((opts.deadlineAtMs - start) / 3));
  if (timeBudgetMs <= 0) {
    return { ...base, status: 'skipped', summary: 'no maintenance-job time left for fence repair; the next run continues', details: { reason: 'deadline' } };
  }
  const llmEnabled = await fenceRepairLlmEnabled(engine);
  let result: RepairResult;
  try {
    const runner = await repairRunner(engine, { apply: !opts.dryRun, logger: { info() {}, warn: console.warn, error: console.error },
      ...(opts.registry ? { registry: opts.registry } : {}) });
    result = await runner.run('fences', await resolveRepairScope(engine), { deadline: start + timeBudgetMs });
  } catch (error) {
    if (isUncontainedPhaseError(error, opts.signal)) throw error;
    const rawCode = (error as { code?: unknown } | null)?.code;
    const code = typeof rawCode === 'string' ? rawCode : 'internal';
    return { ...base, status: 'warn', details: { reason: 'error', code, time_budget_ms: timeBudgetMs,
      fix: previewFix('The fence repair stopped on an error; the preview shows the plan and the error on the brain host.') },
      summary: `fence repair stopped on an error (${code}) and the next maintenance run retries. Run \`${PREVIEW}\` on the brain host `
        + 'to see the plan and the error; ask the user if it keeps failing.' };
  }

  const v = result.verification as Partial<FenceRepairVerification> | undefined;
  const repairedByTier = v?.repaired_by_tier ?? { deterministic: 0, resolver: 0, llm: 0 };
  const heldByReason: Record<string, number> = v?.held_by_reason ?? result.remaining ?? {};
  const candidates = v?.candidates ?? result.affected;
  const repaired = result.repaired ?? result.applied;
  const oldestHoldAt = v?.oldest_hold_at ?? null;
  const oldestHoldAgeHours = oldestHoldAt ? Math.max(0, Math.round((now() - Date.parse(oldestHoldAt)) / 3_600_000)) : null;
  const llmUsd = result.cost.llm_usd ?? null;
  const llmUsdPerRepair = v?.llm_usd_per_repair ?? null;
  const scanPartial = v?.partial ?? result.scan?.partial ?? false;
  const stopped = result.stopped;
  const held = Object.values(heldByReason).reduce((sum, n) => sum + n, 0);
  const manual = Object.entries(heldByReason).filter(([reason]) => FENCE_REASONS[reason as FenceReason]?.manualOnly).reduce((sum, [, n]) => sum + n, 0);
  const llmDisabled = heldByReason.llm_disabled ?? 0;

  const usd = (n: number | null) => n === null ? 'unpriced' : `$${n.toFixed(4)}`;
  const parts = [
    result.mode === 'dry_run' ? `dry run: ${candidates} fence candidate(s) planned, nothing written`
      : candidates === 0 && held === 0 ? 'no malformed fences to repair'
        : `repaired ${repaired} of ${candidates} fence candidate(s) (deterministic ${repairedByTier.deterministic}, resolver ${repairedByTier.resolver}, `
          + `model ${repairedByTier.llm}; ${usd(llmUsd)} on the model${llmUsdPerRepair !== null ? `, ${usd(llmUsdPerRepair)} per model repair` : ''})`,
    held ? `${held} still held (${Object.entries(heldByReason).filter(([, n]) => n).map(([reason, n]) => `${reason} ${n}`).join(', ')})` : '',
    oldestHoldAgeHours !== null ? `the oldest unresolved hold is ${oldestHoldAgeHours} h old` : '',
  ].filter(Boolean).join('; ');
  const notes = [
    stopped?.reason === 'time_budget' ? `Stopped at the phase time budget (${Math.round(timeBudgetMs / 1000)} s); the next maintenance run resumes.` : '',
    stopped && stopped.reason !== 'time_budget' ? `Stopped (${stopped.reason}): ${stopped.message}` : '',
    scanPartial ? 'The fence census scan is still partial; the next run continues it.' : '',
    llmEnabled ? '' : `Model (Tier 3) repair is off (${FENCE_REPAIR_LLM_KEY} false)${llmDisabled ? `: ${llmDisabled} fence(s) wait for it; ask the user before `
      + `turning it on (\`gbrain config set ${FENCE_REPAIR_LLM_KEY} true\`, paid) or edit them by hand` : ''}.`,
    manual ? `${manual} need a manual edit: run \`${PREVIEW}\` on the brain host for each exact fix.` : '',
  ].filter(Boolean);
  const fix = stopped && stopped.reason !== 'time_budget' ? stopped.fix : manual ? previewFix('Some fences need a manual edit; the preview names each exact fix.') : undefined;
  return {
    ...base,
    status: stopped && stopped.reason !== 'time_budget' ? 'warn' : 'ok',
    summary: [`${parts}.`, ...notes].join(' '),
    details: {
      mode: result.mode, candidates, repaired, repaired_by_tier: repairedByTier, held_by_reason: heldByReason,
      llm_enabled: llmEnabled, llm_usd: llmUsd, llm_cap_remaining_usd: result.cost.llm_cap_remaining_usd ?? null,
      llm_repairs: v?.llm_repairs ?? 0, llm_usd_per_repair: llmUsdPerRepair, oldest_hold_at: oldestHoldAt, oldest_hold_age_hours: oldestHoldAgeHours,
      scan_partial: scanPartial, complete: result.complete, time_budget_ms: timeBudgetMs, stopped_reason: stopped?.reason ?? null,
      ...(stopped ? { stopped } : {}), ...(fix ? { fix } : {}),
    },
  };
}
