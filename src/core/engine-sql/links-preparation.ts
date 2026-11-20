/**
 * The three reads link preparation made through `engine.executeRaw` (persistence/links-preparation.ts): the alias
 * targets a page's links may follow, and the slug fingerprint that keeps the per-source basename index current.
 * SQL once for both engines, so a store that is not SQL serves the same members (rust/docs/store/links-preparation.md).
 * Each statement is the one the call site ran, with the same parameters.
 *
 * The fingerprint counts every row of `pages` (a soft-deleted page too), as `getAllSlugs` lists it.
 */
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** An alias slug with the canonical page it points at. */
export interface LiveSlugAliasRow { alias_slug: string; canonical_slug: string }

/** What `probeSourceSlugFingerprint` returns: the source's fingerprint, and the slugs added after `afterId` with their hash sum. */
export interface SlugFingerprintProbe { n: number; h: string; m: number; added: string[]; added_h: string }

/** What `readSourceSlugFingerprint` returns: the source's fingerprint and every slug in it. */
export interface SlugFingerprintRead { n: number; h: string; m: number; slugs: string[] }

/**
 * Of `targets`, the alias slugs of the source that hold no live page while their canonical page is live. A brain
 * without the `slug_aliases` table has none.
 */
export async function readLiveSlugAliases(tx: Raw, sourceId: string, targets: readonly string[]): Promise<LiveSlugAliasRow[]> {
  if (!targets.length) return [];
  try {
    return await tx.executeRaw<LiveSlugAliasRow>(`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
      WHERE a.source_id=$1 AND a.alias_slug IN (SELECT unnest($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`, [sourceId, [...new Set(targets)]]);
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', 'slug_aliases')) return [];
    throw error;
  }
}

/**
 * The source's fingerprint (row count, `hashtextextended(slug, 0)` sum as text and highest id: a change to any slug of the
 * source moves one of them), with the slugs of the pages whose id is above `afterId` and their hash sum.
 */
export async function probeSourceSlugFingerprint(tx: Raw, sourceId: string, afterId: number): Promise<SlugFingerprintProbe> {
  const [probe] = await tx.executeRaw<SlugFingerprintProbe>(`SELECT count(*)::int AS n, coalesce(sum(hashtextextended(slug, 0)), 0)::text AS h, coalesce(max(id), 0)::int AS m,
      coalesce(array_agg(slug) FILTER (WHERE id > $2), '{}') AS added, coalesce(sum(hashtextextended(slug, 0)) FILTER (WHERE id > $2), 0)::text AS added_h
      FROM pages WHERE source_id=$1`, [sourceId, afterId]);
  return probe!;
}

/** The source's fingerprint with every slug in it. */
export async function readSourceSlugFingerprint(tx: Raw, sourceId: string): Promise<SlugFingerprintRead> {
  const [all] = await tx.executeRaw<SlugFingerprintRead>(
    `SELECT count(*)::int AS n, coalesce(sum(hashtextextended(slug, 0)), 0)::text AS h, coalesce(max(id), 0)::int AS m, coalesce(array_agg(slug), '{}') AS slugs FROM pages WHERE source_id=$1`, [sourceId]);
  return all!;
}
