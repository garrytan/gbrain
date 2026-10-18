/**
 * `unindexed_files` cycle phase (#6865): one bounded pass of the unindexed-file
 * detector (src/core/persistence/unindexed-files.ts) over every managed Git
 * source this host owns, in the global maintenance lane right after
 * `content_repair`. It finds committed files with no page, no hold and no
 * scheduled re-screen (typically files an older gbrain refused before
 * refusals became holds), stores the result where doctor `unindexed_files`
 * reads it, and schedules the found paths for a re-screen on the next sync
 * (at most `UNINDEXED_SCHEDULE_CAP` per run), so each is imported or recorded
 * as a hold. Scheduling is the only write: no file or page changes here, and
 * the per-sync path never runs it.
 *
 * Deadline: min(60 s, a third of the maintenance job's remaining time),
 * shared by the sources in id order; a source the budget stops is continued
 * by the next run from its stored cursor. A dry run scans and reports without
 * scheduling or storing. The report is counts only, never a path. It never
 * fails the cycle: an error on a source reports `warn` and the others still run.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { SyncOpts } from '../../commands/sync.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { resolveManagedSyncContext } from '../persistence/sync-discovery.ts';
import { companyBrainProfile } from '../company-brain/policy.ts';
import { findUnindexedFiles, refreshUnindexedFiles, UNINDEXED_SCAN_BUDGET_MS, UNINDEXED_SCHEDULE_CAP, type UnindexedScan } from '../persistence/unindexed-files.ts';
import { isUncontainedPhaseError } from './phase-containment.ts';

export interface UnindexedFilesPhaseOpts {
  dryRun: boolean;
  signal?: AbortSignal;
  /** The enclosing maintenance job's absolute deadline (epoch ms); null or unset for a direct `gbrain dream`. */
  deadlineAtMs?: number | null;
  now?: () => number;
}

const errorCode = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' ? code : 'internal'; };

export async function runUnindexedFilesPhase(engine: BrainEngine | null, opts: UnindexedFilesPhaseOpts): Promise<PhaseResult> {
  const base = { phase: 'unindexed_files' as const, duration_ms: 0 };
  if (!engine) return { ...base, status: 'skipped', summary: 'no database connected', details: { reason: 'no_database' } };
  if (!(await managedPersistenceEnabled(engine))) {
    return { ...base, status: 'skipped', summary: 'managed persistence is off, so there is no managed Git source to check for unindexed files', details: { reason: 'not_managed' } };
  }
  const now = opts.now ?? Date.now;
  const start = now();
  const timeBudgetMs = opts.deadlineAtMs == null ? UNINDEXED_SCAN_BUDGET_MS : Math.min(UNINDEXED_SCAN_BUDGET_MS, Math.floor((opts.deadlineAtMs - start) / 3));
  if (timeBudgetMs <= 0) return { ...base, status: 'skipped', summary: 'no maintenance-job time left to look for unindexed files; the next run continues', details: { reason: 'deadline' } };
  const deadlineAt = start + timeBudgetMs;
  const rows = await engine.executeRaw<{ id: string; config: Record<string, unknown> | null }>(
    "SELECT id, config FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL AND (config->>'kind') IS NULL ORDER BY id");
  const sources: Array<{ source_id: string; complete: boolean; scanned: number; unindexed: number; slug_taken: number; scheduled_now: number; already_scheduled: number;
    metafile_skipped: number; by_code: Record<string, number> }> = [];
  const skipped: Array<{ source_id: string; reason: string }> = [];
  const errors: Array<{ source_id: string; code: string }> = [];
  let room = UNINDEXED_SCHEDULE_CAP;
  for (const row of rows) {
    if (now() >= deadlineAt) { skipped.push({ source_id: row.id, reason: 'deadline' }); continue; }
    try {
      if (companyBrainProfile(row.config ?? {})) { skipped.push({ source_id: row.id, reason: 'company_source' }); continue; }
      const context = await resolveManagedSyncContext(engine, { sourceId: row.id, noPull: true } as SyncOpts).catch((error: unknown) => {
        if (['owner_unavailable', 'source_changed', 'writer_coordinator_required'].includes(errorCode(error))) return errorCode(error);
        throw error;
      });
      if (typeof context === 'string') { skipped.push({ source_id: row.id, reason: context }); continue; }
      let scan: UnindexedScan, scheduledNow = 0;
      if (opts.dryRun) scan = await findUnindexedFiles(engine, row.id, { context, deadlineAt, now });
      else {
        const refresh = await refreshUnindexedFiles(engine, row.id, { context, deadlineAt, now, keep: room });
        scan = refresh.scan; scheduledNow = refresh.scheduled.length; room -= scheduledNow;
      }
      sources.push({ source_id: row.id, complete: scan.complete, scanned: scan.scanned, unindexed: scan.unindexed, slug_taken: scan.slug_taken,
        scheduled_now: scheduledNow, already_scheduled: scan.scheduled, metafile_skipped: scan.metafile_skipped, by_code: scan.by_code });
    } catch (error) {
      if (isUncontainedPhaseError(error, opts.signal)) throw error;
      errors.push({ source_id: row.id, code: errorCode(error) });
    }
  }
  const total = (key: 'scanned' | 'unindexed' | 'slug_taken' | 'scheduled_now' | 'already_scheduled' | 'metafile_skipped') => sources.reduce((n, source) => n + source[key], 0);
  const byCode: Record<string, number> = {};
  for (const source of sources) for (const [code, n] of Object.entries(source.by_code)) byCode[code] = (byCode[code] ?? 0) + n;
  const incomplete = sources.filter(source => !source.complete).length;
  const codes = Object.entries(byCode).map(([code, n]) => `${code} ${n}`).join(', ');
  const parts = [
    `${opts.dryRun ? 'dry run: ' : ''}checked ${total('scanned')} committed file(s) in ${sources.length} managed Git source(s)`,
    total('unindexed') ? `${total('unindexed')} had no page and no hold (${codes}${total('slug_taken') ? `; ${total('slug_taken')} share a slug with another page` : ''})` : 'none was missing from the index',
    opts.dryRun ? (total('unindexed') ? 'nothing was scheduled' : '') : total('scheduled_now') ? `${total('scheduled_now')} scheduled for a re-screen on the next sync` : '',
    total('already_scheduled') ? `${total('already_scheduled')} already wait for a re-screen` : '',
    total('metafile_skipped') ? `${total('metafile_skipped')} titled file(s) are named like folder scaffolding (index.md and the like), which sync skips on purpose; renaming one is the user's call` : '',
  ].filter(Boolean);
  const notes = [
    incomplete ? `${incomplete} source(s) stopped at the phase time budget (${Math.round(timeBudgetMs / 1000)} s); the next maintenance run continues where they stopped.` : '',
    skipped.length ? `${skipped.length} source(s) skipped (${[...new Set(skipped.map(s => s.reason))].join(', ')}).` : '',
    errors.length ? `${errors.length} source(s) could not be checked (${[...new Set(errors.map(e => e.code))].join(', ')}); gbrain doctor --only unindexed_files --json shows each source's state.` : '',
  ].filter(Boolean);
  return {
    ...base,
    status: errors.length ? 'warn' : 'ok',
    summary: [`${parts.join('; ')}.`, ...notes].join(' '),
    details: {
      mode: opts.dryRun ? 'dry_run' : 'apply', sources: sources.map(({ by_code: _codes, ...source }) => source), scanned: total('scanned'), unindexed: total('unindexed'),
      slug_taken: total('slug_taken'), scheduled_now: total('scheduled_now'), already_scheduled: total('already_scheduled'), metafile_skipped: total('metafile_skipped'), by_code: byCode,
      complete: incomplete === 0, time_budget_ms: timeBudgetMs, skipped, errors,
      ...(errors.length ? { fix: { argv: ['gbrain', 'doctor', '--only', 'unindexed_files', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows each managed Git source\'s unindexed-file state and the next step; read-only.' } } : {}),
    },
  };
}
