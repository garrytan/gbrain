/**
 * The projection rebuild members the Rust store answers here: the window probe, the pages row estimate, and the
 * queue-row reads and stamps of the rebuild loop (readProjectionJobReason, hasSegmentedPage, rekeyProjectionJob,
 * stampDeferredProjectionJob, touchUnclaimedProjectionJob, deferProjectionJob), and the chunk keep plan of a rebuild
 * (readChunkKeepState, clearUnkeptChunkVectors, setProjectionChunkerVersion, hasDrainableProjectionJob,
 * readChunkRowsFingerprint, deleteUnkeptChunks, listStaleChunkVectors, clearChunkVectors, countPendingTextChunks;
 * src/core/engine-sql/projection-rebuild.ts). The store keeps the embedding column only; another column refuses. Each member sends the arguments of its BrainEngine member. The store
 * keeps no planner statistics, so the row estimate is the live page count (reltuples tracks the table's rows).
 */
import type { BrainEngine } from '../../engine.ts';
import type { KeepColumn, ProjectionJobKey } from '../../engine-sql/projection-rebuild.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const probeProjectionWindowCandidates: Member<'probeProjectionWindowCandidates'> = (brain, candidates) =>
  storeCall({ member: 'probeProjectionWindowCandidates' }, () => brain.probeProjectionWindowCandidates(
    candidates.map(row => ({ source_incarnation: row.source_incarnation, slug: row.slug }))));

/** The store keeps no planner statistics; the live page count stands in for the pages table's row estimate. */
export const readPagesRowEstimate: Member<'readPagesRowEstimate'> = async (brain) =>
  Number(await storeCall({ member: 'readPagesRowEstimate' }, () => brain.countBrainLivePages()) ?? 0);

export const readProjectionJobReason: Member<'readProjectionJobReason'> = (brain, key) =>
  storeCall({ member: 'readProjectionJobReason', slug: key.slug }, () => brain.readProjectionJobReason(key));

export const hasSegmentedPage: Member<'hasSegmentedPage'> = (brain, sourceId, slug) =>
  storeCall({ member: 'hasSegmentedPage', slug, sourceId }, () => brain.hasSegmentedPage(sourceId, slug));

export const rekeyProjectionJob: Member<'rekeyProjectionJob'> = async (brain, job, revision) => {
  await storeCall({ member: 'rekeyProjectionJob', slug: job.slug }, () => brain.rekeyProjectionJob(jobKey(job), revision));
};

export const stampDeferredProjectionJob: Member<'stampDeferredProjectionJob'> = async (brain, job, requeue) => {
  await storeCall({ member: 'stampDeferredProjectionJob', slug: job.slug }, () => brain.stampDeferredProjectionJob(jobKey(job), requeue));
};

export const touchUnclaimedProjectionJob: Member<'touchUnclaimedProjectionJob'> = async (brain, job) => {
  await storeCall({ member: 'touchUnclaimedProjectionJob', slug: job.slug }, () => brain.touchUnclaimedProjectionJob(jobKey(job)));
};

export const deferProjectionJob: Member<'deferProjectionJob'> = (brain, job) =>
  storeCall({ member: 'deferProjectionJob', slug: job.slug }, () => brain.deferProjectionJob(jobKey(job)));

/** The job key as the store reads it: only its three fields. */
function jobKey(job: ProjectionJobKey): ProjectionJobKey {
  return { sourceIncarnation: job.sourceIncarnation, slug: job.slug, revision: job.revision };
}

function keepColumn(member: string, column: KeepColumn): { dimensions: number } {
  if (column.name !== 'embedding') refuseMember(member, `column ${column.name}; the store keeps embedding only`);
  return { dimensions: column.dimensions };
}

export const readChunkKeepState: Member<'readChunkKeepState'> = (brain, pageId, provenanceModel, column) => {
  const { dimensions } = keepColumn('readChunkKeepState', column);
  return storeCall({ member: 'readChunkKeepState' }, () => brain.readChunkKeepState(pageId, provenanceModel, dimensions));
};

export const clearUnkeptChunkVectors: Member<'clearUnkeptChunkVectors'> = async (brain, pageId, provenanceModel, column, currentIds) => {
  const { dimensions } = keepColumn('clearUnkeptChunkVectors', column);
  await storeCall({ member: 'clearUnkeptChunkVectors' }, () =>
    brain.clearUnkeptChunkVectors(pageId, provenanceModel, dimensions, [...currentIds]));
};

/** `version` goes to the store as text, as setChunkerVersion sends it. */
export const setProjectionChunkerVersion: Member<'setProjectionChunkerVersion'> = async (brain, sourceId, slug, version) => {
  await storeCall({ member: 'setProjectionChunkerVersion', slug, sourceId }, () =>
    brain.setChunkerVersion(slug, String(version), sourceId));
};

export const hasDrainableProjectionJob: Member<'hasDrainableProjectionJob'> = (brain, opts) => {
  return storeCall({ member: 'hasDrainableProjectionJob' }, () => brain.hasDrainableProjectionJob(opts?.media === true));
};

export const readChunkRowsFingerprint: Member<'readChunkRowsFingerprint'> = (brain, pageId) =>
  storeCall({ member: 'readChunkRowsFingerprint' }, () => brain.readChunkRowsFingerprint(pageId));

export const deleteUnkeptChunks: Member<'deleteUnkeptChunks'> = async (brain, pageId, keptIds) => {
  await storeCall({ member: 'deleteUnkeptChunks' }, () => brain.deleteUnkeptChunks(pageId, [...keptIds]));
};

export const listStaleChunkVectors: Member<'listStaleChunkVectors'> = (brain, pageId, provenanceModel, column, currentIds) => {
  const { dimensions } = keepColumn('listStaleChunkVectors', column);
  return storeCall({ member: 'listStaleChunkVectors' }, () =>
    brain.listStaleChunkVectors(pageId, provenanceModel, dimensions, [...currentIds]));
};

export const clearChunkVectors: Member<'clearChunkVectors'> = async (brain, pageId, column, ids) => {
  keepColumn('clearChunkVectors', column);
  await storeCall({ member: 'clearChunkVectors' }, () => brain.clearChunkVectors(pageId, [...ids]));
};

export const countPendingTextChunks: Member<'countPendingTextChunks'> = (brain, pageId, column) => {
  keepColumn('countPendingTextChunks', column);
  return storeCall({ member: 'countPendingTextChunks' }, () => brain.countPendingTextChunks(pageId));
};
