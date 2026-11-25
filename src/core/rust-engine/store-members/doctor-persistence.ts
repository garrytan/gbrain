/**
 * Doctor persistence reads (src/core/engine-sql/doctor-persistence.ts).
 *
 * Served from the store (rust/crates/gbrain-store/src/cli_reads/doctor_persistence.rs): the reads over the request
 * journal and the counters, which the store keeps, the stale embedding effects (persistence/embedding_candidates.rs),
 * the effect and movement reads (persistence/writer_status_queue.rs) and the worktree binding reads
 * (persistence/binding_reads.rs). Answered in TypeScript with no store call: the reads over a relation the store has no
 * writer for (consumers, derivation sweeps), which hold no row on this engine, so each answers the empty state the same
 * read gives on a PGLite brain with none. rust/docs/store/cli-reads-doctor-per.md names each member and the reason.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { managedServed } from './managed-hold.ts';
import type { StoreBrain } from '../store.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';
import type { GitPushHoldRow, OrphanBindingRow, OwnerBindingRow, StalledCatchupRow } from '../../engine-sql/doctor-persistence.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** `principal` as the two nullable arguments the store takes. */
const principalArgs = (principal: readonly [kind: string, id: string] | null): [string | null, string | null] => [principal?.[0] ?? null, principal?.[1] ?? null];

// ---- served from the store ----------------------------------------------------------------------------------------

export const listCapacityCounters: Member<'listCapacityCounters'> = async brain =>
  await storeCall({ member: 'listCapacityCounters' }, () => brain.listCapacityCounters()) as Awaited<ReturnType<BrainEngine['listCapacityCounters']>>;

export const listLifetimeCounters: Member<'listLifetimeCounters'> = async brain =>
  await storeCall({ member: 'listLifetimeCounters' }, () => brain.listLifetimeCounters()) as Awaited<ReturnType<BrainEngine['listLifetimeCounters']>>;

/** The store counts exactly; `estimate` (Postgres's planner row estimate) has nothing to be cheaper than. */
export const countPersistenceRequestRows: Member<'countPersistenceRequestRows'> = async brain =>
  await storeCall({ member: 'countPersistenceRequestRows' }, () => brain.countPersistenceRequestRows()) as { rows: string };

export const readAdmissionSample: Member<'readAdmissionSample'> = async (brain, principal) =>
  await storeCall({ member: 'readAdmissionSample' }, () => brain.readAdmissionSample(...principalArgs(principal))) as Awaited<ReturnType<BrainEngine['readAdmissionSample']>>;

export const listOutstandingHolders: Member<'listOutstandingHolders'> = async (brain, principal) =>
  await storeCall({ member: 'listOutstandingHolders' }, () => brain.listOutstandingHolders(...principalArgs(principal))) as Awaited<ReturnType<BrainEngine['listOutstandingHolders']>>;

export const listRunningRequestStalls: Member<'listRunningRequestStalls'> = async (brain, maxClaimMs) =>
  await storeCall({ member: 'listRunningRequestStalls' }, () => brain.listRunningRequestStalls(maxClaimMs)) as Awaited<ReturnType<BrainEngine['listRunningRequestStalls']>>;

export const readMaxRequestSequence: Member<'readMaxRequestSequence'> = async brain =>
  await storeCall({ member: 'readMaxRequestSequence' }, () => brain.readMaxRequestSequence()) as string | null;

export const listRecentDriftReceiptSlugs: Member<'listRecentDriftReceiptSlugs'> = async (brain, sourceId, floor, message) =>
  await storeCall({ member: 'listRecentDriftReceiptSlugs', sourceId }, () => brain.listRecentDriftReceiptSlugs(sourceId, floor, message)) as Awaited<ReturnType<BrainEngine['listRecentDriftReceiptSlugs']>>;

/** The store scans the journal in memory, so the statement timeout `timeoutMs` bounds has nothing to cut short. */
export const listOlderDriftReceiptSlugs: Member<'listOlderDriftReceiptSlugs'> = async (brain, sourceId, floor, message) =>
  await storeCall({ member: 'listOlderDriftReceiptSlugs', sourceId }, () => brain.listOlderDriftReceiptSlugs(sourceId, floor, message)) as Awaited<ReturnType<BrainEngine['listOlderDriftReceiptSlugs']>>;

export const listRefusalBreakerRows: Member<'listRefusalBreakerRows'> = async (brain, sourceId, windowHours, threshold, limit) =>
  await storeCall({ member: 'listRefusalBreakerRows', sourceId }, () => brain.listRefusalBreakerRows(sourceId, windowHours, threshold, limit)) as Awaited<ReturnType<BrainEngine['listRefusalBreakerRows']>>;

export const readCounterDrift: Member<'readCounterDrift'> = async (brain, clampedKey) =>
  await storeCall({ member: 'readCounterDrift' }, () => brain.readCounterDrift(clampedKey)) as Awaited<ReturnType<BrainEngine['readCounterDrift']>>;

export const readPublicationRefusals: Member<'readPublicationRefusals'> = async brain =>
  await storeCall({ member: 'readPublicationRefusals' }, () => brain.readPublicationRefusals()) as Awaited<ReturnType<BrainEngine['readPublicationRefusals']>>;

/**
 * A running claim on a worktree is judged by the host that owns the worktree (its record); a claim on none is every host's.
 * While the managed hold is on (store-members/managed-hold.ts) the list answers as it did before: only the claims on no
 * worktree, since a user's Rust brain holds no managed worktree request.
 */
export const listRunningClaimOwners = async function (this: unknown, brain: StoreBrain, hostId: string): ReturnType<Member<'listRunningClaimOwners'>> {
  return await storeCall({ member: 'listRunningClaimOwners' }, () => brain.listRunningClaimOwners(managedServed(this) ? hostId : null)) as Awaited<ReturnType<BrainEngine['listRunningClaimOwners']>>;
};

export const listLocalEditAdoptions: Member<'listLocalEditAdoptions'> = async brain =>
  await storeCall({ member: 'listLocalEditAdoptions' }, () => brain.listLocalEditAdoptions()) as Awaited<ReturnType<BrainEngine['listLocalEditAdoptions']>>;

export const listCallerRefusalRows: Member<'listCallerRefusalRows'> = async (brain, sourceIds, operations) =>
  await storeCall({ member: 'listCallerRefusalRows' }, () => brain.listCallerRefusalRows(sourceIds, operations)) as Awaited<ReturnType<BrainEngine['listCallerRefusalRows']>>;

export const countCompactedCallerRefusals: Member<'countCompactedCallerRefusals'> = async (brain, sourceIds, operations) =>
  Number(await storeCall({ member: 'countCompactedCallerRefusals' }, () => brain.countCompactedCallerRefusals(sourceIds, operations)));

export const listRecentWriterVersions: Member<'listRecentWriterVersions'> = async (brain, days) =>
  await storeCall({ member: 'listRecentWriterVersions' }, () => brain.listRecentWriterVersions(days)) as Awaited<ReturnType<BrainEngine['listRecentWriterVersions']>>;

/** The persistence identity as text; the store holds it as the same uuid text. */
export const readPersistenceBrainIdText: Member<'readPersistenceBrainIdText'> = brain => readPersistenceBrainId(brain);

/** Each active source with a local path is a managed root; no host binds another (the store records none). */
export const listManagedRoots: Member<'listManagedRoots'> = async brain => {
  const rows = await storeCall({ member: 'listManagedRoots' }, () => brain.listAllSources({})) as Array<{ id: string; local_path: string | null }>;
  return rows.filter(row => row.local_path != null).map(row => ({ root: row.local_path as string, source_id: row.id }));
};

// ---- worktree bindings: the rows the writer claim keeps (persistence/worktrees.rs; persistence/binding_reads.rs) ----

/** Source bindings whose source is gone or was re-created, by source id, at most `limit` when given. */
export const listOrphanBindingRows: Member<'listOrphanBindingRows'> = async (brain, limit) => {
  if (limit) {
    const rows = Math.floor(limit);
    if (!Number.isFinite(rows)) throw new Error('listOrphanBindingRows: limit must be a finite number');
    limit = rows;
  }
  const rows = await storeCall({ member: 'listOrphanBindingRows' }, () => brain.listOrphanBindingRows(limit || undefined)) as Array<OrphanBindingRow & { pending_requests: number | string }>;
  return rows.map(row => ({ ...row, pending_requests: Number(row.pending_requests) }));
};
/** Every stored worktree id. */
export const listWorktreeIds: Member<'listWorktreeIds'> = async (brain) =>
  storeCall({ member: 'listWorktreeIds' }, () => brain.listWorktreeIds()) as Promise<string[]>;
/** Worktrees a host other than `hostId` owns (not recovering), with the owner's path and source ids, oldest first. */
export const listOwnerBindings: Member<'listOwnerBindings'> = async (brain, hostId) =>
  storeCall({ member: 'listOwnerBindings' }, () => brain.listOwnerBindings(hostId)) as Promise<OwnerBindingRow[]>;

/**
 * The online-built request indexes: the Rust store keeps no SQL indexes; its request lookups are key scans of the request
 * records, so no index can be missing, invalid or still being built. Every name reads valid: doctor
 * `persistence_request_indexes` prints what a healthy SQL brain prints and `gbrain repair request-indexes` applies nothing.
 */
export const readRequestIndexStates: Member<'readRequestIndexStates'> = async (_brain, names) =>
  names.map(name => ({ name, valid: true, phase: null, blocks_done: null, blocks_total: null }));

// ---- empty: the store has no writer for the relation ---------------------------------------------------------------

/** No consumer heartbeat is recorded (persistence_consumers has no writer). */
export const readLiveConsumerSummary: Member<'readLiveConsumerSummary'> = async () => ({ live: '0', oldest_hours: null });
/** Served from the store's effect records (persistence/writer_status_queue.rs). */
export const countParkedEffects: Member<'countParkedEffects'> = async (brain, sourceIds) =>
  Number(await storeCall({ member: 'countParkedEffects' }, () => brain.parkedEffectCount(sourceIds)));
/** Served from the store's effect, request and source binding records; `request` is the stored row, as `to_jsonb(r)` is. */
export const listParkedEffects: Member<'listParkedEffects'> = async (brain, sourceIds) =>
  await storeCall({ member: 'listParkedEffects' }, () => brain.parkedEffectRows(sourceIds)) as Awaited<ReturnType<BrainEngine['listParkedEffects']>>;
/** Served from the store's effect, request, host binding and source binding records; `oldest_at` as a `Date`, as the SQL engines return it. */
export const listGitPushHoldRows: Member<'listGitPushHoldRows'> = async (brain, codes, sourceIds) => {
  const rows = await storeCall({ member: 'listGitPushHoldRows' }, () => brain.gitPushHoldRows([...codes], sourceIds)) as Array<Omit<GitPushHoldRow, 'oldest_at'> & { oldest_at: string }>;
  return rows.map(row => ({ ...row, oldest_at: new Date(row.oldest_at) }));
};
/** Served from the store's effect records (persistence/writer_status_queue.rs); `since` as a `Date`, as the SQL engines return it. */
export const listStalledCatchupRows: Member<'listStalledCatchupRows'> = async (brain, sourceIds, stallMs) => {
  const rows = await storeCall({ member: 'listStalledCatchupRows' }, () => brain.stalledCatchupRows(sourceIds, stallMs)) as Array<Omit<StalledCatchupRow, 'since'> & { since: string }>;
  return rows.map(row => ({ ...row, since: new Date(row.since) }));
};
/** Served from the store's effect, request, source binding and source records (persistence/writer_status_queue.rs). */
export const listParkedGroupRows: Member<'listParkedGroupRows'> = async (brain, sourceIds) =>
  await storeCall({ member: 'listParkedGroupRows' }, () => brain.parkedGroupRows(sourceIds)) as Awaited<ReturnType<BrainEngine['listParkedGroupRows']>>;
/** Stale queued and failed embedding effects of committed writes, served from the store's effect rows (persistence/embedding_candidates.rs). */
export const readStaleEmbeddingCounts: Member<'readStaleEmbeddingCounts'> = async (brain, sourceIds) => {
  const row = await storeCall({ member: 'readStaleEmbeddingCounts' }, () => brain.readStaleEmbeddingCounts(sourceIds ? [...sourceIds] : null)) as Record<string, unknown>;
  return { count: Number(row.count), failed: Number(row.failed), requeued: Number(row.requeued) };
};
export const listStaleEmbeddingEffects: Member<'listStaleEmbeddingEffects'> = (brain, sourceIds) =>
  storeCall({ member: 'listStaleEmbeddingEffects' }, () => brain.listStaleEmbeddingEffects(sourceIds ? [...sourceIds] : null));
/** Served from the store's source binding, worktree and source records (persistence/writer_status_queue.rs). */
export const listSourceBindingsForMovement: Member<'listSourceBindingsForMovement'> = async (brain, sourceIds) =>
  await storeCall({ member: 'listSourceBindingsForMovement' }, () => brain.movementBindingRows(sourceIds)) as Awaited<ReturnType<BrainEngine['listSourceBindingsForMovement']>>;
export const listConsumerOwners: Member<'listConsumerOwners'> = async () => [];
export const listStuckWorktreeRefreshes: Member<'listStuckWorktreeRefreshes'> = (brain, minutes) =>
  storeCall({ member: 'listStuckWorktreeRefreshes' }, () => brain.refreshRows({ kind: 'stuck', minutes })) as ReturnType<Member<'listStuckWorktreeRefreshes'>>;
/**
 * The request ids of the page and fact purges the store's `page_purges` (`F 0x0C`) and `fact_purges` (`F 0x0F`) ledgers
 * hold. The store keeps no `take_purges` row, so that arm adds nothing.
 */
export const listRecentPurgeRequests: Member<'listRecentPurgeRequests'> = (brain, days, cap) =>
  storeCall({ member: 'listRecentPurgeRequests' }, () => brain.listRecentPurgeRequests(days, cap));
/** The store records no derivation-result sweep of a fact purge. */
export const listDerivationPurgeSweeps: Member<'listDerivationPurgeSweeps'> = async () => [];
/** The store has no `database_only_reason` on a page, so no page was written database-only to an unbound source. */
export const listUnboundSourcePages: Member<'listUnboundSourcePages'> = async () => [];
