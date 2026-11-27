/**
 * The saved facts `search` and `query` report beside their rows
 * (`retrieval.saved_facts`, after the facts of the entity the query names):
 * active facts that share the query's words, matched as stemmed whole words.
 * `search.saved_facts_supersede` (default on) adds correction-cue ordering.
 * Tests: test/search-saved-facts-match.test.ts, test/search-saved-facts.test.ts,
 * test/search/saved-facts-probe.test.ts.
 */
import type { OperationContext } from '../ops/contract.ts';
import type { TrustTier } from '../trust/tier.ts';
import { collapseFactReads } from '../facts/capture-dedup.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { hasCJK } from '../cjk.ts';
import { resolveExcludePrivatePages, worldOnlyFacts } from './private-visibility.ts';
import { type CollapseColumns } from './entity-facts.ts';

/** Words too common to count toward a saved-fact match; also the coverage relevance stopwords in ops/search.ts. */
export const FACT_MATCH_STOPWORDS = new Set(['the', 'and', 'for', 'who', 'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'our', 'your', 'their', 'now', 'current', 'currently', 'should', 'does', 'did', 'has', 'have', 'how', 'any', 'all', 'about', 'into', 'its', 'next']);

/** Words that frame a question about a figure ("seat count", "total revenue") and that the fact stating it rarely repeats; they count toward neither side of the threshold. */
const QUESTION_FRAME_WORDS = new Set(['count', 'number', 'total', 'amount']);

export interface SavedFactMatch { id: number; fact: string; entity_slug: string | null; kind: string; valid_from: string; source: string;
  /** #7043: every entity of the copies this row stands for, and how many rows it stands for. */
  entity_slugs?: string[]; collapsed_count?: number;
  /** With `search.saved_facts_supersede` on: the newer returned fact that corrects this one. */
  corrected_by?: number }

/** The matched facts, and every correction decision made before the five-fact cap (corrected fact id to its corrector's id). */
export interface SavedFactMatches { facts: Array<SavedFactMatch & CollapseColumns>; correctedBy: Map<number, number> }

/** Default on (set false to turn off): a newer saved fact carrying a correction cue is returned ahead of the older fact it corrects, which is labelled `corrected_by`. */
export const SAVED_FACTS_SUPERSEDE_KEY = 'search.saved_facts_supersede';
/** Cues that withdraw what was said, so they correct without stating a new figure; the facts block's retraction cue starts from them (fact-relevance.ts). */
export const RETRACTION = String.raw`retract(s|ed|ing|ion)?|disregard|scratch that|i misspoke|i was wrong|not what (i|we) (posted|said|wrote)|ignore (the|my|that|what)`;
const RETRACTION_CUE = new RegExp(String.raw`\b(${RETRACTION})\b`, 'i');
/** What marks a saved fact as making a correction (Postgres ARE, matched case-insensitively); "corrected" and "correcting" report one made elsewhere. */
export const CORRECTION_CUE = String.raw`\m(correction|${RETRACTION})\M`;

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
const DATES = new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\b\d{1,2}:\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)? ${MONTH}|\b${MONTH} \d{1,2}(?:st|nd|rd|th)?\b`, 'gi');

/** The words a fact writes as the first word of a name ("Orbix" in "Orbix Home Goods", not "Example" in "Alice Example"), lower-cased. */
function nameHeads(text: string): string[] {
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)]
    .filter(m => m[0][0] !== m[0][0]!.toLowerCase() && !/\p{Lu}[\p{L}\p{N}'-]*\s+$/u.test(text.slice(0, m.index)))
    .map(m => m[0].toLowerCase());
}

/** The matched query words a fact writes as a name head, by prefix or by stem (`stems`: head to the 1-based term indexes it matches). */
function namedWords(heads: string[], terms: string[], words: Set<number>, stems: Map<string, Set<number>>): Set<number> {
  return new Set([...words].filter(i => heads.some(h => h.startsWith(terms[i - 1]!) || stems.get(h)?.has(i))));
}

/**
 * Which query terms each name head matches after stemming with the brain's full-text language, as the keyword scan
 * matches words; empty on a read error. An engine that cannot stem in this language refuses, and that refusal is
 * rethrown rather than read as "no names match".
 */
async function headStems(engine: OperationContext['engine'], heads: string[], terms: string[]): Promise<Map<string, Set<number>>> {
  if (heads.length === 0) return new Map();
  const rows = await engine.matchHeadStems(heads, terms).catch((err: unknown) => { rethrowCapabilityRefusal(err); return []; });
  return new Map(rows.map(r => [r.h, new Set(r.i)]));
}

/**
 * The figures a fact states: its numbers, with dates ("2026-10-14", "14 Oct", "July 1") and clock times left out,
 * thousands separators and a zero fraction dropped, so 52,000, 52000 and 52000.0 are one figure.
 */
function figures(text: string): Set<string> {
  return new Set((text.replace(DATES, ' ').match(/\d+(?:[.,]\d+)*/g) ?? [])
    .map(n => (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(n) ? n.replace(/,/g, '') : n).replace(/\.0+$/, '')));
}

async function savedFactsSupersedeEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(SAVED_FACTS_SUPERSEDE_KEY))?.trim().toLowerCase();
    return !(raw === 'false' || raw === 'off' || raw === '0' || raw === 'no');
  } catch {
    return true;
  }
}

/**
 * Facts saved with `remember` live in the facts table, not in page chunks, so
 * page search never returns them (gbrain-evals Cat 40: agents saved a
 * correction with remember and the next session's search missed it). This
 * finds active facts that contain at least three quarters of the query's words
 * (both words of a two-word query, and never more than four: a question asked in
 * full carries words the short fact answering it does not repeat), under the same source scope and
 * visibility rules recall applies, copies of one claim collapsed before the cap
 * (#7043).
 * Words match whole after stemming with the brain's full-text language, as the
 * facts keyword index does: "renews" finds "renewal", and "count" never matches
 * inside "countersigned". CJK words, which that parser does not split, match as
 * substrings. Most matched words first, then newest. With
 * `search.saved_facts_supersede` on, a newer fact with a correction cue that
 * shares at least two matched words with a returned fact is returned too, even
 * below the threshold, and every fact it corrects moves below the facts nothing
 * corrects, labelled `corrected_by`. An acknowledgement corrects nothing: a cue
 * fact that adds no figure (a number other than a date or time) to the older
 * fact, when it restates one of its figures or the older fact is itself a
 * correction. Nor does a cue fact about another entity, one missing every
 * name the older fact starts with a matched word (prefix or stem; the stems are
 * read only when a cue fact is among the candidates), one of lower trust, or one
 * stating no figure that withdraws nothing. A corrected fact whose corrector
 * the five-fact cap leaves out is dropped. `correctedBy` carries the decisions
 * for facts the cap cut too, so a caller merging other reads of the same facts
 * (the entity facts) can drop or label them the same way.
 */
export async function matchingSavedFacts(ctx: OperationContext, scope: { sourceId?: string; sourceIds?: string[]; minTrust?: TrustTier }, queryText: string, otherNames: string[] = []): Promise<SavedFactMatches> {
  const none: SavedFactMatches = { facts: [], correctedBy: new Map() };
  // A query naming one of two declared names also matches facts saved under the other.
  if (otherNames.length) queryText += ` ${otherNames.join(' ')}`;
  const terms = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]+/gu) ?? [])]
    .filter(t => t.length >= 3 && !FACT_MATCH_STOPWORDS.has(t) && !QUESTION_FRAME_WORDS.has(t)).slice(0, 12);
  if (terms.length === 0 || !ctx.emitResponseMeta) return none;
  const sources = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? ctx.sourceId ?? 'default'];
  const [excludePrivate, supersede] = await Promise.all([resolveExcludePrivatePages(ctx.engine, ctx.remote), savedFactsSupersedeEnabled(ctx.engine)]);
  // CJK words match as substrings; without one the scan is the any-word tsquery alone, which the facts keyword index serves.
  const pats = terms.map(t => hasCJK(t) ? `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%` : null);
  try {
    // Most searches have no saved fact to find: the uncorrelated EXISTS is an indexed probe
    // (idx_facts_since) the planner runs once, before the keyword scan, and the scan is skipped
    // when no fact qualifies; one statement, so one round trip either way. The probe reads the
    // fact's own columns only: every row the scan returns passes it, so it never changes the
    // result, and the page-eligibility filters stay on the scan, where they cost an index
    // lookup per candidate. The any-word tsquery reads the facts keyword index's own expression.
    // A word the language drops as a stopword counts toward neither side of the threshold.
    // The threshold is applied before the cut: a fact matching every word is never crowded
    // out by newer facts that match fewer.
    // Cue rows below the threshold rank in a pool of their own, so full matches never push a correction past the cut.
    const rows = await ctx.engine.matchSavedFacts({ sources, terms, pats, cue: CORRECTION_CUE, supersede, excludePrivate, worldOnly: worldOnlyFacts(ctx.remote), minTrust: scope.minTrust });
    // GST-3170: a slot value a later one ended at read time is no longer current, like a lapsed valid_until (slot-ends.ts).
    const { applySlotEnds } = await import('./slot-ends.ts');
    const current = await applySlotEnds(ctx.engine, { sourceIds: sources, worldOnly: worldOnlyFacts(ctx.remote), excludePrivate, minTrust: scope.minTrust },
      rows.map(r => ({ ...r, id: Number(r.id) })), { activeOnly: true });
    const found = current.map(({ at, matched, need, cue, trust_rank, pool_rank: _p, dimension: _d, ...fact }) => ({ fact: fact as SavedFactMatch & CollapseColumns,
      at: new Date(at as string).getTime(), words: new Set(matched.map(Number)), need: Number(need), cue, trust: Number(trust_rank), figures: figures(fact.fact) }));
    const admitted = found.filter(r => r.words.size >= r.need);
    const correcting = new Set<number>();
    if (supersede) {
      const cues = found.filter(n => n.cue);
      const heads = new Map(admitted.map(r => [r, nameHeads(r.fact.fact)]));
      const stems = cues.length ? await headStems(ctx.engine, [...new Set([...heads.values()].flat())], terms) : new Map<string, Set<number>>();
      for (const older of admitted) {
        const names = namedWords(heads.get(older)!, terms, older.words, stems);
        // Posts saved in one flush share a time; the later id is the later post.
        // An acknowledgement is not a correction: a cue fact that adds no figure to the older fact
        // corrects it only when it restates no figure and the older fact is not a correction itself.
        // A cue fact corrects nothing about another entity, nor a fact whose matched names it shares none of, nor one of
        // higher trust; one stating no figure corrects only by withdrawing ("disregard"), never by a bare "correction".
        const corrections = cues.filter(n => (n.at > older.at || (n.at === older.at && n.fact.id > older.fact.id))
          && (!n.fact.entity_slug || !older.fact.entity_slug || n.fact.entity_slug === older.fact.entity_slug)
          && (names.size === 0 || [...names].some(w => n.words.has(w))) && n.trust >= older.trust
          && [...n.words].filter(w => older.words.has(w)).length >= Math.min(2, n.need)
          && (n.figures.size > 0 || RETRACTION_CUE.test(n.fact.fact))
          && !([...n.figures].every(x => older.figures.has(x)) && (n.figures.size > 0 || older.cue))).sort((a, b) => b.at - a.at || b.fact.id - a.fact.id);
        if (corrections.length) older.fact.corrected_by = corrections[0].fact.id;
        for (const c of corrections) correcting.add(c.fact.id);
      }
      // Every correction of a returned fact comes back, not only the newest: an acknowledgement
      // saved after the correction must not crowd out the post that made it.
      admitted.push(...found.filter(r => correcting.has(r.fact.id) && r.words.size < r.need));
    }
    // Corrected facts that correct others go newest first, each behind its newer corrector, so the cap cuts the stalest first.
    const ordered = supersede ? [...admitted.filter(r => !r.fact.corrected_by),
      ...admitted.filter(r => r.fact.corrected_by && correcting.has(r.fact.id)).sort((a, b) => b.at - a.at || b.fact.id - a.fact.id),
      ...admitted.filter(r => r.fact.corrected_by && !correcting.has(r.fact.id))] : admitted;
    const kept = (await collapseFactReads(ctx.engine, ordered.map(r => r.fact))).slice(0, 5);
    if (!supersede) return { facts: kept, correctedBy: new Map() };
    // A label names the returned fact that stands for its corrector. A corrected fact whose corrector the cap or
    // the collapse left out is dropped rather than shown as current.
    const correctedBy = new Map(ordered.flatMap(r => r.fact.corrected_by === undefined ? [] : [[r.fact.id, r.fact.corrected_by] as const]));
    const shownAs = new Map(kept.flatMap(r => (r.collapsed_ids ?? [r.id]).map(id => [id, r.id] as const)));
    const facts = kept.flatMap(({ corrected_by, ...r }) => {
      const by = (r.collapsed_ids ?? [r.id]).map(id => shownAs.get(correctedBy.get(id) ?? -1)).find(c => c !== undefined && c !== r.id);
      if (by !== undefined) return [{ ...r, corrected_by: by }];
      return corrected_by === undefined ? [r] : [];
    });
    return { facts, correctedBy };
  } catch (err) {
    // An engine that cannot run this match (another full-text language on a Rust brain) says so; it is not "no facts".
    rethrowCapabilityRefusal(err);
    const code = (err as { code?: unknown } | null)?.code;
    console.warn(`[search] Saved-facts match failed (SQLSTATE ${typeof code === 'string' ? code : 'unknown'}); this reply carries no saved facts, which does not mean none match.`);
    return none;
  }
}
