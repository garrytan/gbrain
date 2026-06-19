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
import { slugify } from '../entities/resolve.ts';
import { stripTakesFence } from '../takes-fence.ts';
import { stripFactsFence } from '../facts-fence.ts';
import type { EntityCandidate } from './entity-salience.ts';

/** Default cap on pointers injected per turn (config: retrieval_reflex_max_pointers). */
export const DEFAULT_MAX_POINTERS = 3;
const SYNOPSIS_MAX = 160;

/** Which resolution arm produced a pointer (provenance → honest confidence). */
export type ResolveArm = 'alias' | 'title' | 'slug-suffix';

/**
 * v0.43 (#2095) — arm → confidence. Lives HERE, next to the arm definitions,
 * so arm identity and its score can't drift apart (eng-review note). The
 * volunteer layer imports these; small deterministic boosts (multi-turn /
 * newest-turn mention) are added on top there.
 */
export const ARM_CONFIDENCE: Record<ResolveArm, number> = {
  alias: 0.9,
  title: 0.8,
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
}

interface PageRow {
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

  // display lookup keyed by normalized query, so resolved slugs can recover a
  // human surface form for the pointer label.
  const displayByNorm = new Map<string, string>();
  const aliasNorms: string[] = [];
  const titlesLc: string[] = [];
  const exactSlugs: string[] = [];
  const slugSuffixes: string[] = [];
  // Reverse maps for arm-2 provenance (which candidate produced a row) —
  // populated in this same pass so the derivations happen exactly once.
  const titleToNorm = new Map<string, string>();
  const slugToNorm = new Map<string, string>();
  for (const c of candidates) {
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
  for (let i = 0; i < sourceIds.length; i++) {
    const r = aliasResults[i];
    if (r.status !== 'fulfilled') continue;
    for (const norm of aliasNorms) {
      const hits = r.value.get(norm);
      if (hits && hits.length === 1) push(hits[0].slug, sourceIds[i], 'alias', norm);
    }
  }

  // Arm 2 — exact title OR slug-suffix. This is the recall fix: a bare "Alice
  // Example" slugifies to alice-example, but the real page is people/alice-example,
  // so a plain slug = ANY() misses. Match lower(title) exactly or the slug suffix.
  let rows: PageRow[] = [];
  try {
    rows = await engine.executeRaw<PageRow>(
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
  // can't report which predicate matched: an exact lower(title) hit is the
  // 'title' arm; anything else got in via slug / slug-suffix.
  const titleSet = new Set(titlesLc);
  for (const r of rows) {
    const titleLc = (r.title ?? '').toLowerCase();
    if (titleSet.has(titleLc)) {
      push(r.slug, r.source_id, 'title', titleToNorm.get(titleLc));
    } else {
      // Slug arm: exact slugified-candidate match, else suffix scan.
      const tail = r.slug.includes('/') ? r.slug.slice(r.slug.lastIndexOf('/') + 1) : r.slug;
      push(r.slug, r.source_id, 'slug-suffix', slugToNorm.get(r.slug) ?? slugToNorm.get(tail));
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
 */
function safeSynopsis(row: PageRow): string {
  const fmSummary = row.frontmatter?.summary;
  if (typeof fmSummary === 'string' && fmSummary.trim()) {
    return clip(collapse(fmSummary), SYNOPSIS_MAX);
  }
  const body = row.compiled_truth ?? '';
  if (!body) return '';
  const stripped = stripFactsFence(stripTakesFence(body), { keepVisibility: ['world'] });
  // Drop frontmatter block, markdown headings, and blank lines; first real prose line.
  const firstProse = stripped
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('<!--'));
  if (!firstProse) return '';
  // first sentence-ish
  const sentence = firstProse.split(/(?<=[.!?])\s/)[0];
  return clip(collapse(sentence), SYNOPSIS_MAX);
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
  void import('./volunteer-events.ts')
    .then(({ logVolunteerEventsFireAndForget, volunteerEventRowsFrom }) => {
      logVolunteerEventsFireAndForget(
        engine,
        volunteerEventRowsFrom(
          pointers.map((p) => ({ ...p, rationale: `${p.arm} match "${p.display}"` })),
          { channel: 'reflex' },
        ),
      );
    })
    .catch(() => {
      /* telemetry only */
    });
}
