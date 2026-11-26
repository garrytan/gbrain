import { randomUUID } from 'node:crypto';
import { WRITE_SWITCHES, writeSwitchOn } from './switches.ts';
import type { BrainEngine } from '../engine.ts';
import { getCode } from '../retry-matcher.ts';
import { requireManagedPersistence, requireTransactions } from '../rust-engine/errors.ts';
import { assertRecoveryStagingAbsent } from './staging.ts';
import { markNotAdmitted, OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { digest, jsonBytes, requireUuid } from './digest.ts';
import { authorizeWrite } from './authority.ts';
import { journalLimitKey, oneYearCapacity, readJournalLimits, readReceiptRetentionDays } from './limits.ts';
import { outstandingCapacityDetail, retryWriteAdmission, waitOutRefreshFence } from './admission-retry.ts';
import { PreadmitBrainChanged } from './preadmit-cache.ts';
import { pipelined } from '../page-state/transactions.ts';
import { backgroundPaused, backgroundWorktreeInactive, declaredBackground, readBackgroundPauseShare, resolveAdmissionOrigin, type AdmissionOrigin } from './admission-origin.ts';
import { EFFECT_BYTES_SQL, RECEIPT_RESERVATION_FLOOR, receiptReservation, retainedReceiptBytes } from './receipt-bytes.ts';
import { writeHealth, type WriteHealthFacts } from './health.ts';
import { OWNER_READ_BUDGET_MS, startOwnerRead } from './owner-activity.ts';
import { assertBackgroundOwner } from './owner-verification.ts';
import { writerStamp } from './writer-versions.ts';
import { intentCarriesContent, intentCarriesPurgedContent } from './purged-intent.ts';
import { hostname } from 'node:os';
import { claimOwner, claimOwnerKind, claimPhaseStamp, startClaimPhase } from './claim-phase.ts';
import { CONSUMER_LIVE_MS, consumerIdentity, RESIDENT_CONSUMER_KINDS } from './consumer-heartbeat.ts';
import { classifyHolderLiveness, syncLockId } from '../db-lock.ts';
import { publicFailureDetail } from './publication-failure.ts';
import { ownerWidened } from '../search/private-visibility.ts';
import { catalogueError } from '../error-catalogue.ts';
import { refreshFenceClear, RELEASED_DEFERRED } from './worktree-refresh-schema.ts';
import { refreshProgress, refreshRetryHint, seconds } from './refresh-retry-hint.ts';
import { assertMutationProtocol, assertSharedSkillPersistence, declareDurablePersistence, declarePersistenceProtocol, isPersistenceDeclaration, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { assertGraduationAdmission } from './graduation-custody.ts';
import { schemaAdmissionRefusal } from './schema-admission.ts';
import { CAPACITY_VERIFY } from './capacity-verify.ts';
import { readManagedMode } from './managed-mode.ts';
import { hostIdFor } from './identity.ts';
import { MANAGED_SYNC_PASS_OP } from './sync-pass-row.ts';
import { BACKOFF_ELAPSED } from './transient-retry.ts';
import { segmentWriteScope } from '../page-body/ingest.ts';
import { sameAttestedActor } from '../access/member-facts.ts';
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
  /** #6712 PR 4b: the worktree owner epoch the caller resolved; admission refuses `source_changed` when it moved. */
  ownerEpoch?: string | number | null;
  requestId?: string;
  /** F6: the client's non-UUID request_id, stored beside the canonical id and never digested. */
  clientRequestId?: string;
  /** Normalized caller intent, excluding server-generated timestamp/TTL defaults. */
  callerIntent: Record<string, unknown>;
  intent: Record<string, unknown>;
  authority: WriteAuthority;
  terminalReservation?: number;
  /** #6696 (A5): who the write is for; unset is background unless a surrounding `withAdmissionOrigin` scope says otherwise. */
  origin?: AdmissionOrigin;
  /** Phase 4.2: the brain the cached pre-admission reads came from; admission under another brain throws PreadmitBrainChanged. */
  brainId?: string;
  /** PR B: the caller reports a pending receipt for a write deferred behind a refresh (page and memory verbs); others keep the refusal. */
  deferrable?: boolean;
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
/** #6696 (A5): a background admission of `ids` requests and `bytes` reservation refuses past the pause line of any locked counter. */
async function assertBackgroundRoom(tx: SqlEngine & Pick<BrainEngine, 'readAdmissionRate'>, counters: Counter[], limits: JournalLimits, ids: number, bytes: number): Promise<void> {
  const share = await readBackgroundPauseShare(tx);
  for (const row of counters) {
    const scope = row.key === 'brain' ? 'brain' : 'principal';
    for (const [resource, setting, used, need] of [['lifetime_ids', `${scope}LifetimeIds`, Number(row.lifetime_ids), ids],
      ['terminal_bytes', `${scope}TerminalBytes`, Number(row.terminal_bytes), bytes]] as const) {
      const limit = limits[setting];
      if (used + need <= Math.floor(limit * share)) continue;
      throw backgroundPaused(row.key, resource, used, limit, share, journalLimitKey(setting),
        await oneYearCapacity(tx, row.key, resource === 'lifetime_ids' ? 'LifetimeIds' : 'TerminalBytes', used, limit));
    }
  }
}
/**
 * `outstanding` (#6278): the outstanding-request cap carries its counts on `detail`
 * (`outstandingCapacityDetail`), so a caller that can wait for the other
 * requests to settle (the managed drain) knows how many stand in its way.
 */
export function capacityError(resource: string, outstanding?: { used: number; limit: number }): OperationError {
  const error = new OperationError('queue_capacity', `Write capacity exhausted: ${resource}.`,
    'Inspect writer status and configured persistence limits. Existing requests retain their reserved completion space.');
  if (outstanding) error.detail = outstandingCapacityDetail(outstanding.used, outstanding.limit);
  return error;
}
/**
 * #8368: the outstanding-request refusal for `row`, or null when the write may be admitted. The local CLI principal is
 * shared by every source's sync and maintenance on the host, so one source's requests that never settle could hold the
 * whole principal cap and starve every other source. At that cap, a source holding less than its fair share (the cap
 * divided by the sources holding outstanding requests on the principal, this one included) is still admitted; the brain
 * cap and every other principal's cap stay hard. The share is checked before the admission, so a sync publication group
 * larger than the share is admitted whole and a source passes its share by at most one group. A refusal names the source
 * holding the most slots. GST-1623: a managed sync job passes `held`, the counter's writes waiting in `deferred` (heldBehindImport). Deferred
 * writes hold slots like queued ones, so they count toward their source's share.
 */
async function outstandingRefusal(tx: Pick<BrainEngine, 'countOutstandingBySource'>, row: Counter, principal: Principal, sourceId: string, need: number, limit: number,
  held = 0): Promise<OperationError | null> {
  const used = Number(row.outstanding_count);
  if (used - held + need <= limit) return null;
  if (row.key === 'brain' || principal.kind !== 'local_cli') return capacityError(`${row.key === 'brain' ? 'brain' : 'principal'} outstanding requests`, { used, limit });
  const holders = await tx.countOutstandingBySource(principal.kind, principal.id);
  const own = holders.find(holder => holder.source_id === sourceId)?.n ?? 0;
  const sources = holders.length + (own > 0 ? 0 : 1);
  if (sources > 1 && own < Math.floor(limit / sources)) return null;
  const top = holders[0];
  return capacityError(`principal outstanding requests${top ? ` (source ${top.source_id} holds ${top.n})` : ''}`, { used, limit });
}
/**
 * GST-1623: the writes counted on `principal`'s counter (the brain's when null) that still wait in `deferred` on source
 * `sourceId`'s managed sync: held for its import, or deferred behind an unreleased refresh it is a member of (a refresh is
 * released only once all its members synced). They cannot settle before that sync, so its job is admitted as if they held
 * no slot; the importer can pass a cap by at most what they hold. Writes waiting on another source's sync, and released ones
 * about to settle, keep their slots (#8759). Read only when the plain check would refuse.
 */
async function heldBehindImport(tx: Pick<BrainEngine, 'countHeldBehindImport'>, principal: Principal | null, sourceId: string): Promise<{ count: number; bytes: number }> {
  requireManagedPersistence(tx, 'heldBehindImport', 'it counts the writes held behind a managed import or refresh');
  return tx.countHeldBehindImport(sourceId, principal ? { kind: principal.kind, id: principal.id } : null);
}
/** A managed sync job: the import itself, never deferred or refused behind a refresh that waits on it. */
const managedSyncJob = (input: Pick<WriteAdmission, 'operation' | 'intent'>) => input.operation === 'submit_job' && String(input.intent.kind ?? '').startsWith('managed_sync_');
/**
 * #6696 (A6): a cumulative cap refusal is `write_quota_exhausted` (host only;
 * waiting does not free a permanent id, and receipt bytes free only as
 * receipts compact). It names the config key and a value that covers one more
 * year at the current admission rate; `detail` keeps the limit key, `reason`
 * the resource.
 */
async function cumulativeCapacityError(tx: SqlEngine & Pick<BrainEngine, 'readAdmissionRate'>, resource: string, scope: string, setting: keyof JournalLimits, used: number, limit: number): Promise<OperationError> {
  const key = journalLimitKey(setting);
  const ids = setting.endsWith('LifetimeIds');
  const value = await oneYearCapacity(tx, scope, ids ? 'LifetimeIds' : 'TerminalBytes', used, limit);
  return quotaExhausted(resource, key, value, used, limit, ids ? 'lifetime_ids' : 'terminal_bytes');
}
/** The `write_quota_exhausted` refusal for config key `key`; the fix is the reversible raise, verified by the capacity check. */
export function quotaExhausted(resource: string, key: string, value: number, used: number, limit: number, reason: 'lifetime_ids' | 'terminal_bytes'): OperationError {
  return opError('write_quota_exhausted', `Write capacity exhausted: ${resource} (${used} used of ${limit}).`,
    `Run on the brain host: gbrain config set ${key} ${value} (covers about one more year at the current admission rate; undo with gbrain config unset ${key}). ` +
    `Keep the same request_id and retry after the change. Accepted request IDs and retained receipts are never evicted.${reason === 'terminal_bytes'
      ? ' Then gbrain repair receipt-compaction previews the retained receipt bytes compaction would free.' : ''}`,
    { reason, detail: key.slice('persistence.limits.'.length), docs: 'docs/guides/write-refusals.md#write_quota_exhausted',
      fix: { argv: ['gbrain', 'config', 'set', key, String(value)], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: reason === 'lifetime_ids' ? 'Request ids are permanent, so only a larger cap admits more writes; the raise is reversible.'
          : 'The raise unblocks writes at once and is reversible; compaction frees reserved bytes only over time.',
        verify: CAPACITY_VERIFY, docs: 'docs/guides/concurrent-writes.md#quota-near-exhaustion' } });
}
/**
 * Up-front refusal for a backfill that will admit `needed` new requests: when
 * the brain's or the principal's permanent request IDs cannot cover them, it
 * refuses with the same filled capacity command an admission would, before
 * the caller mutates anything.
 */
export async function assertLifetimeIdHeadroom(engine: SqlEngine & Pick<BrainEngine, 'readJournalLimitRows' | 'readCounterRows' | 'readAdmissionRate'>, principal: Principal, needed: number): Promise<void> {
  await assertWriteHeadroom(engine, principal, { ids: needed });
}
/**
 * #6696 (A7): a bulk run's preflight. `needed` is the run's estimate (new
 * request ids, and receipt bytes at `receiptReservation` each); `share` is the
 * producer's pause line (`backgroundPauseShare`) or 1 for an interactive run.
 * A cap already full refuses `write_quota_exhausted`; a cap that still admits
 * writes but cannot cover the run refuses `write_quota_insufficient`, both
 * with the config value that covers the run and one more year.
 */
export async function assertWriteHeadroom(engine: SqlEngine & Pick<BrainEngine, 'readJournalLimitRows' | 'readCounterRows' | 'readAdmissionRate'>, principal: Principal, needed: { ids: number; bytes?: number }, share = 1): Promise<void> {
  if (needed.ids <= 0 && !needed.bytes) return;
  const limits = await readJournalLimits(engine);
  const keys = ['brain', principalKey(principal)];
  const rows = await engine.readCounterRows(keys);
  for (const key of keys) {
    const scope = key === 'brain' ? 'brain' : 'principal';
    for (const [resource, setting, need, label] of [['lifetime_ids', `${scope}LifetimeIds`, needed.ids, 'permanent request IDs'],
      ['terminal_bytes', `${scope}TerminalBytes`, needed.bytes ?? 0, 'reserved receipt bytes']] as const) {
      if (need <= 0) continue;
      const used = Number(rows.find(row => row.key === key)?.[resource] ?? 0);
      const limit = limits[setting];
      if (used + need <= Math.floor(limit * share)) continue;
      if (used + (resource === 'lifetime_ids' ? 1 : RECEIPT_RESERVATION_FLOOR) > limit) {
        throw await cumulativeCapacityError(engine, `${scope} ${label}`, key, setting, used, limit);
      }
      const configKey = journalLimitKey(setting);
      const value = Math.max(Math.ceil((used + need) / share) + 1, await oneYearCapacity(engine, key, resource === 'lifetime_ids' ? 'LifetimeIds' : 'TerminalBytes', used, limit));
      throw opError('write_quota_insufficient', `This run needs ${need} more ${scope} ${label} than the ${Math.floor(limit * share) - used} left before its limit (${used} used of ${limit}${share < 1 ? `, pausing at ${Math.round(share * 100)}%` : ''}).`,
        `Nothing was started and other writes still work. Run on the brain host: gbrain config set ${configKey} ${value} (undo with gbrain config unset ${configKey}), then rerun the same command.`,
        { reason: resource, detail: configKey.slice('persistence.limits.'.length), docs: 'docs/guides/write-refusals.md#write_quota_insufficient',
          fix: { argv: ['gbrain', 'config', 'set', configKey, String(value)], consent: [], actor: 'host_admin', requires_exclusive: false,
            why: 'Covers this run and about one more year at the current rate; reversible.', verify: CAPACITY_VERIFY } });
    }
  }
}
/**
 * #6884: how many more requests `principal` can have outstanding before the tighter of its own and the brain's
 * outstanding caps, each taken at `share` (a background run stops at the pause line), with that cap's counts.
 */
export async function readOutstandingRoom(engine: SqlEngine & Pick<BrainEngine, 'readJournalLimitRows' | 'readCounterRows'>, principal: Principal, share = 1): Promise<{ room: number; scope: 'brain' | 'principal'; used: number; limit: number }> {
  const limits = await readJournalLimits(engine);
  const rows = await engine.readCounterRows(['brain', principalKey(principal)]);
  const room = (scope: 'brain' | 'principal', key: string, cap: number) => {
    const used = Number(rows.find(row => row.key === key)?.outstanding_count ?? 0), limit = Math.floor(cap * share);
    return { room: limit - used, scope, used, limit };
  };
  const brain = room('brain', 'brain', limits.brainOutstanding), own = room('principal', principalKey(principal), limits.principalOutstanding);
  return brain.room < own.room ? brain : own;
}
/** Creates and locks the counter rows in key order: two statements for any number of keys (#5984 round-trip diet). */
// The counter statements live in engine-sql (the engines run them); page-upload.ts and group-publish.ts send them as text.
export { ENSURE_COUNTERS_SQL, LOCK_COUNTERS_SQL } from '../engine-sql/persistence-journal.ts';
export async function lockCounters(tx: Pick<BrainEngine, 'lockPersistenceCounters'>, keys: string[]): Promise<Counter[]> {
  return tx.lockPersistenceCounters(keys);
}
export async function getWriteRequest(engine: Pick<BrainEngine, 'readWriteRequest'>, principal: Principal, requestId: string): Promise<WriteRequest | null> {
  return engine.readWriteRequest(principal.kind, principal.id, requireUuid(requestId));
}
/** Resolve other operation domains before repeating target/provider preparation. */
export async function assertPageRequestIdentity(engine: Pick<BrainEngine, 'readTopologyChange'>, principal: Principal, requestId: string): Promise<void> {
  if (principal.kind !== 'local_cli') return;
  if (await engine.readTopologyChange(principal.id, requireUuid(requestId))) throw lifecycleIdConflict(requestId);
}
export async function getWriteRequestById(engine: Pick<BrainEngine, 'readWriteRequestById'>, id: string, signal?: AbortSignal): Promise<WriteRequest | null> {
  return engine.readWriteRequestById(id, { signal });
}
/** #5984: the progress columns a waiter polls (engine-sql/persistence-journal.ts `readWriteRequestProgress`). */
export { WRITE_PROGRESS_SQL, type WriteRequestProgress } from '../engine-sql/persistence-journal.ts';
import type { CompletedWriteRow, WriteCompletion, WriteRequestProgress } from '../engine-sql/persistence-journal.ts';
import { syncRows } from '../engine-sql/managed-sync-store.ts';
import { bindClaimFence, claimFenceOpts, fenceFor, fenceOpts } from './host-fence.ts';
export async function getWriteRequestProgress(engine: Pick<BrainEngine, 'readWriteRequestProgress'>, id: string, signal?: AbortSignal): Promise<WriteRequestProgress | null> {
  return engine.readWriteRequestProgress(id, { signal });
}
export function intentDigest(a: Pick<WriteAdmission, 'operation' | 'sourceId' | 'slug' | 'callerIntent'>): string {
  return digest({ operation: a.operation, source_id: a.sourceId, slug: a.slug, intent: a.callerIntent });
}
export function assertReplayIntent(row: WriteRequest, expectedDigest: string): WriteRequest {
  // GST-359 C2: a request_id another person's attested write used is a different write, never a replay of it.
  if (row.digest !== expectedDigest || !sameAttestedActor(row.authority?.actingFor)) throw opError('idempotency_conflict', 'This request_id was used for a different write; send a new one or omit it.',
    'A request_id is reused only to retry the same write. Send this write again with a new request_id or without one; the earlier write keeps its receipt.',
    { fix: readFix(`Reads the earlier write's receipt (request ${row.request_id}), read-only.`, row.principal_kind === 'local_cli'
      ? { argv: ['gbrain', 'write-request', '--', row.request_id] }
      : { mcp: { tool: 'get_write_request', arguments: { request_id: row.client_request_id ?? row.request_id } } }) });
  return row;
}
export async function admitWrite(engine: BrainEngine, input: WriteAdmission, overrides?: Partial<JournalLimits>,
  transaction: <T>(fn: (tx: BrainEngine) => Promise<T>) => Promise<T> = fn => engine.transaction(fn, { pipelineFirst: isPersistenceDeclaration })): Promise<WriteRequest> {
  const { requestId, apply } = await prepareAdmission(engine, input, overrides);
  // #6355: a lent connection (the consumer's warm lane) whose session dropped is dead for every later attempt, so the
  // re-run takes a transaction from the engine's pool after the pool itself is rebuilt.
  let run = transaction;
  // GST-1387: an interactive write waits out a refresh fence (bounded), re-running its whole admission.
  return waitOutRefreshFence(resolveAdmissionOrigin(input.origin) === 'interactive', () => retryWriteAdmission(requestId, remaining => run(async tx => {
    const brain = await declareDurablePersistence(tx, `${Math.min(100, remaining)}ms`, `${remaining}ms`);
    if (input.brainId !== undefined && brain !== input.brainId) throw new PreadmitBrainChanged();
    return apply(tx);
  }), undefined, async error => { run = fn => engine.transaction(fn, { pipelineFirst: isPersistenceDeclaration }); await engine.reconnect({ error }); }));
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
  const terminalBytes = Math.max(input.terminalReservation ?? 0, receiptReservation(input));
  if (!Number.isSafeInteger(terminalBytes) || terminalBytes < 1024) throw new TypeError('Invalid terminal receipt reservation.');
  const stamp = writerStamp({ engine });
  const origin = resolveAdmissionOrigin(input.origin);
  if (input.worktreeId) requireManagedPersistence(engine, 'admitWrite', 'a write to a managed worktree checks its refresh fence, owner and binding');
  // #6741 C: a declared background producer is refused before any receipt when the source's owner fails its verification.
  if (input.worktreeId && declaredBackground(input.origin)) await assertBackgroundOwner(engine, input.sourceId, ownerStatusFix);
  const barrier = !!input.worktreeId && deferrable(input) && await readRefreshBarrier(engine);
  return { requestId, apply: async (tx: BrainEngine): Promise<WriteRequest> => {
    await declarePersistenceProtocol(tx);
    // The guards are sent together in lock order (worktree, source, writer, counters) and judged in
    // that order: the first refusal in this list is the one reported, as when they ran one by one.
    let deferTo: string | null = null;
    const [, , , , , counters, topology, prior] = await pipelined(tx, [
      () => assertGraduationAdmission(tx),
      async () => assertMutationProtocol({ target_kind: input.targetKind, protocol_version: input.protocolVersion }),
      async () => { if (input.worktreeId) deferTo = await assertWorktreeAdmission(tx, input, true, barrier); },
      // Source membership is locked before principal/counter/request guards. A
      // deleted/recreated source never receives work accepted for its old identity.
      async () => {
        const source = await tx.readSourceMembership(input.sourceId, { lock: true });
        if (!source || source.archived || source.incarnation !== input.sourceIncarnation) {
          throw new OperationError('source_changed', 'The write source is missing, archived, or was replaced.', 'Resolve the source again and submit a new request.');
        }
      },
      () => authorizeWrite(tx, input.authority, input.operation, input.slug, true),
      () => lockCounters(tx, ['brain', principalKey(input.principal)]),
      () => input.principal.kind === 'local_cli' ? tx.findTopologyChanges(input.principal.id, [requestId]) : Promise.resolve([]),
      () => getWriteRequest(tx, input.principal, requestId),
    ]) as [unknown, unknown, unknown, unknown, unknown, Counter[], unknown[], WriteRequest | null];
    if (topology.length) throw lifecycleIdConflict(requestId);
    if (prior) {
      if ((prior.target_kind ?? 'page') !== (input.targetKind ?? 'page') || (prior.protocol_version ?? 1) !== (input.protocolVersion ?? 1)) {
        throw opError('idempotency_conflict', 'This request_id belongs to a different mutation target or protocol.',
          `Request ID ${requestId} was already accepted for a ${prior.target_kind ?? 'page'} write (protocol ${prior.protocol_version ?? 1}), so this ${input.targetKind ?? 'page'} write was not admitted. Read the original request${prior.principal_kind === 'local_cli' ? ' with the command in fix' : ' with get_write_request'} if you meant to replay it; otherwise submit this write with a new request_id.`,
          prior.principal_kind === 'local_cli' ? { fix: requestInspectFix(prior) } : {});
      }
      return assertReplayIntent(prior, fingerprint);
    }
    // #6904: only after a replay returned, so an accepted request id reconciles whatever the schema reads.
    const schemaRefusal = await schemaAdmissionRefusal(tx);
    if (schemaRefusal) throw schemaRefusal;
    if (input.targetKind === 'skill_bundle') await assertSharedSkillPersistence(tx, input.sourceId);
    for (const row of counters) {
      const brain = row.key === 'brain';
      const countLimit = brain ? limits.brainOutstanding : limits.principalOutstanding, bytesLimit = brain ? limits.brainIntentBytes : limits.principalIntentBytes;
      const fits = Number(row.outstanding_count) + 1 <= countLimit && Number(row.intent_bytes) + bytes <= bytesLimit;
      const held = managedSyncJob(input) && !fits ? await heldBehindImport(tx, brain ? null : input.principal, input.sourceId) : { count: 0, bytes: 0 };
      const outstanding = await outstandingRefusal(tx, row, input.principal, input.sourceId, 1, countLimit, held.count);
      if (outstanding) throw outstanding;
      if (Number(row.intent_bytes) - held.bytes + bytes > bytesLimit) throw capacityError(`${brain ? 'brain' : 'principal'} intent bytes`);
      const scope = brain ? 'brain' : 'principal';
      if (Number(row.lifetime_ids) + 1 > limits[`${scope}LifetimeIds`]) throw await cumulativeCapacityError(tx, `${scope} permanent request IDs`,
        row.key, `${scope}LifetimeIds`, Number(row.lifetime_ids), limits[`${scope}LifetimeIds`]);
      if (Number(row.terminal_bytes) + terminalBytes > limits[`${scope}TerminalBytes`]) throw await cumulativeCapacityError(tx, `${scope} reserved receipt bytes`,
        row.key, `${scope}TerminalBytes`, Number(row.terminal_bytes), limits[`${scope}TerminalBytes`]);
    }
    if (origin === 'background') await assertBackgroundRoom(tx, counters, limits, 1, terminalBytes);
    // The request row and its counter reservation in one statement; the counters are already locked.
    return tx.insertWriteRequest({ principalKind: input.principal.kind, principalId: input.principal.id, requestId, operation: input.operation,
      sourceId: input.sourceId, sourceIncarnation: input.sourceIncarnation, pageId: input.pageId ?? null, slug: input.slug, worktreeId: input.worktreeId ?? null,
      topologyGeneration: input.topologyGeneration ?? null, digest: fingerprint, intent: input.intent, authority: input.authority, intentBytes: bytes,
      terminalReservation: terminalBytes, targetKind: input.targetKind ?? 'page', protocolVersion: input.protocolVersion ?? 1, admitterVersion: stamp.version,
      admitterHostId: stamp.hostId, counterKeys: counters.map(c => c.key), clientRequestId: input.clientRequestId ?? null, state: deferTo ? 'deferred' : 'queued',
      deferredRefreshId: deferTo });
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
  if (first.worktreeId) requireManagedPersistence(tx, 'admitWriteGroupInTransaction', 'a grouped admission to a managed worktree checks its refresh fence, owner and binding');
  if (inputs.some(input => input.sourceId !== first.sourceId || input.sourceIncarnation !== first.sourceIncarnation || input.worktreeId !== first.worktreeId
    || String(input.topologyGeneration) !== String(first.topologyGeneration) || input.principal.kind !== first.principal.kind || input.principal.id !== first.principal.id
    || input.operation !== first.operation || (input.targetKind ?? 'page') !== 'page' || (input.protocolVersion ?? 1) !== 1 || digest(input.authority) !== digest(first.authority))) {
    throw new TypeError('A group admission requires one source, worktree, principal, operation and authority.');
  }
  const stamp = writerStamp({ engine: tx });
  const items = inputs.map(input => ({ input, requestId: requireUuid(input.requestId ?? randomUUID()), fingerprint: intentDigest(input),
    bytes: jsonBytes(input.intent) + jsonBytes(input.authority), terminalBytes: Math.max(input.terminalReservation ?? 0, receiptReservation(input)) }));
  assertMutationProtocol({ target_kind: 'page', protocol_version: 1 });
  if (first.worktreeId && declaredBackground(first.origin)) await assertBackgroundOwner(tx, first.sourceId, ownerStatusFix);
  const ids = items.map(item => item.requestId);
  // #5984: the checks are independent reads and share locks, so they go out back to back in the order they always
  // had (protocol, graduation, worktree, source, writer, counters); a failure is raised in that order.
  const [limits, , , , sources, , counters, topology, priorRows] = await pipelined(tx, [
    () => readJournalLimits(tx, overrides),
    () => declarePersistenceProtocol(tx),
    () => assertGraduationAdmission(tx),
    () => first.worktreeId ? assertWorktreeAdmission(tx, first) : Promise.resolve(),
    () => tx.readSourceMembership(first.sourceId, { lock: true }).then(source => source ? [source] : []),
    () => Promise.all(items.map(({ input }) => authorizeWrite(tx, input.authority, input.operation, input.slug, true))),
    () => lockCounters(tx, ['brain', principalKey(first.principal)]),
    () => first.principal.kind === 'local_cli' ? tx.findTopologyChanges(first.principal.id, ids) : Promise.resolve([]),
    () => tx.readWriteRequestsByRequestIds(first.principal.kind, first.principal.id, ids),
  ]) as [JournalLimits, unknown, unknown, unknown, Array<{ incarnation: string; archived: boolean }>, unknown, Counter[], Array<{ request_id: string }>, WriteRequest[]];
  const [source] = sources;
  if (!source || source.archived || source.incarnation !== first.sourceIncarnation) {
    throw new OperationError('source_changed', 'The write source is missing, archived, or was replaced.', 'Resolve the source again and submit a new request.');
  }
  if (topology[0]) throw lifecycleIdConflict(topology[0].request_id);
  const priors = new Map(priorRows.map(row => [row.request_id, row]));
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
    const schemaRefusal = await schemaAdmissionRefusal(tx);
    if (schemaRefusal) throw schemaRefusal;
    const bytes = fresh.reduce((sum, item) => sum + item.bytes, 0), terminalBytes = fresh.reduce((sum, item) => sum + item.terminalBytes, 0);
    const syncGroup = fresh.every(item => managedSyncJob(item.input));
    for (const row of counters) {
      const brain = row.key === 'brain', scope = brain ? 'brain' : 'principal';
      const countLimit = brain ? limits.brainOutstanding : limits.principalOutstanding, bytesLimit = brain ? limits.brainIntentBytes : limits.principalIntentBytes;
      const fits = Number(row.outstanding_count) + fresh.length <= countLimit && Number(row.intent_bytes) + bytes <= bytesLimit;
      const held = syncGroup && !fits ? await heldBehindImport(tx, brain ? null : first.principal, first.sourceId) : { count: 0, bytes: 0 };
      const outstanding = await outstandingRefusal(tx, row, first.principal, first.sourceId, fresh.length, countLimit, held.count);
      if (outstanding) throw outstanding;
      if (Number(row.intent_bytes) - held.bytes + bytes > bytesLimit) throw capacityError(`${scope} intent bytes`);
      if (Number(row.lifetime_ids) + fresh.length > limits[`${scope}LifetimeIds`]) throw await cumulativeCapacityError(tx, `${scope} permanent request IDs`,
        row.key, `${scope}LifetimeIds`, Number(row.lifetime_ids), limits[`${scope}LifetimeIds`]);
      if (Number(row.terminal_bytes) + terminalBytes > limits[`${scope}TerminalBytes`]) throw await cumulativeCapacityError(tx, `${scope} reserved receipt bytes`,
        row.key, `${scope}TerminalBytes`, Number(row.terminal_bytes), limits[`${scope}TerminalBytes`]);
    }
    if (resolveAdmissionOrigin(first.origin) === 'background') await assertBackgroundRoom(tx, counters, limits, fresh.length, terminalBytes);
    // The rows and their counter charge go in one statement (engine-sql/persistence-journal.ts ADMIT_WRITE_GROUP_SQL).
    const rows = await tx.insertWriteRequestGroup({ principalKind: first.principal.kind, principalId: first.principal.id, operation: first.operation,
      sourceId: first.sourceId, sourceIncarnation: first.sourceIncarnation, worktreeId: first.worktreeId ?? null, topologyGeneration: first.topologyGeneration ?? null,
      authority: first.authority, admitterVersion: stamp.version, admitterHostId: stamp.hostId, counterKeys: counters.map(c => c.key),
      items: fresh.map(item => ({ requestId: item.requestId, pageId: item.input.pageId ?? null, slug: item.input.slug, digest: item.fingerprint,
        intent: item.input.intent, intentBytes: item.bytes, terminalReservation: item.terminalBytes, clientRequestId: item.input.clientRequestId ?? null })) });
    for (const row of rows) priors.set(row.request_id, row);
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
 * The publication group key of a request: a bulk sync's `intent.group`, the
 * batch id of a `put_pages` child or of an `add_timeline_entry` admitted in
 * the same batch (`intent.page_batch.id`, #6007), the batch id of a managed
 * file import (`intent.import_batch`), the batch id of a maintenance run's
 * page publications (`intent.maintenance_batch`, G6), or the activation id of
 * a managed atom generation (its page members and its activation, G6). Null
 * when it publishes alone. GROUP_KEY_SQL below is the same function in SQL.
 *
 * Every key is an independent group (`independentGroup`): one member's failure
 * never cancels another. A maintenance batch is a set of unrelated page
 * rewrites. An atom generation is already published one request at a time and
 * crash-tolerant member by member (generations/managed.ts): creates land before
 * the activation (an activation that never happens leaves orphan candidates),
 * and overwrite and retire members each refuse unless pending on the live
 * activated generation, a crash between them resuming on the next run. So a
 * generation may activate with some members still pending; a member that fails
 * in its group publishes or fails alone, exactly as it would ungrouped.
 */
export function publicationGroupKey(row: Pick<WriteRequest, 'operation' | 'intent'>): string | null {
  if (typeof row.intent?.group === 'string') return `sync:${row.intent.group}`;
  const kind = row.intent?.kind;
  if (row.operation === 'submit_job') {
    if (kind === 'managed_maintenance_page') return typeof row.intent!.maintenance_batch === 'string' ? `maintenance:${row.intent!.maintenance_batch}` : null;
    const atom = kind === 'managed_atom_page' || kind === 'managed_atom_delete'
      || kind === 'managed_generation_activate' && (row.intent!.key as { kind?: unknown } | undefined)?.kind === 'atom';
    return atom && typeof row.intent!.activationId === 'string' ? `generation:${row.intent!.activationId}` : null;
  }
  if (row.operation === 'put_page' && kind === 'managed_file_import') return typeof row.intent!.import_batch === 'string' ? `import:${row.intent!.import_batch}` : null;
  if (row.operation !== 'put_page' && row.operation !== 'add_timeline_entry') return null;
  const batch = row.intent?.page_batch as { id?: unknown } | undefined;
  return !kind && typeof batch?.id === 'string' ? `batch:${batch.id}` : null;
}
/** Groups whose members are independent page writes: one member's failure never cancels the others (see publicationGroupKey). */
export function independentGroup(key: string | null): boolean {
  return key !== null && ['batch:', 'import:', 'maintenance:', 'generation:'].some(prefix => key.startsWith(prefix));
}
/** #6712: a bulk managed-sync group key; such a group claims up to its admitted size (63 followers) and prepares four members at a time. */
export function syncGroup(key: string | null): boolean {
  return key !== null && key.startsWith('sync:');
}
/** publicationGroupKey in SQL, over a persistence_requests row (test/git-door-g6-publication-groups.test.ts holds them equal). */
export const GROUP_KEY_SQL = `CASE WHEN jsonb_typeof(intent->'group')='string' THEN 'sync:'||(intent->>'group')
  WHEN operation='submit_job' AND intent->>'kind'='managed_maintenance_page' AND jsonb_typeof(intent->'maintenance_batch')='string' THEN 'maintenance:'||(intent->>'maintenance_batch')
  WHEN operation='submit_job' AND (intent->>'kind' IN ('managed_atom_page','managed_atom_delete')
    OR intent->>'kind'='managed_generation_activate' AND intent->'key'->>'kind'='atom') AND jsonb_typeof(intent->'activationId')='string' THEN 'generation:'||(intent->>'activationId')
  WHEN operation='put_page' AND intent->>'kind'='managed_file_import' AND jsonb_typeof(intent->'import_batch')='string' THEN 'import:'||(intent->>'import_batch')
  WHEN operation IN ('put_page','add_timeline_entry') AND NOT (intent ? 'kind') AND jsonb_typeof(intent->'page_batch'->'id')='string' THEN 'batch:'||(intent->'page_batch'->>'id') END`;
export async function claimGroupFollowers(engine: BrainEngine, head: WriteRequest, group: string, max: number, leaseMs = 30_000): Promise<WriteRequest[]> {
  if (!head.worktree_id || max <= 0) return [];
  return engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    // #5984 G6: only the group's candidate prefix is locked. Locking every next row also held a foreground write's row
    // (the first non-member) for the claim's round trips, so its recovery record and reads waited on the lane.
    // #6278: a follower carries no phase until its wave dispatches it (`markDispatched`), so an undispatched follower is never
    // charged. #6650: it does carry its token, owner and claim time, so a consumer that proves the owner dead reclaims it with
    // the head, and writer status and doctor age the claim from when it was taken.
    return (await tx.groupPublishStore()).claimFollowers({ worktree_id: head.worktree_id!, sequence: head.sequence }, group, max, leaseMs, claimOwner(), fenceOpts(tx));
  });
}

/**
 * Renews every claim of a group in one statement; returns the ids still held.
 * `stamps` (#6176/#6278) are the members' `claimPhaseStamp`s in `rows` order
 * (null keeps a member's recorded stamp, for one not yet dispatched); a single
 * string is stamped on every member with its own token.
 */
export async function renewGroupClaims(engine: Pick<BrainEngine, 'groupPublishStore'>, rows: WriteRequest[], leaseMs = 30_000, signal?: AbortSignal,
  stamps: string | null | Array<string | null> = null): Promise<Set<string>> {
  const perMember = Array.isArray(stamps) ? stamps.map(stamp => stamp ?? null) : rows.map(() => stamps);
  const held = await (await engine.groupPublishStore()).renewClaims(rows.map((row, i) => ({ id: row.id, token: row.execution_token!, stamp: perMember[i] ?? null })), leaseMs, { signal, ...fenceOpts(engine) });
  return new Set(held);
}
/**
 * #6278: a group's dispatch mark. Before a wave of members starts preparing,
 * each member's `preparing` stamp (its own token, start and step) is stored,
 * so a kill before the first renewal still charges exactly the members that
 * were preparing (the expired-claim reclaim, consumer.ts and effect-journal.ts)
 * and never an undispatched follower. Returns the ids whose claim still held.
 */
export async function markDispatched(engine: Pick<BrainEngine, 'groupPublishStore'>, members: Array<{ row: WriteRequest; stamp: string }>, signal?: AbortSignal): Promise<Set<string>> {
  if (!members.length) return new Set();
  const marked = await (await engine.groupPublishStore()).markDispatched(members.map(m => ({ id: m.row.id, token: m.row.execution_token!, stamp: m.stamp })), { signal, ...fenceOpts(engine) });
  return new Set(marked);
}
/**
 * #6278: an abandoned preparation overran the hard ceiling, which proves it
 * ignored cancellation: its request's counter is set to the limit so the next
 * claim finishes it `preparation_stalled`. Token-free (the claim was released
 * at the budget), terminal rows are left alone.
 */
export async function floorPreparationAttempts(engine: SqlEngine, id: string, limit: number): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_requests SET preparation_attempts=GREATEST(preparation_attempts,$2::integer),updated_at=now()
    WHERE id=$1::uuid AND state IN ('queued','running') AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, [id, limit]);
}
/** #6278: charges one preparation attempt to a claim this owner still holds (before finishing it `preparation_stalled`). */
export async function chargePreparationAttempt(engine: SqlEngine, row: WriteRequest): Promise<number> {
  const [charged] = await engine.executeRaw<{ preparation_attempts: number }>(`UPDATE persistence_requests SET preparation_attempts=preparation_attempts+1,updated_at=now()
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING preparation_attempts`, [row.id, row.execution_token]);
  return charged?.preparation_attempts ?? (row.preparation_attempts ?? 0) + 1;
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
async function assertWorktreeAdmission(tx: BrainEngine, input: WriteAdmission, replayable = false, barrier = false): Promise<string | null> {
  // Sent together: the server takes the share lock before it reads the fence and the binding. PR B: with the barrier on, the
  // active refresh row is locked right after the worktree (protocol.ts lock order), so a deferral and the refresh's terminal
  // transition serialize on it, and the syncing completion below upgrades no lock.
  const { worktree, refresh, bound } = await tx.readWorktreeAdmission({ worktreeId: input.worktreeId!, sourceId: input.sourceId,
    sourceIncarnation: input.sourceIncarnation!, topologyGeneration: input.topologyGeneration }, { lockRefresh: barrier });
  const deferTo = refresh ? await assertWorktreeNotRefreshing(tx, input, refresh, replayable, barrier) : null;
  // #6741 C: a background producer never takes a permanent request id against a worktree in recovery (a draining owner still replays).
  if (worktree?.state === 'recovering' && resolveAdmissionOrigin(input.origin) === 'background') throw backgroundWorktreeInactive(input.sourceId, worktree.state, ownerStatusFix(input.sourceId));
  if (!bound || input.ownerEpoch != null && worktree && worktree.owner_epoch !== String(input.ownerEpoch)) throw opError('source_changed', 'The source binding changed during admission.',
    `Source ${input.sourceId}'s worktree binding changed (a claim, transfer or lifecycle change) while this write was being admitted, so nothing was accepted. Check the owner with the command in fix, then submit the write again; reusing the same request_id is safe because nothing was recorded.`,
    { fix: ownerStatusFix(input.sourceId) });
  return deferTo;
}

/** What a consumer advertises (consumer-heartbeat.ts CONSUMER_CAPABILITIES) and admission requires of every live one on the owner host. */
export const REFRESH_BARRIER_CAPABILITY = 'refresh_barrier_1';
/** GST-1582: a consumer that claims a write held for an import (`deferred_import_from`); an older one would stall on it. */
export const IMPORT_HOLD_CAPABILITY = 'refresh_barrier_import_1';
/** A single page write whose caller opted in may wait behind a refresh; jobs (managed sync included), grouped batches and skill bundles keep the refusal. */
function deferrable(input: WriteAdmission): boolean {
  return input.deferrable === true && (input.targetKind ?? 'page') === 'page' && input.operation !== 'submit_job' && publicationGroupKey({ operation: input.operation, intent: input.intent }) === null;
}
/** PR B: whether the refresh barrier is on (docs/designs/REFRESH_WRITE_BARRIER.md). */
async function readRefreshBarrier(engine: BrainEngine): Promise<boolean> {
  requireManagedPersistence(engine, 'readRefreshBarrier', 'a write may wait behind a managed refresh');
  return writeSwitchOn(engine, 'refresh_barrier').catch(() => false);
}
/**
 * Every live consumer of the worktree's owner host can drain a deferred write. GST-1582: there is no per-refresh cap; the
 * journal's outstanding and byte limits bound deferred writes like queued ones.
 */
export async function deferralRoom(tx: Pick<BrainEngine, 'hasDeferralRoom'>, worktreeId: string, capability: string = REFRESH_BARRIER_CAPABILITY): Promise<boolean> {
  return tx.hasDeferralRoom(worktreeId, capability, CONSUMER_LIVE_MS);
}
/** The refresh to defer this write behind, or null when it is admitted normally; otherwise refuses. */
async function assertWorktreeNotRefreshing(tx: BrainEngine, input: WriteAdmission, refresh: { id: string; state: string; source_ids: string[] }, replayable: boolean,
  barrier: boolean): Promise<string | null> {
  if (refresh.state === 'syncing' && managedSyncJob(input)) return null;
  if (refresh.state === 'syncing') {
    if (await tx.completeSyncedRefresh(refresh.id)) return null;
  }
  // A single write's replay of a request already accepted (its acknowledgement lost before the fence) reconciles to its
  // receipt instead; a group admission never bypasses, since its other items may be new. GST-1623: checked before any
  // deferral, so a replay never waits behind a refresh as if it were new.
  if (replayable && input.requestId && await getWriteRequest(tx, input.principal, input.requestId)) return null;
  // GST-1582: with the barrier on, a write waits behind a refresh awaiting recovery too, and lands once it is released.
  if (refresh.state === 'recovery_required' && barrier && input.worktreeId && await deferralRoom(tx, input.worktreeId)) return refresh.id;
  if (refresh.state === 'recovery_required') throw catalogueError('refresh_recovery_required',
    `Refresh ${refresh.id} could not verify the checkout HEAD of source ${input.sourceId}; writes to its worktree stay fenced.`,
    `gbrain sources writer status ${input.sourceId}, then gbrain sources refresh ${input.sourceId} --resume. Retry the same request_id afterwards.`);
  // PR B: with the barrier on, the write waits behind the refresh as a deferred request instead of being refused.
  if (barrier && input.worktreeId && await deferralRoom(tx, input.worktreeId)) return refresh.id;
  // GST-1582: the retry hint comes from the refresh's own state (its phase, how long it has run, how long this worktree's
  // refreshes typically take), never a fixed second that sends the caller back into the same refresh.
  const hint = await refreshRetryHint(tx, refresh);
  // GST-2353: the retry names the id this write was refused under (minted when the caller sent none), so it can be reused.
  const retryWith = input.requestId ? `Retry with request_id ${input.requestId}` : 'Retry the same call';
  const error = catalogueError('worktree_refreshing',
    `This write was not saved: refresh ${refresh.id} is fast-forwarding source ${input.sourceId}'s checkout (${refreshProgress(hint)}). ${retryWith} in about ${seconds(hint.retryAfterMs)} s.`,
    `${retryWith} after retry_after_ms: ${hint.retryAfterMs}. Check progress with gbrain sources writer status ${input.sourceId}.`);
  error.detail = `retry_after_ms=${hint.retryAfterMs}`;
  error.retryable = true;
  if (input.requestId) error.requestId = input.requestId;
  // GST-1387: nothing was recorded, so the same call is retried after the delay (actor provider renders next: wait).
  error.fix = { argv: ['gbrain', 'sources', 'writer', 'status', '--source', input.sourceId, '--json'], consent: [], actor: 'provider', requires_exclusive: false,
    why: `A refresh of source ${input.sourceId}'s checkout holds its writes until it finishes syncing; this write was not recorded. Repeat the same call${input.requestId ? ` with request_id ${input.requestId}` : ''} after about ${seconds(hint.retryAfterMs)} s (retry_after_ms=${hint.retryAfterMs}); this read-only command shows the refresh's progress.` };
  throw markNotAdmitted(error);
}

/**
 * An unfinished row ahead of `r` on its root that `r` may not pass. The root (a worktree, or a
 * database-only incarnation) is matched by the caller with columns the pending indexes cover,
 * so each probe is an index range scan rather than a walk of every pending row.
 */
export const EARLIER_HEAD = (earlier: string, r: string, priority: string, laneRoots: string) => `${earlier}.sequence<${r}.sequence
        AND ${earlier}.state IN ('queued','running','recovering') AND NOT ${PASSES_QUEUED_SYNC(earlier, r, priority, laneRoots)}`;
/**
 * PR B: a released deferred write ahead of `r` on its worktree, a page write that is never a sync row, so nothing passes it.
 * A probe of its own (the deferred partial index), so `EARLIER_HEAD` stays a range scan of the pending index.
 */
export const EARLIER_DEFERRED = (earlier: string, r: string) => `${earlier}.sequence<${r}.sequence AND ${RELEASED_DEFERRED(earlier)}`;
/** Sets the session flag the v292 deferred-row guard requires of a claim that moves a deferred row to running. */
export const REFRESH_BARRIER_CLAIM_PREDICATE = "set_config('gbrain.refresh_barrier','1',true)='1'";
/**
 * The rows `claimNextWrite` may claim, over `persistence_requests r LEFT JOIN
 * persistence_worktrees w`, with $1 = host id and $2 = excluded root keys. An
 * unresolved head blocks its entire root. A worktree under a refresh fence
 * (`fenced`, `merged`, `recovery_required`) claims nothing. A file write also waits for an
 * unfinished withdrawal mirror of its page (of every page, for an untargeted
 * mirror), so the mirror never rewrites a file under an accepted request.
 */
export const SYNC_KIND = (row: string) => `COALESCE(${row}.intent->>'kind','') LIKE 'managed_sync_%'`;
/** Whether sync row `sync` names the page of request `write`: its slug, page id or rename source. */
const NAMES_PAGE = (sync: string, write: string) => `(${sync}.source_id=${write}.source_id AND (${sync}.slug=${write}.slug
  OR ${sync}.page_id=${write}.page_id OR ${sync}.intent->'renameFrom'->>'slug'=${write}.slug))`;
/**
 * #5984 Phase 4.5 (with `priority`, the `foreground_priority` switch): a foreground request passes an earlier
 * sync row that has not started and does not name its page. Running and recovering rows, recovery records and
 * a sync row naming the page still come first; a passed sync row waits until the foreground request finishes.
 */
const PASSES_QUEUED_SYNC = (earlier: string, r: string, priority: string, laneRoots: string) => `((${priority}) AND NOT ${SYNC_KIND(r)}
  AND (${earlier}.state='queued' OR (${earlier}.state='running' AND ${earlier}.intent ? 'lane'
    AND ${earlier}.worktree_id::text=ANY(${laneRoots})))
  AND ${earlier}.recovery IS NULL AND ${SYNC_KIND(earlier)} AND NOT ${NAMES_PAGE(earlier, r)})`;
/**
 * The rows `claimNextWrite` may claim, over `persistence_requests r LEFT JOIN
 * persistence_worktrees w`, with $1 = host id and $2 = excluded root keys and
 * `priority` the SQL condition of the `foreground_priority` switch. An
 * unresolved head blocks its entire root. `laneRoots` (an SQL text[]) names the worktrees whose lane groups
 * run in the claiming process: there a foreground write also passes running lane groups that do not name its
 * page and publishes beside them on the process's shared worktree lock (group-publish.ts).
 */
export const claimableWriteSql = (priority: string, laneRoots = "'{}'::text[]") => `(r.state='queued' OR ${RELEASED_DEFERRED('r')}) AND (r.worktree_id IS NULL OR (w.owner_host_id=$1::uuid AND w.state='active'))
      AND (r.worktree_id IS NULL OR ${refreshFenceClear('r')})
      AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($2::text[]))
      AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror WHERE mirror.worktree_id=r.worktree_id
        AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')
        AND (NOT (mirror.data ? 'targets') OR mirror.data->'targets' @> jsonb_build_array(jsonb_build_object('slug',r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND ${BACKOFF_ELAPSED('r')}
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND ${EARLIER_HEAD('earlier', 'r', priority, laneRoots)})
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NULL AND earlier.worktree_id IS NULL AND earlier.source_incarnation=r.source_incarnation
        AND ${EARLIER_HEAD('earlier', 'r', priority, laneRoots)})
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND ${EARLIER_DEFERRED('earlier', 'r')})
      AND NOT ((${priority}) AND ${SYNC_KIND('r')} AND EXISTS (SELECT 1 FROM persistence_requests ahead
        WHERE ahead.worktree_id=r.worktree_id AND ahead.sequence>r.sequence AND ahead.state IN ('running','recovering') AND NOT ${SYNC_KIND('ahead')}))`;
/** With the switch on, a claimable foreground request is claimed before the sync rows it passes. */
export const CLAIM_ORDER = (priority: string) => `(${priority} AND NOT ${SYNC_KIND('r')}) DESC, r.sequence`;
/**
 * The `foreground_priority` switch as SQL, so a claim reads it in its own statement: the environment
 * override (a process constant) or, without one, the brain config row (on unless `0`/`false`).
 */
export function foregroundPrioritySql(): string {
  const env = foregroundPriorityOverride();
  if (env !== null) return String(env);
  return `NOT EXISTS (SELECT 1 FROM config WHERE key='${WRITE_SWITCHES.foreground_priority.key}' AND lower(trim(value)) IN ('0','false'))`;
}
/** The `foreground_priority` environment override (a process constant), or null when the brain config row decides. */
export function foregroundPriorityOverride(): boolean | null {
  const env = process.env[WRITE_SWITCHES.foreground_priority.env]?.trim().toLowerCase();
  if (env === '0' || env === 'false') return false;
  if (env === '1' || env === 'true') return true;
  return null;
}
/** Whether `foreground_priority` is on for this brain; on when the switch cannot be read. */
export function foregroundPriority(engine: SqlEngine): Promise<boolean> {
  return writeSwitchOn(engine, 'foreground_priority').catch(() => true);
}

/** #5401: whether `claimNextWrite` would find a row now. Read-only: no lock and no claim. */
export async function hasClaimableWrite(engine: Pick<BrainEngine, 'hasClaimableWrite'>, hostId: string, excludeRoots: string[] = [], signal?: AbortSignal): Promise<boolean> {
  return engine.hasClaimableWrite(hostId, excludeRoots, { priority: foregroundPriorityOverride(), signal });
}

/** Claims commit before OS-lock waits. An unresolved head blocks its entire root. */
/**
 * `fifoRoots` (#5984 Phase 4.5) are roots where this consumer owes the sync side a turn: a foreground write it
 * claimed ahead of a queued sync row (`passed_sync`) committed since it last claimed a sync row, so there the claim is plain FIFO.
 */
/**
 * #5984 Phase 4.5: the worktrees (`f.worktree_id`) where a foreground write that may go first waits, so no new sync head
 * is claimed there: one queued or recovering, or claimed by another process (claim owner nonce other than `nonce`) that
 * has not begun to publish (it cannot publish while this process's sync group holds the worktree, so it releases the claim
 * and this process takes it), and not waiting on an earlier sync row that names its page. A non-sync request committed on
 * the worktree after sequence `seen` (the newest sequence when this process last claimed a sync head there) earns the sync
 * side one head, so a stream of writes cannot starve it. Uncorrelated with the candidate row, so a claim reads it once.
 * The FIFO claim holds back only sync rows the write would pass (sequence below it): an earlier unfinished write is the
 * head-of-root rules' business, and one stalled in another process must not stop the sync behind it. A write queued
 * behind an earlier queued (or released deferred) write that waits on a sync row naming its page cannot go first either (a write never passes
 * an earlier one), so it holds back nothing: counting it held back the very sync row the earlier write waited on, and
 * the three rows waited on each other with no foreground commit left to earn the sync side a head.
 */
export const FOREGROUND_WAITING_ON = (nonce: string, seen: string, worktree = 'TRUE') => `SELECT f.worktree_id, f.sequence FROM persistence_requests f
    WHERE ${worktree} AND (f.state IN ('queued','running','recovering') OR ${RELEASED_DEFERRED('f')}) AND (f.state<>'running' OR (NOT f.publication_started
      AND f.claim_phase->'owner'->>'nonce' IS DISTINCT FROM ${nonce}))
    AND f.recovery IS NULL AND NOT ${SYNC_KIND('f')}
    AND NOT EXISTS (SELECT 1 FROM persistence_requests named WHERE named.worktree_id=f.worktree_id AND named.sequence<f.sequence
      AND named.state IN ('queued','running','recovering') AND ${SYNC_KIND('named')} AND ${NAMES_PAGE('named', 'f')})
    AND NOT EXISTS (SELECT 1 FROM persistence_requests ahead WHERE ahead.worktree_id=f.worktree_id AND ahead.sequence<f.sequence
      AND (ahead.state='queued' OR ${RELEASED_DEFERRED('ahead')}) AND NOT ${SYNC_KIND('ahead')}
      AND EXISTS (SELECT 1 FROM persistence_requests named WHERE named.worktree_id=ahead.worktree_id AND named.sequence<ahead.sequence
        AND named.state IN ('queued','running','recovering') AND ${SYNC_KIND('named')} AND ${NAMES_PAGE('named', 'ahead')}))
    AND NOT EXISTS (SELECT 1 FROM persistence_requests c WHERE c.sequence>COALESCE(${seen},0) AND c.worktree_id=f.worktree_id
      AND c.state='committed' AND NOT ${SYNC_KIND('c')})`;

/**
 * `syncSeen` maps a worktree id to the newest request sequence when this process last claimed a sync head there: a
 * sync row is not claimed while a foreground write that may go first waits on its worktree (`FOREGROUND_WAITING`), so
 * a write its own process is claiming (its row skipped as locked) or has claimed is not overtaken. A claimed sync row
 * returns `seen_sequence`.
 */
export async function claimNextWrite(engine: BrainEngine, hostId: string, leaseMs = 30_000, excludeRoots: string[] = [], fifoRoots: string[] = [],
  laneRoots: string[] = [], syncSeen: Record<string, string> = {}): Promise<(WriteRequest & { passed_sync?: boolean; seen_sequence?: string | null }) | null> {
  const holderOnly = !RESIDENT_CONSUMER_KINDS.includes(claimOwnerKind());
  requireTransactions(engine, 'claimNextWrite', 'it selects the head under FOR UPDATE SKIP LOCKED and stamps the claim in one transaction');
  return engine.transactionDirect(async tx => {
    // The protocol declaration and the FIFO head read are sent together.
    const [, row] = await pipelined(tx, [
      () => declarePersistenceProtocol(tx),
      () => tx.selectClaimableWrite<WriteRequest>({ hostId, excludeRoots, fifoRoots, laneRoots, nonce: consumerIdentity().nonce, syncSeen,
        priority: foregroundPriorityOverride(), leaseHolder: holderOnly ? { lockPrefix: syncLockId(''), pid: process.pid, host: hostname() } : null, ...fenceOpts(tx) }),
    ]) as [unknown, WriteRequest | null];
    if (!row) return null;
    if (holderOnly && String(row.intent?.kind ?? '').startsWith('managed_sync_')) {
      const [lease] = await syncRows<{ holder_pid: number; holder_host: string | null }>(tx, 'lease_other_holder', [syncLockId(row.source_id), process.pid, hostname()]);
      if (lease && classifyHolderLiveness(lease.holder_pid, lease.holder_host ?? '', 0, { graceMs: 0 }) !== 'dead_eligible') return null;
    }
    // `passed_sync`: the claimed row went ahead of a queued sync row of its root.
    // #6278: the claim stamps its own `preparing` phase, so a kill before the first renewal is charged like any other.
    const token = randomUUID();
    const stampFence = fenceOpts(tx);
    const claimed = await tx.stampWriteClaim(row.id, token, leaseMs, claimPhaseStamp(startClaimPhase(), token), stampFence);
    if (claimed) bindClaimFence(token, stampFence.fence ?? null);
    return claimed ? { ...claimed, previous_claim_phase: row.claim_phase } : null;
  }, { pipelineFirst: isPersistenceDeclaration });
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
/**
 * `seenSequence` is the newest request sequence when this process last claimed a head of the run (#5984
 * Phase 4.5): a foreground write admitted and committed since then earns the drain one head while others wait.
 */
export async function claimNextLaneHead(engine: BrainEngine, hostId: string, worktreeId: string, run: string, leaseMs = 30_000,
  seenSequence: string | null = null): Promise<(WriteRequest & { seen_sequence: string }) | null> {
  return engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    // The lane head read and its claim stamp live in engine-sql/persistence-claims.ts (the SQL text is unchanged).
    const row = await tx.selectClaimableLaneHead<WriteRequest>({ hostId, worktreeId, run, seenSequence, nonce: consumerIdentity().nonce,
      priority: foregroundPriorityOverride(), ...fenceOpts(tx) });
    if (!row) return null;
    const token = randomUUID();
    const claimed = await tx.stampLaneHeadClaim<WriteRequest & { seen_sequence: string }>({ id: row.id, token, leaseMs, phaseJson: claimPhaseStamp(startClaimPhase(), token), ...fenceOpts(tx) });
    return claimed ? { ...claimed, previous_claim_phase: row.claim_phase } : claimed;
  });
}
/** `phase` (claim-phase.ts `claimPhaseStamp`, #6176) records the claim's current phase with the renewal. */
export async function renewWriteClaim(engine: Pick<BrainEngine, 'renewWriteClaim'>, id: string, token: string, leaseMs = 30_000, signal?: AbortSignal, phase: string | null = null): Promise<boolean> {
  return engine.renewWriteClaim({ id, token, leaseMs, phaseJson: phase, ...claimFenceOpts(engine, token) }, { signal });
}
/** `charge` (#6278): a `preparation_deadline` release counts one preparation attempt; `claim_lost`, `consumer_stopping` and the rest never do. */
export async function releaseUnpublishedClaim(engine: Pick<BrainEngine, 'releaseUnpublishedClaim'>, row: WriteRequest, reason: string, opts: { charge?: boolean } = {}): Promise<void> {
  // An uncharged release ends a finished preparation: its claim phase would read as a preparation still waiting.
  await engine.releaseUnpublishedClaim({ id: row.id, token: row.execution_token, reason, charge: opts.charge === true, ...claimFenceOpts(engine, row.execution_token) });
}

/** A recovery larger than a budget: names both budgets and the bytes needed, since a configured budget is the user's. */
function recoveryTooLarge(bytes: number, limits: JournalLimits): OperationError {
  const worktree = journalLimitKey('worktreeRecoveryBytes'), brain = journalLimitKey('brainRecoveryBytes');
  return new OperationError('request_too_large',
    `This request needs ${bytes} bytes of recovery space, more than the recovery budget (${worktree} ${limits.worktreeRecoveryBytes}, ${brain} ${limits.brainRecoveryBytes}); nothing was changed.`,
    `A configured budget is the user's choice: ask them before raising it with gbrain config set, or unset ${worktree} for the default, which holds the largest page stored in segments.`);
}

/** Called while holding the root lock; the durable record precedes any rename. */
export async function prepareRecovery(engine: BrainEngine, row: WriteRequest, recovery: RecoveryRecord, bytes: number,
  overrides?: Partial<JournalLimits>): Promise<void> {
  const limits = await readJournalLimits(engine,overrides);
  if (!row.worktree_id) throw new TypeError('Filesystem recovery requires a worktree.');
  if (bytes > limits.worktreeRecoveryBytes || bytes > limits.brainRecoveryBytes) throw recoveryTooLarge(bytes, limits);
  await engine.transaction(async tx => {
    // A crash after rename must never lose the earlier recovery reservation,
    // even when the deployment defaults ordinary transactions to async commit.
    await declareDurablePersistence(tx);
    const counters = await lockCounters(tx, ['brain', `worktree:${row.worktree_id}`]);
    const fits = counters.every(c => Number(c.recovery_bytes) + bytes <= (c.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes));
    // #6007: the common case records the reservation in one statement; any other state takes the checked path below.
    const journal = await tx.publicationJournalStore();
    const reservation = { id: row.id, executionToken: row.execution_token, recovery, bytes, keys: counters.map(c => c.key), ...claimFenceOpts(tx, row.execution_token) };
    if (fits && await journal.recordRecovery(reservation, true)) return;
    const current = await tx.lockWriteRequest(row.id);
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
    await journal.recordRecovery(reservation, false);
  });
}

/**
 * #6007 grouped publication: records every member's recovery record in one
 * transaction, before any of their files is touched. All or nothing: a member
 * whose claim moved, or that already holds a record, fails the whole call and
 * nothing is recorded.
 */
export async function prepareRecoveries(engine: BrainEngine, members: { row: WriteRequest; record: RecoveryRecord; bytes: number }[],
  transaction: <T>(fn: (tx: BrainEngine) => Promise<T>) => Promise<T> = fn => engine.transaction(fn), knownLimits?: JournalLimits): Promise<void> {
  if (!members.length) return;
  const worktree = members[0]!.row.worktree_id;
  if (!worktree || members.some(member => member.row.worktree_id !== worktree)) throw new TypeError('Grouped filesystem recovery requires one worktree.');
  const limits = knownLimits ?? await readJournalLimits(engine);
  const total = members.reduce((sum, member) => sum + member.bytes, 0);
  const largest = Math.max(...members.map(member => member.bytes));
  if (largest > limits.worktreeRecoveryBytes || largest > limits.brainRecoveryBytes) throw recoveryTooLarge(largest, limits);
  await transaction(async tx => {
    const [, counters] = await pipelined(tx, [() => declareDurablePersistence(tx), () => lockCounters(tx, ['brain', `worktree:${worktree}`])]) as [unknown, Counter[]];
    for (const c of counters) if (Number(c.recovery_bytes) + total > (c.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes)) throw capacityError('recovery bytes currently reserved by other requests');
    const recorded = await (await tx.groupPublishStore()).recordRecoveries(members.map(member => ({ id: member.row.id, token: member.row.execution_token!, record: member.record, bytes: member.bytes })),
      total, counters.map(c => c.key), fenceOpts(tx));
    if (recorded.length !== members.length) throw opError('write_claim_lost', 'A grouped write claim changed before its recovery was recorded.',
      'Another owner pass holds one of the grouped requests; the group publishes nothing and its members publish one at a time.');
  });
}

/** Clears the resolved recovery records of a committed group in one transaction; a record that changed is cleared on its own. */
export async function clearResolvedRecoveries(engine: BrainEngine, rows: WriteRequest[],
  transaction: <T>(fn: (tx: BrainEngine) => Promise<T>) => Promise<T> = fn => engine.transaction(fn)): Promise<void> {
  const resolved = rows.filter(row => row.recovery && isTerminal(row));
  if (resolved.length < 2) { for (const row of resolved) await clearResolvedRecovery(engine, row.id, row, transaction); return; }
  for (const row of resolved) for (const file of recoveryFiles(row.recovery!)) assertRecoveryStagingAbsent(file);
  const worktree = resolved[0]!.worktree_id;
  const cleared = new Set((await transaction(async tx => {
    await declareDurablePersistence(tx);
    const keys = ['brain', ...(worktree ? [`worktree:${worktree}`] : [])];
    await lockCounters(tx, keys);
    return (await tx.groupPublishStore()).clearRecoveries(resolved.map(row => ({ id: row.id, record: row.recovery })), keys, worktree, fenceOpts(tx));
  })));
  for (const row of resolved) if (!cleared.has(row.id)) await clearResolvedRecovery(engine, row.id);
}

/** #6007: claims again a request this owner pass released to the queue itself, while it still holds the worktree's native lock; never before its backoff (LPH b). */
export async function reclaimReleasedWrite(engine: BrainEngine, id: string, leaseMs = 30_000): Promise<WriteRequest | null> {
  const token = randomUUID();
  const claimed = await engine.reclaimReleasedWrite<WriteRequest>({ id, token, leaseMs, phaseJson: claimPhaseStamp(startClaimPhase(), token), ...fenceOpts(engine) });
  return claimed ?? null;
}

/** In the SAME transaction as page publication. Counters are always before request locks. */
export async function completeWrite(tx: SqlEngine & Pick<BrainEngine, 'lockPersistenceCounters' | 'lockWriteRequest' | 'completeWriteRow' | 'declarePersistence' | 'requireSynchronousCommit' | 'compactTerminalIntent'>, row: WriteRequest, state: 'committed' | 'conflict' | 'failed' | 'cancelled',
  outcome: Record<string, unknown>, error?: { code: string; message: string; detail?: unknown },
  /** #5984: the caller's transaction already declared the protocol, set synchronous_commit, locked these counters and this row FOR UPDATE. */
  locked?: WriteRequest,
  /** L5 (G8): the successor settling a recovered publication. On a multi-user Rust brain the engine checks the current host fence and this recovery state, then retires the predecessor's claim epoch. */
  recovered?: true): Promise<WriteRequest> {
  // Every acknowledged terminal state survives a crash, including cancellation
  // and pre-publication failures that do not enter the file coordinator.
  let current = locked;
  if (!current) {
    await tx.requireSynchronousCommit();
    await declarePersistenceProtocol(tx);
    await lockCounters(tx, ['brain', principalKey(requestPrincipal(row)), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])]);
    current = await tx.lockWriteRequest(row.id) ?? undefined;
  }
  if (!current) throw opError('not_found', 'Write request not found.',
    `The journal row of request ${row.request_id} in source ${row.source_id} disappeared before its completion was recorded, so no outcome was saved. Inspect the source's requests with the command in fix before submitting anything again.`,
    { fix: ownerStatusFix(row.source_id) });
  if (isTerminal(current)) return current;
  const completion = terminalCompletion(tx, row, current, state, outcome, error);
  const recovery = recovered && fenceFor(tx) ? { recovered: { state: current.state, executionToken: current.execution_token ?? null } } : {};
  const terminal = await tx.completeWriteRow({ ...completion, ...(recovered ? fenceOpts(tx) : claimFenceOpts(tx, row.execution_token)), ...recovery });
  if (!terminal) throw capacityError('terminal result and effects exceed their reserved bounded encoding');
  return finishTerminal(tx, row, current, terminal, error);
}

/**
 * Cancels `row` before publication, in the caller's transaction, which already declared the protocol, locked the
 * counters and read `current` through `lockWriteRequest`. The engine re-checks and completes the row in one step
 * (`cancelWriteRow`), so a request that another pass claimed, published or ended meanwhile is returned unchanged.
 */
export async function cancelLockedWrite(tx: SqlEngine & Pick<BrainEngine, 'cancelWriteRow' | 'compactTerminalIntent'>, row: WriteRequest, current: WriteRequest): Promise<WriteRequest> {
  const error = { code: 'cancelled', message: 'Cancelled before publication.' };
  const completion = terminalCompletion(tx, row, current, 'cancelled', {}, error);
  const result = await tx.cancelWriteRow({ ...completion, state: 'cancelled', expectState: current.state, expectExecutionToken: current.execution_token ?? null });
  if (!result) throw opError('not_found', 'Write request not found.',
    `The journal row of request ${row.request_id} in source ${row.source_id} disappeared before its cancellation was recorded, so nothing was cancelled. Inspect the source's requests with the command in fix before submitting anything again.`,
    { fix: ownerStatusFix(row.source_id) });
  if (result.status === 'kept') return result.row;
  if (result.status === 'too_large') throw capacityError('terminal result and effects exceed their reserved bounded encoding');
  return finishTerminal(tx, row, current, result.row, error);
}

/** The completion statement's numbers for `current` ending in `state`; throws write_claim_lost when another pass holds the claim. */
function terminalCompletion(tx: SqlEngine, row: WriteRequest, current: WriteRequest, state: WriteCompletion['state'],
  outcome: Record<string, unknown>, error?: { code: string; message: string; detail?: unknown }): WriteCompletion {
  // G7b: a strict write whose door commit landed before its row keeps naming that commit when it ends without committing.
  const landed = (current.outcome as { persistence?: { landed_before_row?: boolean } } | null)?.persistence;
  if (state !== 'committed' && landed?.landed_before_row === true && !('persistence' in outcome)) outcome = { ...outcome, persistence: landed };
  if (row.execution_token !== current.execution_token) throw opError('write_claim_lost', 'Write claim changed before completion.',
    `Another owner pass claimed request ${row.request_id} in source ${row.source_id} before this pass recorded its outcome, so this pass's completion was discarded; the current claim records the final outcome. Inspect the request with the command in fix instead of resubmitting it.`,
    { fix: requestInspectFix(row) });
  // Only publication stamps the consumer; failures, cancellations and conflicts leave it unset.
  const stamp = writerStamp({ engine: tx });
  // #6007: one statement sizes the queued effects, checks the terminal reservation, completes the row and
  // releases its outstanding counters; no row means the encoding exceeds the reservation and nothing changed.
  const resultBytes = jsonBytes(outcome) + jsonBytes(current.authority) + 1024 + Buffer.byteLength(error?.message ?? '') + (error?.detail ? jsonBytes(error.detail) : 0);
  const probePurges = intentCarriesContent(current.intent);
  // #6696 (A1): the true-up sizes the reservation down to what the receipt keeps, once no effect is unfinished.
  const retained = retainedReceiptBytes({ intent: current.intent, authority: current.authority, outcome, error_message: error?.message ?? null,
    error_detail: error?.detail ?? current.error_detail, client_request_id: current.client_request_id }, { stage: 'terminal' });
  return { id: row.id, state, outcome, errorCode: error?.code ?? null, errorMessage: error?.message ?? null,
    consumerVersion: stamp.version, consumerHostId: stamp.hostId, errorDetail: error?.detail, resultBytes, counterKeys: ['brain', principalKey(requestPrincipal(row))],
    intentBytes: Number(current.intent_bytes), retainedBytes: retained, terminalReservation: Number(current.terminal_reservation), probePurges };
}

/** After the completion statement: a terminal write whose intent carries purged content keeps no copy of it. */
async function finishTerminal(tx: SqlEngine & Pick<BrainEngine, 'compactTerminalIntent'>, row: WriteRequest, current: WriteRequest, terminal: CompletedWriteRow,
  error?: { code: string; message: string; detail?: unknown }): Promise<WriteRequest> {
  const probePurges = intentCarriesContent(current.intent);
  const { purge_has_facts: purgeFacts, purge_has_pages: purgePages, ...doneRow } = terminal;
  const done = doneRow as WriteRequest;
  // #5575: a terminal write whose stored intent carries purged content (refused by the purge guards, refused for another
  // reason first, or committed as a no-op after the overlay dropped the purged rows) keeps no copy of it; replay answers
  // from the stored outcome, and the intent bytes were released above.
  if (error && PURGED_REFUSAL.test(`${error.code}: ${error.message}`) || probePurges && await intentCarriesPurgedContent(tx as BrainEngine, current, { facts: purgeFacts === true, pages: purgePages === true })) {
    // #6696: the redaction compacts the receipt, so its reservation shrinks to what is left (no intent) once no effect is unfinished.
    const left = retainedReceiptBytes({ ...done, intent: null }, { stage: 'terminal' });
    // The compaction is the typed compactTerminalIntent member (engine-sql/persistence-journal.ts).
    const redacted = await tx.compactTerminalIntent({ id: row.id, left, reservation: Number(done.terminal_reservation),
      counterKeys: ['brain', principalKey(requestPrincipal(row))] });
    return redacted ?? done;
  }
  // Recovery bytes remain reserved until physical cleanup has been verified.
  return done;
}
const PURGED_REFUSAL = /^purged_content:|which the owner purged; it was not imported\.$/;

/**
 * `known` is the row a publication just completed, passed while it still
 * holds the worktree's native lock, so neither its recovery record nor its
 * staging files can change: its staging is checked first and the record is
 * cleared in one statement when it is still exactly that record.
 */
export async function clearResolvedRecovery(engine: BrainEngine, id: string, known?: WriteRequest,
  transaction: <T>(fn: (tx: BrainEngine) => Promise<T>) => Promise<T> = fn => engine.transaction(fn)): Promise<void> {
  const row = known ?? await getWriteRequestById(engine, id);
  if (!row?.recovery || !isTerminal(row)) return;
  if (known) for (const file of recoveryFiles(row.recovery)) assertRecoveryStagingAbsent(file);
  await transaction(async tx => {
    const keys = ['brain', ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])];
    const journal = await tx.publicationJournalStore();
    if (known) {
      // The settings, the counter lock and the clear of the exact known record are sent together.
      const [, , cleared] = await pipelined(tx, [() => declareDurablePersistence(tx), () => lockCounters(tx, keys),
        () => journal.clearKnownRecovery(id, keys, row.recovery)]) as [unknown, unknown, boolean];
      if (cleared) return;
    } else {
      await declareDurablePersistence(tx);
      await lockCounters(tx, keys);
    }
    const locked = await tx.lockWriteRequest(id);
    if (!locked?.recovery || !isTerminal(locked)) return;
    for (const file of recoveryFiles(locked.recovery)) assertRecoveryStagingAbsent(file);
    await journal.clearRecovery(id, keys, Number(locked.recovery_bytes));
  });
}
export async function markRecovering(engine: Pick<BrainEngine, 'publicationJournalStore'>, row: WriteRequest, reason: string,
  failure?: {code:string;message:string;detail?:unknown}): Promise<void> {
  await (await engine.publicationJournalStore()).markRecovering(row.id, row.execution_token, reason, failure, claimFenceOpts(engine, row.execution_token));
}
const PERSISTENCE_QUEUE_TABLES = ['persistence_requests', 'persistence_effects', 'persistence_counters', 'page_projection_jobs', 'page_write_guards'];
/**
 * Lets timers and I/O run between PGLite statement chains. Every PGLite statement runs synchronously and resolves as a
 * microtask, so a chain of them never returns to the event loop on its own and holds every request until it ends. It
 * resumes from the timer queue: a check-phase resume (setImmediate) runs the next chain before timers that came due
 * during the last one, so two chains back to back held a waiting request through both.
 */
export const yieldToEventLoop = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * PGLite has no autovacuum. The resident owner reclaims queue churn and keeps
 * planner statistics current, so receipt lookups keep using the request-id
 * index and claims do not walk dead queue entries. A queue table is vacuumed
 * once its heap has grown more than 10% (and 8 pages) past the size its last
 * VACUUM or ANALYZE recorded: PGLite keeps no dead-tuple counters across
 * processes, and unreclaimed churn lands on new pages. Every short-lived CLI
 * process otherwise vacuumed every queue on its first tick (0.6 s per one-page
 * sync at 5k pages).
 */
export async function vacuumPersistenceQueues(engine: BrainEngine): Promise<number> {
  if (engine.kind !== 'pglite') return 0;
  const grown = await engine.executeRaw<{ relname: string }>(
    `SELECT c.relname FROM pg_class c WHERE c.relname = ANY($1::text[]) AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
       AND pg_relation_size(c.oid) / current_setting('block_size')::int > c.relpages * 1.1 + 8`, [PERSISTENCE_QUEUE_TABLES]);
  const tables = PERSISTENCE_QUEUE_TABLES.filter(table => grown.some(row => row.relname === table));
  for (const table of tables) {
    await yieldToEventLoop();
    await engine.executeRaw(`VACUUM (ANALYZE) ${table}`);
  }
  const [requests] = await engine.executeRaw<{ rows: number }>("SELECT GREATEST(reltuples,0)::float8 AS rows FROM pg_class WHERE oid='persistence_requests'::regclass");
  return Number(requests?.rows ?? 0);
}

/**
 * Wave B segment GC (spec 3.5), run by the resident owner next to the queue
 * vacuum: expires body stagings past their deadlines (their staged manifest
 * and chunk rows go with them), deletes retired chunk rows and manifest rows
 * no retained generation needs, and unreferenced segment texts past the grace
 * window. On a managed brain it collects only the sources this host owns, each
 * in a coordinated write. A brain that never staged a segment pays one
 * existence probe.
 */
export async function sweepSegmentStorage(engine: BrainEngine): Promise<void> {
  if (!await engine.hasSegmentStorage()) return;
  if (!await readManagedMode(engine)) { await engine.sweepSegments({ expireStagings: true }); return; }
  const owned = await engine.executeRaw<{ source_id: string }>(`SELECT s.source_id FROM persistence_source_bindings s
    JOIN persistence_worktrees w ON w.id=s.worktree_id WHERE w.owner_host_id=$1::uuid AND w.state='active'`, [hostIdFor(engine)]);
  for (const { source_id: sourceId } of owned) {
    const writes = await segmentWriteScope(engine, sourceId);
    await writes(exec => exec.sweepSegments({ sourceId, expireStagings: true }));
  }
}

/**
 * #6696 (A9): compaction drops the intent, and a sync receipt's `intent.runId`
 * is how a resumed run finds what it committed. A receipt of a run whose
 * managed-sync cursor is still open (not done) is never compacted, nor the newest
 * committed sync receipt of its worktree.
 * #6712 PR 4b (design v3.2 §3.7): a pass's receipts carry `intent.passId`
 * instead; one whose pass row is open (`telemetry.outcome = 'open'`, its
 * `pass_id` equal) is kept the same way, and the newest committed sync receipt
 * is kept whether it names a run or a pass.
 */
const OPEN_SYNC_PASS_SQL = (r: string) => `${r}.intent ? 'passId' AND EXISTS (SELECT 1 FROM op_checkpoints p
      WHERE p.op='${MANAGED_SYNC_PASS_OP}' AND p.completed_keys->0->'telemetry'->>'pass_id'=${r}.intent->>'passId' AND p.completed_keys->0->'telemetry'->>'outcome'='open')`;
export const OPEN_SYNC_CURSOR_EXCLUSION = (r: string) => `AND NOT (${r}.intent ? 'runId' AND EXISTS (SELECT 1 FROM op_checkpoints c
      WHERE c.op='managed-sync' AND c.completed_keys->0->>'runId'=${r}.intent->>'runId' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'))
    AND NOT (${OPEN_SYNC_PASS_SQL(r)})`;
/**
 * GBRA-130 A-14: `newestSyncReceipt` as a selection filter, so a compaction pass's window is never filled by receipts
 * `compactReceipt` keeps (one per worktree, retired ones included); the per-row check still re-reads it under the lock.
 */
export const NEWEST_SYNC_RECEIPT_EXCLUSION = (r: string) => `AND NOT (${r}.state='committed' AND ${r}.worktree_id IS NOT NULL AND (${r}.intent ? 'runId' OR ${r}.intent ? 'passId')
      AND COALESCE(${r}.intent->>'kind','') LIKE 'managed_sync_%' AND ${r}.id=(SELECT n.id FROM persistence_requests n WHERE n.worktree_id=${r}.worktree_id
        AND n.state='committed' AND COALESCE(n.intent->>'kind','') LIKE 'managed_sync_%' ORDER BY n.completed_at DESC, n.sequence DESC LIMIT 1))`;
export async function newestSyncReceipt(tx: SqlEngine, row: Pick<WriteRequest, 'id' | 'state' | 'intent' | 'worktree_id'>): Promise<boolean> {
  const intent = row.intent as { runId?: unknown; passId?: unknown; kind?: unknown } | null;
  if (row.state !== 'committed' || !row.worktree_id || (typeof intent?.runId !== 'string' && typeof intent?.passId !== 'string') || !String(intent?.kind ?? '').startsWith('managed_sync_')) return false;
  const [newest] = await tx.executeRaw<{ id: string }>(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND state='committed'
    AND COALESCE(intent->>'kind','') LIKE 'managed_sync_%' ORDER BY completed_at DESC, sequence DESC LIMIT 1`, [row.worktree_id]);
  return newest?.id === row.id;
}
/** What one compaction pass did (#6696 A11): receipts compacted, reservation bytes it freed, candidates it left and why. */
export interface ReceiptCompactionResult { compacted: number; freed_bytes: number; skipped_by_reason: Record<string, number> }
export async function compactWriteReceipts(engine: BrainEngine, retentionDays?: number): Promise<number> {
  return (await compactWriteReceiptsDetailed(engine, retentionDays)).compacted;
}
export async function compactWriteReceiptsDetailed(engine: BrainEngine, retentionDays?: number): Promise<ReceiptCompactionResult> {
  retentionDays ??= await readReceiptRetentionDays(engine);
  if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new TypeError('Invalid receipt retention.');
  // Receipts with unfinished effects stay retained; filtering them before the
  // LIMIT keeps a backlog of parked effects from starving later receipts.
  const rows = await engine.listCompactableReceipts<WriteRequest>(retentionDays);
  const result: ReceiptCompactionResult = { compacted: 0, freed_bytes: 0, skipped_by_reason: {} };
  for (const row of rows) {
    const done = await compactReceipt(engine, row).catch(error => {
      if (['55P03', '57014'].includes(getCode(error) ?? '')) return { skipped: 'lock_timeout' };
      throw error;
    });
    if ('skipped' in done) result.skipped_by_reason[done.skipped] = (result.skipped_by_reason[done.skipped] ?? 0) + 1;
    else { result.compacted++; result.freed_bytes += done.freed_bytes; }
  }
  return result;
}
/** Terminal states a compaction may take; the receipt-compaction repair keeps failures unless asked. */
export const COMPACTABLE_STATES = ['committed', 'conflict', 'failed', 'cancelled'] as const;
/**
 * Compacts one terminal receipt in its own short transaction (#6696 A9, A11): counters locked first in key order, then
 * the request row, with transaction-local lock and statement timeouts so a concurrent admission waits at most that
 * long. Every eligibility rule is rechecked under the lock: terminal, no recovery, not compacted, `states`,
 * `completedBefore`, no unfinished effect, no open sync cursor for its run, no open pass for its pass id (#6712 PR 4b), not
 * the worktree's newest sync receipt.
 */
export async function compactReceipt(engine: BrainEngine, row: Pick<WriteRequest, 'id' | 'principal_kind' | 'principal_id'>,
  opts: { states?: readonly string[]; completedBefore?: string } = {}): Promise<{ freed_bytes: number } | { skipped: string }> {
  requireTransactions(engine, 'compactReceipt', 'it rechecks the receipt under its row lock and releases the counters in one transaction');
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
    await tx.executeRaw("SET LOCAL statement_timeout = '15s'");
    const keys = ['brain', principalKey(requestPrincipal(row as WriteRequest))];
    await lockCounters(tx, keys);
    const [current] = await tx.executeRaw<WriteRequest & { eligible_age: boolean; open_cursor: boolean; open_pass: boolean }>(`SELECT r.*,
        ($2::timestamptz IS NULL OR r.completed_at < $2::timestamptz) AS eligible_age,
        EXISTS (SELECT 1 FROM op_checkpoints c WHERE r.intent ? 'runId' AND c.op='managed-sync' AND c.completed_keys->0->>'runId'=r.intent->>'runId'
          AND COALESCE(c.completed_keys->0->>'done','false')<>'true') AS open_cursor,
        COALESCE(${OPEN_SYNC_PASS_SQL('r')}, false) AS open_pass
      FROM persistence_requests r WHERE r.id=$1::uuid FOR UPDATE OF r`, [row.id, opts.completedBefore ?? null]);
    if (!current || current.compacted || current.recovery || !isTerminal(current)) return { skipped: 'changed' };
    if (!(opts.states ?? COMPACTABLE_STATES).includes(current.state) || !current.eligible_age) return { skipped: 'changed' };
    const unfinished = await tx.executeRaw("SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid AND state<>'committed' LIMIT 1", [row.id]);
    if (unfinished.length) return { skipped: 'unfinished_effect' };
    if (current.open_cursor) return { skipped: 'open_sync_cursor' };
    if (current.open_pass) return { skipped: 'open_sync_pass' };
    if (await newestSyncReceipt(tx, current)) return { skipped: 'newest_sync_receipt' };
    const [effects] = await tx.executeRaw<{ bytes: string }>(`SELECT COALESCE(SUM(${EFFECT_BYTES_SQL}),0)::text AS bytes
      FROM persistence_effects WHERE request_id=$1::uuid`, [row.id]);
    const retained = Math.min(Number(current.terminal_reservation), retainedReceiptBytes(current, { stage: 'compacted', effects: Number(effects.bytes) }));
    const freed = Number(current.terminal_reservation) - retained;
    await tx.executeRaw('UPDATE persistence_requests SET intent=NULL,compacted=true,error_message=NULL,terminal_reservation=$2 WHERE id=$1::uuid', [row.id, retained]);
    await tx.executeRaw('UPDATE persistence_counters SET terminal_bytes=terminal_bytes-LEAST($2::bigint,terminal_bytes) WHERE key=ANY($1::text[])', [keys, freed]);
    return { freed_bytes: freed };
  });
}
export function receiptFor(stored: WriteRequest, facts?: WriteHealthFacts, now = Date.now()) {
  // PR B: a deferred row reads as queued (every receipt reader, an older client's included, knows that state) plus `deferred`.
  const state: Exclude<RequestState, 'deferred'> = stored.state === 'deferred' ? 'queued' : stored.state;
  const row = { ...stored, state };
  const outcome = row.outcome && 'private_rows_kept' in row.outcome && !ownerWidened() ? (({ private_rows_kept: _kept, ...rest }) => rest)(row.outcome) : row.outcome;
  return {
    ...(outcome ?? {}),
    ...(outcome ? { outcome } : {}),
    request_id: row.request_id, ...(row.client_request_id ? { client_request_id: row.client_request_id } : {}), state,
    ...(stored.state === 'deferred' ? { deferred: { ...(stored.deferred_refresh_id ? { refresh_id: stored.deferred_refresh_id } : {}),
      ...(stored.deferred_import_from != null ? { pending_import: true } : {}) } } : {}),
    ...writeHealth(row, facts, now),
    ...(row.error_code ? { write_error: row.error_code } : {}),
    ...(row.error_detail ? { write_error_detail: publicFailureDetail(row.error_detail) } : {}),
    ...(row.blocked_reason ? { blocked_reason: row.blocked_reason } : {}),
    ...(row.compacted ? { compacted: true } : {}),
    created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
  };
}

const healthQueries = new WeakMap<BrainEngine, Promise<unknown>>();
/**
 * #6275: a head needs recovery only when it is recovering, or holds a recovery record without a live claim; a
 * publication in progress keeps its ordinary before-image record, and the requests behind it are only waiting.
 */
const STUCK_RECOVERY = (r: string) => `(${r}.state='recovering' OR (${r}.recovery IS NOT NULL AND (${r}.state<>'running' OR ${r}.claim_expires_at<now())))`;
/**
 * Receipt health facts per root. #5984: a queued request waits on any earlier unfinished request of its root;
 * a claimed one (a lane, a group follower, or a foreground write claimed ahead of queued sync rows) waits only
 * on an earlier one already publishing or recovering, so the queued rows it overtook never make it report
 * `waiting_on_earlier_write`. GST-1623: a released deferred write is an earlier unfinished request like a queued one (claims
 * wait on it, EARLIER_DEFERRED), and a worktree whose refresh awaits recovery reports `recovery_required` for every write that
 * waits there, a write deferred behind that refresh included, so the operator signal the refusal used to carry is not lost.
 */
export async function writeHealthFacts(engine: BrainEngine, rows: WriteRequest[]): Promise<Map<string, WriteHealthFacts>> {
  if (rows.length > 100) throw new RangeError('Receipt health pages are limited to 100 rows.');
  const pending = rows.filter(row => !isTerminal(row));
  const result = new Map<string, WriteHealthFacts>();
  if (!pending.length || healthQueries.has(engine)) return result;
  const roots = [...new Set(pending.map(row => row.worktree_id ?? `db:${row.source_incarnation}`))];
  const abort = new AbortController();
  const observed_at = new Date().toISOString();
  const query = engine.executeRaw<{ root: string; sequence: string | null; started_sequence: string | null; started_unlaned: string | null; recovery_required: boolean; owner_unavailable: boolean; inspect_owner: boolean }>(`
    WITH roots AS (SELECT unnest($1::text[]) AS root)
    SELECT roots.root,head.sequence::text,head.started_sequence::text,head.started_unlaned::text,COALESCE(head.inspect_owner,false) AS inspect_owner,
      COALESCE(head.recovering,false) OR EXISTS (SELECT 1 FROM persistence_effects e
        WHERE e.worktree_id=w.id AND e.recovery IS NOT NULL)
        OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.worktree_id=w.id AND f.state='recovery_required') AS recovery_required,
      w.id IS NOT NULL AND (w.state<>'active' OR w.owner_host_id IS NULL) AS owner_unavailable
    FROM roots LEFT JOIN persistence_worktrees w ON w.id::text=roots.root
    LEFT JOIN LATERAL (
      (SELECT r.sequence,(SELECT s.sequence FROM persistence_requests s WHERE s.worktree_id=w.id
          AND (s.state IN ('running','recovering') OR s.recovery IS NOT NULL) ORDER BY s.sequence LIMIT 1) AS started_sequence,
        (SELECT s.sequence FROM persistence_requests s WHERE s.worktree_id=w.id
          AND (s.state IN ('running','recovering') OR s.recovery IS NOT NULL)
          AND NOT (s.state='running' AND s.recovery IS NULL AND s.operation='submit_job') ORDER BY s.sequence LIMIT 1) AS started_unlaned,
        ${STUCK_RECOVERY('r')} AS recovering,
        r.blocked_reason IN ('unexpected_file_bytes','unexpected_staging_bytes') AS inspect_owner FROM persistence_requests r
        WHERE r.worktree_id=w.id AND (r.state IN ('queued','running','recovering') OR r.recovery IS NOT NULL OR ${RELEASED_DEFERRED('r')})
        ORDER BY r.sequence LIMIT 1)
      UNION ALL
      (SELECT r.sequence,(SELECT s.sequence FROM persistence_requests s WHERE s.worktree_id IS NULL AND s.source_incarnation=r.source_incarnation
          AND s.state IN ('running','recovering') ORDER BY s.sequence LIMIT 1) AS started_sequence,NULL::bigint AS started_unlaned,
        ${STUCK_RECOVERY('r')} AS recovering,
        r.blocked_reason IN ('unexpected_file_bytes','unexpected_staging_bytes') AS inspect_owner FROM persistence_requests r
        WHERE r.worktree_id IS NULL AND r.source_incarnation=CASE WHEN roots.root LIKE 'db:%' THEN substring(roots.root FROM 4)::uuid END
        AND r.state IN ('queued','running','recovering') ORDER BY r.sequence LIMIT 1)
    ) head ON true`, [roots], { signal: engine.kind === 'postgres' ? abort.signal : undefined })
    .catch(() => null).finally(() => { if (healthQueries.get(engine) === query) healthQueries.delete(engine); });
  healthQueries.set(engine, query);
  // GBRA-248: owner facts read beside the head facts, inside the same 500 ms budget.
  const ownerReadStarted = performance.now();
  const settleOwners = startOwnerRead(engine, pending.flatMap(row => row.worktree_id ? [row.worktree_id] : []));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const facts = await Promise.race([query, new Promise<null>(resolve => {
    timer = setTimeout(() => { abort.abort(); resolve(null); }, OWNER_READ_BUDGET_MS);
  })]).finally(() => { if (timer) clearTimeout(timer); });
  const owners = await settleOwners(facts ? OWNER_READ_BUDGET_MS - (performance.now() - ownerReadStarted) : 0) ?? new Map();
  if (!facts) return result;
  const byRoot = new Map(facts.map(fact => [fact.root, fact]));
  for (const row of pending) {
    const fact = byRoot.get(row.worktree_id ?? `db:${row.source_incarnation}`);
    if (!fact) continue;
    // #5984 Phase 4.5: a foreground write publishing beside running lane groups (claimed sync jobs) is not waiting on them.
    const head = row.state === 'queued' ? fact.sequence : row.worktree_id && row.operation !== 'submit_job' ? fact.started_unlaned : fact.started_sequence;
    const owner = row.worktree_id ? owners.get(row.worktree_id) : undefined;
    result.set(row.id, { observed_at, recovery_required: fact.recovery_required,
      owner_unavailable: fact.owner_unavailable,
      inspect_owner: fact.inspect_owner,
      earlier_write: head != null && BigInt(head) < BigInt(row.sequence),
      ...(owner ? { owner } : {}) });
  }
  return result;
}
