/**
 * Run status and exit semantics for `gbrain extract-conversation-facts`:
 * a partial run (some pages extracted, some failed) is a success that lists
 * its failed pages; only a run where every attempted page failed, or a model
 * without pricing, exits nonzero.
 */
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
  if (result.failed_pages.length < FAILED_PAGES_LISTED) result.failed_pages.push({ slug, error: error.slice(0, 300) });
}

