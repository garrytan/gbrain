/**
 * `git_maintenance` cycle phase (Wave C 1C, G7): for every strict source (`config.canonical = "git"`) whose Git checkout
 * is on this host, including a hosted source's bare repository through its linked worktree, the run
 * `src/core/git/maintenance.ts` plans automatically: a daily prune-and-repack, or a repack when loose objects passed
 * their threshold or grew past a large door publication's size since the last run. Runs in the global maintenance lane
 * after `unindexed_files`, without the writer lock (only the maintenance lock, so door writes never wait on it).
 *
 * Skipped brain-wide when `git.maintenance` is `off`, and per source when the user scheduled git's own maintenance
 * there (doctor `git_repo_health` says so), when another run holds the maintenance lock, or when the maintenance job's
 * deadline has passed. A dry run reports the plans and runs nothing. It never fails the cycle: an error on one source is
 * `warn` and the others still run. Details are counts and sizes by source, never a path.
 */
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { GIT_MAINTENANCE_KEY, planMaintenance, runMaintenance, type MaintenanceKind, type MaintenanceTrigger } from '../git/maintenance.ts';
import { isGitCheckout } from '../persistence/git-gap.ts';
import { isUncontainedPhaseError } from './phase-containment.ts';

export interface GitMaintenancePhaseOpts {
  dryRun: boolean;
  signal?: AbortSignal;
  /** The enclosing maintenance job's absolute deadline (epoch ms); null or unset for a direct `gbrain dream`. */
  deadlineAtMs?: number | null;
  now?: () => number;
}

const errorCode = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' ? code : 'internal'; };

export async function runGitMaintenancePhase(engine: BrainEngine | null, opts: GitMaintenancePhaseOpts): Promise<PhaseResult> {
  const base = { phase: 'git_maintenance' as const, duration_ms: 0 };
  if (!engine) return { ...base, status: 'skipped', summary: 'no database connected', details: { reason: 'no_database' } };
  if ((await engine.getConfig(GIT_MAINTENANCE_KEY))?.trim().toLowerCase() === 'off') {
    return { ...base, status: 'skipped', summary: `${GIT_MAINTENANCE_KEY} is off, so gbrain packs and prunes no Git repository`, details: { reason: 'disabled' } };
  }
  const now = opts.now ?? Date.now;
  const rows = await engine.executeRaw<{ id: string; local_path: string }>(
    "SELECT id, local_path FROM sources WHERE NOT archived AND local_path IS NOT NULL AND COALESCE(config->>'canonical','')='git' ORDER BY id");
  const ran: Array<{ source_id: string; kind: MaintenanceKind; trigger: MaintenanceTrigger; loose_bytes_before: number; loose_bytes_after: number | null; packs_after: number | null; pruned_objects: number }> = [];
  const skipped: Array<{ source_id: string; reason: string }> = [];
  const errors: Array<{ source_id: string; code: string }> = [];
  for (const row of rows) {
    if (opts.deadlineAtMs != null && now() >= opts.deadlineAtMs) { skipped.push({ source_id: row.id, reason: 'deadline' }); continue; }
    if (!existsSync(row.local_path) || !isGitCheckout(row.local_path)) { skipped.push({ source_id: row.id, reason: 'no_checkout' }); continue; }
    try {
      const plan = await planMaintenance(row.local_path, { manual: false, now: now() });
      if (plan.user_scheduled) { skipped.push({ source_id: row.id, reason: 'user_scheduled' }); continue; }
      if (!plan.kind || !plan.trigger) { skipped.push({ source_id: row.id, reason: 'not_due' }); continue; }
      if (opts.dryRun) {
        ran.push({ source_id: row.id, kind: plan.kind, trigger: plan.trigger, loose_bytes_before: plan.stats.loose_bytes, loose_bytes_after: null, packs_after: null, pruned_objects: plan.kind === 'daily' ? plan.would_prune : 0 });
        continue;
      }
      const record = await runMaintenance(plan, { now, signal: opts.signal, deadlineAtMs: opts.deadlineAtMs ?? undefined });
      if (!record) { skipped.push({ source_id: row.id, reason: 'maintenance_busy' }); continue; }
      ran.push({ source_id: row.id, kind: record.kind, trigger: record.trigger, loose_bytes_before: record.before.loose_bytes,
        loose_bytes_after: record.after?.loose_bytes ?? null, packs_after: record.after?.packs ?? null, pruned_objects: record.pruned_objects });
    } catch (error) {
      if (isUncontainedPhaseError(error, opts.signal)) throw error;
      errors.push({ source_id: row.id, code: errorCode(error) });
    }
  }
  const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;
  const parts = [
    `${opts.dryRun ? 'dry run: ' : ''}${rows.length} strict source(s)`,
    ran.length ? `${opts.dryRun ? 'would maintain' : 'maintained'} ${ran.map(r => `${r.source_id} (${r.kind}, ${mib(r.loose_bytes_before)} loose${r.loose_bytes_after === null ? '' : ` -> ${mib(r.loose_bytes_after)}`}${r.pruned_objects ? `, ${r.pruned_objects} unreachable object(s) past the two-week grace pruned` : ''})`).join(', ')}` : 'none due',
    skipped.length ? `${skipped.length} skipped (${[...new Set(skipped.map(s => s.reason))].join(', ')})` : '',
    errors.length ? `${errors.length} failed (${[...new Set(errors.map(e => e.code))].join(', ')}); gbrain doctor --only git_repo_health --json shows each source's state` : '',
  ].filter(Boolean);
  return {
    ...base,
    status: errors.length ? 'warn' : 'ok',
    summary: `${parts.join('; ')}.`,
    details: { mode: opts.dryRun ? 'dry_run' : 'apply', sources: ran, skipped, errors,
      ...(errors.length ? { fix: { argv: ['gbrain', 'doctor', '--only', 'git_repo_health', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows each strict source\'s Git object store, its last maintenance run and the next step; read-only.' } } : {}) },
  };
}
