/**
 * global_maintenance_stalled doctor check (GBRA-130 C-6, #6837): brain-wide
 * maintenance has not completed a pass (`autopilot.last_global_at`) for more
 * than three global intervals while its jobs failed or a phase kept blocking
 * the stamp (warn), for a week or more (fail), or passes stamp past a phase
 * that keeps failing (warn). Names the phase, its blocker key and the command
 * that runs it in the foreground; without a phase streak, the failed job to
 * inspect. The verdict comes from core/minions/global-maintenance-stall.ts,
 * which also drives the `gbrain autopilot --status` exit code.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { assessGlobalMaintenanceStall } from '../../../core/minions/global-maintenance-stall.ts';
import { phaseRetryCommand } from '../../../core/minions/handlers/autopilot-global-maintenance.ts';

const DOCS = 'docs/guides/troubleshooting.md#global-maintenance-stalled';

async function runGlobalMaintenanceStalled(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const verdict = await assessGlobalMaintenanceStall(connectedEngine(ctx));
    const phase = verdict.fix?.[0] === 'gbrain' && verdict.fix[1] === 'dream' ? verdict.fix[3]! : null;
    const fix = verdict.status === 'ok' || !verdict.fix ? undefined : phase
      ? agentFix(verdict.fix, `Runs phase ${phase} in the foreground so its error is visible; LLM and embedding phases spend tokens, so ask the user first.`, 'global_maintenance_stalled',
        { consent: ['paid'], docs: DOCS, then: agentFix(phaseRetryCommand(phase).split(' '), 'Ends the phase back-off so the next autopilot pass runs it again.', 'global_maintenance_stalled') })
      : agentFix(verdict.fix, 'Shows the failed maintenance job and its error; it changes nothing.', 'global_maintenance_stalled', { docs: DOCS });
    const { status, message, fix: _argv, checked_at: _checked, ...state } = verdict;
    checks.push({ name: 'global_maintenance_stalled', status, message, details: { code: 'global_maintenance_stalled', ...state, docs: DOCS }, ...(fix ? { fix } : {}) });
  } catch (error) {
    checks.push(checkError('global_maintenance_stalled', 'read the brain-wide maintenance state', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const globalMaintenanceStalledEntry: DoctorEntry = {
  name: 'global_maintenance_stalled',
  emits: ['global_maintenance_stalled'],
  run: runGlobalMaintenanceStalled,
};
