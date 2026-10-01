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
import { sqlFragment, trustedSql } from './fragment.ts';

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
        endpoint_state.to_id IS NOT NULL AS to_exists
      FROM endpoint_state
    `)).rows;
    if (!result?.from_exists) throw new PageMissingError('addLink', 'from', from, fromSrc);
    if (!result.to_exists) throw new PageMissingError('addLink', 'to', to, toSrc);
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
    const result = await executeRawJsonb(
      exec,
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, link_kind, origin_page_id, origin_field)
       SELECT f.id, t.id, v.link_type, v.context, v.link_source, v.link_kind, o.id, v.origin_field
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(
         from_slug text, to_slug text, link_type text, context text, link_source text,
         origin_slug text, origin_field text, from_source_id text, to_source_id text,
         origin_source_id text, link_kind text
       )
       JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
       JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
       LEFT JOIN pages o ON o.slug = v.origin_slug AND o.source_id = v.origin_source_id
       ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO NOTHING
       RETURNING 1`,
      [],
      [{ rows }],
    );
    return result.length;
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
       RETURNING 1`,
      [opts.linkSource],
      [payload],
    );
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
        RETURNING 1
      `)).rows;
      return rows.length;
    } else if (linkType !== undefined) {
      const rows = (await exec.run(sqlFragment`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
          AND link_type = ${linkType}
        RETURNING 1
      `)).rows;
      return rows.length;
    } else if (linkSource !== undefined) {
      const rows = (await exec.run(sqlFragment`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
          AND link_source IS NOT DISTINCT FROM ${linkSource}
        RETURNING 1
      `)).rows;
      return rows.length;
    } else {
      const rows = (await exec.run(sqlFragment`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
        RETURNING 1
      `)).rows;
      return rows.length;
    }
  }


export async function getLinks(exec: ScopedRead, slug: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean }): Promise<Link[]> {
    const privacy = opts?.excludePrivate ? `AND ${privatePagesFilterFragment('f')} AND ${privatePagesFilterFragment('t')} AND ${privateLinkOriginFilterFragment('l')}` : '';
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
                 l.origin_field
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY(${ids}::text[])
          WHERE f.slug = ${slug} AND f.source_id = ANY(${ids}::text[]) AND t.source_id = ANY(${ids}::text[])
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
          ORDER BY l.id
        `)).rows;
        return rows as unknown as Link[];
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
                 l.origin_field
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id
          WHERE f.slug = ${slug} AND f.source_id = ${opts.sourceId}
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
          ORDER BY l.id
        `)).rows;
        return rows as unknown as Link[];
      }
      const rows = (await exec.run(sqlFragment`
        SELECT f.slug as from_slug, f.source_id as from_source_id,
               t.slug as to_slug, t.source_id as to_source_id,
               l.link_type, l.context, l.link_source,
               o.slug as origin_slug, o.source_id as origin_source_id,
               l.origin_field
        FROM links l
        JOIN pages f ON f.id = l.from_page_id
        JOIN pages t ON t.id = l.to_page_id
        LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE f.slug = ${slug}
          AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
        ORDER BY l.id
      `)).rows;
      return rows as unknown as Link[];
  }


export async function getBacklinks(exec: ScopedRead, slug: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean }): Promise<Link[]> {
    const privacy = opts?.excludePrivate ? `AND ${privatePagesFilterFragment('f')} AND ${privatePagesFilterFragment('t')} AND ${privateLinkOriginFilterFragment('l')}` : '';
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
                 l.origin_field
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY(${ids}::text[])
          WHERE t.slug = ${slug} AND t.source_id = ANY(${ids}::text[]) AND f.source_id = ANY(${ids}::text[])
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
          ORDER BY l.id
        `)).rows;
        return rows as unknown as Link[];
      }
      // v0.31.8 (D16) + #2200: federated arm above is first; two below mirror getLinks
      // (incl. the #3754 soft-delete endpoint filter on all three arms).
      if (opts?.sourceId) {
        const rows = (await exec.run(sqlFragment`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id
          WHERE t.slug = ${slug} AND t.source_id = ${opts.sourceId}
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
          ORDER BY l.id
        `)).rows;
        return rows as unknown as Link[];
      }
      const rows = (await exec.run(sqlFragment`
        SELECT f.slug as from_slug, f.source_id as from_source_id,
               t.slug as to_slug, t.source_id as to_source_id,
               l.link_type, l.context, l.link_source,
               o.slug as origin_slug, o.source_id as origin_source_id,
               l.origin_field
        FROM links l
        JOIN pages f ON f.id = l.from_page_id
        JOIN pages t ON t.id = l.to_page_id
        LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE t.slug = ${slug}
          AND f.deleted_at IS NULL AND t.deleted_at IS NULL ${trustedSql(privacy)}
        ORDER BY l.id
      `)).rows;
      return rows as unknown as Link[];
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
  }): Promise<Array<{ slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean }>> {
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
        (NOT ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}) AS quarantined
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
    return rows as unknown as Array<{ slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean }>;
  }


export async function traverseGraph(
  exec: LegacyUnscopedRead,
    slug: string,
    depth: number = 5,
    opts?: TraverseGraphOpts,
  ): Promise<GraphNode[]> {
    const privacy = (page: string, link?: string) => opts?.excludePrivate
      ? trustedSql(`AND ${privatePagesFilterFragment(page)}${link ? ` AND ${privateLinkOriginFilterFragment(link)}` : ''}`) : sqlFragment``;
    // v0.34.1 (#861 — P0 leak seal): scope visited nodes to the caller's
    // source(s). Without this, the walk follows edges into pages from
    // foreign sources, leaking topology + page metadata. The filter
    // applies at BOTH the seed (root must be in scope) AND the recursive
    // step (every visited neighbor must be in scope). The aggregation
    // subquery also filters so the per-node `links` array only includes
    // edges to in-scope pages.
    const useSourceIds = opts?.sourceIds && opts.sourceIds.length > 0;
    const seedScope = useSourceIds
      ? sqlFragment`AND p.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sqlFragment`AND p.source_id = ${opts.sourceId}`
        : sqlFragment``;
    const stepScope = useSourceIds
      ? sqlFragment`AND p2.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sqlFragment`AND p2.source_id = ${opts.sourceId}`
        : sqlFragment``;
    const aggScope = useSourceIds
      ? sqlFragment`AND p3.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sqlFragment`AND p3.source_id = ${opts.sourceId}`
        : sqlFragment``;
    // T8 (v0.36+): frontier cap. When set, the recursive term applies a
    // parenthesized LIMIT N with ORDER BY (slug, id) for stable selection.
    // Postgres' parenthesized-LIMIT inside a recursive term caps per
    // ITERATION, which maps approximately to per-BFS-LAYER (the mapping is
    // exact when fanout is bounded; for hub-fanout graphs the cap fires
    // early). Post-query, count rows per depth — if any depth == cap, fire
    // the truncation callback.
    const cap = opts?.frontierCap;
    const recursiveStep = cap !== undefined && cap > 0
      ? sqlFragment`(SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.visited || p2.id
             FROM graph g
             JOIN links l ON l.from_page_id = g.id
             JOIN pages p2 ON p2.id = l.to_page_id
             WHERE g.depth < ${depth}
               AND NOT (p2.id = ANY(g.visited))
               AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
               ${stepScope}
             ORDER BY p2.slug ASC, p2.id ASC
             LIMIT ${cap})`
      : sqlFragment`SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.visited || p2.id
            FROM graph g
            JOIN links l ON l.from_page_id = g.id
            JOIN pages p2 ON p2.id = l.to_page_id
            WHERE g.depth < ${depth}
              AND NOT (p2.id = ANY(g.visited))
              AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
              ${stepScope}`;
    // Cycle prevention: visited array tracks page IDs already in the path.
    const rows = (await exec.run(sqlFragment`
      WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth, ARRAY[p.id] as visited
        FROM pages p WHERE p.slug = ${slug} AND p.deleted_at IS NULL ${privacy('p')} ${seedScope}

        UNION ALL

        ${recursiveStep}
      )
      SELECT DISTINCT g.slug, g.title, g.type, g.depth,
        coalesce(
          -- jsonb_agg(DISTINCT ...) collapses duplicate (to_slug, link_type)
          -- edges that originate from different provenance (markdown body
          -- vs frontmatter vs auto-extracted). The underlying links table
          -- preserves every row with its origin_page_id / link_source —
          -- the dedup is presentation-only for the legacy traverseGraph
          -- aggregation. traversePaths has its own in-memory dedup at a
          -- different layer. See plan Bug 6/10.
          (SELECT jsonb_agg(DISTINCT jsonb_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
           FROM links l2
           JOIN pages p3 ON p3.id = l2.to_page_id
           WHERE l2.from_page_id = g.id AND p3.deleted_at IS NULL ${privacy('p3', 'l2')} ${aggScope}),
          '[]'::jsonb
        ) as links
      FROM (SELECT DISTINCT id, slug, title, type, depth
            FROM (SELECT id, slug, title, type, depth FROM graph LIMIT ${TRAVERSE_WALK_ROW_CAP}) capped) g
      ORDER BY g.depth, g.slug
    `)).rows;

    // T8 truncation-detection callback was designed here but the v1 algorithm
    // had both false-positive (organic count == cap) and false-negative
    // (LIMIT-before-DISTINCT in diamond graphs) cases caught by adversarial
    // review. Stripped pending the dedupe-then-cap SQL rewrite + real Postgres
    // parity coverage. See TODOS.md → "T8 truncation signal".

    return rows.map((r: Record<string, unknown>) => ({
      slug: r.slug as string,
      title: r.title as string,
      type: r.type as string,
      depth: r.depth as number,
      links: (typeof r.links === 'string' ? JSON.parse(r.links) : r.links) as { to_slug: string; link_type: string }[],
    }));
  }


export async function traversePathsDetailed(
  exec: LegacyUnscopedRead,
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both'; sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean },
  ): Promise<{ paths: GraphPath[]; truncated: boolean }> {
    const privacy = (page: string, link?: string) => opts?.excludePrivate
      ? trustedSql(`AND ${privatePagesFilterFragment(page)}${link ? ` AND ${privateLinkOriginFilterFragment(link)}` : ''}`) : sqlFragment``;
    const depth = opts?.depth ?? 5;
    const direction = opts?.direction ?? 'out';
    const linkType = opts?.linkType ?? null;
    const linkTypeMatches = linkType !== null;
    // v0.34.1 (#861 — P0 leak seal): source-scope filter fragments. Applied
    // at seed (root must be in scope) AND at every recursive step (neighbor
    // must be in scope) AND in the SELECT join (final edges respect scope).
    // The 'both' branch needs filters on BOTH endpoint joins.
    const useSourceIds = opts?.sourceIds && opts.sourceIds.length > 0;
    const seedScope = useSourceIds
      ? sqlFragment`AND p.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sqlFragment`AND p.source_id = ${opts.sourceId}`
        : sqlFragment``;
    const stepScope = useSourceIds
      ? sqlFragment`AND p2.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sqlFragment`AND p2.source_id = ${opts.sourceId}`
        : sqlFragment``;
    // For the 'both' direction's final SELECT, both endpoint joins (pf, pt)
    // get scope filters so edges crossing into a foreign source are dropped.
    const pfScope = useSourceIds
      ? sqlFragment`AND pf.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sqlFragment`AND pf.source_id = ${opts.sourceId}`
        : sqlFragment``;
    const ptScope = useSourceIds
      ? sqlFragment`AND pt.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sqlFragment`AND pt.source_id = ${opts.sourceId}`
        : sqlFragment``;

    // #3754: soft-deleted pages are excluded at seed, every recursive step, and
    // the final SELECT joins — a deleted page neither anchors, relays, nor
    // terminates a path (mirrors pglite-engine.traversePaths).
    let rows;
    if (direction === 'out') {
      rows = (await exec.run(sqlFragment`
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug} AND p.deleted_at IS NULL ${privacy('p')} ${seedScope}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.from_page_id = w.id
          JOIN pages p2 ON p2.id = l.to_page_id
          WHERE w.depth + 1 < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
            ${stepScope}
        ),
        capped AS (SELECT id, slug, depth FROM walk LIMIT ${TRAVERSE_WALK_ROW_CAP + 1}),
        nodes AS (SELECT DISTINCT id, slug, depth FROM capped)
        SELECT (SELECT count(*) FROM capped) > ${TRAVERSE_WALK_ROW_CAP} AS walk_truncated,
               w.slug as from_slug, p2.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM nodes w
        JOIN links l ON l.from_page_id = w.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE w.depth < ${depth}
          AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
          ${stepScope}
        ORDER BY depth, from_slug, to_slug
        LIMIT ${TRAVERSE_PATH_ROW_CAP + 1}
      `)).rows;
    } else if (direction === 'in') {
      rows = (await exec.run(sqlFragment`
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug} AND p.deleted_at IS NULL ${privacy('p')} ${seedScope}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.to_page_id = w.id
          JOIN pages p2 ON p2.id = l.from_page_id
          WHERE w.depth + 1 < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
            ${stepScope}
        ),
        capped AS (SELECT id, slug, depth FROM walk LIMIT ${TRAVERSE_WALK_ROW_CAP + 1}),
        nodes AS (SELECT DISTINCT id, slug, depth FROM capped)
        SELECT (SELECT count(*) FROM capped) > ${TRAVERSE_WALK_ROW_CAP} AS walk_truncated,
               p2.slug as from_slug, w.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM nodes w
        JOIN links l ON l.to_page_id = w.id
        JOIN pages p2 ON p2.id = l.from_page_id
        WHERE w.depth < ${depth}
          AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
          ${stepScope}
        ORDER BY depth, from_slug, to_slug
        LIMIT ${TRAVERSE_PATH_ROW_CAP + 1}
      `)).rows;
    } else {
      rows = (await exec.run(sqlFragment`
        WITH RECURSIVE walk AS (
          SELECT p.id, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug} AND p.deleted_at IS NULL ${privacy('p')} ${seedScope}
          UNION ALL
          SELECT p2.id, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
          JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END
          WHERE w.depth + 1 < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL ${privacy('p2', 'l')}
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
            ${stepScope}
        ),
        capped AS (SELECT id, depth FROM walk LIMIT ${TRAVERSE_WALK_ROW_CAP + 1}),
        nodes AS (SELECT DISTINCT id, depth FROM capped)
        SELECT (SELECT count(*) FROM capped) > ${TRAVERSE_WALK_ROW_CAP} AS walk_truncated,
               pf.slug as from_slug, pt.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM nodes w
        JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
        JOIN pages pf ON pf.id = l.from_page_id
        JOIN pages pt ON pt.id = l.to_page_id
        WHERE w.depth < ${depth}
          AND pf.deleted_at IS NULL ${privacy('pf', 'l')}
          AND pt.deleted_at IS NULL ${privacy('pt')}
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
          ${pfScope}
          ${ptScope}
        ORDER BY depth, from_slug, to_slug
        LIMIT ${TRAVERSE_PATH_ROW_CAP + 1}
      `)).rows;
    }

    // Row cap: the LIMIT above fetched CAP + 1 rows; the probe row only tells
    // us the walk overflowed and is dropped with everything past the cap.
    const truncated = rows.length > TRAVERSE_PATH_ROW_CAP || (rows as Array<{ walk_truncated?: boolean }>).some((r) => r.walk_truncated === true);
    const bounded = (truncated ? rows.slice(0, TRAVERSE_PATH_ROW_CAP) : rows) as Record<string, unknown>[];
    // Dedup edges (same edge can appear via multiple visited paths).
    const seen = new Set<string>();
    const result: GraphPath[] = [];
    for (const r of bounded) {
      const key = `${r.from_slug}|${r.to_slug}|${r.link_type}|${r.depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        from_slug: r.from_slug as string,
        to_slug: r.to_slug as string,
        link_type: r.link_type as string,
        context: (r.context as string) || '',
        depth: Number(r.depth),
      });
    }
    return { paths: result, truncated };
  }
