/**
 * v0.31 Hot Memory — entity slug canonicalization.
 *
 * Per /plan-eng-review D4: at extract time, resolve a free-form entity name
 * (e.g. "Sam") against `pages.slug` so that hot memory + the existing graph
 * see the same canonical id. Falls back to a slugified form when no page
 * matches.
 *
 * Pure helper; the engine layer is the data dependency injected by callers.
 * Lives under `src/core/entities/` so signal-detector can reuse it for the
 * Sonnet pass too without circular import through facts/.
 *
 * v0.34.5 — added a prefix-expansion step between fuzzy match and
 * slugify fallback. Bare first names like "Alice" scored too low on
 * pg_trgm (short strings have terrible trigram overlap), so they fell
 * through to slugify("Alice") → "alice", which then spawned a phantom
 * `people/alice.md` stub instead of resolving to an existing
 * `people/alice-example` page. The fix queries `slug LIKE 'people/X-%'`
 * (then `companies/X-%`, etc., per the configured dir list) when fuzzy
 * fails on a single-word bare name, and uses connection count
 * (links + chunks) as the tiebreaker when multiple candidates match.
 *
 * The dir list is config-driven via `entities.prefix_expansion_dirs`
 * (see `src/core/config.ts`). Default covers the four directories the
 * stub-guard recognizes; custom brains override to support funds/,
 * advisors/, etc. See plan `mossy-popping-crown.md` D2.
 */

import type { BrainEngine } from '../engine.ts';
import { isUndefinedColumnError } from '../utils.ts';
import { loadConfig } from '../config.ts';

/**
 * Canonicalize a free-form entity reference to a page slug.
 *
 * Resolution order:
 *   1. If `raw` is already a page slug shape (contains a "/" or matches an
 *      exact pages.slug row in this source), return it untouched.
 *   2. Try fuzzy match against pages.slug + pages.title within the source
 *      (case-insensitive). Pick the highest-trgm-score match if any.
 *   3. Prefix-expansion match for bare single-token names: walk each
 *      configured entity directory (`entities.prefix_expansion_dirs`) and
 *      query `<dir>/<token>-%`. Highest-connection wins.
 *   4. Fall back to a deterministic slugify: lowercase-no-spaces with
 *      hyphen-collapse. NOT prefixed with a directory — caller decides
 *      whether to prefix `people/`, `companies/`, etc.
 *
 * Returns null when raw is empty or whitespace-only. Non-empty input always
 * produces a non-null slug — the fallback path is the floor.
 */
export async function resolveEntitySlug(
  engine: BrainEngine,
  source_id: string,
  raw: string,
): Promise<string | null> {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Exact match on slug. If raw already looks like a slug (or matches
  //    a row exactly), use it.
  if (looksLikeSlug(trimmed)) {
    const exact = await tryExactSlug(engine, source_id, trimmed);
    if (exact) return exact;
  }

  // 2. Fuzzy match against existing pages within the source. Match either
  //    on slug fragment or on title.
  const fuzzy = await tryFuzzyMatch(engine, source_id, trimmed);
  if (fuzzy) return fuzzy;

  // 3. Prefix-expansion match: when the input looks like a bare first name
  //    (no slash, no prefix, slugifies to a single short token), try
  //    `<dir>/<token>-%` for each configured directory in order. Short
  //    bare names score terribly on pg_trgm — similarity('alice',
  //    'alice-example') is below the 0.4 threshold — so this is the
  //    layer that catches `"Alice"` → `people/alice-example` before we
  //    phantom-stub a bare `people/alice.md`.
  if (isBareName(trimmed)) {
    const expanded = await tryPrefixExpansion(engine, source_id, slugify(trimmed));
    if (expanded) return expanded;
  }

  // 4. Fallback: deterministic slugify.
  return slugify(trimmed);
}

/**
 * "Bare name" detector — true when the input is a single word with no
 * slash, no embedded prefix marker, and slugifies to a non-empty token.
 * Multi-word inputs (e.g. "Alice Example") are handled by fuzzy match;
 * this gate only fires for short first-name-shaped tokens.
 */
function isBareName(raw: string): boolean {
  if (raw.includes('/')) return false;
  // One-token input. Whitespace-tokenize: "Alice" → 1, "Alice Example" → 2.
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return false;
  const slug = slugify(raw);
  if (!slug) return false;
  // Reject hyphenated multi-token slugs like "alice-example" — those
  // should hit the exact-slug or fuzzy path, not prefix expansion.
  if (slug.includes('-')) return false;
  return true;
}

/**
 * Default prefix-expansion directories. Covers the four entity types
 * the stub-guard recognizes in `src/core/facts/fence-write.ts` plus
 * `concepts/` which is the canonical home for `type: concept` pages
 * across gbrain docs and example schemas (e.g. `concepts/rag`,
 * `concepts/agentic-workflows`). Bare-name references like "RAG" or
 * "Bitcoin" therefore resolve out of the box. Override per-brain via
 * the `entities.prefix_expansion_dirs` config key.
 */
export const DEFAULT_PREFIX_EXPANSION_DIRS = ['people', 'companies', 'deals', 'topics', 'concepts'] as const;

/**
 * Resolve the active prefix-expansion dir list. Config-first, default-fallback.
 * Exported for tests and for callers that want to inspect the configured set.
 */
export function getPrefixExpansionDirs(): readonly string[] {
  const cfg = loadConfig();
  const fromConfig = cfg?.entities?.prefix_expansion_dirs;
  if (Array.isArray(fromConfig) && fromConfig.length > 0) {
    // Filter to non-empty strings; anything else silently drops so a bad
    // config entry can't 500 the resolver. Matches the v0.31.12
    // model-tier resolver's "fall back to defaults on bad input" posture.
    const cleaned = fromConfig.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (cleaned.length > 0) return cleaned;
  }
  return DEFAULT_PREFIX_EXPANSION_DIRS;
}

/**
 * Look up pages whose slug is `<dir>/<token>` OR starts with
 * `<dir>/<token>-` for each configured entity directory. When multiple
 * candidates match within a directory, pick the one with the highest
 * connection count (links_in + links_out + chunk count) — the most-
 * mentioned entity is the most likely canonical target for a bare-name
 * reference. When no candidates match in any directory, returns null
 * and the caller falls through to slugify.
 *
 * Also exported so `gbrain merge-phantoms` can run the prefix step in
 * isolation: resolveEntitySlug's exact-slug short-circuit would match
 * a phantom against itself before reaching prefix expansion. `token`
 * should be a pre-slugified single word (e.g. `'alice'`, not `'Alice'`).
 *
 * The connection-count subqueries are correlated (per page row) rather
 * than full table aggregates so the cost scales with the number of
 * slug-matching candidates (typically 1-3), not with brain size.
 * Indexes used: `idx_links_to`, `idx_links_from`, `idx_chunks_page`.
 */
export async function tryPrefixExpansion(
  engine: BrainEngine,
  source_id: string,
  token: string,
): Promise<string | null> {
  for (const dir of getPrefixExpansionDirs()) {
    // Match BOTH `<dir>/<token>` exactly AND `<dir>/<token>-%` (hyphenated
    // variants). Without the exact-match leg, a brain whose canonical slug
    // is `companies/acme` (no hyphen-suffix) would never resolve bare
    // "Acme" — codex caught this in the third /codex review pass. The
    // ORDER BY tiebreak still applies across both candidate shapes.
    const exact = `${dir}/${token}`;
    const hyphen = `${dir}/${token}-%`;
    try {
      const rows = await engine.executeRaw<{
        slug: string;
        connection_count: number;
      }>(
        // Correlated subqueries: each per p.id, hitting the existing
        // (to_page_id), (from_page_id), (page_id) indexes. The outer
        // WHERE clause uses `slug = $2 OR slug LIKE $3` so both the
        // exact and the prefix candidates feed the same tiebreak.
        `SELECT p.slug,
                ((SELECT COUNT(*) FROM links WHERE to_page_id = p.id) +
                 (SELECT COUNT(*) FROM links WHERE from_page_id = p.id) +
                 (SELECT COUNT(*) FROM content_chunks WHERE page_id = p.id))
                  AS connection_count
         FROM pages p
         WHERE p.source_id = $1
           AND p.deleted_at IS NULL
           AND (p.slug = $2 OR p.slug LIKE $3)
         ORDER BY connection_count DESC, p.slug ASC
         LIMIT 1`,
        [source_id, exact, hyphen],
      );
      if (rows.length === 0) continue;
      return rows[0].slug;
    } catch (err) {
      // Narrow probe: column-missing on legacy brains (most likely
      // `deleted_at` pre-v0.26.5) falls through to the next directory.
      // Genuine failures (pool exhaustion, lock timeout, network blip)
      // propagate so they're visible instead of silently masquerading
      // as "no prefix match." See v0.26.9 D14 in CLAUDE.md.
      if (isUndefinedColumnError(err, 'deleted_at')) continue;
      throw err;
    }
  }
  return null;
}

function looksLikeSlug(s: string): boolean {
  // Slug shape: lowercase letters/digits with at least one slash OR matches
  // [a-z0-9-]+ exactly. Anything with whitespace or capital letters fails.
  if (/\s/.test(s)) return false;
  if (s !== s.toLowerCase()) return false;
  return /^[a-z0-9/_-]+$/.test(s);
}

async function tryExactSlug(
  engine: BrainEngine,
  source_id: string,
  candidate: string,
): Promise<string | null> {
  try {
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
      [source_id, candidate],
    );
    if (rows.length > 0) return rows[0].slug;
  } catch (err) {
    // Legacy brain without `deleted_at` column — fall through to slugify
    // fallback. Other failures propagate.
    if (isUndefinedColumnError(err, 'deleted_at')) return null;
    throw err;
  }
  return null;
}

async function tryFuzzyMatch(
  engine: BrainEngine,
  source_id: string,
  raw: string,
): Promise<string | null> {
  const lc = raw.toLowerCase();
  const fragment = slugify(raw);
  // Prefer titles (display names) over slug fragments since user input
  // tends to be display-name-shaped ("Alice Example" vs "alice-example"). Cap at
  // 3 candidates; pick the first deterministic one.
  try {
    const rows = await engine.executeRaw<{ slug: string; title: string; score: number }>(
      `SELECT slug, title,
         GREATEST(
           similarity(lower(title), $2),
           similarity(slug, $3)
         ) AS score
       FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND (
           lower(title) % $2
           OR slug ILIKE '%' || $3 || '%'
         )
       ORDER BY score DESC, slug ASC
       LIMIT 3`,
      [source_id, lc, fragment],
    );
    if (rows.length > 0 && rows[0].score >= 0.4) return rows[0].slug;
  } catch (err) {
    // pg_trgm functions (`similarity`, `%`) might not be available on
    // every engine config; same for `deleted_at` on legacy brains.
    // Either fall through to the prefix-expansion + slugify path.
    if (isUndefinedColumnError(err, 'deleted_at')) return null;
    const msg = err instanceof Error ? err.message : String(err);
    if (/similarity|operator does not exist|function similarity/i.test(msg)) return null;
    throw err;
  }
  return null;
}

/**
 * Deterministic slugify: lowercase, replace non-alphanumerics with hyphens,
 * collapse repeated hyphens, trim leading/trailing hyphens.
 *
 * Exported for tests + callers who want the same fallback shape independently.
 */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    // NFKD decomposes accents into combining marks (U+0300..U+036F);
    // strip them before replacing the rest with hyphens so "è" → "e",
    // not "e" + "-".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
