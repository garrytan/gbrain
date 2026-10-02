/**
 * Code edges (v0.20 Cathedral II call graph): one SQL implementation for both
 * engines (refactor wave 1, W1-core C13). Statement text is PostgresEngine's
 * master text (SQL-text golden `sql-text/code-edges.json`); PGLite runs the
 * same statements, except `getEdgesByChunk`, whose PGLite form differs in
 * behavior on master (one UNION with a shared LIMIT) and stays dialect-specific
 * in src/core/pglite-engine/code-edges.ts (docs/designs/refactor-wave-1/w1-inventory.md).
 *
 * Capability `maxBindParamsPerStatement`: PGLite's parameter bridge corrupts
 * the session past 32,767 binds, so bulk inserts split below 30,000 binds
 * there; Postgres (Infinity) keeps master's single statement per shape. The
 * inserts keep master's direct `unsafe` path (they were raw on master).
 * Reads were unscoped on master (EO4 inventory): `LegacyUnscopedRead`.
 */
import type { CodeEdgeInput, CodeEdgeResult } from '../types.ts';
import { currentCodeEdgeFilter } from '../code-intel/read-scope.ts';
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** Rows per statement for a shape binding `bindsPerRow` params (Infinity = one statement). */
function rowsPerStatement(exec: SqlExecutor, bindsPerRow: number): number {
  return Math.floor(exec.capabilities.maxBindParamsPerStatement / bindsPerRow);
}

function* batches<T>(rows: T[], size: number): Generator<T[]> {
  if (!Number.isFinite(size)) { if (rows.length > 0) yield rows; return; }
  for (let offset = 0; offset < rows.length; offset += size) yield rows.slice(offset, offset + size);
}

export async function addCodeEdges(exec: SqlExecutor, edges: CodeEdgeInput[]): Promise<number> {
    if (edges.length === 0) return 0;
    let inserted = 0;
    const resolved = edges.filter(e => e.to_chunk_id != null);
    const unresolved = edges.filter(e => e.to_chunk_id == null);

    // Per-row placeholders with ::text::jsonb for edge_metadata. Bun SQL
    // mis-encodes jsonb[] array binds (double-encoded strings landed in
    // edge_metadata — the resolver then read `"{}"` scalars and 0 edges ever
    // resolved). ::text::jsonb per row is the codebase-wide safe shape.
    for (const batch of batches(resolved, rowsPerStatement(exec, 7))) {
      const values = joinFragments(batch.map(e => sqlFragment`(${e.from_chunk_id}::int, ${e.to_chunk_id as number}::int, ${e.from_symbol_qualified}, ${e.to_symbol_qualified}, ${e.edge_type}, ${JSON.stringify(e.edge_metadata ?? {})}::text::jsonb, ${e.source_id ?? 'default'})`), ', ');
      const { text, params } = renderFragment(sqlFragment`INSERT INTO code_edges_chunk
           (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${values}
         ON CONFLICT (from_chunk_id, to_chunk_id, edge_type) DO NOTHING`);
      inserted += (await exec.unsafe(text, params)).affectedRows;
    }

    for (const batch of batches(unresolved, rowsPerStatement(exec, 6))) {
      const values = joinFragments(batch.map(e => sqlFragment`(${e.from_chunk_id}::int, ${e.from_symbol_qualified}, ${e.to_symbol_qualified}, ${e.edge_type}, ${JSON.stringify(e.edge_metadata ?? {})}::text::jsonb, ${e.source_id ?? 'default'})`), ', ');
      const { text, params } = renderFragment(sqlFragment`INSERT INTO code_edges_symbol
           (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${values}
         ON CONFLICT (from_chunk_id, to_symbol_qualified, edge_type) DO NOTHING`);
      inserted += (await exec.unsafe(text, params)).affectedRows;
    }

    return inserted;
  }

export async function deleteCodeEdgesForChunks(exec: SqlExecutor, chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    (await exec.run(sqlFragment`DELETE FROM code_edges_chunk WHERE from_chunk_id = ANY(${chunkIds}::int[]) OR to_chunk_id = ANY(${chunkIds}::int[])`)).rows;
    (await exec.run(sqlFragment`DELETE FROM code_edges_symbol WHERE from_chunk_id = ANY(${chunkIds}::int[])`)).rows;
  }

export async function getCallersOf(
  exec: LegacyUnscopedRead,
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const scopedSource: string | null =
      !opts?.allSources && opts?.sourceId ? opts.sourceId : null;
    const rows = (await exec.run(sqlFragment`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE to_symbol_qualified = ${qualifiedName}
        AND ${trustedSql(currentCodeEdgeFilter('code_edges_chunk', true))}
        ${scopedSource ? sqlFragment`AND source_id = ${scopedSource}` : sqlFragment``}
      UNION ALL
      SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        WHERE to_symbol_qualified = ${qualifiedName}
        AND ${trustedSql(currentCodeEdgeFilter('code_edges_symbol', false))}
        ${scopedSource ? sqlFragment`AND source_id = ${scopedSource}` : sqlFragment``}
      LIMIT ${limit}
    `)).rows;
    return rows.map(r => rowToCodeEdge(r as Record<string, unknown>));
  }

export async function getCalleesOf(
  exec: LegacyUnscopedRead,
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number; bareFallback?: boolean },
  ): Promise<CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const scopedSource: string | null =
      !opts?.allSources && opts?.sourceId ? opts.sourceId : null;
    const run = async (fromPredicate: SqlFragment) => (await exec.run(sqlFragment`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE ${fromPredicate}
        AND ${trustedSql(currentCodeEdgeFilter('code_edges_chunk', true))}
        ${scopedSource ? sqlFragment`AND source_id = ${scopedSource}` : sqlFragment``}
      UNION ALL
      SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        WHERE ${fromPredicate}
        AND ${trustedSql(currentCodeEdgeFilter('code_edges_symbol', false))}
        ${scopedSource ? sqlFragment`AND source_id = ${scopedSource}` : sqlFragment``}
      LIMIT ${limit}
    `)).rows;
    let rows = await run(sqlFragment`from_symbol_qualified = ${qualifiedName}`);
    // #4670: opt-in bare-name fallback (both engines).
    // Opt-in; zero-row exact miss + delimiter-free input re-keys on the bare
    // content_chunks.symbol_name (exact, never LIKE).
    if (rows.length === 0 && opts?.bareFallback && !/[.#:]/.test(qualifiedName)) {
      rows = await run(sqlFragment`from_chunk_id IN (SELECT id FROM content_chunks WHERE symbol_name = ${qualifiedName})`);
    }
    return rows.map(r => rowToCodeEdge(r as Record<string, unknown>));
  }

export async function getEdgesByChunk(
  exec: LegacyUnscopedRead,
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<CodeEdgeResult[]> {
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(opts?.limit ?? 50, 200);
    const typeFilter = opts?.edgeType;

    const chunkRows = (await exec.run(sqlFragment`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE
          ${direction === 'in' ? sqlFragment`to_chunk_id = ${chunkId}`
            : direction === 'out' ? sqlFragment`from_chunk_id = ${chunkId}`
            : sqlFragment`(from_chunk_id = ${chunkId} OR to_chunk_id = ${chunkId})`}
          ${typeFilter ? sqlFragment`AND edge_type = ${typeFilter}` : sqlFragment``}
        LIMIT ${limit}
    `)).rows;
    let symbolRows: unknown[] = [];
    if (direction !== 'in') {
      const sRows = (await exec.run(sqlFragment`
        SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
               edge_type, edge_metadata, source_id, false as resolved
          FROM code_edges_symbol
          WHERE from_chunk_id = ${chunkId}
            ${typeFilter ? sqlFragment`AND edge_type = ${typeFilter}` : sqlFragment``}
          LIMIT ${limit}
      `)).rows;
      symbolRows = [...sRows];
    }
    return [...chunkRows, ...symbolRows].map(r => rowToCodeEdge(r as Record<string, unknown>));
  }

/**
 * Shared by both engines' reads. `resolved` is true for a code_edges_chunk
 * row AND for a code_edges_symbol row the resolver stamped with
 * edge_metadata.resolved_chunk_id (gbrain-evals N13-2); to_chunk_id still
 * reports the stored column.
 */
export function rowToCodeEdge(row: Record<string, unknown>): CodeEdgeResult {
  const edgeMetadata = (row.edge_metadata as Record<string, unknown>) ?? {};
  return {
    id: row.id as number,
    from_chunk_id: row.from_chunk_id as number,
    to_chunk_id: row.to_chunk_id == null ? null : (row.to_chunk_id as number),
    from_symbol_qualified: (row.from_symbol_qualified as string) ?? '',
    to_symbol_qualified: (row.to_symbol_qualified as string) ?? '',
    edge_type: (row.edge_type as string) ?? '',
    edge_metadata: edgeMetadata,
    source_id: row.source_id == null ? null : (row.source_id as string),
    resolved: Boolean(row.resolved) || typeof edgeMetadata.resolved_chunk_id === 'number',
  };
}
