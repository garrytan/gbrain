/**
 * managed_sync_blocked (#6858 ask 3): a source whose managed sync run stopped on a recorded failure (or a page receipt
 * that did not commit) and has stayed stopped for longer than `MANAGED_SYNC_BLOCKED_FAIL_MS` fails the check. The run
 * resumes nothing by itself while it is blocked, so the source stops indexing even though every freshness sync job and
 * the other sources look healthy (#6858: one source stopped 21 h while every job reported `completed`). A run blocked
 * for less than the threshold warns. Reads the durable cursor and failure rows only; names sources, codes and ages, never
 * paths or receipt text.
 * #6712 PR 4b: a non-company source's passes that keep stopping (`blocked`, a `not_converged` or `settle_mismatch`
 * streak) count too, aged from when they started stopping (`readBlockedManagedSyncs`).
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { MANAGED_SYNC_BLOCKED_FAIL_MS, readBlockedManagedSyncs } from '../../../core/persistence/sync-blocked.ts';
import { agentFix, checkError } from '../check-fix.ts';

const DOCS = 'docs/guides/troubleshooting.md#managed-sync-blocked';

async function runManagedSyncBlockedCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const blocked = await readBlockedManagedSyncs(connectedEngine(ctx), doctorSourceIds(ctx));
    if (!blocked.length) {
      checks.push({ name: 'managed_sync_blocked', status: 'ok', message: 'No managed sync run is blocked.' });
      return checks;
    }
    const now = Date.now();
    const over = blocked.filter(b => now - Date.parse(b.blocked_since) > MANAGED_SYNC_BLOCKED_FAIL_MS);
    const first = over[0] ?? blocked[0]!;
    const minutes = (since: string) => Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
    const list = blocked.map(b => `${b.source_id} (${b.code}, blocked ${minutes(b.blocked_since)} min)`).join('; ');
    checks.push({ name: 'managed_sync_blocked', status: over.length ? 'fail' : 'warn', readiness_state: 'degraded',
      details: { threshold_ms: MANAGED_SYNC_BLOCKED_FAIL_MS, sources: blocked.map(b => ({ ...b, blocked_minutes: minutes(b.blocked_since) })), docs: DOCS },
      message: `${list}: the managed sync run is stopped on a page that did not commit, or its passes keep stopping without converging, so the source indexes nothing new until it is cleared`
        + `${over.length ? ` (over the ${MANAGED_SYNC_BLOCKED_FAIL_MS / 60_000} min threshold)` : ''}. Freshness sync jobs for the source end dead with the run's next step instead of completed.`,
      fix: agentFix(['gbrain', 'sync', 'status', '--source', first.source_id, '--json'],
        'Read-only: names the page the run stopped on, its fault class and the next step (a hold to reconcile, a repair to preview, or the resume command).',
        'managed_sync_blocked', { docs: DOCS }) });
  } catch (error) {
    checks.push(checkError('managed_sync_blocked', 'read blocked managed sync runs', error, { details: { health: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const managedSyncBlockedEntry: DoctorEntry = { name: 'managed_sync_blocked', emits: ['managed_sync_blocked'], run: runManagedSyncBlockedCheck };
