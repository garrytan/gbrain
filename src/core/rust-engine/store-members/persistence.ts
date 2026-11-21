/**
 * The write-journal members the Rust store answers: the state reads (readManagedModeRows, readLocalWriterRow,
 * insertLocalWriterRow, readJournalLimitRows; the held-file reads are in sync-hold-store.ts), the request rows the put path
 * reads and writes (readWriteRequest, readWriteRequestById, listWriteRequestRows, readWriteRequestProgress, countOutstandingBySource, ownsSchemaTables, readOAuthClientWriteGrant, readAccessTokenWriteGrant, shareLockWriteCredential, readCounterRows, readAdmissionRate, lockPersistenceCounters, insertWriteRequest,
 * insertWriteRequestGroup, readWriteRequestsByRequestIds, readOwnerHostBinding,
 * stampWriteClaim, lockWriteRequest, completeWriteRow, cancelWriteRow), the claim upkeep (renewWriteClaim, expireStaleWriteClaims,
 * hasClaimableWrite), the consumer rows (listHostConsumerRows, probeLiveConsumerRows, renewConsumerRow,
 * deleteConsumerRow, stampWorktreeHeartbeats), the admission reads (readSourceMembership, findTopologyChanges), the topology recovery scan (listTopologyRecoveries), the lifecycle receipts
 * (readTopologyChange, insertTopologyChange) and readLedgerSource, and the effects a publication or a managed-request
 * withdrawal queues (insertPublicationEffects, insertWithdrawalEffects).
 *
 * Each store call is one store write transaction, so the row locks PGLite takes (FOR SHARE, FOR UPDATE, the counter
 * lock) change nothing here: no other write can run between the read and the write that follows it. The callers that
 * run these members inside `transaction` still refuse until this engine serves transactions.
 *
 * What each member answers and why: rust/docs/store/journal.md ("TypeScript journal members") and
 * rust/docs/store/persistence.md.
 */
import type { LocalWriterInsert, LocalWriterRow } from '../../engine-sql/persistence-state.ts';
import type { AccessTokenWriteGrant, AdmissionRate, ClaimedWriteRow, CompletedWriteRow, CounterRow, OAuthClientWriteGrant, OutstandingBySource, PublicationEffectsSpec, WithdrawalEffectsSpec, WriteCancellation, WriteCancelResult, WriteCompletion, WriteRequestGroupInsert, WriteRequestInsert, WriteRequestListFilter, WriteRequestProgress } from '../../engine-sql/persistence-journal.ts';
import type { ClaimExpiry, ClaimHeadSpec, ClaimRelease, ClaimRenewal, ConsumerProbe, ConsumerRenewal, ConsumerRowKey, ConsumerRowRead, SourceMembership, TopologyChange, TopologyChangeInsert } from '../../engine-sql/persistence-claims.ts';
import type { LedgerSource } from '../../engine-sql/belief.ts';
import type { SourceStateRow } from '../../engine-sql/write-misc.ts';
import type { SourceCheckoutRoot, UnembeddedPageSummary, WriteWatermarkRow } from '../../engine-sql/applied-watermark-reads.ts';
import type { SourceDetailRow } from '../../engine.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { PAGE_BODY_CONFIG_KEYS } from '../../page-body/limits.ts';
import { requestRow, topologyRow } from '../store-codec.ts';
import { withdrawalEffectsData } from '../../engine-sql/persistence-journal.ts';
import { requireTextColumn, storeCall, type StoreMember } from './common.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';
import { readBrainMode } from './writer-release.ts';
// The managed-worktree admission members (managed_persistence), served beside the journal's.
export * from './persistence-admission.ts';

/** The one singleton row with the stored brain mode (gbrain-store `persistence::worktrees::release`; classic until activated). */
export const readManagedModeRows: StoreMember<[], Array<{ enabled: unknown }>> = async (brain) =>
  [{ enabled: (await readBrainMode(brain, 'readManagedModeRows')).enabled }];

/**
 * The registration row of a local writer, or undefined. `lock` asks PGLite for FOR SHARE so a revocation waits; the
 * store runs one write transaction at a time, so a read never overlaps a revocation and the option changes nothing.
 * `revoked_at` comes back as a Date, as PGLite returns a timestamptz.
 */
export const readLocalWriterRow: StoreMember<[id: string, opts?: { lock?: boolean }], LocalWriterRow | undefined> =
  async (brain, id) => {
    const row = await storeCall({ member: 'readLocalWriterRow' }, () => brain.readLocalWriter(id)) as
      { lane: string; credential_hash: string; grant_ceiling: LocalWriterRow['grant_ceiling']; revoked_at: string | null } | null;
    if (!row) return undefined;
    return { lane: row.lane, credential_hash: row.credential_hash, grant_ceiling: row.grant_ceiling, revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at) };
  };

/** Stores a local writer unless its id or credential hash is registered already; true when this call stored it. */
export const insertLocalWriterRow: StoreMember<[row: LocalWriterInsert], boolean> = (brain, row) =>
  storeCall({ member: 'insertLocalWriterRow' }, () => brain.insertLocalWriterRow({
    id: row.id, lane: row.lane, credentialHash: row.credentialHash, grantCeiling: row.grant,
  }));

/** `config` keys `LIKE 'persistence.limits.%'`: the prefix, then anything (no `_` in it, so no single-character wildcard). */
const LIMITS_PREFIX = 'persistence.limits.';

/**
 * The journal's config rows, then the largest page stored in segments (key null). The store keeps no segmented pages
 * (createSegmentedPageShell refuses on this engine), so that value is null, as PGLite's `max(body_bytes)` over no rows.
 * Rows are in key order; the caller reads them into a map.
 */
export const readJournalLimitRows: StoreMember<[], Array<{ key: string | null; value: string | null }>> = async (brain) => {
  const all = await storeCall({ member: 'readJournalLimitRows' }, () => brain.getAllConfig()) as Record<string, string>;
  const exact = new Set<string>([PAGE_BODY_CONFIG_KEYS.segmentedStorage, PAGE_BODY_CONFIG_KEYS.maxBytes]);
  const rows: Array<{ key: string | null; value: string | null }> = Object.keys(all)
    .filter(key => key.startsWith(LIMITS_PREFIX) || exact.has(key))
    .sort()
    .map(key => ({ key, value: all[key] }));
  rows.push({ key: null, value: null });
  return rows;
};

/** The source row's sync point (getSource) and the journal's outstanding requests of its current incarnation. */
export const readWriteWatermarkRow: StoreMember<[sourceId: string], WriteWatermarkRow> = async (brain, sourceId) => {
  const member = 'readWriteWatermarkRow';
  const source: SourceDetailRow | null = await storeCall({ member, sourceId }, () => brain.getSource(sourceId));
  const state: SourceStateRow | null = source ? await storeCall({ member, sourceId }, () => brain.readSourceState(sourceId)) : null;
  const journal = await storeCall({ member, sourceId }, () => brain.readRequestWatermark(sourceId, state?.incarnation ?? null)) as Pick<WriteWatermarkRow, 'pending_min' | 'pending_count' | 'pending_since' | 'newest_sequence'>;
  return { last_commit: source?.last_commit ?? null, last_sync_at: source?.last_sync_at ?? null, ...journal };
};

/** This engine keeps no host bindings, so the checkout is the source's own path. */
export const readSourceCheckoutRoot: StoreMember<[sourceId: string, hostId: string | null], SourceCheckoutRoot | null> = async (brain, sourceId) => {
  const state: SourceStateRow | null = await storeCall({ member: 'readSourceCheckoutRoot', sourceId }, () => brain.readSourceState(sourceId));
  return state ? { incarnation: state.incarnation, root: state.local_path } : null;
};

/** The store holds one vector column, so `column` is the text column; it keeps no embedding budget rows, so `held` is 0. */
export const readUnembeddedPageSummary: StoreMember<[sourceId: string, column: string], UnembeddedPageSummary> = async (brain, sourceId) => {
  await requireTextColumn(brain, 'readUnembeddedPageSummary');
  const row: UnembeddedPageSummary = await storeCall({ member: 'readUnembeddedPageSummary', sourceId }, () => brain.readUnembeddedPageSummary(sourceId));
  return { ...row, oldest: row.oldest == null ? null : new Date(String(row.oldest)) };
};

/** The request a principal admitted under `requestId`, or null. */
export const readWriteRequest: StoreMember<[principalKind: string, principalId: string, requestId: string], WriteRequest | null> =
  async (brain, kind, id, requestId) => requestRow(await storeCall({ member: 'readWriteRequest' }, () => brain.readWriteRequest({ kind, id }, requestId)));

/**
 * One candidate page of `list_write_requests`: the principal's requests in one live source, newest sequence first,
 * through the cursor and fences (gbrain-store `persistence/receipt_list.rs`).
 */
export const listWriteRequestRows: StoreMember<[principalKind: string, principalId: string, sourceId: string, filter: WriteRequestListFilter], WriteRequest[]> =
  async (brain, kind, id, sourceId, filter) => {
    const rows = await storeCall({ member: 'listWriteRequestRows' }, () => brain.listWriteRequestRows({ kind, id }, sourceId, filter)) as unknown[];
    return rows.map(row => requestRow<WriteRequest>(row)!);
  };

/** The request with journal id `id`, or null. `signal` changes nothing: the read does not wait on anything. */
export const readWriteRequestById: StoreMember<[id: string, opts?: { signal?: AbortSignal }], WriteRequest | null> =
  async (brain, id) => requestRow(await storeCall({ member: 'readWriteRequestById' }, () => brain.readWriteRequestById(id)));

/**
 * The progress columns of request `id`, or null: the columns PGLite's WRITE_PROGRESS_SQL selects, taken from the
 * stored row. `signal` changes nothing, as for readWriteRequestById.
 */
export const readWriteRequestProgress: StoreMember<[id: string, opts?: { signal?: AbortSignal }], WriteRequestProgress | null> = async (brain, id) => {
  const row = requestRow<WriteRequest>(await storeCall({ member: 'readWriteRequestProgress' }, () => brain.readWriteRequestById(id)));
  if (!row) return null;
  return { state: row.state, error_code: row.error_code, error_message: row.error_message, completed_at: row.completed_at, updated_at: row.updated_at,
    blocked_reason: row.blocked_reason, outcome: row.outcome, deferred_refresh_id: row.deferred_refresh_id, deferred_import_from: row.deferred_import_from };
};

/** The sources holding outstanding requests of one principal, most first; a tie in byte order of the source id, as Postgres sorts `COLLATE "C"`. */
export const countOutstandingBySource: StoreMember<[principalKind: string, principalId: string], OutstandingBySource[]> = (brain, principalKind, principalId) =>
  storeCall({ member: 'countOutstandingBySource' }, () => brain.countOutstandingBySource(principalKind, principalId));

/** The brain's one process opens its store file, so it owns every table and may apply migrations. */
export const ownsSchemaTables: StoreMember<[], boolean> = async () => true;

/**
 * The grant columns of the OAuth client that owns a write, projected from the client's whole stored row
 * (rust/docs/store/oauth-clients.md), or null for a client the store does not have. `lock` holds nothing: one process
 * owns the store, as shareLockWriteCredential below.
 */
export const readOAuthClientWriteGrant: StoreMember<[clientId: string, opts?: { lock?: boolean }], OAuthClientWriteGrant | null> = async (brain, clientId) => {
  const row = await readOauthClient(brain, clientId) as unknown as Record<string, unknown> | null;
  if (!row) return null;
  return { deleted_at: row.deleted_at ?? null, scope: row.scope ?? null, source_id: row.source_id ?? null, source_grant: row.source_grant ?? null,
    allowed_operations: row.allowed_operations ?? null, bound_slug_prefixes: row.bound_slug_prefixes ?? null, bound_tools: row.bound_tools ?? null,
    delegated_namespace: row.delegated_namespace ?? null, delegated_slug_prefixes: row.delegated_slug_prefixes ?? null };
};
/** The store keeps no legacy access tokens, so a write owned by one finds no live grant row. */
export const readAccessTokenWriteGrant: StoreMember<[tokenId: string, opts?: { lock?: boolean }], AccessTokenWriteGrant | null> = async () => null;
/** No credential row exists to hold, so the lock holds nothing (a missing row locks nothing on Postgres either). */
export const shareLockWriteCredential: StoreMember<[kind: 'oauth_client' | 'legacy_token', id: string], void> = async () => {};

/** The existing counter rows of `keys` in key byte order (`COLLATE "C"`), unlocked; a missing key has no row. */
export const readCounterRows: StoreMember<[keys: readonly string[]], CounterRow[]> = (brain, keys) =>
  storeCall({ member: 'readCounterRows' }, () => brain.readCounterRows([...keys]));

/** The brain's first request id and the latest 1,000 admissions' sample. This engine records no effect row, so `net` counts none. */
export const readAdmissionRate: StoreMember<[principal: { kind: string; id: string } | null, opts?: { sample?: boolean }], AdmissionRate> = async (brain, principal, opts) => {
  const rate = await storeCall({ member: 'readAdmissionRate' }, () => brain.readAdmissionRate(principal?.kind ?? null, principal?.id ?? null)) as AdmissionRate;
  // `{ sample: false }` saves the sample statement on Postgres; the store answers both from its rows, so only the first id is kept.
  return opts?.sample === false ? { first_request_id: rate.first_request_id, admissions: 0, age_seconds: null, gross: null, net: null } : rate;
};

/** Request `id`, or null. FOR UPDATE changes nothing in one store write (see the header). */
export const lockWriteRequest: StoreMember<[id: string], WriteRequest | null> =
  async (brain, id) => requestRow(await storeCall({ member: 'lockWriteRequest' }, () => brain.readWriteRequestById(id)));

/** The named counter rows, created at zero, in key order (bytewise, as COLLATE "C"). */
export const lockPersistenceCounters: StoreMember<[keys: readonly string[]], CounterRow[]> = (brain, keys) =>
  storeCall({ member: 'lockPersistenceCounters' }, () => brain.lockPersistenceCounters([...keys]));

/**
 * The admitted request row with its counter charge. A worktree or a refresh id that names no row refuses with the
 * foreign-key violation PGLite gives.
 */
export const insertWriteRequest: StoreMember<[row: WriteRequestInsert], WriteRequest> = async (brain, row) =>
  requestRow<WriteRequest>(await storeCall({ member: 'insertWriteRequest' }, () => brain.insertWriteRequest(row)))!;

/**
 * A grouped admission: one store write that inserts the rows in item order, so each row takes the next sequence and
 * charges its counters by one request and its own bytes; the sums are the one counter update the SQL statement makes.
 * Every row is a queued page write (target `page`, protocol 1), as the statement inserts it. A refusal at any item
 * drops the whole write, so no row and no counter charge is kept, as the one SQL statement does.
 */
export const insertWriteRequestGroup: StoreMember<[group: WriteRequestGroupInsert], WriteRequest[]> = async (brain, group) => {
  const rows = group.items.map(item => ({
    principalKind: group.principalKind, principalId: group.principalId, requestId: item.requestId, operation: group.operation,
    sourceId: group.sourceId, sourceIncarnation: group.sourceIncarnation, pageId: item.pageId, slug: item.slug, worktreeId: group.worktreeId,
    topologyGeneration: group.topologyGeneration, digest: item.digest, intent: item.intent, authority: group.authority, intentBytes: item.intentBytes,
    terminalReservation: item.terminalReservation, targetKind: 'page', protocolVersion: 1, admitterVersion: group.admitterVersion,
    admitterHostId: group.admitterHostId, counterKeys: group.counterKeys, clientRequestId: item.clientRequestId, state: 'queued', deferredRefreshId: null,
  } satisfies WriteRequestInsert));
  if (!rows.length) return [];
  const stored = await storeCall({ member: 'insertWriteRequestGroup' }, () => brain.insertWriteRequestGroup(rows)) as unknown[];
  return stored.map(row => requestRow<WriteRequest>(row)!);
};

/**
 * The requests a principal admitted under any of `requestIds`: one `readWriteRequest` each, the ones found, each row
 * once. Two spellings of one uuid (letter case) name one row, as `request_id = ANY($3::uuid[])` returns it once.
 */
export const readWriteRequestsByRequestIds: StoreMember<[principalKind: string, principalId: string, requestIds: readonly string[]], WriteRequest[]> =
  async (brain, kind, id, requestIds) => {
    const rows: WriteRequest[] = [];
    const seen = new Set<string>();
    for (const requestId of new Set(requestIds.map(requestId => requestId.toLowerCase()))) {
      const row = requestRow<WriteRequest>(await storeCall({ member: 'readWriteRequestsByRequestIds' }, () => brain.readWriteRequest({ kind, id }, requestId)));
      if (row && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
    return rows;
  };

/** The owner host's checkout path of a worktree, or null; a worktree id that is not a uuid refuses as the cast does. */
export const readOwnerHostBinding: StoreMember<[worktreeId: string], string | null> = async (brain, worktreeId) =>
  (await storeCall({ member: 'readOwnerHostBinding' }, () => brain.readOwnerHostBinding(worktreeId))) as string | null;

/** The claim stamp; `passed_sync` is false and the refresh barrier never refuses (this engine has no worktrees). */
export const stampWriteClaim: StoreMember<[id: string, token: string, leaseMs: number, phaseJson: string], ClaimedWriteRow | null> =
  async (brain, id, token, leaseMs, phaseJson) =>
    requestRow<ClaimedWriteRow>(await storeCall({ member: 'stampWriteClaim' }, () => brain.stampWriteClaim({ id, token, leaseMs, phaseJson })));

/** The completion; this engine keeps no persistence effects, so the queued effect size is 0. */
export const completeWriteRow: StoreMember<[completion: WriteCompletion], CompletedWriteRow | null> = async (brain, completion) =>
  requestRow<CompletedWriteRow>(await storeCall({ member: 'completeWriteRow' }, () => brain.completeWriteRow(completion)));

/**
 * Synchronous commit for the current transaction: nothing to set. A store commit makes every write durable before it
 * returns (gbrain-store kv.rs `commit`), so each commit already waits for the flush.
 */
export const requireSynchronousCommit: StoreMember<[], void> = async () => undefined;

/**
 * Stores a publication's effects (rust/docs/store/persistence.md, "Publication effects"): every kind is stored, a
 * gated kind is left out while `auto_link` or `mcp.remote_auto_links` is off, and a kind already queued for the
 * request is kept. Returns the kinds inserted, in queue order.
 */
export const insertPublicationEffects: StoreMember<[spec: PublicationEffectsSpec], string[]> = async (brain, spec) =>
  await storeCall({ member: 'insertPublicationEffects' }, () => brain.insertPublicationEffects(spec)) as string[];

/**
 * Queues a managed-request withdrawal's `withdrawal-mirror`, `git` and `embedding` effects (rust/docs/store/persistence.md,
 * "Withdrawal effects"), with the data the engine-sql statement binds. Inside `transaction` it is one more statement of
 * the withdrawal's store write, so the effects commit with the withdrawal or not at all.
 */
export const insertWithdrawalEffects: StoreMember<[spec: WithdrawalEffectsSpec], void> = async (brain, spec) => {
  await storeCall({ member: 'insertWithdrawalEffects' }, () => brain.insertWithdrawalEffects({ requestId: spec.requestId, sourceId: spec.sourceId,
    data: withdrawalEffectsData(spec) }));
};

/** The cancellation in one store write: the read, the check and the completion; null when the row does not exist. */
export const cancelWriteRow: StoreMember<[cancel: WriteCancellation], WriteCancelResult | null> = async (brain, cancel) => {
  const result = await storeCall({ member: 'cancelWriteRow' }, () => brain.cancelWriteRow(cancel)) as { status: WriteCancelResult['status']; row: unknown } | null;
  return result ? { status: result.status, row: requestRow<CompletedWriteRow>(result.row)! } as WriteCancelResult : null;
};

/** Extends a claim's lease; true while request `id` is running under `token`. */
export const renewWriteClaim: StoreMember<[renewal: ClaimRenewal, opts?: { signal?: AbortSignal }], boolean> = (brain, renewal) =>
  storeCall({ member: 'renewWriteClaim' }, () => brain.renewWriteClaim(renewal));

/** Returns a claim that never began to publish to queued under its token, so the writer retries it. One writer: no direct lane. */
export const releaseUnpublishedClaim: StoreMember<[release: ClaimRelease, opts?: { direct?: boolean }], void> = async (brain, release) => {
  await storeCall({ member: 'releaseUnpublishedClaim' }, () => brain.releaseUnpublishedClaim(release));
};

/** Returns expired claims, and claims of dead owners, to queued (at most 100). Every request here is unbound, so the host check passes. */
export const expireStaleWriteClaims: StoreMember<[expiry: ClaimExpiry, opts?: { signal?: AbortSignal; direct?: boolean }], void> = async (brain, expiry) => {
  await storeCall({ member: 'expireStaleWriteClaims' }, () => brain.expireStaleWriteClaims(expiry));
};

/**
 * Whether a claim would find a row now. The host id selects worktree rows; a row on a worktree refuses
 * `engine_capability_missing` until the store can read its worktree.
 */
export const hasClaimableWrite: StoreMember<[hostId: string, excludeRoots: string[], opts?: { priority?: boolean | null; signal?: AbortSignal }], boolean> =
  (brain, hostId, excludeRoots, opts) =>
    storeCall({ member: 'hasClaimableWrite' }, () => brain.hasClaimableWrite({ hostId, excludeRoots, priority: opts?.priority ?? null }));

/**
 * The request a FIFO claim takes next, or null. The whole spec goes to the store: the lease holder ranks a managed-sync
 * row whose drain lease another process holds last, and the host id, nonce and sync-seen map select worktree rows (a
 * row on a worktree refuses `engine_capability_missing` until the store can read its worktree). One process owns the
 * store, so no row is locked against another.
 */
export const selectClaimableWrite: StoreMember<[spec: ClaimHeadSpec], WriteRequest | null> = async (brain, spec) =>
  requestRow<WriteRequest>(await storeCall({ member: 'selectClaimableWrite' }, () => brain.selectClaimableWrite({
    hostId: spec.hostId, excludeRoots: spec.excludeRoots, fifoRoots: spec.fifoRoots, laneRoots: spec.laneRoots, nonce: spec.nonce,
    syncSeen: spec.syncSeen, priority: spec.priority, leaseHolder: spec.leaseHolder })));

// The consumer rows. One process owns this engine's brain, so the store keeps no consumer heartbeat rows and no
// worktrees: the reads answer none (PGLite's callers answer the same without a read) and the writes change nothing.
/** The host's consumer rows; none here. */
export const listHostConsumerRows: StoreMember<[hostId: string, opts?: { signal?: AbortSignal; direct?: boolean }], ConsumerRowRead[]> = async () => [];
/** The host's live full consumers other than the caller; none here. */
export const probeLiveConsumerRows: StoreMember<[probe: ConsumerProbe, opts?: { signal?: AbortSignal; direct?: boolean }], ConsumerRowRead[]> = async () => [];
/** The heartbeat renewal; no row is kept. */
export const renewConsumerRow: StoreMember<[renewal: ConsumerRenewal, opts?: { signal?: AbortSignal }], void> = async () => undefined;
/** The heartbeat's row delete; there is no row. */
export const deleteConsumerRow: StoreMember<[key: ConsumerRowKey, opts?: { signal?: AbortSignal }], void> = async () => undefined;
/** The worktree heartbeat stamp: `heartbeat_at` now on every worktree the host owns (the claims an unmanaged brain keeps). */
export const stampWorktreeHeartbeats: StoreMember<[hostId: string, opts?: { signal?: AbortSignal }], void> = async (brain, hostId, opts) => {
  opts?.signal?.throwIfAborted();
  await storeCall({ member: 'stampWorktreeHeartbeats' }, () => brain.stampWorktreeHeartbeats(hostId));
};

/** A source's incarnation and archive flag, or null. FOR SHARE changes nothing in one store write. */
export const readSourceMembership: StoreMember<[sourceId: string, opts?: { lock?: boolean }], SourceMembership | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceMembership' }, () => brain.readSourceMembership(sourceId));

/** The first of `requestIds` a lifecycle change of local writer `principalId` used, as `[{ request_id }]`, or []. */
export const findTopologyChanges: StoreMember<[principalId: string, requestIds: string[]], Array<{ request_id: string }>> = (brain, principalId, requestIds) =>
  storeCall({ member: 'findTopologyChanges' }, () => brain.findTopologyChanges(principalId, [...requestIds]));

/** The topology recovery scan: this host's changes with a recovery after the cursor, in id order; timestamps as Dates. */
export const listTopologyRecoveries: StoreMember<[hostId: string, after: string | null, limit: number], TopologyChange[]> = async (brain, hostId, after, limit) =>
  ((await storeCall({ member: 'listTopologyRecoveries' }, () => brain.listTopologyRecoveries(hostId, after, limit))) as unknown[]).map(row => topologyRow(row)!);

/** The lifecycle receipt of (principal, request id), or null; its two timestamps as Dates, as PGLite returns them. */
export const readTopologyChange: StoreMember<[principalId: string, requestId: string], TopologyChange | null> = async (brain, principalId, requestId) =>
  topologyRow(await storeCall({ member: 'readTopologyChange' }, () => brain.readTopologyChange(principalId, requestId)));

/** Records a lifecycle receipt; a reused (principal, request id) refuses with the unique violation PGLite gives. */
export const insertTopologyChange: StoreMember<[row: TopologyChangeInsert], TopologyChange> = async (brain, row) =>
  topologyRow(await storeCall({ member: 'insertTopologyChange' }, () => brain.insertTopologyChange(row)))!;

/**
 * The belief ledger's view of a source. Belief events, the purge epoch and take and page purges are written only
 * through `executeRaw`, which this engine refuses, so the epoch is 0 and coverage is null; a purge is possible when the
 * source holds a fact purge tombstone (`insertFactPurge`). A batch also returns the brain row with its stored mode and
 * the plan-cache mode PGLite reports, which it never changes here.
 */
export const readLedgerSource: StoreMember<[sourceId: string, opts?: { batch?: boolean }], LedgerSource | null> = async (brain, sourceId, opts) => {
  const membership = await storeCall({ member: 'readLedgerSource' }, () => brain.readSourceMembership(sourceId)) as SourceMembership | null;
  if (!membership) return null;
  const purgesPossible = await storeCall({ member: 'readLedgerSource' }, () => brain.hasFactPurges(sourceId)) as boolean;
  return { incarnation: String(membership.incarnation), purgeEpoch: 0, coverage: null, purgesPossible,
    ...(opts?.batch ? { managedRows: [{ enabled: (await readBrainMode(brain, 'readLedgerSource')).enabled }], planModePrev: PLAN_CACHE_MODE } : {}) };
};

/**
 * The store records no belief events (they are written only through `executeRaw`, which this engine refuses), so no
 * source is covered for any subject, as `readLedgerSource` answers `coverage: null`.
 */
export const listCoveredSources: StoreMember<[subjectKey: string], string[]> = async () => [];

/** `current_setting('plan_cache_mode')` on a PGLite brain that never set it. */
const PLAN_CACHE_MODE = 'auto';
