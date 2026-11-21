/**
 * Minion queue members (BrainEngine admitJob, getJob, listJobs, claimNextJob, renewJobLease, completeJob, failJob,
 * reclaimStalledJobs), the cycle locks (acquire, refresh, release, read, delete, delete-if-stale, assert) and the page
 * embedding leases (take, renew, release). The store keeps the `minion_jobs`, `minion_inbox` and `gbrain_cycle_locks` rows (rust/docs/store/jobs.md); timestamps cross
 * the binding as ISO strings and come back as `Date`s, as PGLite returns them.
 */
import type { BrainEngine, CycleLockFilter, CycleLockRow } from '../../engine.ts';
import type { AdmitJobPolicy, AdmitJobResult, AdmitJobSpec, ClaimJobSpec, JobRow, ListJobsFilter } from '../../engine-sql/jobs.ts';
import { QueueQuotaExceededError } from '../../minions/admission.ts';
import { WATCHDOG_SUSPECT_MARK } from '../../minions/watchdog-attribution.ts';
import { delegatedPolicyHandle } from '../delegated-policy-handle.ts';
import { withDates } from '../store-codec.ts';
import { storeErrorCode } from '../store-errors.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** The `timestamptz` columns of `minion_jobs`. */
const JOB_DATES = ['lock_until', 'delay_until', 'timeout_at', 'private_queue_lease_until', 'created_at', 'started_at', 'finished_at', 'updated_at'] as const;
const LOCK_DATES = ['acquired_at', 'ttl_expires_at', 'last_refreshed_at', 'db_now'] as const;

const jobRow = (row: JobRow | null | undefined): JobRow | null => (row ? withDates(row, JOB_DATES) : null);

/**
 * A coalesced row is the one PGLite read with `submission_authority IS NULL AS legacy_authority_is_null`; the store
 * refuses an insert without an authority (the protocol trigger), so the column is whether the row's authority is null.
 */
const keyedRow = (row: JobRow): JobRow => ({ ...jobRow(row)!, legacy_authority_is_null: row.submission_authority == null });

/** A transaction handle for a `decide` callback that must not reach the database: any use refuses. */
function noDatabase(member: string): BrainEngine {
  return new Proxy({}, { get: () => refuseMember(member, 'the coalesce policy read the database') }) as BrainEngine;
}

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

/**
 * The store runs the whole admission in one write and decides coalesce or release itself (same authority: coalesce a
 * live row, release a dead or cancelled one). A row held under another authority comes back as `conflict`, and the
 * caller's `decide` then throws the refusal PGLite throws. A delegated client's lock runs on the delegated policy handle
 * (../delegated-policy-handle.ts), where the grant read goes through readOauthClient; past it the admission still refuses before anything is
 * written, because the lock, the capacity count and the insert would be separate store calls.
 */
export const admitJob: StoreMember<[spec: AdmitJobSpec, policy: AdmitJobPolicy], AdmitJobResult> = async (brain, spec, policy) => {
  if (policy.lock || policy.checkCapacity) {
    if (policy.lock) await policy.lock(delegatedPolicyHandle(brain, 'admitJob').tx);
    refuseMember('admitJob', 'delegated client admission across store calls');
  }
  const out: { outcome: 'inserted' | 'coalesced' | 'conflict'; row: JobRow; audit: AdmitJobResult['audit'] } =
    await storeCall({ member: 'admitJob' }, async () => {
      try {
        return await brain.admitJob(spec);
      } catch (error) {
        throw admitError(error, spec);
      }
    });
  if (out.outcome === 'inserted') return { row: jobRow(out.row)!, coalesced: false, audit: null };
  const row = keyedRow(out.row);
  if (out.outcome === 'coalesced') return { row, coalesced: true, audit: out.audit ?? null };
  await policy.decide(noDatabase('admitJob'), row);
  return refuseMember('admitJob', 'a coalesce the store and the policy decide differently');
};

export const getJob: StoreMember<[id: number], JobRow | null> = async (brain, id) =>
  jobRow(await storeCall({ member: 'getJob' }, () => brain.getJob(id)));

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
export const renewJobLease: StoreMember<[id: number, lockToken: string, lockDurationMs: number, opts?: { signal?: AbortSignal }], boolean> =
  (brain, id, lockToken, lockDurationMs) => storeCall({ member: 'renewJobLease' }, () => brain.renewJobLease(id, lockToken, lockDurationMs));

export const completeJob: StoreMember<[id: number, lockToken: string, result?: Record<string, unknown>], JobRow | null> =
  async (brain, id, lockToken, result) => jobRow(await storeCall({ member: 'completeJob' }, () => brain.completeJob(id, lockToken, result ?? null)));

export const failJob: StoreMember<[id: number, lockToken: string, errorText: string, newStatus: 'delayed' | 'failed' | 'dead', backoffMs?: number, result?: Record<string, unknown>], JobRow | null> =
  async (brain, id, lockToken, errorText, newStatus, backoffMs, result) =>
    jobRow(await storeCall({ member: 'failJob' }, () => brain.failJob(id, lockToken, errorText, newStatus, backoffMs ?? null, result ?? null)));

export const reclaimStalledJobs: StoreMember<[graceMs: number], { requeued: JobRow[]; dead: JobRow[] }> = async (brain, graceMs) => {
  const out: { requeued: JobRow[]; dead: JobRow[] } = await storeCall({ member: 'reclaimStalledJobs' }, () => brain.reclaimStalledJobs(graceMs, WATCHDOG_SUSPECT_MARK));
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

/** The same snapshot-matched DELETE as releaseCycleLock. */
export const deleteCycleLock: StoreMember<[lockId: string, opts: HolderOpts], boolean> = (brain, lockId, opts) =>
  storeCall({ member: 'deleteCycleLock' }, () => brain.releaseCycleLock(lockId, opts));

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

export const renewPageEmbeddingLease: StoreMember<[leaseId: string, opts: { acquisitionToken: string; ttlMinutes: number }], boolean> = (brain, leaseId, opts) =>
  storeCall({ member: 'renewPageEmbeddingLease' }, () => brain.renewPageEmbeddingLease(leaseId, opts));

export const releasePageEmbeddingLease: StoreMember<[leaseId: string, opts: { acquisitionToken: string }], void> = async (brain, leaseId, opts) => {
  await storeCall({ member: 'releasePageEmbeddingLease' }, () => brain.releasePageEmbeddingLease(leaseId, opts));
};

export const assertCycleLease: StoreMember<[lockId: string, acquisitionToken: string], boolean> = (brain, lockId, acquisitionToken) =>
  storeCall({ member: 'assertCycleLease' }, () => brain.assertCycleLease(lockId, acquisitionToken));
