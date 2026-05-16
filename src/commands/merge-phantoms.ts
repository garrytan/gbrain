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
import {
  tryPrefixExpansion,
  slugify,
  getPrefixExpansionDirs,
  stubBodyChars,
  PHANTOM_STUB_MAX_BODY_CHARS,
} from '../core/entities/resolve.ts';
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
    | 'fence_write_failed'
    | 'not_a_stub'
    | 'ambiguous';
  /**
   * When `skipped === 'ambiguous'`, the list of canonical candidates
   * that matched across multiple directories. Operator picks which
   * one to merge into manually.
   */
  ambiguous_candidates?: string[];
}

// stubBodyChars + PHANTOM_STUB_MAX_BODY_CHARS moved to
// src/core/entities/resolve.ts so resolveEntitySlug can also use the
// stub-detection contract (codex round-8 P2 #2 — the resolver needs
// to distinguish phantom stubs from real top-level pages before
// overriding exact bare slugs). Imported above.

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
 * Search every configured prefix-expansion directory rather than
 * constraining by phantom.type. Codex round-6 P2 #1 flagged the
 * round-4 type-constraint as broken: the pre-fix `stubEntityPage`
 * defaulted unprefixed phantoms to `type: concept`, so a phantom
 * `alice` (real-world: a person) had stored type='concept' and the
 * round-4 fix would only search `concepts/` and skip the canonical
 * `people/alice-example`. The merge command's whole job is to clean
 * up exactly that bug class.
 *
 * Ambiguity protection comes from the search itself: when the same
 * token resolves in multiple directories (e.g. both `people/acme-*`
 * AND `companies/acme-*` exist), the merge skips with `ambiguous`
 * and lists the candidates instead of auto-picking the wrong one.
 * This was round-4's concern; the new path addresses it with a
 * cross-dir tie check rather than a per-phantom type filter.
 */

/**
 * Find candidate phantom unprefixed entity pages. Returns the row plus
 * the full `compiled_truth` so the caller can apply `stubBodyChars()`
 * to distinguish v0.34.5-era stubs (zero chars after stripping the
 * fence content) from user-imported pages with real bodies (codex
 * round-5 P2 + round-6 P2 #2).
 */
export async function listPhantomEntityPages(
  engine: BrainEngine,
  sourceId: string,
): Promise<Array<{ id: number; slug: string; type: string; compiled_truth: string | null }>> {
  return engine.executeRaw<{ id: number; slug: string; type: string; compiled_truth: string | null }>(
    `SELECT id, slug, type, compiled_truth
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

  const dirs = getPrefixExpansionDirs();

  for (const row of phantoms) {
    // Content-size gate (codex round-5 P2 + round-6 P2 #2): skip pages
    // whose body looks like a user-imported entity page rather than a
    // v0.34.5-era stub. We must count BODY chars only (paragraphs +
    // non-fence sections), not the fence payload — round-6 caught
    // that fact-bearing phantoms exceed any total-length threshold.
    if (stubBodyChars(row.compiled_truth) > PHANTOM_STUB_MAX_BODY_CHARS) {
      skipped.push({ phantom: row.slug, canonical: null, skipped: 'not_a_stub' });
      continue;
    }

    // Search EVERY configured directory rather than constraining by
    // the phantom's own type. Pre-fix `stubEntityPage` defaulted all
    // unprefixed phantoms to `type: concept`, so the phantom's type
    // is unreliable for routing decisions (codex round-6 P2 #1).
    //
    // Cross-directory ambiguity protection: if more than one
    // directory has a candidate (e.g. both `people/acme-*` AND
    // `companies/acme-*` exist), skip with `ambiguous` so the
    // operator can decide manually instead of the merge auto-picking
    // the wrong target (codex round-4's original concern, now solved
    // structurally rather than via type-constraint).
    const token = slugify(row.slug);
    const dirCandidates: Array<{ dir: string; canonical: string }> = [];
    if (token) {
      for (const dir of dirs) {
        const hit = await tryPrefixExpansion(engine, opts.sourceId, token, { dirs: [dir] });
        if (hit) dirCandidates.push({ dir, canonical: hit });
      }
    }

    if (dirCandidates.length > 1) {
      skipped.push({
        phantom: row.slug,
        canonical: null,
        skipped: 'ambiguous',
        ambiguous_candidates: dirCandidates.map(c => c.canonical),
      });
      continue;
    }

    const canonical = dirCandidates[0]?.canonical ?? null;

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

    // Read the phantom's active facts via raw SQL so we get ALL of
    // them. listFactsByEntity clamps `limit` at MAX_SEARCH_LIMIT (100),
    // so a phantom with > 100 facts would lose the overflow — codex
    // round-9 P1 #2 caught this: re-fence the first 100, then delete
    // ALL phantom rows (deleteFactsForPage), then soft-delete the
    // phantom. Overflow facts permanently lost. Bypassing the listing
    // API with a raw select avoids the clamp.
    //
    // Columns mirror the FactRow shape so the mapping to
    // FenceInputFact below is direct.
    const phantomFacts = await engine.executeRaw<{
      fact: string;
      kind: 'fact' | 'event' | 'preference' | 'commitment' | 'belief';
      notability: 'high' | 'medium' | 'low';
      source: string;
      context: string | null;
      visibility: 'private' | 'world';
      confidence: number;
      valid_from: Date;
      embedding: Float32Array | null;
      source_session: string | null;
    }>(
      `SELECT fact, kind, notability, source, context, visibility,
              confidence, valid_from, embedding, source_session
         FROM facts
        WHERE source_id = $1
          AND entity_slug = $2
          AND expired_at IS NULL
        ORDER BY id ASC`,
      [opts.sourceId, row.slug],
    );
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
