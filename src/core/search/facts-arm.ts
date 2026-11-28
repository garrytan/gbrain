/**
 * Facts arm for `query` (`search.query_facts_arm`, default on; gates in
 * docs/eval/decisions/query-facts-arm/). A correction saved with `remember`
 * lives in the facts table, which page search never ranks, so the stale page
 * text answers instead. Unless the key is off, `query` adds the active facts that
 * match the question as rows of their own, inside the caller's row count and
 * token budget, and stamps a page row `superseded_claim` when a newer active
 * fact covers the same entity and typed claim slot as a fact taken from that
 * page.
 *
 * Matching: query terms against the fact text and entity (at least half of
 * the content terms), cosine against the query embedding hybrid search
 * already computed (no extra model call; skipped when there is none), and the
 * facts of the one entity page the query names (in that page's source); the
 * candidate pool is fact-relevance.ts's. Matches are ordered newest
 * valid_from first. Read policy is recall's: source scope, active rows only,
 * audit rows excluded, and world-visible facts with non-private provenance
 * for remote callers.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, SearchResult } from '../types.ts';
import { resolveExcludePrivatePages, worldOnlyFacts } from './private-visibility.ts';
import { admitted, collectFactCandidates, FACTS_ARM_COSINE_MIN, factRecency, laterRetractions, queryTerms, scoreFactCandidates, type FactCandidate as PoolCandidate, type FactPoolScope } from './fact-relevance.ts';
import { readSlotHistory, slotWindows } from './slot-history.ts';
import { enforceTokenBudget, resultTokens } from './token-budget.ts';
import { configFlagOn, factDateHeader, factObservationDates } from './evidence-date.ts';
import { collapseFactReads } from '../facts/capture-dedup.ts';
import type { TrustTier } from '../trust/tier.ts';
import { conversationSignal } from './evidence-delivery.ts';
import { factsFromQuotedPages } from './transcript-quote.ts';
import { findTimeMentions } from '../temporal-grammar.ts';
import { rethrowCapabilityMissing } from '../rust-engine/errors.ts';
import { withDecideContested, type ContestedLookup } from '../facts/contested-claims.ts';
import type { Contested } from '../eligibility/labels.ts';

export { queryTerms } from './fact-relevance.ts';

export const QUERY_FACTS_ARM_KEY = 'search.query_facts_arm';
/** Fact rows added per query at most. */
export const MAX_FACT_ROWS = 3;
/** Cosine similarity a fact needs against the query embedding to count as a match on its own. */
export const FACT_COSINE_MIN = FACTS_ARM_COSINE_MIN;
/** Share of the query's content terms a fact's text and entity must hold to match by keyword. */
const TERM_SHARE_MIN = 0.5;

/** Temporal fact reserve (docs/eval/decisions/temporal-fact-reserve/): off by default. */
export const TEMPORAL_FACT_RESERVE_KEY = 'search.temporal_fact_reserve';
/** Share of the caller's token budget reserved facts may take. */
export const TEMPORAL_RESERVE_SHARE = 0.15;
export const MAX_RESERVE_ROWS = 20;
/** Share of the caller's row count reserved facts may take (at least one row). */
export const TEMPORAL_RESERVE_ROW_SHARE = 0.3;

/** GBRA-205 facts block (`search.query_facts_block`, default on): every query with a caller token budget, ahead of the pages. */
export const QUERY_FACTS_BLOCK_KEY = 'search.query_facts_block';
/** Share of the caller's token budget the facts block may take (about 1,800 of 8,100, as the measured combined lane). */
export const QUERY_FACTS_BLOCK_SHARE = 0.22;
export const MAX_FACTS_BLOCK_ROWS = 40;

/** GBRA-205 (`search.fact_source_pages`, default off): the conversations matched facts came from join the hits. */
export const FACT_SOURCE_PAGES_KEY = 'search.fact_source_pages';
export const MAX_FACT_SOURCE_PAGES = 2;
/** Source pages go in after this many organic rows. */
export const FACT_SOURCE_PAGE_RANK = 3;

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const TEMPORAL_CUE = new RegExp(`\\b(when|before|after|since|until|till|during|ago|earlier|later|earliest|latest|first|last|previous|next|dates?|day|week|month|year|order|sequence|${MONTHS})\\b`
  + `|\\bhow (long|many (days|weeks|months|years))\\b|\\bwhat time\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');

/** Whether `query` carries a deterministic temporal cue (the preregistered word, phrase, ISO date and month-name list). */
export function hasTemporalCue(query: string): boolean {
  return TEMPORAL_CUE.test(query);
}

const HISTORY_CUE = /\b(before|earlier|earliest|previous(ly)?|prior|former(ly)?|used to|originally|first|history|historically|ever|over time|in order|chronolog\w*|sequence|ago|back then|at the time|no longer|any ?more|in the past)\b/i;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * GBRA-574 B1: whether `query` asks about the past, by a plain-English history word or a time it names (the shared
 * temporal grammar, temporal-grammar.ts) that ended before `asOf` (today by default).
 */
export function hasHistoryCue(query: string, asOf = today()): boolean {
  return HISTORY_CUE.test(query) || findTimeMentions(query, asOf, 'past').some(m => m.end < asOf);
}

/** GBRA-574 B3: the one date `query` names (the last day of it, YYYY-MM-DD, by the shared temporal grammar), or null for none or several. */
export function questionDate(query: string, asOf = today()): string | null {
  const ends = [...new Set(findTimeMentions(query, asOf, 'past').filter(m => m.kind === 'absolute').map(m => m.end))];
  return ends.length === 1 ? ends[0]! : null;
}

export interface FactsArmScope {
  sourceId?: string; sourceIds?: string[]; remote: boolean;
  /** #5575 read floor and activation control, applied in the candidate SQL like every retrieval arm. */
  minTrust?: TrustTier; suppressFlagged?: boolean;
}

type FactCandidate = PoolCandidate;

async function poolScope(engine: BrainEngine, scope: FactsArmScope): Promise<FactPoolScope> {
  return { ...scope, worldOnly: worldOnlyFacts(scope.remote), excludePrivate: await resolveExcludePrivatePages(engine, scope.remote) };
}

const day = (v: Date | string | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);

/** The active facts that match `query`, newest valid_from first (at most MAX_FACT_ROWS). */
export async function matchQueryFacts(engine: BrainEngine, query: string, scope: FactsArmScope, queryEmbedding?: Float32Array | null): Promise<FactCandidate[]> {
  const { candidates } = await collectFactCandidates(engine, query, await poolScope(engine, scope), queryEmbedding, { depth: { keyword: 50, cosine: 10, entity: MAX_FACT_ROWS } });
  const terms = queryTerms(query);
  const matched = (c: FactCandidate) => { const haystack = `${c.fact} ${c.entity_slug ?? ''}`.toLowerCase(); return terms.filter(t => haystack.includes(t)).length; };
  return candidates
    .filter(c => c.entity || (c.similarity ?? -1) >= FACT_COSINE_MIN || (terms.length > 0 && matched(c) >= Math.max(Math.min(2, terms.length), Math.ceil(terms.length * TERM_SHARE_MIN))))
    .sort((a, b) => factRecency(b) - factRecency(a) || Number(b.id) - Number(a.id))
    .slice(0, MAX_FACT_ROWS);
}

/**
 * When each fact was said (evidence-date.ts `factObservationDates`, under the caller's page read policy), or null
 * when the read failed: its rows then carry `observed_unavailable` and the response is marked degraded. An engine
 * that cannot serve the read refuses: the refusal propagates, never a quiet degraded marker.
 */
async function observedDates(engine: BrainEngine, facts: FactCandidate[], readScope: PageReadScope | undefined): Promise<{ dates: Map<number, string> | null; timeZone: string | null }> {
  const timeZone = (await engine.getConfig('brain.timezone').catch(() => null))?.trim() || null;
  try {
    return { dates: await factObservationDates(engine, facts, timeZone, readScope), timeZone };
  } catch (e) {
    rethrowCapabilityMissing(e);
    return { dates: null, timeZone };
  }
}

function factRow(f: FactCandidate, score: number, pageSlug: string | undefined, fromQuotedPage: boolean, observed: Map<number, string> | null): SearchResult {
  const from = day(f.valid_from);
  const until = day(f.valid_until);
  const args: Record<string, string> = f.entity_slug ? { entity: f.entity_slug } : { grep: f.fact.slice(0, 60) };
  if (f.source_id !== 'default') args.source_id = f.source_id;
  return {
    result_type: 'fact', fact_id: String(f.id), ...(pageSlug ? { page_slug: pageSlug } : {}), follow_up: { op: 'recall', args },
    slug: `facts/${f.id}`, page_id: 0, title: f.entity_slug ? `Saved fact about ${f.entity_slug}` : 'Saved fact', type: 'note',
    chunk_text: `Saved fact (${f.kind}; valid from ${from ?? 'unknown'}${until ? ` to ${until}` : ''}; provenance: ${f.source}): ${f.fact}`,
    chunk_source: 'compiled_truth', chunk_id: -Number(f.id), chunk_index: 0, score, stale: false, source_id: f.source_id,
    fact_row: { id: Number(f.id), valid_from: f.valid_from == null ? null : new Date(f.valid_from).toISOString(), valid_until: f.valid_until ? new Date(f.valid_until).toISOString() : null, source: f.source,
      ...(fromQuotedPage ? { from_quoted_page: true as const } : {}),
      ...(observed === null ? { observed_unavailable: true as const } : observed.has(Number(f.id)) ? { observed: observed.get(Number(f.id))! } : {}) },
  } as SearchResult;
}

/**
 * Stamp `superseded_claim` on page rows whose page is the source of an older
 * fact for the same entity and typed claim slot as a newer matched fact.
 * Untyped claims are never compared.
 */
async function stampSupersededClaims(engine: BrainEngine, results: SearchResult[], facts: FactCandidate[]): Promise<void> {
  const typed = facts.filter(f => f.entity_slug && f.claim_metric);
  const pages = results.filter(r => !r.fact_row && r.slug);
  if (!typed.length || !pages.length) return;
  const rows = await engine.listTypedClaimFactsAtPages([...new Set(pages.map(r => r.slug))], [...new Set(typed.map(f => f.entity_slug!))]);
  for (const r of pages) {
    for (const old of rows.filter(o => o.source_markdown_slug === r.slug && o.source_id === (r.source_id ?? o.source_id))) {
      const newer = typed.find(f => f.entity_slug === old.entity_slug && f.claim_metric === old.claim_metric
        && (!f.claim_period || !old.claim_period || f.claim_period === old.claim_period)
        && Number(f.id) !== Number(old.id) && f.valid_from != null && old.valid_from != null && new Date(f.valid_from).getTime() > new Date(old.valid_from).getTime());
      if (newer?.valid_from != null) { r.superseded_claim = { fact_id: Number(newer.id), valid_from: new Date(newer.valid_from).toISOString() }; break; }
    }
  }
}

/**
 * `source\0slug` keys of the facts' entity pages (page slug = fact entity_slug, same source) the caller may read: the
 * live pages the caller's read scope admits (`readAdmittedPageRefs`, the typed member every engine serves). A refused
 * read propagates; it is never read as "no readable page".
 */
async function readableEntityPages(engine: BrainEngine, facts: FactCandidate[], scope: PageReadScope | undefined): Promise<Set<string>> {
  const refs = new Map<string, { source_id: string; slug: string }>();
  for (const f of facts) if (f.entity_slug) refs.set(`${f.source_id}\u0000${f.entity_slug}`, { source_id: f.source_id, slug: f.entity_slug });
  if (!refs.size) return new Set();
  // Only the page-read fields: the arm's scope also carries search knobs (an evidence plan) no page read takes.
  const read: PageReadScope = scope ? {
    sourceId: scope.sourceId, sourceIds: scope.sourceIds, excludePrivate: scope.excludePrivate,
    minTrust: scope.minTrust, suppressFlagged: scope.suppressFlagged,
  } : {};
  const rows = await engine.readAdmittedPageRefs([...refs.values()], read);
  return new Set(rows.map(r => `${r.source_id}\u0000${r.slug}`));
}

/**
 * What a caller sees of a fact row: the fact, its identity and how to follow
 * it, never page fields (slug, id, type, chunk_id) that would invite get_page
 * or fetch on a page that may not exist.
 */
export function factRowOutput<T extends Partial<SearchResult>>(row: T): T {
  if (row.result_type !== 'fact') return row;
  const { slug: _slug, id: _id, type: _type, chunk_id: _chunk, page_id: _page, chunk_index: _index, chunk_source: _source, fact_row: _fact, ...rest } = row as T & { id?: string };
  return rest as T;
}

export interface FactsArmOpts extends FactsArmScope {
  /** The caller's page read policy: a fact's entity page is named (`page_slug`) only when the caller may read it. */
  readScope?: PageReadScope;
  tokenBudget?: number;
  queryEmbedding?: Float32Array | null;
  /** The caller's row count (explicit limit or the mode's default), read only when a fact matches. */
  rowCap?: () => Promise<number>;
}

/**
 * The facts arm: matched facts appended as rows in spare capacity only (free
 * slots under the caller's row count, and what the pages leave of the token
 * budget), so no page row is ever displaced; superseded page claims stamped.
 * No match, no spare capacity or any error: the results unchanged.
 */
export async function applyFactsArm(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts): Promise<SearchResult[]> {
  try {
    const facts = await matchQueryFacts(engine, query, opts, opts.queryEmbedding);
    if (!facts.length) return results;
    const free = ((await opts.rowCap?.().catch(() => 0)) ?? 0) - results.length;
    if (free <= 0) return results;
    const pages = results.map(r => ({ ...r }));
    const floor = pages.reduce((m, r) => (Number.isFinite(r.score) && r.score < m ? r.score : m), pages[0]?.score ?? 1);
    const shown = facts.slice(0, free);
    const pageSlugs = await readableEntityPages(engine, shown, opts.readScope);
    const fromQuoted = await factsFromQuotedPages(engine, shown.map(f => Number(f.id)));
    const { dates } = await observedDates(engine, shown, opts.readScope);
    let rows = shown.map((f, i) => factRow(f, floor - (i + 1) * 1e-6, f.entity_slug && pageSlugs.has(`${f.source_id}\u0000${f.entity_slug}`) ? f.entity_slug : undefined, fromQuoted.has(Number(f.id)), dates));
    if (opts.tokenBudget) {
      let left = opts.tokenBudget - enforceTokenBudget(pages, opts.tokenBudget).meta.used;
      rows = rows.filter(r => { const cost = resultTokens(r); if (cost > left) return false; left -= cost; return true; });
    }
    if (!rows.length) return results;
    const merged = [...pages, ...rows];
    await stampSupersededClaims(engine, merged, facts).catch(unlessRefused(() => undefined));
    return merged;
  } catch (e) {
    // An engine that cannot serve a read refuses: the refusal is a typed stop, never a silently empty facts arm.
    rethrowCapabilityMissing(e);
    return results;
  }
}

/**
 * A fail-soft fallback for a read the answer depends on (the slot history, its windows, later retractions): a failed
 * read degrades the block as before, but an engine capability refusal rethrows, so it never reads as "no history".
 */
const unlessRefused = <T>(fallback: () => T) => (e: unknown): T => { rethrowCapabilityMissing(e); return fallback(); };

interface ReservePolicy {
  share: number;
  maxRows: number;
  /** Share of the caller's row count the facts may take (they replace the lowest page rows); null: they add rows. */
  rowShare: number | null;
  /** Where the facts go: after the pages (temporal reserve) or ahead of them (facts block). */
  position: 'after' | 'before';
  /** GBRA-574 B1, B3, G1 and B5: ended facts on a history cue, the asked date in each header, contested labels and later retractions. */
  dated: boolean;
}

const TEMPORAL_RESERVE: ReservePolicy = { share: TEMPORAL_RESERVE_SHARE, maxRows: MAX_RESERVE_ROWS, rowShare: TEMPORAL_RESERVE_ROW_SHARE, position: 'after', dated: false };
const FACTS_BLOCK: ReservePolicy = { share: QUERY_FACTS_BLOCK_SHARE, maxRows: MAX_FACTS_BLOCK_ROWS, rowShare: null, position: 'before', dated: true };

/**
 * Temporal fact reserve: for a query with a temporal cue and a token budget,
 * the facts that best match the question (the shared scorer in
 * fact-relevance.ts: cosine + term share, +0.1 when the fact carries a real
 * date, admitted by the reserve rule) take up to TEMPORAL_RESERVE_SHARE of the budget and
 * TEMPORAL_RESERVE_ROW_SHARE of the row count (1 to MAX_RESERVE_ROWS rows), rendered with their date header and ordered oldest
 * first after the pages. The row count never grows (a fact takes a free row,
 * else the lowest page row) and pages fill the rest of the budget. No match or
 * any error: the results unchanged.
 */
export function applyTemporalFactReserve(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts & { budget: number }): Promise<SearchResult[]> {
  return applyFactReserve(engine, query, results, opts, TEMPORAL_RESERVE);
}

/**
 * Facts block (GBRA-205): the same question-ranked, dated facts as the
 * temporal reserve, for every query whose caller passed a token budget, up to
 * QUERY_FACTS_BLOCK_SHARE of the budget and MAX_FACTS_BLOCK_ROWS rows and
 * never more rows than the caller's row count (#8411), oldest first ahead of
 * the pages. Copies of one claim take one row, dated as first stated with
 * "(stated N times, last D)" after the fact (GBRA-574 A2), and each row's date
 * header carries when the fact was said (A1). On a history cue (`hasHistoryCue`)
 * the pool also takes the named entity's ended facts with their windows (B1;
 * never a withdrawn or forgotten one); when the question names one date each
 * header says whether the fact was told after it (B3); and a fact in a pending
 * supersede proposal ends "(contested by #<id>)" when the caller can read the
 * other fact, as recall labels it (G1). A later fact of the same entity that retracts a shown fact or calls it off (a
 * plain-English cue not negated just before it, whose non-name terms are all in the fact or share two with it, or
 * carrying the fact's slot; fact-relevance.ts `laterRetractions`) follows it with
 * its own date, inside the same share and row count (B5). Block rows take the top page's
 * score: they are placed, not ranked against the pages, and never outscore them. The facts add rows
 * (every page row stays) and pages fill the rest of the budget. No match or
 * any error: the results unchanged.
 */
export function applyFactsBlock(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts & { budget: number }): Promise<SearchResult[]> {
  return applyFactReserve(engine, query, results, opts, FACTS_BLOCK);
}

async function applyFactReserve(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts & { budget: number }, policy: ReservePolicy): Promise<SearchResult[]> {
  try {
    const scope = await poolScope(engine, opts);
    const readScope: PageReadScope = opts.readScope ?? { sourceId: opts.sourceId, sourceIds: opts.sourceIds, excludePrivate: scope.excludePrivate };
    // GBRA-574 F: a history question about one slot dimension of one named entity takes every value it has had, first in line (slot-history.ts).
    let historyUnavailable = false;
    const history = policy.dated ? await readSlotHistory(engine, query, scope, readScope).catch(unlessRefused(() => { historyUnavailable = true; return null; })) : null;
    const pinned = new Set((history?.rows ?? []).map(c => Number(c.id)));
    const { candidates, stems } = await collectFactCandidates(engine, query, scope, opts.queryEmbedding,
      { depth: { keyword: 50, cosine: 50, entity: policy.maxRows }, cosineForAll: true, history: policy.dated && hasHistoryCue(query) });
    const scored = [...(history?.rows ?? []), ...scoreFactCandidates(query, candidates, queryTerms(query), stems)
      .filter(s => admitted(s, 'reserve') && !pinned.has(Number(s.candidate.id))).map(s => s.candidate)];
    if (!scored.length) return results;
    const callerRows = (await opts.rowCap?.().catch(() => 0)) ?? 0;
    const rowCap = Math.max(results.length, callerRows);
    const maxRows = policy.rowShare === null ? Math.min(policy.maxRows, callerRows || policy.maxRows) : Math.min(policy.maxRows, Math.max(1, Math.floor(rowCap * policy.rowShare)));
    // GBRA-574 A2: copies of one claim (exact fingerprint, capture-dedup.ts) take one row, shown as first stated; a differing value never merges.
    const byId = new Map(scored.map(c => [Number(c.id), c]));
    const collapsed = await collapseFactReads(engine, scored.map(c => ({ ...c, id: Number(c.id), created_at: c.created_at ?? c.valid_from ?? new Date(0), visibility: c.visibility ?? '', attributed_to: c.attributed_to ?? null })));
    const members = collapsed.map(r => (r.collapsed_ids ?? [r.id]).map(id => byId.get(id)!));
    // GBRA-574 B5: later facts that retract or call off a pooled fact, read under the same policy.
    const answers = policy.dated ? await laterRetractions(engine, scope, members.flat()).catch(unlessRefused(() => new Map<number, FactCandidate[]>())) : new Map<number, FactCandidate[]>();
    const retracting = [...new Map([...answers.values()].flat().filter(r => !byId.has(r.id)).map(r => [r.id, r])).values()];
    const { dates } = await observedDates(engine, [...members.flat(), ...retracting], opts.readScope);
    const said = (c: FactCandidate) => dates?.get(Number(c.id)) ?? day(c.created_at ?? c.valid_from) ?? '';
    const groups = members.map(g => g.sort((a, b) => said(a).localeCompare(said(b)) || Number(a.id) - Number(b.id)));
    const shown = groups.map(g => g[0]!);
    // GBRA-574 B2/G4 and F: a slot value's window ends at read time, from the rows the caller may read under every key of its entity (slot-history.ts).
    const ends = await slotWindows(engine, scope, readScope, shown, history?.keys ?? null)
      .catch(unlessRefused(() => { historyUnavailable ||= history !== null; return new Map<number, Date>(); }));
    const pageSlugs = await readableEntityPages(engine, shown, opts.readScope);
    const fromQuoted = await factsFromQuotedPages(engine, [...shown, ...retracting].map(c => Number(c.id)));
    const asked = policy.dated ? questionDate(query) : null;
    const lookup: ContestedLookup = {};
    const contested = policy.dated
      ? new Map((await withDecideContested<{ id: number; contested?: Contested }>(engine, shown.map(c => ({ id: Number(c.id) })),
        { remote: opts.remote, excludePrivate: scope.excludePrivate, eligibility: { floor: opts.minTrust, suppressFlagged: opts.suppressFlagged } }, lookup))
        .flatMap(r => (r.contested ? [[r.id, r.contested.fact_id] as const] : [])))
      : new Map<number, string>();
    let left = Math.floor(opts.budget * policy.share);
    const render = (group: FactCandidate[]) => {
      const c = group[0]!;
      const restated = group.length > 1 ? ` (stated ${group.length} times, last ${said(group[group.length - 1]!)})` : '';
      const row = factRow(c, 0, c.entity_slug && pageSlugs.has(`${c.source_id}\u0000${c.entity_slug}`) ? c.entity_slug : undefined, fromQuoted.has(Number(c.id)), dates);
      const window = c.valid_until ? c : { ...c, valid_until: ends.get(Number(group[group.length - 1]!.id)) ?? null };
      const label = contested.has(Number(c.id)) ? ` (contested by #${contested.get(Number(c.id))})` : '';
      row.chunk_text = `${factDateHeader(window, undefined, dates?.get(Number(c.id)), asked)}\n${c.fact}${restated}${label}`;
      if (lookup.degraded) row.fact_row = { ...row.fact_row!, contested_unavailable: true };
      if (historyUnavailable) row.fact_row = { ...row.fact_row!, history_unavailable: true };
      return row;
    };
    type Shown = { c: FactCandidate; row: SearchResult; after: Array<{ c: FactCandidate; row: SearchResult }> };
    const chosen: Shown[] = [];
    const groupOf = new Map(groups.flatMap(g => g.map(m => [Number(m.id), g] as const)));
    const attached = new Set<number>();
    let count = 0;
    for (const group of groups) {
      if (count >= maxRows) break;
      const c = group[0]!;
      if (attached.has(Number(c.id))) continue;
      const row = render(group);
      const cost = resultTokens(row);
      if (cost > left) continue;
      left -= cost;
      const entry: Shown = { c, row, after: [] };
      chosen.push(entry);
      count++;
      // GBRA-574 B5: each later retraction goes right after the fact it answers; one already shown moves there.
      for (const r of answers.get(Number(c.id)) ?? []) {
        const g = groupOf.get(r.id) ?? [r];
        const head = Number(g[0]!.id);
        if (head === Number(c.id) || attached.has(head)) continue;
        const at = chosen.findIndex(x => Number(x.c.id) === head);
        if (at >= 0) {
          const [moved] = chosen.splice(at, 1);
          entry.after.push({ c: moved!.c, row: moved!.row }, ...moved!.after);
          attached.add(head);
          continue;
        }
        if (count >= maxRows) break;
        const answer = render(g);
        const answerCost = resultTokens(answer);
        if (answerCost > left) continue;
        left -= answerCost;
        entry.after.push({ c: g[0]!, row: answer });
        attached.add(head);
        count++;
      }
    }
    if (!chosen.length) return results;
    chosen.sort((a, b) => factRecency(a.c) - factRecency(b.c) || Number(a.c.id) - Number(b.c.id));
    const pagesFloor = results.reduce((m, r) => (Number.isFinite(r.score) && r.score < m ? r.score : m), results[0]?.score ?? 1);
    const pagesTop = results.reduce((m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m), results[0]?.score ?? 1);
    const placed = chosen.flatMap(({ c, row, after }) => [{ c, row }, ...after]);
    const rows = policy.position === 'after'
      ? placed.map(({ row }, i) => ({ ...row, score: pagesFloor - (i + 1) * 1e-6 }))
      : placed.map(({ row }) => ({ ...row, score: pagesTop }));
    let pages = (policy.rowShare === null ? results : results.slice(0, Math.max(0, Math.min(results.length, rowCap - rows.length)))).map(r => ({ ...r }));
    if (opts.tokenBudget) pages = enforceTokenBudget(pages, Math.max(1, opts.tokenBudget - rows.reduce((n, r) => n + resultTokens(r), 0))).results;
    const merged = policy.position === 'after' ? [...pages, ...rows] : [...rows, ...pages];
    await stampSupersededClaims(engine, merged, placed.map(x => x.c)).catch(unlessRefused(() => undefined));
    return merged;
  } catch (e) {
    // An engine that cannot serve a read refuses: the refusal is a typed stop, never a silently empty facts block.
    rethrowCapabilityMissing(e);
    return results;
  }
}

/**
 * Fact source pages (GBRA-205): the conversations the question's best-matching
 * facts were extracted from (`facts.source_markdown_slug`, never the fact's
 * own entity page), up to MAX_FACT_SOURCE_PAGES not already in the results,
 * go in after the top FACT_SOURCE_PAGE_RANK rows, so evidence delivery can
 * hand over the whole session. Each page is read through `getChunkWindows`
 * under the caller's read scope, so an unreadable page is absent. The row
 * count never grows (the lowest rows give way). No match or any other error:
 * the results unchanged; an engine that refuses a read refuses the caller.
 */
export async function applyFactSourcePages(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts): Promise<SearchResult[]> {
  try {
    const { candidates, stems } = await collectFactCandidates(engine, query, await poolScope(engine, opts), opts.queryEmbedding,
      { depth: { keyword: 50, cosine: 50, entity: MAX_RESERVE_ROWS }, cosineForAll: true });
    const ranked = scoreFactCandidates(query, candidates, queryTerms(query), stems).filter(s => admitted(s, 'reserve')).map(s => Number(s.candidate.id));
    if (!ranked.length) return results;
    const sources = await engine.listFactSourcePages(ranked);
    const rank = new Map(ranked.map((id, i) => [id, i]));
    const present = new Set(results.map(r => r.page_id));
    const wanted: typeof sources = [];
    for (const s of [...sources].sort((a, b) => rank.get(Number(a.id))! - rank.get(Number(b.id))!)) {
      if (wanted.length >= MAX_FACT_SOURCE_PAGES) break;
      if (present.has(Number(s.page_id)) || !conversationSignal({ type: s.type, slug: s.slug })) continue;
      present.add(Number(s.page_id));
      wanted.push(s);
    }
    if (!wanted.length) return results;
    const windows = await engine.getChunkWindows(wanted.map((w, i) => ({ page_id: Number(w.page_id), from_index: 0, to_index: 0, priority: i })),
      { sourceId: opts.readScope?.sourceId, sourceIds: opts.readScope?.sourceIds, excludePrivate: opts.readScope?.excludePrivate, requireSafeChunks: opts.readScope?.requireSafeChunks,
        minTrust: opts.readScope?.minTrust, suppressFlagged: opts.readScope?.suppressFlagged, chunkSources: ['compiled_truth'], maxRows: wanted.length });
    const byId = new Map(windows.map(w => [w.page_id, w]));
    const at = Math.min(FACT_SOURCE_PAGE_RANK, results.length);
    const above = results[at - 1]?.score ?? 1;
    const added: SearchResult[] = [];
    for (const w of wanted) {
      const window = byId.get(Number(w.page_id));
      const chunk = window?.chunks[0];
      if (!window || !chunk) continue;
      added.push({
        page_id: Number(w.page_id), slug: window.slug, title: w.title ?? window.slug, type: window.type as SearchResult['type'], source_id: window.source_id,
        chunk_text: chunk.chunk_text, chunk_index: chunk.chunk_index, chunk_id: chunk.id, chunk_source: chunk.chunk_source as SearchResult['chunk_source'],
        score: above - (added.length + 1) * 1e-9, stale: false,
      } as SearchResult);
    }
    if (!added.length) return results;
    const rowCap = Math.max(results.length, (await opts.rowCap?.().catch(() => 0)) ?? 0);
    return [...results.slice(0, at), ...added, ...results.slice(at)].slice(0, rowCap);
  } catch (err) {
    // An engine that refuses a read here refuses the caller: the unchanged results would hide the refusal.
    rethrowCapabilityMissing(err);
    return results;
  }
}

/** `search.temporal_fact_reserve` is on ('true' | 'on' | '1' | 'yes'); off by default and on any read error. */
export async function temporalFactReserveEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    return configFlagOn(await engine.getConfig(TEMPORAL_FACT_RESERVE_KEY));
  } catch {
    return false;
  }
}

/** `search.query_facts_block` is on by default; 'false' | 'off' | '0' | 'no' turns it off, and so does any read error. */
export async function queryFactsBlockEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(QUERY_FACTS_BLOCK_KEY))?.trim().toLowerCase();
    return !(raw === 'false' || raw === 'off' || raw === '0' || raw === 'no');
  } catch {
    return false;
  }
}

/** `search.fact_source_pages` is on ('true' | 'on' | '1' | 'yes'); off by default and on any read error. */
export async function factSourcePagesEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    return configFlagOn(await engine.getConfig(FACT_SOURCE_PAGES_KEY));
  } catch {
    return false;
  }
}

/**
 * `search.query_facts_arm`: on by default (gates 1b and 2 passed,
 * docs/eval/decisions/query-facts-arm/); 'false' | 'off' | '0' | 'no' turns it
 * off. A config read error leaves it off.
 */
export async function queryFactsArmEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(QUERY_FACTS_ARM_KEY))?.trim().toLowerCase();
    return !(raw === 'false' || raw === 'off' || raw === '0' || raw === 'no');
  } catch {
    return false;
  }
}
