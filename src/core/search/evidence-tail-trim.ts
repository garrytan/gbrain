/**
 * Protected tail trim (`search.evidence_tail_trim`, default off): under
 * `return_unit: auto`, drop whole-conversation blocks past the top 3 whose
 * search score is under half of rank one's, so a reader gets the evidence
 * that matters with about a third fewer tokens on the questions it touches
 * (GBRA-162 wave A2, LongMemEval-S: non-inferior on three reader models,
 * 36.6% fewer delivered tokens on the 217 affected questions).
 *
 * Query-term guard: a tail block that holds the query's terms nearly as fully
 * as rank one (at least 80% of rank one's share) is kept. The unguarded trim
 * reliably broke one knowledge-update question whose earlier value sat in a
 * low-scoring session that restated the same fact; on the frozen wave A2
 * evidence this guard keeps that block and 14 others of the 398 dropped,
 * and the saving stays at about 35%.
 *
 * The trim needs the query and a usable score on every row; without them it
 * does nothing. Ranked chunks, saved facts and long pages are never dropped.
 */
import type { DeliveredSearchResult } from './evidence-delivery.ts';

export const EVIDENCE_TAIL_TRIM_KEY = 'search.evidence_tail_trim';
export const TAIL_TRIM_PROTECTED = 3;
export const TAIL_TRIM_SCORE_FRACTION = 0.5;
export const TAIL_TRIM_TERM_FRACTION = 0.8;

/** `delivery.tail_trim`: blocks dropped, and blocks under the score cut the query-term guard kept. */
export interface TailTrimMeta { dropped: number; kept_by_query_terms: number }

const STOPWORDS = new Set(('a an the of to in on for and or is are was were be been am do does did have has had i my me we our you your it its this that ' +
  'what which who whom how many much when where why with at by from as about any some all not no so than then there their they them he she his her ' +
  'up out into over after before again more most other such only own same can will just should now could would get got also').split(' '));

/** Query terms: lowercased letter/digit runs, stopwords and single characters dropped, each cut to its first six characters. */
export function queryTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) if (w.length > 1 && !STOPWORDS.has(w)) out.add(w.slice(0, 6));
  return out;
}

function termShare(terms: Set<string>, text: string): number {
  if (terms.size === 0) return 0;
  const have = queryTerms(text);
  let n = 0;
  for (const t of terms) if (have.has(t)) n++;
  return n / terms.size;
}

const wholeConversation = (r: DeliveredSearchResult) => r.delivered.reason === 'conversation_type' || r.delivered.reason === 'conversation_slug';

/** Rank-order rows in, rank-order rows out; the meta is returned whenever the trim ran. */
export function trimEvidenceTail(results: DeliveredSearchResult[], query: string): { results: DeliveredSearchResult[]; meta: TailTrimMeta } {
  const meta: TailTrimMeta = { dropped: 0, kept_by_query_terms: 0 };
  const top = results[0]?.score;
  if (!(Number.isFinite(top) && top > 0) || results.some(r => !Number.isFinite(r.score))) return { results, meta };
  const terms = queryTerms(query);
  const guard = TAIL_TRIM_TERM_FRACTION * termShare(terms, results[0].chunk_text ?? '');
  const kept = results.filter((r, i) => {
    if (i < TAIL_TRIM_PROTECTED || !wholeConversation(r) || r.score >= TAIL_TRIM_SCORE_FRACTION * top) return true;
    if (guard > 0 && termShare(terms, r.chunk_text ?? '') >= guard) { meta.kept_by_query_terms++; return true; }
    meta.dropped++;
    return false;
  });
  return { results: kept, meta };
}

/** `search.evidence_tail_trim` is on ('true' | 'on' | '1' | 'yes'); off by default and on any read error. */
export async function evidenceTailTrimEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(EVIDENCE_TAIL_TRIM_KEY))?.trim().toLowerCase();
    return raw === 'true' || raw === 'on' || raw === '1' || raw === 'yes';
  } catch {
    return false;
  }
}
