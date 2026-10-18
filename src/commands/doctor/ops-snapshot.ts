/**
 * #6696 B2: the full ops snapshot behind `/admin/api/ops` (admin-gated): the
 * doctor ops-tier report and the capacity view, computed at most once per
 * engine every 60 s (in flight included), so a dashboard polling it costs one
 * ops run a minute. A failed run is cached too, so a struggling database is not
 * asked again on every poll.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { readCapacityView, type CapacityView } from '../../core/persistence/capacity-view.ts';
import { buildChecks, computeDoctorReport, type DoctorReport } from '../doctor.ts';
import { startDoctorDeadline } from './budget.ts';

export const OPS_SNAPSHOT_TTL_MS = 60_000;

export interface OpsSnapshot {
  generated_at: string;
  report: DoctorReport;
  capacity: CapacityView | { status: 'unknown'; reason: string };
}

const snapshots = new WeakMap<BrainEngine, { at: number; value: Promise<OpsSnapshot> }>();

export function cachedOpsSnapshot(engine: BrainEngine, now = Date.now()): Promise<OpsSnapshot> {
  const hit = snapshots.get(engine);
  if (hit && now - hit.at < OPS_SNAPSHOT_TTL_MS) return hit.value;
  const value = computeOpsSnapshot(engine);
  snapshots.set(engine, { at: now, value });
  return value;
}

async function computeOpsSnapshot(engine: BrainEngine): Promise<OpsSnapshot> {
  const args = ['--json', '--tier', 'ops'];
  const deadline = startDoctorDeadline(args);
  const checks = await buildChecks(engine, args, undefined, undefined, deadline);
  const capacity = await readCapacityView(engine).catch((error: unknown) => ({ status: 'unknown' as const, reason: error instanceof Error ? error.message : String(error) }));
  return { generated_at: new Date().toISOString(),
    report: computeDoctorReport(checks, { engine: engine.kind, run: { tier: 'ops', startedAt: deadline.startedAt, budgetMs: deadline.budgetMs } }), capacity };
}
