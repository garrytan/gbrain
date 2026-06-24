import type { BrainEngine } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';

// Postgres' default text-search parser classifies `foo/bar` as a single
// `file`-alias token. Under the english config that alias maps to the
// `simple` dictionary, so `websearch_to_tsquery('english', 'foo/bar')`
// produces the single lexeme `'foo/bar'`. That lexeme never matches indexed
// chunk text whose `to_tsvector('english', …)` split on the slash, so any
// query containing `/` silently returns zero hits — e.g. pasting a meeting
// title like `Author1/Author2 - Topic`. Replacing `/` with whitespace breaks
// the file-alias token into ordinary `asciiword`s, which then stem and match
// through the english dictionary the same way the manually-despaced query
// does. Quoted phrases (`"foo/bar"`) still become phrase queries
// (`foo <-> bar`), which is at least as permissive as the no-hits baseline.
// The semantic / vector path is unaffected.
export function normalizeKeywordQuery(query: string): string {
  return query.replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
}

export async function keywordSearch(
  engine: BrainEngine,
  query: string,
  opts?: SearchOpts,
): Promise<SearchResult[]> {
  return engine.searchKeyword(query, opts);
}
