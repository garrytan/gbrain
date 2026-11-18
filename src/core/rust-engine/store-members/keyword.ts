/**
 * Keyword search members the keyword_search capability still refuses, and title trigrams. findByTitleFuzzy is served;
 * countKeywordPages, searchKeywordPages, searchTitles and searchKeywordChunks still refuse with
 * `engine_capability_missing` until this file exports them (docs/designs/RUST_ENGINE_INTERFACES.md).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import { storeCall, type StoreMember } from './common.ts';

type FuzzyHit = { slug: string; similarity: number } | null;

export const findByTitleFuzzy: StoreMember<[name: string, dirPrefix?: string, minSimilarity?: number, sourceId?: string], FuzzyHit> =
  async (brain, name, dirPrefix, minSimilarity, sourceId) => {
    // `similarity(title, NULL)` and `>= NULL` are never true, so a null name or threshold finds nothing on the SQL
    // engines.
    if (minSimilarity === null || name === null || name === undefined) return null;
    // The SQL engines scope by `dirPrefix` and `sourceId` only when they are truthy.
    const dir = dirPrefix ? String(dirPrefix) : undefined;
    const source = sourceId ? String(sourceId) : undefined;
    return storeCall({ member: 'findByTitleFuzzy' }, () => brain.findByTitleFuzzy(String(name), dir, minSimilarity, source));
  };
