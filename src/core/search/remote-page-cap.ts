/**
 * GBRA-156: the default page cap of a remote `search` or `query` that names no `limit`.
 *
 * The keyword arm returns only pages that matched the query. With an embedding
 * model on, the vector arm fills the rest of the mode's row limit with every
 * page it can reach, however weakly related, so an agent asking one question
 * read most of a small brain: on the multi-member harness, a median 13 pages a
 * call against keyword's 1, with a page from another member's source in 46 of
 * 51 calls. Rank 1 was never such a page. Cutting at 3 pages left one in 12
 * calls; 4 left 23, and 2 left 9 while keeping a third fewer readable pages,
 * so the default cap is 3.
 *
 * The cap keeps every page with lexical evidence (a keyword or title hit, an
 * alias or exact identity match, a pinned relational answer), exactly the
 * pages the keyword path returns, and lets vector-only pages fill the result
 * only up to `search.remote_page_cap` distinct pages in total. A query with
 * no lexical match still gets its top vector pages. An explicit `limit`, a
 * paged call (offset > 0), every trusted local caller and a host subagent
 * tool call (`viaSubagent`) that no remote client delegated keep today's rows;
 * `0` turns the cap off.
 */
import type { OperationContext } from '../ops/contract.ts';
import type { SearchResult } from '../types.ts';

export const REMOTE_PAGE_CAP_KEY = 'search.remote_page_cap';
export const DEFAULT_REMOTE_PAGE_CAP = 3;

/** `_meta.retrieval.page_cap` when the cap left pages out; `kept_pages` counts the pages the cap kept, before later stages (alias fan-out, query arms) add or drop rows. */
export interface RemotePageCapMeta {
  cap: number;
  kept_pages: number;
  dropped_pages: number;
}

/** The cap for one call, or null when it does not apply. */
export async function remotePageCap(ctx: OperationContext, p: Record<string, unknown>): Promise<number | null> {
  if (ctx.remote === false || (ctx.viaSubagent === true && !ctx.auth) || p.limit || p.offset) return null;
  const raw = await ctx.engine.getConfig(REMOTE_PAGE_CAP_KEY).catch(() => null);
  const n = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  const cap = Number.isInteger(n) && n >= 0 ? n : DEFAULT_REMOTE_PAGE_CAP;
  return cap === 0 ? null : cap;
}

/** The model-visible line when the cap left pages out (hosts that show only `content[]` never see `_meta`); `how` names the parameter the reader passes. */
export function pageCapLine(retrieval: unknown, how = 'limit'): string | null {
  const m = (retrieval as { page_cap?: RemotePageCapMeta } | null)?.page_cap;
  if (!m) return null;
  return `[gbrain search] ${m.dropped_pages} more pages matched only by meaning and were left out (default remote cap ${m.cap}). Pass ${how} to read them.`;
}

function hasLexicalEvidence(r: SearchResult): boolean {
  return r.keyword_hit === true || r.alias_hit === true || r.exact_lookup !== undefined || r.relational_pinned === true;
}

/** Keeps every lexically matched page and the top vector-only pages up to `cap` distinct pages. */
export function capVectorOnlyPages(rows: SearchResult[], cap: number | null): { rows: SearchResult[]; meta?: RemotePageCapMeta } {
  if (cap === null) return { rows };
  const pageOf = (r: SearchResult) => `${r.source_id ?? ''}\u0000${r.slug}`;
  const pages = new Set(rows.filter(hasLexicalEvidence).map(pageOf));
  const dropped = new Set<string>();
  const kept = rows.filter((r) => {
    const page = pageOf(r);
    if (pages.has(page)) return true;
    if (pages.size < cap) { pages.add(page); return true; }
    dropped.add(page);
    return false;
  });
  return dropped.size === 0 ? { rows } : { rows: kept, meta: { cap, kept_pages: pages.size, dropped_pages: dropped.size } };
}
