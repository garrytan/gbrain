/**
 * The page reads of hybrid search's ranking stage (BrainEngine slugsEndingIn, generatedPagesIn, livePageIdsAt), served
 * by gbrain-store `cli_reads::search_reads_pages`. Order, soft-delete and source rules of each member:
 * rust/docs/store/cli-reads-search-pages.md.
 */
import type { GeneratedPageRow } from '../../engine-sql/search-reads.ts';
import { storeCall, type StoreMember } from './common.ts';

export const slugsEndingIn: StoreMember<[sourceId: string, word: string], string[]> = (brain, sourceId, word) =>
  storeCall({ member: 'slugsEndingIn', sourceId }, () => brain.slugsEndingIn(sourceId, word));

export const generatedPagesIn: StoreMember<[ids: number[]], GeneratedPageRow[]> = async (brain, ids) =>
  ids.length === 0 ? [] : storeCall({ member: 'generatedPagesIn' }, () => brain.generatedPagesIn([...ids]));

export const livePageIdsAt: StoreMember<[refs: Array<{ slug: string; source_id: string }>], number[]> = async (brain, refs) =>
  refs.length === 0 ? [] : storeCall({ member: 'livePageIdsAt' }, () => brain.livePageIdsAt(refs.map(r => ({ slug: r.slug, source_id: r.source_id }))));
