/**
 * The persistence state members the import and put paths reach (BrainEngine readManagedModeRows, ownsSchemaTables,
 * readLocalWriterRow, insertLocalWriterRow): the one brain row's stored mode, the store owning its
 * own tables, and the local writer registration every CLI write checks (persistence/identity.ts registerLocalWriter).
 */
import type { LocalWriterInsert, LocalWriterRow } from '../../engine-sql/persistence-state.ts';
import type { AccessTokenWriteGrant, AdmissionRate, ClaimedWriteRow, CompletedWriteRow, CounterRow, OAuthClientWriteGrant, PublicationEffectsSpec, TerminalIntentCompaction, WriteCompletion, WriteRequestInsert, WriteRequestProgress } from '../../engine-sql/persistence-journal.ts';
import type { ClaimRelease, ClaimRenewal, SourceMembership, TopologyChange } from '../../engine-sql/persistence-claims.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { PAGE_BODY_CONFIG_KEYS } from '../../page-body/limits.ts';
import type { StoreBrain } from '../store.ts';
import { requestRow, topologyRow, uuidText, withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { LedgerSource } from '../../engine-sql/belief.ts';
import type { ClaimExpiry } from '../../engine-sql/persistence-claims.ts';
import type { ClaimHeadSpec } from '../../engine-sql/persistence-claims.ts';
import type { ConsumerRenewal } from '../../engine-sql/persistence-claims.ts';
import type { ConsumerRowKey } from '../../engine-sql/persistence-claims.ts';

/** The stored brain mode: `enabled` and `mode_epoch` (text) of the persistence brain row. */
async function readBrainMode(brain: StoreBrain, member: string): Promise<{ enabled: boolean; mode_epoch: string }> {
  return storeCall({ member }, () => brain.writerReleaseRows({ kind: 'brain_mode' }));
}

/** The one singleton row with the stored brain mode (gbrain-store `persistence::worktrees::release`; classic until activated). */
export const readManagedModeRows: StoreMember<[], Array<{ enabled: unknown }>> = async (brain) =>
  [{ enabled: (await readBrainMode(brain, 'readManagedModeRows')).enabled }];

/** The brain's one process opens its store file, so it owns every table and may apply migrations. */
export const ownsSchemaTables: StoreMember<[], boolean> = async () => true;

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

/** The lifecycle receipt of (local writer, request id), or null: a page write refuses a request id a lifecycle change used. */
export const readTopologyChange: StoreMember<[principalId: string, requestId: string], TopologyChange | null> = async (brain, principalId, requestId) =>
  topologyRow(await storeCall({ member: 'readTopologyChange' }, () => brain.readTopologyChange(principalId, requestId)));

/** The config keys under which the journal's admission limits live. */
const LIMITS_PREFIX = 'persistence.limits.';

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

export const readWriteRequest: StoreMember<[principalKind: string, principalId: string, requestId: string], WriteRequest | null> =
  async (brain, kind, id, requestId) => requestRow(await storeCall({ member: 'readWriteRequest' }, () => brain.readWriteRequest({ kind, id }, requestId)));

export const readWriteRequestById: StoreMember<[id: string, opts?: { signal?: AbortSignal }], WriteRequest | null> =
  async (brain, id) => requestRow(await storeCall({ member: 'readWriteRequestById' }, () => brain.readWriteRequestById(id)));

export const readOAuthClientWriteGrant: StoreMember<[clientId: string, opts?: { lock?: boolean }], OAuthClientWriteGrant | null> = async (brain, clientId) => {
  const row = await storeCall({ member: 'readOAuthClientWriteGrant' }, () => brain.readOauthClientWriteGrant(clientId)) as OAuthClientWriteGrant | null;
  return row ? withDates(row, ['deleted_at']) : null;
};
export const readAccessTokenWriteGrant: StoreMember<[tokenId: string, opts?: { lock?: boolean }], AccessTokenWriteGrant | null> = async (brain, tokenId) => {
  const id = uuidText(tokenId);
  const row = await storeCall({ member: 'readAccessTokenWriteGrant' }, () => brain.readAccessTokenWriteGrant(id)) as AccessTokenWriteGrant | null;
  return row ? withDates(row, ['revoked_at']) : null;
};
export const shareLockWriteCredential: StoreMember<[kind: 'oauth_client' | 'legacy_token', id: string], void> = async () => {};

export const readCounterRows: StoreMember<[keys: readonly string[]], CounterRow[]> = (brain, keys) =>
  storeCall({ member: 'readCounterRows' }, () => brain.readCounterRows([...keys]));

export const readAdmissionRate: StoreMember<[principal: { kind: string; id: string } | null, opts?: { sample?: boolean }], AdmissionRate> = async (brain, principal, opts) => {
  const rate = await storeCall({ member: 'readAdmissionRate' }, () => brain.readAdmissionRate(principal?.kind ?? null, principal?.id ?? null)) as AdmissionRate;
  // `{ sample: false }` saves the sample statement on Postgres; the store answers both from its rows, so only the first id is kept.
  return opts?.sample === false ? { first_request_id: rate.first_request_id, admissions: 0, age_seconds: null, gross: null, net: null } : rate;
};

export const lockWriteRequest: StoreMember<[id: string], WriteRequest | null> =
  async (brain, id) => requestRow(await storeCall({ member: 'lockWriteRequest' }, () => brain.readWriteRequestById(id)));

export const lockPersistenceCounters: StoreMember<[keys: readonly string[]], CounterRow[]> = (brain, keys) =>
  storeCall({ member: 'lockPersistenceCounters' }, () => brain.lockPersistenceCounters([...keys]));

export const insertWriteRequest: StoreMember<[row: WriteRequestInsert], WriteRequest> = async (brain, row) =>
  requestRow<WriteRequest>(await storeCall({ member: 'insertWriteRequest' }, () => brain.insertWriteRequest(row)))!;

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

export const stampWriteClaim: StoreMember<[id: string, token: string, leaseMs: number, phaseJson: string], ClaimedWriteRow | null> =
  async (brain, id, token, leaseMs, phaseJson) =>
    requestRow<ClaimedWriteRow>(await storeCall({ member: 'stampWriteClaim' }, () => brain.stampWriteClaim({ id, token, leaseMs, phaseJson })));

export const completeWriteRow: StoreMember<[completion: WriteCompletion], CompletedWriteRow | null> = async (brain, completion) =>
  requestRow<CompletedWriteRow>(await storeCall({ member: 'completeWriteRow' }, () => brain.completeWriteRow(completion)));

export const lockWriteRequestsById: StoreMember<[ids: readonly string[]], WriteRequest[]> = async (brain, ids) => {
  const ordered = [...new Set(ids.map(id => id.toLowerCase()))].sort();
  const rows: WriteRequest[] = [];
  for (const id of ordered) {
    const row = requestRow<WriteRequest>(await storeCall({ member: 'lockWriteRequestsById' }, () => brain.readWriteRequestById(id)));
    if (row) rows.push(row);
  }
  return rows;
};

export const compactTerminalIntent: StoreMember<[compaction: TerminalIntentCompaction], WriteRequest | null> = async (brain, compaction) =>
  requestRow<WriteRequest>(await storeCall({ member: 'compactTerminalIntent' }, () => brain.compactTerminalIntent({ ...compaction, counterKeys: [...compaction.counterKeys] })));

export const insertPublicationEffects: StoreMember<[spec: PublicationEffectsSpec], string[]> = async (brain, spec) =>
  await storeCall({ member: 'insertPublicationEffects' }, () => brain.insertPublicationEffects(spec)) as string[];

export const renewWriteClaim: StoreMember<[renewal: ClaimRenewal, opts?: { signal?: AbortSignal }], boolean> = (brain, renewal) =>
  storeCall({ member: 'renewWriteClaim' }, () => brain.renewWriteClaim(renewal));

export const releaseUnpublishedClaim: StoreMember<[release: ClaimRelease, opts?: { direct?: boolean }], void> = async (brain, release) => {
  await storeCall({ member: 'releaseUnpublishedClaim' }, () => brain.releaseUnpublishedClaim(release));
};

export const readSourceMembership: StoreMember<[sourceId: string, opts?: { lock?: boolean | 'update' }], SourceMembership | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceMembership' }, () => brain.readSourceMembership(sourceId));

export const findTopologyChanges: StoreMember<[principalId: string, requestIds: string[]], Array<{ request_id: string }>> = (brain, principalId, requestIds) =>
  storeCall({ member: 'findTopologyChanges' }, () => brain.findTopologyChanges(principalId, [...requestIds]));

/** `current_setting('plan_cache_mode')` on a PGLite brain that never set it. */
const PLAN_CACHE_MODE = 'auto';
const PLAN_CACHE_SETTING = 'plan_cache_mode';

/**
 * The belief ledger's view of a source (gbrain-store `trust::belief_history`): its incarnation, purge epoch and newest
 * coverage event, and whether a purge tombstone or a raised epoch makes a purge possible. A batch also returns the one
 * unmanaged brain row and the plan-cache mode it replaced: inside a transaction with coverage active it sets the
 * transaction's `plan_cache_mode` to `force_generic_plan` (transactions.ts keeps it), as the SQL batch does with
 * `set_config`. The store has no planner, so the setting changes nothing else.
 */
export const readLedgerSource = async function readLedgerSource(this: RustEngine, brain: StoreBrain, sourceId: string, opts?: { batch?: boolean }): Promise<LedgerSource | null> {
  const row = await storeCall({ member: 'readLedgerSource' }, () => brain.readLedgerSource(sourceId)) as LedgerSource | null;
  if (!row) return null;
  if (!opts?.batch) return row;
  const scope = this._txScope && !this._txScope.ended ? this._txScope : null;
  const planModePrev = scope?.settings.get(PLAN_CACHE_SETTING) ?? PLAN_CACHE_MODE;
  if (scope && row.coverage !== null && row.coverage !== 'coverage.stopped') scope.settings.set(PLAN_CACHE_SETTING, 'force_generic_plan');
  return { ...row, managedRows: [{ enabled: false }], planModePrev };
};

/** The heartbeat's row delete; there is no row. */
export const deleteConsumerRow: StoreMember<[key: ConsumerRowKey, opts?: { signal?: AbortSignal }], void> = async () => undefined;

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

/** The topology recovery scan: this host's changes with a recovery after the cursor, in id order; timestamps as Dates. */
export const listTopologyRecoveries: StoreMember<[hostId: string, after: string | null, limit: number], TopologyChange[]> = async (brain, hostId, after, limit) =>
  ((await storeCall({ member: 'listTopologyRecoveries' }, () => brain.listTopologyRecoveries(hostId, after, limit))) as unknown[]).map(row => topologyRow(row)!);

/** The heartbeat renewal; no row is kept. */
export const renewConsumerRow: StoreMember<[renewal: ConsumerRenewal, opts?: { signal?: AbortSignal }], void> = async () => undefined;

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

/** The worktree heartbeat stamp: `heartbeat_at` now on every worktree the host owns (the claims an unmanaged brain keeps). */
export const stampWorktreeHeartbeats: StoreMember<[hostId: string, opts?: { signal?: AbortSignal }], void> = async (brain, hostId, opts) => {
  opts?.signal?.throwIfAborted();
  await storeCall({ member: 'stampWorktreeHeartbeats' }, () => brain.stampWorktreeHeartbeats(hostId));
};

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

/**
 * Synchronous commit for the current transaction: nothing to set. A store commit makes every write durable before it
 * returns (gbrain-store kv.rs `commit`), so each commit already waits for the flush.
 */
export const requireSynchronousCommit: StoreMember<[], void> = async () => undefined;
