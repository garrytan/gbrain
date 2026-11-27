/**
 * Minion queue members (BrainEngine admitJob, getJob, listJobs, claimNextJob, renewJobLease, completeJob, failJob,
 * reclaimStalledJobs, readLiveJobIds), the cycle locks (acquire, refresh, release, read, delete, delete-if-stale, assert)
 * with the drain lease's holder record (readDrainLeaseBeacon, writeDrainLeaseHolder, refreshDrainLeaseHolder,
 * releaseDrainLeaseHolder), and the page embedding leases (take, renew, release). The store keeps the `minion_jobs`,
 * `minion_inbox` and `gbrain_cycle_locks` rows (rust/docs/store/jobs.md); timestamps cross
 * the binding as ISO strings and come back as `Date`s, as PGLite returns them.
 */
import type { BrainEngine, CycleLockFilter, CycleLockRow } from '../../engine.ts';
import type { DrainLeaseHolderRecord } from '../../engine-sql/cycle-locks.ts';
import type { AdmitJobPolicy, AdmitJobResult, AdmitJobSpec, ClaimJobSpec, JobRow, ListJobsFilter } from '../../engine-sql/jobs.ts';
import { QueueQuotaExceededError } from '../../minions/admission.ts';
import { WATCHDOG_SUSPECT_MARK } from '../../minions/watchdog-attribution.ts';
import type { RustEngine } from '../../rust-engine.ts';
import { withDates } from '../store-codec.ts';
import type { StoreBrain } from '../store.ts';
import { storeErrorCode } from '../store-errors.ts';
import { noDatabase, refuseMember, storeCall, type StoreMember } from './common.ts';
import type { FenceOpts } from '../../engine-sql/lease-token.ts';

/** The `timestamptz` columns of `minion_jobs`. */
const JOB_DATES = ['lock_until', 'delay_until', 'timeout_at', 'private_queue_lease_until', 'created_at', 'started_at', 'finished_at', 'updated_at'] as const;
const LOCK_DATES = ['acquired_at', 'ttl_expires_at', 'last_refreshed_at', 'db_now'] as const;

const jobRow = (row: JobRow | null | undefined): JobRow | null => (row ? withDates(row, JOB_DATES) : null);

/**
 * A coalesced row is the one PGLite read with `submission_authority IS NULL AS legacy_authority_is_null`; the store
 * refuses an insert without an authority (the protocol trigger), so the column is whether the row's authority is null.
 */
const keyedRow = (row: JobRow): JobRow => ({ ...jobRow(row)!, legacy_authority_is_null: row.submission_authority == null });


/** Store rejections of admitJob that PGLite raises as other errors. */
function admitError(error: unknown, spec: AdmitJobSpec): unknown {
  const code = storeErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'admission_refused') {
    // `queue_quota_exceeded:<name>:<waiting>:<max>`; the name may hold ':', so read the counts from the end.
    const parts = message.split(':');
    if (parts[0] === 'queue_quota_exceeded' && parts.length >= 4) {
      const max = Number(parts.pop()), waiting = Number(parts.pop());
      return new QueueQuotaExceededError(parts.slice(1).join(':') || spec.insert.name, waiting, max);
    }
  }
  // The parent refusals (not found, remote parent, finished parent, depth, max_children) are plain errors on PGLite.
  if (code === 'invalid_state') return new Error(message);
  return error;
}

type StoreAdmit = { outcome: 'inserted' | 'coalesced' | 'conflict' | 'capacity'; row: JobRow; audit: AdmitJobResult['audit'] };

/** One store admission (`capacityCheck`: stop where the capacity check runs and answer `capacity`, writing nothing). */
function storeAdmit(brain: StoreBrain, spec: AdmitJobSpec & { capacityCheck?: boolean }): Promise<StoreAdmit> {
  return storeCall({ member: 'admitJob' }, async () => {
    try {
      return await brain.admitJob(spec);
    } catch (error) {
      throw admitError(error, spec);
    }
  });
}

/** The result of a store admission that answered: an insert, a coalesce, or a conflict the policy refuses. */
async function settled(out: StoreAdmit, policy: AdmitJobPolicy): Promise<AdmitJobResult> {
  if (out.outcome === 'inserted') return { row: jobRow(out.row)!, coalesced: false, audit: null };
  const row = keyedRow(out.row);
  if (out.outcome === 'coalesced') return { row, coalesced: true, audit: out.audit ?? null };
  await policy.decide(noDatabase('admitJob'), row);
  return refuseMember('admitJob', 'a coalesce the store and the policy decide differently');
}

/**
 * The store runs the whole admission in one write and decides coalesce or release itself (same authority: coalesce a
 * live row, release a dead or cancelled one). A row held under another authority comes back as `conflict`, and the
 * caller's `decide` then throws the refusal PGLite throws.
 *
 * A delegated client's admission (a `lock` or a `checkCapacity` policy) runs in one engine transaction, in the SQL
 * order: the lock, then a store probe that answers a coalesce or stops where the capacity check runs, then the
 * policy's capacity check on the transaction, then the store admission. The policy's reads see the transaction's state,
 * and the store admits one write transaction at a time, so the check and the insert are one admission.
 */
export const admitJob = async function admitJob(this: RustEngine, brain: StoreBrain, spec: AdmitJobSpec, policy: AdmitJobPolicy): Promise<AdmitJobResult> {
  if (!policy.lock && !policy.checkCapacity) return settled(await storeAdmit(brain, spec), policy);
  return this.transaction(async (tx) => {
    const txBrain = (await (tx as unknown as RustEngine).storeFor('admitJob')).brain;
    const limit = policy.lock ? await policy.lock(tx) : null;
    if (policy.checkCapacity) {
      const probe = await storeAdmit(txBrain, { ...spec, capacityCheck: true });
      if (probe.outcome !== 'capacity') return settled(probe, policy);
      await policy.checkCapacity(tx, limit);
    }
    return settled(await storeAdmit(txBrain, spec), policy);
  });
};

export const getJob: StoreMember<[id: number], JobRow | null> = async (brain, id) =>
  jobRow(await storeCall({ member: 'getJob' }, () => brain.getJob(id)));

export const readJobDataByIdempotencyKey: StoreMember<[key: string], { data: unknown } | null> = async (brain, key) =>
  await storeCall({ member: 'readJobDataByIdempotencyKey' }, () => brain.readJobDataByIdempotencyKey(key)) as { data: unknown } | null;

/**
 * The idempotency-key step of admitJob alone, decided by the store in one write under the rule admitJob uses (above):
 * no row or a freed key reads null, a returned row comes back as PGLite read it, and a row held under another
 * authority is handed to the caller's `decide`, which throws the refusal PGLite throws.
 */
export const coalesceOnIdempotencyKey: StoreMember<[key: string, policy: { authority: unknown; decide: AdmitJobPolicy['decide'] }], JobRow | null> =
  async (brain, key, policy) => {
    const out: { outcome: 'none' | 'released' | 'coalesced' | 'conflict'; row?: JobRow } =
      await storeCall({ member: 'coalesceOnIdempotencyKey' }, () => brain.coalesceOnIdempotencyKey(key, policy.authority ?? null));
    if (out.outcome === 'none' || out.outcome === 'released') return null;
    const row = keyedRow(out.row!);
    if (out.outcome === 'coalesced') return row;
    await policy.decide(noDatabase('coalesceOnIdempotencyKey'), row);
    return refuseMember('coalesceOnIdempotencyKey', 'a coalesce the store and the policy decide differently');
  };

export const listJobs: StoreMember<[filter?: ListJobsFilter], JobRow[]> = async (brain, filter) => {
  const rows: JobRow[] = await storeCall({ member: 'listJobs' }, () => brain.listJobs(filter ?? null));
  return rows.map(r => jobRow(r)!);
};

/** The store orders an overdue watchdog suspect first (`suspectWaitMs`) with the mark this module passes. */
export const claimNextJob: StoreMember<[spec: ClaimJobSpec], JobRow | null> = async (brain, spec) => {
  if (spec.names.length === 0) return null;
  return jobRow(await storeCall({ member: 'claimNextJob' }, () => brain.claimNextJob({ ...spec, suspectMark: WATCHDOG_SUSPECT_MARK })));
};

/** The store's write is not interrupted, as a renewal already sent to the database is not; a signal is ignored. */
export const renewJobLease: StoreMember<[id: number, lockToken: string, lockDurationMs: number, opts?: { signal?: AbortSignal } & FenceOpts], boolean> =
  (brain, id, lockToken, lockDurationMs, opts) => storeCall({ member: 'renewJobLease' }, () =>
    opts?.fence ? brain.renewJobLease(id, lockToken, lockDurationMs, opts.fence) : brain.renewJobLease(id, lockToken, lockDurationMs));

export const completeJob: StoreMember<[id: number, lockToken: string, result?: Record<string, unknown>, opts?: FenceOpts], JobRow | null> =
  async (brain, id, lockToken, result, opts) => jobRow(await storeCall({ member: 'completeJob' }, () =>
    opts?.fence ? brain.completeJob(id, lockToken, result ?? null, opts.fence) : brain.completeJob(id, lockToken, result ?? null)));

export const failJob: StoreMember<[id: number, lockToken: string, errorText: string, newStatus: 'delayed' | 'failed' | 'dead', backoffMs?: number, result?: Record<string, unknown>, opts?: FenceOpts], JobRow | null> =
  async (brain, id, lockToken, errorText, newStatus, backoffMs, result, opts) =>
    jobRow(await storeCall({ member: 'failJob' }, () => opts?.fence
      ? brain.failJob(id, lockToken, errorText, newStatus, backoffMs ?? null, result ?? null, opts.fence)
      : brain.failJob(id, lockToken, errorText, newStatus, backoffMs ?? null, result ?? null)));

export const reclaimStalledJobs: StoreMember<[graceMs: number, opts?: FenceOpts], { requeued: JobRow[]; dead: JobRow[] }> = async (brain, graceMs, opts) => {
  const out: { requeued: JobRow[]; dead: JobRow[] } = await storeCall({ member: 'reclaimStalledJobs' }, () =>
    opts?.fence ? brain.reclaimStalledJobs(graceMs, WATCHDOG_SUSPECT_MARK, opts.fence) : brain.reclaimStalledJobs(graceMs, WATCHDOG_SUSPECT_MARK));
  return { requeued: out.requeued.map(r => jobRow(r)!), dead: out.dead.map(r => jobRow(r)!) };
};

// The rest of the queue (engine-sql/jobs-queue.ts).
export * from './jobs-queue.ts';
export * from './jobs-health.ts';
// The status reads (engine-sql/jobs-status.ts).
export * from './jobs-status.ts';
export * from './jobs-checks.ts';
export * from './jobs-wake.ts';
// The reads behind `describeJobs` (engine-sql/jobs-insight.ts).
export * from './jobs-insight.ts';
// Group C: the spend reservations and the lease-pressure log (engine-sql/jobs-spend.ts).
export * from './jobs-spend.ts';
// The spend ledger and the client budgets (engine-sql/spend-log.ts).
export * from './jobs-spend-log.ts';
// The oauth_clients table (engine-sql/oauth-clients.ts).
export * from './jobs-oauth-clients.ts';
// The client grant writes and audit reads (engine-sql/client-grants.ts).
export * from './jobs-client-grants.ts';
// The revoke deletes of a token and a client (engine-sql/oauth-revocation.ts).
export * from './jobs-oauth-revocation.ts';
// The access_tokens members (engine-sql/access-tokens.ts).
export * from './jobs-access-tokens.ts';
// The subagent transcript and tool ledger (engine-sql/jobs-subagent.ts).
export * from './jobs-subagent.ts';

// ---------------------------------------------------------------- cycle locks

type AcquireOpts = Parameters<BrainEngine['acquireCycleLock']>[1];
type HolderOpts = { holderPid: number; acquisitionToken: string };

export const acquireCycleLock: StoreMember<[lockId: string, opts: AcquireOpts], { id: string; fence: string } | null> = (brain, lockId, opts) =>
  storeCall({ member: 'acquireCycleLock' }, () => brain.acquireCycleLock(lockId, opts));

/** A signal is ignored, as PGLite ignores it. */
export const refreshCycleLock: StoreMember<[lockId: string, opts: HolderOpts & { ttlMinutes: number }, queryOpts?: { signal?: AbortSignal }], boolean> =
  (brain, lockId, opts) => storeCall({ member: 'refreshCycleLock' }, () => brain.refreshCycleLock(lockId, opts));

export const releaseCycleLock: StoreMember<[lockId: string, opts: HolderOpts], boolean> = (brain, lockId, opts) =>
  storeCall({ member: 'releaseCycleLock' }, () => brain.releaseCycleLock(lockId, opts));

/** The snapshot-matched DELETE of an operator or a reaper: not the holder's release, so it needs no claim epoch. */
export const deleteCycleLock: StoreMember<[lockId: string, opts: HolderOpts], boolean> = (brain, lockId, opts) =>
  storeCall({ member: 'deleteCycleLock' }, () => brain.deleteCycleLock(lockId, opts));

export const deleteCycleLockIfStale: StoreMember<[lockId: string, opts: HolderOpts & { maxAgeSeconds: number }], { deleted: boolean; lastRefreshedAt: Date | null }> =
  async (brain, lockId, opts) => {
    const out: { deleted: boolean; lastRefreshedAt: string | null } = await storeCall({ member: 'deleteCycleLockIfStale' }, () => brain.deleteCycleLockIfStale(lockId, opts));
    return { deleted: out.deleted, lastRefreshedAt: out.lastRefreshedAt == null ? null : new Date(out.lastRefreshedAt) };
  };

export const readCycleLocks: StoreMember<[filter: CycleLockFilter], CycleLockRow[]> = async (brain, filter) => {
  const rows: CycleLockRow[] = await storeCall({ member: 'readCycleLocks' }, () => brain.readCycleLocks(filter));
  return rows.map(r => withDates(r, LOCK_DATES));
};

// ---------------------------------------------------------------- page embedding leases (page-embedding-lease.ts)

type PageLeaseTake = Parameters<BrainEngine['takePageEmbeddingLease']>[1];

export const takePageEmbeddingLease: StoreMember<[leaseId: string, opts: PageLeaseTake], boolean> = (brain, leaseId, opts) =>
  storeCall({ member: 'takePageEmbeddingLease' }, () => brain.takePageEmbeddingLease(leaseId, opts));

export const renewPageEmbeddingLease: StoreMember<[leaseId: string, opts: Parameters<BrainEngine['renewPageEmbeddingLease']>[1]], boolean> = (brain, leaseId, opts) =>
  storeCall({ member: 'renewPageEmbeddingLease' }, () => brain.renewPageEmbeddingLease(leaseId, opts));

export const releasePageEmbeddingLease: StoreMember<[leaseId: string, opts: Parameters<BrainEngine['releasePageEmbeddingLease']>[1]], void> = async (brain, leaseId, opts) => {
  await storeCall({ member: 'releasePageEmbeddingLease' }, () => brain.releasePageEmbeddingLease(leaseId, opts));
};

export const assertCycleLease: StoreMember<[lockId: string, acquisitionToken: string, opts?: FenceOpts], boolean> = (brain, lockId, acquisitionToken, opts) =>
  storeCall({ member: 'assertCycleLease' }, () =>
    opts?.fence ? brain.assertCycleLease(lockId, acquisitionToken, opts.fence) : brain.assertCycleLease(lockId, acquisitionToken));

/** `readLiveJobIds`: the given ids whose job is still live, ascending (the store reads each id's row). */
export const readLiveJobIds: StoreMember<[ids: number[]], number[]> = async (brain, ids) =>
  await storeCall({ member: 'readLiveJobIds' }, () => brain.readLiveJobIds(ids)) as number[];

/** The drain lease's holder record (engine-sql/cycle-locks.ts): its beacon read, write, renewal and release. */
export const readDrainLeaseBeacon: StoreMember<[lockToken: string], Record<string, unknown> | null> = async (brain, lockToken) =>
  await storeCall({ member: 'readDrainLeaseBeacon' }, () => brain.readDrainLeaseBeacon(lockToken)) as Record<string, unknown> | null;

export const writeDrainLeaseHolder: StoreMember<[record: DrainLeaseHolderRecord], void> = async (brain, record) => {
  const data = { sourceId: record.sourceId, drain_lease_beacon: record.beacon };
  await storeCall({ member: 'writeDrainLeaseHolder', sourceId: record.sourceId }, () => record.fence
    ? brain.writeDrainLeaseHolder(record.sourceId, record.lockToken, data, record.ttlMinutes, record.fence)
    : brain.writeDrainLeaseHolder(record.sourceId, record.lockToken, data, record.ttlMinutes));
};

export const refreshDrainLeaseHolder: StoreMember<[lockToken: string, ttlMinutes: number, opts?: FenceOpts], void> = async (brain, lockToken, ttlMinutes, opts) => {
  await storeCall({ member: 'refreshDrainLeaseHolder' }, () =>
    opts?.fence ? brain.refreshDrainLeaseHolder(lockToken, ttlMinutes, opts.fence) : brain.refreshDrainLeaseHolder(lockToken, ttlMinutes));
};

export const releaseDrainLeaseHolder: StoreMember<[lockToken: string, opts?: FenceOpts], void> = async (brain, lockToken, opts) => {
  await storeCall({ member: 'releaseDrainLeaseHolder' }, () =>
    opts?.fence ? brain.releaseDrainLeaseHolder(lockToken, opts.fence) : brain.releaseDrainLeaseHolder(lockToken));
};
