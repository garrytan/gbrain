/**
 * Wave B PR 4 (lane 4a): doctor `derivation_purge_sweeps`. A fact purge records a sweep of the stored derivation
 * results holding its claim and deletes them after it commits (segment-derive.ts continueDerivationPurges). While a
 * sweep is recorded, paid synopsis and fact extraction makes no call on the pages it covers (receipts say
 * `purge_sweep_pending`), so a sweep left pending or stalled holds that work back. This check names each one with its
 * purge request id and the command that continues it.
 */
import type { Check } from '../../doctor.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const SAMPLE = 20;

/** The command that continues the sweep of purge request `requestId` (the id the purge printed). */
export const continueSweepArgv = (requestId: string): string[] => ['gbrain', 'forget', '--purge', '--status', '--request-id', requestId, '--continue'];

async function runDerivationPurgeSweeps(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  let rows: Array<{ request_id: string | null; source_id: string; stalled: boolean; reason: string | null; pending_reason: string | null; created_at: string }>;
  try {
    rows = await connectedEngine(ctx).executeRaw(`SELECT r.request_id::text AS request_id, x.source_id, x.stalled_at IS NOT NULL AS stalled, x.stalled_reason AS reason, x.pending_reason,
        x.created_at::text AS created_at
      FROM page_segment_derivation_purges x LEFT JOIN persistence_requests r ON r.id = x.request_id ORDER BY x.created_at, x.request_id`);
  } catch (error) {
    checks.push(checkError('derivation_purge_sweeps', 'read the recorded derivation sweeps', error));
    return checks;
  }
  if (!rows.length) {
    checks.push({ name: 'derivation_purge_sweeps', status: 'ok', message: 'No fact purge has a sweep of stored derivation results pending or stalled.', details: { sweeps: 0 } });
    return checks;
  }
  const sweeps = rows.slice(0, SAMPLE).map(row => ({ request_id: row.request_id, source_id: row.source_id, state: row.stalled ? 'stalled' : 'pending',
    ...(row.stalled ? { reason: row.reason ?? 'statement_timeout' } : row.pending_reason ? { reason: row.pending_reason } : {}), created_at: row.created_at,
    ...(row.request_id ? { command: continueSweepArgv(row.request_id).join(' ') } : {}) }));
  const listed = sweeps.map(s => `${s.request_id ?? '(request missing)'} in source ${s.source_id} (${s.state}${s.reason ? `, ${s.reason}` : ''})`).join(', ');
  const first = sweeps.find(s => s.request_id)?.request_id;
  const busy = sweeps.some(s => s.reason === 'scope_lock_busy');
  checks.push({
    name: 'derivation_purge_sweeps', status: 'warn', details: { sweeps: rows.length, truncated: rows.length > sweeps.length, records: sweeps },
    message: `${rows.length} fact purge sweep(s) of stored derivation results are not finished: ${listed}${rows.length > sweeps.length ? ` (first ${sweeps.length} of ${rows.length} shown)` : ''}. `
      + 'Until each ends, paid synopsis and fact extraction makes no call on the pages it covers (purge_sweep_pending). '
      + (busy ? 'A sweep marked scope_lock_busy has walked to its end and waits only for a write in its source that is still open (an import, sync or page edit): let that write finish, then continue it. ' : '')
      + `Continue each with gbrain forget --purge --status --request-id <request_id> --continue.`,
    ...(first ? { fix: { argv: continueSweepArgv(first), consent: [], actor: 'agent' as const, requires_exclusive: false, verify: doctorVerify('derivation_purge_sweeps'),
      why: 'Continues the purge\'s sweep (a stalled one is tried again) and reports its completion. It deletes the stored results in the sweep\'s scope that hold the claim the user already purged, and an unpaid result in that scope that alone cannot be read within the statement budget, unread, whether or not it holds the claim (unpaid results are derived again from the page at no cost; a paid one is never deleted unread). Run it for each request id listed until its completion is complete.' } }
      : { fix_unavailable_reason: 'operator_judgement' as const }),
  });
  return checks;
}

export const derivationPurgeSweepsEntry: DoctorEntry = { name: 'derivation_purge_sweeps', emits: ['derivation_purge_sweeps'], run: runDerivationPurgeSweeps };
