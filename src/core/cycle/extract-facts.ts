/**
 * v0.32.2 — extract_facts cycle phase.
 *
 * Reconciles the facts DB index from the `## Facts` fence on each
 * entity page. Runs between the `extract` phase (which materializes
 * links + timeline) and `recompute_emotional_weight` so emotional
 * weight sees fresh take + fact state.
 *
 * Source-of-truth contract: the fence is canonical. For each page in
 * the affected slug set, this phase:
 *   1. Reads the markdown body (DB-side fetch via engine.getPage).
 *   2. Parses the `## Facts` fence with parseFactsFence.
 *   3. Maps ParsedFact → FenceExtractedFact via extractFactsFromFenceText.
 *   4. Wipes the page's DB index via deleteFactsForPage.
 *   5. Re-inserts via engine.insertFacts batch.
 *
 * After the phase, the DB index for every affected page byte-matches
 * the fence (modulo embeddings + runtime-derived fields). Pages with
 * no fence go through delete-then-empty-insert — DB rows for that
 * page coordinate are wiped; legacy NULL-source_markdown_slug rows
 * survive because deleteFactsForPage targets source_markdown_slug =
 * slug only.
 *
 * Empty-fence guard (Codex R2-#7): the phase refuses to do its
 * destructive reconciliation pass when legacy rows (row_num IS NULL,
 * entity_slug IS NOT NULL) still exist in the brain — they're the
 * v0.31 hot-memory facts pending the v0_32_2 backfill. Status returns
 * `warn` with a hint to run `gbrain apply-migrations --yes`. Without
 * the guard, an interrupted upgrade where v0_32_2 hasn't run could
 * leave the cycle silently misreporting "0 facts on people/alice"
 * while legacy rows linger in the DB.
 */

import type { BrainEngine } from '../engine.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import { embed, isAvailable } from '../ai/gateway.ts';

export interface ExtractFactsOpts {
  /** Subset of slugs to reconcile. undefined = walk every page in the brain. */
  slugs?: string[];
  /** Dry-run: parse + count, no DB writes. */
  dryRun?: boolean;
  /** Optional source_id override for multi-source brains. Default 'default'. */
  sourceId?: string;
}

export interface ExtractFactsResult {
  pagesScanned: number;
  pagesWithFacts: number;
  factsInserted: number;
  factsDeleted: number;
  legacyRowsPending: number;
  guardTriggered: boolean;
  warnings: string[];
}

/**
 * Run the extract_facts phase against the current brain state. Returns
 * an ExtractFactsResult envelope; status mapping (ok / warn / fail)
 * happens in the cycle.ts caller.
 */
export async function runExtractFacts(
  engine: BrainEngine,
  opts: ExtractFactsOpts = {},
): Promise<ExtractFactsResult> {
  const sourceId = opts.sourceId ?? 'default';
  const result: ExtractFactsResult = {
    pagesScanned: 0,
    pagesWithFacts: 0,
    factsInserted: 0,
    factsDeleted: 0,
    legacyRowsPending: 0,
    guardTriggered: false,
    warnings: [],
  };

  // ── Empty-fence guard (Codex R2-#7) ────────────────────────────
  // Pre-check: if any legacy fact rows exist (row_num NULL but
  // entity_slug NOT NULL), refuse to run the destructive
  // reconciliation pass. The v0_32_2 orchestrator must complete
  // first.
  const legacy = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n FROM facts WHERE row_num IS NULL AND entity_slug IS NOT NULL`,
  );
  const legacyCount = parseInt(legacy[0]?.n ?? '0', 10);
  result.legacyRowsPending = legacyCount;
  if (legacyCount > 0) {
    result.guardTriggered = true;
    result.warnings.push(
      `extract_facts: ${legacyCount} legacy v0.31 fact rows pending fence backfill. ` +
      `Run \`gbrain apply-migrations --yes\` to complete v0_32_2 before this phase ` +
      `can safely reconcile fence → DB.`,
    );
    return result;
  }

  // ── Resolve target slug set ───────────────────────────────────
  let slugs: string[];
  if (opts.slugs && opts.slugs.length > 0) {
    slugs = opts.slugs;
  } else {
    // Full walk: every page in the brain. Bounded by engine.getAllSlugs
    // which is already the precedent for full-extract paths.
    const allSlugs = await engine.getAllSlugs();
    slugs = Array.from(allSlugs);
  }

  // ── Reconcile each page ───────────────────────────────────────
  for (const slug of slugs) {
    result.pagesScanned += 1;

    const page = await engine.getPage(slug, { sourceId });
    if (!page) {
      // Slug listed but not in DB — skip silently. The next cycle
      // will pick it up if it exists.
      continue;
    }

    const body = page.compiled_truth ?? '';
    const parsed = parseFactsFence(body);
    if (parsed.warnings.length > 0) {
      result.warnings.push(
        ...parsed.warnings.map(w => `${slug}: ${w}`),
      );
    }

    if (parsed.facts.length > 0) result.pagesWithFacts += 1;

    if (opts.dryRun) continue;

    // Wipe-and-reinsert per page. The deleteFactsForPage call targets
    // source_markdown_slug = slug only, so NULL-source_markdown_slug
    // legacy rows survive (the partial-UNIQUE-index keyspace).
    const deleted = await engine.deleteFactsForPage(slug, sourceId);
    result.factsDeleted += deleted.deleted;

    if (parsed.facts.length === 0) continue;

    // v0.35.4 (D-ENG-1) — thread page.effective_date as the fallback
    // valid_from. Without this, fence rows without explicit `validFrom:`
    // land with `valid_from = now()` (import timestamp) and every
    // trajectory query against the page returns import dates instead of
    // claim dates.
    const pageEffectiveDate = page.effective_date ? new Date(page.effective_date) : null;
    const extracted = extractFactsFromFenceText(parsed.facts, slug, sourceId, { pageEffectiveDate });

    // v0.35.4 (D-CDX-3) — batch-embed before insert. Without this,
    // cycle-inserted facts land with `embedding = NULL`, which breaks
    // consolidate's cosine clustering AND the drift_score formula in
    // find_trajectory. Falls open: if the embedding gateway is
    // unavailable (no API key configured), facts still insert with
    // NULL embeddings — drift_score gracefully returns null and
    // clustering falls back to recency.
    if (isAvailable('embedding') && extracted.length > 0) {
      try {
        const texts = extracted.map(e => e.fact);
        const embeddings = await embed(texts);
        // Defensive: embed should return one vector per input; if the
        // gateway returns a partial array (provider partial-batch retry
        // returning fewer than requested), only fill what we have.
        for (let i = 0; i < extracted.length && i < embeddings.length; i++) {
          extracted[i].embedding = embeddings[i];
        }
      } catch (err) {
        // Embedding failure is non-fatal — facts still get inserted, just
        // without embeddings. Cycle phase status stays 'ok'.
        result.warnings.push(
          `${slug}: extract_facts batch embed failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const inserted = await engine.insertFacts(extracted, { source_id: sourceId }); // gbrain-allow-direct-insert: extract_facts cycle phase reconciles fence → DB
    result.factsInserted += inserted.inserted;
  }

  return result;
}
