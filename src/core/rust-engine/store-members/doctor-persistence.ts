/**
 * Doctor persistence reads (src/core/engine-sql/doctor-persistence.ts).
 *
 * Served from the store (rust/crates/gbrain-store/src/cli_reads/doctor_persistence.rs): the reads over the request
 * journal and the counters, which the store keeps, and the stale embedding effects (persistence/embedding_candidates.rs). Answered in TypeScript with no store call: the reads over a
 * relation the store has no writer for (worktrees, host bindings, consumers, effects, derivation
 * sweeps), which hold no row on this engine, so each answers the empty state the same read gives on a PGLite brain with
 * none. rust/docs/store/cli-reads-doctor-per.md names each member and the reason.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

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

/** The store records no worktree, so a running claim on one has no owning host; `hostId` selects nothing more. */
export const listRunningClaimOwners: Member<'listRunningClaimOwners'> = async brain =>
  await storeCall({ member: 'listRunningClaimOwners' }, () => brain.listRunningClaimOwners()) as Awaited<ReturnType<BrainEngine['listRunningClaimOwners']>>;

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

// ---- empty: the store has no writer for the relation ---------------------------------------------------------------

/** No consumer heartbeat is recorded (persistence_consumers has no writer). */
export const readLiveConsumerSummary: Member<'readLiveConsumerSummary'> = async () => ({ live: '0', oldest_hours: null });
/** No effect is recorded here, so none is parked. */
export const countParkedEffects: Member<'countParkedEffects'> = async () => 0;
export const listParkedEffects: Member<'listParkedEffects'> = async () => [];
export const listGitPushHoldRows: Member<'listGitPushHoldRows'> = async () => [];
export const listStalledCatchupRows: Member<'listStalledCatchupRows'> = async () => [];
export const listParkedGroupRows: Member<'listParkedGroupRows'> = async () => [];
/** Stale queued and failed embedding effects of committed writes, served from the store's effect rows (persistence/embedding_candidates.rs). */
export const readStaleEmbeddingCounts: Member<'readStaleEmbeddingCounts'> = async (brain, sourceIds) => {
  const row = await storeCall({ member: 'readStaleEmbeddingCounts' }, () => brain.readStaleEmbeddingCounts(sourceIds ? [...sourceIds] : null)) as Record<string, unknown>;
  return { count: Number(row.count), failed: Number(row.failed), requeued: Number(row.requeued) };
};
export const listStaleEmbeddingEffects: Member<'listStaleEmbeddingEffects'> = (brain, sourceIds) =>
  storeCall({ member: 'listStaleEmbeddingEffects' }, () => brain.listStaleEmbeddingEffects(sourceIds ? [...sourceIds] : null));
/** No worktree or source binding row exists, so none is orphaned. */
export const listOrphanBindingRows: Member<'listOrphanBindingRows'> = async () => [];
export const listWorktreeIds: Member<'listWorktreeIds'> = async () => [];
export const listSourceBindingsForMovement: Member<'listSourceBindingsForMovement'> = async () => [];
export const listOwnerBindings: Member<'listOwnerBindings'> = async () => [];
export const listConsumerOwners: Member<'listConsumerOwners'> = async () => [];
export const listStuckWorktreeRefreshes: Member<'listStuckWorktreeRefreshes'> = async () => [];
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
