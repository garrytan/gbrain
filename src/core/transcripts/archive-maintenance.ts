/**
 * archive-maintenance.ts — the conversation archive's step in the maintenance pass (GST-2768 PR 3).
 *
 * Unattended upkeep (the serve's idle tick, gbrain maintain --unattended and its schedule) and the autopilot tick
 * call runArchiveMaintenance. A brain archived while personal that has become shared is re-scoped to its owner first,
 * even though the unset switch now resolves off. Otherwise it does nothing unless the archive resolves on
 * (archive-default.ts), runs at most once
 * per transcripts.archive.maintenance_floor_min, and holds the gbrain-transcript-archive lock so two runners never
 * archive at once (a repository write still takes the checkout's writer lock through gbrain git commit-push). One
 * pass archives the forward window (archive run) and then one bounded backfill run over older days
 * (transcripts.archive.backfill_days_per_run, newest first, embedding held as archive_backfill) until backfill has
 * nothing left. One pass is bounded by a count (the run window, transcripts.archive.run_window_days, and
 * backfill_days_per_run) and by time (ARCHIVE_MAINTENANCE_BUDGET_MS: no further reader or conversation starts after
 * it once one conversation has been written, so a slow reader still moves forward every pass).
 * On a managed brain each day page is a put_page write request through the write coordinator (submitPageMutation),
 * under the same local_cli identity as gbrain transcripts archive run; the wait for it counts against the budget, and a
 * write the coordinator accepted but has not published yet is submitted again by later runs until it is published, and
 * keeps the backfill open, as a held day does.
 *
 * Never throws: every outcome, an archive error included, is recorded in transcripts.archive.last_maintenance, which
 * the transcript_archive_freshness doctor check reads. No fact extraction, no Dream synthesis, and no embedding call
 * here: new days are embedded like any new page (unattended upkeep caps that at maintenance.embed_daily_usd; autopilot
 * and a managed brain's write coordinator embed new pages as they arrive), and backfilled days stay held.
 */

import type { BrainEngine } from '../engine.ts';
import { tryAcquireDbLock } from '../db-lock.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { GBrainConfig } from '../config.ts';
import { persistenceConsumerConfig } from '../persistence/service.ts';
import { resolveCliWriteWaitMs } from '../persistence/write-wait.ts';
import { insideCoordinatedWrite } from '../persistence/context.ts';
import { resolveArchiveEnabled } from './archive-default.ts';
import { addDays } from './archive-day.ts';
import type { ArchiveReader, ArchiveRunResult, runTranscriptArchive } from './archive.ts';

export const ARCHIVE_MAINTENANCE_KEY = 'transcripts.archive.last_maintenance';
export const ARCHIVE_BACKFILL_STATE_KEY = 'transcripts.archive.backfill_state';
export const ARCHIVE_MAINTENANCE_FLOOR_KEY = 'transcripts.archive.maintenance_floor_min';
export const DEFAULT_ARCHIVE_MAINTENANCE_FLOOR_MIN = 360;
export const ARCHIVE_STALE_DAYS_KEY = 'transcripts.archive.stale_days';
export const DEFAULT_ARCHIVE_STALE_DAYS = 2;
/** The automatic backfill reads every session the readers hold; this is only the lower bound of its range. */
export const ARCHIVE_BACKFILL_EARLIEST = '2000-01-01';
export const ARCHIVE_MAINTENANCE_LOCK_ID = 'gbrain-transcript-archive';
const LOCK_TTL_MIN = 30;
/** Wall-clock budget of one pass's archive work (forward run plus backfill); conversations not reached wait for the next pass. */
export const ARCHIVE_MAINTENANCE_BUDGET_MS = 120_000;
/** Run refusals that end this pass's archive step as a recorded skip the next pass retries (the floor ignores a skip). */
export const ARCHIVE_RETRYABLE_CODES: readonly string[] = ['archive_run_busy', 'archive_audience_unproven', 'archive_audience_changed'];

export interface ArchiveMaintenanceError { code: string; message: string }

export interface ArchiveMaintenanceRecord {
  at: string;
  runner: string;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  code?: string;
  message?: string;
  written: number;
  /** Day writes the coordinator accepted and publishes later (a managed brain); recorded, not written again. */
  accepted?: number;
  held: number;
  errors: ArchiveMaintenanceError[];
  backfill?: { written: number; deferred: number; done: boolean };
  /** The pass reached ARCHIVE_MAINTENANCE_BUDGET_MS and left the rest for the next pass. */
  stopped_at_deadline?: boolean;
}

export interface ArchiveMaintenanceOutcome {
  status: 'ran' | 'skipped' | 'not_due';
  code?: string;
  message: string;
  record?: ArchiveMaintenanceRecord;
}

export interface ArchiveMaintenanceOpts {
  runner: string;
  now?: Date;
  /** Test seams. */
  readers?: ArchiveReader[];
  run?: typeof runTranscriptArchive;
  budgetMs?: number;
}

export async function readArchiveMaintenance(engine: Pick<BrainEngine, 'getConfig'>): Promise<ArchiveMaintenanceRecord | null> {
  const raw = await engine.getConfig(ARCHIVE_MAINTENANCE_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ArchiveMaintenanceRecord;
    return parsed && typeof parsed.at === 'string' ? { ...parsed, errors: Array.isArray(parsed.errors) ? parsed.errors : [] } : null;
  } catch {
    return null;
  }
}

function nonNegative(value: string | null | undefined, fallback: number): number {
  const raw = value?.trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resultErrors(result: ArchiveRunResult): ArchiveMaintenanceError[] {
  return [
    ...result.errors.filter(e => e.reader).map(e => ({ code: e.code, message: (e.reader + ': ' + e.message).slice(0, 300) })),
    ...result.days.filter(d => d.status === 'error').map(d => ({ code: d.code ?? 'archive_day_failed', message: (d.harness + ' ' + d.day + ': ' + (d.message ?? 'no detail')).slice(0, 300) })),
  ];
}

async function save(engine: BrainEngine, record: ArchiveMaintenanceRecord): Promise<void> {
  await engine.setConfig(ARCHIVE_MAINTENANCE_KEY, JSON.stringify(record)).catch(() => undefined);
}

/** One archive step of a maintenance pass (module comment). Never throws. */
export async function runArchiveMaintenance(engine: BrainEngine, opts: ArchiveMaintenanceOpts): Promise<ArchiveMaintenanceOutcome> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  try {
    const { reconcileArchiveAudience } = await import('./archive.ts');
    await reconcileArchiveAudience(engine);
    const enablement = await resolveArchiveEnabled(engine);
    if (!enablement.enabled) return { status: 'skipped', code: 'archive_off', message: 'The conversation archive is off on this brain (' + enablement.reason + '); nothing ran.' };
    const prior = await readArchiveMaintenance(engine);
    const floorMs = nonNegative(await engine.getConfig(ARCHIVE_MAINTENANCE_FLOOR_KEY).catch(() => null), DEFAULT_ARCHIVE_MAINTENANCE_FLOOR_MIN) * 60_000;
    if (prior && prior.status !== 'skipped' && now.getTime() - Date.parse(prior.at) < floorMs) {
      return { status: 'not_due', message: 'The archive last ran at ' + prior.at + '; the next pass runs it after ' + ARCHIVE_MAINTENANCE_FLOOR_KEY + '.' };
    }
    if (insideCoordinatedWrite()) {
      const record: ArchiveMaintenanceRecord = { at, runner: opts.runner, status: 'skipped', code: 'archive_inside_publication', written: 0, held: 0, errors: [],
        message: 'The pass was called inside a coordinated write, where submitting to the coordinator would wait on itself; the next pass archives.' };
      await save(engine, record);
      return { status: 'skipped', code: record.code, message: record.message!, record };
    }
    const lock = await tryAcquireDbLock(engine, ARCHIVE_MAINTENANCE_LOCK_ID, LOCK_TTL_MIN);
    if (!lock) return { status: 'skipped', code: 'archive_running', message: 'Another runner is archiving conversations right now; this pass left it alone.' };
    try {
      const run = opts.run ?? (await import('./archive.ts')).runTranscriptArchive;
      const readers = opts.readers;
      const makeContext = async (sourceId: string): Promise<OperationContext> => {
        const config = persistenceConsumerConfig(engine) ?? ({ engine: engine.kind } as GBrainConfig);
        return { engine, config, remote: false, admissionOrigin: 'background', sourceId, dryRun: false,
          logger: { info() {}, warn() {}, error() {} }, writeWaitMs: resolveCliWriteWaitMs({ config }) };
      };
      const record: ArchiveMaintenanceRecord = { at, runner: opts.runner, status: 'ok', written: 0, held: 0, errors: [] };
      try {
        const deadlineAtMs = Date.now() + (opts.budgetMs ?? ARCHIVE_MAINTENANCE_BUDGET_MS);
        const forward = await run(engine, { mode: 'run', now, deadlineAtMs, makeContext, ...(readers ? { readers } : {}) });
        record.written += forward.written;
        if (forward.accepted) record.accepted = (record.accepted ?? 0) + forward.accepted;
        record.held += forward.held;
        record.errors.push(...resultErrors(forward));
        const state = await engine.getConfig(ARCHIVE_BACKFILL_STATE_KEY).catch(() => null);
        const done = !!state && (JSON.parse(state) as { done?: boolean }).done === true;
        if (forward.stopped_at_deadline) record.stopped_at_deadline = true;
        if (!done && forward.from && !record.stopped_at_deadline && Date.now() < deadlineAtMs) {
          const backfill = await run(engine, { mode: 'backfill', from: ARCHIVE_BACKFILL_EARLIEST, to: addDays(forward.from, -1), now, deadlineAtMs, makeContext, ...(readers ? { readers } : {}) });
          if (backfill.stopped_at_deadline) record.stopped_at_deadline = true;
          const errors = resultErrors(backfill);
          record.written += backfill.written;
          if (backfill.accepted) record.accepted = (record.accepted ?? 0) + backfill.accepted;
          record.held += backfill.held;
          record.errors.push(...errors);
          record.backfill = { written: backfill.written, deferred: backfill.deferred_days.length, done: backfill.deferred_days.length === 0 && errors.length === 0 && !backfill.stopped_at_deadline && backfill.held === 0 && !backfill.accepted };
          if (record.backfill.done) await engine.setConfig(ARCHIVE_BACKFILL_STATE_KEY, JSON.stringify({ done: true, at }));
        }
        if (record.errors.length) {
          record.status = 'partial';
          record.code = record.errors[0]!.code;
        }
      } catch (error) {
        const e = error as { code?: string; message?: string };
        if (e.code && ARCHIVE_RETRYABLE_CODES.includes(e.code)) {
          const skipped: ArchiveMaintenanceRecord = { ...record, status: 'skipped', code: e.code, message: (e.message ?? String(error)).slice(0, 300) };
          await save(engine, skipped);
          return { status: 'skipped', code: e.code, message: 'The archive step did not run this pass (' + e.code + '); the next pass tries again.', record: skipped };
        }
        record.status = 'failed';
        record.code = e.code ?? 'archive_maintenance_failed';
        record.errors.push({ code: record.code, message: (e.message ?? String(error)).slice(0, 300) });
      }
      await save(engine, record);
      return {
        status: 'ran', ...(record.code ? { code: record.code } : {}), record,
        message: record.status === 'failed'
          ? 'The archive step failed with ' + record.code + '; the pass went on and doctor shows it.'
          : 'The archive step wrote ' + record.written + ' day page(s)' + (record.held ? ', ' + record.held + ' held' : '') + (record.errors.length ? ', ' + record.errors.length + ' error(s)' : '') + '.',
      };
    } finally {
      await lock.release();
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'archive_maintenance_failed';
    return { status: 'skipped', code, message: 'The archive step could not start: ' + (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}
