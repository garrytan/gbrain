/**
 * The stored-spelling scan of a scalar slug read (ops/slug-params.ts `chooseSpelling`): the slugs stored under any spelling
 * whose key matches the key of the slug the caller asked for. It reads pages of every state (deleted pages included) and
 * applies no privacy rule; the caller checks each slug it gets with its own scope and privacy gate. Unscoped on master
 * (it ran through `executeRaw` on the pool).
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { SCAN_KEY_SQL, SPELLING_KEY_SQL } from '../slug-spelling-key.ts';

/** The most slugs one call answers; the caller asks again after the last one while a call answers this many. */
export const STORED_SPELLINGS_PAGE = 200;

/** The source scope of the scan: `sourceIds` when given (an empty list matches nothing), else `sourceId`, else every source. */
export interface StoredSpellingScope { sourceId?: string; sourceIds?: readonly string[] }

/**
 * The distinct stored slugs in `scope` whose spelling key is `key` and that sort after `after` by bytes (`COLLATE "C"`), in
 * that order, at most STORED_SPELLINGS_PAGE of them. `key` is the caller's normal-form slug with everything but `a-z0-9` removed.
 * `keys`, when given, are the index keys of the slug and its capital forms (`spellingKeys`, master #10168): the rows are probed by
 * `idx_pages_spelling_key`. When it is null or absent the unindexed ASCII-key scan (`SCAN_KEY_SQL = key`) answers instead; the
 * caller keeps only the rows that `normalizeSlug` maps to its slug, so both reads give it the same set.
 */
export function storedSpellingsStatement(key: string, scope: StoredSpellingScope, after: string, keys?: readonly string[] | null): { text: string; params: unknown[] } {
  const scoped = scope.sourceIds ? sqlFragment`AND source_id = ANY(${[...scope.sourceIds]}::text[])`
    : scope.sourceId !== undefined ? sqlFragment`AND source_id = ${scope.sourceId}` : sqlFragment``;
  const match = keys ? sqlFragment`${trustedSql(SPELLING_KEY_SQL)} = ANY(${[...keys]}::text[])` : sqlFragment`${trustedSql(SCAN_KEY_SQL)} = ${key}`;
  return renderFragment(sqlFragment`SELECT DISTINCT slug COLLATE "C" AS s FROM pages WHERE ${match} ${scoped} AND slug COLLATE "C" > ${after} ORDER BY s LIMIT 200`);
}

export async function readStoredSlugSpellings(exec: LegacyUnscopedRead, key: string, scope: StoredSpellingScope, after: string, keys?: readonly string[] | null): Promise<string[]> {
  const { text, params } = storedSpellingsStatement(key, scope, after, keys);
  const rows = await exec.executeRaw<{ s: string }>(text, params);
  return rows.map(({ s }) => s);
}
