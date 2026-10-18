/**
 * Links: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/links.json`); PGLite runs the same statements
 * (docs/designs/refactor-wave-1/w1-inventory.md, "links").
 *
 * The JSONB batch writes keep master's executeRaw path (executeRawJsonb over
 * the executor); the engine re-resolves the executor on each batchRetry
 * attempt. `getLinks` / `getBacklinks` / `listLinkSources` ran inside
 * `withScopedReadTransaction` on master and take `ScopedRead`; the other reads
 * take `LegacyUnscopedRead` (EO4 inventory). `replaceDerivedLinks` already
 * shares `derived-links.ts`.
 */
import type { LinkBatchInput, TraverseGraphOpts } from '../engine.ts';
import type { Link, GraphNode, GraphPath } from '../types.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { sanitizeForJsonb, buildLinkRows } from '../batch-rows.ts';
import { privatePagesFilterFragment, privateLinkOriginFilterFragment } from '../search/private-visibility.ts';
import { TRAVERSE_PATH_ROW_CAP, TRAVERSE_WALK_ROW_CAP } from '../engine-constants.ts';
import { PageMissingError } from '../engine-errors.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../quarantine.ts';
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead, ScopedRead } from './brands.ts';
import { sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { refreshRelationships, type RelationshipKey } from '../link-relationships.ts';
import { isTemporalLinkType, relationshipFilterSql, temporalLinkJoinSql, TEMPORAL_LINK_SELECT_SQL, annotateTemporalRow } from '../link-validity.ts';
import type { LinkReadScope } from '../link-validity.ts';

/** Bounded link reads annotate rows with relationship status (never filter) when a temporal read is requested. */
function finishTemporal(rows: unknown[], opts?: LinkReadScope): Link[] {
  const t = opts?.temporal;
  return (t ? rows.map(r => annotateTemporalRow(r as Link, t.asOf)) : rows) as Link[];
}

/** WHERE fragment that keeps only edges matching the caller's temporal policy (walks and fanout). */
function temporalWalkFilter(alias: string, opts?: LinkReadScope) {
  return opts?.temporal ? trustedSql(`AND ${relationshipFilterSql(alias, { ...opts.temporal, excludePrivate: opts.excludePrivate })}`) : sqlFragment``;
}

export async function addLink(
  exec: SqlExecutor,
    from: string,
    to: string,
    context?: string,
    linkType?: string,
    linkSource?: string,
    originSlug?: string,
    originField?: string,
    opts?: { fromSourceId?: string; toSourceId?: string; originSourceId?: string },
  ): Promise<void> {
    const fromSrc = opts?.fromSourceId ?? 'default';
    const toSrc = opts?.toSourceId ?? 'default';
    const originSrc = opts?.originSourceId ?? 'default';

    // Default link_source to 'markdown' for back-compat with pre-v0.13 callers.
    const src = linkSource ?? 'markdown';
    // #4109: resolve both required endpoints and upsert from ONE statement
    // snapshot — a separate pre-check raced concurrent hard deletes (a delete
    // winning between check and insert made a zero-row upsert look like
    // success). The lookups stay source-qualified per endpoint (JOIN-on-
    // (slug, source_id), not the pre-v0.18 cross-product that fanned out
    // across sources containing either slug). FOR KEY SHARE makes a
    // concurrent hard delete linearize around the mutation: a delete that
    // wins first is observed as a missing endpoint; a mutation that wins
    // first holds the referenced rows through the insert instead of leaking
    // a raw FK violation.
    const [result] = (await exec.run(sqlFragment`
      WITH endpoint_state AS (
        SELECT
          (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc} FOR KEY SHARE) AS from_id,
          (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc} FOR KEY SHARE) AS to_id,
          (SELECT id FROM pages WHERE slug = ${originSlug ?? null} AND source_id = ${originSrc} FOR KEY SHARE) AS origin_id
      ), upserted AS (
        INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
        SELECT s.from_id, s.to_id, ${linkType || ''}, ${sanitizeForJsonb(context || '')}, ${src}, s.origin_id, ${originField ?? null}
        FROM endpoint_state s
        WHERE s.from_id IS NOT NULL AND s.to_id IS NOT NULL
        ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET
          context = EXCLUDED.context,
          origin_field = EXCLUDED.origin_field
        RETURNING 1
      )
      SELECT
        endpoint_state.from_id IS NOT NULL AS from_exists,
        endpoint_state.to_id IS NOT NULL AS to_exists,
        endpoint_state.from_id, endpoint_state.to_id
      FROM endpoint_state
    `)).rows as Array<{ from_exists: boolean; to_exists: boolean; from_id: number | null; to_id: number | null }>;
    if (!result?.from_exists) throw new PageMissingError('addLink', 'from', from, fromSrc);
    if (!result.to_exists) throw new PageMissingError('addLink', 'to', to, toSrc);
    if (isTemporalLinkType(linkType)) {
      await refreshRelationships(exec, [{ from_page_id: Number(result.from_id), to_page_id: Number(result.to_id), link_type: linkType! }]);
    }
  }


/** One code path a markdown page cites (`src/core/sync.ts:42`), with the slug of its code page. */
export interface CodeReference { codeSlug: string; path: string; line?: number }

/**
 * The doc↔impl edges for every code path one markdown page cites, in one
 * statement (#6712 L6; the import paths wrote two savepointed addLink calls per
 * reference). Each reference writes what the addLink pair wrote: page→code
 * `documents` (context `cited at <path>:<line>`, or the path) and code→page
 * `documented_by` (context the path), both `markdown` edges whose origin is the
 * page, field `compiled_truth`. Endpoints resolve source-qualified in the
 * page's source under FOR KEY SHARE in the same statement snapshot; an edge
 * whose endpoint is missing is skipped alone (a code page not imported yet);
 * an existing edge takes the new context and origin_field; a repeated edge
 * keeps its last occurrence, as sequential upserts would. Returns the edges
 * written (inserted or updated).
 */
export async function addCodeReferenceLinks(exec: Pick<SqlExecutor, 'executeRaw'>, slug: string, sourceId: string, refs: CodeReference[]): Promise<number> {
  const edges = new Map<string, { from_slug: string; to_slug: string; link_type: string; context: string }>();
  for (const ref of refs) {
    for (const [from, to, linkType, context] of [
      [slug, ref.codeSlug, 'documents', ref.line ? `cited at ${ref.path}:${ref.line}` : ref.path],
      [ref.codeSlug, slug, 'documented_by', ref.path],
    ] as const) {
      const key = JSON.stringify([from, to, linkType]);
      edges.delete(key);
      edges.set(key, { from_slug: from, to_slug: to, link_type: linkType, context: sanitizeForJsonb(context) });
    }
  }
  if (!edges.size) return 0;
  const rows = [...edges.values()].map((edge, ord) => ({ ...edge, ord }));
  const written = await executeRawJsonb<RelationshipKey>(exec,
    `WITH v AS (
       SELECT * FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(ord int, from_slug text, to_slug text, link_type text, context text)
     ), endpoints AS (
       SELECT p.id, p.slug FROM pages p
       WHERE p.source_id = $1 AND p.slug IN (SELECT from_slug FROM v UNION SELECT to_slug FROM v)
       ORDER BY p.id
       FOR KEY SHARE
     )
     INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
     SELECT f.id, t.id, v.link_type, v.context, 'markdown', o.id, 'compiled_truth'
     FROM v
     JOIN endpoints f ON f.slug = v.from_slug
     JOIN endpoints t ON t.slug = v.to_slug
     LEFT JOIN endpoints o ON o.slug = $2::text
     ORDER BY v.ord
     ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET
       context = EXCLUDED.context,
       origin_field = EXCLUDED.origin_field
     RETURNING from_page_id, to_page_id, link_type`,
    [sourceId, slug],
    [{ rows }],
  );
  await refreshRelationships(exec, written);
  return written.length;
}

export async function addLinksBatch(exec: SqlExecutor, links: LinkBatchInput[]): Promise<number> {
    // #1861: pass the batch as one JSONB document via jsonb_to_recordset instead
    // of N parallel unnest(${arr}::text[]). The old text[] array-literal path
    // crashed Postgres ("malformed array literal") on free-text context strings
    // (calendar/Zoom lines with commas, quotes, braces, em-dashes); JSONB encodes
    // arbitrary text safely and dodges the 65535-param cap. Binding goes through
    // executeRawJsonb (the audited cross-engine JSONB contract) with an OBJECT
    // wrapper { rows } — a bare top-level array through postgres.js would re-enter
    // the same array serializer this fix exists to avoid. Row construction +
    // NUL-stripping + exact defaulting live in buildLinkRows (shared with PGLite).
    const rows = buildLinkRows(links);
    const insert = (target: SqlExecutor) => executeRawJsonb<RelationshipKey>(
      target,
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, link_kind, origin_page_id, origin_field, resolution_type)
       SELECT f.id, t.id, v.link_type, v.context, v.link_source, v.link_kind, o.id, v.origin_field, v.resolution_type
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(
         from_slug text, to_slug text, link_type text, context text, link_source text,
         origin_slug text, origin_field text, from_source_id text, to_source_id text,
         origin_source_id text, link_kind text, resolution_type text
       )
       JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
       JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
       LEFT JOIN pages o ON o.slug = v.origin_slug AND o.source_id = v.origin_source_id
       ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO NOTHING
       RETURNING from_page_id, to_page_id, link_type`,
      [],
      [{ rows }],
    );
    // Temporal relation types also refresh their relationship state in the
    // same transaction; batches of plain references skip it entirely.
    if (!rows.some(r => isTemporalLinkType(r.link_type))) return (await insert(exec)).length;
    return exec.transaction(async tx => {
      const inserted = await insert(tx);
      await refreshRelationships(tx, inserted);
      return inserted.length;
    });
  }


  // #3674 — see BrainEngine.removeLinksByPagesAndSource JSDoc. Identical SQL
  // shape in PGLiteEngine (parity). JSONB recordset binding (never
  // JSON.stringify into ::jsonb — executeRawJsonb passes raw objects).
export async function removeLinksByPagesAndSource(
  exec: SqlExecutor,
    pages: Array<{ slug: string; source_id: string }>,
    opts: {
      linkSource: string;
      keepTypedNerPairs?: Array<{
        from_slug: string; from_source_id: string;
        to_slug: string; to_source_id: string;
      }>;
    },
  ): Promise<number> {
    if (pages.length === 0) return 0;
    const payload = { pages, keep: opts.keepTypedNerPairs ?? [] };
    const rows = await executeRawJsonb(
      exec,
      `WITH scope AS (
         SELECT f.id AS from_id
         FROM jsonb_to_recordset(($2::jsonb)->'pages') AS p(slug text, source_id text)
         JOIN pages f ON f.slug = p.slug AND f.source_id = p.source_id
       ),
       keep AS (
         SELECT f.id AS from_id, t.id AS to_id
         FROM jsonb_to_recordset(($2::jsonb)->'keep') AS k(
           from_slug text, from_source_id text, to_slug text, to_source_id text
         )
         JOIN pages f ON f.slug = k.from_slug AND f.source_id = k.from_source_id
         JOIN pages t ON t.slug = k.to_slug AND t.source_id = k.to_source_id
       )
       DELETE FROM links l
       USING scope s
       WHERE l.from_page_id = s.from_id
         AND l.link_source = $1
         AND NOT (
           COALESCE(l.link_kind, '') = 'typed_ner'
           AND EXISTS (
             SELECT 1 FROM keep k
             WHERE k.from_id = l.from_page_id AND k.to_id = l.to_page_id
           )
         )
       RETURNING l.from_page_id, l.to_page_id, l.link_type`,
      [opts.linkSource],
      [payload],
    ) as RelationshipKey[];
    await refreshRelationships(exec, rows);
    return rows.length;
  }


export async function removeLink(
  exec: SqlExecutor,
    from: string,
    to: string,
    linkType?: string,
    linkSource?: string,
    opts?: { fromSourceId?: string; toSourceId?: string },
  ): Promise<number> {
    const fromSrc = opts?.fromSourceId ?? 'default';
    const toSrc = opts?.toSourceId ?? 'default';
    // Build up filters dynamically. linkType + linkSource are independent
    // optional constraints; all four combinations are valid. Each branch's
    // page-id subquery is source-qualified so multi-source brains don't
    // delete the wrong (from, to) pair.
    // #4527: RETURNING 1 so the caller learns how many edges actually died —
    // a zero-match delete must be distinguishable from a real removal.
    if (linkType !== undefined && linkSource !== undefined) {
      const rows = (await exec.run(sqlFragment`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
          AND link_type = ${linkType}
          AND link_source IS NOT DISTINCT FROM ${linkSource}
        RETURNING from_page_id, to_page_id, link_type
      `)).rows as unknown as RelationshipKey[];
      await refreshRelationships(exec, rows);
      return rows.length;
    } else if (linkType !== undefined) {
      const rows = (await exec.run(sqlFragment`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
          AND link_type = ${linkType}
        RETURNING from_page_id, to_page_id, link_type
      `)).rows as unknown as RelationshipKey[];
      await refreshRelationships(exec, rows);
      return rows.length;
    } else if (linkSource !== undefined) {
      const rows = (await exec.run(sqlFragment`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
          AND link_source IS NOT DISTINCT FROM ${linkSource}
        RETURNING from_page_id, to_page_id, link_type
      `)).rows as unknown as RelationshipKey[];
      await refreshRelationships(exec, rows);
      return rows.length;
    } else {
      const rows = (await exec.run(sqlFragment`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
        RETURNING from_page_id, to_page_id, link_type
      `)).rows as unknown as RelationshipKey[];
      await refreshRelationships(exec, rows);
      return rows.length;
    }
  }


export async function getLinks(exec: ScopedRead, slug: string, opts?: LinkReadScope): Promise<Link[]> {
    const privacy = opts?.excludePrivate ? `AND ${privatePagesFilterFragment('f')} AND ${privatePagesFilterFragment('t')} AND ${privateLinkOriginFilterFragment('l')}` : '';
    const tSel = opts?.temporal ? TEMPORAL_LINK_SELECT_SQL : '';
    const tJoin = opts?.temporal ? temporalLinkJoinSql('l', opts.excludePrivate) : '';
    const finish = (rows: unknown[]) => finishTemporal(rows, opts);
      // #2200: federated grant scopes ALL THREE page endpoints — from, to, AND
      // the origin (the page that authored the edge, surfaced as origin_slug).
      // Scoping only from+to would still leak an out-of-grant origin's slug; the
      // origin LEFT JOIN carries the same ANY($) filter so origin_slug nulls
      // out of grant. Remote MCP clients always land here.
      if (opts?.sourceIds && opts.sourceIds.length > 0) {
        const ids = opts.sourceIds;
        const rows = (await exec.run(sqlFragment`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field ${trustedSql(tSel)}
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY(${ids}::text[]) ${trustedSql(tJoin)}
          WHERE f.slug = ${slug} AND f.source_id = ANY(${ids}::text[]) AND t.source_id = ANY(${ids}::text[])
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
          ORDER BY l.id
        `)).rows;
        return finish(rows);
      }
      // v0.31.8 (D16) + #2200: the federated arm above is the first branch; the
      // two below preserve pre-v0.31.8 semantics. Without opts.sourceId, no
      // source filter (cross-source view for internal callers). With
      // opts.sourceId, scope the from-page lookup.
      // #3754: all three arms filter soft-deleted endpoints (f/t deleted_at IS
      // NULL) so links to/from soft-deleted pages stop voting in the graph,
      // matching orphans/get/list/search visibility.
      if (opts?.sourceId) {
        const rows = (await exec.run(sqlFragment`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field ${trustedSql(tSel)}
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id ${trustedSql(tJoin)}
          WHERE f.slug = ${slug} AND f.source_id = ${opts.sourceId}
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
          ORDER BY l.id
        `)).rows;
        return finish(rows);
      }
      const rows = (await exec.run(sqlFragment`
        SELECT f.slug as from_slug, f.source_id as from_source_id,
               t.slug as to_slug, t.source_id as to_source_id,
               l.link_type, l.context, l.link_source,
               o.slug as origin_slug, o.source_id as origin_source_id,
               l.origin_field ${trustedSql(tSel)}
        FROM links l
        JOIN pages f ON f.id = l.from_page_id
        JOIN pages t ON t.id = l.to_page_id
        LEFT JOIN pages o ON o.id = l.origin_page_id ${trustedSql(tJoin)}
        WHERE f.slug = ${slug}
          AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
        ORDER BY l.id
      `)).rows;
      return finish(rows);
  }


export async function getBacklinks(exec: ScopedRead, slug: string, opts?: LinkReadScope): Promise<Link[]> {
    const privacy = opts?.excludePrivate ? `AND ${privatePagesFilterFragment('f')} AND ${privatePagesFilterFragment('t')} AND ${privateLinkOriginFilterFragment('l')}` : '';
    const tSel = opts?.temporal ? TEMPORAL_LINK_SELECT_SQL : '';
    const tJoin = opts?.temporal ? temporalLinkJoinSql('l', opts.excludePrivate) : '';
    const finish = (rows: unknown[]) => finishTemporal(rows, opts);
      // #2200: federated grant scopes all three endpoints (mirrors getLinks) —
      // the referrer (from), the queried page (to), AND the origin — so neither
      // a foreign referrer nor a foreign origin slug is disclosed to the caller.
      if (opts?.sourceIds && opts.sourceIds.length > 0) {
        const ids = opts.sourceIds;
        const rows = (await exec.run(sqlFragment`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field ${trustedSql(tSel)}
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY(${ids}::text[]) ${trustedSql(tJoin)}
          WHERE t.slug = ${slug} AND t.source_id = ANY(${ids}::text[]) AND f.source_id = ANY(${ids}::text[])
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
          ORDER BY l.id
        `)).rows;
        return finish(rows);
      }
      // v0.31.8 (D16) + #2200: federated arm above is first; two below mirror getLinks
      // (incl. the #3754 soft-delete endpoint filter on all three arms).
      if (opts?.sourceId) {
        const rows = (await exec.run(sqlFragment`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field ${trustedSql(tSel)}
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id ${trustedSql(tJoin)}
          WHERE t.slug = ${slug} AND t.source_id = ${opts.sourceId}
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
          ORDER BY l.id
        `)).rows;
        return finish(rows);
      }
      const rows = (await exec.run(sqlFragment`
        SELECT f.slug as from_slug, f.source_id as from_source_id,
               t.slug as to_slug, t.source_id as to_source_id,
               l.link_type, l.context, l.link_source,
               o.slug as origin_slug, o.source_id as origin_source_id,
               l.origin_field ${trustedSql(tSel)}
        FROM links l
        JOIN pages f ON f.id = l.from_page_id
        JOIN pages t ON t.id = l.to_page_id
        LEFT JOIN pages o ON o.id = l.origin_page_id ${trustedSql(tJoin)}
        WHERE t.slug = ${slug}
          AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
        ORDER BY l.id
      `)).rows;
      return finish(rows);
  }


export async function listLinkSources(
  exec: ScopedRead,
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<{ link_source: string | null; count: number }[]> {
      // v114 (#1941): distinct provenances + counts for `gbrain link-sources`.
      // Scope by the FROM page's source (consistent with getLinks). Federated
      // {sourceIds} takes precedence over scalar {sourceId}; neither = unscoped.
      const sourceCondition =
        opts?.sourceIds && opts.sourceIds.length > 0
          ? sqlFragment`WHERE f.source_id = ANY(${opts.sourceIds}::text[])`
          : opts?.sourceId
            ? sqlFragment`WHERE f.source_id = ${opts.sourceId}`
            : sqlFragment``;
      const rows = (await exec.run(sqlFragment`
        SELECT l.link_source, COUNT(*)::int AS count
        FROM links l
        JOIN pages f ON f.id = l.from_page_id
        ${sourceCondition}
        GROUP BY l.link_source
        ORDER BY count DESC, l.link_source ASC NULLS LAST
      `)).rows;
      return rows as unknown as { link_source: string | null; count: number }[];
  }


export async function findOrphanPages(exec: LegacyUnscopedRead, opts?: {
    sourceId?: string;
    sourceIds?: string[];
    excludePrivate?: boolean;
    mode?: 'inbound' | 'islanded';
  }): Promise<Array<{ slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean; source_id?: string }>> {
    // Soft-delete filter on BOTH sides:
    //   - candidate: p.deleted_at IS NULL — soft-deleted pages aren't orphan candidates
    //   - link source: src.deleted_at IS NULL — links FROM soft-deleted pages don't count as inbound
    // Without the link-source filter, a live page can hide from orphan results purely
    // because a soft-deleted page links to it. v0.26.5 invariant; codex C11.
    //
    // v0.41.29.0: scope ONLY the candidate side (`p.source_id`) when opts.sourceId
    // is set. The inbound-link NOT EXISTS deliberately counts links from ANY source:
    // a page in source X linked FROM source Y is reachable, so NOT an orphan of X.
    // Do NOT add `src.source_id = p.source_id` here — that would be the stricter
    // intra-source-only definition we deliberately reject.
    const sourceFilter =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? sqlFragment`AND p.source_id = ANY(${opts.sourceIds}::text[])`
        : opts?.sourceId
          ? sqlFragment`AND p.source_id = ${opts.sourceId}`
          : sqlFragment``;
    // #4524: default mode 'islanded' — identical predicate to getHealth's
    // orphan_pages (no live inbound AND no live outbound; outbound counts
    // only when its TARGET page is live, per gbrain#4153 endpoint liveness).
    // mode 'inbound' preserves the legacy no-inbound-only view.
    const outboundFilter =
      (opts?.mode ?? 'islanded') === 'islanded'
        ? sqlFragment`AND NOT EXISTS (
            SELECT 1
            FROM links l
            JOIN pages tgt ON tgt.id = l.to_page_id
            WHERE l.from_page_id = p.id
              AND tgt.deleted_at IS NULL ${opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterFragment('tgt')} AND ${privateLinkOriginFilterFragment('l')}`) : sqlFragment``}
          )`
        : sqlFragment``;
    const rows = (await exec.run(sqlFragment`
      SELECT
        p.slug,
        COALESCE(p.title, p.slug) AS title,
        p.frontmatter->>'domain' AS domain,
        p.type,
        (NOT ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}) AS quarantined,
        p.source_id
      FROM pages p
      WHERE p.deleted_at IS NULL ${opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterFragment('p')}`) : sqlFragment``}
        ${sourceFilter}
        AND NOT EXISTS (
          SELECT 1
          FROM links l
          JOIN pages src ON src.id = l.from_page_id
          WHERE l.to_page_id = p.id
            AND src.deleted_at IS NULL ${opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterFragment('src')} AND ${privateLinkOriginFilterFragment('l')}`) : sqlFragment``}
        )
        ${outboundFilter}
      ORDER BY p.slug
    `)).rows;
    return rows as unknown as Array<{ slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean; source_id?: string }>;
  }


/**
 * Breadth-first walk shared by `traverseGraph` and `traversePathsDetailed`.
 *
 * Each recursive row is one whole BFS layer: its depth, its frontier and every
 * page visited so far. A layer expands the frontier through one indexed
 * `links` join with the caller's per-step filters (soft delete, privacy,
 * source scope, link type, temporal policy), drops already-visited pages with a
 * hash anti-join, and keeps at most `layerCap` new pages and never more than
 * TRAVERSE_WALK_ROW_CAP + 1 visited pages in total, in (slug, id) order. Every
 * page therefore appears once, at its shortest distance from the seed, and the
 * work is bounded by the pages and edges touched instead of by the number of
 * simple paths (the old per-path CTE took 22 s on a 12-page clique at depth 5).
 *
 * Emits two CTEs: `bfs` and `walk(id, depth, pos)`, where `pos` is the page's
 * position in visit order. A walk with more than TRAVERSE_WALK_ROW_CAP rows was
 * truncated; callers keep `pos <= TRAVERSE_WALK_ROW_CAP`.
 */
function bfsWalkCtes(w: {
  seed: SqlFragment;
  maxLayer: number;
  direction: 'in' | 'out' | 'both';
  step: SqlFragment;
  layerCap?: number;
}) {
  const out = sqlFragment`SELECT p2.id, p2.slug FROM unnest(bfs.frontier) f(id)
          JOIN links l ON l.from_page_id = f.id
          JOIN pages p2 ON p2.id = l.to_page_id
          WHERE ${w.step}`;
  const into = sqlFragment`SELECT p2.id, p2.slug FROM unnest(bfs.frontier) f(id)
          JOIN links l ON l.to_page_id = f.id
          JOIN pages p2 ON p2.id = l.from_page_id
          WHERE ${w.step}`;
  const neighbours = w.direction === 'out' ? out : w.direction === 'in' ? into : sqlFragment`${out} UNION ALL ${into}`;
  const budget = sqlFragment`greatest(0, ${TRAVERSE_WALK_ROW_CAP + 1}::int - cardinality(bfs.visited))`;
  const limit = w.layerCap !== undefined && w.layerCap > 0 ? sqlFragment`least(${w.layerCap}::int, ${budget})` : budget;
  return sqlFragment`bfs(depth, frontier, visited) AS (
        SELECT 0, array_agg(p.id ORDER BY p.slug, p.id), array_agg(p.id ORDER BY p.slug, p.id)
        FROM pages p WHERE ${w.seed}
        HAVING count(*) > 0
        UNION ALL
        SELECT bfs.depth + 1, n.next, bfs.visited || n.next
        FROM bfs CROSS JOIN LATERAL (
          SELECT array_agg(c.id ORDER BY c.slug, c.id) AS next
          FROM (
            SELECT DISTINCT nb.id, nb.slug FROM (${neighbours}) nb
            WHERE NOT EXISTS (SELECT 1 FROM unnest(bfs.visited) v(id) WHERE v.id = nb.id)
            ORDER BY nb.slug, nb.id
            LIMIT ${limit}
          ) c
        ) n
        WHERE bfs.depth < ${w.maxLayer}::int AND n.next IS NOT NULL
      ),
      walk AS (
        SELECT u.id, b.depth, row_number() OVER (ORDER BY b.depth, u.ord) AS pos
        FROM bfs b CROSS JOIN LATERAL unnest(b.frontier) WITH ORDINALITY u(id, ord)
      )`;
}

const SCOPED_SOURCE_COLUMNS = { p: 'p.source_id', p2: 'p2.source_id', p3: 'p3.source_id', pf: 'pf.source_id', pt: 'pt.source_id' } as const;

function sourceScope(alias: keyof typeof SCOPED_SOURCE_COLUMNS, opts?: { sourceId?: string; sourceIds?: string[] }) {
  const column = trustedSql(SCOPED_SOURCE_COLUMNS[alias]);
  if (opts?.sourceIds && opts.sourceIds.length > 0) return sqlFragment`AND ${column} = ANY(${opts.sourceIds}::text[])`;
  if (opts?.sourceId) return sqlFragment`AND ${column} = ${opts.sourceId}`;
  return sqlFragment``;
}

export async function traverseGraph(
  exec: LegacyUnscopedRead,
    slug: string,
    depth: number = 5,
    opts?: TraverseGraphOpts,
  ): Promise<GraphNode[]> {
    const privacy = (page: string, link?: string) => opts?.excludePrivate
      ? trustedSql(`AND ${privatePagesFilterFragment(page)}${link ? ` AND ${privateLinkOriginFilterFragment(link)}` : ''}`) : sqlFragment``;
    // v0.34.1 (#861 — P0 leak seal): visited pages are scoped to the caller's
    // source(s) at the seed and at every step, and the per-node `links`
    // aggregation only includes edges to in-scope pages.
    // T8 (v0.36+): `frontierCap` bounds the new pages each BFS layer adds,
    // chosen in (slug, id) order.
    const rows = (await exec.run(sqlFragment`
      WITH RECURSIVE ${bfsWalkCtes({
        seed: sqlFragment`p.slug = ${slug} AND p.deleted_at IS NULL ${privacy('p')} ${sourceScope('p', opts)}`,
        maxLayer: depth,
        direction: 'out',
        step: sqlFragment`p2.deleted_at IS NULL ${privacy('p2', 'l')} ${sourceScope('p2', opts)} ${temporalWalkFilter('l', opts)}`,
        layerCap: opts?.frontierCap,
      })}
      SELECT g.slug, g.source_id, g.title, g.type, g.depth,
        coalesce(
          -- jsonb_agg(DISTINCT ...) collapses duplicate (to_slug, link_type)
          -- edges that originate from different provenance (markdown body
          -- vs frontmatter vs auto-extracted). The underlying links table
          -- preserves every row with its origin_page_id / link_source —
          -- the dedup is presentation-only for the legacy traverseGraph
          -- aggregation. See plan Bug 6/10.
          (SELECT jsonb_agg(DISTINCT jsonb_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
           FROM links l2
           JOIN pages p3 ON p3.id = l2.to_page_id
           WHERE l2.from_page_id = g.id AND p3.deleted_at IS NULL ${privacy('p3', 'l2')} ${sourceScope('p3', opts)} ${temporalWalkFilter('l2', opts)}),
          '[]'::jsonb
        ) as links
      FROM (SELECT p.id, p.slug, p.source_id, p.title, p.type, w.depth
            FROM walk w JOIN pages p ON p.id = w.id
            WHERE w.pos <= ${TRAVERSE_WALK_ROW_CAP}::int) g
      ORDER BY g.depth, g.slug, g.source_id
    `)).rows;

    return rows.map((r: Record<string, unknown>) => ({
      slug: r.slug as string,
      source_id: r.source_id as string,
      title: r.title as string,
      type: r.type as string,
      depth: Number(r.depth),
      links: (typeof r.links === 'string' ? JSON.parse(r.links) : r.links) as { to_slug: string; link_type: string }[],
    }));
  }


export async function traversePathsDetailed(
  exec: LegacyUnscopedRead,
    slug: string,
    opts?: LinkReadScope & { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' },
  ): Promise<{ paths: GraphPath[]; truncated: boolean }> {
    const privacy = (page: string, link?: string) => opts?.excludePrivate
      ? trustedSql(`AND ${privatePagesFilterFragment(page)}${link ? ` AND ${privateLinkOriginFilterFragment(link)}` : ''}`) : sqlFragment``;
    const depth = opts?.depth ?? 5;
    const direction = opts?.direction ?? 'out';
    const linkType = opts?.linkType ?? null;
    const linkTypeFilter = linkType !== null ? sqlFragment`AND l.link_type = ${linkType}` : sqlFragment``;
    // v0.34.1 (#861 — P0 leak seal) and #3754: source scope, soft delete,
    // privacy, link type and temporal policy apply at the seed, at every BFS
    // step and on both endpoints of every returned edge, so an out-of-scope,
    // private or deleted page neither anchors, relays nor terminates a path.
    // The walk visits pages at depth < `depth`; each qualifying edge is
    // returned once, at one past the depth of its shallower visited endpoint
    // on the walked side ('both' counts either endpoint).
    const walk = bfsWalkCtes({
      seed: sqlFragment`p.slug = ${slug} AND p.deleted_at IS NULL ${privacy('p')} ${sourceScope('p', opts)}`,
      maxLayer: depth - 1,
      direction,
      step: sqlFragment`p2.deleted_at IS NULL ${privacy('p2', 'l')} ${linkTypeFilter} ${temporalWalkFilter('l', opts)} ${sourceScope('p2', opts)}`,
    });
    const visited = sqlFragment`nodes AS (SELECT p.id, p.slug, p.source_id, w.depth FROM walk w JOIN pages p ON p.id = w.id WHERE w.pos <= ${TRAVERSE_WALK_ROW_CAP}::int)`;
    const walkTruncated = sqlFragment`(SELECT count(*) FROM walk) > ${TRAVERSE_WALK_ROW_CAP}::int AS walk_truncated`;
    const edges = direction === 'out'
      ? sqlFragment`w.id as from_id, w.slug as from_slug, w.source_id as from_source_id,
               p2.id as to_id, p2.slug as to_slug, p2.source_id as to_source_id,
               l.link_type, l.context, w.depth + 1 as depth
        FROM nodes w
        JOIN links l ON l.from_page_id = w.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE w.depth < ${depth}
          AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
          ${linkTypeFilter} ${temporalWalkFilter('l', opts)}
          ${sourceScope('p2', opts)}`
      : direction === 'in'
        ? sqlFragment`p2.id as from_id, p2.slug as from_slug, p2.source_id as from_source_id,
               w.id as to_id, w.slug as to_slug, w.source_id as to_source_id,
               l.link_type, l.context, w.depth + 1 as depth
        FROM nodes w
        JOIN links l ON l.to_page_id = w.id
        JOIN pages p2 ON p2.id = l.from_page_id
        WHERE w.depth < ${depth}
          AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
          ${linkTypeFilter} ${temporalWalkFilter('l', opts)}
          ${sourceScope('p2', opts)}`
        : sqlFragment`pf.id as from_id, pf.slug as from_slug, pf.source_id as from_source_id,
               pt.id as to_id, pt.slug as to_slug, pt.source_id as to_source_id,
               l.link_type, l.context, e.depth + 1 as depth
        FROM (
          SELECT l.id AS link_id, wf.depth FROM nodes wf
          JOIN links l ON l.from_page_id = wf.id
          LEFT JOIN nodes wt ON wt.id = l.to_page_id
          WHERE wt.id IS NULL OR wf.depth <= wt.depth
          UNION ALL
          SELECT l.id, wt.depth FROM nodes wt
          JOIN links l ON l.to_page_id = wt.id
          LEFT JOIN nodes wf ON wf.id = l.from_page_id
          WHERE wf.id IS NULL OR wt.depth < wf.depth
        ) e
        JOIN links l ON l.id = e.link_id
        JOIN pages pf ON pf.id = l.from_page_id
        JOIN pages pt ON pt.id = l.to_page_id
        WHERE e.depth < ${depth}
          AND pf.deleted_at IS NULL ${privacy('pf', 'l')}
          AND pt.deleted_at IS NULL ${privacy('pt')}
          ${linkTypeFilter} ${temporalWalkFilter('l', opts)}
          ${sourceScope('pf', opts)}
          ${sourceScope('pt', opts)}`;
    const rows = (await exec.run(sqlFragment`
      WITH RECURSIVE ${walk}, ${visited}
      SELECT ${walkTruncated}, ${edges}
      ORDER BY depth, from_slug, to_slug, from_source_id, to_source_id
      LIMIT ${TRAVERSE_PATH_ROW_CAP + 1}
    `)).rows;

    // Row cap: the LIMIT above fetched CAP + 1 rows; the probe row only tells
    // us the walk overflowed and is dropped with everything past the cap.
    const truncated = rows.length > TRAVERSE_PATH_ROW_CAP || (rows as Array<{ walk_truncated?: boolean }>).some((r) => r.walk_truncated === true);
    const bounded = (truncated ? rows.slice(0, TRAVERSE_PATH_ROW_CAP) : rows) as Record<string, unknown>[];
    // Duplicate link rows (same edge, different provenance) collapse here.
    // Keyed on page ids, so the same slug in two sources stays two edges.
    const seen = new Set<string>();
    const result: GraphPath[] = [];
    for (const r of bounded) {
      const key = `${r.from_id}|${r.to_id}|${r.link_type}|${r.depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        from_slug: r.from_slug as string,
        from_source_id: r.from_source_id as string,
        to_slug: r.to_slug as string,
        to_source_id: r.to_source_id as string,
        link_type: r.link_type as string,
        context: (r.context as string) || '',
        depth: Number(r.depth),
      });
    }
    return { paths: result, truncated };
  }
