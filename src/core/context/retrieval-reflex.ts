/**
 * Retrieval Reflex — resolver core (issue #1981, Layer 1).
 *
 * Given salient candidate surface-forms (from entity-salience.ts) and a real
 * BrainEngine, resolve the ones that map to an EXISTING brain page and return a
 * compact POINTER block (name → slug → safe one-line synopsis) to inject into
 * the system prompt. Detect + point, NEVER auto-dump the body — the agent makes
 * the deliberate get_page call when the entity is actually the subject.
 *
 * This is the NARROW operation behind the resolve capability: it takes
 * candidates and returns pointers. The IPC (serve) and host (ctx.brainQuery)
 * paths run THIS SAME function server-side so no raw SQL ever crosses a trust
 * boundary — the wire only carries candidates in and pointers out.
 *
 * Deterministic, zero-LLM. Precision-biased resolution (no trgm-fuzzy):
 *   1. alias-first  — page_aliases exact (unambiguous single-slug only)
 *   2. title + slug-suffix — lower(title) exact OR slug suffix match
 *      (real slugs are namespaced people/alice-example; bare slugify misses).
 *
 * Privacy (eng-review D5): the synopsis is taken from a SAFE source —
 * frontmatter `summary` if present, else the page body with takes/private-fact
 * fences STRIPPED (same boundary get_page applies to untrusted readers). Raw
 * compiled_truth is never injected.
 */

import type { BrainEngine } from '../engine.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { CJK_SLUG_CHARS } from '../cjk.ts';
import { escapeLikePattern } from '../search/sql-ranking.ts';
import { slugify } from '../entities/resolve.ts';
import { stripTakesFence } from '../takes-fence.ts';
import { stripFactsFence } from '../facts-fence.ts';
import type { EntityCandidate } from './entity-salience.ts';
import { reflexPointerRationale } from './reflex-rationale.ts';
import { logVolunteerEventsFireAndForget, volunteerEventRowsFrom } from './volunteer-events.ts';

export { reflexPointerRationale } from './reflex-rationale.ts';

/** Default cap on pointers injected per turn (config: retrieval_reflex_max_pointers). */
export const DEFAULT_MAX_POINTERS = 3;
const SYNOPSIS_MAX = 160;

// #3746 — pure-CJK norm (every char in the shared Han/kana/hangul ranges).
// These norms get the extra exact-title/exact-slug arm: CJK candidates are
// n-grams with no capitalization signal, `slugify()` strips CJK entirely (so
// the generic slug arm can never fire for them), and the alias table alone
// covers only explicitly registered aliases.
const PURE_CJK_RE = new RegExp(`^[${CJK_SLUG_CHARS}]+$`, 'u');

/** Which resolution arm produced a pointer (provenance → honest confidence). */
export type ResolveArm = 'alias' | 'title' | 'slug-suffix' | 'title-surname' | 'cjk-title';

/**
 * v0.43 (#2095) — arm → confidence. Lives HERE, next to the arm definitions,
 * so arm identity and its score can't drift apart (eng-review note). The
 * volunteer layer imports these; small deterministic boosts (multi-turn /
 * newest-turn mention) are added on top there.
 *
 * 'title-surname' (v0.46.15 identity wave) sits at 0.72 — deliberately ABOVE
 * the volunteer layer's 0.70 default gate (a 0.6x score would be silently
 * discarded there) and below 'title' (an exact-title hit is stronger
 * evidence than a surname-tail match).
 *
 * 'cjk-title' (#3746) also sits at 0.72: a pure-CJK weak n-gram that exactly
 * matches a unique page title/slug. Exact evidence, but the gram lacks the
 * capitalization signal a strong 'title' candidate carries — score it with
 * the surname class, above the volunteer gate.
 */
export const ARM_CONFIDENCE: Record<ResolveArm, number> = {
  alias: 0.9,
  title: 0.8,
  'title-surname': 0.72,
  'cjk-title': 0.72,
  'slug-suffix': 0.6,
};

export interface ReflexPointer {
  display: string;
  slug: string;
  /** Which brain source the page lives in (federated callers need it for dedup). */
  source_id: string;
  synopsis: string;
  /** Resolution provenance (v0.43 #2095). */
  arm: ResolveArm;
  /** Base arm confidence (ARM_CONFIDENCE[arm]); callers may boost. */
  confidence: number;
  /**
   * normalizeAlias form of the CANDIDATE that resolved this pointer (v0.43
   * #2095) — lets the volunteer layer join pointers back to window-salience
   * metadata without guessing from the display label (which falls back to the
   * page title when the candidate surface differs, e.g. alias "Swami" →
   * title "Swami X"). Absent only when suffix classification couldn't
   * recover the source candidate.
   */
  matchedNorm?: string;
}

export interface PointerBlock {
  pointers: ReflexPointer[];
  /** Pre-rendered markdown for systemPromptAddition. */
  text: string;
}

export interface ResolvePointersOpts {
  maxPointers?: number;
  /**
   * Joined text of PRIOR turns + already-loaded page bodies (NOT the current
   * user message). Pointers whose slug/title already appear here are suppressed
   * — the agent has seen them. MUST exclude the current turn, or the triggering
   * message's own mention would suppress every pointer (eng-review/Codex fix).
   */
  priorContextText?: string;
  /**
   * v0.43 (#2095, codex D7) — suppression mode.
   *   'slug-and-title' (default, window=1 legacy): suppress when the slug OR
   *     the page title appears whole-word in prior context.
   *   'slug-only' (REQUIRED under multi-turn windowing): suppress on slug
   *     presence only. Slugs only enter context when a pointer block or page
   *     body was actually injected; a bare mention of "Alice Example" in a
   *     prior turn never contains `people/alice-example`. The title rule
   *     would suppress every entity merely MENTIONED in a prior window turn
   *     — breaking window extraction by construction.
   */
  suppression?: 'slug-and-title' | 'slug-only';
  /**
   * v0.43 (#2095) — federated scope: resolve across these sources instead of
   * the single positional sourceId. Precedence mirrors sourceScopeOpts
   * (federated array > scalar). Alias arm loops per source; the title/slug
   * arm uses source_id = ANY(...) in one query.
   */
  sourceIds?: string[];
  /**
   * v0.46.15 identity wave — kill switch for the two new lexical arms (the
   * weak-candidate alias arm and the surname arm). Default ON (undefined =
   * enabled); `false` reproduces pre-wave resolution exactly. Threaded from
   * the file-plane config `retrieval_reflex_lexical_arms` / env
   * `GBRAIN_RETRIEVAL_REFLEX_LEXICAL_ARMS` by callers that own a loaded
   * config — the resolver itself never touches config (sync hot path).
   */
  lexicalArms?: boolean;
}

export interface PageRow {
  slug: string;
  source_id: string;
  title: string;
  type: string | null;
  frontmatter: Record<string, unknown> | null;
  compiled_truth: string | null;
}

/**
 * Resolve candidates to a pointer block. Returns null when nothing resolves
 * (so the caller injects nothing). Never throws for data reasons — each arm is
 * independently guarded so a pre-v110 brain (no page_aliases) still gets the
 * title/slug arm.
 */
export async function resolveEntitiesToPointers(
  engine: BrainEngine,
  sourceId: string,
  candidates: EntityCandidate[],
  opts: ResolvePointersOpts = {},
): Promise<PointerBlock | null> {
  if (!candidates.length) return null;
  const maxPointers = opts.maxPointers ?? DEFAULT_MAX_POINTERS;
  const priorLc = (opts.priorContextText ?? '').toLowerCase();

  // v0.46.15 identity wave: the two new lexical arms (weak-alias + surname)
  // share one kill switch. Default ON; `false` reproduces pre-wave behavior.
  const lexicalArms = opts.lexicalArms !== false;

  // display lookup keyed by normalized query, so resolved slugs can recover a
  // human surface form for the pointer label.
  const displayByNorm = new Map<string, string>();
  const aliasNorms: string[] = [];
  const titlesLc: string[] = [];
  const exactSlugs: string[] = [];
  const slugSuffixes: string[] = [];
  // Weak candidates resolve through the ALIAS arm only (exact, unique). Their
  // norms are tracked so the alias fold can apply the stricter cross-source
  // uniqueness rule to them.
  const weakNorms = new Set<string>();
  // Surname arm inputs: strong single-token capitalized candidates ≥3 chars.
  const surnamePatterns: string[] = [];
  const surnameTokens: string[] = []; // lower(token), parallel to patterns
  const surnameTokenToNorm = new Map<string, string>();
  // Reverse maps for arm-2 provenance (which candidate produced a row) —
  // populated in this same pass so the derivations happen exactly once.
  const titleToNorm = new Map<string, string>();
  const slugToNorm = new Map<string, string>();
  for (const c of candidates) {
    // Lowercase WEAK candidates (entity-salience step 2.5) may probe the
    // alias table ONLY — never the title/slug/suffix arms, where ordinary
    // lowercase words would fabricate pointers. Gated by the kill switch.
    if (c.weak) {
      if (!lexicalArms) continue;
      const wnorm = normalizeAlias(c.query);
      if (!wnorm) continue;
      if (!displayByNorm.has(wnorm)) displayByNorm.set(wnorm, c.display);
      if (!weakNorms.has(wnorm)) {
        weakNorms.add(wnorm);
        aliasNorms.push(wnorm);
      }
      continue;
    }
    const norm = normalizeAlias(c.query);
    if (!norm) continue;
    if (!displayByNorm.has(norm)) displayByNorm.set(norm, c.display);
    aliasNorms.push(norm);
    const tl = c.query.toLowerCase();
    titlesLc.push(tl);
    if (!titleToNorm.has(tl)) titleToNorm.set(tl, norm);
    const s = slugify(c.query);
    if (s) {
      exactSlugs.push(s);
      slugSuffixes.push(`%/${s}`);
      if (!slugToNorm.has(s)) slugToNorm.set(s, norm);
    }
    // Surname arm (v0.46.15, kta-pos variant 4): a strong single capitalized
    // token ≥3 chars may be a surname-only reference ("Did Galewright ever…").
    // Escaped for LIKE (backslash is Postgres' default escape char — no
    // ESCAPE clause, which the `LIKE ANY(array)` form doesn't accept).
    if (lexicalArms && !/\s/.test(c.query) && c.query.length >= 3 && /^\p{Lu}/u.test(c.query)) {
      const tokenLc = c.query.toLowerCase();
      if (!surnameTokenToNorm.has(tokenLc)) {
        surnameTokenToNorm.set(tokenLc, norm);
        surnameTokens.push(tokenLc);
        surnamePatterns.push(`% ${escapeLikePattern(tokenLc)}`);
      }
    }
  }
  if (!aliasNorms.length) return null;

  // Federated scope (v0.43 #2095): explicit sourceIds win over the scalar.
  const sourceIds = opts.sourceIds?.length ? opts.sourceIds : [sourceId];

  // Ordered set of resolved (source, slug) pairs with arm provenance —
  // alias hits pushed first → higher confidence.
  const resolved: Array<{ slug: string; source_id: string; arm: ResolveArm; matchedNorm?: string }> = [];
  const seen = new Set<string>();
  // Neither source ids nor slugs contain spaces, so a space separator is safe.
  const keyOf = (src: string, slug: string) => `${src} ${slug}`;
  const push = (slug: string, src: string, arm: ResolveArm, matchedNorm?: string) => {
    if (!slug) return;
    const k = keyOf(src, slug);
    if (!seen.has(k)) {
      seen.add(k);
      resolved.push({ slug, source_id: src, arm, matchedNorm });
    }
  };
  // Arm 1 — alias-first. Unambiguous single-slug hits only, per source (no
  // engine-interface change for federation). Guarded: pre-v110 brains throw
  // "relation page_aliases does not exist" — swallow and continue.
  // Per-source lookups are independent — run them concurrently so a
  // federated caller (M granted sources) pays one RTT, not M sequential
  // ones (~71ms each cross-region; the reflex runs under a 1.5s budget).
  // Results are folded back in sourceIds order so pointer ordering stays
  // deterministic. Per-source failures degrade independently (pre-v110
  // brains have no page_aliases table).
  const aliasResults = await Promise.allSettled(
    sourceIds.map((src) => engine.resolveAliases(aliasNorms, { sourceId: src })),
  );
  const anyAliasSourceFailed = aliasResults.some((r) => r.status !== 'fulfilled');
  // Liveness BEFORE uniqueness: page_aliases has no FK, so a norm's hit list
  // can carry rows for deleted/renamed pages. Deciding uniqueness on raw hits
  // lets a stale row veto the sole live target (hits.length becomes 2), or
  // conversely leaves a phantom looking unique. One batched live-check over
  // every hit slug; result rows carry their true (source_id, slug) so the
  // ANY(sources) × ANY(slugs) over-match cannot mis-key. If the check itself
  // fails, strong arms fall back to raw-hit uniqueness (phantom pointers are
  // still dropped by the downstream hydration) and the weak fold goes
  // fail-closed.
  const liveAliasKeys = new Set<string>();
  let liveCheckOk = false;
  {
    const hitSlugs = new Set<string>();
    for (const r of aliasResults) {
      if (r.status !== 'fulfilled') continue;
      for (const hits of r.value.values()) for (const h of hits) hitSlugs.add(h.slug);
    }
    if (hitSlugs.size) {
      try {
        const liveRows = await engine.executeRaw<{ slug: string; source_id: string }>(
          `SELECT slug, source_id FROM pages
            WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND slug = ANY($2::text[])`,
          [sourceIds, [...hitSlugs]],
        );
        for (const r of liveRows) liveAliasKeys.add(keyOf(r.source_id, r.slug));
        liveCheckOk = true;
      } catch {
        /* fall back below */
      }
    } else {
      liveCheckOk = true;
    }
  }
  const liveHitsFor = (
    r: PromiseSettledResult<Map<string, Array<{ slug: string; source_id: string }>>>,
    src: string,
    norm: string,
  ): Array<{ slug: string; source_id: string }> => {
    if (r.status !== 'fulfilled') return [];
    const hits = r.value.get(norm) ?? [];
    return liveCheckOk ? hits.filter((h) => liveAliasKeys.has(keyOf(h.source_id || src, h.slug))) : hits;
  };
  for (let i = 0; i < sourceIds.length; i++) {
    for (const norm of aliasNorms) {
      if (weakNorms.has(norm)) continue; // weak norms fold below (stricter rule)
      const hits = liveHitsFor(aliasResults[i], sourceIds[i], norm);
      if (hits.length === 1) push(hits[0].slug, sourceIds[i], 'alias', norm);
    }
  }
  // Weak norms: GLOBAL uniqueness across all considered sources (v0.46.15,
  // stricter than the strong per-source rule) — a lowercase word that is a
  // registered alias in two sources injects nothing. FAIL-CLOSED on partial
  // visibility (adversarial F2): if any source's alias lookup failed, or the
  // live-check did, uniqueness cannot be decided globally — a transient DB
  // blip must not make an ambiguous alias look unique. Skip the fold; the
  // next turn retries with full visibility.
  if (weakNorms.size && !anyAliasSourceFailed && liveCheckOk) {
    for (const norm of weakNorms) {
      const all: Array<{ slug: string; source_id: string }> = [];
      for (let i = 0; i < sourceIds.length; i++) {
        for (const h of liveHitsFor(aliasResults[i], sourceIds[i], norm)) {
          all.push({ slug: h.slug, source_id: sourceIds[i] });
        }
      }
      if (all.length === 1) push(all[0].slug, all[0].source_id, 'alias', norm);
    }
  }

  // Arm 2 — exact title OR slug-suffix. This is the recall fix: a bare "Alice
  // Example" slugifies to alice-example, but the real page is people/alice-example,
  // so a plain slug = ANY() misses. Match lower(title) exactly or the slug suffix.
  let rows: PageRow[] = [];
  const useSurnameArm = surnamePatterns.length > 0;
  try {
    // The surname predicate rides the SAME query when armed: person pages
    // whose lower(title) ends with " <token>". Patterns are pre-escaped for
    // LIKE (backslash default escape); type='person' kills the company-tail
    // class ("Labs", "Systems" as pseudo-surnames).
    rows = useSurnameArm
      ? await engine.executeRaw<PageRow>(
          `SELECT slug, source_id, title, type, frontmatter, compiled_truth
             FROM pages
            WHERE deleted_at IS NULL
              AND source_id = ANY($1::text[])
              AND ( lower(title) = ANY($2::text[])
                 OR slug = ANY($3::text[])
                 OR slug LIKE ANY($4::text[])
                 OR (lower(title) LIKE ANY($5::text[]) AND type = 'person') )`,
          [sourceIds, titlesLc, exactSlugs, slugSuffixes, surnamePatterns],
        )
      : await engine.executeRaw<PageRow>(
          `SELECT slug, source_id, title, type, frontmatter, compiled_truth
             FROM pages
            WHERE deleted_at IS NULL
              AND source_id = ANY($1::text[])
              AND ( lower(title) = ANY($2::text[])
             OR slug = ANY($3::text[])
             OR slug LIKE ANY($4::text[]) )`,
          [sourceIds, titlesLc, exactSlugs, slugSuffixes],
        );
  } catch {
    rows = [];
  }
  // Hydrate alias-resolved pages too (their bodies for the synopsis) if not in rows.
  const rowByKey = new Map<string, PageRow>();
  for (const r of rows) rowByKey.set(keyOf(r.source_id, r.slug), r);
  const aliasOnly = resolved.filter((p) => !rowByKey.has(keyOf(p.source_id, p.slug)));
  if (aliasOnly.length) {
    try {
      const extra = await engine.executeRaw<PageRow>(
        `SELECT slug, source_id, title, type, frontmatter, compiled_truth
           FROM pages
          WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND slug = ANY($2::text[])`,
        [sourceIds, aliasOnly.map((p) => p.slug)],
      );
      for (const r of extra) rowByKey.set(keyOf(r.source_id, r.slug), r);
    } catch {
      /* ignore — alias slug may be stale */
    }
  }
  // Title/slug matches that weren't alias hits, appended after alias hits.
  // Arm provenance per row is classified in JS (codex D8) — the combined OR
  // can't report which predicate matched. Classification is per-(row,
  // matching-set) with exact-arm precedence (eng review): a row can
  // title-match candidate X AND surname-match candidate Y — the exact hit
  // wins. Rows matched by NO exact set fall through to the surname check.
  const titleSet = new Set(titlesLc);
  // token → surname-matched rows; pushed only when the token is UNAMBIGUOUS
  // (exactly one page across the considered sources — mirror of the alias
  // arm's posture; an ambiguous surname injects nothing).
  //
  // Ambiguity is counted over ALL person rows carrying the surname,
  // INDEPENDENT of which arm claims a row (adversarial F1): classification
  // precedence (title/slug win) would otherwise remove a title-claimed
  // namesake from the surname count — with "Jane Galewright" resolved by
  // title and a bare "Galewright" in the same window, the OTHER Galewright
  // would look unique and inject the wrong person. The SQL OR fetches every
  // surname-matching person row regardless of later classification, so this
  // coverage count is complete.
  const surnameCoverage = new Map<string, number>();
  if (useSurnameArm) {
    for (const r of rows) {
      if (r.type !== 'person') continue;
      const titleLc = (r.title ?? '').toLowerCase();
      const token = surnameTokens.find((t) => titleLc.endsWith(` ${t}`));
      if (token) surnameCoverage.set(token, (surnameCoverage.get(token) ?? 0) + 1);
    }
  }
  const surnameHits = new Map<string, Array<{ slug: string; source_id: string }>>();
  for (const r of rows) {
    const titleLc = (r.title ?? '').toLowerCase();
    if (titleSet.has(titleLc)) {
      push(r.slug, r.source_id, 'title', titleToNorm.get(titleLc));
      continue;
    }
    // Slug arm: exact slugified-candidate match, else suffix scan.
    const tail = r.slug.includes('/') ? r.slug.slice(r.slug.lastIndexOf('/') + 1) : r.slug;
    const slugNorm = slugToNorm.get(r.slug) ?? slugToNorm.get(tail);
    if (slugNorm !== undefined) {
      push(r.slug, r.source_id, 'slug-suffix', slugNorm);
      continue;
    }
    // Surname arm (v0.46.15): this row got in via the surname predicate only.
    if (useSurnameArm && r.type === 'person') {
      const token = surnameTokens.find((t) => titleLc.endsWith(` ${t}`));
      if (token) {
        const list = surnameHits.get(token) ?? [];
        list.push({ slug: r.slug, source_id: r.source_id });
        surnameHits.set(token, list);
      }
    }
  }
  for (const [token, hits] of surnameHits) {
    // hits counts rows the surname arm alone claimed; coverage counts every
    // holder including title/slug-claimed namesakes. Both must be 1.
    if (hits.length === 1 && (surnameCoverage.get(token) ?? 0) === 1) {
      push(hits[0].slug, hits[0].source_id, 'title-surname', surnameTokenToNorm.get(token));
    }
  }

  // Arm 2.5 — pure-CJK weak exact-title/exact-slug (#3746, 'cjk-title').
  // CJK weak n-grams may probe EXACT title/slug equality on top of the alias
  // arm: slugify() strips CJK so the generic slug arm can never fire, and CJK
  // pages routinely have no registered alias. Never suffix/surname (an n-gram
  // tail-matching slugs would over-match wildly). Gated by the same
  // lexicalArms kill switch as the other weak arms; GLOBAL uniqueness across
  // the considered sources (mirror of the weak-alias fold) — an ambiguous
  // gram injects nothing.
  if (lexicalArms && weakNorms.size) {
    const armResolvedNorms = new Set(resolved.map((r) => r.matchedNorm).filter(Boolean));
    const cjkNorms = [...weakNorms].filter((n) => PURE_CJK_RE.test(n) && !armResolvedNorms.has(n));
    if (cjkNorms.length) {
      try {
        const cjkRows = await engine.executeRaw<PageRow>(
          `SELECT slug, source_id, title, type, frontmatter, compiled_truth
             FROM pages
            WHERE deleted_at IS NULL
              AND source_id = ANY($1::text[])
              AND ( lower(title) = ANY($2::text[]) OR slug = ANY($3::text[]) )`,
          [sourceIds, cjkNorms, cjkNorms],
        );
        const cjkHits = new Map<string, Array<{ slug: string; source_id: string }>>();
        for (const r of cjkRows) {
          rowByKey.set(keyOf(r.source_id, r.slug), r); // hydrate for synopsis
          const titleLc = (r.title ?? '').toLowerCase();
          for (const n of cjkNorms) {
            if (titleLc === n || r.slug === n) {
              const list = cjkHits.get(n) ?? [];
              list.push({ slug: r.slug, source_id: r.source_id });
              cjkHits.set(n, list);
            }
          }
        }
        for (const [n, hits] of cjkHits) {
          if (hits.length === 1) push(hits[0].slug, hits[0].source_id, 'cjk-title', n);
        }
      } catch {
        /* fail-open — the alias arm already ran */
      }
    }
  }

  // Build pointers in confidence order, applying suppression + cap.
  const suppression = opts.suppression ?? 'slug-and-title';
  const pointers: ReflexPointer[] = [];
  for (const { slug, source_id, arm, matchedNorm } of resolved) {
    const row = rowByKey.get(keyOf(source_id, slug));
    if (!row) continue;
    // Suppression: already present in PRIOR context. The current turn is
    // deliberately excluded from priorContextText. Under windowing
    // ('slug-only', codex D7) only the slug counts — a slug appears in prior
    // context only when a pointer/page was actually surfaced there, while a
    // title appears on any bare mention.
    if (priorLc) {
      if (priorLc.includes(slug.toLowerCase())) continue;
      if (suppression === 'slug-and-title') {
        const titleLc = (row.title ?? '').toLowerCase();
        if (titleLc && wholeWordIncludes(priorLc, titleLc)) continue;
      }
    }
    const display = displayForRow(row, displayByNorm);
    const synopsis = safeSynopsis(row);
    pointers.push({ display, slug, source_id, synopsis, arm, confidence: ARM_CONFIDENCE[arm], matchedNorm });
    if (pointers.length >= maxPointers) break;
  }

  if (!pointers.length) return null;
  return { pointers, text: renderPointerBlock(pointers) };
}

/** Recover a display label: prefer the matched candidate surface, else the page title. */
function displayForRow(row: PageRow, displayByNorm: Map<string, string>): string {
  const byTitle = displayByNorm.get(normalizeAlias(row.title ?? ''));
  if (byTitle) return byTitle;
  // try the slug tail (people/alice-example → alice-example)
  const tail = row.slug.includes('/') ? row.slug.slice(row.slug.lastIndexOf('/') + 1) : row.slug;
  return row.title || tail;
}

/**
 * Privacy-safe synopsis (eng-review D5). Prefer a curated frontmatter `summary`;
 * otherwise strip takes/private-fact fences from the body (the same boundary
 * get_page applies to untrusted readers) and take the first sentence. Never
 * returns raw compiled_truth.
 *
 * Exported for the MEMORY_VERBS v1 entity card (verbs/entity-card.ts) — the
 * card's `summary` field runs through THIS boundary, not a parallel one.
 * Also consumed by compile-view.ts (cathedral-5), which widens `maxLen` to
 * 600 for compiled-context excerpts; the default stays SYNOPSIS_MAX.
 */
export function safeSynopsis(
  row: PageRow,
  opts: { keepVisibility?: ('private' | 'world')[]; maxLen?: number } = {},
): string {
  // v0.45.7 ambient recall: world-only by default (the injected-context posture).
  // The ONLY widening caller is the entity-card builder for a trusted-local
  // include_private pack (entity-card.ts) — the pointer/volunteer arms always
  // run world-only (turn mode never widens).
  const keepVisibility = opts.keepVisibility ?? ['world'];
  const maxLen = opts.maxLen ?? SYNOPSIS_MAX;
  const fmSummary = row.frontmatter?.summary;
  if (typeof fmSummary === 'string' && fmSummary.trim()) {
    return clip(collapse(fmSummary), maxLen);
  }
  const body = row.compiled_truth ?? '';
  if (!body) return '';
  const stripped = stripFactsFence(stripTakesFence(body), { keepVisibility });
  // Drop frontmatter block, markdown headings, and blank lines; first real prose line.
  const firstProse = stripped
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('<!--'));
  if (!firstProse) return '';
  // first sentence-ish
  const sentence = firstProse.split(/(?<=[.!?])\s/)[0];
  return clip(collapse(sentence), maxLen);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/** Whole-word containment so "ab" doesn't match inside "fabric". */
function wholeWordIncludes(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${esc}(\\W|$)`).test(haystack);
}

export function renderPointerBlock(pointers: ReflexPointer[]): string {
  const lines = [
    '## Brain pages mentioned this turn',
    'You referenced entities with existing brain pages. Open the page before relying on',
    'details — do not answer from memory.',
    '',
  ];
  for (const p of pointers) {
    const syn = p.synopsis ? ` — ${p.synopsis}` : '';
    lines.push(`- **${p.display}** → \`${p.slug}\`${syn} (use get_page before relying on details)`);
  }
  return lines.join('\n');
}

/**
 * v0.43 (#2095, codex D11 + red-team) — ambient-channel feedback logging,
 * ACCEPT-SIDE ONLY. Called by the delivery points (the serve IPC server after
 * a successful write; the direct-Postgres reflex rung after its per-turn
 * timeout admitted the block) — never inside the resolver itself, because a
 * pointer block that timed out client-side was NEVER injected into a prompt,
 * and logging it would inflate "volunteered" counts and drag the measured
 * precision toward zero (corrupting the exact stats users tune
 * min_confidence with).
 */
export function logDeliveredReflexPointers(engine: BrainEngine, pointers: ReflexPointer[]): void {
  if (!pointers.length) return;
  // Register work synchronously. A dynamic import here creates a late-
  // registration race: callers can drain the sink before the import resolves.
  try {
    logVolunteerEventsFireAndForget(
      engine,
      volunteerEventRowsFrom(
        pointers.map((p) => ({ ...p, rationale: reflexPointerRationale(p) })),
        { channel: 'reflex' },
      ),
    );
  } catch {
    /* telemetry only */
  }
}
