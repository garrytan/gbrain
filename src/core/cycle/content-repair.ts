/**
 * `content_repair` cycle phase (#6377): one bounded pass of the content-repair
 * lane (src/core/repair/content-lane.ts) in the global maintenance lane,
 * right after `fence_repair`, so the content holds managed sync records
 * (`frontmatter_slug_conflict` today's candidate; `invalid_fence` is
 * `fence_repair`'s) clear within one maintenance cycle with no operator. The
 * phase runs every kind in `CONTENT_REPAIR_KINDS` except `fences`, which
 * `fence_repair` just ran, through the same shared trusted repair runner, so
 * each kind keeps its own census, owner checks, caps, ledger and gates, and a
 * new lane kind is picked up here with no change. With `CONTENT_REPAIR_KINDS`
 * holding only `fences` the phase runs nothing and says so (`no_kinds`).
 *
 * Gated on `fences.repair.enabled` (one switch for the whole lane, D3), with a
 * deadline of min(120 s, a third of the maintenance job's remaining time); an
 * apply on a real run, a preview on a dry run. The report is counts by kind,
 * outcome and reason, the lane's model spend and the oldest unresolved hold's
 * age. It never fails the cycle: a stop other than the time budget, or an
 * internal error, reports `warn` with the next step. Output is counts and
 * codes only, never a path, claim or cell value.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { Action } from '../agent-output.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../repair/core.ts';
import type { RepairKindSpec } from '../repair/registry.ts';
import { CONTENT_REPAIR_KINDS, contentLaneArgv, runContentLane, type ContentLaneResult } from '../repair/content-lane.ts';
import { FENCE_REPAIR_ENABLED_KEY, fenceRepairEnabled } from '../fence-repair/config.ts';
import { isUncontainedPhaseError } from './phase-containment.ts';

/** The longest one phase run spends on the lane; inside a maintenance job it is also at most a third of the job's remaining time. */
export const CONTENT_REPAIR_PHASE_BUDGET_MS = 120_000;

export interface ContentRepairPhaseOpts {
  dryRun: boolean;
  signal?: AbortSignal;
  /** The enclosing maintenance job's absolute deadline (epoch ms); null or unset for a direct `gbrain dream`. */
  deadlineAtMs?: number | null;
  /** The lane kinds to run (default: `CONTENT_REPAIR_KINDS` without `fences`); tests name a stub kind here. */
  kinds?: readonly RepairKind[];
  /** Replaces the registered repair kinds, as `repairRunner` takes it (tests pass stub specs). */
  registry?: readonly RepairKindSpec[];
  now?: () => number;
}

/** The kinds the phase runs by default: the lane minus the kind `fence_repair` already ran. */
export function contentRepairPhaseKinds(): RepairKind[] {
  return CONTENT_REPAIR_KINDS.filter(kind => kind !== 'fences');
}

const previewFix = (why: string): Action => ({ argv: contentLaneArgv({}), consent: [], actor: 'agent', why, requires_exclusive: false, docs: 'docs/guides/repair.md#held-files' });

/** Counts by reason over a kind's per-item outcomes (its `remaining` when the kind reports one). */
function heldByReason(result: RepairResult): Record<string, number> {
  if (result.remaining) return result.remaining;
  const counts: Record<string, number> = {};
  for (const item of result.outcome_items ?? []) if (item.outcome !== 'repaired' && item.reason) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return counts;
}

export async function runContentRepairPhase(engine: BrainEngine | null, opts: ContentRepairPhaseOpts): Promise<PhaseResult> {
  const base = { phase: 'content_repair' as const, duration_ms: 0 };
  if (!engine) return { ...base, status: 'skipped', summary: 'no database connected', details: { reason: 'no_database' } };
  const kinds = [...(opts.kinds ?? contentRepairPhaseKinds())];
  const preview = contentLaneArgv({}).join(' ');
  if (!kinds.length) {
    return { ...base, status: 'skipped', details: { reason: 'no_kinds', kinds },
      summary: 'no content-repair kind beyond fence_repair is registered in this release, so the phase ran nothing; fence holds were handled by fence_repair.' };
  }
  if (!(await fenceRepairEnabled(engine))) {
    return { ...base, status: 'skipped', details: { reason: 'disabled', kinds },
      summary: `content repair is paused (${FENCE_REPAIR_ENABLED_KEY} false), so nothing was repaired. Turn it back on with `
        + `\`gbrain config set ${FENCE_REPAIR_ENABLED_KEY} true\`, or preview and apply by hand with \`${preview}\`.` };
  }
  const now = opts.now ?? Date.now;
  const start = now();
  const timeBudgetMs = opts.deadlineAtMs == null ? CONTENT_REPAIR_PHASE_BUDGET_MS
    : Math.min(CONTENT_REPAIR_PHASE_BUDGET_MS, Math.floor((opts.deadlineAtMs - start) / 3));
  if (timeBudgetMs <= 0) {
    return { ...base, status: 'skipped', summary: 'no maintenance-job time left for content repair; the next run continues', details: { reason: 'deadline', kinds } };
  }
  let lane: ContentLaneResult;
  try {
    lane = await runContentLane(engine, await resolveRepairScope(engine), { apply: !opts.dryRun, kinds, deadline: start + timeBudgetMs,
      logger: { info() {}, warn: console.warn, error: console.error }, ...(opts.registry ? { registry: opts.registry } : {}) });
  } catch (error) {
    if (isUncontainedPhaseError(error, opts.signal)) throw error;
    const rawCode = (error as { code?: unknown } | null)?.code;
    const code = typeof rawCode === 'string' ? rawCode : 'internal';
    return { ...base, status: 'warn', details: { reason: 'error', code, kinds, time_budget_ms: timeBudgetMs,
      fix: previewFix('The content repair stopped on an error; the preview shows each kind\'s plan and the error on the brain host.') },
      summary: `content repair stopped on an error (${code}) and the next maintenance run retries. Run \`${preview}\` on the brain host `
        + 'to see the plan and the error; ask the user if it keeps failing.' };
  }

  const byKind = Object.fromEntries(lane.results.map(result => {
    const held = heldByReason(result);
    const v = result.verification as { oldest_hold_at?: string | null } | undefined;
    return [result.kind, { mode: result.mode, candidates: result.affected, repaired: result.repaired ?? result.applied, outcomes: result.outcomes ?? {}, held_by_reason: held,
      llm_usd: result.cost.llm_usd ?? null, complete: result.complete, stopped_reason: result.stopped?.reason ?? null, oldest_hold_at: v?.oldest_hold_at ?? null }];
  })) as Record<string, { mode: string; candidates: number; repaired: number; outcomes: Record<string, number>; held_by_reason: Record<string, number>; llm_usd: number | null; complete: boolean;
    stopped_reason: string | null; oldest_hold_at: string | null }>;
  const kindsRun = Object.values(byKind);
  const candidates = kindsRun.reduce((sum, k) => sum + k.candidates, 0);
  const repaired = kindsRun.reduce((sum, k) => sum + k.repaired, 0);
  const heldTotals: Record<string, number> = {};
  for (const k of kindsRun) for (const [reason, n] of Object.entries(k.held_by_reason)) heldTotals[reason] = (heldTotals[reason] ?? 0) + n;
  const held = Object.values(heldTotals).reduce((sum, n) => sum + n, 0);
  const needsHuman = (heldTotals.needs_human ?? 0) + (heldTotals.merge_recommended ?? 0) + (heldTotals.content_repair_needs_human ?? 0);
  const oldest = kindsRun.map(k => k.oldest_hold_at).filter((at): at is string => !!at).sort()[0] ?? null;
  const oldestHoldAgeHours = oldest ? Math.max(0, Math.round((now() - Date.parse(oldest)) / 3_600_000)) : null;
  const hardStop = lane.stopped.find(stop => stop.reason !== 'time_budget');
  const timeStop = lane.stopped.find(stop => stop.reason === 'time_budget');
  const usd = `$${lane.cost.llm_usd.toFixed(4)}`;
  const parts = [
    lane.mode === 'dry_run' ? `dry run: ${candidates} content candidate(s) planned across ${lane.kinds.join(', ')}, nothing written`
      : candidates === 0 && held === 0 ? `no content holds to repair (${lane.kinds.join(', ')})`
        : `repaired ${repaired} of ${candidates} content candidate(s) across ${lane.kinds.join(', ')} (${usd} on the model)`,
    held ? `${held} still held (${Object.entries(heldTotals).filter(([, n]) => n).map(([reason, n]) => `${reason} ${n}`).join(', ')})` : '',
    oldestHoldAgeHours !== null ? `the oldest unresolved hold is ${oldestHoldAgeHours} h old` : '',
  ].filter(Boolean).join('; ');
  const notes = [
    timeStop ? `Stopped at the phase time budget (${Math.round(timeBudgetMs / 1000)} s) in ${timeStop.kind}; the next maintenance run resumes.` : '',
    hardStop ? `Stopped (${hardStop.kind}: ${hardStop.reason}): ${hardStop.message}` : '',
    needsHuman ? `${needsHuman} wait for a person: gbrain sync status --source <id> --json names each with its paragraph.` : '',
  ].filter(Boolean);
  const fix = hardStop ? hardStop.fix ?? previewFix('A lane kind stopped; the preview shows each kind\'s plan on the brain host.')
    : needsHuman ? previewFix('Some holds wait for a person; the preview names each with its exact next step.') : undefined;
  return {
    ...base,
    status: hardStop ? 'warn' : 'ok',
    summary: [`${parts}.`, ...notes].join(' '),
    details: {
      mode: lane.mode, kinds: lane.kinds, candidates, repaired, held_by_reason: heldTotals, by_kind: byKind,
      llm_usd: lane.cost.llm_usd, oldest_hold_at: oldest, oldest_hold_age_hours: oldestHoldAgeHours,
      complete: lane.results.every(result => result.complete), time_budget_ms: timeBudgetMs, stopped_reason: hardStop?.reason ?? timeStop?.reason ?? null,
      ...(lane.stopped.length ? { stopped: lane.stopped } : {}), ...(fix ? { fix } : {}),
    },
  };
}
