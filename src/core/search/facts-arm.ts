/**
 * Facts arm for `query` (`search.query_facts_arm`, default off; gates in
 * docs/eval/decisions/query-facts-arm/). A correction saved with `remember`
 * lives in the facts table, which page search never ranks, so the stale page
 * text answers instead. With the key on, `query` adds the active facts that
 * match the question as rows of their own, inside the caller's row count and
 * token budget, and stamps a page row `superseded_claim` when a newer active
 * fact covers the same entity and typed claim slot as a fact taken from that
 * page.
 *
 * Matching: query terms against the fact text and entity (at least half of
 * the content terms), cosine against the query embedding hybrid search
 * already computed (no extra model call; skipped when there is none), and the
 * facts of the one entity page the query names. Matches are ordered newest
 * valid_from first. Read policy is recall's: source scope, active rows only,
 * audit rows excluded, and world-visible facts with non-private provenance
 * for remote callers.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, SearchResult } from '../types.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { getEmbeddingModel } from '../ai/gateway.ts';
import { privateProvenanceFilterFragment, resolveExcludePrivatePages } from './private-visibility.ts';
import { quarantinedProvenanceFilterFragment } from '../quarantine.ts';
import { namedEntity } from './entity-anchor.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { enforceTokenBudget, resultTokens } from './token-budget.ts';
import { factDateHeader } from './evidence-date.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import type { TrustTier } from '../trust/tier.ts';

export const QUERY_FACTS_ARM_KEY = 'search.query_facts_arm';
/** Fact rows added per query at most. */
export const MAX_FACT_ROWS = 3;
/** Cosine similarity a fact needs against the query embedding to count as a match on its own. */
export const FACT_COSINE_MIN = 0.6;
/** Share of the query's content terms a fact's text and entity must hold to match by keyword. */
const TERM_SHARE_MIN = 0.5;

/** Temporal fact reserve (docs/eval/decisions/temporal-fact-reserve/): off by default. */
export const TEMPORAL_FACT_RESERVE_KEY = 'search.temporal_fact_reserve';
/** Share of the caller's token budget reserved facts may take. */
export const TEMPORAL_RESERVE_SHARE = 0.15;
export const MAX_RESERVE_ROWS = 20;
/** Share of the caller's row count reserved facts may take (at least one row). */
export const TEMPORAL_RESERVE_ROW_SHARE = 0.3;
const RESERVE_COSINE_MIN = 0.5;
const RESERVE_TERM_SHARE_MIN = 0.34;
const DATED_BONUS = 0.1;
/** valid_from this far from created_at means the writer supplied the date. */
const DATED_MIN_MS = 24 * 60 * 60 * 1000;
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const TEMPORAL_CUE = new RegExp(`\\b(when|before|after|since|until|till|during|ago|earlier|later|earliest|latest|first|last|previous|next|dates?|day|week|month|year|order|sequence|${MONTHS})\\b`
  + `|\\bhow (long|many (days|weeks|months|years))\\b|\\bwhat time\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');

/** Whether `query` carries a deterministic temporal cue (the preregistered word, phrase, ISO date and month-name list). */
export function hasTemporalCue(query: string): boolean {
  return TEMPORAL_CUE.test(query);
}

const STOPWORDS = new Set(['the', 'and', 'for', 'who', 'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'our', 'your', 'their',
  'now', 'current', 'currently', 'should', 'does', 'did', 'has', 'have', 'how', 'any', 'all', 'about', 'into', 'its', 'next', 'use', 'uses', 'tell']);

export interface FactsArmScope {
  sourceId?: string; sourceIds?: string[]; remote: boolean;
  /** #5575 read floor and activation control, applied in the candidate SQL like every retrieval arm. */
  minTrust?: TrustTier; suppressFlagged?: boolean;
}

interface FactCandidate {
  id: number; fact: string; kind: string; entity_slug: string | null; source_id: string; source: string;
  valid_from: Date | string; valid_until: Date | string | null; created_at?: Date | string | null; claim_metric: string | null; claim_period: string | null;
}

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]+/gu) ?? [])].filter(t => t.length >= 3 && !STOPWORDS.has(t)).slice(0, 12);
}

const day = (v: Date | string | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);

type ScoredCandidate = FactCandidate & { similarity?: number; matched: number; terms: number; entity: boolean };

/**
 * Active facts near `query` under the caller's read policy: the keyword
 * matches (with how many query terms each holds), the `cosineLimit` nearest by
 * the query embedding (with their similarity), and the named entity's newest
 * `entityLimit` facts.
 */
async function collectFactCandidates(engine: BrainEngine, query: string, scope: FactsArmScope, queryEmbedding: Float32Array | null | undefined,
  limits: { cosine: number; entity: number }): Promise<ScoredCandidate[]> {
  const terms = queryTerms(query);
  const sources = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'];
  const params: unknown[] = [sources, [...AUDIT_ROW_SOURCES]];
  const excludePrivate = await resolveExcludePrivatePages(engine, scope.remote);
  const base = `f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
    AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($2::text[]) AND ${quarantinedProvenanceFilterFragment('f')}
    ${scope.remote ? `AND f.visibility = 'world'` : ''} ${excludePrivate ? `AND ${privateProvenanceFilterFragment('f')}` : ''}
    AND ${projectionEligibleSql('facts', 'f', { floor: scope.minTrust, suppressFlagged: scope.suppressFlagged })}`;
  const cols = 'f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period';
  const found = new Map<number, ScoredCandidate>();
  const add = (r: FactCandidate & { haystack?: string; similarity?: number }, entity = false) => {
    const prev = found.get(Number(r.id));
    const haystack = r.haystack ?? `${r.fact} ${r.entity_slug ?? ''}`.toLowerCase();
    found.set(Number(r.id), { ...r, similarity: r.similarity !== undefined ? Number(r.similarity) : prev?.similarity,
      matched: terms.filter(t => haystack.includes(t)).length, terms: terms.length, entity: entity || !!prev?.entity });
  };
  if (terms.length) {
    const rows = await engine.executeRaw<FactCandidate & { haystack: string }>(
      `WITH q AS (SELECT NULLIF(replace(plainto_tsquery($3::regconfig, $4)::text, ' & ', ' | '), '')::tsquery AS q)
       SELECT ${cols}, lower(f.fact || ' ' || COALESCE(f.entity_slug, '')) AS haystack
       FROM facts f, q WHERE ${base} AND q.q IS NOT NULL
         AND to_tsvector($3::regconfig, f.fact || ' ' || replace(COALESCE(f.entity_slug, ''), '-', ' ')) @@ q.q
       ORDER BY ts_rank_cd(to_tsvector($3::regconfig, f.fact || ' ' || replace(COALESCE(f.entity_slug, ''), '-', ' ')), q.q) DESC, f.valid_from DESC
       LIMIT 50`, [...params, getFtsLanguage(), terms.join(' ')]);
    for (const r of rows) add(r);
  }
  if (queryEmbedding && queryEmbedding.length) {
    const model = getEmbeddingModel();
    const lit = `[${Array.from(queryEmbedding).join(',')}]`;
    const rows = await engine.executeRaw<FactCandidate & { similarity: number }>(
      `SELECT ${cols}, 1 - (f.embedding <=> $3::vector) AS similarity FROM facts f
       WHERE ${base} AND f.embedding IS NOT NULL AND f.embedding_model = $4 AND f.embedded_text_hash = md5(f.fact)
         AND vector_dims(f.embedding) = $5
       ORDER BY f.embedding <=> $3::vector LIMIT ${limits.cosine}`, [...params, lit, model, queryEmbedding.length]).catch(() => []);
    for (const r of rows) add(r);
  }
  const entity = await namedEntity(engine, query, { sourceIds: sources, excludePrivate }).catch(() => null);
  if (entity) {
    const rows = await engine.executeRaw<FactCandidate>(
      `SELECT ${cols} FROM facts f WHERE ${base} AND f.entity_slug = $3 ORDER BY f.valid_from DESC, f.id DESC LIMIT ${limits.entity}`,
      [...params, entity.slug]);
    for (const r of rows) add(r, true);
  }
  return [...found.values()];
}

/** The active facts that match `query`, newest valid_from first (at most MAX_FACT_ROWS). */
export async function matchQueryFacts(engine: BrainEngine, query: string, scope: FactsArmScope, queryEmbedding?: Float32Array | null): Promise<FactCandidate[]> {
  const candidates = await collectFactCandidates(engine, query, scope, queryEmbedding, { cosine: 10, entity: MAX_FACT_ROWS });
  return candidates
    .filter(c => c.entity || (c.similarity ?? -1) >= FACT_COSINE_MIN || (c.terms > 0 && c.matched >= Math.max(Math.min(2, c.terms), Math.ceil(c.terms * TERM_SHARE_MIN))))
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

const isDated = (f: FactCandidate) => !!f.created_at && Math.abs(new Date(f.valid_from).getTime() - new Date(f.created_at).getTime()) > DATED_MIN_MS;

/**
 * Temporal fact reserve: for a query with a temporal cue and a token budget,
 * the facts that best match the question (cosine + term share, +0.1 when the
 * fact carries a real date) take up to TEMPORAL_RESERVE_SHARE of the budget and
 * TEMPORAL_RESERVE_ROW_SHARE of the row count (1 to MAX_RESERVE_ROWS rows), rendered with their date header and ordered oldest
 * first after the pages. The row count never grows (a fact takes a free row,
 * else the lowest page row) and pages fill the rest of the budget. No match or
 * any error: the results unchanged.
 */
export async function applyTemporalFactReserve(engine: BrainEngine, query: string, results: SearchResult[], opts: FactsArmOpts & { budget: number }): Promise<SearchResult[]> {
  try {
    const candidates = await collectFactCandidates(engine, query, opts, opts.queryEmbedding, { cosine: 50, entity: MAX_RESERVE_ROWS });
    const scored = candidates
      .map(c => ({ c, share: c.terms ? c.matched / c.terms : 0, cos: c.similarity ?? 0 }))
      .filter(x => x.cos >= RESERVE_COSINE_MIN || x.share >= RESERVE_TERM_SHARE_MIN)
      .map(x => ({ c: x.c, score: x.cos + x.share + (isDated(x.c) ? DATED_BONUS : 0) }))
      .sort((a, b) => b.score - a.score || Number(b.c.id) - Number(a.c.id));
    if (!scored.length) return results;
    const rowCap = Math.max(results.length, (await opts.rowCap?.().catch(() => 0)) ?? 0);
    const pageSlugs = await readableEntityPages(engine, scored.map(x => x.c), opts.readScope).catch(() => new Set<string>());
    const pagesFloor = results.reduce((m, r) => (Number.isFinite(r.score) && r.score < m ? r.score : m), results[0]?.score ?? 1);
    let left = Math.floor(opts.budget * TEMPORAL_RESERVE_SHARE);
    const chosen: Array<{ c: FactCandidate; row: SearchResult }> = [];
    for (const { c } of scored) {
      if (chosen.length >= Math.min(MAX_RESERVE_ROWS, Math.max(1, Math.floor(rowCap * TEMPORAL_RESERVE_ROW_SHARE)))) break;
      const row = factRow(c, 0, c.entity_slug && pageSlugs.has(`${c.source_id}\u0000${c.entity_slug}`) ? c.entity_slug : undefined);
      row.chunk_text = `${factDateHeader(c)}\n${c.fact}`;
      const cost = resultTokens(row);
      if (cost > left) continue;
      left -= cost;
      chosen.push({ c, row });
    }
    if (!chosen.length) return results;
    chosen.sort((a, b) => new Date(a.c.valid_from).getTime() - new Date(b.c.valid_from).getTime() || Number(a.c.id) - Number(b.c.id));
    const rows = chosen.map(({ row }, i) => ({ ...row, score: pagesFloor - (i + 1) * 1e-6 }));
    let pages = results.slice(0, Math.max(0, Math.min(results.length, rowCap - rows.length))).map(r => ({ ...r }));
    if (opts.tokenBudget) pages = enforceTokenBudget(pages, Math.max(1, opts.tokenBudget - rows.reduce((n, r) => n + resultTokens(r), 0))).results;
    const merged = [...pages, ...rows];
    await stampSupersededClaims(engine, merged, chosen.map(x => x.c)).catch(() => undefined);
    return merged;
  } catch {
    return results;
  }
}

/** `search.temporal_fact_reserve` is on ('true' | 'on' | '1' | 'yes'); off by default and on any read error. */
export async function temporalFactReserveEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(TEMPORAL_FACT_RESERVE_KEY))?.trim().toLowerCase();
    return raw === 'true' || raw === 'on' || raw === '1' || raw === 'yes';
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
