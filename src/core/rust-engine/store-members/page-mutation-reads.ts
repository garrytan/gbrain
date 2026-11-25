/**
 * The reads a page write makes before admission, the members of engine-sql/page-mutation-reads.ts, served by the
 * store's page and version records (rust/docs/store/page-mutation-reads.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readStoredPageHead: Member<'readStoredPageHead'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readStoredPageHead', sourceId, slug }, () => brain.readStoredPageHead(sourceId, slug));

export const readVersionSourcePath: Member<'readVersionSourcePath'> = (brain, versionId, pageId) =>
  storeCall({ member: 'readVersionSourcePath' }, () => brain.readVersionSourcePath(versionId, pageId));
