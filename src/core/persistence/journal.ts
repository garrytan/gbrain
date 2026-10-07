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
import { assertMutationProtocol, assertSharedSkillPersistence, declareDurablePersistence, declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { assertGraduationAdmission } from './graduation-custody.ts';
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
  /** F6: the client's non-UUID request_id, stored beside the canonical id and never digested. */
  clientRequestId?: string;
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
/** Creates and locks the counter rows in key order: two statements for any number of keys (#5984 round-trip diet). */
/** Creates missing counter rows; takes no lock on existing ones. Keys sorted. */
export const ENSURE_COUNTERS_SQL = 'INSERT INTO persistence_counters(key) SELECT k FROM unnest($1::text[]) WITH ORDINALITY AS u(k,n) ORDER BY n ON CONFLICT DO NOTHING';
/** Locks counter rows in one global order (deadlock avoidance). */
export const LOCK_COUNTERS_SQL = 'SELECT * FROM persistence_counters WHERE key=ANY($1::text[]) ORDER BY key COLLATE "C" FOR UPDATE';
export async function lockCounters(tx: SqlEngine, keys: string[]): Promise<Counter[]> {
  const sorted = [...new Set(keys)].sort();
  await tx.executeRaw(ENSURE_COUNTERS_SQL, [sorted]);
  return tx.executeRaw<Counter>(LOCK_COUNTERS_SQL, [sorted]);
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
/** #5984: the columns a waiter needs while a request is unfinished; the full row is read once it is terminal. */
export type WriteRequestProgress = Pick<WriteRequest, 'state' | 'error_code' | 'error_message' | 'completed_at' | 'updated_at' | 'blocked_reason' | 'outcome'>;
export const WRITE_PROGRESS_SQL = 'SELECT state,error_code,error_message,completed_at,updated_at,blocked_reason,outcome FROM persistence_requests WHERE id=$1::uuid';
export async function getWriteRequestProgress(engine: SqlEngine, id: string, signal?: AbortSignal): Promise<WriteRequestProgress | null> {
  const [row] = await engine.executeRaw<WriteRequestProgress>(WRITE_PROGRESS_SQL, [id], { signal });
  return row ?? null;
}
export function intentDigest(a: Pick<WriteAdmission, 'operation' | 'sourceId' | 'slug' | 'callerIntent'>): string {
  return digest({ operation: a.operation, source_id: a.sourceId, slug: a.slug, intent: a.callerIntent });
}
export function assertReplayIntent(row: WriteRequest, expectedDigest: string): WriteRequest {
  if (row.digest !== expectedDigest) throw opError('idempotency_conflict', 'This request_id was used for a different write; send a new one or omit it.',
    'A request_id is reused only to retry the same write. Send this write again with a new request_id or without one; the earlier write keeps its receipt.',
    { fix: readFix(`Reads the earlier write's receipt (request ${row.request_id}), read-only.`, row.principal_kind === 'local_cli'
      ? { argv: ['gbrain', 'write-request', '--', row.request_id] }
      : { mcp: { tool: 'get_write_request', arguments: { request_id: row.client_request_id ?? row.request_id } } }) });
  return row;
}
export async function admitWrite(engine: BrainEngine, input: WriteAdmission, overrides?: Partial<JournalLimits>): Promise<WriteRequest> {
  const { requestId, apply } = await prepareAdmission(engine, input, overrides);
  return retryWriteAdmission(requestId, remaining => engine.transaction(async tx => {
    await declareDurablePersistence(tx, `${Math.min(100, remaining)}ms`, `${remaining}ms`);
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
    await assertGraduationAdmission(tx);
    assertMutationProtocol({ target_kind: input.targetKind, protocol_version: input.protocolVersion });
    if (input.worktreeId) await assertWorktreeAdmission(tx, input);
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
    // The request row and its counter reservation in one statement; the counters are already locked.
    const [row] = await tx.executeRaw<WriteRequest>(`WITH reserved AS (UPDATE persistence_counters SET outstanding_count=outstanding_count+1,
      intent_bytes=intent_bytes+$14,lifetime_ids=lifetime_ids+1,terminal_bytes=terminal_bytes+$15 WHERE key=ANY($20::text[]))
      INSERT INTO persistence_requests
      (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,page_id,slug,
       worktree_id,topology_generation,digest,intent,authority,intent_bytes,terminal_reservation,target_kind,protocol_version,
       admitter_version,admitter_host_id,client_request_id)
      VALUES($1,$2,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::uuid,$10,$11,$12::text::jsonb,$13::text::jsonb,$14,$15,$16,$17,$18,$19::uuid,$21)
      RETURNING *`, [input.principal.kind, input.principal.id, requestId, input.operation, input.sourceId,
      input.sourceIncarnation, input.pageId ?? null, input.slug, input.worktreeId ?? null, input.topologyGeneration ?? null,
      fingerprint, JSON.stringify(input.intent), JSON.stringify(input.authority), bytes, terminalBytes, input.targetKind ?? 'page', input.protocolVersion ?? 1,
      stamp.version, stamp.hostId, counters.map(c => c.key), input.clientRequestId ?? null]);
    return row;
  } };
}

/**
 * #5984 bulk sync: admits consecutive managed-sync page requests of one cursor
 * in one transaction. Each page keeps its own request row, request ID, digest
 * and receipt; the shared checks (worktree fence, binding, source, counters)
 * run once and the rows are inserted in order, so their sequences keep the
 * manifest order. Replays return the prior rows, as single admission does.
 */
export async function admitWriteGroupInTransaction(tx: BrainEngine, inputs: WriteAdmission[], overrides?: Partial<JournalLimits>): Promise<WriteRequest[]> {
  const first = inputs[0];
  if (!first) return [];
  if (inputs.some(input => input.sourceId !== first.sourceId || input.sourceIncarnation !== first.sourceIncarnation || input.worktreeId !== first.worktreeId
    || String(input.topologyGeneration) !== String(first.topologyGeneration) || input.principal.kind !== first.principal.kind || input.principal.id !== first.principal.id
    || input.operation !== first.operation || (input.targetKind ?? 'page') !== 'page' || (input.protocolVersion ?? 1) !== 1 || digest(input.authority) !== digest(first.authority))) {
    throw new TypeError('A group admission requires one source, worktree, principal, operation and authority.');
  }
  const limits = await readJournalLimits(tx, overrides);
  const stamp = writerStamp();
  const items = inputs.map(input => ({ input, requestId: requireUuid(input.requestId ?? randomUUID()), fingerprint: intentDigest(input),
    bytes: jsonBytes(input.intent) + jsonBytes(input.authority), terminalBytes: input.terminalReservation ?? Math.max(16_384, jsonBytes(input.authority) + 8192) }));
  await declarePersistenceProtocol(tx);
  await assertGraduationAdmission(tx);
  assertMutationProtocol({ target_kind: 'page', protocol_version: 1 });
  if (first.worktreeId) await assertWorktreeAdmission(tx, first);
  const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [first.sourceId]);
  if (!source || source.archived || source.incarnation !== first.sourceIncarnation) {
    throw new OperationError('source_changed', 'The write source is missing, archived, or was replaced.', 'Resolve the source again and submit a new request.');
  }
  for (const { input } of items) await authorizeWrite(tx, input.authority, input.operation, input.slug, true);
  const counters = await lockCounters(tx, ['brain', principalKey(first.principal)]);
  const ids = items.map(item => item.requestId);
  if (first.principal.kind === 'local_cli') {
    const [topology] = await tx.executeRaw<{ request_id: string }>('SELECT request_id FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=ANY($2::uuid[]) LIMIT 1', [first.principal.id, ids]);
    if (topology) throw lifecycleIdConflict(topology.request_id);
  }
  const priors = new Map((await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])',
    [first.principal.kind, first.principal.id, ids])).map(row => [row.request_id, row]));
  for (const item of items) {
    const prior = priors.get(item.requestId);
    if (!prior) continue;
    if ((prior.target_kind ?? 'page') !== 'page' || (prior.protocol_version ?? 1) !== 1) throw opError('idempotency_conflict', 'This request_id belongs to a different mutation target or protocol.',
      `Request ID ${item.requestId} was already accepted for a ${prior.target_kind ?? 'page'} write (protocol ${prior.protocol_version ?? 1}), so this page write was not admitted. Read the original request${prior.principal_kind === 'local_cli' ? ' with the command in fix' : ' with get_write_request'} if you meant to replay it; otherwise submit this write with a new request_id.`,
      prior.principal_kind === 'local_cli' ? { fix: requestInspectFix(prior) } : {});
    assertReplayIntent(prior, item.fingerprint);
  }
  const fresh = items.filter(item => !priors.has(item.requestId));
  if (fresh.length) {
    const bytes = fresh.reduce((sum, item) => sum + item.bytes, 0), terminalBytes = fresh.reduce((sum, item) => sum + item.terminalBytes, 0);
    for (const row of counters) {
      const brain = row.key === 'brain', scope = brain ? 'brain' : 'principal';
      if (Number(row.outstanding_count) + fresh.length > (brain ? limits.brainOutstanding : limits.principalOutstanding)) throw capacityError(`${scope} outstanding requests`);
      if (Number(row.intent_bytes) + bytes > (brain ? limits.brainIntentBytes : limits.principalIntentBytes)) throw capacityError(`${scope} intent bytes`);
      if (Number(row.lifetime_ids) + fresh.length > limits[`${scope}LifetimeIds`]) throw await cumulativeCapacityError(tx, `${scope} permanent request IDs`,
        row.key, `${scope}LifetimeIds`, Number(row.lifetime_ids), limits[`${scope}LifetimeIds`]);
      if (Number(row.terminal_bytes) + terminalBytes > limits[`${scope}TerminalBytes`]) throw await cumulativeCapacityError(tx, `${scope} reserved receipt bytes`,
        row.key, `${scope}TerminalBytes`, Number(row.terminal_bytes), limits[`${scope}TerminalBytes`]);
    }
    const rows = await tx.executeRaw<WriteRequest>(`INSERT INTO persistence_requests
      (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,page_id,slug,
       worktree_id,topology_generation,digest,intent,authority,intent_bytes,terminal_reservation,target_kind,protocol_version,
       admitter_version,admitter_host_id,client_request_id)
      SELECT $1,$2,(e->>'request_id')::uuid,$3,$4,$5::uuid,(e->>'page_id')::integer,e->>'slug',$6::uuid,$7,e->>'digest',e->'intent',$8::text::jsonb,
        (e->>'intent_bytes')::bigint,(e->>'terminal_reservation')::bigint,'page',1,$9,$10::uuid,e->>'client_request_id'
      FROM jsonb_array_elements($11::text::jsonb) WITH ORDINALITY AS t(e,n) ORDER BY n
      RETURNING *`, [first.principal.kind, first.principal.id, first.operation, first.sourceId, first.sourceIncarnation, first.worktreeId ?? null,
      first.topologyGeneration ?? null, JSON.stringify(first.authority), stamp.version, stamp.hostId,
      JSON.stringify(fresh.map(item => ({ request_id: item.requestId, page_id: item.input.pageId ?? null, slug: item.input.slug, digest: item.fingerprint,
        intent: item.input.intent, intent_bytes: item.bytes, terminal_reservation: item.terminalBytes, client_request_id: item.input.clientRequestId ?? null })))]);
    for (const row of rows) priors.set(row.request_id, row);
    await tx.executeRaw(`UPDATE persistence_counters SET outstanding_count=outstanding_count+$4,
      intent_bytes=intent_bytes+$2,lifetime_ids=lifetime_ids+$4,terminal_bytes=terminal_bytes+$3 WHERE key=ANY($1::text[])`,
    [counters.map(c => c.key), bytes, terminalBytes, fresh.length]);
  }
  return items.map(item => priors.get(item.requestId)!);
}

/**
 * #5984 bulk sync: after claiming a group's head, claims the queued members of
 * the same group that directly follow it on its worktree, in sequence order,
 * stopping at the first row that is not a queued member of the group. A member
 * is never claimed past an unfinished non-member, so the FIFO order holds.
 */
/**
 * The publication group key of a request: a bulk sync's `intent.group`, or the
 * batch id of a `put_pages` child (`intent.page_batch.id`, #6007). Null when it
 * publishes alone.
 */
export function publicationGroupKey(row: Pick<WriteRequest, 'operation' | 'intent'>): string | null {
  if (typeof row.intent?.group === 'string') return `sync:${row.intent.group}`;
  const batch = row.intent?.page_batch as { id?: unknown } | undefined;
  return row.operation === 'put_page' && !row.intent?.kind && typeof batch?.id === 'string' ? `batch:${batch.id}` : null;
}
const GROUP_KEY_SQL = `CASE WHEN intent ? 'group' THEN 'sync:'||(intent->>'group')
  WHEN operation='put_page' AND NOT (intent ? 'kind') AND jsonb_typeof(intent->'page_batch'->'id')='string' THEN 'batch:'||(intent->'page_batch'->>'id') END`;
export async function claimGroupFollowers(engine: BrainEngine, head: WriteRequest, group: string, max: number, leaseMs = 30_000): Promise<WriteRequest[]> {
  if (!head.worktree_id || max <= 0) return [];
  return engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    const next = await tx.executeRaw<{ id: string; state: string; grp: string | null; recovering: boolean }>(`SELECT id,state,${GROUP_KEY_SQL} AS grp,recovery IS NOT NULL AS recovering
      FROM persistence_requests WHERE worktree_id=$1::uuid AND sequence>$2 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL)
      ORDER BY sequence LIMIT $3 FOR UPDATE`, [head.worktree_id, head.sequence, max]);
    const members: string[] = [];
    for (const row of next) {
      if (row.grp !== group || row.state !== 'queued' || row.recovering) break;
      members.push(row.id);
    }
    if (!members.length) return [];
    const tokens = members.map(() => randomUUID());
    return tx.executeRaw<WriteRequest>(`UPDATE persistence_requests r SET state='running',execution_token=t.token,
      claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),blocked_reason=NULL
      FROM unnest($1::uuid[],$2::uuid[]) AS t(id,token) WHERE r.id=t.id AND r.state='queued' RETURNING r.*`, [members, tokens, leaseMs])
      .then(rows => rows.sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence))));
  });
}

/** Renews every claim of a group in one statement; returns the ids still held. */
export async function renewGroupClaims(engine: SqlEngine, rows: WriteRequest[], leaseMs = 30_000, signal?: AbortSignal, phase: string | null = null): Promise<Set<string>> {
  const held = await engine.executeRaw<{ id: string }>(`UPDATE persistence_requests r SET claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),
    claim_phase=COALESCE(jsonb_set($4::text::jsonb,'{token}',to_jsonb(t.token::text)),r.claim_phase)
    FROM unnest($1::uuid[],$2::uuid[]) AS t(id,token) WHERE r.id=t.id AND r.execution_token=t.token AND r.state='running' AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING r.id`,
  [rows.map(row => row.id), rows.map(row => row.execution_token), leaseMs, phase], { signal });
  return new Set(held.map(row => row.id));
}

/**
 * F0: a write to a worktree under an active `gbrain sources refresh` is refused
 * before it is journaled. The fence insert holds the worktree row FOR UPDATE
 * and admission holds it FOR SHARE, so an admission either commits before the
 * fence (and is drained) or sees it. During `syncing` only the managed sync's
 * own writes are admitted; a `syncing` refresh whose members all reached the
 * target is completed here, so a later cycle sync converges a crashed refresh.
 */
/**
 * Share-locks the worktree, then checks its refresh fence and the source
 * binding (#6007: both read in one statement after the lock; the fence is
 * judged first, as before).
 */
async function assertWorktreeAdmission(tx: BrainEngine, input: WriteAdmission): Promise<void> {
  await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [input.worktreeId]);
  const [state] = await tx.executeRaw<{ refresh: { id: string; state: string; source_ids: string[] } | string | null; bound: boolean }>(`SELECT
      (SELECT row_to_json(f) FROM (SELECT id,state,source_ids FROM persistence_worktree_refreshes
        WHERE worktree_id=$3::uuid AND state IN ${ACTIVE_REFRESH_STATES_SQL} LIMIT 1) f) AS refresh,
      EXISTS (SELECT 1 FROM persistence_source_bindings WHERE source_id=$1
        AND source_incarnation=$2::uuid AND worktree_id=$3::uuid AND topology_generation=$4) AS bound`,
  [input.sourceId, input.sourceIncarnation, input.worktreeId, input.topologyGeneration]);
  const refresh = typeof state?.refresh === 'string' ? JSON.parse(state.refresh) as { id: string; state: string; source_ids: string[] } : state?.refresh ?? null;
  if (refresh) await assertWorktreeNotRefreshing(tx, input, refresh);
  if (!state?.bound) throw opError('source_changed', 'The source binding changed during admission.',
    `Source ${input.sourceId}'s worktree binding changed (a claim, transfer or lifecycle change) while this write was being admitted, so nothing was accepted. Check the owner with the command in fix, then submit the write again; reusing the same request_id is safe because nothing was recorded.`,
    { fix: ownerStatusFix(input.sourceId) });
}
async function assertWorktreeNotRefreshing(tx: BrainEngine, input: WriteAdmission, refresh: { id: string; state: string; source_ids: string[] }): Promise<void> {
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
/**
 * #5984 lanes: claims the head of the next admitted group of lane run `run` in
 * worktree `worktreeId` while earlier groups of the same run still publish.
 * Every request before it must already be claimed (none queued, so heads are
 * claimed in manifest order), and an unfinished earlier request must be a
 * running request of the same run: a foreground write, a recovering request,
 * a request of another run or any recovery record still blocks it, exactly
 * as under the FIFO claim. Followers are claimed with their head by
 * `claimGroupFollowers`.
 */
export async function claimNextLaneHead(engine: BrainEngine, hostId: string, worktreeId: string, run: string, leaseMs = 30_000): Promise<WriteRequest | null> {
  return engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    const [row] = await tx.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
      JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE r.worktree_id=$2::uuid AND r.state='queued' AND r.intent->>'lane'=$3 AND r.intent->>'group'=r.request_id::text
        AND w.owner_host_id=$1::uuid AND w.state='active' AND ${refreshFenceClear('r')}
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror WHERE mirror.worktree_id=r.worktree_id
          AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier WHERE earlier.worktree_id=r.worktree_id AND earlier.sequence<r.sequence
          AND (earlier.state IN ('queued','recovering') OR (earlier.state='running' AND COALESCE(earlier.intent->>'lane','')<>$3)))
      ORDER BY r.sequence LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, [hostId, worktreeId, run]);
    if (!row) return null;
    const [claimed] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',
      execution_token=$2::uuid,claim_expires_at=now()+($3::double precision*interval '1 millisecond'),
      updated_at=now(),blocked_reason=NULL WHERE id=$1::uuid RETURNING *`, [row.id, randomUUID(), leaseMs]);
    return claimed;
  });
}
/** `phase` (claim-phase.ts `claimPhaseStamp`, #6176) records the claim's current phase with the renewal. */
export async function renewWriteClaim(engine: SqlEngine, id: string, token: string, leaseMs = 30_000, signal?: AbortSignal, phase: string | null = null): Promise<boolean> {
  const rows = await engine.executeRaw(`UPDATE persistence_requests SET
    claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),claim_phase=COALESCE($4::text::jsonb,claim_phase)
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [id, token, leaseMs, phase], { signal });
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
    // A crash after rename must never lose the earlier recovery reservation,
    // even when the deployment defaults ordinary transactions to async commit.
    await declareDurablePersistence(tx);
    const counters = await lockCounters(tx, ['brain', `worktree:${row.worktree_id}`]);
    const fits = counters.every(c => Number(c.recovery_bytes) + bytes <= (c.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes));
    // #6007: the common case records the reservation in one statement; any other state takes the checked path below.
    if (fits) {
      const [reserved] = await tx.executeRaw(`WITH recorded AS (UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4,updated_at=now()
          WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND recovery IS NULL RETURNING id),
        reserved AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$4 WHERE key=ANY($5::text[]) AND EXISTS (SELECT 1 FROM recorded))
        SELECT id FROM recorded`, [row.id, row.execution_token, JSON.stringify(recovery), bytes, counters.map(c => c.key)]);
      if (reserved) return;
    }
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
    await tx.executeRaw(`WITH reserved AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$4 WHERE key=ANY($5::text[]))
      UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4,updated_at=now()
      WHERE id=$1::uuid AND execution_token=$2::uuid`, [row.id, row.execution_token, JSON.stringify(recovery), bytes, counters.map(c => c.key)]);
  });
}

/**
 * #6007 grouped publication: records every member's recovery record in one
 * transaction, before any of their files is touched. All or nothing: a member
 * whose claim moved, or that already holds a record, fails the whole call and
 * nothing is recorded.
 */
export async function prepareRecoveries(engine: BrainEngine, members: { row: WriteRequest; record: RecoveryRecord; bytes: number }[]): Promise<void> {
  if (!members.length) return;
  const worktree = members[0]!.row.worktree_id;
  if (!worktree || members.some(member => member.row.worktree_id !== worktree)) throw new TypeError('Grouped filesystem recovery requires one worktree.');
  const limits = await readJournalLimits(engine);
  const total = members.reduce((sum, member) => sum + member.bytes, 0);
  if (members.some(member => member.bytes > limits.worktreeRecoveryBytes || member.bytes > limits.brainRecoveryBytes)) {
    throw new OperationError('request_too_large', 'This request exceeds the configured recovery capacity.', 'Increase recovery capacity before submitting a new request.');
  }
  await engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    const counters = await lockCounters(tx, ['brain', `worktree:${worktree}`]);
    for (const c of counters) if (Number(c.recovery_bytes) + total > (c.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes)) throw capacityError('recovery bytes currently reserved by other requests');
    const recorded = await tx.executeRaw(`WITH recorded AS (UPDATE persistence_requests r SET recovery=t.record,recovery_bytes=t.bytes,updated_at=now()
        FROM jsonb_to_recordset($1::text::jsonb) AS t(id uuid,token uuid,record jsonb,bytes bigint)
        WHERE r.id=t.id AND r.execution_token=t.token AND r.state='running' AND r.recovery IS NULL RETURNING r.id),
      reserved AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=ANY($3::text[]) AND (SELECT count(*) FROM recorded)=$4)
      SELECT id FROM recorded`, [JSON.stringify(members.map(member => ({ id: member.row.id, token: member.row.execution_token, record: member.record, bytes: member.bytes }))),
      total, counters.map(c => c.key), members.length]);
    if (recorded.length !== members.length) throw opError('write_claim_lost', 'A grouped write claim changed before its recovery was recorded.',
      'Another owner pass holds one of the grouped requests; the group publishes nothing and its members publish one at a time.');
  });
}

/** Clears the resolved recovery records of a committed group in one transaction; a record that changed is cleared on its own. */
export async function clearResolvedRecoveries(engine: BrainEngine, rows: WriteRequest[]): Promise<void> {
  const resolved = rows.filter(row => row.recovery && isTerminal(row));
  if (resolved.length < 2) { for (const row of resolved) await clearResolvedRecovery(engine, row.id, row); return; }
  for (const row of resolved) for (const file of recoveryFiles(row.recovery!)) assertRecoveryStagingAbsent(file);
  const worktree = resolved[0]!.worktree_id;
  const cleared = new Set((await engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    const keys = ['brain', ...(worktree ? [`worktree:${worktree}`] : [])];
    await lockCounters(tx, keys);
    return tx.executeRaw<{ id: string }>(`WITH locked AS (SELECT r.id,r.recovery_bytes FROM persistence_requests r
        JOIN jsonb_to_recordset($1::text::jsonb) AS t(id uuid,record jsonb) ON t.id=r.id
        WHERE r.recovery=t.record AND r.worktree_id IS NOT DISTINCT FROM $3::uuid AND r.state IN ('committed','conflict','failed','cancelled') FOR UPDATE OF r),
      released AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes-(SELECT COALESCE(SUM(recovery_bytes),0) FROM locked) WHERE key=ANY($2::text[]))
      UPDATE persistence_requests r SET recovery=NULL,recovery_bytes=0,blocked_reason=NULL FROM locked WHERE r.id=locked.id RETURNING r.id`,
    [JSON.stringify(resolved.map(row => ({ id: row.id, record: row.recovery }))), keys, worktree]);
  })).map(row => row.id));
  for (const row of resolved) if (!cleared.has(row.id)) await clearResolvedRecovery(engine, row.id);
}

/** #6007: claims again a request this owner pass released to the queue itself, while it still holds the worktree's native lock. */
export async function reclaimReleasedWrite(engine: BrainEngine, id: string, leaseMs = 30_000): Promise<WriteRequest | null> {
  const [claimed] = await engine.executeRawDirect<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,
    claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),blocked_reason=NULL
    WHERE id=$1::uuid AND state='queued' AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING *`, [id, randomUUID(), leaseMs]);
  return claimed ?? null;
}

/** In the SAME transaction as page publication. Counters are always before request locks. */
export async function completeWrite(tx: SqlEngine, row: WriteRequest, state: 'committed' | 'conflict' | 'failed' | 'cancelled',
  outcome: Record<string, unknown>, error?: { code: string; message: string; detail?: unknown },
  /** #5984: the caller's transaction already declared the protocol, set synchronous_commit, locked these counters and this row FOR UPDATE. */
  locked?: WriteRequest): Promise<WriteRequest> {
  // Every acknowledged terminal state survives a crash, including cancellation
  // and pre-publication failures that do not enter the file coordinator.
  let current = locked;
  if (!current) {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    await declarePersistenceProtocol(tx);
    await lockCounters(tx, ['brain', principalKey(requestPrincipal(row)), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])]);
    [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
  }
  if (!current) throw opError('not_found', 'Write request not found.',
    `The journal row of request ${row.request_id} in source ${row.source_id} disappeared before its completion was recorded, so no outcome was saved. Inspect the source's requests with the command in fix before submitting anything again.`,
    { fix: ownerStatusFix(row.source_id) });
  if (isTerminal(current)) return current;
  if (row.execution_token !== current.execution_token) throw opError('write_claim_lost', 'Write claim changed before completion.',
    `Another owner pass claimed request ${row.request_id} in source ${row.source_id} before this pass recorded its outcome, so this pass's completion was discarded; the current claim records the final outcome. Inspect the request with the command in fix instead of resubmitting it.`,
    { fix: requestInspectFix(row) });
  // Only publication stamps the consumer; failures, cancellations and conflicts leave it unset.
  const stamp = writerStamp();
  // #6007: one statement sizes the queued effects, checks the terminal reservation, completes the row and
  // releases its outstanding counters; no row means the encoding exceeds the reservation and nothing changed.
  const resultBytes = jsonBytes(outcome) + jsonBytes(current.authority) + 1024 + Buffer.byteLength(error?.message ?? '') + (error?.detail ? jsonBytes(error.detail) : 0);
  const [done] = await tx.executeRaw<WriteRequest>(`WITH effects AS (SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0) AS bytes
      FROM persistence_effects WHERE request_id=$1::uuid),
    done AS (UPDATE persistence_requests SET state=$2,outcome=$3::text::jsonb,
      error_code=$4,error_message=$5,error_detail=COALESCE($8::text::jsonb,error_detail),completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL,
      consumer_version=CASE WHEN $2='committed' THEN $6 ELSE consumer_version END,
      consumer_host_id=CASE WHEN $2='committed' THEN $7::uuid ELSE consumer_host_id END,
      published_at=CASE WHEN $2='committed' THEN now() ELSE published_at END
      WHERE id=$1::uuid AND $9::bigint+(SELECT bytes FROM effects)<=terminal_reservation RETURNING *),
    released AS (UPDATE persistence_counters SET outstanding_count=outstanding_count-1,intent_bytes=intent_bytes-$11
      WHERE key=ANY($10::text[]) AND EXISTS (SELECT 1 FROM done))
    SELECT * FROM done`, [row.id, state, JSON.stringify(outcome), error?.code ?? null, error?.message ?? null, stamp.version, stamp.hostId,
      error?.detail ? JSON.stringify(error.detail) : null, resultBytes, ['brain', principalKey(requestPrincipal(row))], Number(current.intent_bytes)]);
  if (!done) throw capacityError('terminal result and effects exceed their reserved bounded encoding');
  // Recovery bytes remain reserved until physical cleanup has been verified.
  return done;
}

/**
 * `known` is the row a publication just completed, passed while it still
 * holds the worktree's native lock, so neither its recovery record nor its
 * staging files can change: its staging is checked first and the record is
 * cleared in one statement when it is still exactly that record.
 */
export async function clearResolvedRecovery(engine: BrainEngine, id: string, known?: WriteRequest): Promise<void> {
  const row = known ?? await getWriteRequestById(engine, id);
  if (!row?.recovery || !isTerminal(row)) return;
  if (known) for (const file of recoveryFiles(row.recovery)) assertRecoveryStagingAbsent(file);
  await engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    const keys = ['brain', ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])];
    await lockCounters(tx, keys);
    if (known) {
      const [cleared] = await tx.executeRaw(`WITH locked AS (SELECT id,recovery_bytes FROM persistence_requests WHERE id=$1::uuid AND recovery=$3::text::jsonb
          AND state IN ('committed','conflict','failed','cancelled') FOR UPDATE),
        released AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes-(SELECT recovery_bytes FROM locked) WHERE key=ANY($2::text[]) AND EXISTS (SELECT 1 FROM locked))
        UPDATE persistence_requests r SET recovery=NULL,recovery_bytes=0,blocked_reason=NULL FROM locked WHERE r.id=locked.id RETURNING r.id`,
      [id, keys, JSON.stringify(row.recovery)]);
      if (cleared) return;
    }
    const [locked] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [id]);
    if (!locked?.recovery || !isTerminal(locked)) return;
    for (const file of recoveryFiles(locked.recovery)) assertRecoveryStagingAbsent(file);
    await tx.executeRaw(`WITH released AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$3 WHERE key=ANY($2::text[]))
      UPDATE persistence_requests SET recovery=NULL,recovery_bytes=0,blocked_reason=NULL WHERE id=$1::uuid`, [id, keys, Number(locked.recovery_bytes)]);
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
    const retained=Math.min(Number(current.terminal_reservation),jsonBytes(current.authority)+jsonBytes(current.outcome??{})+(current.error_detail?jsonBytes(current.error_detail):0)+(current.client_request_id?.length??0)+Number(effects.bytes)+1024);
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
    request_id: row.request_id, ...(row.client_request_id ? { client_request_id: row.client_request_id } : {}), state: row.state,
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
