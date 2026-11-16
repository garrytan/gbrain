/**
 * Post-rerank identity injection by declared alias (T3 alias hop) plus the
 * opt-in single-token hop (#5428), and the exclude contract shared with the
 * exact-lookup tier. Split out of hybrid.ts; hybrid.ts re-exports the API.
 */

import type { SearchResult } from '../types.ts';
import { pageLeadSource, projectedLead } from '../page-window/bounded-lead.ts';
import { isIdentityEntity } from '../entities/resolve.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { isPrivatePageForCaller } from './private-visibility.ts';
import { contentTokenCount } from './title-match.ts';

// T3 — free-text alias hop tuning.
const ALIAS_HOP_PRESENT_BOOST = 1.10; // bounded boost when canonical already in results
const MAX_ALIAS_QUERY_TOKENS = 6;     // skip long queries (clearly not a chosen name)
const MAX_ALIAS_INJECT = 3;           // cap injected pages per query (collision safety)
// Opt-in qualified hop (`search.qualified_aliases`): sub-phrase windows of a query up to this many tokens.
const MAX_QUALIFIED_QUERY_TOKENS = 14;
const MIN_QUALIFIED_WINDOW_TOKENS = 3;
const MAX_QUALIFIED_WINDOW_TOKENS = 6;
const MIN_QUALIFIED_CONTENT_TOKENS = 3;

/**
 * T3 — free-text alias hop (retrieval-maxpool incident, the named-thing fix).
 *
 * When the normalized query EXACTLY matches a page's declared alias
 * ("Hall of Light" / "明堂" -> the Mingtang page), make sure that page is in
 * the result set: boost it if already present, inject it at top-of-organic +
 * epsilon if absent. This is the only layer that bridges true synonyms with
 * zero surface overlap — neither max-pool nor title-boost can.
 *
 * Precision guards (Codex#7/#10):
 *   - FULL normalized-query exact match only (not substring / not n-grams) —
 *     "light" won't fire unless the whole query normalizes to a stored alias.
 *     The opt-in qualified hop (`search.qualified_aliases`) is the one
 *     sub-phrase path: one visible claimant, 3+ content tokens, own stamp.
 *   - skip queries longer than MAX_ALIAS_QUERY_TOKENS (clearly prose, not a name).
 *   - bounded: present-boost is 1.10x; inject score is top-of-organic + ε,
 *     never an absolute 1.0 (D3 — aliases are not a ranking sledgehammer).
 *   - order-preserving: injected rows go to the front and a boosted row only
 *     climbs past lower-scored rows directly above it; every other row keeps
 *     its input (reranked) order.
 *   - collisions (two pages claim one alias): deterministic alpha order, capped.
 *
 * Fail-open: pre-v110 brains (no page_aliases table) and any lookup error
 * degrade to the input unchanged (D9). Returns a NEW array; caller re-slices.
 */
/**
 * Read-policy + exclude contract shared by the post-arm identity injections
 * (alias hop, exact-lookup tier). They add pages the engine arms never
 * filtered, so they re-apply the arms' exact-slug and prefix excludes.
 * `excludeSlugPrefixes` is the RESOLVED list (defaults + GBRAIN_SEARCH_EXCLUDE
 * + per-call, minus include_slug_prefixes — see resolveHardExcludes).
 */
export interface IdentityTierOpts {
  sourceId?: string;
  sourceIds?: string[];
  excludePrivate?: boolean;
  requireSafeChunks?: boolean;
  excludeSlugs?: string[];
  excludeSlugPrefixes?: string[];
}

/** True when an identity injection must skip `slug` under the caller's excludes. */
export function isExcludedIdentity(slug: string, opts: Pick<IdentityTierOpts, 'excludeSlugs' | 'excludeSlugPrefixes'>): boolean {
  if (opts.excludeSlugs?.includes(slug)) return true;
  return opts.excludeSlugPrefixes?.some((p) => slug.startsWith(p)) ?? false;
}

/**
 * A54 — the immutable half of the alias hop: the alias table read for the
 * normalized query (plus its tokens under `tokenHop`, and its qualified
 * windows under `qualified`). It never touches a result list, so the rerank
 * gate can read it before reranking and the apply step reuses it after, and
 * the alias table is read once per search.
 * `null` means the hop is a no-op for this query (empty, too long, or the
 * table is missing / the read failed — fail-open, D9). `fullQuery` is false
 * for a query over MAX_ALIAS_QUERY_TOKENS: only its qualified windows were
 * probed, so the full-query and token hops (and the rerank gate's alias
 * grades) keep the 6-token cap.
 */
export interface AliasHopLookup {
  qNorm: string;
  fullQuery: boolean;
  tokens: string[];
  qualified: string[];
  aliasMap: Map<string, Array<{ slug: string; source_id: string }>>;
}

/**
 * Sub-phrase windows of the normalized query for the qualified hop: 3 to
 * min(6, n - 1) tokens, longest first, then leftmost, each with at least 3
 * content tokens, for a query of 3 to 14 tokens. At most 42 windows.
 */
export function qualifiedAliasCandidates(qNorm: string): string[] {
  const tokens = qNorm.split(' ');
  const n = tokens.length;
  if (n < MIN_QUALIFIED_WINDOW_TOKENS || n > MAX_QUALIFIED_QUERY_TOKENS) return [];
  const out = new Set<string>();
  for (let len = Math.min(MAX_QUALIFIED_WINDOW_TOKENS, n - 1); len >= MIN_QUALIFIED_WINDOW_TOKENS; len--) {
    for (let i = 0; i + len <= n; i++) {
      const phrase = tokens.slice(i, i + len).join(' ');
      if (contentTokenCount(phrase) >= MIN_QUALIFIED_CONTENT_TOKENS) out.add(phrase);
    }
  }
  return [...out];
}

export async function lookupAliasHop(
  engine: import('../engine.ts').BrainEngine,
  query: string,
  opts: IdentityTierOpts & { tokenHop?: boolean; qualified?: boolean },
): Promise<AliasHopLookup | null> {
  if (!query) return null;
  const qNorm = normalizeAlias(query);
  if (!qNorm) return null;
  const fullQuery = qNorm.split(' ').length <= MAX_ALIAS_QUERY_TOKENS;
  const qualified = opts.qualified ? qualifiedAliasCandidates(qNorm) : [];
  if (!fullQuery && qualified.length === 0) return null;
  const tokens = fullQuery && opts.tokenHop
    ? [...new Set(qNorm.split(' '))].filter((t) => t.length >= 2 && t !== qNorm)
    : [];
  const probe = fullQuery ? [qNorm, ...tokens, ...qualified] : qualified;
  try {
    return { qNorm, fullQuery, tokens, qualified, aliasMap: await engine.resolveAliases(probe, opts) };
  } catch {
    return null; // pre-v110 table-missing OR transient error -> fail-open
  }
}

/** The full-query alias canonicals the hop would boost or inject: excludes applied, deterministic order, capped. */
export function aliasHopCanonicals(lookup: AliasHopLookup, opts: IdentityTierOpts): Array<{ slug: string; source_id: string }> {
  if (!lookup.fullQuery) return [];
  return [...(lookup.aliasMap.get(lookup.qNorm) ?? [])]
    .filter(ref => !isExcludedIdentity(ref.slug, opts))
    .sort((a, b) => (a.source_id === b.source_id ? a.slug.localeCompare(b.slug) : a.source_id.localeCompare(b.source_id)))
    .slice(0, MAX_ALIAS_INJECT);
}

export async function applyAliasHop(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  query: string,
  opts: IdentityTierOpts & { tokenHop?: boolean; qualified?: boolean },
): Promise<SearchResult[]> {
  return applyAliasHopLookup(engine, results, await lookupAliasHop(engine, query, opts), opts);
}

/** The apply half of the alias hop: boost or inject the looked-up canonicals into `results`. */
export async function applyAliasHopLookup(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  lookup: AliasHopLookup | null,
  opts: IdentityTierOpts,
): Promise<SearchResult[]> {
  if (!lookup) return results;
  const refs = lookup.fullQuery ? lookup.aliasMap.get(lookup.qNorm) : undefined;
  if (!refs || refs.length === 0) {
    const led = await applyQualifiedAliasHop(engine, results, lookup, opts);
    if (led) return led;
    return lookup.tokens.length > 0 ? applyAliasTokenHop(engine, results, lookup.tokens, lookup.aliasMap, opts) : results;
  }

  // Deterministic + capped. Source-scoped: each canonical is a (source_id, slug)
  // pair so a federated caller boosts/injects the RIGHT source's page, never
  // collapsing or cross-injecting (P0 source-isolation contract).
  const ordered = aliasHopCanonicals(lookup, opts);
  const out = [...results];
  let injectScore = topOrganicScore(out);

  for (const ref of ordered) {
    let idx = out.findIndex(r => r.slug === ref.slug && (r.source_id ?? 'default') === ref.source_id);
    if (idx >= 0) {
      const hit = out[idx];
      if (Number.isFinite(hit.score)) hit.score *= ALIAS_HOP_PRESENT_BOOST;
      hit.alias_hit = true;
      // Bubble the boosted row past lower-scored rows directly above it; never
      // re-sort the list, which would discard a reranked order (post-rerank
      // `score` is still the fusion score, not the rerank order).
      while (idx > 0 && out[idx - 1].score < hit.score) {
        out[idx] = out[idx - 1];
        idx--;
      }
      out[idx] = hit;
      continue;
    }
    const page = await fetchAliasCanonical(engine, ref, opts);
    if (!page) continue;
    injectScore += 1e-6;
    out.unshift(await aliasInjectedRow(engine, page, ref, injectScore));
  }
  return out;
}

/**
 * The page the qualified hop leads with: the first window (longest, then
 * leftmost) that has a claimant after excludes decides. One claimant leads;
 * two or more suppress the hop. Claimants come from the caller's read policy,
 * so a page the caller cannot read never counts.
 */
function qualifiedAliasCanonical(lookup: AliasHopLookup, opts: IdentityTierOpts): { slug: string; source_id: string } | null {
  for (const phrase of lookup.qualified) {
    const refs = (lookup.aliasMap.get(phrase) ?? []).filter((ref) => !isExcludedIdentity(ref.slug, opts));
    if (refs.length > 0) return refs.length === 1 ? refs[0] : null;
  }
  return null;
}

/**
 * Opt-in qualified alias hop (`search.qualified_aliases`): moves the one page
 * whose alias is a sub-phrase of the query to the front at top-of-organic + ε,
 * or injects it when absent, stamped `qualified_alias_hit` (never
 * `alias_hit`: evidence does not read a mention as an identity match).
 * Returns null when it does not fire, so the token hop runs as before.
 */
async function applyQualifiedAliasHop(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  lookup: AliasHopLookup,
  opts: IdentityTierOpts,
): Promise<SearchResult[] | null> {
  const ref = qualifiedAliasCanonical(lookup, opts);
  if (!ref) return null;
  const score = topOrganicScore(results) + 1e-6;
  const idx = results.findIndex((r) => r.slug === ref.slug && (r.source_id ?? 'default') === ref.source_id);
  if (idx >= 0) {
    const out = [...results];
    const [hit] = out.splice(idx, 1);
    return [{ ...hit, score, qualified_alias_hit: true }, ...out];
  }
  const page = await fetchAliasCanonical(engine, ref, opts);
  if (!page) return null;
  return [await aliasInjectedRow(engine, page, ref, score, 'qualified_alias_hit'), ...results];
}

/** Cap on pages the single-token alias hop moves or injects per query. */
const MAX_ALIAS_TOKEN_HOP = 2;

/**
 * #5428 — opt-in single-token alias hop (`tokenHop`). A query token that is
 * the alias of exactly ONE page, and that page is a person/company identity
 * page (`isIdentityEntity`), moves that page to the front — or injects it
 * when absent. Ambiguous tokens and excluded pages are skipped; at most
 * MAX_ALIAS_TOKEN_HOP pages; every other row keeps its input order.
 */
async function applyAliasTokenHop(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  tokens: string[],
  aliasMap: Map<string, Array<{ slug: string; source_id: string }>>,
  opts: IdentityTierOpts,
): Promise<SearchResult[]> {
  const out = [...results];
  let injectScore = topOrganicScore(out);
  const hopped = new Set<string>();
  for (const token of tokens) {
    if (hopped.size >= MAX_ALIAS_TOKEN_HOP) break;
    const refs = (aliasMap.get(token) ?? []).filter((ref) => !isExcludedIdentity(ref.slug, opts));
    if (refs.length !== 1) continue;
    const ref = refs[0];
    const key = `${ref.source_id}:${ref.slug}`;
    if (hopped.has(key)) continue;
    injectScore += 1e-6;
    const idx = out.findIndex((r) => r.slug === ref.slug && (r.source_id ?? 'default') === ref.source_id);
    if (idx >= 0) {
      const hit = out[idx];
      if (!isIdentityEntity(hit.slug, hit.type)) continue;
      out.splice(idx, 1);
      out.unshift({ ...hit, score: injectScore, alias_hit: true });
      hopped.add(key);
      continue;
    }
    const page = await fetchAliasCanonical(engine, ref, opts);
    if (!page || !isIdentityEntity(page.slug, page.type)) continue;
    out.unshift(await aliasInjectedRow(engine, page, ref, injectScore));
    hopped.add(key);
  }
  return out;
}

function topOrganicScore(results: SearchResult[]): number {
  const top = results.reduce((m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m), 0);
  return top > 0 ? top : 1.0;
}

/** Fetch an alias canonical in its OWN source, re-applying the private predicate. */
async function fetchAliasCanonical(
  engine: import('../engine.ts').BrainEngine,
  ref: { slug: string; source_id: string },
  opts: IdentityTierOpts,
): Promise<import('../types.ts').Page | null> {
  let page;
  try {
    page = await engine.getPage(ref.slug, { sourceId: ref.source_id, excludePrivate: opts.excludePrivate });
  } catch {
    return null;
  }
  if (!page) return null;
  // #4352 — the alias inject path bypasses the engines' SQL visibility
  // clause (getPage, not search); re-apply the private predicate here so
  // an untrusted caller can't hop into a `visibility: private` page.
  if (opts.excludePrivate && isPrivatePageForCaller(page)) return null;
  return page;
}

async function aliasInjectedRow(
  engine: import('../engine.ts').BrainEngine, page: import('../types.ts').Page, ref: { source_id: string }, score: number,
  stamp: 'alias_hit' | 'qualified_alias_hit' = 'alias_hit',
): Promise<SearchResult> {
  return {
    // #2339-sibling: include page_id. The `as SearchResult` cast hid its
    // absence, so any consumer reading page_id off an alias-injected result got
    // undefined — e.g. listActiveTakesForPages bound undefined/NaN into
    // ANY($1::int[]) and crashed the contradiction probe on real Postgres.
    page_id: page.id,
    slug: page.slug,
    title: page.title,
    type: page.type,
    source_id: page.source_id ?? ref.source_id,
    // Large pages: a bounded, withdrawal-overlaid prefix is sanitized, never the whole body.
    chunk_text: (await projectedLead(engine, { slug: page.slug, source_id: page.source_id ?? ref.source_id, compiled_truth: await pageLeadSource(engine, page) })).slice(0, 200),
    chunk_index: 0,
    chunk_id: 0,
    score,
    base_score: score,
    ...(stamp === 'alias_hit' ? { alias_hit: true } : { qualified_alias_hit: true }),
  } as SearchResult;
}
