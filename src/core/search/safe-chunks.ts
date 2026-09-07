import type { ChunkInput, PageReadScope } from '../types.ts';

/** First markdown index built from the strict full-body fence sanitizer. */
export const SAFE_FENCE_CHUNKER_VERSION = 4;

const PROTECTED_MARKER = '<!--- gbrain:(facts|takes):(begin|end) -->';

export function hasProtectedBody(text: string): boolean {
  return new RegExp(PROTECTED_MARKER).test(text);
}

/** Expression and aliases are internal SQL, never caller-supplied values. */
export function protectedTextFilter(expression: string): string {
  return `COALESCE(${expression}, '') ~ '${PROTECTED_MARKER}'`;
}

/** Fixed SQL aliases only. Check full bodies because fragments can lose markers. */
export function protectedBodyFilter(alias: string): string {
  return `(${protectedTextFilter(`${alias}.compiled_truth`)} OR ${protectedTextFilter(`${alias}.timeline`)})`;
}

/** A body-only write cannot certify old fragments, even after fence removal. */
export function bodyWriteChunkVersion(compiledTruth: string, timeline: string): string {
  return `CASE WHEN pages.compiled_truth IS NOT DISTINCT FROM ${compiledTruth}
    AND pages.timeline IS NOT DISTINCT FROM ${timeline} THEN pages.chunker_version
    WHEN pages.chunker_version < 0 OR ${protectedBodyFilter('pages')}
      OR ${protectedTextFilter(compiledTruth)} OR ${protectedTextFilter(timeline)} THEN -1
    ELSE LEAST(COALESCE(pages.chunker_version, 0), ${SAFE_FENCE_CHUNKER_VERSION - 1}) END`;
}

export function requiresSafeChunks(scope?: PageReadScope): boolean {
  return scope?.requireSafeChunks ?? scope?.excludePrivate ?? false;
}

/** Older fragments lack trustworthy provenance, even if markers were removed later. */
export function safeChunksFilter(alias: string): string {
  return `COALESCE(${alias}.chunker_version, 0) >= ${SAFE_FENCE_CHUNKER_VERSION}`;
}

/**
 * Preserve an existing seal for an embedding-only refresh of the exact chunk
 * snapshot. Additions, removals and textual metadata changes invalidate before
 * the first mutation, including partial failures outside an import transaction.
 * Both engines canonicalize chunk_text before calling, and persist/hash those
 * same bytes. Identity and enum fields retain their existing rejection policy.
 */
export function chunkWriteInvalidation(pageId: number, chunks: ChunkInput[]): { sql: string; params: unknown[] } {
  const metadata = ['language', 'symbol_name', 'symbol_type', 'start_line', 'end_line', 'parent_symbol_path', 'doc_comment', 'symbol_name_qualified'] as const;
  const incoming = chunks.map(chunk => Object.fromEntries(
    ['chunk_index', 'chunk_text', 'chunk_source', 'modality', ...metadata].map(key => [key, chunk[key as keyof ChunkInput] ?? null]),
  ));
  return {
    sql: `UPDATE pages SET chunker_version = -1 WHERE id = $1 AND (
      NOT (${safeChunksFilter('pages')}) OR EXISTS (
        SELECT 1 FROM (SELECT * FROM content_chunks WHERE page_id = $1) cc
        FULL JOIN jsonb_to_recordset($2::text::jsonb) AS incoming(
          chunk_index int, chunk_text text, chunk_source text, modality text,
          language text, symbol_name text, symbol_type text, start_line int,
          end_line int, parent_symbol_path text[], doc_comment text, symbol_name_qualified text)
          ON incoming.chunk_index = cc.chunk_index
        WHERE cc.id IS NULL OR incoming.chunk_index IS NULL
          OR cc.chunk_text IS DISTINCT FROM incoming.chunk_text
          OR cc.chunk_source IS DISTINCT FROM incoming.chunk_source
          OR cc.modality IS DISTINCT FROM COALESCE(incoming.modality, 'text')
          ${metadata.map(key => `OR cc.${key} IS DISTINCT FROM COALESCE(incoming.${key}, cc.${key})`).join('\n          ')}
      ))`,
    params: [pageId, JSON.stringify(incoming)],
  };
}
