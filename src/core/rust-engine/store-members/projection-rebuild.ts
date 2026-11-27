/**
 * A projection rebuild's queue, keep-plan and seal members (src/core/engine-sql/projection-rebuild.ts), served from
 * rust/crates/gbrain-store/src/persistence/projection_rebuild.rs. Each member sends the arguments of its BrainEngine
 * member.
 *
 * The deferred chunk replacement's members (the row fingerprint, the unkept-row delete, the stale-vector list and
 * clear, the page head, the claim probe and renewal), the rebuild loop's queue stamps, the window probe, the queue insert and
 * the drain's clock, work probe, backlog and preview are served too. The
 * fingerprint is the store's own opaque value: a caller only compares two of them.
 *
 * The store keeps one vector column, `embedding`, so the keep-plan and vector members refuse any other column. The store
 * classes image pages as projectionClassSql does (sealable or reimport), so the drained and work probes serve `media` and
 * the backlog and preview count image pages. The row estimate is the live page count (the store keeps no planner
 * statistics; reltuples tracks the table's rows). `setProjectionChunkerVersion` is the
 * store's `setChunkerVersion`, which stamps the same column.
 */
import type { BrainEngine } from '../../engine.ts';
import type { KeepColumn, ProjectionJobKey } from '../../engine-sql/projection-rebuild.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function keepColumn(member: string, column: KeepColumn): { dimensions: number } {
  if (column.name !== 'embedding') refuseMember(member, `column ${column.name}; the store keeps embedding only`);
  return { dimensions: column.dimensions };
}

export const readChunkInputHashes: Member<'readChunkInputHashes'> = (brain, pageId) =>
  storeCall({ member: 'readChunkInputHashes' }, () => brain.readChunkInputHashes(pageId));
export const clearChunkEmbeddingsByIds: Member<'clearChunkEmbeddingsByIds'> = async (brain, pageId, column, ids) => {
  keepColumn('clearChunkEmbeddingsByIds', column);
  await storeCall({ member: 'clearChunkEmbeddingsByIds' }, () => brain.clearChunkEmbeddingsByIds(pageId, [...ids]));
};
export const writeChunkInputHashes: Member<'writeChunkInputHashes'> = async (brain, pageId, ids, hashes) => {
  await storeCall({ member: 'writeChunkInputHashes' }, () => brain.writeChunkInputHashes(pageId, [...ids], [...hashes]));
};

export const listQueuedPageProjections: Member<'listQueuedPageProjections'> = (brain, filter) =>
  storeCall({ member: 'listQueuedPageProjections' }, () => brain.listQueuedPageProjections({
    limit: filter.limit, retryCooldown: filter.retryCooldown, notAfter: filter.notAfter,
    reasons: filter.reasons ? [...filter.reasons] : undefined,
    pages: filter.pages ? { sourceId: filter.pages.sourceId, slugs: [...filter.pages.slugs] } : undefined,
    after: filter.after, served: filter.served,
  }));

export const readProjectionJobReason: Member<'readProjectionJobReason'> = (brain, key) =>
  storeCall({ member: 'readProjectionJobReason', slug: key.slug }, () => brain.readProjectionJobReason(key));

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

export const probeProjectionWindowCandidates: Member<'probeProjectionWindowCandidates'> = (brain, candidates) =>
  storeCall({ member: 'probeProjectionWindowCandidates' }, () => brain.probeProjectionWindowCandidates(
    candidates.map(row => ({ source_incarnation: row.source_incarnation, slug: row.slug }))));

export const readProjectionHead: Member<'readProjectionHead'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readProjectionHead', slug, sourceId }, () => brain.readProjectionHead(sourceId, slug));

export const isDeferredReplacementHeld: Member<'isDeferredReplacementHeld'> = (brain, sourceId, slug, revision, claim) =>
  storeCall({ member: 'isDeferredReplacementHeld', slug, sourceId }, () => brain.isDeferredReplacementHeld(sourceId, slug, revision, claim));

export const renewDeferredReplacementClaim: Member<'renewDeferredReplacementClaim'> = async (brain, job, claim, opts) => {
  await storeCall({ member: 'renewDeferredReplacementClaim', slug: job.slug }, () => opts?.fence
    ? brain.renewDeferredReplacementClaim(jobKey(job), claim, opts.fence) : brain.renewDeferredReplacementClaim(jobKey(job), claim));
};

export const releaseDeferredReplacementClaim: Member<'releaseDeferredReplacementClaim'> = async (brain, slug, claim, opts) => {
  await storeCall({ member: 'releaseDeferredReplacementClaim', slug }, () => opts?.fence
    ? brain.releaseDeferredReplacementClaim(slug, claim, opts.fence) : brain.releaseDeferredReplacementClaim(slug, claim));
};

export const listProjectionDrainPreview: Member<'listProjectionDrainPreview'> = async (brain, limit) => {
  const member = 'listProjectionDrainPreview';
  if (!Number.isSafeInteger(limit)) refuseMember(member, 'a limit that is not an integer');
  return storeCall({ member }, () => brain.listProjectionDrainPreview(limit));
};

export const hasQueuedProjectionWork: Member<'hasQueuedProjectionWork'> = (brain, opts) =>
  storeCall({ member: 'hasQueuedProjectionWork' }, () => brain.hasQueuedProjectionWork(opts?.media === true));

/** The store keeps no planner statistics; the live page count stands in for the pages table's row estimate. */
export const readPagesRowEstimate: Member<'readPagesRowEstimate'> = async (brain) =>
  Number(await storeCall({ member: 'readPagesRowEstimate' }, () => brain.countBrainLivePages()) ?? 0);

export const readDrainRunStart: Member<'readDrainRunStart'> = (brain) =>
  storeCall({ member: 'readDrainRunStart' }, () => brain.readDrainRunStart());

export const isDrainClockPast: Member<'isDrainClockPast'> = (brain, runStart) =>
  storeCall({ member: 'isDrainClockPast' }, () => brain.isDrainClockPast(runStart));

export const queuePageProjectionJob: Member<'queuePageProjectionJob'> = async (brain, sourceId, slug, reason) => {
  await storeCall({ member: 'queuePageProjectionJob', slug, sourceId }, () => brain.queuePageProjectionJob(sourceId, slug, reason));
};

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

/*
 * The image seal (page-state/image-seal.ts sealImageProjections), served from persistence/image_seal.rs. The store keeps
 * no image vector, so a sealed page never has a visual one.
 */
export const listImageSealWindow: Member<'listImageSealWindow'> = (brain, after, limit, notAfter) => {
  const member = 'listImageSealWindow';
  if (!Number.isSafeInteger(limit)) refuseMember(member, 'a limit that is not an integer');
  return storeCall({ member }, () => brain.listImageSealWindow(after.sourceIncarnation, after.slug, limit, notAfter ?? null));
};

export const readImageSealPages: Member<'readImageSealPages'> = (brain, rows) =>
  storeCall({ member: 'readImageSealPages' }, () => brain.readImageSealPages(rows.map(({ source_id, slug, revision }) => ({ source_id, slug, revision }))));

export const listImageSealChunks: Member<'listImageSealChunks'> = (brain, pageIds, column, provenanceModel) => {
  keepColumn('listImageSealChunks', column);
  return storeCall({ member: 'listImageSealChunks' }, () => brain.listImageSealChunks([...pageIds], provenanceModel));
};

export const clearImageSealVectors: Member<'clearImageSealVectors'> = async (brain, column, chunks) => {
  keepColumn('clearImageSealVectors', column);
  await storeCall({ member: 'clearImageSealVectors' }, () => brain.clearImageSealVectors(chunks.map(({ id, page_id }) => ({ id, page_id }))));
};

export const sealImagePages: Member<'sealImagePages'> = (brain, pages) =>
  storeCall({ member: 'sealImagePages' }, () => brain.sealImagePages(pages.map(({ id, revision }) => ({ id, revision }))));
