/**
 * GST-2735: the keyless any-word fill. On a brain with no embedding provider a
 * first page shorter than the limit gets a second run of the same request with
 * the any-word fill on in the keyword arm (SearchOpts.orFill), so its rows pass
 * every stage the first run's did: post-fusion annotations (supersession),
 * collapse and redirects, rank priors, the evidence gate and its injection
 * detector. The answer is the first run's rows, the same objects, followed by
 * the second run's rows whose page, collapsed family or redirect target the
 * first run does not hold, in the second run's order, each marked keyword_fill
 * and scored below the first run's last row, within the limit and the token
 * budget. A later page (offset above zero), a caller-requested keyword-only
 * retrieval (decide.keywordOnly) and a keyword arm whose strict rows were none
 * or filled its pool get no second run.
 */
import type { BrainEngine } from '../../engine.ts';
import type { SearchResult } from '../../types.ts';
import type { HybridSearchOpts } from '../hybrid.ts';
import type { HybridRequest } from './request.ts';
import type { LexicalArms } from './arms.ts';
import { enforceTokenBudget } from '../token-budget.ts';

type Search = (engine: BrainEngine, query: string, opts?: HybridSearchOpts) => Promise<SearchResult[]>;

export async function withAnyWordFill(
  search: Search,
  req: HybridRequest,
  { earlyModality, keywordResults }: LexicalArms,
  rows: SearchResult[],
): Promise<SearchResult[]> {
  const { engine, query, opts, limit, offset, resolvedMode } = req;
  if (opts?._anyWordFill || opts?.decide?.keywordOnly || offset > 0 || rows.length >= limit || earlyModality === 'image') return rows;
  if (keywordResults.length === 0 || keywordResults.some(r => r.keyword_relaxed) || keywordResults.length >= (req.searchOpts.limit ?? Infinity)) return rows;
  const quiet = Object.fromEntries(Object.entries(opts ?? {}).filter(([k, v]) => typeof v !== 'function' && k !== 'explainTarget' && k !== '_timings'));
  const second = await search(engine, query, { ...quiet, _anyWordFill: true } as HybridSearchOpts);
  const key = (slug: string, sourceId: string | undefined) => `${sourceId ?? 'default'}:${slug}`;
  const pagesOf = (r: SearchResult) => [key(r.slug, r.source_id), ...(r.collapsed ?? []).map(c => key(c.slug, c.source_id ?? r.source_id)), ...(r.redirect_to ? [key(r.redirect_to, r.source_id)] : [])];
  const held = new Set(rows.flatMap(pagesOf));
  const added: SearchResult[] = [];
  for (const r of second) {
    if (rows.length + added.length >= limit) break;
    const pages = pagesOf(r);
    if (pages.some(p => held.has(p))) continue;
    for (const p of pages) held.add(p);
    added.push(r);
  }
  if (added.length === 0) return rows;
  let ceiling = rows.length ? Math.min(...rows.map(r => r.score)) : Infinity;
  const below = (score: number) => {
    const cap = Number.isFinite(ceiling) ? ceiling - Math.max(Math.abs(ceiling) * 0.01, Number.EPSILON) : Infinity;
    const next = Math.min(Number.isFinite(score) ? score : cap, cap);
    ceiling = Number.isFinite(next) ? next : 0;
    return ceiling;
  };
  const fill = added.map(r => ({ ...r, keyword_fill: true as const, score: below(r.score) }));
  opts?.explainTarget?.observe('arm:keyword_fill', fill);
  return enforceTokenBudget([...rows, ...fill], resolvedMode.tokenBudget).results;
}
