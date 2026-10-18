/**
 * Stem redirects for synthesize_concepts' grouping: every concept ref an atom
 * carries is slugified to a stem, then sent through these redirects before
 * atoms are grouped into one page per stem. Two kinds of redirect live in the
 * same in-memory map; neither writes a page.
 *
 * #6161: concept merges a human made. The concept-synthesis skill merges
 * concept B into A by archiving B under `concepts/_merged/` with
 * `merged_into: A` and listing B in A's `aliases`. Either record redirects B's
 * atoms to A, so the phase grows A instead of recreating B. Aliases count only
 * on pages the phase owns (`synthesized_by: synthesize_concepts…`), the pages a
 * merge targets. Read back by `loadConceptRedirects`.
 *
 * #5965: spelling variants of one label. `network-effects`, `network_effects`
 * and `networkeffects` are one concept, so `addSpellingRedirects` folds the
 * stems of a run that differ only by ASCII `-`, `_` and `.` onto one of them
 * for that run: the spelling that already has a live `concepts/<stem>` page
 * wins (a page is never re-created under a new spelling), else the spelling
 * most atoms use, a tie going to the hyphenated one. Two spellings that both
 * have live pages are left alone ([R28]: `re-sign` / `resign` and `co-op` /
 * `coop` are different concepts; only the human merge path above joins them).
 * These redirects exist for the run only; the grouping applies them after the
 * human hop, so `canonicalConceptStem` is called twice.
 */
import type { BrainEngine } from '../engine.ts';

/** Map of concept stem → canonical stem. The first record (by slug) wins a conflict. */
export async function loadConceptRedirects(engine: BrainEngine, sourceId: string,
  stemFor: (ref: string) => string | null): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ slug: string; merged_into: string | null; aliases: unknown; synthesized_by: string | null }>(
    `SELECT slug, frontmatter->>'merged_into' AS merged_into, frontmatter->'aliases' AS aliases, frontmatter->>'synthesized_by' AS synthesized_by
       FROM pages
      WHERE source_id = $1 AND slug LIKE 'concepts/%' AND deleted_at IS NULL
        AND ((frontmatter->>'merged_into') IS NOT NULL OR jsonb_typeof(frontmatter->'aliases') = 'array')
      ORDER BY slug`, [sourceId]);
  const redirects = new Map<string, string>();
  const add = (from: string | null, to: string | null) => {
    if (from && to && from !== to && !redirects.has(from)) redirects.set(from, to);
  };
  for (const row of rows) {
    if (row.merged_into) add(stemFor(row.slug), stemFor(row.merged_into));
    const aliases = typeof row.aliases === 'string' ? JSON.parse(row.aliases) as unknown : row.aliases;
    if (!String(row.synthesized_by ?? '').startsWith('synthesize_concepts') || !Array.isArray(aliases)) continue;
    for (const alias of aliases) if (typeof alias === 'string') add(stemFor(alias), stemFor(row.slug));
  }
  return redirects;
}

/** One hop through the redirects; a two-way redirect (a cycle) keeps the stem. */
export function canonicalConceptStem(stem: string, redirects: Map<string, string>): string {
  const target = redirects.get(stem);
  return target && redirects.get(target) !== stem ? target : stem;
}

/** The stems of the live top-level `concepts/<stem>` pages of a source (archived `concepts/_merged/…` pages excluded). */
export async function loadLiveConceptStems(engine: BrainEngine, sourceId: string,
  stemFor: (ref: string) => string | null): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND slug LIKE 'concepts/%' AND slug NOT LIKE 'concepts/%/%' AND deleted_at IS NULL`, [sourceId]);
  return new Set(rows.map((r) => stemFor(r.slug)).filter((s): s is string => s !== null));
}

/** #5965: the key two stems share when they differ only by ASCII `-`, `_` and `.` (Unicode is kept as is). */
export function spellingFoldKey(stem: string): string {
  return stem.replace(/[-_.]/g, '');
}

/**
 * #5965: adds a redirect from every losing spelling of a run to its winner
 * (see the module comment for the rule) and returns the pairs added. `atomCounts`
 * is the number of atoms per stem after the human redirects were applied; a
 * stem that already redirects somewhere is never folded again.
 */
export function addSpellingRedirects(redirects: Map<string, string>, atomCounts: Map<string, number>,
  liveStems: Set<string>): Array<{ from: string; to: string }> {
  const groups = new Map<string, string[]>();
  for (const stem of atomCounts.keys()) {
    if (redirects.has(stem)) continue;
    const key = spellingFoldKey(stem);
    groups.set(key, [...groups.get(key) ?? [], stem]);
  }
  const added: Array<{ from: string; to: string }> = [];
  for (const stems of groups.values()) {
    if (stems.length < 2) continue;
    const live = stems.filter((s) => liveStems.has(s));
    if (live.length > 1) continue;
    const winner = live[0] ?? [...stems].sort((a, b) =>
      (atomCounts.get(b) ?? 0) - (atomCounts.get(a) ?? 0) ||
      Number(b.includes('-')) - Number(a.includes('-')) ||
      a.localeCompare(b))[0]!;
    for (const stem of stems) {
      if (stem === winner) continue;
      redirects.set(stem, winner);
      added.push({ from: stem, to: winner });
    }
  }
  return added.sort((a, b) => a.from.localeCompare(b.from));
}
