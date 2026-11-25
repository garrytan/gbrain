/**
 * Alias fan-out reads: the exact-title lookup and case-sensitive alias read of `resolveQueryEntities`, and the page
 * title and alias rows `namesOf` reads (search/alias-fanout.ts), which ran through `engine.executeRaw`, once for both
 * engines.
 *
 * Every statement here ran on master from alias-fanout.ts. They keep master's predicates and run on master's raw path
 * (`exec.executeRaw`) unscoped, as before; each value is a bound parameter (`sqlFragment`). Three reads gain an
 * `ORDER BY` where master left the order to the plan, each in byte order (`COLLATE "C"`) so every engine sorts alike:
 * `findPagesByTitles` (source, then slug), `resolveCaseSensitiveAliases` (slug, alias, alias text: the rows carry no source) and `readPageAliasRows`
 * (source, slug, alias, origin). The caller takes the first title hit as the group's lead and keeps the first alias row
 * of equal rank, so a fixed order fixes an answer master left to the plan; no other caller reads these rows. The
 * caller keeps master's fail-open `.catch(() => [])`: any failure, a refused capability included, reads as no rows,
 * as a refused raw read did before.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { rows } from './search-reads.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';

/** A live page whose lower-cased title is one of the asked titles: `t` is `lower(title)`. */
export interface TitleHitRow { slug: string; source_id: string; t: string }

/** A case-sensitive `page_aliases` row: the alias matches only as written (`alias_text`). */
export interface CaseSensitiveAliasRow { slug: string; alias_norm: string; alias_text: string | null }

/** One `page_aliases` row of a fan-out page. */
export interface PageAliasRow { slug: string; source_id: string; alias_norm: string; alias_text: string | null; origin: string | null }

/**
 * Live pages of `sourceIds` with a type in `types` whose `lower(title)` is in `titleNorms`, by source then slug;
 * `excludePrivate` adds the caller's page policy (`privatePagesFilterForCaller`). Quarantined pages and archived
 * sources are not filtered, as on master.
 */
export async function findPagesByTitles(
  exec: LegacyUnscopedRead,
  titleNorms: readonly string[],
  sourceIds: readonly string[],
  types: readonly string[],
  opts?: { excludePrivate?: boolean },
): Promise<TitleHitRow[]> {
  if (!titleNorms.length || !sourceIds.length || !types.length) return [];
  const privacy = opts?.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('pages'))}` : sqlFragment``;
  return rows<TitleHitRow>(exec, sqlFragment`SELECT slug, source_id, lower(title) AS t FROM pages
    WHERE lower(title) = ANY(${[...titleNorms]}::text[]) AND source_id = ANY(${[...sourceIds]}::text[])
      AND type = ANY(${[...types]}::text[]) AND deleted_at IS NULL${privacy}
    ORDER BY source_id COLLATE "C", slug COLLATE "C"`);
}

/** The case-sensitive alias rows of `aliasNorms` in `sourceIds`, by source, slug, then alias. */
export async function resolveCaseSensitiveAliases(exec: LegacyUnscopedRead, aliasNorms: readonly string[], sourceIds: readonly string[]): Promise<CaseSensitiveAliasRow[]> {
  if (!aliasNorms.length || !sourceIds.length) return [];
  return rows<CaseSensitiveAliasRow>(exec, sqlFragment`SELECT slug, alias_norm, alias_text FROM page_aliases
    WHERE alias_norm = ANY(${[...aliasNorms]}::text[]) AND case_sensitive AND source_id = ANY(${[...sourceIds]}::text[])
    ORDER BY slug COLLATE "C", alias_norm COLLATE "C", alias_text COLLATE "C"`);
}

/** The title of the page at `(sourceId, slug)`, soft-deleted pages included (master's read); null with no page. */
export async function readPageTitle(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<string | null> {
  const [row] = await rows<{ title: string | null }>(exec, sqlFragment`SELECT title FROM pages WHERE source_id = ${sourceId} AND slug = ${slug}`);
  return row?.title ?? null;
}

/** Every `page_aliases` row whose source is in `sourceIds` and slug in `slugs`, by source, slug, alias, then origin. */
export async function readPageAliasRows(exec: LegacyUnscopedRead, sourceIds: readonly string[], slugs: readonly string[]): Promise<PageAliasRow[]> {
  if (!sourceIds.length || !slugs.length) return [];
  return rows<PageAliasRow>(exec, sqlFragment`SELECT slug, source_id, alias_norm, alias_text, origin FROM page_aliases
    WHERE source_id = ANY(${[...sourceIds]}::text[]) AND slug = ANY(${[...slugs]}::text[])
    ORDER BY source_id COLLATE "C", slug COLLATE "C", alias_norm COLLATE "C", origin COLLATE "C"`);
}

/** One `page_aliases` row of an entity card page or identity sibling. */
export interface EntityAliasRow { slug: string; alias_norm: string; origin: string | null; alias_text: string | null }

/**
 * The entity card's alias rows (verbs/entity-card.ts `readAka`, entity-card-identity.ts `readSiblingIdentity`): every
 * `page_aliases` row of a listed slug in the source, by alias. The text is the card's statement, byte for byte.
 */
export async function readEntityAliasRows(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[]): Promise<EntityAliasRow[]> {
  return rows<EntityAliasRow>(exec, sqlFragment`SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = ${sourceId} AND slug = ANY(${[...slugs]}::text[]) ORDER BY alias_norm COLLATE "C"`);
}

/** One `slug_aliases` row: an old slug and the slug it resolves to. */
export interface SlugAliasRow { alias_slug: string; canonical_slug: string }

/**
 * Every `slug_aliases` row of the source (extract.ts `loadSlugAliasTargets`, which maps old slugs of renamed pages to
 * their current slug so a link written before a rename still resolves). The text is the caller's statement, byte for
 * byte; it has no order, as the caller builds a map. The caller keeps its missing-table fallback.
 */
export async function listSlugAliases(exec: LegacyUnscopedRead, sourceId: string): Promise<SlugAliasRow[]> {
  return rows<SlugAliasRow>(exec, sqlFragment`SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id = ${sourceId}`);
}
