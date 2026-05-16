/**
 * gbrain merge-phantoms — clean up existing phantom unprefixed entity pages.
 *
 * Pre-v0.34.5, when `resolveEntitySlug("Alice")` fell through to slugify
 * (because pg_trgm scored short bare names too low to match), `put_page`
 * / `writeFactsToFence` would stub-create a phantom `alice.md` at the
 * brain root and split the entity's facts across two pages — phantom
 * `alice.md` and canonical `people/alice-example.md`. The v0.34.5 fix
 * stops new phantoms from being created (stub-guard + backstop fallback)
 * but does nothing about the pile that built up before the fix landed.
 *
 * This command reads existing unprefixed entity pages, runs the new
 * resolver against them to find a canonical target, moves the facts
 * over (via UPDATE facts SET entity_slug = $canonical), and soft-deletes
 * the phantom page using the v0.26.5 destructive-guard machinery.
 *
 * Operator-only. Not exposed as an MCP op — destructive operations
 * stay CLI-only until there's a clear remote use case.
 *
 *   gbrain merge-phantoms [--dry-run] [--source SOURCE_ID] [--json]
 *
 * Algorithm:
 *   1. SELECT id, slug, type FROM pages
 *      WHERE source_id = $1
 *        AND slug NOT LIKE '%/%'
 *        AND type IN ('person','company','deal','topic','concept')
 *        AND deleted_at IS NULL
 *   2. For each row, call resolveEntitySlug to find a canonical target.
 *      Skip if (a) canonical is null or empty, (b) canonical equals the
 *      phantom slug, (c) canonical lacks a directory prefix, (d) the
 *      canonical page does not exist in the same source.
 *   3. UPDATE facts SET entity_slug = canonical WHERE entity_slug = slug.
 *      The facts table's dedup is body-hash based at write time, so
 *      moving the entity_slug column doesn't create duplicates here.
 *   4. softDeletePage the phantom (sets deleted_at, hides from search,
 *      72h purge TTL via the autopilot cycle's purge phase).
 *   5. Report what moved.
 *
 * `--dry-run` prints what would happen without mutating anything.
 *
 * Plan: ~/.claude/plans/mossy-popping-crown.md D7.
 */

import type { BrainEngine } from '../core/engine.ts';
import { tryPrefixExpansion, slugify } from '../core/entities/resolve.ts';

/** Phantom-resolution outcome for one row. */
export interface PhantomMerge {
  phantom: string;
  canonical: string | null;
  /** Set when the merge fired. */
  facts_moved?: number;
  /** Set when the row was skipped. */
  skipped?: 'no_canonical' | 'canonical_equals_phantom' | 'canonical_unprefixed' | 'canonical_missing';
}

export interface MergePhantomsResult {
  merged: PhantomMerge[];
  skipped: PhantomMerge[];
  total_scanned: number;
  dry_run: boolean;
  source_id: string;
}

/** Page types we treat as entity candidates. Aligns with stub-guard recognized types. */
const ENTITY_TYPES = ['person', 'company', 'deal', 'topic', 'concept'] as const;

/**
 * Find phantom unprefixed entity pages.
 * Pure data fetch; the caller does the resolve loop.
 */
export async function listPhantomEntityPages(
  engine: BrainEngine,
  sourceId: string,
): Promise<Array<{ id: number; slug: string; type: string }>> {
  // Build the type-list IN clause. Five known entries, parameterized.
  return engine.executeRaw<{ id: number; slug: string; type: string }>(
    `SELECT id, slug, type
       FROM pages
      WHERE source_id = $1
        AND slug NOT LIKE '%/%'
        AND type = ANY($2::text[])
        AND deleted_at IS NULL
      ORDER BY slug ASC`,
    [sourceId, [...ENTITY_TYPES]],
  );
}

/**
 * Merge phantom pages into their canonical targets.
 *
 * On each phantom: resolve → if canonical is good, UPDATE facts +
 * softDeletePage. Idempotent — running twice produces zero merges on
 * the second pass because the phantoms are soft-deleted on the first.
 */
export async function runMergePhantomsCore(
  engine: BrainEngine,
  opts: { sourceId: string; dryRun: boolean },
): Promise<MergePhantomsResult> {
  const phantoms = await listPhantomEntityPages(engine, opts.sourceId);
  const merged: PhantomMerge[] = [];
  const skipped: PhantomMerge[] = [];

  for (const row of phantoms) {
    // Use tryPrefixExpansion directly instead of resolveEntitySlug —
    // the latter's exact-slug step would match the phantom itself
    // (slug='alice' exists, so exact-slug returns 'alice' immediately)
    // and short-circuit before reaching prefix expansion. Slugify
    // defensively in case the stored phantom slug has unexpected
    // characters; for "alice"-shaped phantoms this is a no-op.
    const token = slugify(row.slug);
    const canonical = token ? await tryPrefixExpansion(engine, opts.sourceId, token) : null;

    if (!canonical) {
      skipped.push({ phantom: row.slug, canonical: null, skipped: 'no_canonical' });
      continue;
    }
    if (canonical === row.slug) {
      // Defensive: tryPrefixExpansion returns slugs of shape `<dir>/<slug>`
      // so this is unreachable in practice. Kept for type narrowing.
      skipped.push({ phantom: row.slug, canonical, skipped: 'canonical_equals_phantom' });
      continue;
    }
    if (!canonical.includes('/')) {
      // Defensive: tryPrefixExpansion only returns prefixed slugs by
      // construction (the SQL filters `slug LIKE '<dir>/<token>-%'`).
      // Kept as a belt-and-suspenders guard against future refactors.
      skipped.push({ phantom: row.slug, canonical, skipped: 'canonical_unprefixed' });
      continue;
    }

    // Verify the canonical page actually exists in the same source.
    const targetRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
      [opts.sourceId, canonical],
    );
    if (targetRows.length === 0) {
      skipped.push({ phantom: row.slug, canonical, skipped: 'canonical_missing' });
      continue;
    }

    // How many facts will move?
    const factCount = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1 AND entity_slug = $2`,
      [opts.sourceId, row.slug],
    );
    const facts_moved = factCount[0]?.n ?? 0;

    if (!opts.dryRun) {
      await engine.executeRaw(
        `UPDATE facts SET entity_slug = $1 WHERE source_id = $2 AND entity_slug = $3`,
        [canonical, opts.sourceId, row.slug],
      );
      await engine.softDeletePage(row.slug, { sourceId: opts.sourceId });
    }

    merged.push({ phantom: row.slug, canonical, facts_moved });
  }

  return {
    merged,
    skipped,
    total_scanned: phantoms.length,
    dry_run: opts.dryRun,
    source_id: opts.sourceId,
  };
}

// --- Output formatters ---

export function formatMergePhantomsText(result: MergePhantomsResult): string {
  const lines: string[] = [];
  const mode = result.dry_run ? '[dry-run] ' : '';
  lines.push(
    `${mode}scanned ${result.total_scanned} phantom candidates in source=${result.source_id}: ${result.merged.length} merged, ${result.skipped.length} skipped`,
  );

  if (result.merged.length > 0) {
    lines.push('');
    lines.push(result.dry_run ? 'WOULD MERGE:' : 'MERGED:');
    for (const m of result.merged) {
      lines.push(`  ${m.phantom}  →  ${m.canonical}  (${m.facts_moved ?? 0} fact${m.facts_moved === 1 ? '' : 's'} moved)`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push('');
    lines.push('SKIPPED:');
    for (const s of result.skipped) {
      lines.push(`  ${s.phantom}  (${s.skipped}${s.canonical ? ` → ${s.canonical}` : ''})`);
    }
  }

  if (result.merged.length === 0 && result.skipped.length === 0) {
    lines.push('');
    lines.push('No phantom entity pages found.');
  }

  return lines.join('\n');
}

// --- CLI entry point ---

export async function runMergePhantoms(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain merge-phantoms [options]

Clean up pre-v0.34.5 phantom unprefixed entity pages by merging their
facts into the canonical resolved target and soft-deleting the phantom.

Options:
  --dry-run            Show what would change without mutating anything
  --source <SOURCE_ID> Source to scan (default: 'default')
  --json               JSON output for scripts / agent consumption
  --help, -h           Show this help

What a phantom is:
  A page whose slug has no directory prefix (no '/') and whose type
  is one of person/company/deal/topic/concept. These were created by
  pre-v0.34.5 versions of writeFactsToFence when resolveEntitySlug
  fell through to slugify on a short bare first name.

What gets merged:
  Facts with entity_slug = <phantom> are repointed to entity_slug =
  <canonical> (the prefix-expansion result). The phantom page is
  soft-deleted via the v0.26.5 destructive-guard machinery and will
  be hard-purged by the autopilot cycle's purge phase after 72h.

Idempotent: running twice produces zero merges on the second pass
because phantoms are already soft-deleted.
`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const sourceIdx = args.indexOf('--source');
  const sourceId =
    sourceIdx >= 0 && args[sourceIdx + 1] && !args[sourceIdx + 1].startsWith('--')
      ? args[sourceIdx + 1]
      : 'default';

  const result = await runMergePhantomsCore(engine, { sourceId, dryRun });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatMergePhantomsText(result));
}
