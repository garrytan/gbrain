/**
 * Keyword search (BrainEngine searchKeyword). The store ranks with a plain BM25, not Postgres `ts_rank`, so scores and
 * order differ from PGLite's (RUST_ENGINE.md, D5); the filters are the same. The options the store rejects (`where`,
 * `afterDate`, `beforeDate`) refuse here instead.
 */
import type { SearchOpts, SearchResult } from '../../types.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

const SEARCH_FILTERS = ['limit', 'type', 'types', 'exclude_slugs', 'exclude_slug_prefixes', 'include_slug_prefixes', 'detail',
  'language', 'symbolKind', 'sourceId', 'sourceIds'] as const;
// Options that only steer ranking or report how the Postgres keyword arm ran; the store ranks by its own BM25.
const RANKING_ONLY = ['source_boosts', 'onKeywordIncomplete', 'onVectorPoolMeta', 'vectorLegacyGuard', 'hnswIterativeScan'] as const;

export const searchKeyword: StoreMember<[query: string, opts?: SearchOpts], SearchResult[]> = async (brain, query, opts) => {
  if (opts?.offset) refuseMember('searchKeyword', 'offset');
  const { offset: _offset, ...rest } = opts ?? {};
  const options = takeOptions('searchKeyword', rest, SEARCH_FILTERS, RANKING_ONLY);
  const rows: SearchResult[] = await storeCall({ member: 'searchKeyword' }, () => brain.searchKeyword(query, options));
  // PGLite reports a page's effective date as the calendar day ("2026-03-04"), never a Date.
  return rows.map((row) => (typeof row.effective_date === 'string' ? { ...row, effective_date: (row.effective_date as string).slice(0, 10) } : row));
};
