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

export interface ReflexPointer {
  display: string;
  slug: string;
  synopsis: string;
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
}

interface PageRow {
  slug: string;
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
  for (const c of candidates) {
    const norm = normalizeAlias(c.query);
    if (!norm) continue;
    if (!displayByNorm.has(norm)) displayByNorm.set(norm, c.display);
    aliasNorms.push(norm);
    titlesLc.push(c.query.toLowerCase());
    const s = slugify(c.query);
    if (s) {
      exactSlugs.push(s);
      slugSuffixes.push(`%/${s}`);
    }
  }
  if (!aliasNorms.length) return null;

  // Ordered set of resolved slugs (alias hits first → higher confidence).
  const resolvedSlugs: string[] = [];
  const seen = new Set<string>();
  const pushSlug = (slug: string) => {
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      resolvedSlugs.push(slug);
    }
  };

  // Arm 1 — alias-first. Unambiguous single-slug hits only. Guarded: pre-v110
  // brains throw "relation page_aliases does not exist" — swallow and continue.
  try {
    const aliasMap = await engine.resolveAliases(aliasNorms, { sourceId });
    for (const norm of aliasNorms) {
      const hits = aliasMap.get(norm);
      if (hits && hits.length === 1) pushSlug(hits[0].slug);
    }
  } catch {
    /* no page_aliases table (pre-v110) — degrade to the title/slug arm */
  }

  // Arm 2 — exact title OR slug-suffix. This is the recall fix: a bare "Alice
  // Example" slugifies to alice-example, but the real page is people/alice-example,
  // so a plain slug = ANY() misses. Match lower(title) exactly or the slug suffix.
  let rows: PageRow[] = [];
  try {
    rows = await engine.executeRaw<PageRow>(
      `SELECT slug, title, type, frontmatter, compiled_truth
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = $1
          AND ( lower(title) = ANY($2::text[])
             OR slug = ANY($3::text[])
             OR slug LIKE ANY($4::text[]) )`,
      [sourceId, titlesLc, exactSlugs, slugSuffixes],
    );
  } catch {
    rows = [];
  }
  // Hydrate alias-resolved slugs too (their bodies for the synopsis) if not in rows.
  const rowBySlug = new Map<string, PageRow>();
  for (const r of rows) rowBySlug.set(r.slug, r);
  const aliasOnly = resolvedSlugs.filter((s) => !rowBySlug.has(s));
  if (aliasOnly.length) {
    try {
      const extra = await engine.executeRaw<PageRow>(
        `SELECT slug, title, type, frontmatter, compiled_truth
           FROM pages
          WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])`,
        [sourceId, aliasOnly],
      );
      for (const r of extra) rowBySlug.set(r.slug, r);
    } catch {
      /* ignore — alias slug may be stale */
    }
  }
  // Title/slug matches that weren't alias hits, appended after alias hits.
  for (const r of rows) pushSlug(r.slug);

  // Build pointers in confidence order, applying suppression + cap.
  const pointers: ReflexPointer[] = [];
  for (const slug of resolvedSlugs) {
    const row = rowBySlug.get(slug);
    if (!row) continue;
    // Suppression: already present in PRIOR context (slug or title). The current
    // turn is deliberately excluded from priorContextText.
    if (priorLc) {
      const titleLc = (row.title ?? '').toLowerCase();
      if (priorLc.includes(slug.toLowerCase())) continue;
      if (titleLc && wholeWordIncludes(priorLc, titleLc)) continue;
    }
    const display = displayForRow(row, displayByNorm);
    const synopsis = safeSynopsis(row);
    pointers.push({ display, slug, synopsis });
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
