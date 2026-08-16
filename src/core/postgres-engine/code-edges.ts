/**
 * v0.20.0 Cathedral II: code edges, peeled out of PostgresEngine
 * (containment sprint C15). Free functions over a NARROW deps surface —
 * never the whole engine class.
 */
import type postgres from 'postgres';

type PgSql = ReturnType<typeof postgres>;

/** Narrow slice of PostgresEngine the code-edge operations use. */
export interface PgCodeEdgesDeps {
  /** Live postgres.js pool (getter-backed at the call site). */
  readonly sql: PgSql;
}

export async function addCodeEdges(deps: PgCodeEdgesDeps, edges: import('../types.ts').CodeEdgeInput[]): Promise<number> {
    if (edges.length === 0) return 0;
    const sql = deps.sql;
    let inserted = 0;
    const resolved = edges.filter(e => e.to_chunk_id != null);
    const unresolved = edges.filter(e => e.to_chunk_id == null);

    if (resolved.length > 0) {
      // Per-row placeholders with $n::text::jsonb for edge_metadata. Bun SQL
      // mis-encodes jsonb[] array binds (double-encoded strings landed in
      // edge_metadata — the resolver then read `"{}"` scalars and 0 edges ever
      // resolved). ::text::jsonb per row is the codebase-wide safe shape
      // (executeRawJsonb, PGLite's addCodeEdges).
      const rowParts: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of resolved) {
        rowParts.push(`($${p++}::int, $${p++}::int, $${p++}, $${p++}, $${p++}, $${p++}::text::jsonb, $${p++})`);
        params.push(
          e.from_chunk_id, e.to_chunk_id as number,
          e.from_symbol_qualified, e.to_symbol_qualified, e.edge_type,
          JSON.stringify(e.edge_metadata ?? {}),
          e.source_id ?? 'default',
        );
      }
      const res = await sql.unsafe(
        `INSERT INTO code_edges_chunk
           (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${rowParts.join(', ')}
         ON CONFLICT (from_chunk_id, to_chunk_id, edge_type) DO NOTHING`,
        params as never[],
      );
      inserted += (res as unknown as { count: number }).count ?? 0;
    }

    if (unresolved.length > 0) {
      const rowParts: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of unresolved) {
        rowParts.push(`($${p++}::int, $${p++}, $${p++}, $${p++}, $${p++}::text::jsonb, $${p++})`);
        params.push(
          e.from_chunk_id,
          e.from_symbol_qualified, e.to_symbol_qualified, e.edge_type,
          JSON.stringify(e.edge_metadata ?? {}),
          e.source_id ?? 'default',
        );
      }
      const res = await sql.unsafe(
        `INSERT INTO code_edges_symbol
           (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${rowParts.join(', ')}
         ON CONFLICT (from_chunk_id, to_symbol_qualified, edge_type) DO NOTHING`,
        params as never[],
      );
      inserted += (res as unknown as { count: number }).count ?? 0;
    }

    return inserted;
  }

export async function deleteCodeEdgesForChunks(deps: PgCodeEdgesDeps, chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const sql = deps.sql;
    await sql`DELETE FROM code_edges_chunk WHERE from_chunk_id = ANY(${chunkIds}::int[]) OR to_chunk_id = ANY(${chunkIds}::int[])`;
    await sql`DELETE FROM code_edges_symbol WHERE from_chunk_id = ANY(${chunkIds}::int[])`;
  }

export async function getCallersOf(
  deps: PgCodeEdgesDeps,
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('../types.ts').CodeEdgeResult[]> {
    const sql = deps.sql;
    const limit = Math.min(opts?.limit ?? 100, 500);
    const scopedSource: string | null =
      !opts?.allSources && opts?.sourceId ? opts.sourceId : null;
    const rows = await sql`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE to_symbol_qualified = ${qualifiedName}
        ${scopedSource ? sql`AND source_id = ${scopedSource}` : sql``}
      UNION ALL
      SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        WHERE to_symbol_qualified = ${qualifiedName}
        ${scopedSource ? sql`AND source_id = ${scopedSource}` : sql``}
      LIMIT ${limit}
    `;
    return rows.map(r => pgRowToCodeEdge(r as Record<string, unknown>));
  }

export async function getCalleesOf(
  deps: PgCodeEdgesDeps,
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('../types.ts').CodeEdgeResult[]> {
    const sql = deps.sql;
    const limit = Math.min(opts?.limit ?? 100, 500);
    const scopedSource: string | null =
      !opts?.allSources && opts?.sourceId ? opts.sourceId : null;
    const rows = await sql`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE from_symbol_qualified = ${qualifiedName}
        ${scopedSource ? sql`AND source_id = ${scopedSource}` : sql``}
      UNION ALL
      SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        WHERE from_symbol_qualified = ${qualifiedName}
        ${scopedSource ? sql`AND source_id = ${scopedSource}` : sql``}
      LIMIT ${limit}
    `;
    return rows.map(r => pgRowToCodeEdge(r as Record<string, unknown>));
  }

export async function getEdgesByChunk(
  deps: PgCodeEdgesDeps,
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('../types.ts').CodeEdgeResult[]> {
    const sql = deps.sql;
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(opts?.limit ?? 50, 200);
    const typeFilter = opts?.edgeType;

    const chunkRows = await sql`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE
          ${direction === 'in' ? sql`to_chunk_id = ${chunkId}`
            : direction === 'out' ? sql`from_chunk_id = ${chunkId}`
            : sql`(from_chunk_id = ${chunkId} OR to_chunk_id = ${chunkId})`}
          ${typeFilter ? sql`AND edge_type = ${typeFilter}` : sql``}
        LIMIT ${limit}
    `;
    let symbolRows: unknown[] = [];
    if (direction !== 'in') {
      const sRows = await sql`
        SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
               edge_type, edge_metadata, source_id, false as resolved
          FROM code_edges_symbol
          WHERE from_chunk_id = ${chunkId}
            ${typeFilter ? sql`AND edge_type = ${typeFilter}` : sql``}
          LIMIT ${limit}
      `;
      symbolRows = [...sRows];
    }
    return [...chunkRows, ...symbolRows].map(r => pgRowToCodeEdge(r as Record<string, unknown>));
  }

function pgRowToCodeEdge(row: Record<string, unknown>): import('../types.ts').CodeEdgeResult {
  return {
    id: row.id as number,
    from_chunk_id: row.from_chunk_id as number,
    to_chunk_id: row.to_chunk_id == null ? null : (row.to_chunk_id as number),
    from_symbol_qualified: (row.from_symbol_qualified as string) ?? '',
    to_symbol_qualified: (row.to_symbol_qualified as string) ?? '',
    edge_type: (row.edge_type as string) ?? '',
    edge_metadata: (row.edge_metadata as Record<string, unknown>) ?? {},
    source_id: row.source_id == null ? null : (row.source_id as string),
    resolved: Boolean(row.resolved),
  };
}
