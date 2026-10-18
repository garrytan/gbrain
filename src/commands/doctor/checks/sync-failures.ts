import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { loadSyncFailures, unacknowledgedSyncFailures, decideSyncFailureSeverity, type SyncFailure } from '../../../core/sync-failure-ledger.ts';
import { formatManagedSyncFailure, managedSyncRetryCommand, readManagedSyncFailures } from '../../../core/persistence/sync-failures.ts';
import { resolveHoursEnv } from '../../../core/env-number.ts';
import { makeRemediationStep } from '../../../core/remediation-step.ts';
import { classifyManagedSyncOrphans, type ManagedSyncOrphan } from '../../../core/persistence/managed-sync-orphans.ts';
import { readManagedMode } from '../../../core/persistence/ownership.ts';
import { legacyLedgerNote } from '../../../core/persistence/legacy-sync-failures.ts';
import { classifyRecordedFault } from '../../../core/persistence/terminal-classify.ts';
import { agentFix } from '../check-fix.ts';

/** #6518 [R18 vi]: the fast check cannot verify a mirror row; a warning there is uncertainty, never recovery. */
const MIRROR_UNVERIFIED = (count: number) => `${count} mirrored managed sync failure(s) could not be verified without a database connection: `
  + 'a better fast score means less certainty, not that sync recovered. Run gbrain doctor --only sync_failures with the brain reachable.';

export async function checkSyncFailures(engine: BrainEngine | null, opts: { sourceIds?: string[]; remote?: boolean } = {}): Promise<Check | null> {
  // #5452: sync refuses an archived source, so its failures cannot be cleared and are not a live health signal.
  const archived = new Set(engine ? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived = true')).map(row => row.id) : []);
  const allManaged = engine ? await readManagedSyncFailures(engine, opts.sourceIds) : [];
  let ledger: SyncFailure[] = [];
  try { ledger = loadSyncFailures().filter(row => !opts.sourceIds || opts.sourceIds.includes(row.source_id)); } catch { }
  // With an engine the durable rows are the authority and the mirror is ignored; without one (#6518 [R18 iii]) the
  // mirror rows are reported apart, as unverifiable, while unmanaged ledger failures keep their own severity.
  const allLegacy = ledger.filter(row => !row.managed_cursor_key);
  const mirrorRows = engine ? [] : ledger.filter(row => row.managed_cursor_key && (row.state === 'open' || row.state === 'auto_skipped'));
  const managed = allManaged.filter(row => !archived.has(row.source_id));
  const legacy = allLegacy.filter(row => !archived.has(row.source_id));
  const archivedCount = allManaged.length - managed.length + allLegacy.length - legacy.length;
  const archivedNote = archivedCount ? ` ${archivedCount} failure(s) on archived source(s) ignored; restore a source to retry them.` : '';
  const mirrorNote = mirrorRows.length ? ` ${MIRROR_UNVERIFIED(mirrorRows.length)}` : '';
  const entries: SyncFailure[] = [...legacy, ...managed.map(row => ({ source_id: row.source_id, path: row.path, code: row.code, error: row.message,
    commit: row.target ?? '', first_seen: row.first_seen, ts: row.first_seen, attempts: row.attempts, state: 'open' as const }))];
  const severity = decideSyncFailureSeverity({ entries, nowMs: Date.now(), failHours: resolveHoursEnv('GBRAIN_SYNC_FRESHNESS_FAIL_HOURS', 72) });
  // #5459/#6518 [R18 ii, iv]: bookkeeping nothing current can resume or clear is classified whenever the brain is reachable, not only
  // when a current-incarnation failure is visible; a failed classification is reported as unknown, never as "no orphans".
  let orphans: ManagedSyncOrphan[] = [], orphanReadError: string | null = null;
  if (engine) {
    try { orphans = (await classifyManagedSyncOrphans(engine, opts.sourceIds ?? null)).orphans; }
    catch (error) { orphanReadError = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : String(error)); }
  }
  const orphanSources = new Set(orphans.map(orphan => orphan.source_id));
  const repairArgv = ['gbrain', 'repair', 'managed-sync-orphans', ...(orphanSources.size === 1 ? ['--source', orphans[0]!.source_id] : [])];
  const repairPreview = repairArgv.join(' ');
  const orphanNoteFor = (lead: string) => orphans.length ? ` ${lead} (${orphans.map(orphan => `${orphan.source_id}:${orphan.cursor_key.slice(0, 12)} ${orphan.reason}`).join(', ')}) cannot be resumed or cleared by any sync: `
    + `preview ${repairPreview} and apply with the hash it prints (docs/guides/repair.md#managed-sync-orphans). Retiring them says nothing about whether the current source's files are imported; gbrain sync status --source <id> --json does.` : '';
  const orphanNote = orphanNoteFor(`${orphans.length} of these`);
  const orphanFix = orphans.length && opts.remote === false ? { fix: agentFix(repairArgv, 'Previews the sync bookkeeping no sync can resume or clear (with each row\'s class) and prints the apply command with its hash; writes nothing.', 'sync_failures',
    { docs: 'docs/guides/repair.md#managed-sync-orphans' }) } : {};
  const remoteOrphanNote = orphans.length ? ` ${orphans.length} managed sync bookkeeping row(s) cannot be resumed or cleared by any sync; ask the host operator to preview gbrain repair managed-sync-orphans.` : '';
  const unreadNote = orphanReadError ? ` The managed sync bookkeeping could not be classified (${orphanReadError}); this is not proof that none is orphaned. Run gbrain doctor --only sync_failures again with the brain reachable.` : '';
  if (!severity.unresolved) {
    if (orphans.length || orphanReadError) {
      const base = `${entries.length ? 'All historical sync failures are acknowledged.' : 'No current sync failures on active sources.'}`;
      return { name: 'sync_failures', status: 'warn', message: base + (opts.remote !== false ? remoteOrphanNote + unreadNote : orphanNoteFor(`${orphans.length} managed sync bookkeeping row(s)`) + unreadNote) + archivedNote,
        ...(opts.remote === false && orphans.length ? { details: { orphans } } : {}), ...orphanFix };
    }
    if (mirrorRows.length) return { name: 'sync_failures', status: 'warn', message: `No unresolved unmanaged sync failures.${mirrorNote}${archivedNote}` };
    return entries.length || archivedCount ? { name: 'sync_failures', status: 'ok', message: `${entries.length ? 'All historical sync failures are acknowledged.' : 'No sync failures on active sources.'}${archivedNote}` } : null;
  }
  const summary = `${severity.unresolved} unresolved sync failure(s)${severity.auto_skipped ? ` (${severity.auto_skipped} auto-skipped — pages NOT indexed)` : ''}.${archivedNote}`;
  if (opts.remote !== false) return { name: 'sync_failures', status: severity.status, message: summary + ' Ask the host operator to inspect doctor and repair the accepted sync; no paths or receipt details are exposed remotely.' + remoteOrphanNote + unreadNote + mirrorNote };
  // The `engine ?` tolerance is the doctor's: with no engine there is no managed retry to name; the read itself fails closed (#6482).
  const managedBrain = engine ? await readManagedMode(engine) : false;
  const requiresManagedRetry = managedBrain || managed.length > 0 || mirrorRows.length > 0;
  const details = managed.map(formatManagedSyncFailure);
  const unresolvedLegacy = unacknowledgedSyncFailures(legacy);
  details.push(...unresolvedLegacy.map(row => `${row.source_id}: ${row.path} (${row.code}: ${row.error})`));
  const remediation = requiresManagedRetry ? undefined : [makeRemediationStep({
    id: 'sync-retry-failed', job: 'sync-retry-failed', params: { failure_count: severity.unresolved,
      oldest_failure: unresolvedLegacy.map(row => row.ts).sort()[0] },
    severity: severity.status === 'fail' ? 'high' : 'medium', est_seconds: 30, est_usd_cost: 0,
    rationale: `Retry ${severity.unresolved} unresolved sync failure(s)` })];
  // #5459: a failure nothing current can resume or clear is named as an orphan with its repair, not as a retry that never clears.
  const orphanKeys = new Set(orphans.map(orphan => orphan.cursor_key));
  const resumable = managed.filter(row => !orphanKeys.has(row.cursor_key));
  const retries = [...new Set(resumable.map(row => managedSyncRetryCommand(row)))];
  const recovery = requiresManagedRetry
    ? `${resumable.length || !orphans.length ? `Fix the cause, then run ${retries.length ? retries.join(' ; ') : 'gbrain sync --no-pull with the same source and options (it retries the recorded failure)'}. Completed full runs do not resolve a different unfinished cursor.` : ''}${orphanNote}${unreadNote}`.trim()
    : `Fix the file(s) and re-run 'gbrain sync', or use 'gbrain sync --skip-failed' to acknowledge legacy file failures.${orphanNote}${unreadNote}`;
  const legacyNote = managedBrain ? legacyLedgerNote(unresolvedLegacy) : '';
  // #6712 PR 2 (L5): each managed failure with the classifier's category and the public category beside it.
  const failures = managed.map(row => {
    const v = classifyRecordedFault({ source_id: row.source_id, code: row.code, request_id: row.request_id, error_detail: row.write_error_detail ?? null, message: row.message });
    return { source_id: row.source_id, path: row.path, code: row.code, category: v.category, public_category: v.public_category, class: v.class, needs_human: v.needs_human };
  });
  return { name: 'sync_failures', status: severity.status, message: `${summary} ${details.join('; ')} ${recovery}${legacyNote}`,
    remediation, remediation_status: remediation ? 'remediable' : 'blocked', ...(orphans.length || failures.length ? { details: { ...(orphans.length ? { orphans } : {}), ...(failures.length ? { failures } : {}) } } : {}), ...orphanFix,
    ...(engine ? {} : { message: `${summary} Durable sync state is unavailable without a database connection; the local ledger is only a compatibility mirror.${mirrorNote}` }) };
}
