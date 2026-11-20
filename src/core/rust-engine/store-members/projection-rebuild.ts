/**
 * A projection rebuild's queue, keep-plan and seal members (src/core/engine-sql/projection-rebuild.ts), served from
 * rust/crates/gbrain-store/src/persistence/projection_rebuild.rs. Each member sends the arguments of its BrainEngine
 * member.
 *
 * The store keeps one vector column, `embedding`, so the keep-plan members refuse any other column. The drained probe
 * refuses `media`: the store does not decide which image pages are sealable. `setProjectionChunkerVersion` is the
 * store's `setChunkerVersion`, which stamps the same column.
 */
import type { BrainEngine } from '../../engine.ts';
import type { KeepColumn } from '../../engine-sql/projection-rebuild.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

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
