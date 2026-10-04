import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { assertRecoveryStagingAbsent } from './staging.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { digest, jsonBytes, requireUuid } from './digest.ts';
import { authorizeWrite } from './authority.ts';
import { journalLimitKey, oneYearCapacity, readJournalLimits, readReceiptRetentionDays } from './limits.ts';
import { retryWriteAdmission } from './admission-retry.ts';
import { writeHealth, type WriteHealthFacts } from './health.ts';
import { writerStamp } from './writer-versions.ts';
import { publicFailureDetail } from './publication-failure.ts';
import { catalogueError } from '../error-catalogue.ts';
import { ACTIVE_REFRESH_STATES_SQL, refreshFenceClear } from './worktree-refresh-schema.ts';
import { assertMutationProtocol, assertSharedSkillPersistence, declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import {
  isTerminal, principalKey, requestPrincipal, recoveryFiles,
  type JournalLimits, type Principal, type RecoveryRecord, type RequestState,
  type SqlEngine, type WriteAuthority, type WriteRequest,
} from './model.ts';

export interface WriteAdmission {
  principal: Principal;
  operation: string;
  targetKind?: 'page' | 'skill_bundle';
  protocolVersion?: 1 | 2;
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
/** Read-only: the receipt itself for the local CLI writer's own request; another principal's request is inspected on the owner. */
function requestInspectFix(row: Pick<WriteRequest, 'request_id' | 'source_id' | 'principal_kind'>): Action {
  return row.principal_kind === 'local_cli'
    ? readFix(`Reads request ${row.request_id}'s durable receipt: its state, outcome and recorded error, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] })
    : ownerStatusFix(row.source_id);
}
function ownerStatusFix(sourceId: string): Action {
  return readFix(`Shows source ${sourceId}'s owner and every pending, running or recovering request, read-only.`,
    { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
}
const lifecycleIdConflict = (requestId: string) => opError('idempotency_conflict', 'This request_id belongs to a source lifecycle operation.',
  `Request ID ${requestId} is already recorded for a source lifecycle change of this CLI writer, so this page write was not admitted and nothing changed. Submit the page write with a new request_id.`);
export function capacityError(resource: string): OperationError {
  return new OperationError('queue_capacity', `Write capacity exhausted: ${resource}.`,
    'Inspect writer status and configured persistence limits. Existing requests retain their reserved completion space.');
}
/** Cumulative caps name their config key and a value that covers one more year at the current admission rate. */
async function cumulativeCapacityError(tx: SqlEngine, resource: string, scope: string, setting: keyof JournalLimits, used: number, limit: number): Promise<OperationError> {
  const key = journalLimitKey(setting);
  const value = await oneYearCapacity(tx, scope, setting.endsWith('LifetimeIds') ? 'LifetimeIds' : 'TerminalBytes', used, limit);
  const error = new OperationError('queue_capacity', `Write capacity exhausted: ${resource} (${used} used of ${limit}).`,
    `Run on the brain host: gbrain config set ${key} ${value} (covers about one more year at the current admission rate). ` +
    'Keep the same request_id and retry after the change. Accepted request IDs and retained receipts are never evicted.');
  error.detail = key.slice('persistence.limits.'.length);
  return error;
}
/**
 * Up-front refusal for a backfill that will admit `needed` new requests: when
 * the brain's or the principal's permanent request IDs cannot cover them, it
 * refuses with the same filled capacity command an admission would, before
 * the caller mutates anything.
 */
export async function assertLifetimeIdHeadroom(engine: SqlEngine, principal: Principal, needed: number): Promise<void> {
  if (needed <= 0) return;
  const limits = await readJournalLimits(engine);
  const keys = ['brain', principalKey(principal)];
  const rows = await engine.executeRaw<{ key: string; lifetime_ids: number | string }>(
    'SELECT key,lifetime_ids FROM persistence_counters WHERE key=ANY($1::text[])', [keys]);
  for (const key of keys) {
    const scope = key === 'brain' ? 'brain' : 'principal';
    const used = Number(rows.find(row => row.key === key)?.lifetime_ids ?? 0);
    const limit = limits[`${scope}LifetimeIds`];
    if (used + needed > limit) throw await cumulativeCapacityError(engine, `${scope} permanent request IDs`, key, `${scope}LifetimeIds`, used, limit);
  }
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
  if (topology) throw lifecycleIdConflict(requestId);
}
export async function getWriteRequestById(engine: SqlEngine, id: string, signal?: AbortSignal): Promise<WriteRequest | null> {
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [id], { signal });
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
      [`${Math.min(100, remaining)}ms`, `${remaining}ms`]);
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
  const stamp = writerStamp();
  return { requestId, apply: async (tx: BrainEngine): Promise<WriteRequest> => {
    await declarePersistenceProtocol(tx);
    assertMutationProtocol({ target_kind: input.targetKind, protocol_version: input.protocolVersion });
    if (input.worktreeId) {
      await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [input.worktreeId]);
      await assertWorktreeNotRefreshing(tx, input);
      const binding = await tx.executeRaw(`SELECT source_id FROM persistence_source_bindings WHERE source_id=$1
        AND source_incarnation=$2::uuid AND worktree_id=$3::uuid AND topology_generation=$4`,
      [input.sourceId, input.sourceIncarnation, input.worktreeId, input.topologyGeneration]);
      if (!binding.length) throw opError('source_changed', 'The source binding changed during admission.',
        `Source ${input.sourceId}'s worktree binding changed (a claim, transfer or lifecycle change) while this write was being admitted, so nothing was accepted. Check the owner with the command in fix, then submit the write again; reusing the same request_id is safe because nothing was recorded.`,
        { fix: ownerStatusFix(input.sourceId) });
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
      if(topology.length) throw lifecycleIdConflict(requestId);
    }
    const prior = await getWriteRequest(tx, input.principal, requestId);
    if (prior) {
      if ((prior.target_kind ?? 'page') !== (input.targetKind ?? 'page') || (prior.protocol_version ?? 1) !== (input.protocolVersion ?? 1)) {
        throw opError('idempotency_conflict', 'This request_id belongs to a different mutation target or protocol.',
          `Request ID ${requestId} was already accepted for a ${prior.target_kind ?? 'page'} write (protocol ${prior.protocol_version ?? 1}), so this ${input.targetKind ?? 'page'} write was not admitted. Read the original request${prior.principal_kind === 'local_cli' ? ' with the command in fix' : ' with get_write_request'} if you meant to replay it; otherwise submit this write with a new request_id.`,
          prior.principal_kind === 'local_cli' ? { fix: requestInspectFix(prior) } : {});
      }
      return assertReplayIntent(prior, fingerprint);
    }
    if (input.targetKind === 'skill_bundle') await assertSharedSkillPersistence(tx, input.sourceId);
    for (const row of counters) {
      const brain = row.key === 'brain';
      if (Number(row.outstanding_count) + 1 > (brain ? limits.brainOutstanding : limits.principalOutstanding)) throw capacityError(`${brain ? 'brain' : 'principal'} outstanding requests`);
      if (Number(row.intent_bytes) + bytes > (brain ? limits.brainIntentBytes : limits.principalIntentBytes)) throw capacityError(`${brain ? 'brain' : 'principal'} intent bytes`);
      const scope = brain ? 'brain' : 'principal';
      if (Number(row.lifetime_ids) + 1 > limits[`${scope}LifetimeIds`]) throw await cumulativeCapacityError(tx, `${scope} permanent request IDs`,
        row.key, `${scope}LifetimeIds`, Number(row.lifetime_ids), limits[`${scope}LifetimeIds`]);
      if (Number(row.terminal_bytes) + terminalBytes > limits[`${scope}TerminalBytes`]) throw await cumulativeCapacityError(tx, `${scope} reserved receipt bytes`,
        row.key, `${scope}TerminalBytes`, Number(row.terminal_bytes), limits[`${scope}TerminalBytes`]);
    }
    const [row] = await tx.executeRaw<WriteRequest>(`INSERT INTO persistence_requests
      (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,page_id,slug,
       worktree_id,topology_generation,digest,intent,authority,intent_bytes,terminal_reservation,target_kind,protocol_version,
       admitter_version,admitter_host_id)
      VALUES($1,$2,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::uuid,$10,$11,$12::text::jsonb,$13::text::jsonb,$14,$15,$16,$17,$18,$19::uuid)
      RETURNING *`, [input.principal.kind, input.principal.id, requestId, input.operation, input.sourceId,
      input.sourceIncarnation, input.pageId ?? null, input.slug, input.worktreeId ?? null, input.topologyGeneration ?? null,
      fingerprint, JSON.stringify(input.intent), JSON.stringify(input.authority), bytes, terminalBytes, input.targetKind ?? 'page', input.protocolVersion ?? 1,
      stamp.version, stamp.hostId]);
    await tx.executeRaw(`UPDATE persistence_counters SET outstanding_count=outstanding_count+1,
      intent_bytes=intent_bytes+$2,lifetime_ids=lifetime_ids+1,terminal_bytes=terminal_bytes+$3 WHERE key=ANY($1::text[])`,
    [counters.map(c => c.key), bytes, terminalBytes]);
    return row;
  } };
}

/**
 * F0: a write to a worktree under an active `gbrain sources refresh` is refused
 * before it is journaled. The fence insert holds the worktree row FOR UPDATE
 * and admission holds it FOR SHARE, so an admission either commits before the
 * fence (and is drained) or sees it. During `syncing` only the managed sync's
 * own writes are admitted; a `syncing` refresh whose members all reached the
 * target is completed here, so a later cycle sync converges a crashed refresh.
 */
async function assertWorktreeNotRefreshing(tx: BrainEngine, input: WriteAdmission): Promise<void> {
  const [refresh] = await tx.executeRaw<{ id: string; state: string; source_ids: string[] }>(`SELECT id,state,source_ids FROM persistence_worktree_refreshes
    WHERE worktree_id=$1::uuid AND state IN ${ACTIVE_REFRESH_STATES_SQL}`, [input.worktreeId]);
  if (!refresh) return;
  const managedSync = input.operation === 'submit_job' && String(input.intent.kind ?? '').startsWith('managed_sync_');
  if (refresh.state === 'syncing' && managedSync) return;
  if (refresh.state === 'syncing') {
    const completed = await tx.executeRaw(`UPDATE persistence_worktree_refreshes f SET state='completed',completed_at=now(),updated_at=now()
      WHERE f.id=$1::uuid AND f.state='syncing' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=ANY(f.source_ids)
        AND s.last_commit IS DISTINCT FROM f.target_head) RETURNING f.id`, [refresh.id]);
    if (completed.length) return;
  }
  if (refresh.state === 'recovery_required') throw catalogueError('refresh_recovery_required',
    `Refresh ${refresh.id} could not verify the checkout HEAD of source ${input.sourceId}; writes to its worktree stay fenced.`,
    `gbrain sources writer status ${input.sourceId}, then gbrain sources refresh ${input.sourceId} --resume. Retry the same request_id afterwards.`);
  const error = catalogueError('worktree_refreshing',
    `Source ${input.sourceId}'s checkout is being fast-forwarded by refresh ${refresh.id} (${refresh.state}); this write was not journaled.`,
    `Retry the same request_id after retry_after_ms: 1000. Check progress with gbrain sources writer status ${input.sourceId}.`);
  error.detail = 'retry_after_ms=1000';
  throw error;
}

/**
 * The rows `claimNextWrite` may claim, over `persistence_requests r LEFT JOIN
 * persistence_worktrees w`, with $1 = host id and $2 = excluded root keys. An
 * unresolved head blocks its entire root. A worktree under a refresh fence
 * (`fenced`, `merged`, `recovery_required`) claims nothing. A file write also waits for an
 * unfinished withdrawal mirror of its page (of every page, for an untargeted
 * mirror), so the mirror never rewrites a file under an accepted request.
 */
export const CLAIMABLE_WRITE_SQL = `r.state='queued' AND (r.worktree_id IS NULL OR (w.owner_host_id=$1::uuid AND w.state='active'))
      AND (r.worktree_id IS NULL OR ${refreshFenceClear('r')})
      AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($2::text[]))
      AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror WHERE mirror.worktree_id=r.worktree_id
        AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')
        AND (NOT (mirror.data ? 'targets') OR mirror.data->'targets' @> jsonb_build_array(jsonb_build_object('slug',r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE COALESCE(earlier.worktree_id::text,'db:'||earlier.source_incarnation::text)
              =COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)
        AND earlier.sequence<r.sequence AND earlier.state IN ('queued','running','recovering'))`;

/** #5401: whether `claimNextWrite` would find a row now. Read-only: no lock and no claim. */
export async function hasClaimableWrite(engine: SqlEngine, hostId: string, excludeRoots: string[] = [], signal?: AbortSignal): Promise<boolean> {
  const [row] = await engine.executeRaw<{ claimable: boolean }>(`SELECT EXISTS (SELECT 1 FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE ${CLAIMABLE_WRITE_SQL} LIMIT 1) AS claimable`, [hostId, excludeRoots], { signal });
  return row?.claimable === true;
}

/** Claims commit before OS-lock waits. An unresolved head blocks its entire root. */
export async function claimNextWrite(engine: BrainEngine, hostId: string, leaseMs = 30_000, excludeRoots: string[] = []): Promise<WriteRequest | null> {
  return engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    const [row] = await tx.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE ${CLAIMABLE_WRITE_SQL}
      ORDER BY r.sequence LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, [hostId, excludeRoots]);
    if (!row) return null;
    const [claimed] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',
      execution_token=$2::uuid,claim_expires_at=now()+($3::double precision*interval '1 millisecond'),
      updated_at=now(),blocked_reason=NULL WHERE id=$1::uuid RETURNING *`, [row.id, randomUUID(), leaseMs]);
    return claimed;
  });
}
export async function renewWriteClaim(engine: SqlEngine, id: string, token: string, leaseMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  const rows = await engine.executeRaw(`UPDATE persistence_requests SET
    claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [id, token, leaseMs], { signal });
  return rows.length === 1;
}
export async function releaseUnpublishedClaim(engine: SqlEngine, row: WriteRequest, reason: string): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    blocked_reason=$3,updated_at=now() WHERE id=$1::uuid AND execution_token=$2::uuid
    AND state='running' AND recovery IS NULL AND publication_started=false AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, [row.id, row.execution_token, reason]);
}

/** Called while holding the root lock; the durable record precedes any rename. */
export async function prepareRecovery(engine: BrainEngine, row: WriteRequest, recovery: RecoveryRecord, bytes: number,
  overrides?: Partial<JournalLimits>): Promise<void> {
  const limits = await readJournalLimits(engine,overrides);
  if (!row.worktree_id) throw new TypeError('Filesystem recovery requires a worktree.');
  if (bytes > limits.worktreeRecoveryBytes || bytes > limits.brainRecoveryBytes) throw new OperationError('request_too_large', 'This request exceeds the configured recovery capacity.', 'Increase recovery capacity before submitting a new request.');
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    // A crash after rename must never lose the earlier recovery reservation,
    // even when the deployment defaults ordinary transactions to async commit.
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    const counters = await lockCounters(tx, ['brain', `worktree:${row.worktree_id}`]);
    const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
    if (!current || current.execution_token !== row.execution_token || current.state !== 'running') throw opError('write_claim_lost', 'The write execution claim was superseded.',
      `Another owner pass claimed request ${row.request_id} in source ${row.source_id} before this pass recorded its recovery, so this pass stopped without publishing; the current claim finishes or recovers it. Inspect the request with the command in fix instead of resubmitting it.`,
      { fix: requestInspectFix(row) });
    if (current.recovery) {
      if (digest(current.recovery) !== digest(recovery)) throw opError('recovery_required', 'An existing publication must be recovered before preparing another.',
        `Request ${row.request_id} in source ${row.source_id} already holds a different publication recovery record, so nothing new was written. The owner's recovery pass restores or finishes that publication first; inspect it with the command in fix and do not resubmit the request.`,
        { fix: requestInspectFix(row) });
      return;
    }
    for (const c of counters) if (Number(c.recovery_bytes) + bytes > (c.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes)) throw capacityError('recovery bytes currently reserved by other requests');
    await tx.executeRaw(`UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4,updated_at=now()
      WHERE id=$1::uuid AND execution_token=$2::uuid`, [row.id, row.execution_token, JSON.stringify(recovery), bytes]);
    await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=ANY($1::text[])', [counters.map(c => c.key), bytes]);
  });
}

/** In the SAME transaction as page publication. Counters are always before request locks. */
export async function completeWrite(tx: SqlEngine, row: WriteRequest, state: 'committed' | 'conflict' | 'failed' | 'cancelled',
  outcome: Record<string, unknown>, error?: { code: string; message: string; detail?: unknown }): Promise<WriteRequest> {
  // Every acknowledged terminal state survives a crash, including cancellation
  // and pre-publication failures that do not enter the file coordinator.
  await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
  await declarePersistenceProtocol(tx);
  const keys = ['brain', principalKey(requestPrincipal(row)), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])];
  await lockCounters(tx, keys);
  const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
  if (!current) throw opError('not_found', 'Write request not found.',
    `The journal row of request ${row.request_id} in source ${row.source_id} disappeared before its completion was recorded, so no outcome was saved. Inspect the source's requests with the command in fix before submitting anything again.`,
    { fix: ownerStatusFix(row.source_id) });
  if (isTerminal(current)) return current;
  if (row.execution_token !== current.execution_token) throw opError('write_claim_lost', 'Write claim changed before completion.',
    `Another owner pass claimed request ${row.request_id} in source ${row.source_id} before this pass recorded its outcome, so this pass's completion was discarded; the current claim records the final outcome. Inspect the request with the command in fix instead of resubmitting it.`,
    { fix: requestInspectFix(row) });
  const [effects] = await tx.executeRaw<{bytes:string}>(`SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0)::text AS bytes
    FROM persistence_effects WHERE request_id=$1::uuid`,[row.id]);
  if (jsonBytes(outcome) + jsonBytes(current.authority) + 1024 + Buffer.byteLength(error?.message ?? '') + (error?.detail ? jsonBytes(error.detail) : 0) + Number(effects.bytes) > Number(current.terminal_reservation)) throw capacityError('terminal result and effects exceed their reserved bounded encoding');
  // Only publication stamps the consumer; failures, cancellations and conflicts leave it unset.
  const stamp = writerStamp();
  const [done] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state=$2,outcome=$3::text::jsonb,
    error_code=$4,error_message=$5,error_detail=COALESCE($8::text::jsonb,error_detail),completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL,
    consumer_version=CASE WHEN $2='committed' THEN $6 ELSE consumer_version END,
    consumer_host_id=CASE WHEN $2='committed' THEN $7::uuid ELSE consumer_host_id END,
    published_at=CASE WHEN $2='committed' THEN now() ELSE published_at END
    WHERE id=$1::uuid RETURNING *`, [row.id, state, JSON.stringify(outcome), error?.code ?? null, error?.message ?? null, stamp.version, stamp.hostId,
      error?.detail ? JSON.stringify(error.detail) : null]);
  await tx.executeRaw(`UPDATE persistence_counters SET outstanding_count=outstanding_count-1,intent_bytes=intent_bytes-$2
    WHERE key=ANY($1::text[])`, [['brain', principalKey(requestPrincipal(row))], Number(current.intent_bytes)]);
  // Recovery bytes remain reserved until physical cleanup has been verified.
  return done;
}

export async function clearResolvedRecovery(engine: BrainEngine, id: string): Promise<void> {
  const row = await getWriteRequestById(engine, id);
  if (!row?.recovery || !isTerminal(row)) return;
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    const keys = ['brain', ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])];
    await lockCounters(tx, keys);
    const [locked] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [id]);
    if (!locked?.recovery || !isTerminal(locked)) return;
    for (const file of recoveryFiles(locked.recovery)) assertRecoveryStagingAbsent(file);
    await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$2 WHERE key=ANY($1::text[])', [keys, Number(locked.recovery_bytes)]);
    await tx.executeRaw('UPDATE persistence_requests SET recovery=NULL,recovery_bytes=0,blocked_reason=NULL WHERE id=$1::uuid', [id]);
  });
}
export async function markRecovering(engine: SqlEngine, row: WriteRequest, reason: string, failure?: {code:string;message:string;detail?:unknown}): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_requests SET state='recovering',blocked_reason=$3,updated_at=now(),
    error_code=COALESCE(error_code,$4),error_message=COALESCE(error_message,$5),
    error_detail=CASE WHEN error_code IS NULL THEN $6::text::jsonb ELSE error_detail END
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state IN ('running','recovering') AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
  [row.id, row.execution_token, reason, failure?.code ?? null, failure?.message ?? null, failure?.detail ? JSON.stringify(failure.detail) : null]);
}
/**
 * PGLite has no autovacuum. The resident owner reclaims queue churn and keeps
 * planner statistics current, so receipt lookups keep using the request-id
 * index and claims do not walk dead queue entries.
 */
export async function vacuumPersistenceQueues(engine: BrainEngine): Promise<number> {
  if (engine.kind !== 'pglite') return 0;
  await engine.executeRaw('VACUUM (ANALYZE) persistence_requests, persistence_effects, persistence_counters, page_projection_jobs, page_write_guards');
  const [requests] = await engine.executeRaw<{ rows: number }>("SELECT GREATEST(reltuples,0)::float8 AS rows FROM pg_class WHERE oid='persistence_requests'::regclass");
  return Number(requests?.rows ?? 0);
}

export async function compactWriteReceipts(engine: BrainEngine, retentionDays?: number): Promise<number> {
  retentionDays ??= await readReceiptRetentionDays(engine);
  if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new TypeError('Invalid receipt retention.');
  // Receipts with unfinished effects stay retained; filtering them before the
  // LIMIT keeps a backlog of parked effects from starving later receipts.
  const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests r
    WHERE state IN ('committed','conflict','failed','cancelled') AND recovery IS NULL AND NOT compacted
    AND completed_at < now()-($1::double precision*interval '1 day')
    AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state<>'committed')
    ORDER BY sequence LIMIT 100`, [retentionDays]);
  let count=0;
  for(const row of rows) count+=await engine.transaction(async tx=>{
    await declarePersistenceProtocol(tx);
    const keys=['brain',principalKey(requestPrincipal(row))];
    await lockCounters(tx,keys);
    const [current]=await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE',[row.id]);
    if(!current || current.compacted || current.recovery || !isTerminal(current)) return 0;
    const unfinished=await tx.executeRaw("SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid AND state<>'committed' LIMIT 1",[row.id]);
    if(unfinished.length) return 0;
    const [effects]=await tx.executeRaw<{bytes:string}>(`SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0)::text AS bytes
      FROM persistence_effects WHERE request_id=$1::uuid`,[row.id]);
    const retained=Math.min(Number(current.terminal_reservation),jsonBytes(current.authority)+jsonBytes(current.outcome??{})+(current.error_detail?jsonBytes(current.error_detail):0)+Number(effects.bytes)+1024);
    await tx.executeRaw('UPDATE persistence_requests SET intent=NULL,compacted=true,error_message=NULL,terminal_reservation=$2 WHERE id=$1::uuid',[row.id,retained]);
    for(const key of keys) await tx.executeRaw('UPDATE persistence_counters SET terminal_bytes=terminal_bytes-$2 WHERE key=$1',[key,Number(current.terminal_reservation)-retained]);
    return 1;
  });
  return count;
}
export function receiptFor(row: WriteRequest, facts?: WriteHealthFacts, now = Date.now()) {
  return {
    ...(row.outcome ?? {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    request_id: row.request_id, state: row.state,
    ...writeHealth(row, facts, now),
    ...(row.error_code ? { write_error: row.error_code } : {}),
    ...(row.error_detail ? { write_error_detail: publicFailureDetail(row.error_detail) } : {}),
    ...(row.blocked_reason ? { blocked_reason: row.blocked_reason } : {}),
    ...(row.compacted ? { compacted: true } : {}),
    created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
  };
}

const healthQueries = new WeakMap<BrainEngine, Promise<unknown>>();
export async function writeHealthFacts(engine: BrainEngine, rows: WriteRequest[]): Promise<Map<string, WriteHealthFacts>> {
  if (rows.length > 100) throw new RangeError('Receipt health pages are limited to 100 rows.');
  const pending = rows.filter(row => !isTerminal(row));
  const result = new Map<string, WriteHealthFacts>();
  if (!pending.length || healthQueries.has(engine)) return result;
  const roots = [...new Set(pending.map(row => row.worktree_id ?? `db:${row.source_incarnation}`))];
  const abort = new AbortController();
  const observed_at = new Date().toISOString();
  const query = engine.executeRaw<{ root: string; sequence: string | null; recovery_required: boolean; owner_unavailable: boolean; inspect_owner: boolean }>(`
    WITH roots AS (SELECT unnest($1::text[]) AS root)
    SELECT roots.root,head.sequence::text,COALESCE(head.inspect_owner,false) AS inspect_owner,
      COALESCE(head.recovering,false) OR EXISTS (SELECT 1 FROM persistence_effects e
        WHERE e.worktree_id=w.id AND e.recovery IS NOT NULL) AS recovery_required,
      w.id IS NOT NULL AND (w.state<>'active' OR w.owner_host_id IS NULL) AS owner_unavailable
    FROM roots LEFT JOIN persistence_worktrees w ON w.id::text=roots.root
    LEFT JOIN LATERAL (
      (SELECT r.sequence,r.recovery IS NOT NULL AS recovering,
        r.blocked_reason IN ('unexpected_file_bytes','unexpected_staging_bytes') AS inspect_owner FROM persistence_requests r
        WHERE r.worktree_id=w.id AND (r.state IN ('queued','running','recovering') OR r.recovery IS NOT NULL)
        ORDER BY r.sequence LIMIT 1)
      UNION ALL
      (SELECT r.sequence,r.recovery IS NOT NULL AS recovering,
        r.blocked_reason IN ('unexpected_file_bytes','unexpected_staging_bytes') AS inspect_owner FROM persistence_requests r
        WHERE r.worktree_id IS NULL AND r.source_incarnation=CASE WHEN roots.root LIKE 'db:%' THEN substring(roots.root FROM 4)::uuid END
        AND r.state IN ('queued','running','recovering') ORDER BY r.sequence LIMIT 1)
    ) head ON true`, [roots], { signal: engine.kind === 'postgres' ? abort.signal : undefined })
    .catch(() => null).finally(() => { if (healthQueries.get(engine) === query) healthQueries.delete(engine); });
  healthQueries.set(engine, query);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const facts = await Promise.race([query, new Promise<null>(resolve => {
    timer = setTimeout(() => { abort.abort(); resolve(null); }, 500);
  })]).finally(() => { if (timer) clearTimeout(timer); });
  if (!facts) return result;
  const byRoot = new Map(facts.map(fact => [fact.root, fact]));
  for (const row of pending) {
    const fact = byRoot.get(row.worktree_id ?? `db:${row.source_incarnation}`);
    if (fact) result.set(row.id, { observed_at, recovery_required: fact.recovery_required,
      owner_unavailable: fact.owner_unavailable,
      inspect_owner: fact.inspect_owner,
      earlier_write: fact.sequence != null && BigInt(fact.sequence) < BigInt(row.sequence) });
  }
  return result;
}
