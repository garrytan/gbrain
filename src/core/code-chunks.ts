import type { BrainEngine } from './engine.ts';
import type { ChunkInput, CodeEdgeInput } from './types.ts';
import { chunkCodeTextFull } from './chunkers/code.ts';
import { findChunkForOffset } from './chunkers/edge-extractor.ts';
import { sanitizeRemoteBody } from './remote-body.ts';
import { isEmbedSkipped } from './embed-skip.ts';
import { isQuarantined } from './quarantine.ts';

export async function prepareCodeChunks(page: { compiled_truth: string; frontmatter?: Record<string, unknown> | null }, path: string) {
  const content = sanitizeRemoteBody(page.compiled_truth);
  const prepared = isEmbedSkipped(page.frontmatter) || isQuarantined(page.frontmatter)
    ? { chunks: [], edges: [] } : await chunkCodeTextFull(content, path);
  const chunks: ChunkInput[] = prepared.chunks.map((c, i) => ({
    chunk_index: i, chunk_text: c.text, chunk_source: 'compiled_truth',
    language: c.metadata.language, symbol_name: c.metadata.symbolName || undefined,
    symbol_type: c.metadata.symbolType, start_line: c.metadata.startLine, end_line: c.metadata.endLine,
    parent_symbol_path: c.metadata.parentSymbolPath?.length ? c.metadata.parentSymbolPath : undefined,
    symbol_name_qualified: c.metadata.symbolNameQualified || undefined,
  }));
  return { chunks, edges: prepared.edges, content };
}

export async function installCodeChunkEdges(engine: BrainEngine, slug: string, sourceId: string,
  prepared: Awaited<ReturnType<typeof prepareCodeChunks>>): Promise<void> {
  const stored = await engine.getChunks(slug, { sourceId, includeUnsealed: true });
  if (!stored.length) return;
  const ids = stored.map(c => c.id);
  await engine.executeRaw('DELETE FROM code_edges_chunk WHERE from_chunk_id = ANY($1::int[])', [ids]);
  await engine.executeRaw('DELETE FROM code_edges_symbol WHERE from_chunk_id = ANY($1::int[])', [ids]);
  await engine.executeRaw('UPDATE content_chunks SET edges_backfilled_at=NULL WHERE id = ANY($1::int[])', [ids]);
  const ranges = stored.map(c => ({ id: c.id, startLine: c.start_line ?? 1,
    endLine: c.end_line ?? 1, symbol_name_qualified: c.symbol_name_qualified }));
  const edges: CodeEdgeInput[] = [];
  for (const edge of prepared.edges) {
    const index = findChunkForOffset(edge.callSiteByteOffset, prepared.content, ranges);
    const from = index === null ? undefined : ranges[index];
    if (!from?.symbol_name_qualified) continue;
    edges.push({ from_chunk_id: from.id, to_chunk_id: null, from_symbol_qualified: from.symbol_name_qualified,
      to_symbol_qualified: edge.toSymbol, edge_type: edge.edgeType, source_id: sourceId });
  }
  if (edges.length) await engine.addCodeEdges(edges);
}
