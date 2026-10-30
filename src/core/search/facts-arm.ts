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
import { resolveExcludePrivatePages } from './private-visibility.ts';
import { admitted, collectFactCandidates, FACTS_ARM_COSINE_MIN, queryTerms, scoreFactCandidates, type FactCandidate as PoolCandidate, type FactPoolScope } from './fact-relevance.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { enforceTokenBudget, resultTokens } from './token-budget.ts';
import { configFlagOn, factDateHeader } from './evidence-date.ts';
import type { TrustTier } from '../trust/tier.ts';
import { conversationSignal } from './evidence-delivery.ts';

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

/** GBRA-205 facts block (`search.query_facts_block`, default off): every budgeted query, ahead of the pages. */
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

export interface FactsArmScope {
  sourceId?: string; sourceIds?: string[]; remote: boolean;
  /** #5575 read floor and activation control, applied in the candidate SQL like every retrieval arm. */
  minTrust?: TrustTier; suppressFlagged?: boolean;
}

type FactCandidate = PoolCandidate;

async function poolScope(engine: BrainEngine, scope: FactsArmScope): Promise<FactPoolScope> {
  return { ...scope, excludePrivate: await resolveExcludePrivatePages(engine, scope.remote) };
}

const day = (v: Date | string | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);

/** The active facts that match `query`, newest valid_from first (at most MAX_FACT_ROWS). */
export async function matchQueryFacts(engine: BrainEngine, query: string, scope: FactsArmScope, queryEmbedding?: Float32Array | null): Promise<FactCandidate[]> {
  const { candidates } = await collectFactCandidates(engine, query, await poolScope(engine, scope), queryEmbedding, { depth: { keyword: 50, cosine: 10, entity: MAX_FACT_ROWS } });
  const terms = queryTerms(query);
  const matched = (c: FactCandidate) => { const haystack = `${c.fact} ${c.entity_slug ?? ''}`.toLowerCase(); return terms.filter(t => haystack.includes(t)).length; };
  return candidates
    .filter(c => c.entity || (c.similarity ?? -1) >= FACT_COSINE_MIN || (terms.length > 0 && matched(c) >= Math.max(Math.min(2, terms.length), Math.ceil(terms.length * TERM_SHARE_MIN))))
    .sort((a, b) => new Date(b.valid_from).getTime() - new Date(a.valid_from).getTime() || Number(b.id) - Number(a.id))
    .slice(0, MAX_FACT_ROWS);
}

function factRow(f: FactCandidate, score: number, pageSlug: string | undefined): SearchResult {
  const from = day(f.valid_from);
  const until = day(f.valid_until);
  const args: Record<string, string> = f.entity_slug ? { entity: f.entity_slug } : { grep: f.fact.slice(0, 60) };
  if (f.source_id !== 'default') args.source_id = f.source_id;
  return {
    result_type: 'fact', fact_id: String(f.id), ...(pageSlug ? { page_slug: pageSlug } : {}), follow_up: { op: 'recall', args },
    slug: `facts/${f.id}`, page_id: 0, title: f.entity_slug ? `Saved fact about ${f.entity_slug}` : 'Saved fact', type: 'note',
    chunk_text: `Saved fact (${f.kind}; valid from ${from ?? 'unknown'}${until ? ` to ${until}` : ''}; provenance: ${f.source}): ${f.fact}`,
    chunk_source: 'compiled_truth', chunk_id: -Number(f.id), chunk_index: 0, score, stale: false, source_id: f.source_id,
    fact_row: { id: Number(f.id), valid_from: new Date(f.valid_from).toISOString(), valid_until: f.valid_until ? new Date(f.valid_until).toISOString() : null },
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
  const rows = await engine.executeRaw<{ id: number; source_markdown_slug: string; source_id: string; entity_slug: string; claim_metric: string; claim_period: string | null; valid_from: Date | string }>(
    `SELECT f.id, f.source_markdown_slug, f.source_id, f.entity_slug, f.claim_metric, f.claim_period, f.valid_from FROM facts f
     WHERE f.source_markdown_slug = ANY($1::text[]) AND f.entity_slug = ANY($2::text[]) AND f.claim_metric IS NOT NULL`,
    [[...new Set(pages.map(r => r.slug))], [...new Set(typed.map(f => f.entity_slug!))]]);
  for (const r of pages) {
    for (const old of rows.filter(o => o.source_markdown_slug === r.slug && o.source_id === (r.source_id ?? o.source_id))) {
      const newer = typed.find(f => f.entity_slug === old.entity_slug && f.claim_metric === old.claim_metric
        && (!f.claim_period || !old.claim_period || f.claim_period === old.claim_period)
        && Number(f.id) !== Number(old.id) && new Date(f.valid_from).getTime() > new Date(old.valid_from).getTime());
      if (newer) { r.superseded_claim = { fact_id: Number(newer.id), valid_from: new Date(newer.valid_from).toISOString() }; break; }
    }
  }
}

/** `source\0slug` keys of the facts' entity pages (page slug = fact entity_slug, same source) the caller may read. */
async function readableEntityPages(engine: BrainEngine, facts: FactCandidate[], scope: PageReadScope | undefined): Promise<Set<string>> {
  const slugs = [...new Set(facts.flatMap(f => f.entity_slug ? [f.entity_slug] : []))];
  if (!slugs.length) return new Set();
  const params: unknown[] = [slugs];
  const filter = pageReadFilter('p', scope, params, true);
  const rows = await engine.executeRaw<{ slug: string; source_id: string }>(`SELECT p.slug, p.source_id FROM pages p WHERE p.slug = ANY($1::text[]) AND ${filter}`, params);
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
    const pageSlugs = await readableEntityPages(engine, shown, opts.readScope).catch(() => new Set<string>());
    let rows = shown.map((f, i) => factRow(f, floor - (i + 1) * 1e-6, f.entity_slug && pageSlugs.has(`${f.source_id}\u0000${f.entity_slug}`) ? f.entity_slug : undefined));
    if (opts.tokenBudget) {
      let left = opts.tokenBudget - enforceTokenBudget(pages, opts.tokenBudget).meta.used;
      rows = rows.filter(r => { const cost = resultTokens(r); if (cost > left) return false; left -= cost; return true; });
    }
    if (!rows.length) return results;
    const merged = [...pages, ...rows];
    await stampSupersededClaims(engine, merged, facts).catch(() => undefined);
    return merged;
  } catch {
    return results;
  }
}

interface ReservePolicy {
  share: number;
  maxRows: number;
  /** Share of the caller's row count the facts may take (they replace the lowest page rows); null: they add rows. */
  rowShare: number | null;
  /** Where the facts go: after the pages (temporal reserve) or ahead of them (facts block). */
  position: 'after' | 'before';
}

const TEMPORAL_RESERVE: ReservePolicy = { share: TEMPORAL_RESERVE_SHARE, maxRows: MAX_RESERVE_ROWS, rowShare: TEMPORAL_RESERVE_ROW_SHARE, position: 'after' };
const FACTS_BLOCK: ReservePolicy = { share: QUERY_FACTS_BLOCK_SHARE, maxRows: MAX_FACTS_BLOCK_ROWS, rowShare: null, position: 'before' };

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
 * temporal reserve, for every budgeted query, up to QUERY_FACTS_BLOCK_SHARE
 * of the budget and MAX_FACTS_BLOCK_ROWS rows, oldest first ahead of the
 * pages. The facts add rows (every page row stays) and pages fill the rest of
 * the budget. No match or any error: the results unchanged.
 */
export function applyFactsBlock(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts & { budget: number }): Promise<SearchResult[]> {
  return applyFactReserve(engine, query, results, opts, FACTS_BLOCK);
}

async function applyFactReserve(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts & { budget: number }, policy: ReservePolicy): Promise<SearchResult[]> {
  try {
    const { candidates } = await collectFactCandidates(engine, query, await poolScope(engine, opts), opts.queryEmbedding,
      { depth: { keyword: 50, cosine: 50, entity: policy.maxRows }, cosineForAll: true });
    const scored = scoreFactCandidates(query, candidates).filter(s => admitted(s, 'reserve')).map(s => ({ c: s.candidate }));
    if (!scored.length) return results;
    const rowCap = Math.max(results.length, (await opts.rowCap?.().catch(() => 0)) ?? 0);
    const maxRows = policy.rowShare === null ? policy.maxRows : Math.min(policy.maxRows, Math.max(1, Math.floor(rowCap * policy.rowShare)));
    const pageSlugs = await readableEntityPages(engine, scored.map(x => x.c), opts.readScope).catch(() => new Set<string>());
    let left = Math.floor(opts.budget * policy.share);
    const chosen: Array<{ c: FactCandidate; row: SearchResult }> = [];
    for (const { c } of scored) {
      if (chosen.length >= maxRows) break;
      const row = factRow(c, 0, c.entity_slug && pageSlugs.has(`${c.source_id}\u0000${c.entity_slug}`) ? c.entity_slug : undefined);
      row.chunk_text = `${factDateHeader(c)}\n${c.fact}`;
      const cost = resultTokens(row);
      if (cost > left) continue;
      left -= cost;
      chosen.push({ c, row });
    }
    if (!chosen.length) return results;
    chosen.sort((a, b) => new Date(a.c.valid_from).getTime() - new Date(b.c.valid_from).getTime() || Number(a.c.id) - Number(b.c.id));
    const pagesFloor = results.reduce((m, r) => (Number.isFinite(r.score) && r.score < m ? r.score : m), results[0]?.score ?? 1);
    const pagesTop = results.reduce((m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m), results[0]?.score ?? 1);
    const rows = policy.position === 'after'
      ? chosen.map(({ row }, i) => ({ ...row, score: pagesFloor - (i + 1) * 1e-6 }))
      : chosen.map(({ row }, i) => ({ ...row, score: pagesTop + (chosen.length - i) * 1e-6 }));
    let pages = (policy.rowShare === null ? results : results.slice(0, Math.max(0, Math.min(results.length, rowCap - rows.length)))).map(r => ({ ...r }));
    if (opts.tokenBudget) pages = enforceTokenBudget(pages, Math.max(1, opts.tokenBudget - rows.reduce((n, r) => n + resultTokens(r), 0))).results;
    const merged = policy.position === 'after' ? [...pages, ...rows] : [...rows, ...pages];
    await stampSupersededClaims(engine, merged, chosen.map(x => x.c)).catch(() => undefined);
    return merged;
  } catch {
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
 * count never grows (the lowest rows give way). No match or any error: the
 * results unchanged.
 */
export async function applyFactSourcePages(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts): Promise<SearchResult[]> {
  try {
    const { candidates } = await collectFactCandidates(engine, query, await poolScope(engine, opts), opts.queryEmbedding,
      { depth: { keyword: 50, cosine: 50, entity: MAX_RESERVE_ROWS }, cosineForAll: true });
    const ranked = scoreFactCandidates(query, candidates).filter(s => admitted(s, 'reserve')).map(s => Number(s.candidate.id));
    if (!ranked.length) return results;
    const sources = await engine.executeRaw<{ id: number; page_id: number; slug: string; title: string | null; type: string | null }>(
      `SELECT f.id, p.id AS page_id, p.slug, p.title, p.type FROM facts f
       JOIN pages p ON p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.deleted_at IS NULL
       WHERE f.id = ANY($1::bigint[]) AND f.source_markdown_slug IS DISTINCT FROM f.entity_slug`, [ranked]);
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
  } catch {
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
