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

export const listTruncatedMarkdownBodies: Member<'listTruncatedMarkdownBodies'> = async (brain) =>
  storeCall({ member: 'listTruncatedMarkdownBodies' }, async () =>
    (await brain.listTruncatedMarkdownBodies()).map((row: { slug: string; body_len: unknown; raw_len: unknown }) => ({ ...row, body_len: Number(row.body_len), raw_len: Number(row.raw_len) })));

export const countSegmentedMarkdownBodies: Member<'countSegmentedMarkdownBodies'> = async (brain) =>
  storeCall({ member: 'countSegmentedMarkdownBodies' }, async () => Number(await brain.countSegmentedMarkdownBodies()));

export const listRecentPageBodies: Member<'listRecentPageBodies'> = async (brain, sourceIds) =>
  storeCall({ member: 'listRecentPageBodies' }, () => brain.listRecentPageBodies(sourceIds));

export const countSegmentedRecentPages: Member<'countSegmentedRecentPages'> = async (brain, sourceIds) =>
  storeCall({ member: 'countSegmentedRecentPages' }, async () => Number(await brain.countSegmentedRecentPages(sourceIds)));

export const countPagesHiddenByPrefix: Member<'countPagesHiddenByPrefix'> = async (brain, pattern, sourceIds) =>
  storeCall({ member: 'countPagesHiddenByPrefix' }, async () => Number(await brain.countPagesHiddenByPrefix(pattern, sourceIds)));
