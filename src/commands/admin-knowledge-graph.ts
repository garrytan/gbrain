import type { BrainEngine } from '../core/engine.ts';
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphGlobalResponse,
  KnowledgeGraphMetaResponse,
  KnowledgeGraphMissingLinksResponse,
  KnowledgeGraphNeighborhoodResponse,
  KnowledgeGraphNode,
  KnowledgeGraphSearchResponse,
} from '../../shared/contracts/brain.ts';

export const ADMIN_KNOWLEDGE_GRAPH_NEIGHBOR_LIMIT = 30;
export const ADMIN_KNOWLEDGE_GRAPH_SEARCH_LIMIT = 12;
export const ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT = 10_000;
export const ADMIN_KNOWLEDGE_GRAPH_GLOBAL_EDGE_LIMIT = 25_000;
export const ADMIN_KNOWLEDGE_GRAPH_MISSING_LINK_LIMIT = 1_000;

type NodeRow = Omit<KnowledgeGraphNode, 'tags'>;

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value!)));
}

function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, index) => `$${start + index}`).join(', ');
}

async function loadKnowledgeGraphNodes(engine: BrainEngine, pageIds: number[]): Promise<KnowledgeGraphNode[]> {
  const ids = [...new Set(pageIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const idSql = placeholders(ids.length);
  const rows = await engine.executeRaw<NodeRow>(
    `SELECT p.id::int AS id,
            p.slug,
            COALESCE(NULLIF(p.title, ''), p.slug) AS title,
            p.source_id,
            s.name AS source_name,
            p.type,
            LEFT(COALESCE(p.compiled_truth, ''), 720) AS preview,
            p.updated_at::text AS updated_at,
            (SELECT COUNT(DISTINCT outgoing.to_page_id)::int
               FROM links outgoing
               JOIN pages target ON target.id = outgoing.to_page_id AND target.deleted_at IS NULL
              WHERE outgoing.from_page_id = p.id) AS outgoing_count,
            (SELECT COUNT(DISTINCT incoming.from_page_id)::int
               FROM links incoming
               JOIN pages source ON source.id = incoming.from_page_id AND source.deleted_at IS NULL
              WHERE incoming.to_page_id = p.id) AS incoming_count,
            (SELECT COUNT(*)::int
               FROM (
                 SELECT outgoing.to_page_id AS related_id
                   FROM links outgoing
                   JOIN pages target ON target.id = outgoing.to_page_id AND target.deleted_at IS NULL
                  WHERE outgoing.from_page_id = p.id
                 UNION
                 SELECT incoming.from_page_id AS related_id
                   FROM links incoming
                   JOIN pages source ON source.id = incoming.from_page_id AND source.deleted_at IS NULL
                  WHERE incoming.to_page_id = p.id
               ) related) AS relation_count
       FROM pages p
       JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NULL AND p.id IN (${idSql})`,
    ids,
  );
  const tagRows = await engine.executeRaw<{ page_id: number; tag: string }>(
    `SELECT page_id::int AS page_id, tag
       FROM tags
      WHERE page_id IN (${idSql})
      ORDER BY page_id, tag`,
    ids,
  );
  const tagsByPage = new Map<number, string[]>();
  for (const row of tagRows) {
    const tags = tagsByPage.get(row.page_id) ?? [];
    tags.push(row.tag);
    tagsByPage.set(row.page_id, tags);
  }
  const byId = new Map(rows.map(row => [row.id, { ...row, tags: tagsByPage.get(row.id) ?? [] }]));
  return ids.flatMap(id => {
    const node = byId.get(id);
    return node ? [node] : [];
  });
}

export async function getAdminKnowledgeGraphEdge(engine: BrainEngine, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid_edge_id');
  const edges = await engine.executeRaw<KnowledgeGraphEdge>(`SELECT l.id, l.from_page_id, l.to_page_id,
    l.link_type, l.context, l.link_source FROM links l
    JOIN pages f ON f.id=l.from_page_id AND f.deleted_at IS NULL
    JOIN pages t ON t.id=l.to_page_id AND t.deleted_at IS NULL WHERE l.id=$1`, [id]);
  const nodes = await loadKnowledgeGraphNodes(engine, edges.flatMap(edge => [edge.from_page_id, edge.to_page_id]));
  return { nodes, edges };
}

export async function searchAdminKnowledgeGraphPages(
  engine: BrainEngine,
  query: { query?: string; sourceId?: string; limit?: number },
): Promise<KnowledgeGraphSearchResponse> {
  const value = query.query?.trim() ?? '';
  if (!value) return { rows: [] };
  const limit = boundedInteger(query.limit, ADMIN_KNOWLEDGE_GRAPH_SEARCH_LIMIT, 20);
  const params: Array<string | number> = [value, `${value}%`, `%${value}%`];
  const filters = [
    'p.deleted_at IS NULL',
    '(p.slug ILIKE $3 OR p.title ILIKE $3)',
  ];
  if (query.sourceId && query.sourceId !== 'all') {
    params.push(query.sourceId);
    filters.push(`p.source_id = $${params.length}`);
  }
  params.push(limit);
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT p.id::int AS id
       FROM pages p
      WHERE ${filters.join(' AND ')}
      ORDER BY CASE
        WHEN LOWER(p.title) = LOWER($1) OR LOWER(p.slug) = LOWER($1) THEN 0
        WHEN p.title ILIKE $2 OR p.slug ILIKE $2 THEN 1
        ELSE 2
      END,
      p.updated_at DESC,
      p.id
      LIMIT $${params.length}`,
    params,
  );
  return { rows: await loadKnowledgeGraphNodes(engine, rows.map(row => row.id)) };
}

export async function getAdminKnowledgeGraphNeighborhood(
  engine: BrainEngine,
  query: { sourceId: string; slug: string; relationType?: string; limit?: number },
): Promise<KnowledgeGraphNeighborhoodResponse> {
  const sourceId = query.sourceId.trim();
  const slug = query.slug.trim();
  if (!sourceId || !slug) throw new Error('knowledge_graph_page_identity_required');
  const centerRows = await engine.executeRaw<{ id: number }>(
    `SELECT id::int AS id
       FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [sourceId, slug],
  );
  const centerId = centerRows[0]?.id;
  if (!centerId) throw new Error('knowledge_graph_page_not_found');

  const limit = boundedInteger(query.limit, ADMIN_KNOWLEDGE_GRAPH_NEIGHBOR_LIMIT, ADMIN_KNOWLEDGE_GRAPH_NEIGHBOR_LIMIT);
  const params: Array<string | number> = [centerId];
  const filters = ['(l.from_page_id = $1 OR l.to_page_id = $1)'];
  if (query.relationType?.trim() && query.relationType !== 'all') {
    params.push(query.relationType.trim());
    filters.push(`l.link_type = $${params.length}`);
  }
  params.push(limit + 1);
  const edgeRows = await engine.executeRaw<KnowledgeGraphEdge>(
    `SELECT l.id::int AS id,
            l.from_page_id::int AS from_page_id,
            l.to_page_id::int AS to_page_id,
            COALESCE(l.link_type, '') AS link_type,
            COALESCE(l.context, '') AS context,
            l.link_source
       FROM links l
       JOIN pages source ON source.id = l.from_page_id AND source.deleted_at IS NULL
       JOIN pages target ON target.id = l.to_page_id AND target.deleted_at IS NULL
      WHERE ${filters.join(' AND ')}
      ORDER BY CASE l.link_source
        WHEN 'manual' THEN 0
        WHEN 'frontmatter' THEN 1
        WHEN 'markdown' THEN 2
        ELSE 3
      END,
      l.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const truncated = edgeRows.length > limit;
  const edges = edgeRows.slice(0, limit);
  const pageIds = [
    centerId,
    ...edges.flatMap(edge => [edge.from_page_id, edge.to_page_id]),
  ];
  return {
    center_id: centerId,
    nodes: await loadKnowledgeGraphNodes(engine, pageIds),
    edges,
    truncated,
    limit,
  };
}

export async function getAdminKnowledgeGraphMeta(
  engine: BrainEngine,
  query: { sourceId?: string },
): Promise<KnowledgeGraphMetaResponse> {
  const params: string[] = [];
  const sourceFilter = query.sourceId && query.sourceId !== 'all'
    ? (() => {
      params.push(query.sourceId!);
      return `AND (source.source_id = $1 OR target.source_id = $1)`;
    })()
    : '';
  const relationRows = await engine.executeRaw<{ link_type: string }>(
    `SELECT DISTINCT TRIM(l.link_type) AS link_type
       FROM links l
       JOIN pages source ON source.id = l.from_page_id AND source.deleted_at IS NULL
       JOIN pages target ON target.id = l.to_page_id AND target.deleted_at IS NULL
      WHERE TRIM(l.link_type) <> '' ${sourceFilter}
      ORDER BY link_type`,
    params,
  );

  const seedParams: string[] = [];
  const seedSourceFilter = query.sourceId && query.sourceId !== 'all'
    ? (() => {
      seedParams.push(query.sourceId!);
      return 'AND p.source_id = $1';
    })()
    : '';
  const seedRows = await engine.executeRaw<{ id: number }>(
    `SELECT p.id::int AS id
       FROM pages p
       LEFT JOIN (
         SELECT endpoints.page_id, COUNT(*)::int AS relation_count
           FROM (
             SELECT from_page_id AS page_id FROM links
             UNION ALL
             SELECT to_page_id AS page_id FROM links
           ) endpoints
          GROUP BY endpoints.page_id
       ) degree ON degree.page_id = p.id
      WHERE p.deleted_at IS NULL ${seedSourceFilter}
      ORDER BY COALESCE(degree.relation_count, 0) DESC, p.updated_at DESC, p.id
      LIMIT 1`,
    seedParams,
  );
  const seed = seedRows[0] ? (await loadKnowledgeGraphNodes(engine, [seedRows[0].id]))[0] ?? null : null;
  return {
    relation_types: relationRows.map(row => row.link_type),
    seed,
  };
}

export async function getAdminKnowledgeGraphGlobal(
  engine: BrainEngine,
  query: { sourceId?: string; relationType?: string },
): Promise<KnowledgeGraphGlobalResponse> {
  const sourceId = query.sourceId?.trim() && query.sourceId !== 'all' ? query.sourceId.trim() : null;
  const relationType = query.relationType?.trim() && query.relationType !== 'all'
    ? query.relationType.trim()
    : null;
  const nodeRows = await engine.executeRaw<NodeRow>(
    `WITH visible_edges AS (
       SELECT l.from_page_id, l.to_page_id
         FROM links l
         JOIN pages source ON source.id = l.from_page_id AND source.deleted_at IS NULL
         JOIN pages target ON target.id = l.to_page_id AND target.deleted_at IS NULL
        WHERE ($1::text IS NULL OR (source.source_id = $1 AND target.source_id = $1))
          AND ($2::text IS NULL OR l.link_type = $2)
     ), degree AS (
       SELECT endpoint.page_id,
              SUM(CASE WHEN endpoint.direction = 'out' THEN 1 ELSE 0 END)::int AS outgoing_count,
              SUM(CASE WHEN endpoint.direction = 'in' THEN 1 ELSE 0 END)::int AS incoming_count,
              COUNT(*)::int AS relation_count
         FROM (
           SELECT from_page_id AS page_id, 'out' AS direction FROM visible_edges
           UNION ALL
           SELECT to_page_id AS page_id, 'in' AS direction FROM visible_edges
         ) endpoint
        GROUP BY endpoint.page_id
     )
     SELECT p.id::int AS id,
            p.slug,
            COALESCE(NULLIF(p.title, ''), p.slug) AS title,
            p.source_id,
            s.name AS source_name,
            p.type,
            '' AS preview,
            p.updated_at::text AS updated_at,
            COALESCE(degree.outgoing_count, 0)::int AS outgoing_count,
            COALESCE(degree.incoming_count, 0)::int AS incoming_count,
            COALESCE(degree.relation_count, 0)::int AS relation_count
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       LEFT JOIN degree ON degree.page_id = p.id
      WHERE p.deleted_at IS NULL
        AND ($1::text IS NULL OR p.source_id = $1)
      ORDER BY COALESCE(degree.relation_count, 0) DESC, p.id
      LIMIT $3`,
    [sourceId, relationType, ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT + 1],
  );
  const nodes = nodeRows.slice(0, ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT).map(node => ({ ...node, tags: [] }));
  const visibleNodeIds = new Set(nodes.map(node => node.id));

  const edgeParams: Array<string | number | null> = [
    sourceId,
    relationType,
    ADMIN_KNOWLEDGE_GRAPH_GLOBAL_EDGE_LIMIT + 1,
  ];
  const edgeRows = await engine.executeRaw<KnowledgeGraphEdge>(
    `SELECT l.id::int AS id,
            l.from_page_id::int AS from_page_id,
            l.to_page_id::int AS to_page_id,
            COALESCE(l.link_type, '') AS link_type,
            COALESCE(l.context, '') AS context,
            l.link_source
       FROM links l
       JOIN pages source ON source.id = l.from_page_id AND source.deleted_at IS NULL
       JOIN pages target ON target.id = l.to_page_id AND target.deleted_at IS NULL
      WHERE ($1::text IS NULL OR (source.source_id = $1 AND target.source_id = $1))
        AND ($2::text IS NULL OR l.link_type = $2)
      ORDER BY l.id
      LIMIT $3`,
    edgeParams,
  );
  const edges = edgeRows
    .slice(0, ADMIN_KNOWLEDGE_GRAPH_GLOBAL_EDGE_LIMIT)
    .filter(edge => visibleNodeIds.has(edge.from_page_id) && visibleNodeIds.has(edge.to_page_id));

  const countRows = await engine.executeRaw<{ total_nodes: number; total_edges: number }>(
    `SELECT
       (SELECT COUNT(*)::int
          FROM pages p
         WHERE p.deleted_at IS NULL
           AND ($1::text IS NULL OR p.source_id = $1)) AS total_nodes,
       (SELECT COUNT(*)::int
          FROM links l
          JOIN pages source ON source.id = l.from_page_id AND source.deleted_at IS NULL
          JOIN pages target ON target.id = l.to_page_id AND target.deleted_at IS NULL
         WHERE ($1::text IS NULL OR (source.source_id = $1 AND target.source_id = $1))
           AND ($2::text IS NULL OR l.link_type = $2)) AS total_edges`,
    edgeParams.slice(0, 2),
  );
  const totals = countRows[0] ?? { total_nodes: nodes.length, total_edges: edges.length };
  return {
    nodes,
    edges,
    total_nodes: totals.total_nodes,
    total_edges: totals.total_edges,
    truncated: nodeRows.length > ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT
      || edgeRows.length > ADMIN_KNOWLEDGE_GRAPH_GLOBAL_EDGE_LIMIT,
    node_limit: ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT,
    edge_limit: ADMIN_KNOWLEDGE_GRAPH_GLOBAL_EDGE_LIMIT,
  };
}

/**
 * Lightweight orphan audit view: pages with no valid incoming or outgoing
 * relation to another non-deleted page. Kept separate from the global graph
 * so the normal star map does not pay for an anti-join unless requested.
 */
export async function getAdminKnowledgeGraphIsolated(
  engine: BrainEngine,
  query: { sourceId?: string },
): Promise<KnowledgeGraphGlobalResponse> {
  const sourceId = query.sourceId?.trim() && query.sourceId !== 'all' ? query.sourceId.trim() : null;
  const rows = await engine.executeRaw<NodeRow>(
    `SELECT p.id::int AS id,
            p.slug,
            COALESCE(NULLIF(p.title, ''), p.slug) AS title,
            p.source_id,
            s.name AS source_name,
            p.type,
            '' AS preview,
            p.updated_at::text AS updated_at,
            0::int AS outgoing_count,
            0::int AS incoming_count,
            0::int AS relation_count
       FROM pages p
       JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NULL
        AND ($1::text IS NULL OR p.source_id = $1)
        AND NOT EXISTS (
          SELECT 1
            FROM links l
            JOIN pages source ON source.id = l.from_page_id AND source.deleted_at IS NULL
            JOIN pages target ON target.id = l.to_page_id AND target.deleted_at IS NULL
           WHERE l.from_page_id = p.id OR l.to_page_id = p.id
        )
      ORDER BY p.updated_at DESC, p.id
      LIMIT $2`,
    [sourceId, ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT + 1],
  );
  const nodes = rows.slice(0, ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT).map(node => ({ ...node, tags: [] }));
  const countRows = await engine.executeRaw<{ total_nodes: number }>(
    `SELECT COUNT(*)::int AS total_nodes
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND ($1::text IS NULL OR p.source_id = $1)
        AND NOT EXISTS (
          SELECT 1
            FROM links l
            JOIN pages source ON source.id = l.from_page_id AND source.deleted_at IS NULL
            JOIN pages target ON target.id = l.to_page_id AND target.deleted_at IS NULL
           WHERE l.from_page_id = p.id OR l.to_page_id = p.id
        )`,
    [sourceId],
  );
  const totalNodes = countRows[0]?.total_nodes ?? nodes.length;
  return {
    nodes,
    edges: [],
    total_nodes: totalNodes,
    total_edges: 0,
    truncated: rows.length > ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT,
    node_limit: ADMIN_KNOWLEDGE_GRAPH_GLOBAL_NODE_LIMIT,
    edge_limit: ADMIN_KNOWLEDGE_GRAPH_GLOBAL_EDGE_LIMIT,
  };
}

export async function getAdminKnowledgeGraphMissingLinks(
  engine: BrainEngine,
  query: { sourceId?: string },
): Promise<KnowledgeGraphMissingLinksResponse> {
  const sourceId = query.sourceId?.trim() && query.sourceId !== 'all' ? query.sourceId.trim() : null;
  const rows = await engine.executeRaw<KnowledgeGraphMissingLinksResponse['rows'][number]>(
    `SELECT l.id::int AS id,
            l.from_page_id::int AS from_page_id,
            source.slug AS from_slug,
            COALESCE(NULLIF(source.title, ''), source.slug) AS from_title,
            source.source_id AS from_source_id,
            source_scope.name AS from_source_name,
            l.to_page_id::int AS missing_page_id,
            COALESCE(l.link_type, '') AS link_type,
            COALESCE(l.context, '') AS context,
            l.link_source
       FROM links l
       LEFT JOIN pages target ON target.id = l.to_page_id
       LEFT JOIN pages source ON source.id = l.from_page_id
       LEFT JOIN sources source_scope ON source_scope.id = source.source_id
      WHERE target.id IS NULL
        AND ($1::text IS NULL OR source.source_id = $1)
      ORDER BY source.updated_at DESC NULLS LAST, l.id DESC
      LIMIT $2`,
    [sourceId, ADMIN_KNOWLEDGE_GRAPH_MISSING_LINK_LIMIT + 1],
  );
  const countRows = await engine.executeRaw<{ total: number }>(
    `SELECT COUNT(*)::int AS total
       FROM links l
       LEFT JOIN pages target ON target.id = l.to_page_id
       LEFT JOIN pages source ON source.id = l.from_page_id
      WHERE target.id IS NULL
        AND ($1::text IS NULL OR source.source_id = $1)`,
    [sourceId],
  );
  return {
    rows: rows.slice(0, ADMIN_KNOWLEDGE_GRAPH_MISSING_LINK_LIMIT),
    total: countRows[0]?.total ?? rows.length,
    truncated: rows.length > ADMIN_KNOWLEDGE_GRAPH_MISSING_LINK_LIMIT,
    limit: ADMIN_KNOWLEDGE_GRAPH_MISSING_LINK_LIMIT,
  };
}
