/**
 * PGLite-only code-edge read (refactor wave 1 C13). The rest of the domain
 * lives once in src/core/engine-sql/code-edges.ts. `getEdgesByChunk` stays
 * dialect-specific because it runs on the PGLite query API, but it applies the
 * same filters as the shared Postgres read: the edge-type filter covers every
 * direction arm and is bound, and each table gets its own LIMIT.
 */
import type { PGlite } from '@electric-sql/pglite';
import { rowToCodeEdge } from '../engine-sql/code-edges.ts';

/** Narrow slice of PGLiteEngine this read uses. */
export interface PgliteCodeEdgesDeps {
  /** Live PGLite handle (getter-backed at the call site). */
  readonly db: PGlite;
}

export async function getEdgesByChunk(
  deps: PgliteCodeEdgesDeps,
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('../types.ts').CodeEdgeResult[]> {
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(opts?.limit ?? 50, 200);
    const params: unknown[] = [chunkId, limit];
    let typeClause = '';
    if (opts?.edgeType) {
      params.push(opts.edgeType);
      typeClause = 'AND edge_type = $3';
    }
    const chunkFilter = direction === 'in' ? 'to_chunk_id = $1'
      : direction === 'out' ? 'from_chunk_id = $1'
      : '(from_chunk_id = $1 OR to_chunk_id = $1)';
    const { rows: chunkRows } = await deps.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
        WHERE ${chunkFilter} ${typeClause}
        LIMIT $2`,
      params,
    );
    let symbolRows: unknown[] = [];
    if (direction !== 'in') {
      const { rows } = await deps.db.query(
        `SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
                edge_type, edge_metadata, source_id, false as resolved
           FROM code_edges_symbol
          WHERE from_chunk_id = $1 ${typeClause}
          LIMIT $2`,
        params,
      );
      symbolRows = rows;
    }
    return [...chunkRows, ...symbolRows].map(r => rowToCodeEdge(r as Record<string, unknown>));
  }
