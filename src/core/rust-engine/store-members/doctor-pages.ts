/**
 * Doctor page reads (src/core/engine-sql/doctor-pages.ts), served from the page, body, raw-data, link and source records
 * each check reads (rust/crates/gbrain-store/src/cli_reads/doctor_pages.rs, rust/docs/store/cli-reads-doctor-pages.md).
 *
 * One member answers without a store call: `countImageModalityMismatches` counts image-asset chunks that hold an image
 * vector, and the store keeps no `embedding_image` vector at all (no writer), so there are none to count (0).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listOversizedPages: Member<'listOversizedPages'> = async (brain, minBytes) =>
  storeCall({ member: 'listOversizedPages' }, () => brain.listOversizedPages(minBytes));

export const listScraperJunkCandidates: Member<'listScraperJunkCandidates'> = async (brain, limit) =>
  storeCall({ member: 'listScraperJunkCandidates' }, () => brain.listScraperJunkCandidates(limit));

export const countMarkedPages: Member<'countMarkedPages'> = async (brain, marker) =>
  Number(await storeCall({ member: 'countMarkedPages' }, () => brain.countMarkedPages(marker)));

export const countOversizedCorePages: Member<'countOversizedCorePages'> = async (brain, maxBytes) =>
  Number(await storeCall({ member: 'countOversizedCorePages' }, () => brain.countOversizedCorePages(maxBytes)));

export const readRawProvenanceGaps: Member<'readRawProvenanceGaps'> = async (brain) =>
  storeCall({ member: 'readRawProvenanceGaps' }, () => brain.readRawProvenanceGaps());

export const countUnverifiedExtractions: Member<'countUnverifiedExtractions'> = async (brain, days, sourceId) =>
  Number(await storeCall({ member: 'countUnverifiedExtractions' }, () => brain.countUnverifiedExtractions(days, sourceId)));

export const listContentHashDuplicates: Member<'listContentHashDuplicates'> = async (brain) =>
  storeCall({ member: 'listContentHashDuplicates' }, () => brain.listContentHashDuplicates());

export const countTranscriptImportPages: Member<'countTranscriptImportPages'> = async (brain) =>
  Number(await storeCall({ member: 'countTranscriptImportPages' }, () => brain.countTranscriptImportPages()));

export const countPageRows: Member<'countPageRows'> = async (brain) =>
  Number(await storeCall({ member: 'countPageRows' }, () => brain.countPageRows()));

export const countPagesBySlugPrefix: Member<'countPagesBySlugPrefix'> = async (brain, prefix) =>
  Number(await storeCall({ member: 'countPagesBySlugPrefix' }, () => brain.countPagesBySlugPrefix(prefix)));

export const countLivePages: Member<'countLivePages'> = async (brain) =>
  Number(await storeCall({ member: 'countLivePages' }, () => brain.countLivePages()));

export const readOldestPageCreatedAt: Member<'readOldestPageCreatedAt'> = async (brain) =>
  storeCall({ member: 'readOldestPageCreatedAt' }, () => brain.readOldestPageCreatedAt());

export const countPageTrustTiers: Member<'countPageTrustTiers'> = async (brain) =>
  storeCall({ member: 'countPageTrustTiers' }, () => brain.countPageTrustTiers());

export const countPagesWithMentionLinks: Member<'countPagesWithMentionLinks'> = async (brain) =>
  Number(await storeCall({ member: 'countPagesWithMentionLinks' }, () => brain.countPagesWithMentionLinks()));

/** No store call: the store keeps no `embedding_image` vector, so no chunk has one to be mistagged. */
export const countImageModalityMismatches: Member<'countImageModalityMismatches'> = async () => 0;

export const readImagePageCoverage: Member<'readImagePageCoverage'> = async (brain) =>
  storeCall({ member: 'readImagePageCoverage' }, () => brain.readImagePageCoverage());

export const listFactsPageBodies: Member<'listFactsPageBodies'> = async (brain) =>
  storeCall({ member: 'listFactsPageBodies' }, () => brain.listFactsPageBodies());

export const listBracketPathPages: Member<'listBracketPathPages'> = async (brain) =>
  storeCall({ member: 'listBracketPathPages' }, () => brain.listBracketPathPages());

export const listSlugPathCandidates: Member<'listSlugPathCandidates'> = async (brain, sourceIds) =>
  storeCall({ member: 'listSlugPathCandidates' }, () => brain.listSlugPathCandidates(sourceIds));
