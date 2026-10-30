/**
 * Rare words in the keyword arm's OR fallback (GBRA-156, after #7471). When
 * no chunk holds every query word, the arm retries with the OR of its words,
 * and ts_rank knows no term rarity: a chunk naming a common word several
 * times outranks the few chunks holding a rare one, so "Acme Quokka" on a
 * brain of Acme notes returned every Acme note before the one Quokka page.
 *
 * For a retry of at most RARITY_MAX_TERMS words, one statement reads, per
 * word, the pages of up to RARE_TERM_CHUNK_CAP chunks that hold it (index
 * served, read-only, and only compared against rows the retry already
 * authorized). A word whose chunks all fit is rare and weighs 1 / its page
 * count. The engine runs its retry statement once more with the OR of the
 * rarest words whose pages together fit the limit, ranked with the full OR
 * query, so rows the first retry's limit cut come back with comparable
 * scores. Rows sort by the summed weight of the
 * rare words their page holds, then in retry order. With no rare word, or
 * when the read fails, the retry's rows are returned unchanged.
 */
import { chunkVisibleFilter } from './safe-chunks.ts';
import { orFallbackTokens } from './sql-ranking.ts';

/** OR retries of at most this many words rank rare words first (this module and the title arm's rankByRarity). */
export const RARITY_MAX_TERMS = 4;

/** A word matching at most this many chunks is rare; the read stops one past it. */
export const RARE_TERM_CHUNK_CAP = 400;

/** Per word (`$1` text[]), the distinct pages of its first `$2` + 1 matching text chunks and that chunk count. */
export function rareTermPagesSql(ftsLang: string): string {
  return `SELECT u.term,
      (SELECT count(*) FROM (SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE cc.search_vector @@ websearch_to_tsquery('${ftsLang}', u.term) AND cc.modality = 'text' AND ${chunkVisibleFilter('p', 'cc')} LIMIT $2::int + 1) m)::int AS chunks,
      ARRAY(SELECT DISTINCT m.page_id FROM (SELECT cc.page_id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE cc.search_vector @@ websearch_to_tsquery('${ftsLang}', u.term) AND cc.modality = 'text' AND ${chunkVisibleFilter('p', 'cc')} LIMIT $2::int + 1) m) AS page_ids
    FROM unnest($1::text[]) WITH ORDINALITY AS u(term, ord)
    ORDER BY u.ord`;
}

export interface RareTermPages { term: string; chunks: number | string; page_ids: unknown[] }

export async function rankOrFallbackByRarity<R>(args: {
  query: string;
  rows: R[];
  limit: number;
  offset: number;
  readTermPages: (terms: string[]) => Promise<RareTermPages[]>;
  runRare: (rareOrQuery: string) => Promise<R[]>;
}): Promise<R[]> {
  const terms = orFallbackTokens(args.query);
  if (terms.length < 2 || terms.length > RARITY_MAX_TERMS || args.offset > 0) return args.rows;
  const read = await args.readTermPages(terms).catch(() => null);
  const rare = (read ?? []).filter(t => Number(t.chunks) > 0 && Number(t.chunks) <= RARE_TERM_CHUNK_CAP && t.page_ids.length > 0);
  if (rare.length === 0) return args.rows;
  const weight = new Map<string, number>();
  for (const t of rare) for (const id of t.page_ids) weight.set(String(id), (weight.get(String(id)) ?? 0) + 1 / t.page_ids.length);
  const fetch: string[] = [];
  let pages = 0;
  for (const t of [...rare].sort((a, b) => a.page_ids.length - b.page_ids.length)) {
    if (pages + t.page_ids.length > args.limit) break;
    pages += t.page_ids.length;
    fetch.push(t.term);
  }
  const rareRows = fetch.length ? await args.runRare(fetch.join(' OR ')).catch(() => [] as R[]) : [];
  const ids = (r: R) => r as { page_id?: unknown; chunk_id?: unknown };
  const seen = new Set(args.rows.map(r => `${ids(r).page_id}:${ids(r).chunk_id}`));
  const pool = [...args.rows, ...rareRows.filter(r => !seen.has(`${ids(r).page_id}:${ids(r).chunk_id}`))];
  return pool
    .map((row, i) => ({ row, i, w: weight.get(String(ids(row).page_id)) ?? 0 }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, args.limit)
    .map(e => e.row);
}
