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
/**
 * Most matching chunks the Postgres keyword statement ranks (GBRA-156).
 * ts_rank runs on every row it is given, so a query whose terms match
 * hundreds of thousands of chunks (one common word on a 2M-chunk brain)
 * spent 3-8 s ranking and ran into the keyword statement timeout, which
 * returns no rows at all. The statement takes the first matching chunks
 * that pass its filters, up to this bound, and ranks those; a match set under
 * the bound ranks exactly as before. When the bound applies the caller is
 * told (SearchOpts.onKeywordIncomplete), and hybrid reports
 * `keyword_candidates_incomplete`, because the rows come from a sample.
 */
export const KEYWORD_RANK_CANDIDATES = 50_000;

/**
 * Transaction-local settings for the keyword statement. At the 4 MB
 * `work_mem` default, the bitmap over a common word's matches goes lossy, so
 * the heap scan rechecks every row's tsvector, and the bounded candidate sort
 * spills to disk: a remote caller's bounded any-word retry took 6.6 s on the
 * 2M-chunk bench against 1.4 s at 32 MB (128 MB measured the same). The
 * bound keeps the memory this can use per statement small.
 */
export const KEYWORD_STATEMENT_SETTINGS = { work_mem: '32MB' } as const;

/**
 * The display columns of the keyword statement's ranked chunks, joined by key
 * after ranking (`ranked_chunks` carries only page_id, chunk_id, score and
 * bounded_rows). Ranking reads only the score, so the rows and their order are
 * unchanged, except where the KEYWORD_RANK_CANDIDATES bound applies: its
 * sample is the first matches in plan order, and the wider rows used to split
 * the match's hash join into work_mem batches, which reordered it (the rows
 * equal the wide statement's at a work_mem without batches). What changes is
 * that the up to KEYWORD_RANK_CANDIDATES matches no longer carry chunk_text
 * and the frontmatter columns through the per-page window sort and the
 * bounded-row count. With them, a 46k-match OR
 * retry sorted 1.3 KB rows and spilled 57 MB to disk, and the windows
 * buffered the same rows again; now only the at most `innerLimit` ranked
 * chunks are read for display. Each is one primary-key probe whose LIMIT 1
 * keeps the subquery from being pulled up into a join: as a plain join, the
 * planner (estimating a few dozen ranked rows) sorted every page by source and slug for the per-page dedup and filtered
 * the ranked rows against all of them (15M join-filter rows, 2 s).
 */
// chunk-visibility-ok: joins by id only the chunks ranked_chunks selected under the statement's visibility clause
export const KEYWORD_RANKED_ROWS_CTE = `ranked_rows AS (
        SELECT p.slug, rc.page_id, p.title, p.type, p.source_id,
          p.effective_date, p.effective_date_source,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
          rc.chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source, rc.score, rc.bounded_rows
        FROM ranked_chunks rc
        CROSS JOIN LATERAL (SELECT c.chunk_index, c.chunk_text, c.chunk_source FROM content_chunks c WHERE c.id = rc.chunk_id LIMIT 1) cc
        CROSS JOIN LATERAL (SELECT pg.slug, pg.title, pg.type, pg.source_id, pg.effective_date, pg.effective_date_source, pg.frontmatter
          FROM pages pg WHERE pg.id = rc.page_id LIMIT 1) p
      )`;

export function buildKeywordChunkMatch(ftsLang: string, excludePrivate: boolean | undefined): { from: string; match: string; modality: string } {
  const tsq = `websearch_to_tsquery('${ftsLang}', $1)`;
  if (!excludePrivate) return { from: 'content_chunks cc', match: `cc.search_vector @@ ${tsq}`, modality: `AND cc.modality = 'text'` };
  return {
    // chunk-visibility-ok: the outer search statement applies buildVisibilityClause(..., { chunkAlias: 'cc' }) to the generation columns this subquery projects
    from: `(
          SELECT id, page_id, chunk_index, chunk_text, chunk_source, search_vector, language, symbol_type, body_generation, occurrence_id
          FROM content_chunks
          WHERE search_vector @@ ${tsq} AND modality = 'text'
          OFFSET 0
        ) cc`,
    match: 'true',
    modality: '',
  };
}
