/**
 * think {known_as_of} (W3, docs/architecture/historical-retrieval.md section 6): the evidence branches that run under a
 * recorded-time instant T, each T-bounded or off as the per-branch table says. Pages and takes come from the
 * historical retriever (branches 1, 3, 8, 11), the anchor resolves at T (14), the window filters on the content date
 * of the revision live at T and its floor lists revisions live at T (4), and each body is the one recorded at T under
 * the restrictions bounded by now (15, 16, 23). Every other branch is named in `known_as_of.disabled_branches`.
 */
import type { BrainEngine, TakeHit } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { opError } from '../ops/contract.ts';
import { parseKnownAsOf } from '../belief/page-at-time.ts';
import { anchorAtTime, historicalEvidence, windowFloorAt, type HistoricalPage, type KnownAsOfBlock } from '../belief/historical-search.ts';
import { filterPagesToWindow, type TemporalWindow } from './temporal-window.ts';
import type { ThinkGatherResult } from './gather.ts';
import type { ParsedCitation } from './cite-render.ts';

const GATHER_LIMIT = 40;
const TAKES_LIMIT = 30;

/** The instant a think call reads at, after refusing the parameters no historical read serves (branches 18 and 22). */
export function historicalThinkInstant(opts: { knownAsOf?: string; save?: boolean; take?: boolean; withCalibration?: boolean }): Date | null {
  if (opts.knownAsOf === undefined) return null;
  for (const [name, set] of [['save', opts.save], ['take', opts.take], ['with_calibration', opts.withCalibration]] as const) {
    if (set) throw opError('invalid_params', `think: ${name} cannot be combined with known_as_of.`, `A recorded-time think reads the past and writes nothing; drop ${name}, or drop known_as_of to think over the current brain.`);
  }
  return parseKnownAsOf(opts.knownAsOf);
}

/** The sources a historical think reads: the caller's scope, or every source of the brain (an uncovered one refuses the call). */
export async function historicalSources(engine: BrainEngine, opts: { sourceId?: string; allowedSources?: string[] }): Promise<string[]> {
  if (opts.allowedSources?.length) return [...opts.allowedSources];
  if (opts.sourceId !== undefined && opts.sourceId !== '__all__') return [opts.sourceId];
  return (await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id COLLATE "C"')).map(r => r.id);
}

const toResult = (p: HistoricalPage): SearchResult => ({
  slug: p.slug, page_id: p.page_id ?? 0, title: p.title ?? '', type: p.type ?? '', chunk_text: [p.compiled_truth, p.timeline].filter(t => t.trim().length > 0).join('\n\n'),
  chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0, score: p.score, stale: false, source_id: p.source_id,
  effective_date: p.content_date ? `${p.content_date}T00:00:00.000Z` : null, effective_date_source: p.content_date ? 'date' : null, trust_tier: p.trust_tier,
} as SearchResult);

const isoDay = (ms: number | null) => ms === null ? null : new Date(ms).toISOString().slice(0, 10);

export interface HistoricalThinkGather { gather: ThinkGatherResult; block: KnownAsOfBlock; pages: HistoricalPage[] }

/** The gather of a historical think: the shape runThink renders, from the views bounded by T. */
export async function gatherAtTime(engine: BrainEngine, q: { question: string; at: Date; anchor?: string; sources: string[]; remote: boolean; holders?: string[];
  window: TemporalWindow | null }): Promise<HistoricalThinkGather> {
  const hq = { query: q.question, at: q.at, sources: q.sources, remote: q.remote, holders: q.holders ?? ['world'],
    limit: q.window ? Math.min(GATHER_LIMIT * 4, 200) : GATHER_LIMIT, takesLimit: TAKES_LIMIT };
  const evidence = await historicalEvidence(engine, hq);
  const block = evidence.known_as_of;
  const anchor = q.anchor ? await anchorAtTime(engine, hq, block, q.anchor) : null;
  const floor = q.window ? await windowFloorAt(engine, hq, block, { after: isoDay(q.window.startMs), before: isoDay(q.window.endMs) }) : [];
  const seen = new Set<string>();
  let pages = [...(anchor ? [anchor] : []), ...evidence.pages, ...floor].filter(p => !seen.has(p.lifetime) && !!seen.add(p.lifetime));
  let window: ThinkGatherResult['diagnostics']['window'];
  if (q.window) {
    const filtered = filterPagesToWindow(pages.map(p => ({ p, ...toResult(p) })), q.window);
    window = { dropped: filtered.droppedOutOfWindow, undatedKept: filtered.undatedKept };
    pages = filtered.kept.map(k => k.p).slice(0, GATHER_LIMIT);
  }
  const takes = evidence.takes.map(t => ({ take_id: 0, page_id: 0, page_slug: t.page_slug, row_num: t.row_num, claim: t.claim, kind: t.kind, holder: t.holder,
    weight: t.weight, score: t.score, since_date: t.since_date, trust_tier: t.trust_tier }) as unknown as TakeHit);
  return {
    block, pages,
    gather: { pages: pages.map(toResult), takes, graphSlugs: [], warnings: [],
      diagnostics: { pagesFromHybrid: evidence.pages.length, takesFromKeyword: takes.length, takesFromVector: 0, graphHits: 0, questionSanitizedFor: 'none', ...(window ? { window } : {}) } },
  };
}

/** The prompt's header line (section 6): the instant and whether the read is certified. */
export const knownAsOfHeader = (block: KnownAsOfBlock) => `Recorded state as of ${block.at}; certified: ${block.certified ? 'yes' : 'no'}`;

/** Branch 21: each citation of a page in the evidence carries that page's revision and recorded_at at T. */
export function stampHistoricalCitations(citations: ParsedCitation[], pages: HistoricalPage[]): void {
  for (const c of citations) {
    const page = pages.find(p => p.slug === c.page_slug);
    c.revision = page?.revision ?? null;
    c.recorded_at = page?.recorded_at ?? null;
  }
}
