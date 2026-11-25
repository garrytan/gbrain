/**
 * The reads of the legacy_slug_spellings doctor check (src/core/engine-sql/slug-spelling-repair.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/slug_spelling_repair.rs, rust/docs/store/slug-spelling-repair.md).
 *
 * The store keeps no row-level security, so no table hides rows from a role: `readRowSecurityTables` answers no table
 * without a store call. The candidate scan reads the store's pages with the SQL prefilter.
 */
import type { BrainEngine } from '../../engine.ts';
import type { SlugSpellingCandidateRow } from '../../engine-sql/slug-spelling-repair.ts';
import { SLUG_SPELLING_CANDIDATE_BATCH } from '../../engine-sql/slug-spelling-repair.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readRowSecurityTables: Member<'readRowSecurityTables'> = async () => [];
export const listSlugSpellingCandidates: Member<'listSlugSpellingCandidates'> = async (brain, afterId) =>
  await storeCall({ member: 'listSlugSpellingCandidates' }, () => brain.listSlugSpellingCandidates(afterId, SLUG_SPELLING_CANDIDATE_BATCH)) as SlugSpellingCandidateRow[];
