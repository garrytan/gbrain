/**
 * Exact widening glue for the `search` and `query` ops (search/exact-widen.ts for the rules): runs the literal
 * scan `search_exact` uses, through the same caller read policy (scanExactForCaller), for the query's content terms
 * as a phrase, and merges the pages it finds into the returned rows. Any failure leaves the rows as they were.
 */
import type { OperationContext } from './contract.ts';
import type { SearchResult, PageType } from '../types.ts';
import { scanExactForCaller } from './search-exact.ts';
import { applySearchFactsArm } from '../search/query-arms.ts';
import type { SearchTimings } from '../search/stage-timings.ts';
import { EXACT_MAX_LIMIT } from '../search/exact-scan.ts';
import { EXACT_WIDEN_MAX_PAGES, EXACT_WIDEN_SECONDS, exactWidenEnabled, markExactWidened, mergeExactHits, widenPhrase, widenReason } from '../search/exact-widen.ts';

export { exactWidenRan } from '../search/exact-widen.ts';

/** The facts arm for `search` (search/query-arms.ts applySearchFactsArm) under the op's scope and read policy, timed as the `facts_arm` stage. */
export function searchFactsArm(ctx: OperationContext, p: Record<string, unknown>, query: string, results: SearchResult[],
  o: { scope: ExactWidenInput['scope']; excludePrivate: boolean; filtered: boolean; queryEmbedding: Float32Array | null; limit: number; timings: SearchTimings }): Promise<SearchResult[]> {
  return o.timings.stage('facts_arm', () => applySearchFactsArm(ctx.engine, p, query, results, { ...o.scope, excludePrivate: o.excludePrivate, requireSafeChunks: ctx.remote !== false,
    filtered: o.filtered, remote: ctx.remote !== false, queryEmbedding: o.queryEmbedding, rowCap: async () => o.limit }));
}

export interface ExactWidenInput {
  scope: { sourceId?: string; sourceIds?: string[]; minTrust?: import('../trust/tier.ts').TrustTier };
  /** The caller's row count. */
  limit: number;
  degraded?: ReadonlyArray<{ stage?: string; reason?: string }>;
  /** The call's own timings object: the key meta reads `exact_widened` back by. */
  callKey: object;
  /** types, where or a language or symbol constraint: the scan cannot honor them, so none runs. */
  filtered: boolean;
}

export interface ExactWidened {
  results: SearchResult[];
  added: SearchResult[];
  /** An evidence delivery's rows with the merged rows appended (undefined stays undefined). */
  delivered: <D extends { rows: SearchResult[] }>(d: D | undefined) => D | undefined;
}

export async function exactWiden(ctx: OperationContext, p: Record<string, unknown>, query: string, results: SearchResult[], o: ExactWidenInput): Promise<ExactWidened> {
  const unchanged: ExactWidened = { results, added: [], delivered: d => d };
  try {
    if (p.offset || p.cursor || p.match === 'keyword' || o.filtered || p.since || p.until || p.lang || p.symbol_kind || p.near_symbol) return unchanged;
    if (!await exactWidenEnabled(ctx.engine)) return unchanged;
    const phrase = widenPhrase(query);
    const reason = phrase && widenReason(results, phrase.terms, o.degraded);
    if (!phrase || !reason) return unchanged;
    markExactWidened(o.callKey);
    const scan = await scanExactForCaller(ctx, { phrase: phrase.phrase, scope: o.scope, ...(o.scope.minTrust ? { minTrust: o.scope.minTrust } : {}),
      limit: Math.min(EXACT_MAX_LIMIT, results.length + EXACT_WIDEN_MAX_PAGES), deadlineMs: Date.now() + EXACT_WIDEN_SECONDS * 1000, ftsTerms: phrase.terms });
    if (!scan.visible.length) return unchanged;
    const chunks = await ctx.engine.executeRaw<{ id: number; page_id: number; chunk_index: number }>(
      `SELECT id, page_id, chunk_index FROM content_chunks WHERE (page_id, chunk_index) IN (SELECT * FROM unnest($1::int[], $2::int[]))`,
      [scan.visible.map(m => m.page_id), scan.visible.map(m => m.snippets[0]?.chunk_index ?? 0)]);
    const chunkId = new Map(chunks.map(c => [`${c.page_id}:${c.chunk_index}`, Number(c.id)]));
    const hits: SearchResult[] = scan.visible.filter(m => m.snippets.length).map(m => {
      const first = m.snippets[0]!;
      return { slug: m.slug, page_id: m.page_id, title: m.title, type: m.type as PageType, chunk_text: m.snippets.map(s => s.text).join('\n'), chunk_source: first.chunk_source as SearchResult['chunk_source'],
        chunk_id: chunkId.get(`${m.page_id}:${first.chunk_index}`) ?? 0, chunk_index: first.chunk_index, score: 0, stale: false, source_id: m.source_id, widened: 'exact' as const };
    });
    const merged = mergeExactHits(results, hits, o.limit, reason === 'thin');
    if (!merged.added.length) return unchanged;
    return { results: merged.rows, added: merged.added, delivered: d => d && { ...d, rows: [...d.rows, ...merged.added] } };
  } catch {
    return unchanged;
  }
}
