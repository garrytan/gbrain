/**
 * Exact, source-scoped reconciliation for links derived from one page.
 *
 * This is the destructive half of link extraction: addLinksBatch is
 * deliberately additive, while a page rewrite needs removed references to
 * disappear. Ownership is provenance-specific so user-authored/manual edges
 * and another page's frontmatter edges can never be swept accidentally.
 */

import type {
  BrainEngine,
  DerivedLinkReconciliationResult,
  LinkBatchInput,
} from './engine.ts';
import { buildLinkRows, type LinkRow } from './batch-rows.ts';
import { executeRawJsonb } from './sql-query.ts';
import { assertValidSourceId } from './source-id.ts';
import { validateSlug } from './utils.ts';

const MANAGED_DERIVED_SOURCES = new Set([
  'markdown',
  'frontmatter',
  'wikilink-resolved',
]);

function normalizedRows(
  originSlugRaw: string,
  sourceId: string,
  links: LinkBatchInput[],
): { originSlug: string; rows: LinkRow[] } {
  assertValidSourceId(sourceId);
  const originSlug = validateSlug(originSlugRaw);
  const normalized = links.map((link): LinkBatchInput => {
    const linkSource = link.link_source || 'markdown';
    if (!MANAGED_DERIVED_SOURCES.has(linkSource)) {
      throw new Error(
        `reconcileDerivedLinks only accepts managed derived provenance; got ${JSON.stringify(linkSource)}`,
      );
    }

    const fromSourceId = link.from_source_id || sourceId;
    const toSourceId = link.to_source_id || sourceId;
    const originSourceId = link.origin_source_id || sourceId;
    assertValidSourceId(fromSourceId);
    assertValidSourceId(toSourceId);
    assertValidSourceId(originSourceId);

    if (linkSource === 'frontmatter') {
      const declaredOrigin = validateSlug(link.origin_slug || originSlug);
      if (declaredOrigin !== originSlug || originSourceId !== sourceId) {
        throw new Error('frontmatter reconciliation rows must be authored by the scoped origin page');
      }
      return {
        ...link,
        link_source: linkSource,
        origin_slug: originSlug,
        from_source_id: fromSourceId,
        to_source_id: toSourceId,
        origin_source_id: sourceId,
      };
    }

    if (validateSlug(link.from_slug) !== originSlug || fromSourceId !== sourceId) {
      throw new Error('markdown reconciliation rows must originate from the scoped page');
    }
    return {
      ...link,
      from_slug: originSlug,
      link_source: linkSource,
      from_source_id: sourceId,
      to_source_id: toSourceId,
      origin_source_id: originSourceId,
    };
  });
  return { originSlug, rows: buildLinkRows(normalized) };
}

const DESIRED_RECORDSET = `
  SELECT *
    FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(
      from_slug text, to_slug text, link_type text, context text, link_source text,
      origin_slug text, origin_field text, from_source_id text, to_source_id text,
      origin_source_id text, link_kind text
    )`;

const RESOLVED_DESIRED = `
  SELECT f.id AS from_id, t.id AS to_id, o.id AS origin_id,
         v.link_type, v.context, v.link_source, v.link_kind, v.origin_field
    FROM desired v
    JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
    JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
    LEFT JOIN pages o ON o.slug = v.origin_slug AND o.source_id = v.origin_source_id`;

/**
 * Shared implementation used by both engines. All three statements execute
 * inside one engine transaction: insert missing desired rows, refresh the
 * context/provenance columns on surviving rows, then prune stale owned rows.
 */
export async function runDerivedLinkReconciliation(
  engine: BrainEngine,
  originSlugRaw: string,
  links: LinkBatchInput[],
  opts: { sourceId: string },
): Promise<DerivedLinkReconciliationResult> {
  const { originSlug, rows } = normalizedRows(originSlugRaw, opts.sourceId, links);

  return engine.transaction(async (tx) => {
    const inserted = await executeRawJsonb<{ one: number }>(
      tx,
      `WITH desired AS (${DESIRED_RECORDSET})
       INSERT INTO links (
         from_page_id, to_page_id, link_type, context, link_source,
         link_kind, origin_page_id, origin_field
       )
       SELECT f.id, t.id, v.link_type, v.context, v.link_source,
              v.link_kind, o.id, v.origin_field
         FROM desired v
         JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
         JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
         LEFT JOIN pages o ON o.slug = v.origin_slug AND o.source_id = v.origin_source_id
       ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id)
       DO NOTHING
       RETURNING 1 AS one`,
      [],
      [{ rows }],
    );

    // Existing desired rows still need their excerpt/field metadata refreshed.
    await executeRawJsonb(
      tx,
      `WITH desired AS (${DESIRED_RECORDSET}),
            resolved AS (${RESOLVED_DESIRED})
       UPDATE links l
          SET context = r.context,
              link_kind = r.link_kind,
              origin_field = r.origin_field
         FROM resolved r
        WHERE l.from_page_id = r.from_id
          AND l.to_page_id = r.to_id
          AND l.link_type = r.link_type
          AND l.link_source IS NOT DISTINCT FROM r.link_source
          AND l.origin_page_id IS NOT DISTINCT FROM r.origin_id`,
      [],
      [{ rows }],
    );

    const removed = await executeRawJsonb<{ one: number }>(
      tx,
      `WITH desired AS (
         SELECT *
           FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(
             from_slug text, to_slug text, link_type text, context text, link_source text,
             origin_slug text, origin_field text, from_source_id text, to_source_id text,
             origin_source_id text, link_kind text
           )
       ), resolved AS (${RESOLVED_DESIRED})
       DELETE FROM links l
        WHERE (
          (l.link_source IN ('markdown', 'wikilink-resolved')
            AND l.from_page_id = (
              SELECT id FROM pages WHERE slug = $1 AND source_id = $2
            ))
          OR
          (l.link_source = 'frontmatter'
            AND l.origin_page_id = (
              SELECT id FROM pages WHERE slug = $1 AND source_id = $2
            ))
        )
          AND NOT EXISTS (
            SELECT 1 FROM resolved r
             WHERE l.from_page_id = r.from_id
               AND l.to_page_id = r.to_id
               AND l.link_type = r.link_type
               AND l.link_source IS NOT DISTINCT FROM r.link_source
               AND l.origin_page_id IS NOT DISTINCT FROM r.origin_id
          )
       RETURNING 1 AS one`,
      [originSlug, opts.sourceId],
      [{ rows }],
    );

    return { created: inserted.length, removed: removed.length };
  });
}
