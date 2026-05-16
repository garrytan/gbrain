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
 * This command reads existing unprefixed entity pages, finds a
 * canonical target via prefix expansion, RE-FENCES the phantom's active
 * facts into the canonical page's `## Facts` fence (so the rows land
 * with proper `source_markdown_slug` + `row_num` pointing at the
 * canonical, not the soft-deleted phantom), then soft-deletes the
 * phantom.
 *
 * Per codex P2 in /codex review: a naive UPDATE that moves only
 * `entity_slug` leaves rows with `source_markdown_slug = phantom`,
 * which subsequent extract_facts cycle phases would wipe (the cycle
 * deletes rows keyed on the phantom's slug). The re-fence path mirrors
 * the v0.32.2 "fence is canonical" contract — the canonical page's
 * markdown becomes the source of truth, the DB index follows.
 *
 * Operator-only. Not exposed as an MCP op — destructive operations
 * stay CLI-only until there's a clear remote use case.
 *
 *   gbrain merge-phantoms [--dry-run] [--source SOURCE_ID] [--json]
 *
 * Algorithm:
 *   1. List phantom unprefixed entity pages.
 *   2. For each row, call tryPrefixExpansion to find a canonical
 *      target. Skip when no canonical exists.
 *   3. listFactsByEntity(phantom_slug, activeOnly=true) — get the
 *      facts that need migration.
 *   4. Build FenceInputFact[] preserving fact text, kind, notability,
 *      visibility, source, source_session, confidence, embedding.
 *   5. writeFactsToFence(canonical, inputFacts) — appends the facts
 *      to the canonical's markdown fence and inserts new DB rows with
 *      source_markdown_slug=canonical + proper row_nums.
 *   6. deleteFactsForPage(phantom_slug) wipes post-v0.32.2 phantom
 *      rows. A raw DELETE handles pre-v0.32.2 NULL-source_markdown_slug
 *      rows attached to the phantom by entity_slug.
 *   7. softDeletePage the phantom (autopilot cycle's purge phase
 *      hard-purges after 72h).
 *
 * `--dry-run` prints what would happen without mutating anything.
 *
 * Plan: ~/.claude/plans/mossy-popping-crown.md D7 + D9 (codex P2).
 */

import type { BrainEngine } from '../core/engine.ts';
import { tryPrefixExpansion, slugify } from '../core/entities/resolve.ts';
import { writeFactsToFence, lookupSourceLocalPath, type FenceInputFact } from '../core/facts/fence-write.ts';

/** Phantom-resolution outcome for one row. */
export interface PhantomMerge {
  phantom: string;
  canonical: string | null;
  /** Set when the merge fired. */
  facts_moved?: number;
  /** Set when the row was skipped. */
  skipped?:
    | 'no_canonical'
    | 'canonical_equals_phantom'
    | 'canonical_unprefixed'
    | 'canonical_missing'
    | 'no_local_path'
    | 'fence_write_failed';
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
 * 1:1 map from entity type to the slug directory that holds canonical
 * pages for that type. The merge command uses this to constrain the
 * prefix-expansion search — without it, a phantom `acme` of type
 * 'company' could resolve to `people/acme-example` (because `people`
 * is first in DEFAULT_PREFIX_EXPANSION_DIRS) and the company facts
 * would land on a person's page. Codex flagged this as a data-
 * correctness P1 in the round-4 review.
 *
 * Type-to-dir is intentionally a constant map, not config-driven:
 * the page type column IS the type system. If a user has custom
 * `type: fund` pages under `funds/`, they extend this map plus
 * extend `ENTITY_TYPES`. Cross-cutting feature; out of scope for
 * the v0.34.5 fix wave.
 */
const TYPE_TO_DIR: Record<string, string> = {
  person: 'people',
  company: 'companies',
  deal: 'deals',
  topic: 'topics',
  concept: 'concepts',
};

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
    // and short-circuit before reaching prefix expansion.
    //
    // Type-constrained search (codex round-4 P1): pass exactly the
    // directory that matches the phantom's page type, so a `company`
    // phantom 'acme' can only resolve into `companies/`, not `people/`.
    // Otherwise the global dir order would let person + company facts
    // mismerge onto each other.
    const token = slugify(row.slug);
    const targetDir = TYPE_TO_DIR[row.type];
    const canonical =
      token && targetDir
        ? await tryPrefixExpansion(engine, opts.sourceId, token, { dirs: [targetDir] })
        : null;

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

    // Read the phantom's active facts. listFactsByEntity defaults to
    // activeOnly=true, which is what we want — expired/strikethrough
    // facts stay on the phantom (it gets soft-deleted, hard-purged in
    // 72h, taking the historical record with it). Active facts are
    // what the user cares about migrating.
    const phantomFacts = await engine.listFactsByEntity(opts.sourceId, row.slug, {
      activeOnly: true,
      limit: 10_000,
    });
    const facts_moved = phantomFacts.length;

    // Feasibility check BEFORE the dry-run short-circuit (codex round-4
    // P2): a phantom that has facts but lives in a source with no
    // local_path can't be re-fenced. Dry-run must report the same
    // skip the real run would produce, or the operator preview is
    // misleading.
    if (facts_moved > 0) {
      const localPathPreview = await lookupSourceLocalPath(engine, opts.sourceId);
      if (localPathPreview === null) {
        skipped.push({ phantom: row.slug, canonical, skipped: 'no_local_path' });
        continue;
      }
    }

    if (opts.dryRun) {
      merged.push({ phantom: row.slug, canonical, facts_moved });
      continue;
    }

    if (facts_moved === 0) {
      // Phantom with no facts to migrate — just soft-delete it.
      await engine.softDeletePage(row.slug, { sourceId: opts.sourceId });
      merged.push({ phantom: row.slug, canonical, facts_moved: 0 });
      continue;
    }

    // Re-fence into canonical's `## Facts` fence (codex P2 fix).
    // Re-fetch localPath (already known to be non-null from the
    // feasibility check above, but the type narrowing was scoped to
    // that block).
    const localPath = await lookupSourceLocalPath(engine, opts.sourceId);
    if (localPath === null) {
      // Defensive: should be unreachable since we already passed the
      // feasibility check above. Kept so type narrowing works.
      skipped.push({ phantom: row.slug, canonical, skipped: 'no_local_path' });
      continue;
    }

    const inputFacts: FenceInputFact[] = phantomFacts.map(fr => ({
      fact: fr.fact,
      kind: fr.kind,
      notability: fr.notability,
      source: fr.source,
      context: fr.context,
      visibility: fr.visibility,
      confidence: fr.confidence,
      validFrom: fr.valid_from,
      embedding: fr.embedding,
      sessionId: fr.source_session,
    }));

    const fenceResult = await writeFactsToFence(
      engine,
      { sourceId: opts.sourceId, localPath, slug: canonical },
      inputFacts,
    );

    if (fenceResult.fenceWriteFailed || fenceResult.stubGuardBlocked) {
      // Neither should fire here in practice — canonical has a
      // directory prefix so stub-guard is structurally impossible, and
      // the canonical fence is the writer's existing canonical state.
      // If something goes wrong, log+skip so we don't double-delete
      // facts the canonical doesn't own.
      skipped.push({ phantom: row.slug, canonical, skipped: 'fence_write_failed' });
      continue;
    }

    // Wipe the phantom's rows. Two delete passes cover both eras:
    //   - deleteFactsForPage targets source_markdown_slug = phantom
    //     (post-v0.32.2 phantom rows).
    //   - The raw DELETE catches pre-v0.32.2 NULL-source_markdown_slug
    //     rows attached to the phantom via entity_slug.
    await engine.deleteFactsForPage(row.slug, opts.sourceId);
    await engine.executeRaw(
      `DELETE FROM facts
        WHERE source_id = $1
          AND entity_slug = $2
          AND source_markdown_slug IS NULL`,
      [opts.sourceId, row.slug],
    );

    // Soft-delete the phantom page; autopilot's purge phase hard-purges
    // after 72h.
    await engine.softDeletePage(row.slug, { sourceId: opts.sourceId });

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
