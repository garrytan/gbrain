/**
 * #1663 — structural exact-lookup tier (identity resolution before ranking).
 *
 * The floor/ceiling redesign's floor: when the query IS a page identity — a
 * slug ('people/alice-example'), an exact page title, or a declared alias —
 * no amount of RRF/rerank scoring should be able to bury that page. The
 * alias half already ships (applyAliasHop, T3); this tier adds the two
 * structural probes it deliberately skipped:
 *
 *   slug probe   — a slug-shaped query resolves via engine.getPage directly.
 *   title probe  — an exact (normalized) full-title equality match, read off
 *                  the ALREADY-FETCHED page-grain title arm (zero extra
 *                  queries on the hot path).
 *
 * Supersession-filtered: a page that a `supersedes` link marks stale is
 * NEVER top-injected by this tier (the organic pipeline still surfaces it,
 * downranked + stamped, via applySupersedeDownrank). Current canon wins the
 * identity slot.
 *
 * Wiring: applyExactLookupTier runs right after applyAliasHop on all three
 * hybrid return paths, gated on isLookupShapedQuery (pure, cheap). Hits
 * already in the organic set are promoted to rank-1; absent hits inject at
 * top-of-organic + epsilon (the alias-hop injection shape, page_id
 * included). Injected/promoted rows carry:
 *   - exact_lookup: 'slug' | 'title'  (autocut preserve predicate + telemetry)
 *   - slug hits: alias_hit=true        (evidence → alias_hit → 'exists')
 *   - title hits: title_match_boost    (evidence → exact_title_match → 'exists')
 * so the T4 evidence/create_safety contract reads them as identity matches
 * without widening the frozen EVIDENCE_ENUM.
 *
 * Fail-open everywhere: a probe error returns the organic results unchanged.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { isLookupShapedQuery } from './query-intent.ts';
import { applySupersedeDownrank } from './hybrid.ts';

/** Cap on tier injections per query (mirrors the alias hop's discipline). */
export const MAX_EXACT_LOOKUP_INJECT = 3;
/** title_match_boost stamped on exact-title tier hits (evidence signal). */
export const EXACT_TITLE_STAMP = 1.25;

/** Slug-shaped: one whitespace-free token containing a path separator. */
export function isSlugShapedQuery(query: string): boolean {
  const q = query.trim();
  return q.length > 0 && !/\s/.test(q) && q.includes('/') && !q.startsWith('/') && !q.endsWith('/');
}

export interface ExactLookupOpts {
  sourceId?: string;
  sourceIds?: string[];
  /**
   * The page-grain title arm hybridSearch already fetched (searchTitles
   * output). The title probe filters THIS list to normalized full-title
   * equality — no second engine query. Callers without the arm omit it and
   * only the slug probe runs.
   */
  titleCandidates?: SearchResult[];
  /**
   * #4480 — shape-filter gating. The scored arms apply type/types/
   * exclude_slugs at SQL level; without the same gate here the tier could
   * top-inject a page the caller's filters explicitly excluded. Same
   * semantics as SearchOpts: `type` and `types` are AND-applied, both empty
   * = no type gate.
   */
  type?: string;
  types?: string[];
  excludeSlugs?: string[];
}

/** Max distinct sources probed for a slug-shaped query on a federated call. */
const MAX_SLUG_PROBE_SOURCES = 5;

/**
 * Probe the structural identity surfaces for a lookup-shaped query. Returns
 * supersession-filtered, deduped, capped hits (empty for non-lookup queries
 * and on any probe failure).
 */
export async function structuralExactLookup(
  engine: BrainEngine,
  query: string,
  opts: ExactLookupOpts = {},
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q || !isLookupShapedQuery(q)) return [];

  const hits: SearchResult[] = [];
  const seen = new Set<string>();
  // #4480 — mirror the scored arms' shape filters so the tier can never
  // inject a page the caller explicitly filtered out.
  const excluded = new Set(opts.excludeSlugs ?? []);
  const typeGate = (t: string | undefined | null): boolean => {
    if (opts.type && t !== opts.type) return false;
    if (opts.types && opts.types.length > 0 && (t == null || !opts.types.includes(t))) return false;
    return true;
  };
  const push = (r: SearchResult) => {
    if (excluded.has(r.slug)) return;
    if (!typeGate(r.type)) return;
    const key = `${r.source_id ?? 'default'}::${r.slug}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(r);
  };

  // Slug probe — only for slug-shaped queries (zero cost otherwise).
  if (isSlugShapedQuery(q)) {
    const scopes: Array<string | undefined> =
      opts.sourceIds && opts.sourceIds.length > 0
        ? [...opts.sourceIds].sort().slice(0, MAX_SLUG_PROBE_SOURCES)
        : opts.sourceId != null
          ? [opts.sourceId]
          : [undefined];
    for (const scope of scopes) {
      try {
        const page = scope != null
          ? await engine.getPage(q, { sourceId: scope })
          : await engine.getPage(q); // gbrain-allow-unscoped-getpage — read-only first-match; no paired write
        if (!page) continue;
        push({
          page_id: page.id,
          slug: page.slug,
          title: page.title,
          type: page.type,
          source_id: page.source_id ?? scope ?? 'default',
          chunk_text: (page.compiled_truth ?? '').slice(0, 200),
          chunk_index: 0,
          chunk_id: 0,
          score: 0, // caller assigns the injection score
          alias_hit: true, // identity match — evidence alias_hit → 'exists'
          exact_lookup: 'slug',
        } as SearchResult);
      } catch {
        // fail-open: slug probe error → no tier hit from this scope
      }
    }
  }

  // Title probe — normalized full-title equality over the existing title arm.
  const qNorm = normalizeAlias(q);
  if (qNorm && opts.titleCandidates && opts.titleCandidates.length > 0) {
    for (const cand of opts.titleCandidates) {
      if (!cand.title) continue;
      if (normalizeAlias(cand.title) !== qNorm) continue;
      push({
        ...cand,
        title_match_boost: Math.max(cand.title_match_boost ?? 1.0, EXACT_TITLE_STAMP),
        exact_lookup: cand.exact_lookup ?? 'title',
      });
    }
  }

  if (hits.length === 0) return [];

  // Supersession filter — a stale (superseded) page never wins the identity
  // slot. Reuses the shared downrank stage as the lookup (it stamps
  // `superseded`); tier scores are assigned by the caller afterwards, so the
  // stage's score mutation on dropped rows is irrelevant.
  try {
    await applySupersedeDownrank(hits, engine);
  } catch {
    // fail-open: filter unavailable (pre-links schema) → keep hits
  }
  return hits.filter((h) => h.superseded !== true).slice(0, MAX_EXACT_LOOKUP_INJECT);
}

/**
 * Promote/inject structural exact-lookup hits into a ranked result set.
 * Mirrors applyAliasHop's contract: hits already present are promoted to the
 * top (score = current-top + epsilon) and stamped; absent hits inject with
 * the same top-of-organic + epsilon score shape. Returns a NEW sorted array;
 * fail-open returns `results` unchanged.
 */
export async function applyExactLookupTier(
  engine: BrainEngine,
  results: SearchResult[],
  query: string,
  opts: ExactLookupOpts = {},
): Promise<SearchResult[]> {
  let hits: SearchResult[];
  try {
    hits = await structuralExactLookup(engine, query, opts);
  } catch {
    return results;
  }
  if (hits.length === 0) return results;

  const out = [...results];
  const topScore = out.reduce((m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m), 0);
  let injectScore = topScore > 0 ? topScore : 1.0;

  for (const hit of hits) {
    injectScore += 1e-6;
    const matchingIndexes: number[] = [];
    for (let i = 0; i < out.length; i++) {
      const r = out[i];
      if (r.slug === hit.slug && (r.source_id ?? 'default') === (hit.source_id ?? 'default')) {
        matchingIndexes.push(i);
      }
    }
    if (matchingIndexes.length > 0) {
      // Search is chunk-grained, but an exact identity lookup is page-grained.
      // Promote the strongest existing chunk (identity match outranks every
      // scored row) and remove the same page's remaining chunks — dedup allows
      // 2 chunks/page, so without the collapse the canonical page could appear
      // twice on the wire for an exact identity lookup.
      const idx = matchingIndexes.reduce((best, cand) =>
        out[cand].score > out[best].score ? cand : best,
      );
      const promoted = out[idx];
      promoted.score = injectScore;
      promoted.exact_lookup = hit.exact_lookup;
      if (hit.alias_hit) promoted.alias_hit = true;
      if (hit.title_match_boost) {
        promoted.title_match_boost = Math.max(promoted.title_match_boost ?? 1.0, hit.title_match_boost);
      }
      // Splice highest-index-first so earlier removals don't shift later ones.
      for (let k = matchingIndexes.length - 1; k >= 0; k--) {
        if (matchingIndexes[k] !== idx) out.splice(matchingIndexes[k], 1);
      }
      continue;
    }
    out.push({ ...hit, score: injectScore, base_score: injectScore });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
