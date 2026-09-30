/**
 * Post-rerank identity injection by declared alias (T3 alias hop) plus the
 * opt-in single-token hop (#5428), and the exclude contract shared with the
 * exact-lookup tier. Split out of hybrid.ts; hybrid.ts re-exports the API.
 */

import type { SearchResult } from '../types.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { isIdentityEntity } from '../entities/resolve.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { isPrivatePage } from './private-visibility.ts';

// T3 — free-text alias hop tuning.
const ALIAS_HOP_PRESENT_BOOST = 1.10; // bounded boost when canonical already in results
const MAX_ALIAS_QUERY_TOKENS = 6;     // skip long queries (clearly not a chosen name)
const MAX_ALIAS_INJECT = 3;           // cap injected pages per query (collision safety)

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

export async function applyAliasHop(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  query: string,
  opts: IdentityTierOpts & { tokenHop?: boolean },
): Promise<SearchResult[]> {
  if (!query) return results;
  const qNorm = normalizeAlias(query);
  if (!qNorm || qNorm.split(' ').length > MAX_ALIAS_QUERY_TOKENS) return results;
  const tokens = opts.tokenHop
    ? [...new Set(qNorm.split(' '))].filter((t) => t.length >= 2 && t !== qNorm)
    : [];

  let aliasMap: Map<string, Array<{ slug: string; source_id: string }>>;
  try {
    aliasMap = await engine.resolveAliases([qNorm, ...tokens], opts);
  } catch {
    return results; // pre-v110 table-missing OR transient error -> fail-open
  }
  const refs = aliasMap.get(qNorm);
  if (!refs || refs.length === 0) {
    return tokens.length > 0 ? applyAliasTokenHop(engine, results, tokens, aliasMap, opts) : results;
  }

  // Deterministic + capped. Source-scoped: each canonical is a (source_id, slug)
  // pair so a federated caller boosts/injects the RIGHT source's page, never
  // collapsing or cross-injecting (P0 source-isolation contract).
  const ordered = [...refs]
    .filter(ref => !isExcludedIdentity(ref.slug, opts))
    .sort((a, b) => (a.source_id === b.source_id ? a.slug.localeCompare(b.slug) : a.source_id.localeCompare(b.source_id)))
    .slice(0, MAX_ALIAS_INJECT);
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
    out.unshift(aliasInjectedRow(page, ref, injectScore));
  }
  return out;
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
    out.unshift(aliasInjectedRow(page, ref, injectScore));
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
  if (opts.excludePrivate && isPrivatePage(page)) return null;
  return page;
}

function aliasInjectedRow(page: import('../types.ts').Page, ref: { source_id: string }, score: number): SearchResult {
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
    chunk_text: sanitizeRemoteBody(page.compiled_truth ?? '').slice(0, 200),
    chunk_index: 0,
    chunk_id: 0,
    score,
    base_score: score,
    alias_hit: true,
  } as SearchResult;
}
