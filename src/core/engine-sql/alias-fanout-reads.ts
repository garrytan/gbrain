/**
 * Alias fan-out reads: the case-sensitive alias read of `resolveQueryEntities`, and the page
 * title and alias rows `namesOf` reads (search/alias-fanout.ts), which ran through `engine.executeRaw`, once for both
 * engines.
 *
 * Every statement here is the statement master ran from alias-fanout.ts and entity-card-identity.ts, byte for byte,
 * on master's raw path (`exec.executeRaw`) unscoped, as before. Where master left the row order to the plan, the member
 * sorts the rows in JavaScript in byte order (source, slug, alias, origin) so every engine answers alike: the caller
 * takes the first title hit as the group's lead and keeps the first alias row of equal rank. The caller keeps master's
 * fail-open `.catch(() => [])`: any failure, a refused capability included, reads as no rows, as a refused raw read did
 * before.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** Bytewise order, the order a Rust store sorts strings in. */
const byteCmp = (a: string | null, b: string | null): number => Buffer.compare(Buffer.from(a ?? ''), Buffer.from(b ?? ''));

/** A case-sensitive `page_aliases` row: the alias matches only as written (`alias_text`). */
export interface CaseSensitiveAliasRow { slug: string; alias_norm: string; alias_text: string | null }

/** One `page_aliases` row of a fan-out page. */
export interface PageAliasRow { slug: string; source_id: string; alias_norm: string; alias_text: string | null; origin: string | null }

/** The case-sensitive alias rows of `norms` in `sources`, by source, slug, then alias. */
export async function resolveCaseSensitiveAliases(exec: LegacyUnscopedRead, norms: readonly string[], sources: readonly string[]): Promise<CaseSensitiveAliasRow[]> {
  if (!norms.length || !sources.length) return [];
  const rows = await exec.executeRaw<CaseSensitiveAliasRow & { source_id?: string }>(
      `SELECT slug, alias_norm, alias_text FROM page_aliases WHERE alias_norm = ANY($1::text[]) AND case_sensitive AND source_id = ANY($2::text[])`,
      [[...norms], [...sources]]);
  return rows.sort((a, b) => byteCmp(a.slug, b.slug) || byteCmp(a.alias_norm, b.alias_norm) || byteCmp(a.alias_text, b.alias_text));
}

/** The title of the page at `(sourceId, slug)`, soft-deleted pages included (master's read); null with no page. */
export async function readPageTitle(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ title: string | null }>('SELECT title FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return row?.title ?? null;
}

/** Every `page_aliases` row whose source is in `sourceIds` and slug in `slugs`, by source, slug, alias, then origin. */
export async function readPageAliasRows(exec: LegacyUnscopedRead, sourceIds: readonly string[], slugs: readonly string[]): Promise<PageAliasRow[]> {
  if (!sourceIds.length || !slugs.length) return [];
  const rows = await exec.executeRaw<PageAliasRow>(
    `SELECT slug, source_id, alias_norm, alias_text, origin FROM page_aliases
      WHERE source_id = ANY($1::text[]) AND slug = ANY($2::text[])`, [[...sourceIds], [...slugs]]);
  return rows.sort((a, b) => byteCmp(a.source_id, b.source_id) || byteCmp(a.slug, b.slug) || byteCmp(a.alias_norm, b.alias_norm) || byteCmp(a.origin, b.origin));
}

/** One `page_aliases` row of an entity card page or identity sibling. */
export interface EntityAliasRow { slug: string; alias_norm: string; origin: string | null; alias_text: string | null }

/**
 * The entity card's alias rows (verbs/entity-card-identity.ts `readSiblingIdentity`): every `page_aliases` row of a
 * listed slug in the source, by alias. The text is the identity read's statement, byte for byte.
 */
export async function readEntityAliasRows(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[]): Promise<EntityAliasRow[]> {
  return exec.executeRaw<EntityAliasRow>(
    `SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm`,
    [sourceId, [...slugs]]);
}
