/**
 * The stored-spelling scan of a scalar slug read (ops/slug-params.ts `chooseSpelling`): the slugs stored under any spelling
 * whose key matches the key of the slug the caller asked for. It reads pages of every state (deleted pages included) and
 * applies no privacy rule; the caller checks each slug it gets with its own scope and privacy gate. Unscoped on master
 * (it ran through `executeRaw` on the pool).
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/**
 * The SQL side of `normalizeSlug`, cut down to ASCII letters and digits, so every row that normalizes to a slug shares its key with
 * it (the caller then compares with `normalizeSlug` itself). The capitals are lowered by hand, never by the engine's locale:
 * ASCII, and the two whose lowercase holds ASCII (U+0130 lowers to `i` and a combining dot, U+212A to `k`); then the text is composed.
 */
export const SPELLING_KEY_SQL = `regexp_replace(normalize(translate(replace(replace(slug, chr(304), 'i' || chr(775)), chr(8490), 'k'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), NFC), '[^a-z0-9]', '', 'g')`;

/** The most slugs one call answers; the caller asks again after the last one while a call answers this many. */
export const STORED_SPELLINGS_PAGE = 200;

/** The source scope of the scan: `sourceIds` when given (an empty list matches nothing), else `sourceId`, else every source. */
export interface StoredSpellingScope { sourceId?: string; sourceIds?: readonly string[] }

/**
 * The distinct stored slugs in `scope` whose spelling key is `key` and that sort after `after` by bytes (`COLLATE "C"`), in
 * that order, at most STORED_SPELLINGS_PAGE of them. `key` is the caller's normal-form slug with everything but `a-z0-9` removed.
 */
export async function readStoredSlugSpellings(exec: LegacyUnscopedRead, key: string, scope: StoredSpellingScope, after: string): Promise<string[]> {
  const scoped = scope.sourceIds ? sqlFragment`AND source_id = ANY(${[...scope.sourceIds]}::text[])`
    : scope.sourceId !== undefined ? sqlFragment`AND source_id = ${scope.sourceId}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT slug COLLATE "C" AS s FROM pages WHERE ${trustedSql(SPELLING_KEY_SQL)} = ${key} ${scoped} AND slug COLLATE "C" > ${after} ORDER BY s LIMIT 200`);
  const rows = await exec.executeRaw<{ s: string }>(text, params);
  return rows.map(({ s }) => s);
}
