/**
 * v0.31 Hot Memory — entity slug canonicalization.
 *
 * Per /plan-eng-review D4: at extract time, resolve a free-form entity name
 * (e.g. "Alice") against `pages.slug` so that hot memory + the existing graph
 * see the same canonical id. Falls back to a slugified form when no page
 * matches.
 *
 * Pure helper; the engine layer is the data dependency injected by callers.
 * Lives under `src/core/entities/` so signal-detector can reuse it for the
 * Sonnet pass too without circular import through facts/.
 *
 * Prefix-expansion step lives between fuzzy match and slugify fallback.
 * Bare first names like "Alice" score too low on pg_trgm (short strings
 * have terrible trigram overlap), so without this step they fall through
 * to slugify("Alice") → "alice", which spawns a phantom `people/alice.md`
 * stub at brain root instead of resolving to the existing
 * `people/alice-example` page. The fix queries `slug LIKE 'people/X-%'`
 * (then `companies/X-%`) when fuzzy fails on a single-word bare name, and
 * uses connection count (links + chunks) as the tiebreaker when multiple
 * candidates match.
 */

import type { BrainEngine } from '../engine.ts';

/**
 * Canonicalize a free-form entity reference to a page slug.
 *
 * Resolution order:
 *   1. If `raw` is already a page slug shape (contains a "/" or matches an
 *      exact pages.slug row in this source), return it untouched.
 *   2. Try fuzzy match against pages.slug + pages.title within the source
 *      (case-insensitive). Pick the highest-trgm-score match if any.
 *   3. Fall back to a deterministic slugify: lowercase-no-spaces with
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
  //    `people/<token>-%` then `companies/<token>-%`. Short bare names
  //    score terribly on pg_trgm — similarity('alice', 'alice-example')
  //    is below the 0.4 threshold — so this is the layer that catches
  //    `"Alice"` → `people/alice-example` before we phantom-stub a bare
  //    `people/alice.md`.
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

const PREFIX_EXPANSION_DIRS = ['people', 'companies'] as const;

/**
 * v0.35.5 — phantom-canonical resolver. Variant of `resolveEntitySlug` that
 * SKIPS the exact-slug step at the top: a phantom slug like `'alice'` would
 * always exact-match itself (the phantom page exists as that exact slug),
 * which made the original phantom-redirect handler a no-op (codex #1).
 *
 * Resolution order for phantoms:
 *   1. Fuzzy match against `pages.title` / `pages.slug` within the source
 *      — catches Liz → Elizabeth-Warren style fuzzy title hits when no
 *      prefix-expansion candidate exists (round-22 case).
 *   2. Prefix expansion: `people/<token>-*` then `companies/<token>-*`.
 *   3. Returns null if neither path finds a prefixed canonical.
 *
 * The output is filtered to require `result !== phantomSlug AND result.includes('/')`
 * so a fuzzy match that bounces back to the phantom itself (e.g. fuzzy on
 * its own bare title) doesn't trigger a self-redirect. Caller treats null
 * as `'no_canonical'`.
 */
export async function resolvePhantomCanonical(
  engine: BrainEngine,
  source_id: string,
  phantomSlug: string,
): Promise<string | null> {
  if (!phantomSlug) return null;
  const trimmed = phantomSlug.trim();
  if (!trimmed) return null;
  // The phantom slug is the input; we treat it as the search term too,
  // because phantom slugs ARE the lowercased bare name a fuzzy / prefix
  // lookup would naturally target.
  const fuzzy = await tryFuzzyMatch(engine, source_id, trimmed);
  if (fuzzy && fuzzy !== phantomSlug && fuzzy.includes('/')) return fuzzy;

  const expanded = await tryPrefixExpansion(engine, source_id, slugify(trimmed));
  if (expanded && expanded !== phantomSlug && expanded.includes('/')) return expanded;

  return null;
}

/**
 * v0.35.5 — standalone candidate query for ambiguity detection (codex #11).
 *
 * `tryPrefixExpansion` returns top-1-per-directory and short-circuits on
 * the first non-empty directory. That's correct for the resolver hot path
 * (we want the most likely match, not all of them) but wrong for the
 * phantom-redirect handler which needs to KNOW whether multiple canonicals
 * could absorb the phantom. This query returns every prefixed page across
 * every configured dir whose slug matches `<dir>/<token>` OR `<dir>/<token>-*`,
 * so the caller can count candidates and refuse to redirect when ambiguous.
 *
 * Returns rows ordered by `connection_count DESC, slug ASC` (deterministic
 * tiebreaker for test pinning). Cap of 10 — beyond that we treat the input
 * as too generic anyway and the caller skips with audit.
 */
export async function findPrefixCandidates(
  engine: BrainEngine,
  source_id: string,
  token: string,
): Promise<Array<{ slug: string; connection_count: number }>> {
  if (!token) return [];
  // Build LIKE pattern set for each configured directory:
  //   people/<token>      (bare child — covers `people/alice` exactly)
  //   people/<token>-%    (suffixed child — covers `people/alice-example`)
  //   ... same for companies/
  // We deliberately do NOT use `people/<token>%` (no hyphen) because that
  // also matches `people/aliceberg` for token="alice" — a false positive.
  const patterns: string[] = [];
  for (const dir of PREFIX_EXPANSION_DIRS) {
    patterns.push(`${dir}/${token}`);
    patterns.push(`${dir}/${token}-%`);
  }
  try {
    const rows = await engine.executeRaw<{
      slug: string;
      connection_count: number;
    }>(
      `SELECT p.slug,
              ((SELECT COUNT(*)::int FROM links WHERE to_page_id = p.id)
               + (SELECT COUNT(*)::int FROM links WHERE from_page_id = p.id)
               + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
                AS connection_count
       FROM pages p
       WHERE p.source_id = $1
         AND p.deleted_at IS NULL
         AND p.slug LIKE ANY($2::text[])
       ORDER BY connection_count DESC, p.slug ASC
       LIMIT 10`,
      [source_id, patterns],
    );
    return rows;
  } catch {
    // Defensive: any SQL hiccup returns "no candidates" so the caller's
    // ambiguity gate doesn't crash the cycle. The downstream
    // `resolvePhantomCanonical` runs the per-dir tryPrefixExpansion path
    // separately and will surface its own errors.
    return [];
  }
}

/**
 * Look up pages whose slug starts with `<dir>/<token>-` for each known
 * entity directory. When multiple candidates match within a directory,
 * pick the one with the highest connection count (links_in + links_out +
 * chunk count) — the most-mentioned entity is the most likely canonical
 * target for a bare-name reference. When no candidates match in any
 * directory, returns null and the caller falls through to slugify.
 */
async function tryPrefixExpansion(
  engine: BrainEngine,
  source_id: string,
  token: string,
): Promise<string | null> {
  for (const dir of PREFIX_EXPANSION_DIRS) {
    const pattern = `${dir}/${token}-%`;
    try {
      const rows = await engine.executeRaw<{
        slug: string;
        connection_count: number;
      }>(
        // Connection count is a simple proxy for canonicality:
        // (incoming links) + (outgoing links) + (content chunks).
        //
        // SQL shape: correlated subqueries scoped to the slug-LIKE
        // candidates. The pre-v0.34.5 version used derived-table JOINs
        // (SELECT FROM links GROUP BY to_page_id, etc.) which forced the
        // planner to aggregate the FULL links + content_chunks tables on
        // every prefix-expansion call — O(N) per call where N is total
        // links/chunks in the brain. On a 100K-link / 50K-chunk brain
        // that's slow.
        //
        // The slug LIKE filter is already selective in practice (typical
        // brain has 0-5 pages per prefix), so the correlated subqueries
        // run N=3 times per matched row, hitting the indexes on
        // links.to_page_id, links.from_page_id, and content_chunks.page_id
        // directly. Even on a pathological prefix matching 1000+ pages,
        // work is bounded per-candidate, not whole-table.
        `SELECT p.slug,
                ((SELECT COUNT(*)::int FROM links WHERE to_page_id = p.id)
                 + (SELECT COUNT(*)::int FROM links WHERE from_page_id = p.id)
                 + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
                  AS connection_count
         FROM pages p
         WHERE p.source_id = $1
           AND p.deleted_at IS NULL
           AND p.slug LIKE $2
         ORDER BY connection_count DESC, p.slug ASC
         LIMIT 5`,
        [source_id, pattern],
      );
      if (rows.length === 0) continue;
      // Single unambiguous match: return it.
      if (rows.length === 1) return rows[0].slug;
      // Multiple matches: the top row (sorted by connection_count desc)
      // wins. The slug-ASC secondary key makes ties deterministic when
      // connection counts collide — important for test pinning.
      return rows[0].slug;
    } catch {
      // Defensive: a missing table or index shouldn't crash extraction.
      // Try the next directory (or fall through to slugify).
      continue;
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
  } catch {
    // Defensive: fail open. Caller still gets a slug from the fallback.
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
  } catch {
    // pg_trgm functions might not be available on every engine config;
    // fall through to slugify.
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
