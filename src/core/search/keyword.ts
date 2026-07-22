import type { BrainEngine } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';

export async function keywordSearch(
  engine: BrainEngine,
  query: string,
  opts?: SearchOpts,
): Promise<SearchResult[]> {
  return engine.searchKeyword(query, opts);
}
