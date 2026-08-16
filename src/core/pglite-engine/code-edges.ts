/**
 * v0.20.0 Cathedral II: code edges, peeled out of PGLiteEngine
 * (containment sprint C15). Free functions over a NARROW deps surface —
 * never the whole engine class.
 */
import type { PGlite } from '@electric-sql/pglite';

// PGLite's parameter bridge corrupts the current engine session when a single
// statement crosses the signed-int16 bind ceiling (32,767 parameters). Keep
// bulk code-edge writes comfortably below it; the two edge shapes use 7 and 6
// binds per row respectively.
const PGLITE_EDGE_BATCH_MAX_BIND_PARAMS = 30_000;

/** Narrow slice of PGLiteEngine the code-edge operations use. */
export interface PgliteCodeEdgesDeps {
  /** Live PGLite handle (getter-backed at the call site). */
  readonly db: PGlite;
}

export async function addCodeEdges(deps: PgliteCodeEdgesDeps, edges: import('../types.ts').CodeEdgeInput[]): Promise<number> {
    if (edges.length === 0) return 0;
    let inserted = 0;
    // Split into resolved vs unresolved. Resolved rows carry to_chunk_id
    // (known target chunk); unresolved rows only know the qualified name.
    const resolved = edges.filter(e => e.to_chunk_id != null);
    const unresolved = edges.filter(e => e.to_chunk_id == null);

    const resolvedBatchSize = Math.floor(PGLITE_EDGE_BATCH_MAX_BIND_PARAMS / 7);
    for (let offset = 0; offset < resolved.length; offset += resolvedBatchSize) {
      const batch = resolved.slice(offset, offset + resolvedBatchSize);
      const rowParts: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of batch) {
        rowParts.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++})`);
        params.push(
          e.from_chunk_id, e.to_chunk_id, e.from_symbol_qualified,
          e.to_symbol_qualified, e.edge_type,
          JSON.stringify(e.edge_metadata ?? {}),
          e.source_id ?? 'default',
        );
      }
      const res = await deps.db.query(
        `INSERT INTO code_edges_chunk
           (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${rowParts.join(', ')}
         ON CONFLICT (from_chunk_id, to_chunk_id, edge_type) DO NOTHING`,
        params,
      );
      inserted += res.affectedRows ?? 0;
    }

    const unresolvedBatchSize = Math.floor(PGLITE_EDGE_BATCH_MAX_BIND_PARAMS / 6);
    for (let offset = 0; offset < unresolved.length; offset += unresolvedBatchSize) {
      const batch = unresolved.slice(offset, offset + unresolvedBatchSize);
      const rowParts: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of batch) {
        rowParts.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++})`);
        params.push(
          e.from_chunk_id, e.from_symbol_qualified, e.to_symbol_qualified, e.edge_type,
          JSON.stringify(e.edge_metadata ?? {}),
          e.source_id ?? 'default',
        );
      }
      const res = await deps.db.query(
        `INSERT INTO code_edges_symbol
           (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${rowParts.join(', ')}
         ON CONFLICT (from_chunk_id, to_symbol_qualified, edge_type) DO NOTHING`,
        params,
      );
      inserted += res.affectedRows ?? 0;
    }
    return inserted;
  }

export async function deleteCodeEdgesForChunks(deps: PgliteCodeEdgesDeps, chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    // Both directions on code_edges_chunk; from-only on code_edges_symbol
    // (unresolved edges don't have a to_chunk_id to match against).
    await deps.db.query(
      `DELETE FROM code_edges_chunk WHERE from_chunk_id = ANY($1::int[]) OR to_chunk_id = ANY($1::int[])`,
      [chunkIds],
    );
    await deps.db.query(
      `DELETE FROM code_edges_symbol WHERE from_chunk_id = ANY($1::int[])`,
      [chunkIds],
    );
  }

export async function getCallersOf(
  deps: PgliteCodeEdgesDeps,
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('../types.ts').CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const sourceClause = opts?.allSources || !opts?.sourceId
      ? ''
      : `AND source_id = '${opts.sourceId.replace(/'/g, "''")}'`;
    const { rows } = await deps.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         WHERE to_symbol_qualified = $1 ${sourceClause}
       UNION ALL
       SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, false as resolved
         FROM code_edges_symbol
         WHERE to_symbol_qualified = $1 ${sourceClause}
       LIMIT $2`,
      [qualifiedName, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

export async function getCalleesOf(
  deps: PgliteCodeEdgesDeps,
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('../types.ts').CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const sourceClause = opts?.allSources || !opts?.sourceId
      ? ''
      : `AND source_id = '${opts.sourceId.replace(/'/g, "''")}'`;
    const { rows } = await deps.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         WHERE from_symbol_qualified = $1 ${sourceClause}
       UNION ALL
       SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, false as resolved
         FROM code_edges_symbol
         WHERE from_symbol_qualified = $1 ${sourceClause}
       LIMIT $2`,
      [qualifiedName, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

export async function getEdgesByChunk(
  deps: PgliteCodeEdgesDeps,
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('../types.ts').CodeEdgeResult[]> {
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(opts?.limit ?? 50, 200);
    const edgeTypeClause = opts?.edgeType ? `AND edge_type = '${opts.edgeType.replace(/'/g, "''")}'` : '';
    // Build the chunk-table filter based on direction. Unresolved edges
    // (code_edges_symbol) only carry from_chunk_id — there's no inbound
    // direction into them from a chunk ID, so we include them only when
    // direction is 'out' or 'both'.
    let chunkFilter = '';
    if (direction === 'in') chunkFilter = `WHERE to_chunk_id = $1`;
    else if (direction === 'out') chunkFilter = `WHERE from_chunk_id = $1`;
    else chunkFilter = `WHERE from_chunk_id = $1 OR to_chunk_id = $1`;

    let symbolFilter = '';
    if (direction === 'out' || direction === 'both') {
      symbolFilter = `WHERE from_chunk_id = $1`;
    }

    const unionClause = symbolFilter ? `
      UNION ALL
      SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        ${symbolFilter} ${edgeTypeClause}
    ` : '';

    const { rows } = await deps.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         ${chunkFilter} ${edgeTypeClause}
       ${unionClause}
       LIMIT $2`,
      [chunkId, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

function rowToCodeEdge(row: Record<string, unknown>): import('../types.ts').CodeEdgeResult {
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
