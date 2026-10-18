/**
 * `gbrain autopilot --retry-global [--phase <name>] [--json]` (GBRA-130 A-10):
 * ends the back-off of a brain-wide maintenance phase that kept failing, so the
 * next autopilot pass runs it again. The streak count stays: a phase that still
 * fails keeps the pass stamping past it and backs off again. Without --phase
 * every backed-off phase is released. Writes only the progress row in config.
 */
import type { BrainEngine } from '../core/engine.ts';
import {
  GLOBAL_MAINTENANCE_PROGRESS_KEY, readGlobalMaintenanceProgress, resolveGlobalFloorMin,
} from '../core/minions/handlers/autopilot-global-maintenance.ts';

export async function runAutopilotRetryGlobal(engine: BrainEngine, args: string[]): Promise<void> {
  const phaseAt = args.indexOf('--phase');
  const phase = phaseAt >= 0 ? args[phaseAt + 1] : undefined;
  const progress = await readGlobalMaintenanceProgress(engine);
  const streaks = progress.failures ?? {};
  const released = Object.keys(streaks).filter(p => (phase === undefined || p === phase) && streaks[p]!.retry_at);
  for (const p of released) delete streaks[p]!.retry_at;
  if (released.length > 0) await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify(progress));
  const [active] = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs WHERE name = 'autopilot-global-maintenance' AND status = 'active' ORDER BY id DESC LIMIT 1`);
  const floorMin = await resolveGlobalFloorMin(engine);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ released, streaks: Object.entries(streaks).map(([p, s]) => ({ phase: p, ...s })), running_job: active ? Number(active.id) : null }));
    return;
  }
  if (released.length === 0) {
    console.log(phase ? `Phase ${phase} is not backing off; nothing to retry.` : 'No brain-wide maintenance phase is backing off; nothing to retry.');
    return;
  }
  console.log(`Released ${released.join(', ')}: the next brain-wide maintenance pass (at most every ${floorMin} min) runs ${released.length === 1 ? 'it' : 'them'} again.`);
  if (active) console.log(`Pass job #${active.id} is running now and may restore the back-off when it saves; if \`gbrain doctor --only global_maintenance_stalled\` still shows it, run this again after the job finishes.`);
}
