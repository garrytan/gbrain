/**
 * Run status and exit semantics for `gbrain extract-conversation-facts`:
 * a partial run (some pages extracted, some failed) is a success that lists
 * its failed pages; only a run where every attempted page failed, or a model
 * without pricing, exits nonzero.
 */
import type { ParseResult } from '../conversation-parser/types.ts';

interface RunCounts { pages_failed: number; pages_processed: number }
interface FailedPages { failed_pages: Array<{ slug: string; error: string }> }

const FAILED_PAGES_LISTED = 50;

/** ok: nothing failed; partial: some pages extracted and some failed; failed: every attempted page failed. */
export function extractRunStatus(r: RunCounts): 'ok' | 'partial' | 'failed' {
  return r.pages_failed === 0 ? 'ok' : r.pages_processed > 0 ? 'partial' : 'failed';
}

/** CLI exit status: 0 for ok and partial runs; 1 when every attempted page failed or a model has no pricing. */
export function extractExitCode(r: RunCounts, unpricedModels: number): 0 | 1 {
  return extractRunStatus(r) === 'failed' || unpricedModels > 0 ? 1 : 0;
}

/** Keep the first 50 failed pages with their error for the summary and the JSON envelope. */
export function recordFailedPage(result: FailedPages, slug: string, error: string): void {
  listRunPage(result.failed_pages, { slug, error: error.slice(0, 300) });
}

/** Keep the first 50 entries of a per-page list in the summary and the JSON envelope. */
export function listRunPage<T>(list: T[], entry: T): void {
  if (list.length < FAILED_PAGES_LISTED) list.push(entry);
}

/** GST-3251: why a page's parse produced no speaker turns, for unparsed_pages and the SKIP line. */
export function unparsedCause(parse: ParseResult, llmFallback: boolean): string {
  const fallback = llmFallback && parse.phase === 'no_match' ? '; the LLM fallback found none either' : '';
  const nm = parse.no_match;
  if (nm?.reason === 'label_list') return `the best format, ${nm.pattern_id}, gave turns with no repeated speaker (a list of labels, not a conversation)${fallback}`;
  if (nm && nm.score === 0) return `no line matched any conversation format${fallback}`;
  if (nm) return `no conversation format matched: the closest, ${nm.pattern_id}, matched ${(nm.score * 100).toFixed(1)}% of lines, under the 5% floor${fallback}`;
  if (parse.phase === 'no_match') return `the page body is empty or every built-in format is disabled${fallback}`;
  return `the ${parse.matched_pattern_id ?? parse.phase} format matched no message lines`;
}
