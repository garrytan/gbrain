/**
 * Doctor search and knowledge reads (src/core/engine-sql/doctor-search.ts), served from the page, alias, body, link,
 * source and projection-queue records each check reads (rust/crates/gbrain-store/src/cli_reads/doctor_search.rs,
 * rust/docs/store/cli-reads-doctor-search.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listOrphanedAliasCounts: Member<'listOrphanedAliasCounts'> = async (brain) =>
  storeCall({ member: 'listOrphanedAliasCounts' }, () => brain.listOrphanedAliasCounts());

export const readSoftDeletedAliasCounts: Member<'readSoftDeletedAliasCounts'> = async (brain) =>
  storeCall({ member: 'readSoftDeletedAliasCounts' }, () => brain.readSoftDeletedAliasCounts());

export const listPageTypePairs: Member<'listPageTypePairs'> = async (brain) =>
  storeCall({ member: 'listPageTypePairs' }, () => brain.listPageTypePairs());
