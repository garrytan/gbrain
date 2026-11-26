/**
 * The keyword count's wording, shared by the MCP line (keyword-paging.ts) and
 * the CLI. Import-free on purpose: the warm CLI socket path renders a reply
 * with these and must not load the engine, driver or AI graph
 * (test/cli-socket-warm-graph.test.ts).
 */

/** Counts stop here; a capped count is reported as "10000+". */
export const KEYWORD_COUNT_CAP = 10_000;

export const countWords = (n: number, capped: boolean | undefined) => `${capped ? `${n}+` : n} page${n === 1 && !capped ? '' : 's'}`;

/** Why the count is unavailable, read from the `keyword_count_unavailable` degraded stage. */
export function countUnavailableReason(r: Record<string, unknown>): 'timeout' | 'error' {
  const stage = Array.isArray(r.degraded) ? r.degraded.find(d => (d as { stage?: unknown })?.stage === 'keyword_count_unavailable') : undefined;
  return (stage as { reason?: unknown } | undefined)?.reason === 'timeout' ? 'timeout' : 'error';
}

/**
 * #9412: the CLI's stderr line for `gbrain search` / `gbrain query` (null when
 * the call carries no count). With rows, no literal match and no entity the
 * query names, it says the rows matched only by meaning, or, when the any-word
 * retry supplied rows, only some of the words.
 */
export function cliKeywordCountLine(rows: unknown[], retrieval: Record<string, unknown> | null): string | null {
  if (!retrieval) return null;
  const r = retrieval;
  const unavailable = `Keyword match count unavailable (${countUnavailableReason(r) === 'timeout' ? 'timed out' : 'failed'}; not a count of zero).`;
  if (r.match === 'keyword') {
    if (typeof r.total !== 'number') return unavailable;
    const shown = Number(r.shown_to) < Number(r.shown_from) ? 'none on this page' : `showing ${r.shown_from}-${r.shown_to}`;
    return `Keyword matches: ${countWords(r.total, r.total_capped === true)}; ${shown}.${r.truncated === true ? ` More: rerun with --offset ${r.shown_to}.` : ' No more keyword matches.'}`;
  }
  if (!('keyword_total' in r)) return null;
  if (typeof r.keyword_total !== 'number') return unavailable;
  if (r.keyword_total === 0 && rows.length > 0 && r.query_entity_resolved !== true) {
    const relaxed = rows.some(x => (x as { keyword_relaxed?: unknown })?.keyword_relaxed === true)
      || (Array.isArray(r.degraded) && r.degraded.some(d => (d as { stage?: unknown })?.stage === 'keyword_relaxed_carried'));
    return relaxed ? 'No page contains all these words (literal match). The rows below contain only some of them, or matched by meaning.'
      : 'No page contains these words (literal match). The rows below matched only by meaning.';
  }
  const unlisted = Array.isArray(r.keyword_unlisted_filters) && r.keyword_unlisted_filters.length
    ? ` (search ignores ${(r.keyword_unlisted_filters as string[]).map(f => `--${f.replace('_', '-')}`).join(', ')}, so it also lists pages this count left out)` : '';
  return `Keyword matches: ${countWords(r.keyword_total, r.keyword_total_capped === true)} (pages containing these words, not a count of these rows). List them all with: gbrain search <words> --match keyword${unlisted}`;
}
