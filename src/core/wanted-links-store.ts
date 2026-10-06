/**
 * Storage for wanted pages (see src/core/wanted-links.ts). Kept free of the
 * link-extraction import graph because derived-links.ts, which every engine
 * imports, calls it inside the derived-link replacement transaction.
 */
import type { BrainEngine } from './engine.ts';
import { executeRawJsonb } from './sql-query.ts';
import { sanitizeForJsonb } from './batch-rows.ts';

export type WantedProducer = 'body' | 'frontmatter';

export interface WantedLinkInput {
  producer: WantedProducer;
  ref_kind: 'slug' | 'name';
  target_source_id: string;
  target_ref: string;
  link_type: string;
  context: string;
}

export interface WantedLinksReplacement {
  rows: WantedLinkInput[];
  /** Producers whose rows this replacement owns; others stay untouched. */
  producers: readonly WantedProducer[];
}

/**
 * Replace one origin's wanted rows inside the caller's transaction (the same
 * one that replaces its derived links). Slug targets are locked first, so a
 * concurrent writer creating the target either committed before this check
 * (and the row is stamped `-infinity`, leaving the origin stale) or commits
 * after it with an `updated_at` past `checked_at`. Only an exact slug counts
 * here: a bare-name reference matching some page's basename may legitimately
 * stay unresolved (basename resolution is opt-in), and stamping it
 * `-infinity` would re-list its origin forever.
 */
export async function replaceWantedLinks(
  tx: Pick<BrainEngine, 'executeRaw' | 'lockPageKeys'>,
  origin: { pageId: number; sourceId: string },
  replacement: WantedLinksReplacement,
): Promise<number> {
  if (!replacement.producers.length) return 0;
  const rows = replacement.rows.filter(row => replacement.producers.includes(row.producer))
    .map(row => ({ ...row, context: sanitizeForJsonb(row.context) }));
  const slugTargets = rows.filter(row => row.ref_kind === 'slug')
    .map(row => ({ sourceId: row.target_source_id, slug: row.target_ref }));
  if (slugTargets.length) await tx.lockPageKeys(slugTargets);
  await executeRawJsonb(tx, `DELETE FROM wanted_links w
      WHERE w.origin_page_id = $1
        AND w.producer IN (SELECT jsonb_array_elements_text(($2::jsonb)->'producers'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(($2::jsonb)->'rows')
          AS v(producer text, ref_kind text, target_source_id text, target_ref text)
          WHERE v.producer = w.producer AND v.ref_kind = w.ref_kind
            AND v.target_source_id = w.target_source_id AND v.target_ref = w.target_ref)`,
  [origin.pageId], [{ rows, producers: replacement.producers }]);
  if (!rows.length) return 0;
  const written = await executeRawJsonb<{ id: number }>(tx, `INSERT INTO wanted_links
      (origin_page_id, source_id, producer, ref_kind, target_source_id, target_ref, link_type, context, checked_at)
    SELECT $1, $2, v.producer, v.ref_kind, v.target_source_id, v.target_ref, v.link_type, v.context,
      CASE WHEN EXISTS (SELECT 1 FROM pages t WHERE t.source_id = v.target_source_id AND t.deleted_at IS NULL
        AND t.slug = v.target_ref)
      THEN '-infinity'::timestamptz ELSE now() END
    FROM jsonb_to_recordset(($3::jsonb)->'rows')
      AS v(producer text, ref_kind text, target_source_id text, target_ref text, link_type text, context text)
    ON CONFLICT ON CONSTRAINT wanted_links_reference_unique DO UPDATE
      SET link_type = EXCLUDED.link_type, context = EXCLUDED.context, checked_at = EXCLUDED.checked_at
    RETURNING id`, [origin.pageId, origin.sourceId], [{ rows }]);
  return written.length;
}

export interface WantedPageRow {
  target: string;
  target_source_id: string;
  ref_kind: 'slug' | 'name';
  referenced_by: number;
  sample_origins: Array<{ slug: string; source_id: string }>;
  link_types: string[];
  /** Live pages whose basename equals a bare-name target (link them by slug). */
  existing_matches: Array<{ slug: string; source_id: string }>;
  first_seen: string;
  last_checked: string;
}

/**
 * Missing link targets, most-referenced first. Scope applies to the origin
 * pages (the caller's readable sources) and, when `excludePrivate`, private
 * origins are removed BEFORE aggregation so a private page never reveals a
 * target name or contributes to a count. Soft-deleted origins never count.
 */
export async function listWantedPages(engine: Pick<BrainEngine, 'executeRaw'>, opts: {
  sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; privateFilter?: (alias: string) => string;
  limit: number; offset: number;
}): Promise<{ total: number; rows: WantedPageRow[] }> {
  const params: unknown[] = [];
  const scope = opts.sourceIds?.length
    ? (params.push(opts.sourceIds), ` AND o.source_id = ANY($${params.length}::text[])`)
    : opts.sourceId ? (params.push(opts.sourceId), ` AND o.source_id = $${params.length}`) : '';
  const originPrivacy = opts.excludePrivate && opts.privateFilter ? ` AND ${opts.privateFilter('o')}` : '';
  const matchPrivacy = opts.excludePrivate && opts.privateFilter ? ` AND ${opts.privateFilter('m')}` : '';
  const base = `WITH wanted AS (
      SELECT w.target_source_id, w.target_ref, w.ref_kind, w.link_type, w.first_seen_at, w.checked_at,
        o.slug AS origin_slug, o.source_id AS origin_source_id
      FROM wanted_links w JOIN pages o ON o.id = w.origin_page_id AND o.deleted_at IS NULL
      WHERE NOT EXISTS (SELECT 1 FROM pages t WHERE t.source_id = w.target_source_id AND t.slug = w.target_ref AND t.deleted_at IS NULL)
        ${scope}${originPrivacy}
    ), grouped AS (
      SELECT target_source_id, target_ref, min(ref_kind) AS ref_kind,
        count(DISTINCT (origin_source_id, origin_slug))::int AS referenced_by,
        jsonb_agg(jsonb_build_object('slug', origin_slug, 'source_id', origin_source_id) ORDER BY origin_slug) AS origins,
        coalesce(jsonb_agg(DISTINCT link_type) FILTER (WHERE link_type <> ''), '[]'::jsonb) AS link_types,
        min(first_seen_at) AS first_seen, max(checked_at) AS last_checked
      FROM wanted GROUP BY target_source_id, target_ref
    )`;
  const [{ total }] = await engine.executeRaw<{ total: number }>(`${base} SELECT count(*)::int AS total FROM grouped`, params);
  params.push(opts.limit, opts.offset);
  const rows = await engine.executeRaw<{ target_source_id: string; target_ref: string; ref_kind: 'slug' | 'name'; referenced_by: number;
    origins: Array<{ slug: string; source_id: string }>; link_types: string[]; matches: Array<{ slug: string; source_id: string }> | null;
    first_seen: Date | string; last_checked: Date | string }>(`${base}
    SELECT g.*, (SELECT jsonb_agg(jsonb_build_object('slug', m.slug, 'source_id', m.source_id))
        FROM (SELECT m.slug, m.source_id FROM pages m WHERE g.ref_kind = 'name' AND m.source_id = g.target_source_id
          AND regexp_replace(m.slug, '^.*/', '') = g.target_ref AND m.deleted_at IS NULL${matchPrivacy}
          ORDER BY m.slug LIMIT 3) m) AS matches
    FROM grouped g ORDER BY g.referenced_by DESC, g.target_source_id, g.target_ref
    LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();
  return { total: Number(total ?? 0), rows: rows.map(row => {
    const seen = new Set<string>();
    const origins = (row.origins ?? []).filter(o => !seen.has(`${o.source_id}\0${o.slug}`) && seen.add(`${o.source_id}\0${o.slug}`));
    return { target: row.target_ref, target_source_id: row.target_source_id, ref_kind: row.ref_kind,
      referenced_by: Number(row.referenced_by), sample_origins: origins.slice(0, 3), link_types: row.link_types ?? [],
      existing_matches: row.matches ?? [], first_seen: iso(row.first_seen),
      last_checked: Number.isFinite(new Date(row.last_checked).getTime()) ? iso(row.last_checked) : 'pending' };
  }) };
}
