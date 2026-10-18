/**
 * #6696 B2: `run_doctor` with `tier` / `only` (admin scope). `tier: 'ops'`
 * runs the ops sections of the local registry on the serving host under one
 * 4 s deadline (observational: the serve's engine is already connected);
 * `only` narrows it, or narrows the focused remote report when none of the
 * names is an ops section. Every source-aware section is confined to the
 * caller's source scope. Nothing here mutates.
 */
import type { OperationContext } from '../../core/ops/contract.ts';
import { sourceScopeOpts } from '../../core/ops/context.ts';
import { invalidParam } from '../../core/ops/op-fix.ts';
import { computeDoctorReport, doctorReportRemote, buildChecks, type DoctorReport } from '../doctor.ts';
import { doctorCheckNames, opsCheckNames } from './registry.ts';
import { startDoctorDeadline } from './budget.ts';

export async function runRemoteDoctorTier(ctx: OperationContext, p: Record<string, unknown>): Promise<DoctorReport> {
  if (p.tier !== undefined && p.tier !== 'ops') {
    throw invalidParam(ctx, 'run_doctor', 'tier', 'run_doctor: tier must be "ops" (the standard and deep tiers run only on the brain host: gbrain doctor --tier deep).', { example: 'ops' });
  }
  const only = p.only === undefined ? null : Array.isArray(p.only) && p.only.every((n) => typeof n === 'string' && n.length > 0) ? p.only as string[] : undefined;
  if (only === undefined || (only && only.length === 0)) throw invalidParam(ctx, 'run_doctor', 'only', 'run_doctor: only must be a non-empty array of check names.', { example: ['persistence_capacity'] });
  const known = doctorCheckNames();
  const unknown = (only ?? []).filter((n) => !known.has(n));
  if (unknown.length) throw invalidParam(ctx, 'run_doctor', 'only', `run_doctor: unknown check ${unknown.join(', ')}. Valid names: ${[...known].sort().join(', ')}.`, { example: ['persistence_capacity'] });

  const scope = sourceScopeOpts(ctx);
  const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined);
  const transport = ctx.remote === false ? 'cli' : ctx.transport ?? 'http';
  const render = { transport, isCallable: (op: string) => op === 'run_doctor' || op === 'get_brain_health', preapproved: () => false } as const;
  const ops = opsCheckNames();
  if (p.tier === 'ops' || (only && only.every((n) => ops.has(n)))) {
    const args = ['--json', '--tier', 'ops', ...(only ? ['--only', only.join(',')] : [])];
    const deadline = startDoctorDeadline(args);
    const checks = await buildChecks(ctx.engine, args, undefined, undefined, deadline, { sourceIds });
    return computeDoctorReport(checks, { engine: ctx.engine.kind, render, run: { tier: 'ops', startedAt: deadline.startedAt, budgetMs: deadline.budgetMs } });
  }
  const report = await doctorReportRemote(ctx.engine, { sourceIds, remote: ctx.remote, render });
  const kept = report.checks.filter((c) => only!.includes(c.name));
  return computeDoctorReport(kept, { engine: report.engine, render });
}
