import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { loadSyncFailures, unacknowledgedSyncFailures, decideSyncFailureSeverity, type SyncFailure } from '../../../core/sync-failure-ledger.ts';
import { formatManagedSyncFailure, readManagedSyncFailures } from '../../../core/persistence/sync-failures.ts';
import { resolveHoursEnv } from '../../../core/env-number.ts';
import { makeRemediationStep } from '../../../core/remediation-step.ts';

export async function checkSyncFailures(engine: BrainEngine | null, opts: { sourceIds?: string[]; remote?: boolean } = {}): Promise<Check | null> {
  const managed = engine ? await readManagedSyncFailures(engine, opts.sourceIds) : [];
  let legacy: SyncFailure[] = [];
  try { legacy = loadSyncFailures().filter(row => (!engine || !row.managed_cursor_key) && (!opts.sourceIds || opts.sourceIds.includes(row.source_id))); } catch { }
  const entries: SyncFailure[] = [...legacy, ...managed.map(row => ({ source_id: row.source_id, path: row.path, code: row.code, error: row.message,
    commit: row.target ?? '', first_seen: row.first_seen, ts: row.first_seen, attempts: row.attempts, state: 'open' as const }))];
  const severity = decideSyncFailureSeverity({ entries, nowMs: Date.now(), failHours: resolveHoursEnv('GBRAIN_SYNC_FRESHNESS_FAIL_HOURS', 72) });
  if (!severity.unresolved) return entries.length ? { name: 'sync_failures', status: 'ok', message: 'All historical sync failures are acknowledged.' } : null;
  const summary = `${severity.unresolved} unresolved sync failure(s)${severity.auto_skipped ? ` (${severity.auto_skipped} auto-skipped — pages NOT indexed)` : ''}.`;
  if (opts.remote !== false) return { name: 'sync_failures', status: severity.status, message: summary + ' Ask the host operator to inspect doctor and repair the accepted sync; no paths or receipt details are exposed remotely.' };
  const [brain] = engine ? await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1') : [];
  const requiresManagedRetry = brain?.enabled || managed.length > 0 || legacy.some(row => row.managed_cursor_key);
  const details = managed.map(formatManagedSyncFailure);
  const unresolvedLegacy = unacknowledgedSyncFailures(legacy);
  details.push(...unresolvedLegacy.map(row => `${row.source_id}: ${row.path} (${row.code}: ${row.error})`));
  const remediation = requiresManagedRetry ? undefined : [makeRemediationStep({
    id: 'sync-retry-failed', job: 'sync-retry-failed', params: { failure_count: severity.unresolved,
      oldest_failure: unresolvedLegacy.map(row => row.ts).sort()[0] },
    severity: severity.status === 'fail' ? 'high' : 'medium', est_seconds: 30, est_usd_cost: 0,
    rationale: `Retry ${severity.unresolved} unresolved sync failure(s)` })];
  const recovery = requiresManagedRetry
    ? 'Fix the cause, then run gbrain sync --no-pull --retry-failed with the same source and options. Completed full runs do not resolve a different unfinished cursor.'
    : "Fix the file(s) and re-run 'gbrain sync', or use 'gbrain sync --skip-failed' to acknowledge legacy file failures.";
  return { name: 'sync_failures', status: severity.status, message: `${summary} ${details.join('; ')} ${recovery}`,
    remediation, remediation_status: remediation ? 'remediable' : 'blocked', ...(engine ? {} : { message: `${summary} Durable sync state is unavailable without a database connection; the local ledger is only a compatibility mirror.` }) };
}
