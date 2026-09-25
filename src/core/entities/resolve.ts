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
 * Bare-name prefix expansion lives before fuzzy match and slugify fallback.
 * Bare first names like "Alice" score too low on pg_trgm (short strings
 * have terrible trigram overlap), so without this step they fall through
 * to slugify("Alice") → "alice", which spawns a phantom `people/alice.md`
 * stub at brain root instead of resolving to the existing
 * `people/alice-example` page. The fix queries `slug LIKE 'people/X-%'`
 * (then `companies/X-%`) when fuzzy fails on a single-word bare name, and
 * resolves only a single candidate; collisions fall through to the guarded
 * unprefixed holding path rather than guessing from connection count.
 */

import type { BrainEngine } from '../engine.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { SLUG_NON_WORD_RUN_RE, SLUG_WORD_CHARS, foldSlugText } from '../cjk.ts';
import { foldNonDecomposingLatin } from '../latin-fold.ts';
import { isUndefinedTableError } from '../utils.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';

/**
 * Canonicalize a free-form entity reference to a page slug.
 *
 * Resolution order:
 *   1. If `raw` is already a page slug shape (contains a "/" or matches an
 *      exact pages.slug row in this source), return it untouched. A mention
 *      that is exactly one live page's own name (slug basename) resolves to
 *      it next, before any other page's alias.
 *   2. Resolve a bare name only when prefix expansion finds one candidate,
 *      or one candidate whose title is exactly that name.
 *   3. For multi-token input, take a fuzzy candidate within the source only
 *      when it carries the same name tokens (sameEntityName).
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

  // 1.25. Exact own name: a live page whose slug basename IS the mention wins
  //       over another page's alias — "Jordan Lee-Example" is
  //       people/jordan-lee-example even when a different person lists it as
  //       a former name.
  const basenames = await findExactBasenameCandidates(engine, source_id, trimmed);
  if (basenames.length === 1) return basenames[0].slug;

  // 1.5. Alias-exact (v0.46.15 identity wave, #3730): an unambiguous
  //      page_aliases hit resolves BEFORE prefix expansion / fuzzy — the
  //      alias table is curated ground truth ("saoirse" → people/saoirse-x)
  //      while fuzzy is a guess. Live-page verified (page_aliases has no FK).
  const aliased = await tryAliasExact(engine, source_id, trimmed);
  if (aliased) return aliased;

  if (basenames.length > 1) return fallbackSlugify(trimmed);

  // 2. Prefix-expansion match: when the input looks like a bare first name
  //    (no slash, no prefix, slugifies to a single short token), try
  //    `people/<token>-%` then `companies/<token>-%`. Short bare names
  //    score terribly on pg_trgm — similarity('alice', 'alice-example')
  //    is below the fuzzy threshold — so this is the layer that catches
  //    `"Alice"` → `people/alice-example` before we phantom-stub a bare
  //    `people/alice.md`.
  if (isBareName(trimmed)) {
    const expanded = await tryUnambiguousPrefixExpansion(engine, source_id, trimmed);
    if (expanded) return expanded;
  } else {
    // 3. Fuzzy match against existing pages within the source. Bare names
    //    deliberately skip this arm: a shared first name is not specific
    //    enough to choose one person by trigram score or popularity.
    const fuzzy = await tryFuzzyMatch(engine, source_id, trimmed);
    if (fuzzy) return fuzzy;
  }

  // 4. Fallback: deterministic slugify.
  return fallbackSlugify(trimmed);
}

/**
 * #3447 — shared fallback for both resolvers. slugify()'s `[^a-z0-9]+ → '-'`
 * rule rewrites the path separator, so running slug-shaped input through it
 * corrupts a well-formed slug (`people/alice-example` → `people-alice-example`)
 * into one no page can ever have — and the flattened slug never resolves, so
 * every re-extraction re-mints it. Path-shaped input is slugified PER SEGMENT
 * (identity for already-well-formed slugs); display names keep plain slugify.
 */
function fallbackSlugify(trimmed: string): string {
  if (trimmed.includes('/')) {
    return trimmed.split('/').map(slugify).filter(Boolean).join('/');
  }
  return slugify(trimmed);
}

const IDENTITY_TYPES = new Set(['person', 'company', 'fund', 'organization']);
const IDENTITY_DIRS = ['people/', 'companies/', 'funds/', 'orgs/', 'organizations/'];
const NAME_NOISE_TOKENS = new Set(['the', 'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'plc', 'gmbh']);

/** True for pages that name one real-world person, company, fund or organization. */
export function isIdentityEntity(slug: string, type?: string | null): boolean {
  return (type != null && IDENTITY_TYPES.has(type)) || IDENTITY_DIRS.some(dir => slug.startsWith(dir));
}

const FACT_ENTITY_TYPES = new Set(['concept', 'project', 'deal']);
const FACT_ENTITY_DIRS = ['hosts/', 'projects/', 'concepts/', 'deals/'];

/** Pages a fuzzy fact attribution may land on: entities, never meetings, notes or other documents. */
export function isFactEntityPage(slug: string, type: string | null): boolean {
  return isIdentityEntity(slug, type) || (type != null && FACT_ENTITY_TYPES.has(type))
    || FACT_ENTITY_DIRS.some(dir => slug.startsWith(dir));
}

function nameTokens(value: string): string {
  const folded = foldNonDecomposingLatin(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const tokens = folded.split(/[^\p{L}\p{N}]+/u).filter(token => token && !NAME_NOISE_TOKENS.has(token));
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * A fuzzy candidate names the same entity as a reference only when both carry
 * the same name tokens, ignoring case, punctuation, order, accents and
 * corporate suffixes. "Example, Alice" matches "Alice Example"; "Alicia
 * Example" and "Alice Examples" do not, so a near-name never resolves to a
 * different entity.
 */
export function sameEntityName(reference: string, candidateTitle: string | null | undefined, candidateSlug: string): boolean {
  const wanted = nameTokens(reference);
  return wanted !== '' && (wanted === nameTokens(candidateTitle ?? '') || wanted === nameTokens(candidateSlug.split('/').pop() ?? ''));
}

let aliasExactWarned = false;

/**
 * Alias-exact arm (v0.46.15, #3730): normalize `raw` and return the ONE live
 * page claiming that normalized name, or null — ambiguous, absent, or the
 * alias table is missing; every failure falls through rather than throwing.
 *
 * Hits are verified against LIVE pages: page_aliases has no FK to pages, so
 * alias rows for deleted/renamed pages linger (outside-voice R2-8). Liveness
 * is filtered BEFORE uniqueness (codex ship-review) — a stale sibling row must
 * not veto the sole live target, since that fall-through lands on
 * fuzzy/slugify and could recreate a phantom slug on a WRITE path.
 * Fail-open on undefined-table (pre-v110 brains have no page_aliases table);
 * other errors warn once per process so degradation isn't silent.
 *
 * Exported for enrichment-service, which consults it before minting an entity
 * page (ADR-0001: two spellings slug apart, the alias layer merges them). The
 * index is type-blind — any page may claim any name — so a caller that only
 * accepts one namespace filters the result itself.
 */
export async function tryAliasExact(engine: BrainEngine, source_id: string, raw: string): Promise<string | null> {
  const norm = normalizeAlias(raw);
  if (!norm) return null;
  try {
    const hits = (await engine.resolveAliases([norm], { sourceId: source_id })).get(norm) ?? [];
    if (!hits.length) return null;
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])`,
      [source_id, [...new Set(hits.map((h) => h.slug))]],
    );
    const live = [...new Set(rows.map((r) => r.slug))];
    return live.length === 1 ? live[0] : null;
  } catch (err) {
    if (!isUndefinedTableError(err) && !aliasExactWarned) {
      aliasExactWarned = true;
      console.error(`[gbrain] alias-exact resolution degraded (falling through to fuzzy): ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
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

// hosts/projects joined people/companies after the 2026-08-06 memory eval: a
// bare infra token ("hive") fell through to slugify and recall returned
// nothing while the canonical hosts/<token> page + its facts sat one prefix
// away. `infra/` is deliberately NOT here — it is a mixed namespace of
// analysis/runbook documents (`infra/hive-dependency-audit-…`), and any such
// doc would trip the ambiguity gate and re-break bare-token resolution.
const PREFIX_EXPANSION_DIRS = ['people', 'companies', 'hosts', 'projects'] as const;

async function findExactBasenameCandidates(
  engine: BrainEngine,
  source_id: string,
  raw: string,
): Promise<Array<{ slug: string }>> {
  const token = slugify(raw);
  if (raw.includes('/') || !token.includes('-')) return [];
  try {
    return await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`,
      [source_id, [...PREFIX_EXPANSION_DIRS, 'concepts'].map(dir => `${dir}/${token}`)],
    );
  } catch {
    return [];
  }
}

/**
 * v0.40.2.0 — resolution-source-tagged variant for trajectory routing.
 *
 * Same resolution chain as `resolveEntitySlug` but returns the source
 * (`exact_page` | `alias_exact` | `prefix_expansion` | `fuzzy_match` |
 * `fallback_slugify`) alongside the slug so trajectory callers can gate on
 * `resolution_source !== 'fallback_slugify'` — querying findTrajectory on an
 * invented slug always returns [] and wastes a SQL round-trip.
 *
 * `prefix_expansion` is the bare single-token branch: it picks the sole
 * `<dir>/<token>-*` page because it is the only candidate, not because
 * anything confirms the mention is the same person or company (a bare
 * "Victor" in an unrelated transcript landed on the brain's one
 * `people/victor-*` page). It still verifies a live page, so
 * `!== 'fallback_slugify'` gates are unaffected; `facts/backstop.ts` flags
 * facts written through it as unverified.
 *
 * The original `resolveEntitySlug` keeps its existing contract (returns
 * just the slug) for all pre-v0.40 call sites — no caller-side churn.
 */
export type ResolutionSource = 'exact_page' | 'alias_exact' | 'prefix_expansion' | 'fuzzy_match' | 'fallback_slugify';

export interface ResolveResult {
  slug: string;
  source: ResolutionSource;
}

export async function resolveEntitySlugWithSource(
  engine: BrainEngine,
  source_id: string,
  raw: string,
): Promise<ResolveResult | null> {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Mirror resolveEntitySlug's resolution chain but tag each branch.
  if (looksLikeSlug(trimmed)) {
    const exact = await tryExactSlug(engine, source_id, trimmed);
    if (exact) return { slug: exact, source: 'exact_page' };
  }

  const basenames = await findExactBasenameCandidates(engine, source_id, trimmed);
  if (basenames.length === 1) return { slug: basenames[0].slug, source: 'fuzzy_match' };

  const aliased = await tryAliasExact(engine, source_id, trimmed);
  if (aliased) return { slug: aliased, source: 'alias_exact' };

  if (basenames.length > 1) return { slug: fallbackSlugify(trimmed), source: 'fallback_slugify' };

  if (isBareName(trimmed)) {
    const expanded = await tryUnambiguousPrefixExpansion(engine, source_id, trimmed);
    if (expanded) return { slug: expanded, source: 'prefix_expansion' };
  } else {
    const fuzzy = await tryFuzzyMatch(engine, source_id, trimmed);
    if (fuzzy) return { slug: fuzzy, source: 'fuzzy_match' };
  }

  return { slug: fallbackSlugify(trimmed), source: 'fallback_slugify' };
}

/**
 * How a strict reference resolution found its page. `basename` is the
 * unique-slug-basename arm and `same_name` the trigram arm restricted to
 * pages carrying the same name tokens (both are `fuzzy_match` in
 * resolveEntitySlugWithSource).
 */
export type StrictResolutionArm = 'exact_page' | 'alias_exact' | 'basename' | 'same_name';

/**
 * A strict resolution miss: `ambiguous` (two live pages qualify),
 * `unverified` (only a bare-name prefix guess exists), `not_entity` (the
 * reference names a live page that is not a fact entity, e.g. a meeting) or
 * `no_page`.
 */
export type StrictResolution =
  | { slug: string; arm: StrictResolutionArm }
  | { slug: null; miss: 'ambiguous' | 'unverified' | 'not_entity' | 'no_page' };

/**
 * Resolve a name to a live fact-entity page using only identity evidence:
 * exact slug, unique slug basename, unique alias and, with `sameName`, the
 * same-name trigram arm. Never guesses from a bare-name prefix and never
 * falls back to a slugified name. With `excludePrivate`, private pages are
 * removed before uniqueness is counted, so an unreadable namesake can neither
 * be returned nor change the outcome for a remote caller.
 */
export async function resolveStrictEntityReference(
  engine: BrainEngine,
  source_id: string,
  raw: string,
  opts: { sameName?: boolean; excludePrivate?: boolean } = {},
): Promise<StrictResolution> {
  const trimmed = raw.trim();
  if (!trimmed) return { slug: null, miss: 'no_page' };
  const privacy = opts.excludePrivate ? `AND ${privatePagesFilterFragment('p')}` : '';
  const live = async (slugs: string[]) => slugs.length === 0 ? [] : engine.executeRaw<{ slug: string; type: string | null }>(
    `SELECT p.slug, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug = ANY($2::text[]) ${privacy}`,
    [source_id, [...new Set(slugs)]],
  );
  const pick = (rows: Array<{ slug: string; type: string | null }>, arm: StrictResolutionArm): StrictResolution | null => {
    if (rows.length > 1) return { slug: null, miss: 'ambiguous' };
    if (rows.length === 0) return null;
    return isFactEntityPage(rows[0].slug, rows[0].type) ? { slug: rows[0].slug, arm } : { slug: null, miss: 'not_entity' };
  };

  if (looksLikeSlug(trimmed)) {
    const exact = pick(await live([trimmed]), 'exact_page');
    if (exact) return exact;
  }
  const token = slugify(trimmed);
  if (!trimmed.includes('/') && token.includes('-')) {
    const basename = pick(await live([...PREFIX_EXPANSION_DIRS, 'concepts'].map(dir => `${dir}/${token}`)), 'basename');
    if (basename) return basename;
  }
  const norm = normalizeAlias(trimmed);
  if (norm) {
    try {
      const hits = (await engine.resolveAliases([norm], { sourceId: source_id })).get(norm) ?? [];
      const aliased = pick(await live(hits.map(h => h.slug)), 'alias_exact');
      if (aliased) return aliased;
    } catch (err) {
      if (!isUndefinedTableError(err)) throw err;
    }
  }
  if (opts.sameName && !isBareName(trimmed)) {
    try {
      const rows = await engine.executeRaw<{ slug: string; title: string; type: string | null }>(
        `SELECT p.slug, p.title, p.type FROM pages p
          WHERE p.source_id = $1 AND p.deleted_at IS NULL ${privacy}
            AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
          ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug ASC
          LIMIT 5`,
        [source_id, trimmed.toLowerCase(), token],
      );
      const named = pick(rows.filter(row => isFactEntityPage(row.slug, row.type) && sameEntityName(trimmed, row.title, row.slug)), 'same_name');
      if (named) return named;
    } catch (err) {
      if (!isMissingTrigramError(err)) throw err;
    }
  }
  if (isBareName(trimmed) && token) {
    const prefixed = (await findPrefixCandidates(engine, source_id, token)).map(c => c.slug);
    // Readable scope applies here too, so a private namesake never changes a remote outcome.
    if ((opts.excludePrivate ? await live(prefixed) : prefixed).length > 0) return { slug: null, miss: 'unverified' };
  }
  return { slug: null, miss: 'no_page' };
}

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
  opts: { type?: string | null } = {},
): Promise<string | null> {
  if (!phantomSlug) return null;
  const trimmed = phantomSlug.trim();
  if (!trimmed) return null;
  // Type guard: a phantom that declares an entity type only merges into a page
  // of that type's directory (a company phantom never lands on people/…).
  const allowedDirs = opts.type ? PHANTOM_TYPE_DIRS[opts.type] : undefined;
  const typeOk = (slug: string) => !allowedDirs || allowedDirs.some(dir => slug.startsWith(`${dir}/`));
  // The phantom slug is the input; we treat it as the search term too,
  // because phantom slugs ARE the lowercased bare name a fuzzy / prefix
  // lookup would naturally target. Short or repetitive names carry too little
  // signal for a trigram match, so they skip the fuzzy tier.
  if (hasNameSignal(trimmed.replace(/-/g, ' '))) {
    const fuzzy = await tryFuzzyMatch(engine, source_id, trimmed, false);
    if (fuzzy && fuzzy !== phantomSlug && fuzzy.includes('/') && typeOk(fuzzy)) return fuzzy;
  }

  const expanded = await tryPrefixExpansion(engine, source_id, slugify(trimmed));
  if (expanded && expanded !== phantomSlug && expanded.includes('/') && typeOk(expanded)) return expanded;

  return null;
}

/** Entity types whose phantoms may only merge into their own directories. */
const PHANTOM_TYPE_DIRS: Readonly<Record<string, readonly string[]>> = {
  person: ['people'],
  company: ['companies'],
  project: ['projects'],
  host: ['hosts'],
};

/**
 * Name-specificity gate for fuzzy phantom merges: at least 6 characters or two
 * tokens, and Shannon character entropy of at least 1.5 bits. Short or
 * repetitive names ("ai", "aaaa") defer to the stricter prefix tier.
 */
export function hasNameSignal(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized.length < 6 && normalized.split(' ').length < 2) return false;
  const chars = normalized.replace(/ /g, '');
  if (!chars) return false;
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) { const p = n / chars.length; entropy -= p * Math.log2(p); }
  return entropy >= 1.5;
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
 * The sole prefix candidate, or, when every candidate sits in one entity
 * directory, the one page whose title is exactly the bare name: "Acme" is
 * `companies/acme-0` titled "Acme", not `companies/acme-labs-50` titled
 * "Acme Labs" (gbrain-evals N9-5). A collision across directories (a person
 * and a host) or two exact titles stays ambiguous.
 */
async function tryUnambiguousPrefixExpansion(
  engine: BrainEngine,
  source_id: string,
  raw: string,
): Promise<string | null> {
  const token = slugify(raw);
  const candidates = await findPrefixCandidates(engine, source_id, token);
  if (candidates.length === 1) return candidates[0].slug;
  if (candidates.length === 0) return null;
  const patterns = PREFIX_EXPANSION_DIRS.flatMap(dir => [`${dir}/${token}`, `${dir}/${token}-%`]);
  try {
    const dirs = await engine.executeRaw<{ dir: string }>(
      `SELECT DISTINCT split_part(slug, '/', 1) AS dir FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE ANY($2::text[])
        LIMIT 2`,
      [source_id, patterns],
    );
    if (dirs.length !== 1) return null;
    const rows = await engine.executeRaw<{ slug: string; title: string | null }>(
      `SELECT slug, title FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL
          AND slug LIKE ANY($2::text[]) AND lower(title) = lower($3)
        LIMIT 3`,
      [source_id, patterns, raw.trim()],
    );
    const exact = rows.filter(r => sameEntityName(raw, r.title, r.slug));
    return exact.length === 1 ? exact[0].slug : null;
  } catch {
    return null;
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
      // connection counts collide — important for test pinning. The
      // phantom pass's findPrefixCandidates gate refuses any multi-candidate
      // redirect, so this top row is never taken on its own.
      return rows[0].slug;
    } catch {
      // Defensive: a missing table or index shouldn't crash extraction.
      // Try the next directory (or fall through to slugify).
      continue;
    }
  }
  return null;
}

// Slug shape: the word chars slugify keeps (SLUG_WORD_CHARS — every script,
// ADR-0001) plus `/`, `_`, `-`. Built from the shared grammar so a slug
// slugify produces always takes the exact-page branch.
const SLUG_SHAPE_RE = new RegExp(`^[${SLUG_WORD_CHARS}/_-]+$`, 'u');

export function looksLikeSlug(s: string): boolean {
  // Anything with whitespace or capital letters is a display name, not a slug.
  if (/\s/.test(s)) return false;
  if (s !== s.toLowerCase()) return false;
  return SLUG_SHAPE_RE.test(s);
}

async function tryExactSlug(
  engine: BrainEngine,
  source_id: string,
  candidate: string,
): Promise<string | null> {
  // A database error propagates: degrading to the fallback slug would
  // silently attribute the caller's facts to a different entity.
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
    [source_id, candidate],
  );
  return rows[0]?.slug ?? null;
}

async function tryFuzzyMatch(
  engine: BrainEngine,
  source_id: string,
  raw: string,
  sameNameOnly = true,
): Promise<string | null> {
  const lc = raw.toLowerCase();
  const fragment = slugify(raw);
  // Prefer titles (display names) over slug fragments since user input
  // tends to be display-name-shaped ("Alice Example" vs "alice-example"). Cap at
  // 3 candidates; pick the first deterministic one.
  try {
    const rows = await engine.executeRaw<{ slug: string; title: string; type: string | null; score: number }>(
      `SELECT slug, title, type,
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
       LIMIT 5`,
      [source_id, lc, fragment],
    );
    // A trigram score alone attributes facts about "Alicia Example" to Alice,
    // and facts about a person with no page to a meeting page that carries
    // their name. Entity resolution takes a candidate only when it names the
    // same entity; anything else falls back to the reference's own slug.
    // Only entity pages are candidates (a meeting titled "Dana Jones Example"
    // is not Dana), and two entity pages carrying the same name are
    // ambiguous: neither wins by trigram score.
    if (sameNameOnly) {
      const named = rows.filter(row => isFactEntityPage(row.slug, row.type) && sameEntityName(raw, row.title, row.slug));
      return named.length === 1 ? named[0].slug : null;
    }
    // Phantom canonicals: a clear winner only, with a margin over the runner-up.
    if (rows.length > 0 && rows[0].score >= 0.7 && (rows.length === 1 || rows[0].score - rows[1].score >= 0.1)) return rows[0].slug;
  } catch (err) {
    // pg_trgm might not be installed on every engine config: that brain has
    // no fuzzy arm and falls through to slugify. Any other database error
    // propagates rather than becoming a silent misattribution.
    if (!isMissingTrigramError(err)) throw err;
  }
  return null;
}

function isMissingTrigramError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  const message = err instanceof Error ? err.message : String(err);
  return code === '42883' || /function similarity|operator does not exist: text %/i.test(message);
}


/**
 * Deterministic slugify: lowercase, fold accents and stroke letters to their
 * base letter, keep letters and digits of every script (Cyrillic й/ё
 * included, ADR-0001), turn every other run into one hyphen, trim hyphens.
 *
 * Exported for tests + callers who want the same fallback shape independently.
 */
export function slugify(raw: string): string {
  // NFKD first so compatibility forms fold too ("ﬁ" → "fi"), then the shared
  // letter fold (cjk.ts). Stroke letters carry no decomposition, so the mark
  // strip cannot fold them and the sweep below would DELETE them ("Đăng
  // Example" → "ang-example"); fold them after the strip so composed forms
  // reduce in one pass ("ǿ" → "ø" → "o").
  return foldNonDecomposingLatin(foldSlugText(raw.normalize('NFKD')))
    .replace(SLUG_NON_WORD_RUN_RE, '-')
    .replace(/^-+|-+$/g, '');
}
