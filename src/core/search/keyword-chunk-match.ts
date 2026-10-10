/**
 * The chunk side of the Postgres keyword statement (PostgresEngine.searchKeyword):
 * where `cc` comes from, the full-text match, and the text-modality filter.
 *
 * excludePrivate (remote callers) adds correlated visibility subplans that
 * inflate the cost of every join plan, so a cheaper bitmap scan on the match
 * fell within the planner's 1% fuzz of a serial seq scan and lost on startup
 * cost; that seq scan detoasts every chunk's search_vector (~1.1 s for a
 * common term at 250k chunks). The OFFSET 0 subquery plans the match on its
 * own. Without those subplans the join plans well, often in parallel, which
 * an OFFSET subquery would forbid, so it stays unfenced.
 *
 * `modality = 'text'` (v0.27.1) hides image rows from text-keyword search so
 * OCR text doesn't drown text-page hits; image search runs a separate vector
 * path on embedding_image.
 *
 * `ftsLang` must already be validated (getFtsLanguage); `$1` is the websearch text.
 */
export function buildKeywordChunkMatch(ftsLang: string, excludePrivate: boolean | undefined): { from: string; match: string; modality: string } {
  const tsq = `websearch_to_tsquery('${ftsLang}', $1)`;
  if (!excludePrivate) return { from: 'content_chunks cc', match: `cc.search_vector @@ ${tsq}`, modality: `AND cc.modality = 'text'` };
  return {
    from: `(
          SELECT id, page_id, chunk_index, chunk_text, chunk_source, search_vector, language, symbol_type
          FROM content_chunks
          WHERE search_vector @@ ${tsq} AND modality = 'text'
          OFFSET 0
        ) cc`,
    match: 'true',
    modality: '',
  };
}
