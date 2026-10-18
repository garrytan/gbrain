import type { PageReadScope, PageReadPolicy, AdjacencyRow, RelationalFanoutOpts, RelationalFanoutRow, ChainHopOpts, ChainHopEdge } from '../types.ts';
import { unverifiedExtractionFragment } from '../extraction-review.ts';
import { chunkGenerationProbe, currentTextProjectionFilter, protectedBodyFilter, requiresSafeChunks, safeChunksFilter } from './safe-chunks.ts';
import { hasReadPolicy, pageReadFilter } from './read-policy-sql.ts';
import { relationshipFilterSql } from '../link-validity.ts';
import { rankingLinkSql } from '../link-ranking-policy.ts';

/** Narrow query dependency shared by both engines. */
export type ReadQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
type PageRef = { slug: string; source_id: string };

function originFilter(scope: PageReadScope | undefined, params: unknown[]): string {
  if (!scope) return 'TRUE';
  const filter = pageReadFilter('origin', scope, params, true);
  return `(l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages origin WHERE origin.id = l.origin_page_id AND ${filter}))`;
}

/** Authorize graph seeds, hops and edge origins before ranking or emitting paths. */
export async function readRelationalFanout(query: ReadQuery, seeds: string[], opts?: RelationalFanoutOpts, chunkManifest = true): Promise<RelationalFanoutRow[]> {
  if (!seeds?.length) return [];
  const depth = Math.min(Math.max(1, opts?.depth ?? 2), 3);
  const direction = opts?.direction ?? 'both';
  const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
  const params: unknown[] = [seeds, depth, limit];
  const policy = hasReadPolicy(opts) ? opts : undefined;
  const seed = pageReadFilter('p', policy, params, !!policy);
  const step = pageReadFilter('p2', policy, params, !!policy);
  const origin = originFilter(policy, params);
  let seedIdentities = '';
  if (opts?.seedRefs !== undefined) {
    params.push(opts.seedRefs.map(ref => ref.source_id), opts.seedRefs.map(ref => ref.slug));
    seedIdentities = `AND (p.source_id, p.slug) IN (SELECT * FROM unnest($${params.length - 1}::text[], $${params.length}::text[]))`;
  }
  let typeFilter = '';
  if (opts?.linkTypes?.length) {
    params.push(opts.linkTypes);
    typeFilter = `AND l.link_type = ANY($${params.length}::text[])`;
  }
  const mentionsFilter = opts?.includeMentions ? '' : `AND l.link_source IS DISTINCT FROM 'mentions'`;
  const edgeExpr = direction === 'out'
    ? `w.slug || '|' || l.link_type || '|' || p2.slug`
    : direction === 'in'
      ? `p2.slug || '|' || l.link_type || '|' || w.slug`
      : `CASE WHEN l.from_page_id = w.id THEN w.slug || '|' || l.link_type || '|' || p2.slug
              ELSE p2.slug || '|' || l.link_type || '|' || w.slug END`;
  const temporalFilter = opts?.temporal ? `AND ${relationshipFilterSql('l', { ...opts.temporal, excludePrivate: opts.excludePrivate })}` : '';
  const recurStep = direction === 'out'
    ? 'JOIN links l ON l.from_page_id = w.id JOIN pages p2 ON p2.id = l.to_page_id'
    : direction === 'in'
      ? 'JOIN links l ON l.to_page_id = w.id JOIN pages p2 ON p2.id = l.from_page_id'
      : `JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
         JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END`;
  const rows = await query<Record<string, unknown>>(`
    WITH RECURSIVE walk AS (
      SELECT p.id, p.slug, p.source_id, 0::int AS depth,
        ARRAY[p.id] AS visited, ARRAY[p.slug] AS path,
        p.source_id AS seed_source, NULL::text AS last_link_type, ARRAY[]::text[] AS edges
      FROM pages p WHERE p.slug = ANY($1::text[]) AND p.deleted_at IS NULL AND ${seed} ${seedIdentities}
      UNION ALL
      SELECT p2.id, p2.slug, p2.source_id, w.depth + 1,
        w.visited || p2.id, w.path || p2.slug, w.seed_source, l.link_type, w.edges || (${edgeExpr})
      FROM walk w ${recurStep}
      WHERE w.depth < $2 AND NOT (p2.id = ANY(w.visited))
        AND p2.source_id = w.seed_source AND p2.deleted_at IS NULL
        AND ${step} AND ${origin} AND ${rankingLinkSql('l')} ${mentionsFilter} ${typeFilter} ${temporalFilter}
    )
    SELECT n.source_id, n.slug, MIN(n.depth) AS hop,
      COUNT(DISTINCT n.last_link_type) AS edge_count,
      array_agg(DISTINCT n.last_link_type) FILTER (WHERE n.last_link_type IS NOT NULL) AS via_link_types,
      (array_agg(array_to_string(n.path, chr(9)) ORDER BY n.depth ASC,
        array_length(n.path, 1) ASC, array_to_string(n.path, chr(9)) ASC))[1] AS path_str,
      (array_agg(array_to_string(n.edges, chr(9)) ORDER BY n.depth ASC,
        array_length(n.path, 1) ASC, array_to_string(n.path, chr(9)) ASC))[1] AS edges_str,
      (SELECT cc.id FROM content_chunks cc WHERE cc.page_id = n.id AND ${chunkGenerationProbe('cc', chunkManifest)}
        ${requiresSafeChunks(opts) ? `AND EXISTS (SELECT 1 FROM pages cp WHERE cp.id = n.id AND ${safeChunksFilter('cp')})` : ''}
        ORDER BY cc.chunk_index ASC LIMIT 1) AS canonical_chunk_id
    FROM walk n WHERE n.depth > 0 GROUP BY n.source_id, n.slug, n.id
    ORDER BY hop ASC, edge_count DESC, n.source_id ASC, n.slug ASC LIMIT $3`, params);
  return rows.map(row => ({
    source_id: row.source_id as string, slug: row.slug as string,
    hop: Number(row.hop), edge_count: Number(row.edge_count),
    via_link_types: Array.isArray(row.via_link_types) ? row.via_link_types as string[] : [],
    path: row.path_str ? String(row.path_str).split('\t') : [],
    path_edges: row.edges_str ? String(row.edges_str).split('\t') : [],
    canonical_chunk_id: row.canonical_chunk_id == null ? null : Number(row.canonical_chunk_id),
  }));
}

/**
 * Degree used for hub weighting saturates here: a node with at least this many
 * readable typed link rows counts as this degree (its hub weight is already
 * ~0.01). Below saturation the degree is the number of distinct neighbors the
 * caller may read. Rows to unreadable neighbors, or written on unreadable
 * origin pages, never count.
 */
export const CHAIN_DEGREE_SATURATION = 300;

/** Integer ids inlined into SQL (never bound): see readAdjacencyBoosts for the generic-plan reason. */
function inlineIds(ids: number[], label: string): string {
  return `ARRAY[${ids.map(id => {
    if (!Number.isSafeInteger(id)) throw new TypeError(`${label}: page id ${String(id)} is not an integer`);
    return id;
  }).join(',')}]::int[]`;
}

/**
 * One oriented, authorized, bounded expansion step of a relational chain.
 *
 * Orientation: canonical provenance rows (frontmatter, manual, oriented
 * attendance) keep stored direction; body-extracted rows are read by the
 * relation's type signature: forward fit = stored, reverse fit = flipped,
 * both = uncertain (stored direction), neither = not a hop. Every endpoint,
 * origin and degree contributor passes the read policy (and, with `temporal`,
 * the relationship-validity predicate) before anything is returned; edge context is returned only when the evidence page's text is
 * readable under the policy.
 */
export async function readChainHop(query: ReadQuery, frontier: number[], opts: ChainHopOpts, chunkManifest = true): Promise<ChainHopEdge[]> {
  if (!frontier.length || !opts.linkTypes.length) return [];
  const ids = inlineIds([...new Set(frontier)], 'readChainHop');
  // Pages are fetched by primary key behind an optimization fence: the read
  // policy's archived-source EXISTS otherwise lets a statistics-less planner
  // (PGLite) scan every page of a source per link row.
  const byId = (idExpr: string) => `(SELECT * FROM pages WHERE id = ${idExpr} OFFSET 0)`;
  const policy: PageReadPolicy = opts;
  const params: unknown[] = [opts.linkTypes, opts.subjectTypes, opts.objectTypes, opts.degreeLinkTypes, Math.max(1, Math.min(opts.neighborCap, 1000))];
  const branch = (frontierCol: 'from_page_id' | 'to_page_id', a: string) => {
    const pf = pageReadFilter(`${a}f`, policy, params, true);
    const pt = pageReadFilter(`${a}t`, policy, params, true);
    const og = pageReadFilter(`${a}g`, policy, params, true);
    const origin = `(${a}l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM ${byId(`${a}l.origin_page_id`)} ${a}g WHERE ${og}))`;
    const live = opts.temporal ? `AND ${relationshipFilterSql(`${a}l`, { ...opts.temporal, excludePrivate: opts.excludePrivate })}` : '';
    return `SELECT f.id AS fid, ${a}l.id AS lid, ${a}l.link_type, ${a}l.from_page_id, ${a}l.to_page_id, ${a}l.origin_page_id,
        ${a}l.link_source, ${a}f.type AS from_type, ${a}t.type AS to_type, ${a}f.source_id
      FROM f CROSS JOIN LATERAL (
        SELECT x.* FROM links x WHERE x.${frontierCol} = f.id AND x.link_type = ANY($1::text[])
          AND x.from_page_id <> x.to_page_id AND x.link_source IS DISTINCT FROM 'mentions' AND ${rankingLinkSql('x')}
        OFFSET 0
      ) ${a}l
      CROSS JOIN LATERAL ${byId(`${a}l.from_page_id`)} ${a}f
      CROSS JOIN LATERAL ${byId(`${a}l.to_page_id`)} ${a}t
      WHERE ${a}f.source_id = ${a}t.source_id AND ${pf} AND ${pt} AND ${origin} ${live}`;
  };
  // The LATERAL link scan is fenced the same way, so the walk always starts
  // from the frontier's links.
  const outBranch = branch('from_page_id', 'o');
  const inBranch = branch('to_page_id', 'i');
  const nb = pageReadFilter('nb', policy, params, true);
  const dg = pageReadFilter('dg', policy, params, true);
  const degreeLive = opts.temporal ? `AND ${relationshipFilterSql('dl', { ...opts.temporal, excludePrivate: opts.excludePrivate })}` : '';
  const ev = pageReadFilter('ev', policy, params, true);
  const textGate = requiresSafeChunks(policy) ? `AND ${safeChunksFilter('ev')} AND NOT ${protectedBodyFilter('ev')}` : '';
  params.push(opts.toward);
  const toward = `$${params.length}`;
  const rows = await query<Record<string, unknown>>(`
    WITH f AS (SELECT DISTINCT unnest(${ids}) AS id),
    cand AS (${outBranch} UNION ${inBranch}),
    classified AS (
      SELECT c.*, CASE
          WHEN c.link_source IN ('frontmatter', 'manual') OR (c.link_type = 'attended' AND c.origin_page_id IS NOT NULL)
            THEN CASE WHEN c.from_type = ANY($2::text[]) AND c.to_type = ANY($3::text[]) THEN 'canonical' END
          WHEN c.from_type = ANY($2::text[]) AND c.to_type = ANY($3::text[])
            AND c.to_type = ANY($2::text[]) AND c.from_type = ANY($3::text[]) THEN 'uncertain'
          WHEN c.from_type = ANY($2::text[]) AND c.to_type = ANY($3::text[]) THEN 'stored'
          WHEN c.to_type = ANY($2::text[]) AND c.from_type = ANY($3::text[]) THEN 'flipped'
        END AS orientation
      FROM cand c
    ),
    semantic AS (
      SELECT k.*,
        CASE WHEN k.orientation = 'flipped' THEN k.to_page_id ELSE k.from_page_id END AS subject_id,
        CASE WHEN k.orientation = 'flipped' THEN k.from_page_id ELSE k.to_page_id END AS object_id
      FROM classified k WHERE k.orientation IS NOT NULL
    ),
    stepped AS (
      SELECT s.*, CASE WHEN ${toward} = 'object' THEN s.object_id ELSE s.subject_id END AS next_id,
        CASE s.orientation WHEN 'canonical' THEN 0 WHEN 'stored' THEN 1 WHEN 'flipped' THEN 2 ELSE 3 END AS orient_rank
      FROM semantic s
      WHERE (CASE WHEN ${toward} = 'object' THEN s.subject_id ELSE s.object_id END) = s.fid
    ),
    logical AS (
      SELECT fid, next_id, MIN(source_id) AS source_id, MIN(lid) AS min_lid,
        array_agg(lid ORDER BY lid) AS link_ids,
        (array_agg(lid ORDER BY orient_rank, lid))[1] AS evidence_lid,
        (array_agg(orientation ORDER BY orient_rank, lid))[1] AS orientation
      FROM stepped GROUP BY fid, next_id
    ),
    ranked AS (
      SELECT g.*, ROW_NUMBER() OVER (PARTITION BY g.fid ORDER BY g.min_lid) AS rn,
        COUNT(*) OVER (PARTITION BY g.fid) AS per_frontier
      FROM logical g
    ),
    deg_rows AS (
      SELECT f.id AS fid, d.nb_id FROM f CROSS JOIN LATERAL (
        SELECT dn.nb_id FROM (
          SELECT CASE WHEN dl.from_page_id = f.id THEN dl.to_page_id ELSE dl.from_page_id END AS nb_id, dl.id AS lid, dl.origin_page_id
          FROM links dl
          WHERE (dl.from_page_id = f.id OR dl.to_page_id = f.id) AND dl.from_page_id <> dl.to_page_id
            AND dl.link_type = ANY($4::text[]) AND dl.link_source IS DISTINCT FROM 'mentions' AND ${rankingLinkSql('dl')} ${degreeLive}
          OFFSET 0
        ) dn
        CROSS JOIN LATERAL ${byId('dn.nb_id')} nb
        WHERE ${nb} AND (dn.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM ${byId('dn.origin_page_id')} dg WHERE ${dg}))
        ORDER BY dn.lid LIMIT ${CHAIN_DEGREE_SATURATION}
      ) d
    ),
    deg AS (
      SELECT f.id AS fid, CASE
        WHEN (SELECT COUNT(*) FROM deg_rows r WHERE r.fid = f.id) >= ${CHAIN_DEGREE_SATURATION} THEN ${CHAIN_DEGREE_SATURATION}
        ELSE (SELECT COUNT(DISTINCT r.nb_id) FROM deg_rows r WHERE r.fid = f.id)
      END AS degree FROM f
    )
    SELECT r.fid, r.next_id, np.slug AS next_slug, np.type AS next_type, r.source_id, el.link_type, r.orientation,
      r.link_ids, sf.slug AS stored_from_slug, st.slug AS stored_to_slug,
      CASE WHEN ev.id IS NOT NULL ${textGate} THEN el.context END AS context,
      el.origin_page_id, op.slug AS origin_slug, deg.degree AS from_degree, (r.per_frontier > $5) AS cap_hit,
      (SELECT cc.id FROM content_chunks cc WHERE cc.page_id = r.next_id AND ${chunkGenerationProbe('cc', chunkManifest)}
        ${requiresSafeChunks(policy) ? `AND EXISTS (SELECT 1 FROM pages cp WHERE cp.id = r.next_id AND ${safeChunksFilter('cp')})` : ''}
        ORDER BY cc.chunk_index ASC LIMIT 1) AS canonical_chunk_id
    FROM ranked r
    JOIN pages np ON np.id = r.next_id
    JOIN links el ON el.id = r.evidence_lid
    JOIN pages sf ON sf.id = el.from_page_id
    JOIN pages st ON st.id = el.to_page_id
    LEFT JOIN pages op ON op.id = el.origin_page_id
    LEFT JOIN LATERAL (SELECT ev0.* FROM ${byId('COALESCE(el.origin_page_id, el.from_page_id)')} ev0) ev ON ${ev}
    JOIN deg ON deg.fid = r.fid
    WHERE r.rn <= $5
    ORDER BY r.fid ASC, r.min_lid ASC`, params);
  return rows.map(row => ({
    from_page_id: Number(row.fid), to_page_id: Number(row.next_id), to_slug: row.next_slug as string,
    to_type: row.next_type as string, source_id: row.source_id as string, link_type: row.link_type as string,
    orientation: row.orientation as ChainHopEdge['orientation'],
    link_ids: (Array.isArray(row.link_ids) ? row.link_ids : []).map(Number),
    stored_from_slug: row.stored_from_slug as string, stored_to_slug: row.stored_to_slug as string,
    context: row.context == null ? null : String(row.context),
    origin_page_id: row.origin_page_id == null ? null : Number(row.origin_page_id),
    origin_slug: row.origin_slug == null ? null : String(row.origin_slug),
    canonical_chunk_id: row.canonical_chunk_id == null ? null : Number(row.canonical_chunk_id),
    from_degree: Number(row.from_degree ?? 0), neighbor_cap_hit: row.cap_hit === true,
  }));
}

export async function readBacklinkCounts(query: ReadQuery, ids: number[], scope?: PageReadScope): Promise<Map<number, number>> {
  const result = new Map(ids.map(id => [id, 0]));
  if (!ids.length) return result;
  const params: unknown[] = [ids];
  const target = pageReadFilter('p', scope, params, !!scope);
  const contributor = pageReadFilter('contributor', scope, params, true);
  const origin = originFilter(scope, params);
  // Distinct linking pages, not link rows: duplicate edges (several link
  // types between one pair) and self-links would inflate the boost
  // (adjacency's COUNT(DISTINCT) shape). A policy additionally requires live,
  // authorized contributors; the trusted unscoped call counts every page.
  const rows = await query<{ page_id: number; cnt: number }>(`
    SELECT p.id AS page_id, COUNT(DISTINCT l.from_page_id)::int AS cnt
    FROM pages p LEFT JOIN links l ON l.to_page_id = p.id
      AND l.from_page_id <> p.id
      AND l.link_source IS DISTINCT FROM 'mentions' AND ${rankingLinkSql('l')}
      ${scope ? `AND EXISTS (SELECT 1 FROM pages contributor WHERE contributor.id = l.from_page_id AND ${contributor}) AND ${origin}` : ''}
    WHERE p.id = ANY($1::int[]) AND ${target} GROUP BY p.id`, params);
  for (const row of rows) result.set(Number(row.page_id), Number(row.cnt));
  return result;
}

export async function readAdjacencyBoosts(query: ReadQuery, ids: number[], scope?: PageReadScope): Promise<Map<number, AdjacencyRow>> {
  if (!ids.length) return new Map();
  // The candidate ids are inlined (integers only), never a bound parameter: once a
  // statement has run five times Postgres may reuse a generic plan, and without
  // planner statistics (PGLite) the generic plan of this read walks pages against
  // links (~7 s per search at 2k pages instead of ~45 ms).
  const idArray = `ARRAY[${ids.map(id => {
    if (!Number.isSafeInteger(id)) throw new TypeError(`readAdjacencyBoosts: page id ${String(id)} is not an integer`);
    return id;
  }).join(',')}]::int[]`;
  const params: unknown[] = [];
  const from = pageReadFilter('p', scope, params, !!scope);
  const to = pageReadFilter('t', scope, params, !!scope);
  const origin = originFilter(scope, params);
  const rows = await query<{ to_page_id: number; hits: number; cross_source_hits: number }>(`
    SELECT l.to_page_id, COUNT(DISTINCT l.from_page_id)::int AS hits,
      COUNT(DISTINCT CASE WHEN p.source_id <> t.source_id THEN p.source_id END)::int AS cross_source_hits
    FROM links l JOIN pages p ON p.id = l.from_page_id AND p.deleted_at IS NULL
      JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
    WHERE l.from_page_id = ANY(${idArray}) AND l.to_page_id = ANY(${idArray})
      AND ${from} AND ${to} AND ${origin} AND ${rankingLinkSql('l')}
    GROUP BY l.to_page_id HAVING COUNT(DISTINCT l.from_page_id) >= 1`, params);
  return new Map(rows.map(row => [Number(row.to_page_id), { hits: Number(row.hits), cross_source_hits: Number(row.cross_source_hits) }]));
}

export async function readContentFlags(query: ReadQuery, ids: number[], scope?: PageReadScope): Promise<Map<number, { reason: string; detail: string }>> {
  if (!ids.length) return new Map();
  const params: unknown[] = [ids];
  const filter = pageReadFilter('p', scope, params, !!scope);
  const rows = await query<{ id: number; reason: string | null; detail: string | null }>(`
    SELECT p.id, p.frontmatter->'content_flag'->>'reason' AS reason,
      p.frontmatter->'content_flag'->>'detail' AS detail FROM pages p
    WHERE p.id = ANY($1::int[]) AND p.frontmatter ? 'content_flag' AND ${filter}`, params);
  return new Map(rows.filter(row => row.reason).map(row => [Number(row.id), { reason: row.reason!, detail: row.detail ?? '' }]));
}

export async function readExtractionStates(query: ReadQuery, ids: number[], scope?: PageReadScope): Promise<Map<number, { unverified: boolean; status: string }>> {
  if (!ids.length) return new Map();
  const params: unknown[] = [ids];
  const filter = pageReadFilter('p', scope, params, !!scope);
  const rows = await query<{ id: number; status: string; unverified: boolean }>(`
    SELECT p.id, p.frontmatter->>'status' AS status, (${unverifiedExtractionFragment('p')}) AS unverified
    FROM pages p WHERE p.id = ANY($1::int[]) AND p.frontmatter->>'status' IS NOT NULL AND ${filter}`, params);
  return new Map(rows.map(row => [Number(row.id), { unverified: row.unverified === true, status: row.status }]));
}

export async function readEffectiveDates(query: ReadQuery, refs: PageRef[], scope?: PageReadScope): Promise<Map<string, Date>> {
  if (!refs.length) return new Map();
  const params: unknown[] = [refs.map(r => r.slug), refs.map(r => r.source_id)];
  const filter = pageReadFilter('p', scope, params, !!scope);
  const rows = await query<{ slug: string; source_id: string; ts: string | Date }>(`
    SELECT p.slug, p.source_id, COALESCE(p.effective_date, p.updated_at, p.created_at) AS ts
    FROM pages p JOIN unnest($1::text[], $2::text[]) AS u(slug, source_id)
      ON p.slug = u.slug AND p.source_id = u.source_id WHERE ${filter}`, params);
  return new Map(rows.map(row => [`${row.source_id}::${row.slug}`, row.ts instanceof Date ? row.ts : new Date(row.ts)]));
}

export async function readSalienceScores(query: ReadQuery, refs: PageRef[], scope?: PageReadPolicy): Promise<Map<string, number>> {
  if (!refs.length) return new Map();
  const params: unknown[] = [refs.map(r => r.slug), refs.map(r => r.source_id)];
  const filter = pageReadFilter('p', scope, params, !!scope);
  const restricted = scope?.takesHoldersAllowList !== undefined;
  let holder = '';
  if (restricted) {
    params.push(scope.takesHoldersAllowList);
    holder = `AND t.holder = ANY($${params.length}::text[])`;
  }
  const rows = await query<{ slug: string; source_id: string; score: number }>(`
    SELECT p.slug, p.source_id,
      (${restricted ? '0' : 'COALESCE(p.emotional_weight, 0) * 5'} + ln(1 + COUNT(DISTINCT t.id))) AS score
    FROM pages p JOIN unnest($1::text[], $2::text[]) AS u(slug, source_id)
      ON p.slug = u.slug AND p.source_id = u.source_id
    LEFT JOIN takes t ON t.page_id = p.id AND t.active = TRUE ${holder}
    WHERE ${filter} GROUP BY p.id`, params);
  return new Map(rows.map(row => [`${row.source_id}::${row.slug}`, Number(row.score)]));
}

/** Resolve alias contributors before callers rank or cap canonical pages. */
export async function readAliases(query: ReadQuery, aliases: string[], scope?: PageReadScope): Promise<Map<string, PageRef[]>> {
  const out = new Map<string, PageRef[]>();
  if (!aliases.length) return out;
  const params: unknown[] = [aliases];
  const aliasScope = pageReadFilter('m', scope && { sourceId: scope.sourceId, sourceIds: scope.sourceIds }, params);
  const filter = pageReadFilter('p', scope, params, true);
  const titleFilter = pageReadFilter('t', scope, params, true);
  // Alias matches first, then one unique-key page lookup each (OFFSET 0 keeps the
  // read filter out of that lookup): without planner statistics (PGLite has no
  // autovacuum) the page_aliases -> sources foreign key otherwise makes the planner
  // walk every readable page and probe aliases per page.
  // Precedence: within a source, only the claims at the best origin answer
  // (frontmatter > declared > subject), and a derived (declared or subject)
  // alias never answers for a name that is another live page's exact title
  // the caller can read (a private title a remote caller can't see must not
  // hide a readable alias),
  // so "Acme Example" stays the company page beside "CRM record: Acme Example".
  const rows = await query<PageRef & { alias_norm: string; rank: number }>(`
    WITH a AS MATERIALIZED (
      SELECT m.alias_norm, m.slug, m.source_id,
             CASE m.origin WHEN 'subject' THEN 2 WHEN 'declared' THEN 1 ELSE 0 END AS rank
      FROM page_aliases m
      WHERE m.alias_norm = ANY($1::text[]) AND ${aliasScope}
    )
    SELECT a.alias_norm, a.slug, a.source_id, a.rank FROM a
    CROSS JOIN LATERAL (SELECT * FROM pages WHERE source_id = a.source_id AND slug = a.slug OFFSET 0) p
    WHERE ${filter}
      AND (a.rank = 0 OR NOT EXISTS (SELECT 1 FROM pages t WHERE t.source_id = a.source_id AND ${titleFilter}
                                     AND lower(t.title) = a.alias_norm AND t.slug <> a.slug))
    ORDER BY a.alias_norm, a.source_id, a.rank, a.slug`, params);
  const best = new Map<string, number>();
  for (const row of rows) {
    const k = `${row.alias_norm}\0${row.source_id}`;
    best.set(k, Math.min(best.get(k) ?? Infinity, Number(row.rank)));
  }
  for (const row of rows) {
    if (Number(row.rank) > best.get(`${row.alias_norm}\0${row.source_id}`)!) continue;
    const refs = out.get(row.alias_norm) ?? [];
    if (!refs.some(ref => ref.slug === row.slug && ref.source_id === row.source_id)) refs.push({ slug: row.slug, source_id: row.source_id });
    out.set(row.alias_norm, refs);
  }
  return out;
}
