/**
 * The reads of the legacy_slug_spellings doctor check and of the gbrain repair slug-spelling preview
 * (src/core/engine-sql/slug-spelling-repair.ts) on the Rust engine (rust/crates/gbrain-store/src/slug_spelling_repair.rs,
 * rust/docs/store/slug-spelling-repair.md).
 *
 * Answered without a store call: the store keeps no row-level security, so no table hides rows from a role
 * (`readRowSecurityTables`, `readRowSecurityBrainTables`), and it holds text as UTF-8 (`readServerEncoding`). The page and
 * source reads are the store's.
 */
import type { BrainEngine } from '../../engine.ts';
import type { SlugRepairSourceRow, SlugSpellingCandidateRow, SourceSlugSpellingCandidateRow, SpellingKeyPageRow } from '../../engine-sql/slug-spelling-repair.ts';
import { SLUG_SPELLING_CANDIDATE_BATCH } from '../../engine-sql/slug-spelling-repair.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readRowSecurityTables: Member<'readRowSecurityTables'> = async () => [];
export const listSlugSpellingCandidates: Member<'listSlugSpellingCandidates'> = async (brain, afterId) =>
  await storeCall({ member: 'listSlugSpellingCandidates' }, () => brain.listSlugSpellingCandidates(afterId, SLUG_SPELLING_CANDIDATE_BATCH)) as SlugSpellingCandidateRow[];
export const readServerEncoding: Member<'readServerEncoding'> = async () => 'UTF8';
export const readRowSecurityBrainTables: Member<'readRowSecurityBrainTables'> = async () => [];
export const readSlugRepairSource: Member<'readSlugRepairSource'> = async (brain, sourceId) =>
  await storeCall({ member: 'readSlugRepairSource', sourceId }, () => brain.readSlugRepairSource(sourceId)) as SlugRepairSourceRow | null;
export const listSourceSlugSpellingCandidates: Member<'listSourceSlugSpellingCandidates'> = async (brain, sourceId, afterId) =>
  await storeCall({ member: 'listSourceSlugSpellingCandidates', sourceId }, () => brain.listSourceSlugSpellingCandidates(sourceId, afterId, SLUG_SPELLING_CANDIDATE_BATCH)) as SourceSlugSpellingCandidateRow[];
export const readSpellingKeyPages: Member<'readSpellingKeyPages'> = async (brain, sourceId, keys, scanKey, excludeId) =>
  await storeCall({ member: 'readSpellingKeyPages', sourceId }, () => brain.readSpellingKeyPages(sourceId, keys ? [...keys] : null, scanKey, excludeId)) as SpellingKeyPageRow[];
export const readPageSlugInSource: Member<'readPageSlugInSource'> = async (brain, pageId, sourceId) =>
  await storeCall({ member: 'readPageSlugInSource', sourceId }, () => brain.readPageSlugInSource(pageId, sourceId)) as string | null;
export const readSlugRepairPage: Member<'readSlugRepairPage'> = async (brain, pageId, sourceId) =>
  await storeCall({ member: 'readSlugRepairPage', sourceId }, () => brain.readSlugRepairPage(pageId, sourceId)) as SourceSlugSpellingCandidateRow | null;
