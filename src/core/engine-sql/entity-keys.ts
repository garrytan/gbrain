/**
 * Duplicate finder read (`BrainEngine.listEntityKeyRows`, core/entities/duplicates.ts): live, unretired pages of the
 * given types in sources that are not archived, with only the named frontmatter keys, keyset-paged by
 * (source_id, slug). One implementation for both engines; read-only. `members` narrows the read to those pages, and `tokens` to
 * pages one of whose `fields` values reads as one of the tokens in a form the finder's key normalizers produce (the
 * lowered value, its host, a LinkedIn company or profile name, a GitHub login): a superset the normalizers then narrow,
 * and the company sweep's read of every page that may share a key value with the pages a sync changed.
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
  page_id: number;
  generation: number;
  /** ISO 8601 in UTC with microseconds, so two rows compare as strings. */
  created_at: string;
  /** The identity group the page sits in, and who linked it there; null when it is in none. */
  identity: { entity_id: string; established_by: string } | null;
}

export interface EntityKeyRowsOpts {
  types: string[];
  keys: string[];
  /** Keyset cursor: rows strictly after this (source_id, slug). */
  after?: { source_id: string; slug: string };
  limit: number;
  members?: ReadonlyArray<{ source_id: string; slug: string }>;
  /** Pages one of whose `fields` values reads as one of `values` in a form the finder's key normalizers produce. */
  tokens?: { values: string[]; fields: string[] };
  /** Instead of live unretired pages: the retired pages a dedupe collapse made (a `merged_into` and a `dedupe_collapse` record, core/entities/evidence/collapse.ts). */
  collapsed?: boolean;
}

export async function listEntityKeyRows(exec: LegacyUnscopedRead, opts: EntityKeyRowsOpts): Promise<EntityKeyRow[]> {
  const members = opts.members ?? null;
  const tokens = opts.tokens ?? null;
  const { rows } = await exec.run<{ source_id: string; slug: string; title: string | null; type: string; keys: unknown; page_id: number; generation: number | string;
    created_at: string; entity_id: string | null; established_by: string | null }>(sqlFragment`
    SELECT p.source_id, p.slug, p.title, p.type, p.id AS page_id, p.generation, to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           ei.entity_id, ei.established_by,
           COALESCE((SELECT jsonb_object_agg(k.key, p.frontmatter -> k.key)
                       FROM unnest(${opts.keys}::text[]) AS k(key)
                      WHERE p.frontmatter -> k.key IS NOT NULL), '{}'::jsonb) AS keys
      FROM pages p
      JOIN sources s ON s.id = p.source_id
      LEFT JOIN entity_identities ei ON ei.source_id = p.source_id AND ei.page_id = p.id
     WHERE p.deleted_at IS NULL
       AND s.archived IS NOT TRUE
       AND p.type = ANY(${opts.types}::text[])
       AND (CASE WHEN ${opts.collapsed === true}::boolean
              THEN p.frontmatter -> 'dedupe_collapse' IS NOT NULL AND btrim(COALESCE(p.frontmatter ->> 'merged_into', '')) <> ''
              ELSE NOT ${trustedSql(retiredPageSql('p'))} END)
       AND (${members === null}::boolean OR (p.source_id, p.slug) IN (
             SELECT * FROM unnest(${(members ?? []).map(m => m.source_id)}::text[], ${(members ?? []).map(m => m.slug)}::text[])))
       AND (${tokens === null}::boolean OR EXISTS (
             SELECT 1 FROM unnest(${tokens?.fields ?? []}::text[]) AS f(key)
             CROSS JOIN LATERAL jsonb_array_elements_text(CASE jsonb_typeof(p.frontmatter -> f.key)
                 WHEN 'array' THEN p.frontmatter -> f.key WHEN 'string' THEN jsonb_build_array(p.frontmatter -> f.key)
                 WHEN 'number' THEN jsonb_build_array((p.frontmatter -> f.key)::text) ELSE '[]'::jsonb END) AS v(value)
             CROSS JOIN LATERAL (SELECT lower(btrim(v.value)) AS raw) n
             CROSS JOIN LATERAL (SELECT '/' || n.raw AS slashed) q
             CROSS JOIN LATERAL unnest(ARRAY[n.raw, ltrim(n.raw, '@'),
                 split_part(split_part(split_part(split_part(regexp_replace(n.raw, '^[a-z][a-z0-9+.-]*://(www[.])?', ''), '/', 1), '?', 1), '#', 1), ':', 1),
                 split_part(split_part(split_part(split_part(substr(q.slashed, NULLIF(strpos(q.slashed, '/company/'), 0) + 9), '/', 1), '?', 1), '#', 1), ' ', 1),
                 split_part(split_part(split_part(split_part(substr(q.slashed, NULLIF(strpos(q.slashed, '/in/'), 0) + 4), '/', 1), '?', 1), '#', 1), ' ', 1),
                 split_part(split_part(split_part(split_part(substr(q.slashed, NULLIF(strpos(q.slashed, '/pub/'), 0) + 5), '/', 1), '?', 1), '#', 1), ' ', 1),
                 split_part(split_part(split_part(split_part(substr(n.raw, NULLIF(strpos(n.raw, 'github.com/'), 0) + 11), '/', 1), '?', 1), '#', 1), ' ', 1)]) AS t(form)
            WHERE t.form = ANY(${tokens?.values ?? []}::text[])))
       AND (p.source_id, p.slug) > (${opts.after?.source_id ?? ''}::text, ${opts.after?.slug ?? ''}::text)
     ORDER BY p.source_id, p.slug
     LIMIT ${opts.limit}::int`);
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug, title: r.title, type: r.type,
    keys: (typeof r.keys === 'string' ? JSON.parse(r.keys) : r.keys ?? {}) as Record<string, unknown>,
    page_id: Number(r.page_id), generation: Number(r.generation), created_at: String(r.created_at),
    identity: r.entity_id ? { entity_id: r.entity_id, established_by: r.established_by ?? 'manual' } : null }));
}
