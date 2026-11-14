/**
 * unattended_maintenance doctor check (GBRA-438): reads `maintenance.last_run`
 * (or autopilot's freshness when an autopilot owns upkeep) through the same
 * view as `gbrain maintain --status`. Off and autopilot-owned read as ok; a
 * brain younger than 48 hours with no run is information; a run older than
 * 48 hours, a step failing three runs in a row, or an item the serve parked, warns with the command
 * that runs free upkeep now.
 */
import type { Check } from '../../doctor.ts';
import { cliRenderContext, renderAction } from '../../../core/agent-output.ts';
import { checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readUpkeepStatus, type UpkeepStatus } from '../../../core/maintenance/status.ts';

const name = 'unattended_maintenance';

function details(s: UpkeepStatus): Record<string, unknown> {
  return {
    state: s.state, runner: s.runner, last_run: s.last_run, steps: s.steps.length, next_due_at: s.next_due_at,
    pending_purge_count: s.pending_purge_count, paid_phases_opt_in: s.paid_phases_opt_in,
    embed_spend_today_usd: s.embed_spend_today_usd, embed_daily_cap_usd: s.embed_daily_cap_usd,
    ...(s.failing ? { failing: s.failing } : {}),
    ...(s.parked.length ? { parked: s.parked } : {}),
    ...(s.alternative_fix ? { alternative_fix: renderAction(s.alternative_fix, cliRenderContext()) } : {}),
  };
}

export async function checkUnattendedMaintenance(engine: Parameters<typeof readUpkeepStatus>[0], opts: { nowMs?: number } = {}): Promise<Check> {
  try {
    const s = await readUpkeepStatus(engine, opts.nowMs);
    if (s.state === 'never') return infoCheck(name, s.message, 'not_applicable', undefined, details(s));
    if (s.state === 'overdue' || s.state === 'failing' || s.state === 'parked') return { name, status: 'warn', message: s.message, details: details(s), ...(s.fix ? { fix: s.fix } : {}) };
    return { name, status: 'ok', message: s.message, details: details(s) };
  } catch (error) {
    return checkError(name, 'read the unattended upkeep record', error);
  }
}

async function runUnattendedMaintenance(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkUnattendedMaintenance(connectedEngine(ctx)));
  return checks;
}

export const unattendedMaintenanceEntry: DoctorEntry = {
  name: 'unattended_maintenance',
  emits: ['unattended_maintenance'],
  run: runUnattendedMaintenance,
};
