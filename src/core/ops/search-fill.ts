/**
 * GST-2762: how the search and query operations take the keyless any-word
 * fill (search/hybrid/keyword-only.ts): only when it leaves every other row as
 * it is without it.
 */
import type { SearchResult } from '../types.ts';
import type { BrainEngine } from '../engine.ts';
import { keepFrontmatterMatches } from '../search/frontmatter-where.ts';
import { stampDeepResearchIds } from './context.ts';

/** GST-2762: the rows without the keyless any-word fill's rows (the same array when it added none). */
export const withoutFill = (rows: SearchResult[]): SearchResult[] => rows.some(r => r.keyword_fill) ? rows.filter(r => !r.keyword_fill) : rows;

/**
 * GST-2762: the keyless any-word fill reaches the caller only when every other
 * row stays exactly as it is without the fill. reference is the op's stages
 * over the pipeline's rows less the fill. A fill row is kept only for a page
 * the reference does not already return and only while the page is under
 * limit; rerun then repeats the stages over the pipeline's other rows plus
 * those, so a fill row passes each stage like any other row. That second
 * result, its fill rows placed last, is returned with its evidence delivery
 * only when its rows less the fill, and what compared reads from it, equal the
 * reference's before delivery and (delivery's own per-row record aside) after
 * it. Otherwise, or when the rerun or the fill's delivery fails (GST-2786),
 * the reference is returned and the fill is withheld for this request.
 */
export async function chooseFill<T extends { results: SearchResult[] }, D extends { rows: SearchResult[] }>(found: SearchResult[], reference: T, limit: number, rerun: (hits: SearchResult[]) => Promise<T>,
  compared: (t: T) => unknown, deliver: (rows: SearchResult[]) => Promise<D>): Promise<T & { delivered?: D }> {
  const page = (r: SearchResult) => JSON.stringify([r.source_id ?? 'default', r.slug]);
  const returned = new Set(reference.results.map(page));
  const fill = found.filter(r => r.keyword_fill && !returned.has(page(r))).slice(0, Math.max(0, limit - reference.results.length));
  if (!fill.length) return reference;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  let again: T;
  try { again = await rerun([...withoutFill(found), ...fill]); } catch { return reference; }
  const filled = { ...again, results: [...withoutFill(again.results), ...again.results.filter(r => r.keyword_fill)] };
  if (!same(compared({ ...filled, results: withoutFill(filled.results) }), compared(reference))) return reference;
  const base = await deliver(reference.results);
  let delivered: D;
  try { delivered = await deliver(filled.results); } catch { return { ...reference, delivered: base }; }
  // Delivery's own per-row record (delivered) is left out: it appears on every row once any row is expanded, and the row's text is compared.
  const text = (rows: SearchResult[]) => rows.map(({ delivered: _record, ...row }: SearchResult & { delivered?: unknown }) => row);
  return same(text(withoutFill(delivered.rows)), text(base.rows)) ? { ...filled, delivered } : { ...reference, delivered: base };
}

/**
 * GST-2762, the query op: both runs keep only the rows that match the caller's
 * frontmatter filter and get their deep-research ids; an escalated CRAG run has
 * no reference to compare the fill against, so it keeps its rows without the fill.
 */
export async function queryFillPage<T extends { results: SearchResult[] }, D extends { rows: SearchResult[] }>(engine: BrainEngine, where: Parameters<typeof keepFrontmatterMatches>[2], found: SearchResult[], reference: T, results: SearchResult[],
  escalated: boolean | undefined, limit: () => Promise<number>, stages: (hits: SearchResult[]) => Promise<T>, compared: (t: T) => unknown, deliver: (rows: SearchResult[]) => Promise<D>): Promise<T & { delivered?: D }> {
  const finish = async (rows: SearchResult[]) => {
    const kept = (await keepFrontmatterMatches(engine, rows, where)).map(r => ({ ...r }));
    stampDeepResearchIds(kept);
    return kept;
  };
  if (escalated) return { ...reference, results: await finish(results) };
  return chooseFill(found, { ...reference, results: await finish(results) }, await limit(), async hits => { const again = await stages(hits); return { ...again, results: await finish(again.results) }; }, compared, deliver);
}
