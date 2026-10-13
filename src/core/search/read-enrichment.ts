import type { PageReadScope, PageReadPolicy, AdjacencyRow, RelationalFanoutOpts, RelationalFanoutRow } from '../types.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { clampSearchLimit, type TakeHit } from '../engine.ts';
import type { PageVersion, Link } from '../types.ts';
import { privatePagesFilterFragment } from './private-visibility.ts';
import { currentMemoryTakeSql } from '../pmbrain-adapters/memory-projections';

export type ReadQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
type PageRef = { slug: string; source_id: string };

export async function readPageRefs(query: ReadQuery, slug: string, scope: PageReadScope): Promise<PageRef[]> {
  const params: unknown[] = [slug];
  const filter = pageReadFilter('p', scope, params, true);
  return query<PageRef>(`SELECT p.slug, p.source_id FROM pages p WHERE p.slug = $1 AND ${filter} ORDER BY p.source_id`, params);
}

export async function readLinks(query: ReadQuery, slug: string, incoming: boolean, scope: PageReadScope): Promise<Link[]> {
  const params: unknown[] = [slug];
  const from = pageReadFilter('f', scope, params, true);
  const to = pageReadFilter('t', scope, params, true);
  const origin = pageReadFilter('o', scope, params, true);
  return query<Link>(`SELECT f.slug AS from_slug, t.slug AS to_slug,
    f.source_id AS from_source_id, t.source_id AS to_source_id,
    l.link_type, l.context, l.link_source, l.resolution_type,
    o.slug AS origin_slug, o.source_id AS origin_source_id, l.origin_field
    FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
    LEFT JOIN pages o ON o.id = l.origin_page_id
    WHERE ${incoming ? 't' : 'f'}.slug = $1 AND ${from} AND ${to}
      AND (l.origin_page_id IS NULL OR (${origin}))`, params);
}

export async function readVersions(query: ReadQuery, slug: string, scope: PageReadScope): Promise<PageVersion[]> {
  const params: unknown[] = [slug];
  const filter = pageReadFilter('p', scope, params, true);
  return query<PageVersion>(`SELECT pv.* FROM page_versions pv JOIN pages p ON p.id = pv.page_id
    WHERE p.slug = $1 AND ${filter} ${scope.excludePrivate ? `AND ${privatePagesFilterFragment('pv')}` : ''}
    ORDER BY pv.snapshot_at DESC`, params);
}

export async function readTakes(query: ReadQuery, input: string | Float32Array, scope: PageReadPolicy & { limit?: number } = {}): Promise<TakeHit[]> {
  const vector = typeof input !== 'string';
  const params: unknown[] = [vector ? `[${Array.from(input).join(',')}]` : input, scope.takesHoldersAllowList ?? null, clampSearchLimit(scope.limit, 30, 100)];
  const filter = pageReadFilter('p', scope, params, true);
  return query<TakeHit>(`
    SELECT t.id AS take_id, t.page_id, p.source_id, p.slug AS page_slug, t.row_num,
      t.claim, t.kind, t.holder, t.weight,
      ${vector ? '(1 - (t.embedding <=> $1::vector))::real' : 'similarity(t.claim, $1)::real'} AS score
    FROM takes t JOIN pages p ON p.id = t.page_id
    WHERE t.active AND ${filter} AND ${currentMemoryTakeSql('t','p')}
      AND ${vector ? 't.embedding IS NOT NULL' : 't.claim % $1'}
      AND ($2::text[] IS NULL OR t.holder = ANY($2::text[]))
    ORDER BY ${vector ? 't.embedding <=> $1::vector' : 'score DESC, t.weight DESC'}
    LIMIT $3`, params);
}

function originFilter(scope: PageReadScope | undefined, params: unknown[]): string {
  if (!scope) return 'TRUE';
  const filter = pageReadFilter('origin', scope, params, true);
  return `(l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages origin WHERE origin.id = l.origin_page_id AND ${filter}))`;
}

export async function readBacklinkCounts(query: ReadQuery, ids: number[], scope?: PageReadScope): Promise<Map<number, number>> {
  const result = new Map(ids.map(id => [id, 0]));
  if (!ids.length) return result;
  const params: unknown[] = [ids];
  const target = pageReadFilter('p', scope, params, !!scope);
  const contributor = pageReadFilter('contributor', scope, params, true);
  const origin = originFilter(scope, params);
  const rows = await query<{ page_id: number; cnt: number }>(`
    SELECT p.id AS page_id, COUNT(l.id)::int AS cnt
    FROM pages p LEFT JOIN links l ON l.to_page_id = p.id
      AND l.link_source IS DISTINCT FROM 'mentions'
      ${scope ? `AND EXISTS (SELECT 1 FROM pages contributor WHERE contributor.id = l.from_page_id AND ${contributor}) AND ${origin}` : ''}
    WHERE p.id = ANY($1::int[]) AND ${target} GROUP BY p.id`, params);
  for (const row of rows) result.set(Number(row.page_id), Number(row.cnt));
  return result;
}

export async function readAdjacencyBoosts(query: ReadQuery, ids: number[], scope?: PageReadScope): Promise<Map<number, AdjacencyRow>> {
  if (!ids.length) return new Map();
  const params: unknown[] = [ids];
  const from = pageReadFilter('p', scope, params, !!scope);
  const to = pageReadFilter('t', scope, params, !!scope);
  const origin = originFilter(scope, params);
  const rows = await query<{ to_page_id: number; hits: number; cross_source_hits: number }>(`
    SELECT l.to_page_id, COUNT(DISTINCT l.from_page_id)::int AS hits,
      COUNT(DISTINCT CASE WHEN p.source_id <> t.source_id THEN p.source_id END)::int AS cross_source_hits
    FROM links l JOIN pages p ON p.id = l.from_page_id AND p.deleted_at IS NULL
      JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
    WHERE l.from_page_id = ANY($1::int[]) AND l.to_page_id = ANY($1::int[])
      AND ${from} AND ${to} AND ${origin}
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

export async function readAliases(query: ReadQuery, aliases: string[], scope?: PageReadScope): Promise<Map<string, PageRef[]>> {
  const out = new Map<string, PageRef[]>();
  if (!aliases.length) return out;
  const params: unknown[] = [aliases];
  const filter = pageReadFilter('p', scope, params, true);
  const rows = await query<PageRef & { alias_norm: string }>(`
    SELECT a.alias_norm, a.slug, a.source_id FROM page_aliases a
    JOIN pages p ON p.source_id = a.source_id AND p.slug = a.slug
    WHERE a.alias_norm = ANY($1::text[]) AND ${filter}
    ORDER BY a.alias_norm, a.source_id, a.slug`, params);
  for (const row of rows) {
    const refs = out.get(row.alias_norm) ?? [];
    if (!refs.some(ref => ref.slug === row.slug && ref.source_id === row.source_id)) refs.push({ slug: row.slug, source_id: row.source_id });
    out.set(row.alias_norm, refs);
  }
  return out;
}

export async function readRelationalFanout(query: ReadQuery, seeds: string[], opts?: RelationalFanoutOpts): Promise<RelationalFanoutRow[]> {
  if (!seeds?.length) return [];
  const depth = Math.min(Math.max(1, opts?.depth ?? 2), 3);
  const direction = opts?.direction ?? 'both';
  const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
  const params: unknown[] = [seeds, depth, limit];
  const policy = opts;
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
        p.source_id AS seed_source, NULL::text AS last_link_type
      FROM pages p WHERE p.slug = ANY($1::text[]) AND p.deleted_at IS NULL AND ${seed} ${seedIdentities}
      UNION ALL
      SELECT p2.id, p2.slug, p2.source_id, w.depth + 1,
        w.visited || p2.id, w.path || p2.slug, w.seed_source, l.link_type
      FROM walk w ${recurStep}
      WHERE w.depth < $2 AND NOT (p2.id = ANY(w.visited))
        AND p2.source_id = w.seed_source AND p2.deleted_at IS NULL
        AND ${step} AND ${origin} ${mentionsFilter} ${typeFilter}
    )
    SELECT n.source_id, n.slug, MIN(n.depth) AS hop,
      COUNT(DISTINCT n.last_link_type) AS edge_count,
      array_agg(DISTINCT n.last_link_type) FILTER (WHERE n.last_link_type IS NOT NULL) AS via_link_types,
      (array_agg(array_to_string(n.path, chr(9)) ORDER BY n.depth ASC,
        array_length(n.path, 1) ASC, array_to_string(n.path, chr(9)) ASC))[1] AS path_str,
      (SELECT cc.id FROM content_chunks cc WHERE cc.page_id = n.id

        ORDER BY cc.chunk_index ASC LIMIT 1) AS canonical_chunk_id
    FROM walk n WHERE n.depth > 0 GROUP BY n.source_id, n.slug, n.id
    ORDER BY hop ASC, edge_count DESC, n.source_id ASC, n.slug ASC LIMIT $3`, params);
  return rows.map(row => ({
    source_id: row.source_id as string, slug: row.slug as string,
    hop: Number(row.hop), edge_count: Number(row.edge_count),
    via_link_types: Array.isArray(row.via_link_types) ? row.via_link_types as string[] : [],
    path: row.path_str ? String(row.path_str).split('\t') : [],
    canonical_chunk_id: row.canonical_chunk_id == null ? null : Number(row.canonical_chunk_id),
  }));
}
