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
 * The store keeps one vector column, `embedding`, so the keep-plan and vector members refuse any other column. The drained probe
 * refuses `media`, as the work probe does: the store does not decide which image pages are sealable, so the backlog and
 * preview refuse a queue that holds an image page that is neither protected nor archived. The row estimate is 0: the
 * store keeps no planner statistics. `setProjectionChunkerVersion` is the
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
  if (opts?.media) refuseMember('hasDrainableProjectionJob', 'option media; the store does not decide which image pages are sealable');
  return storeCall({ member: 'hasDrainableProjectionJob' }, () => brain.hasDrainableProjectionJob());
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

export const renewDeferredReplacementClaim: Member<'renewDeferredReplacementClaim'> = async (brain, job, claim) => {
  await storeCall({ member: 'renewDeferredReplacementClaim', slug: job.slug }, () => brain.renewDeferredReplacementClaim(jobKey(job), claim));
};

export const releaseDeferredReplacementClaim: Member<'releaseDeferredReplacementClaim'> = async (brain, slug, claim) => {
  await storeCall({ member: 'releaseDeferredReplacementClaim', slug }, () => brain.releaseDeferredReplacementClaim(slug, claim));
};

/**
 * `readProjectionBacklog`: the store reads a source or sources (`pageReadFilter`'s source clause); a privacy, trust or
 * flag filter refuses. An image page that is neither protected nor archived is sealable or reimport, which the store
 * cannot tell apart, so a backlog that holds one refuses.
 */
export const readProjectionBacklog: Member<'readProjectionBacklog'> = async (brain, scope) => {
  const member = 'readProjectionBacklog';
  const opts = takeOptions(member, scope, ['sourceId', 'sourceIds'], ['requireSafeChunks', 'takesHoldersAllowList']);
  const sourceIds = Array.isArray(opts.sourceIds) && opts.sourceIds.length ? [...opts.sourceIds as string[]] : undefined;
  const sourceId = sourceIds === undefined && typeof opts.sourceId === 'string' && opts.sourceId ? opts.sourceId : undefined;
  const row: Record<string, unknown> & { undecided: number } = await storeCall({ member }, () => brain.readProjectionBacklog({ sourceId, sourceIds }));
  if (row.undecided > 0) refuseMember(member, 'an image page that is sealable or needs a re-import; the store does not tell them apart');
  const { undecided: _undecided, ...backlog } = row;
  return backlog as Awaited<ReturnType<BrainEngine['readProjectionBacklog']>>;
};

/** `listProjectionDrainPreview`: a queue that holds an image page the store cannot class refuses, as the backlog does. */
export const listProjectionDrainPreview: Member<'listProjectionDrainPreview'> = async (brain, limit) => {
  const member = 'listProjectionDrainPreview';
  if (!Number.isSafeInteger(limit)) refuseMember(member, 'a limit that is not an integer');
  const out: { rows: Awaited<ReturnType<BrainEngine['listProjectionDrainPreview']>>; undecided: number } =
    await storeCall({ member }, () => brain.listProjectionDrainPreview(limit));
  if (out.undecided > 0) refuseMember(member, 'an image page that may be sealable; the store does not decide which image pages are sealable');
  return out.rows;
};

export const hasQueuedProjectionWork: Member<'hasQueuedProjectionWork'> = (brain, opts) => {
  if (opts?.media) refuseMember('hasQueuedProjectionWork', 'option media; the store does not decide which image pages are sealable');
  return storeCall({ member: 'hasQueuedProjectionWork' }, () => brain.hasQueuedProjectionWork());
};

/** The store keeps no planner statistics, so the drain's statistics debt starts from no rows. */
export const readPagesRowEstimate: Member<'readPagesRowEstimate'> = async () => 0;

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
