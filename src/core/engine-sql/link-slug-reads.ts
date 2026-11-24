/**
 * Link preparation's slug reads (persistence/links-preparation.ts): the live alias targets a page's links name, and the
 * fingerprint probe behind the per-source basename index. Both read one source, given by the caller; unscoped on
 * master.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** One live `slug_aliases` row: the alias has no live page of its own and its canonical page is live. */
export interface LiveSlugAliasRow { alias_slug: string; canonical_slug: string }

/**
 * The `slug_aliases` rows of `sourceId` whose alias is one of `targets`, has no live page and points at a live
 * canonical page (no order). Throws the missing-table error on a schema without `slug_aliases`; the caller treats that
 * as no aliases.
 */
export async function readLiveSlugAliases(exec: LegacyUnscopedRead, sourceId: string, targets: readonly string[]): Promise<LiveSlugAliasRow[]> {
  if (!targets.length) return [];
  return exec.executeRaw<LiveSlugAliasRow>(`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
      WHERE a.source_id=$1 AND a.alias_slug IN (SELECT unnest($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`,
  [sourceId, [...new Set(targets)]]);
}

/**
 * The slug fingerprint of a source's pages (deleted pages included, as `getAllSlugs` reads them) and the slugs of the
 * pages whose id is above `afterId`: `count`, `hash` (a sum of per-slug hashes, as decimal text), `maxId`, `added` and
 * `addedHash`. With `afterId` 0, `added` is every slug. The hash is the engine's own (Postgres `hashtextextended`); a
 * caller compares it only with a hash the same engine gave, and relies only on it being a sum, so the hash of new pages
 * adds to the old one.
 */
export interface SourceSlugProbe { count: number; hash: string; maxId: number; added: string[]; addedHash: string }

export async function readSourceSlugProbe(exec: LegacyUnscopedRead, sourceId: string, afterId: number): Promise<SourceSlugProbe> {
  const [row] = await exec.executeRaw<{ n: number; h: string; m: number; added: string[]; added_h: string }>(`SELECT
      count(*)::int AS n, coalesce(sum(hashtextextended(slug, 0)), 0)::text AS h, coalesce(max(id), 0)::int AS m,
      coalesce(array_agg(slug) FILTER (WHERE id > $2), '{}') AS added,
      coalesce(sum(hashtextextended(slug, 0)) FILTER (WHERE id > $2), 0)::text AS added_h
      FROM pages WHERE source_id=$1`, [sourceId, afterId]);
  // An aggregate always answers one row; a driver that answers none reads as an empty source.
  if (!row) return { count: 0, hash: '0', maxId: 0, added: [], addedHash: '0' };
  return { count: Number(row.n), hash: String(row.h), maxId: Number(row.m), added: row.added, addedHash: String(row.added_h) };
}
