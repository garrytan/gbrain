
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import type { PageReadScope } from '../types.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { readFilter, rows } from './search-reads.ts';

/** The search filters `hasUnsealedPages` reads beside the page read scope. */
export type UnsealedPageScope = PageReadScope & { types?: string[]; excludeSlugPrefixes?: string[] };

/**
 * Whether a live page in scope is below the safe-chunk fence (search's remote safe-index notice): the same page
 * filters the search applied (`pageReadFilter`, the type list, the hard-excluded slug prefixes). The predicate is the
 * plain range `chunker_version < N`, not the COALESCE form of the read legs, so it matches the partial
 * `pages_safe_chunk_pending_idx`. `sourceIds: []` names no source and matches nothing.
 */
export async function hasUnsealedPages(exec: LegacyUnscopedRead, scope: UnsealedPageScope): Promise<boolean> {
  if (scope.sourceIds?.length === 0 || !Number.isFinite(SAFE_FENCE_CHUNKER_VERSION)) return false;
  const { types, excludeSlugPrefixes = [], ...policy } = scope;
  const typed = types ? sqlFragment` AND p.type = ANY(${types}::text[])` : sqlFragment``;
  const kept = excludeSlugPrefixes.reduce<SqlFragment>((acc, prefix) => sqlFragment`${acc} AND LEFT(p.slug, LENGTH(${prefix}::text)) <> ${prefix}`, sqlFragment``);
  return (await rows<{ one: number }>(exec,
    sqlFragment`SELECT 1 AS one FROM pages p
       WHERE ${readFilter('p', policy, true)}${typed}${kept}
         AND p.chunker_version < ${trustedSql(`${SAFE_FENCE_CHUNKER_VERSION}`)} LIMIT 1`,
  )).length > 0;
}
