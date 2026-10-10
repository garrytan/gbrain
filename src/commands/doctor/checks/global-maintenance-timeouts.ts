/**
 * global_maintenance_timeouts doctor check (#4578): the brain-wide maintenance
 * job (`autopilot-global-maintenance`) keeps dying at its deadline. Warns when
 * its last three finished jobs were all timeout deaths, or when one phase was
 * running in three consecutive job deaths (the handler then skips it each
 * pass). The fix runs the phase alone, without the job deadline, and the
 * deadline itself is configurable. #6303: a dream patterns or synthesize child
 * dies at its own subagent timeout while the maintenance job completes, so the
 * check also warns when a phase's last three finished children all died that way.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readGlobalMaintenanceProgress } from '../../../core/minions/handlers/autopilot-global-maintenance.ts';

const DOCS = 'docs/guides/troubleshooting.md#global-maintenance-timeouts';
const DEATHS = 3;

export async function globalMaintenanceTimeoutsCheck(engine: BrainEngine): Promise<Check> {
  try {
    const recent = await engine.executeRaw<{ id: number; status: string; error_text: string | null }>(
      `SELECT id, status, error_text FROM minion_jobs
        WHERE name = 'autopilot-global-maintenance' AND status IN ('completed', 'failed', 'dead', 'cancelled')
        ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT ${DEATHS}`);
    const timeoutDeaths = recent.length === DEATHS
      && recent.every(job => job.status === 'dead' && /timeout exceeded/.test(job.error_text ?? ''));
    const progress = await readGlobalMaintenanceProgress(engine);
    const phases = Object.entries(progress.timeouts ?? {})
      .filter(([, t]) => t.count >= DEATHS)
      .map(([phase, t]) => ({ phase, consecutive_deaths: t.count, last_at: t.last_at }));
    const children = await engine.executeRaw<{ phase: 'patterns' | 'synthesize'; deaths: number; last_at: string | null }>(
      `SELECT phase, count(*)::int AS deaths, max(finished_at)::text AS last_at FROM (
         SELECT phase, status, error_text, finished_at,
                row_number() OVER (PARTITION BY phase ORDER BY finished_at DESC NULLS LAST, id DESC) AS n
           FROM (SELECT id, status, error_text, finished_at,
                        CASE WHEN key LIKE 'dream:patterns:%' THEN 'patterns' ELSE 'synthesize' END AS phase
                   FROM (SELECT id, status, error_text, finished_at,
                                COALESCE(idempotency_key, data->>'__released_idempotency_key') AS key
                           FROM minion_jobs
                          WHERE name = 'subagent' AND status IN ('completed', 'failed', 'dead', 'cancelled')) keyed
                  WHERE key LIKE 'dream:patterns:%' OR key LIKE 'dream:synth%') phased
       ) recent
        WHERE n <= ${DEATHS}
        GROUP BY phase
       HAVING count(*) = ${DEATHS} AND bool_and(status = 'dead' AND error_text ~ 'timeout exceeded')`);
    const childTimeouts = children.map(c => ({ phase: c.phase, consecutive_deaths: Number(c.deaths), last_at: c.last_at }));
    const phase = phases[0]?.phase ?? childTimeouts[0]?.phase ?? progress.running_phase ?? progress.next_phase;
    if (!timeoutDeaths && phases.length === 0 && childTimeouts.length === 0) {
      return { name: 'global_maintenance_timeouts', status: 'ok', message: 'Brain-wide maintenance jobs are finishing within their deadline.' };
    }
    const fix = phase
      ? { kind: 'run_command', argv: ['gbrain', 'dream', '--phase', phase] }
      : { kind: 'run_command', argv: ['gbrain', 'config', 'set', 'autopilot.global_maintenance_timeout_ms', '3600000'] };
    const causes = [
      ...(phases.length > 0 ? [`phase ${phases.map(p => p.phase).join(', ')} was running in ${DEATHS}+ consecutive autopilot-global-maintenance job deaths and is skipped each pass`] : []),
      ...(timeoutDeaths && phases.length === 0 ? [`the last ${DEATHS} autopilot-global-maintenance jobs (${recent.map(j => `#${j.id}`).join(', ')}) died at their deadline`] : []),
      ...childTimeouts.map(c => `the last ${DEATHS} dream ${c.phase} subagent children died at their subagent timeout`),
    ];
    const cause = causes.join('; ');
    const childAdvice = childTimeouts.map(c =>
      `Raise the ${c.phase} child timeout with: gbrain config set dream.${c.phase}.subagent_timeout_ms <ms> (gbrain dream --phase ${c.phase} reruns it and is paid). `).join('');
    return {
      name: 'global_maintenance_timeouts',
      status: 'warn',
      message: `Brain-wide maintenance is not finishing: ${cause}. `
        + (phase && childTimeouts.length === 0 ? `Run the phase without the job deadline: gbrain dream --phase ${phase}. ` : '')
        + childAdvice
        + `Raise the job deadline with: gbrain config set autopilot.global_maintenance_timeout_ms <ms> (or GBRAIN_GLOBAL_MAINTENANCE_TIMEOUT_MS). See ${DOCS}.`,
      details: { code: 'global_maintenance_timeouts', cause, fix, docs: DOCS, recent_job_ids: recent.map(j => j.id), phases, child_timeouts: childTimeouts,
        resume_phase: progress.next_phase ?? null },
    };
  } catch (error) {
    return { name: 'global_maintenance_timeouts', status: 'warn', message: `Global maintenance history could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown' } };
  }
}

async function runGlobalMaintenanceTimeouts(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { status, message, details } = await globalMaintenanceTimeoutsCheck(connectedEngine(ctx));
  checks.push({ name: 'global_maintenance_timeouts', status, message, details });
  return checks;
}

export const globalMaintenanceTimeoutsEntry: DoctorEntry = {
  name: 'global_maintenance_timeouts',
  emits: ['global_maintenance_timeouts'],
  run: runGlobalMaintenanceTimeouts,
};
