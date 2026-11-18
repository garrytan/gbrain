/**
 * Duplicate finder read (`BrainEngine.listEntityKeyRows`, core/entities/duplicates.ts): live, unretired pages of the
 * given types in sources that are not archived, with only the named frontmatter keys, keyset-paged by
 * (source_id, slug). One implementation for both engines; read-only.
 */
import { sqlFragment, trustedSql } from './fragment.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { retiredPageSql } from '../entities/resolve.ts';

export interface EntityKeyRow {
  source_id: string;
  slug: string;
  title: string | null;
  type: string;
  /** The requested frontmatter keys the page carries, as stored. */
  keys: Record<string, unknown>;
}

export interface EntityKeyRowsOpts {
  types: string[];
  keys: string[];
  /** Keyset cursor: rows strictly after this (source_id, slug). */
  after?: { source_id: string; slug: string };
  limit: number;
}

export async function listEntityKeyRows(exec: LegacyUnscopedRead, opts: EntityKeyRowsOpts): Promise<EntityKeyRow[]> {
  const { rows } = await exec.run<{ source_id: string; slug: string; title: string | null; type: string; keys: unknown }>(sqlFragment`
    SELECT p.source_id, p.slug, p.title, p.type,
           COALESCE((SELECT jsonb_object_agg(k.key, p.frontmatter -> k.key)
                       FROM unnest(${opts.keys}::text[]) AS k(key)
                      WHERE p.frontmatter -> k.key IS NOT NULL), '{}'::jsonb) AS keys
      FROM pages p
      JOIN sources s ON s.id = p.source_id
     WHERE p.deleted_at IS NULL
       AND s.archived IS NOT TRUE
       AND p.type = ANY(${opts.types}::text[])
       AND NOT ${trustedSql(retiredPageSql('p'))}
       AND (p.source_id, p.slug) > (${opts.after?.source_id ?? ''}::text, ${opts.after?.slug ?? ''}::text)
     ORDER BY p.source_id, p.slug
     LIMIT ${opts.limit}::int`);
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug, title: r.title, type: r.type,
    keys: (typeof r.keys === 'string' ? JSON.parse(r.keys) : r.keys ?? {}) as Record<string, unknown> }));
}
