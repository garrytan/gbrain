import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { assertRecoveryStagingAbsent } from './staging.ts';
import { OperationError } from '../ops/contract.ts';
import { digest, jsonBytes, requireUuid } from './digest.ts';
import { authorizeWrite } from './authority.ts';
import { readJournalLimits } from './limits.ts';
import { retryWriteAdmission } from './admission-retry.ts';
import {
  isTerminal, principalKey, requestPrincipal,
  type JournalLimits, type Principal, type RecoveryRecord, type RequestState,
  type SqlEngine, type WriteAuthority, type WriteRequest,
} from './model.ts';

export interface WriteAdmission {
  principal: Principal;
  operation: string;
  sourceId: string;
  sourceIncarnation: string;
  slug: string;
  pageId?: number | null;
  worktreeId?: string | null;
  topologyGeneration?: string | number | null;
  requestId?: string;
  /** Normalized caller intent, excluding server-generated timestamp/TTL defaults. */
  callerIntent: Record<string, unknown>;
  intent: Record<string, unknown>;
  authority: WriteAuthority;
  terminalReservation?: number;
}
interface Counter {
  key: string; outstanding_count: number | string; intent_bytes: number | string;
  lifetime_ids: number | string; terminal_bytes: number | string; recovery_bytes: number | string;
}
export function capacityError(resource: string): OperationError {
  return new OperationError('queue_capacity', `Write capacity exhausted: ${resource}.`,
    'Inspect writer status and configured persistence limits. Existing requests retain their reserved completion space.');
}
export async function lockCounters(tx: SqlEngine, keys: string[]): Promise<Counter[]> {
  const sorted = [...new Set(keys)].sort();
  for (const key of sorted) await tx.executeRaw('INSERT INTO persistence_counters(key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
  const result: Counter[] = [];
  for (const key of sorted) {
    const [row] = await tx.executeRaw<Counter>('SELECT * FROM persistence_counters WHERE key=$1 FOR UPDATE', [key]);
    result.push(row);
  }
  return result;
}
export async function getWriteRequest(engine: SqlEngine, principal: Principal, requestId: string): Promise<WriteRequest | null> {
  const [row] = await engine.executeRaw<WriteRequest>(
    'SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
    [principal.kind, principal.id, requireUuid(requestId)]);
  return row ?? null;
}
/** Resolve other operation domains before repeating target/provider preparation. */
export async function assertPageRequestIdentity(engine: SqlEngine, principal: Principal, requestId: string): Promise<void> {
  if (principal.kind !== 'local_cli') return;
  const [topology] = await engine.executeRaw('SELECT id FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=$2::uuid',
    [principal.id, requireUuid(requestId)]);
  if (topology) throw new OperationError('idempotency_conflict', 'This request_id belongs to a source lifecycle operation.');
}
export async function getWriteRequestById(engine: SqlEngine, id: string): Promise<WriteRequest | null> {
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [id]);
  return row ?? null;
}
export function intentDigest(a: Pick<WriteAdmission, 'operation' | 'sourceId' | 'slug' | 'callerIntent'>): string {
  return digest({ operation: a.operation, source_id: a.sourceId, slug: a.slug, intent: a.callerIntent });
}
export function assertReplayIntent(row: WriteRequest, expectedDigest: string): WriteRequest {
  if (row.digest !== expectedDigest) throw new OperationError('idempotency_conflict',
    'This request_id was already accepted with different intent.', 'Replay the original request, or allocate a new request_id for a new intent.');
  return row;
}
export async function admitWrite(engine: BrainEngine, input: WriteAdmission, overrides?: Partial<JournalLimits>): Promise<WriteRequest> {
  const { requestId, apply } = await prepareAdmission(engine, input, overrides);
  return retryWriteAdmission(requestId, remaining => engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [`${Math.min(1000, remaining)}ms`, `${remaining}ms`]);
    return apply(tx);
  }));
}
/** Caller owns the transaction and retries its entire unit of work after rollback. */
export async function admitWriteInTransaction(tx: BrainEngine, input: WriteAdmission, overrides?: Partial<JournalLimits>): Promise<WriteRequest> {
  return (await prepareAdmission(tx, input, overrides)).apply(tx);
}
async function prepareAdmission(engine: BrainEngine, input: WriteAdmission, overrides?: Partial<JournalLimits>) {
  const limits = await readJournalLimits(engine,overrides);
  const requestId = requireUuid(input.requestId ?? randomUUID());
  const fingerprint = intentDigest(input);
  const bytes = jsonBytes(input.intent) + jsonBytes(input.authority);
  const terminalBytes = input.terminalReservation ?? Math.max(16_384,jsonBytes(input.authority)+8192);
  if (!Number.isSafeInteger(terminalBytes) || terminalBytes < 1024) throw new TypeError('Invalid terminal receipt reservation.');
  return { requestId, apply: async (tx: BrainEngine): Promise<WriteRequest> => {
    if (input.worktreeId) {
      await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [input.worktreeId]);
      const binding = await tx.executeRaw(`SELECT source_id FROM persistence_source_bindings WHERE source_id=$1
        AND source_incarnation=$2::uuid AND worktree_id=$3::uuid AND topology_generation=$4`,
      [input.sourceId, input.sourceIncarnation, input.worktreeId, input.topologyGeneration]);
      if (!binding.length) throw new OperationError('source_changed', 'The source binding changed during admission.');
    }
    // Source membership is locked before principal/counter/request guards. A
    // deleted/recreated source never receives work accepted for its old identity.
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>(
      'SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [input.sourceId]);
    if (!source || source.archived || source.incarnation !== input.sourceIncarnation) {
      throw new OperationError('source_changed', 'The write source is missing, archived, or was replaced.', 'Resolve the source again and submit a new request.');
    }
    await authorizeWrite(tx, input.authority, input.operation, input.slug, true);
    const counters = await lockCounters(tx, ['brain', principalKey(input.principal)]);
    if(input.principal.kind==='local_cli') {
      const topology=await tx.executeRaw('SELECT id FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=$2::uuid',[input.principal.id,requestId]);
      if(topology.length) throw new OperationError('idempotency_conflict','This request_id belongs to a source lifecycle operation.');
    }
    const prior = await getWriteRequest(tx, input.principal, requestId);
    if (prior) return assertReplayIntent(prior, fingerprint);
    for (const row of counters) {
      const brain = row.key === 'brain';
      if (Number(row.outstanding_count) + 1 > (brain ? limits.brainOutstanding : limits.principalOutstanding)) throw capacityError(`${brain ? 'brain' : 'principal'} outstanding requests`);
      if (Number(row.intent_bytes) + bytes > (brain ? limits.brainIntentBytes : limits.principalIntentBytes)) throw capacityError(`${brain ? 'brain' : 'principal'} intent bytes`);
      if (Number(row.lifetime_ids) + 1 > (brain ? limits.brainLifetimeIds : limits.principalLifetimeIds)) throw capacityError(`${brain ? 'brain' : 'principal'} permanent request IDs; raise the quota to retain replay protection`);
      if (Number(row.terminal_bytes) + terminalBytes > (brain ? limits.brainTerminalBytes : limits.principalTerminalBytes)) throw capacityError(`${brain ? 'brain' : 'principal'} reserved receipt bytes`);
    }
    const [row] = await tx.executeRaw<WriteRequest>(`INSERT INTO persistence_requests
      (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,page_id,slug,
       worktree_id,topology_generation,digest,intent,authority,intent_bytes,terminal_reservation)
      VALUES($1,$2,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::uuid,$10,$11,$12::text::jsonb,$13::text::jsonb,$14,$15)
      RETURNING *`, [input.principal.kind, input.principal.id, requestId, input.operation, input.sourceId,
      input.sourceIncarnation, input.pageId ?? null, input.slug, input.worktreeId ?? null, input.topologyGeneration ?? null,
      fingerprint, JSON.stringify(input.intent), JSON.stringify(input.authority), bytes, terminalBytes]);
    for (const c of counters) await tx.executeRaw(`UPDATE persistence_counters SET outstanding_count=outstanding_count+1,
      intent_bytes=intent_bytes+$2,lifetime_ids=lifetime_ids+1,terminal_bytes=terminal_bytes+$3 WHERE key=$1`, [c.key, bytes, terminalBytes]);
    return row;
  } };
}

/** Claims commit before OS-lock waits. An unresolved head blocks its entire root. */
export async function claimNextWrite(engine: BrainEngine, hostId: string, leaseMs = 30_000, excludeRoots: string[] = []): Promise<WriteRequest | null> {
  return engine.transactionDirect(async tx => {
    const [row] = await tx.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE r.state='queued' AND (r.worktree_id IS NULL OR (w.owner_host_id=$1::uuid AND w.state='active'))
      AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($2::text[]))
      AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE COALESCE(earlier.worktree_id::text,'db:'||earlier.source_incarnation::text)
              =COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)
        AND earlier.sequence<r.sequence AND earlier.state IN ('queued','running','recovering'))
      ORDER BY r.sequence LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, [hostId, excludeRoots]);
    if (!row) return null;
    const [claimed] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',
      execution_token=$2::uuid,claim_expires_at=now()+($3::double precision*interval '1 millisecond'),
      updated_at=now(),blocked_reason=NULL WHERE id=$1::uuid RETURNING *`, [row.id, randomUUID(), leaseMs]);
    return claimed;
  });
}
export async function renewWriteClaim(engine: SqlEngine, id: string, token: string, leaseMs = 30_000): Promise<boolean> {
  const rows = await engine.executeRaw(`UPDATE persistence_requests SET
    claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' RETURNING id`, [id, token, leaseMs]);
  return rows.length === 1;
}
export async function releaseUnpublishedClaim(engine: SqlEngine, row: WriteRequest, reason: string): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    blocked_reason=$3,updated_at=now() WHERE id=$1::uuid AND execution_token=$2::uuid
    AND state='running' AND recovery IS NULL AND publication_started=false`, [row.id, row.execution_token, reason]);
}

/** Called while holding the root lock; the durable record precedes any rename. */
export async function prepareRecovery(engine: BrainEngine, row: WriteRequest, recovery: RecoveryRecord, bytes: number,
  overrides?: Partial<JournalLimits>): Promise<void> {
  const limits = await readJournalLimits(engine,overrides);
  if (!row.worktree_id) throw new TypeError('Filesystem recovery requires a worktree.');
  if (bytes > limits.worktreeRecoveryBytes || bytes > limits.brainRecoveryBytes) throw new OperationError('request_too_large', 'This request exceeds the configured recovery capacity.', 'Increase recovery capacity before submitting a new request.');
  await engine.transaction(async tx => {
    // A crash after rename must never lose the earlier recovery reservation,
    // even when the deployment defaults ordinary transactions to async commit.
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    const counters = await lockCounters(tx, ['brain', `worktree:${row.worktree_id}`]);
    const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
    if (!current || current.execution_token !== row.execution_token || current.state !== 'running') throw new OperationError('write_claim_lost', 'The write execution claim was superseded.');
    if (current.recovery) {
      if (digest(current.recovery) !== digest(recovery)) throw new OperationError('recovery_required', 'An existing publication must be recovered before preparing another.');
      return;
    }
    for (const c of counters) if (Number(c.recovery_bytes) + bytes > (c.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes)) throw capacityError('recovery bytes currently reserved by other requests');
    await tx.executeRaw(`UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4,updated_at=now()
      WHERE id=$1::uuid AND execution_token=$2::uuid`, [row.id, row.execution_token, JSON.stringify(recovery), bytes]);
    for (const c of counters) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=$1', [c.key, bytes]);
  });
}

/** In the SAME transaction as page publication. Counters are always before request locks. */
export async function completeWrite(tx: SqlEngine, row: WriteRequest, state: 'committed' | 'conflict' | 'failed' | 'cancelled',
  outcome: Record<string, unknown>, error?: { code: string; message: string }): Promise<WriteRequest> {
  // Every acknowledged terminal state survives a crash, including cancellation
  // and pre-publication failures that do not enter the file coordinator.
  await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
  const keys = ['brain', principalKey(requestPrincipal(row)), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])];
  await lockCounters(tx, keys);
  const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
  if (!current) throw new OperationError('not_found', 'Write request not found.');
  if (isTerminal(current)) return current;
  if (row.execution_token !== current.execution_token) throw new OperationError('write_claim_lost', 'Write claim changed before completion.');
  const [effects] = await tx.executeRaw<{bytes:string}>(`SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0)::text AS bytes
    FROM persistence_effects WHERE request_id=$1::uuid`,[row.id]);
  if (jsonBytes(outcome) + jsonBytes(current.authority) + 1024 + Buffer.byteLength(error?.message ?? '') + Number(effects.bytes) > Number(current.terminal_reservation)) throw capacityError('terminal result and effects exceed their reserved bounded encoding');
  const [done] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state=$2,outcome=$3::text::jsonb,
    error_code=$4,error_message=$5,completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL
    WHERE id=$1::uuid RETURNING *`, [row.id, state, JSON.stringify(outcome), error?.code ?? null, error?.message ?? null]);
  for (const key of ['brain', principalKey(requestPrincipal(row))]) await tx.executeRaw(`UPDATE persistence_counters
    SET outstanding_count=outstanding_count-1,intent_bytes=intent_bytes-$2 WHERE key=$1`, [key, Number(current.intent_bytes)]);
  // Recovery bytes remain reserved until physical cleanup has been verified.
  return done;
}

export async function clearResolvedRecovery(engine: BrainEngine, id: string): Promise<void> {
  const row = await getWriteRequestById(engine, id);
  if (!row?.recovery || !isTerminal(row)) return;
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    const keys = ['brain', ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])];
    await lockCounters(tx, keys);
    const [locked] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [id]);
    if (!locked?.recovery || !isTerminal(locked)) return;
    assertRecoveryStagingAbsent(locked.recovery);
    for (const key of keys) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$2 WHERE key=$1', [key, Number(locked.recovery_bytes)]);
    await tx.executeRaw('UPDATE persistence_requests SET recovery=NULL,recovery_bytes=0,blocked_reason=NULL WHERE id=$1::uuid', [id]);
  });
}
export async function markRecovering(engine: SqlEngine, row: WriteRequest, reason: string, failure?: {code:string;message:string}): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_requests SET state='recovering',blocked_reason=$3,updated_at=now(),
    error_code=COALESCE(error_code,$4),error_message=COALESCE(error_message,$5)
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state IN ('running','recovering')`, [row.id, row.execution_token, reason, failure?.code ?? null, failure?.message ?? null]);
}
export async function compactWriteReceipts(engine: BrainEngine, retentionDays = 30): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new TypeError('Invalid receipt retention.');
  const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests
    WHERE state IN ('committed','conflict','failed','cancelled') AND recovery IS NULL AND NOT compacted
    AND completed_at < now()-($1::double precision*interval '1 day') ORDER BY sequence LIMIT 100`, [retentionDays]);
  let count=0;
  for(const row of rows) count+=await engine.transaction(async tx=>{
    const keys=['brain',principalKey(requestPrincipal(row))];
    await lockCounters(tx,keys);
    const [current]=await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE',[row.id]);
    if(!current || current.compacted || current.recovery || !isTerminal(current)) return 0;
    const unfinished=await tx.executeRaw("SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid AND state<>'committed' LIMIT 1",[row.id]);
    if(unfinished.length) return 0;
    const [effects]=await tx.executeRaw<{bytes:string}>(`SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0)::text AS bytes
      FROM persistence_effects WHERE request_id=$1::uuid`,[row.id]);
    const retained=Math.min(Number(current.terminal_reservation),jsonBytes(current.authority)+jsonBytes(current.outcome??{})+Number(effects.bytes)+1024);
    await tx.executeRaw('UPDATE persistence_requests SET intent=NULL,compacted=true,error_message=NULL,terminal_reservation=$2 WHERE id=$1::uuid',[row.id,retained]);
    for(const key of keys) await tx.executeRaw('UPDATE persistence_counters SET terminal_bytes=terminal_bytes-$2 WHERE key=$1',[key,Number(current.terminal_reservation)-retained]);
    return 1;
  });
  return count;
}
export function receiptFor(row: WriteRequest) {
  return {
    ...(row.outcome ?? {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    request_id: row.request_id, state: row.state,
    retry_after_ms: isTerminal(row) ? null : 1000,
    ...(row.error_code ? { write_error: row.error_code } : {}),
    ...(row.blocked_reason ? { blocked_reason: row.blocked_reason } : {}),
    ...(row.compacted ? { compacted: true } : {}),
    created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
  };
}
