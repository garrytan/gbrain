/**
 * The write-journal members the Rust store answers: the state reads (readManagedModeRows, readLocalWriterRow,
 * insertLocalWriterRow, readJournalLimitRows, readHeldPageRows, readHeldCoverageRows), the request rows the put path
 * reads and writes (readWriteRequest, readWriteRequestById, lockPersistenceCounters, insertWriteRequest,
 * stampWriteClaim, lockWriteRequest, completeWriteRow), the claim upkeep (renewWriteClaim, expireStaleWriteClaims,
 * hasClaimableWrite), the admission reads (readSourceMembership, findTopologyChanges) and readLedgerSource.
 *
 * Each store call is one store write transaction, so the row locks PGLite takes (FOR SHARE, FOR UPDATE, the counter
 * lock) change nothing here: no other write can run between the read and the write that follows it. The callers that
 * run these members inside `transaction` still refuse until this engine serves transactions.
 *
 * What each member answers and why: rust/docs/store/journal.md ("TypeScript journal members") and
 * rust/docs/store/persistence.md.
 */
import type { LocalWriterInsert, LocalWriterRow } from '../../engine-sql/persistence-state.ts';
import type { ClaimedWriteRow, CompletedWriteRow, CounterRow, HeldCoverageRow, WriteCompletion, WriteRequestInsert } from '../../engine-sql/persistence-journal.ts';
import type { ClaimExpiry, ClaimRenewal, SourceMembership } from '../../engine-sql/persistence-claims.ts';
import type { LedgerSource } from '../../engine-sql/belief.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { PAGE_BODY_CONFIG_KEYS } from '../../page-body/limits.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The store keeps no managed brains: a brain on this engine is always unmanaged, one singleton row. */
export const readManagedModeRows: StoreMember<[], Array<{ enabled: unknown }>> = async () => [{ enabled: false }];

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

/** Sync holds are written only by the git sync path, which this engine refuses: no page is ever held. */
export const readHeldPageRows: StoreMember<[pageIds: string[]], Array<{ record: never; revision: string | null }>> = async () => [];

/** No hold rows exist on this engine (see readHeldPageRows), so no source has held coverage. */
export const readHeldCoverageRows: StoreMember<[sourceIds: string[] | null], HeldCoverageRow[]> = async () => [];

/** The request columns PGLite returns as a Date (timestamptz). */
const REQUEST_DATES = ['claim_expires_at', 'created_at', 'updated_at', 'completed_at', 'published_at', 'next_attempt_at'];

/** A stored request row as PGLite returns it: the timestamps as Dates, every other column as stored. */
function requestRow<R extends WriteRequest>(row: unknown): R | null {
  return row === null || row === undefined ? null : withDates(row as R, REQUEST_DATES);
}

/** The request a principal admitted under `requestId`, or null. */
export const readWriteRequest: StoreMember<[principalKind: string, principalId: string, requestId: string], WriteRequest | null> =
  async (brain, kind, id, requestId) => requestRow(await storeCall({ member: 'readWriteRequest' }, () => brain.readWriteRequest({ kind, id }, requestId)));

/** The request with journal id `id`, or null. `signal` changes nothing: the read does not wait on anything. */
export const readWriteRequestById: StoreMember<[id: string, opts?: { signal?: AbortSignal }], WriteRequest | null> =
  async (brain, id) => requestRow(await storeCall({ member: 'readWriteRequestById' }, () => brain.readWriteRequestById(id)));

/** Request `id`, or null. FOR UPDATE changes nothing in one store write (see the header). */
export const lockWriteRequest: StoreMember<[id: string], WriteRequest | null> =
  async (brain, id) => requestRow(await storeCall({ member: 'lockWriteRequest' }, () => brain.readWriteRequestById(id)));

/** The named counter rows, created at zero, in key order (bytewise, as COLLATE "C"). */
export const lockPersistenceCounters: StoreMember<[keys: readonly string[]], CounterRow[]> = (brain, keys) =>
  storeCall({ member: 'lockPersistenceCounters' }, () => brain.lockPersistenceCounters([...keys]));

/**
 * The admitted request row with its counter charge. A worktree or a refresh id refuses with the foreign-key violation
 * PGLite gives: this engine keeps no persistence worktrees.
 */
export const insertWriteRequest: StoreMember<[row: WriteRequestInsert], WriteRequest> = async (brain, row) =>
  requestRow<WriteRequest>(await storeCall({ member: 'insertWriteRequest' }, () => brain.insertWriteRequest(row)))!;

/** The claim stamp; `passed_sync` is false and the refresh barrier never refuses (this engine has no worktrees). */
export const stampWriteClaim: StoreMember<[id: string, token: string, leaseMs: number, phaseJson: string], ClaimedWriteRow | null> =
  async (brain, id, token, leaseMs, phaseJson) =>
    requestRow<ClaimedWriteRow>(await storeCall({ member: 'stampWriteClaim' }, () => brain.stampWriteClaim({ id, token, leaseMs, phaseJson })));

/** The completion; this engine keeps no persistence effects, so the queued effect size is 0. */
export const completeWriteRow: StoreMember<[completion: WriteCompletion], CompletedWriteRow | null> = async (brain, completion) =>
  requestRow<CompletedWriteRow>(await storeCall({ member: 'completeWriteRow' }, () => brain.completeWriteRow(completion)));

/** Extends a claim's lease; true while request `id` is running under `token`. */
export const renewWriteClaim: StoreMember<[renewal: ClaimRenewal, opts?: { signal?: AbortSignal }], boolean> = (brain, renewal) =>
  storeCall({ member: 'renewWriteClaim' }, () => brain.renewWriteClaim(renewal));

/** Returns expired claims, and claims of dead owners, to queued (at most 100). Every request here is unbound, so the host check passes. */
export const expireStaleWriteClaims: StoreMember<[expiry: ClaimExpiry, opts?: { signal?: AbortSignal; direct?: boolean }], void> = async (brain, expiry) => {
  await storeCall({ member: 'expireStaleWriteClaims' }, () => brain.expireStaleWriteClaims(expiry));
};

/** Whether a claim would find a row now. The host id selects worktree rows, which this engine never has. */
export const hasClaimableWrite: StoreMember<[hostId: string, excludeRoots: string[], opts?: { priority?: boolean | null; signal?: AbortSignal }], boolean> =
  (brain, _hostId, excludeRoots, opts) =>
    storeCall({ member: 'hasClaimableWrite' }, () => brain.hasClaimableWrite({ excludeRoots, priority: opts?.priority ?? null }));

/** A source's incarnation and archive flag, or null. FOR SHARE changes nothing in one store write. */
export const readSourceMembership: StoreMember<[sourceId: string, opts?: { lock?: boolean }], SourceMembership | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceMembership' }, () => brain.readSourceMembership(sourceId));

/** Topology changes are recorded only for worktrees, which this engine never has: no request id was used by one. */
export const findTopologyChanges: StoreMember<[principalId: string, requestIds: string[]], Array<{ request_id: string }>> = async () => [];

/**
 * The belief ledger's view of a source. Belief events and fact, take and page purges are written only through
 * `executeRaw`, which this engine refuses, so the epoch is 0, coverage is null and no purge is possible. A batch also
 * returns the one unmanaged brain row and the plan-cache mode PGLite reports, which it never changes here.
 */
export const readLedgerSource: StoreMember<[sourceId: string, opts?: { batch?: boolean }], LedgerSource | null> = async (brain, sourceId, opts) => {
  const membership = await storeCall({ member: 'readLedgerSource' }, () => brain.readSourceMembership(sourceId)) as SourceMembership | null;
  if (!membership) return null;
  return { incarnation: String(membership.incarnation), purgeEpoch: 0, coverage: null, purgesPossible: false,
    ...(opts?.batch ? { managedRows: [{ enabled: false }], planModePrev: PLAN_CACHE_MODE } : {}) };
};

/** `current_setting('plan_cache_mode')` on a PGLite brain that never set it. */
const PLAN_CACHE_MODE = 'auto';
