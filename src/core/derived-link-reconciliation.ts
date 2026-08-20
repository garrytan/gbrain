/**
 * Exact, source- and provenance-scoped reconciliation for links derived from
 * one page.
 *
 * This is the destructive half of link extraction: addLinksBatch is
 * deliberately additive, while a page rewrite needs removed references to
 * disappear. Ownership is provenance-specific so user-authored/manual edges
 * and another page's frontmatter edges can never be swept accidentally.
 */

import type {
  BrainEngine,
  DerivedLinkReconciliationOpts,
  DerivedLinkReconciliationResult,
  LinkBatchInput,
  ManagedDerivedLinkSource,
} from './engine.ts';
import { buildLinkRows, type LinkRow } from './batch-rows.ts';
import { executeRawJsonb } from './sql-query.ts';
import { assertValidSourceId } from './source-id.ts';
import { validateSlug } from './utils.ts';

const ALL_MANAGED_DERIVED_SOURCES: readonly ManagedDerivedLinkSource[] = [
  'markdown',
  'frontmatter',
  'wikilink-resolved',
];
const MANAGED_DERIVED_SOURCES = new Set<string>(ALL_MANAGED_DERIVED_SOURCES);

function normalizedRows(
  originSlugRaw: string,
  links: LinkBatchInput[],
  opts: DerivedLinkReconciliationOpts,
): { originSlug: string; rows: LinkRow[]; managedSources: ManagedDerivedLinkSource[] } {
  const sourceId = opts.sourceId;
  assertValidSourceId(sourceId);
  const originSlug = validateSlug(originSlugRaw);
  const managedSources = opts.linkSources
    ? [...new Set(opts.linkSources)]
    : [...ALL_MANAGED_DERIVED_SOURCES];
  if (managedSources.length === 0) {
    throw new Error('reconcileDerivedLinks requires at least one managed link-source partition');
  }
  for (const source of managedSources) {
    if (!MANAGED_DERIVED_SOURCES.has(source)) {
      throw new Error(`reconcileDerivedLinks does not manage provenance ${JSON.stringify(source)}`);
    }
  }
  const selectedSources = new Set<string>(managedSources);
  const normalized = links.map((link): LinkBatchInput => {
    const linkSource = link.link_source || 'markdown';
    if (!MANAGED_DERIVED_SOURCES.has(linkSource)) {
      throw new Error(
        `reconcileDerivedLinks only accepts managed derived provenance; got ${JSON.stringify(linkSource)}`,
      );
    }
    if (!selectedSources.has(linkSource)) {
      throw new Error(
        `desired link provenance ${JSON.stringify(linkSource)} is outside the declared reconciliation scope`,
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
  return { originSlug, rows: buildLinkRows(normalized), managedSources };
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
  opts: DerivedLinkReconciliationOpts,
): Promise<DerivedLinkReconciliationResult> {
  const { originSlug, rows, managedSources } = normalizedRows(originSlugRaw, links, opts);
  if (opts.stampExtractedAt && !opts.expectedUpdatedAt) {
    throw new Error('stampExtractedAt requires expectedUpdatedAt');
  }

  return engine.transaction(async (tx) => {
    // Revision fence + row lock: a worker may have extracted an older body
    // while another writer (or sweep) advanced the page. Lock before any
    // destructive reconciliation, then stamp under the same lock so no stale
    // worker can overwrite newer edges and subsequently mark them fresh.
    if (opts.expectedUpdatedAt) {
      const current = await tx.executeRaw<{ matches: boolean }>(
        `SELECT updated_at = $3::timestamptz AS matches
           FROM pages
          WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [originSlug, opts.sourceId, opts.expectedUpdatedAt],
      );
      if (current[0]?.matches !== true) return { created: 0, removed: 0 };
    }

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
       ), resolved AS (${RESOLVED_DESIRED}),
          managed_sources AS (
         SELECT jsonb_array_elements_text(($3::jsonb)->'managed_sources') AS link_source
       )
       DELETE FROM links l
        WHERE l.link_source IN (SELECT link_source FROM managed_sources)
          AND (
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
      [{ rows, managed_sources: managedSources }],
    );

    if (opts.stampExtractedAt) {
      await tx.executeRaw(
        `UPDATE pages SET links_extracted_at = $3::timestamptz
          WHERE slug = $1 AND source_id = $2`,
        [originSlug, opts.sourceId, opts.stampExtractedAt],
      );
    }

    return { created: inserted.length, removed: removed.length };
  });
}
