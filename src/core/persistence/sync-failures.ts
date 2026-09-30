import type { BrainEngine } from '../engine.ts';
import { mirrorManagedSyncFailure, clearManagedSyncFailure } from '../sync-failure-ledger.ts';
import type { WriteRequest } from './model.ts';

export interface ManagedSyncFailure {
  source_id: string;
  source_incarnation: string;
  path: string;
  code: string;
  message: string;
  request_id: string | null;
  run_id: string;
  target: string | null;
  cursor_key: string;
  phase: 'discovery' | 'freeze' | 'admission' | 'receipt' | 'checkpoint' | 'resume';
  state: string;
  observation_id: string;
  first_seen: string;
  attempts: number;
}

export async function recordManagedSyncFailure(engine: BrainEngine, value: Omit<ManagedSyncFailure, 'first_seen' | 'attempts'> & { first_seen?: string }): Promise<{ failure: ManagedSyncFailure; ledgerRecorded: boolean }> {
  const failure = { ...value, first_seen: value.first_seen ?? new Date().toISOString(), attempts: 1 };
  const recorded = await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    const [row] = await tx.executeRaw<{ completed_keys: [ManagedSyncFailure] }>(`
      INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-failure',$1,$2::text::jsonb)
      ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=CASE
        WHEN op_checkpoints.completed_keys->0->>'observation_id'=EXCLUDED.completed_keys->0->>'observation_id'
        THEN op_checkpoints.completed_keys ELSE jsonb_build_array(EXCLUDED.completed_keys->0 || jsonb_build_object(
          'first_seen',op_checkpoints.completed_keys->0->>'first_seen',
          'attempts',COALESCE((op_checkpoints.completed_keys->0->>'attempts')::int,0)+1)) END
      RETURNING completed_keys`, [value.cursor_key, JSON.stringify([failure])]);
    return row.completed_keys[0];
  });
  let ledgerRecorded = false;
  try {
    mirrorManagedSyncFailure({ ...recorded, message: formatManagedSyncFailure(recorded) });
    ledgerRecorded = true;
  } catch { }
  return { failure: recorded, ledgerRecorded };
}

export async function clearManagedSyncFailureAfterSuccess(engine: BrainEngine, key: string): Promise<void> {
  const removed = await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1
    AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=$1 AND COALESCE(c.completed_keys->0->>'done','false')<>'true') RETURNING fingerprint`, [key]);
  if (removed.length) try { clearManagedSyncFailure(key); } catch { }
}

export async function readManagedSyncFailures(engine: BrainEngine, sourceIds?: string[]): Promise<ManagedSyncFailure[]> {
  const rows = await engine.executeRaw<{ cursor_key: string; value: { sourceId: string; incarnation: string; runId: string; index: number; target: string; pending?: { requestId: string } };
    receipt: Pick<WriteRequest, 'state' | 'request_id' | 'error_code' | 'error_message'> | null; failure: ManagedSyncFailure | null; path: string | null; updated_at: string }>(`
    SELECT c.fingerprint AS cursor_key,jsonb_build_object('sourceId',s.id,'incarnation',s.incarnation,'runId',c.completed_keys->0->>'runId',
      'index',c.completed_keys->0->'index','target',c.completed_keys->0->>'target',
      'pending',jsonb_build_object('requestId',c.completed_keys->0->'pending'->>'requestId')) AS value,
      CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('state',r.state,'request_id',r.request_id,'error_code',r.error_code,'error_message',r.error_message) END AS receipt,
      f.completed_keys->0 AS failure,m.completed_keys->((c.completed_keys->0->>'index')::int)->>'path' AS path,c.updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation'
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    LEFT JOIN op_checkpoints f ON f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint
    LEFT JOIN op_checkpoints m ON m.op='managed-sync-manifest' AND m.fingerprint=c.completed_keys->0->>'runId'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))`, [sourceIds ?? null]);
  const failures: ManagedSyncFailure[] = rows.map(row => {
    const c = row.value, r = row.receipt;
    if (row.failure && (!r || !['failed', 'conflict', 'cancelled'].includes(r.state) || row.failure.request_id === r.request_id)) return row.failure;
    return { source_id: c.sourceId, source_incarnation: c.incarnation, path: row.path ?? '<checkpoint>', code: r?.error_code ?? 'sync_incomplete',
      message: r?.error_message ?? 'The durable sync cursor is unfinished; resume the accepted run.', request_id: c.pending?.requestId ?? null,
      run_id: c.runId, target: c.target, cursor_key: row.cursor_key, phase: r ? 'receipt' : 'resume', state: r?.state ?? 'unfinished',
      observation_id: c.pending?.requestId ?? `${c.runId}:${c.index}`, first_seen: new Date(row.updated_at).toISOString(), attempts: 1 };
  });
  const orphaned = await engine.executeRaw<{ failure: ManagedSyncFailure }>(`
    SELECT f.completed_keys->0 AS failure FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation'
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint)`, [sourceIds ?? null]);
  return [...failures, ...orphaned.map(row => row.failure)];
}

export function formatManagedSyncFailure(failure: ManagedSyncFailure): string {
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1000);
  return `source=${clean(failure.source_id)} path=${clean(failure.path)} code=${clean(failure.code)}: ${clean(failure.message)} request=${failure.request_id ?? '<not-admitted>'} run=${failure.run_id} target=${failure.target ?? '<undiscovered>'}`;
}

export function syncFailureJsonFields(result: { failedFiles?: number; failureCodes?: Array<{ code: string; count: number }>; failures?: ManagedSyncFailure[]; runId?: string; fromCommit?: string | null; toCommit?: string; bankedFiles?: number }): Record<string, unknown> {
  return { ...(result.failedFiles !== undefined ? { failed_files: result.failedFiles } : {}),
    ...(result.failureCodes ? { failure_codes: result.failureCodes } : {}), ...(result.failures ? { failures: result.failures } : {}),
    ...(result.runId ? { run_id: result.runId, from_commit: result.fromCommit, target_commit: result.toCommit, banked_files: result.bankedFiles, counts_scope: 'run_cumulative' } : {}) };
}
