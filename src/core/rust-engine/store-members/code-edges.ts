/**
 * Code edge members (BrainEngine addCodeEdges, deleteCodeEdgesForChunks, getCallersOf, getCalleesOf,
 * getEdgesByChunk). The store keeps the `code_edges_chunk` and `code_edges_symbol` rows (rust/docs/store/code_edges.md).
 * This shell does what the shared SQL does before its statements run (metadata and source defaults, the limit clamps,
 * the source scope, the bare-name opt-in) and maps every row through the shared `rowToCodeEdge`, so both engines
 * answer the same rows.
 *
 * A limit or chunk id that is not a finite integer refuses: Postgres rejects it as a bind, the store would read it
 * differently.
 */
import { rowToCodeEdge } from '../../engine-sql/code-edges.ts';
import type { CodeEdgeInput, CodeEdgeResult } from '../../types.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

type Row = Record<string, unknown>;

/** `LIMIT n` as the store reads it: a whole count; a negative one is refused by the store as Postgres refuses it. */
function clampLimit(member: string, limit: unknown, fallback: number, cap: number): number {
  const n = Math.min((limit as number | null | undefined) ?? fallback, cap);
  if (typeof n !== 'number' || !Number.isInteger(n)) refuseMember(member, 'limit is not a whole number');
  // A count below the int4 range reaches the store as a double; any negative count is refused the same way.
  return n < 0 ? -1 : n;
}

function finiteChunkId(member: string, chunkId: unknown): unknown {
  if (typeof chunkId === 'number' && !Number.isFinite(chunkId)) refuseMember(member, 'chunk id is not finite');
  return chunkId;
}

export const addCodeEdges: StoreMember<[edges: CodeEdgeInput[]], number> = async (brain, edges) => {
  if (edges.length === 0) return 0;
  const sent = edges.map((e) => {
    // The SQL binds JSON.stringify(...)::text::jsonb; a value JSON cannot carry binds NULL.
    const json = JSON.stringify(e.edge_metadata ?? {});
    return {
      from_chunk_id: finiteChunkId('addCodeEdges', e.from_chunk_id) ?? null,
      to_chunk_id: finiteChunkId('addCodeEdges', e.to_chunk_id) ?? null,
      from_symbol_qualified: e.from_symbol_qualified ?? null,
      to_symbol_qualified: e.to_symbol_qualified ?? null,
      edge_type: e.edge_type ?? null,
      edge_metadata: json === undefined ? null : JSON.parse(json),
      source_id: e.source_id ?? 'default',
    };
  });
  return Number(await storeCall({ member: 'addCodeEdges' }, () => brain.addCodeEdges(sent)));
};

export const deleteCodeEdgesForChunks: StoreMember<[chunkIds: number[]], void> = async (brain, chunkIds) => {
  if (chunkIds.length === 0) return;
  const ids = chunkIds.map((id) => finiteChunkId('deleteCodeEdgesForChunks', id) ?? null);
  await storeCall({ member: 'deleteCodeEdgesForChunks' }, () => brain.deleteCodeEdgesForChunks(ids));
};

export const clearCodeEdgesLeavingChunks: StoreMember<[chunkIds: number[]], void> = async (brain, chunkIds) => {
  if (chunkIds.length === 0) return;
  const ids = chunkIds.map((id) => finiteChunkId('clearCodeEdgesLeavingChunks', id) ?? null);
  await storeCall({ member: 'clearCodeEdgesLeavingChunks' }, () => brain.clearCodeEdgesLeavingChunks(ids));
};

type LookupOpts = { sourceId?: string; allSources?: boolean; limit?: number; bareFallback?: boolean; chunkId?: number };

/** The shared SQL's lookup inputs: limit clamp, `scopedSource`, and chunk identity only for a number. */
function lookup(member: string, name: string, o: Record<string, unknown>, bareFallback: boolean) {
  const byChunk = typeof o.chunkId === 'number';
  if (!byChunk && typeof name !== 'string') refuseMember(member, 'name is not a string');
  return {
    name: byChunk ? '' : name,
    chunk_id: byChunk ? finiteChunkId(member, o.chunkId) : null,
    source_id: !o.allSources && o.sourceId ? o.sourceId : null,
    limit: clampLimit(member, o.limit, 100, 500),
    bare_fallback: bareFallback,
  };
}

export const getCallersOf: StoreMember<[qualifiedName: string, opts?: Omit<LookupOpts, 'bareFallback'>], CodeEdgeResult[]> =
  async (brain, qualifiedName, opts) => {
    const o = takeOptions('getCallersOf', opts, ['sourceId', 'allSources', 'limit', 'chunkId']);
    const sent = lookup('getCallersOf', qualifiedName, o, false);
    const rows = (await storeCall({ member: 'getCallersOf' }, () => brain.getCallersOf(sent))) as Row[];
    return rows.map(rowToCodeEdge);
  };

export const getCalleesOf: StoreMember<[qualifiedName: string, opts?: LookupOpts], CodeEdgeResult[]> =
  async (brain, qualifiedName, opts) => {
    const o = takeOptions('getCalleesOf', opts, ['sourceId', 'allSources', 'limit', 'chunkId', 'bareFallback']);
    // #4670: the fallback is opt-in and only for a name without `.`, `#` or `:`.
    const bare = !!o.bareFallback && typeof qualifiedName === 'string' && !/[.#:]/.test(qualifiedName);
    const sent = lookup('getCalleesOf', qualifiedName, o, bare);
    const rows = (await storeCall({ member: 'getCalleesOf' }, () => brain.getCalleesOf(sent))) as Row[];
    return rows.map(rowToCodeEdge);
  };

export const getEdgesByChunk: StoreMember<
  [chunkId: number, opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number }],
  CodeEdgeResult[]
> = async (brain, chunkId, opts) => {
  const o = takeOptions('getEdgesByChunk', opts, ['direction', 'edgeType', 'limit']);
  const direction = o.direction === 'in' || o.direction === 'out' ? o.direction : 'both';
  const sent = {
    chunk_id: finiteChunkId('getEdgesByChunk', chunkId) ?? null,
    direction,
    edge_type: o.edgeType ? o.edgeType : null,
    limit: clampLimit('getEdgesByChunk', o.limit, 50, 200),
  };
  const rows = (await storeCall({ member: 'getEdgesByChunk' }, () => brain.getEdgesByChunk(sent))) as Row[];
  return rows.map(rowToCodeEdge);
};

// jobs-tables group D: the code_traversal_cache members.
export * from './code-traversal-cache.ts';
