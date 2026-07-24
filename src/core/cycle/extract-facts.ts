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
 *   4. De-dupes rows by canonical (claim, source) content key.
 *   5. Reconciles the page-scoped DB index: no-op when already in sync,
 *      insert only missing keys when possible, or wipe/reinsert when stale
 *      DB rows need cleanup (#1781 — the unconditional wipe-and-reinsert
 *      made every cycle non-idempotent, re-appending duplicate rows).
 *
 * After the phase, the DB index for every affected page matches the
 * fence's canonical (claim, source) row set (modulo embeddings +
 * runtime-derived fields). Pages with no fence wipe DB rows for that
 * page coordinate only; legacy NULL-source_markdown_slug rows survive
 * because deleteFactsForPage targets source_markdown_slug = slug only.
 *
 * Empty-fence guard (Codex R2-#7; #2484): the phase refuses to do its
 * destructive reconciliation pass when genuinely-backfillable legacy
 * rows still exist — `row_num IS NULL` (never fenced) AND `entity_slug`
 * resolves to a live page in this source (so the v0_32_2 migration's
 * Phase B could fence them). Status returns `warn` with a hint to run
 * `gbrain apply-migrations --yes`. Without the guard, an interrupted
 * upgrade where v0_32_2 hasn't run could leave the cycle silently
 * misreporting "0 facts on people/alice" while legacy rows linger.
 *
 * The live-page requirement (#2484) is load-bearing: the inline facts
 * writer keeps producing `row_num IS NULL, entity_slug IS NOT NULL`
 * rows AFTER the migration completes, whenever a resolved slug has no
 * fenceable page (slugify-floor / stub-guard-blocked unprefixed slugs).
 * Those are structurally unfenceable — no page to fence onto, and the
 * ledger-complete migration won't re-run — so they must NOT gate, or
 * the phase jams forever (~16/day observed). Requiring a backing page
 * keeps genuine pre-v0.32.2 rows (whose entity page exists) gating
 * while excluding the inline-writer's permanent-unfenceable rows.
 */

import type { BrainEngine } from '../engine.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { parseFactsFence } from '../facts-fence.ts';
import {
  extractFactsFromFenceText,
  FENCE_SOURCE_DEFAULT,
  type FenceExtractedFact,
} from '../facts/extract-from-fence.ts';
import {
  runPhantomRedirectPass,
  emptyPhantomPassResult,
  type PhantomPassResult,
} from './phantom-redirect.ts';
import { embed, isAvailable } from '../ai/gateway.ts';
import { isAborted } from '../abort-check.ts';

interface ExistingPageFact {
  fact: string;
  source: string | null;
  row_num: number | string | null;
}

function factContentKey(fact: string, source: string | null | undefined): string {
  return `${fact}\u0000${source ?? FENCE_SOURCE_DEFAULT}`;
}

function dedupeFactsByContentKey(facts: FenceExtractedFact[]): FenceExtractedFact[] {
  const seen = new Set<string>();
  const deduped: FenceExtractedFact[] = [];
  for (const fact of facts) {
    const key = factContentKey(fact.fact, fact.source);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(fact);
  }
  return deduped;
}

/**
 * Fence-owned DB rows for one page coordinate. Excludes `cli:`-origin
 * conversation facts (#1928) — they are not fence-owned, so they must
 * neither count as "stale" (which would force a wipe every cycle) nor
 * be compared against the fence's row set. Mirrors the
 * excludeSourcePrefixes filter deleteFactsForPage applies on the wipe.
 */
async function listExistingFactsForPage(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<ExistingPageFact[]> {
  return engine.executeRaw<ExistingPageFact>(
    `SELECT fact, source, row_num
       FROM facts
      WHERE source_id = $1
        AND source_markdown_slug = $2
        AND COALESCE(source, '') NOT LIKE 'cli:%'
      ORDER BY row_num ASC, id ASC`,
    [sourceId, slug],
  );
}

export interface ExtractFactsOpts {
  /** Subset of slugs to reconcile. undefined = walk every page in the brain. */
  slugs?: string[];
  /** Dry-run: parse + count, no DB writes. */
  dryRun?: boolean;
  /** Optional source_id override for multi-source brains. Default 'default'. */
  sourceId?: string;
  /**
   * v0.35.5 (codex #10): brain directory for the phantom-redirect pre-pass.
   * The phantom handler needs disk access to append migrated fence rows
   * to canonical pages and to unlink phantom `.md` files. When omitted,
   * the phantom-redirect pass is skipped (callers like `gbrain dream`
   * that don't have a brainDir, e.g. headless eval runs, still get the
   * standard fence-reconcile loop).
   */
  brainDir?: string;
  /**
   * #1972: cooperative-abort signal. Checked at the top of the per-page loop,
   * threaded into the phantom-redirect pass's lock-retry + phantom loop, and
   * forwarded to the per-page batch embed — so a long extract_facts bails well
   * under the worker's 30s force-evict instead of running to completion.
   */
  signal?: AbortSignal;
}

export interface ExtractFactsResult {
  pagesScanned: number;
  pagesWithFacts: number;
  factsInserted: number;
  factsDeleted: number;
  legacyRowsPending: number;
  guardTriggered: boolean;
  warnings: string[];
  /** v0.35.5: phantom-redirect pre-pass counts. */
  phantomsScanned: number;
  phantomsRedirected: number;
  phantomsAmbiguous: number;
  phantomsSkippedDrift: number;
  phantomsLockBusy: boolean;
  phantomsMorePending: boolean;
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
    phantomsScanned: 0,
    phantomsRedirected: 0,
    phantomsAmbiguous: 0,
    phantomsSkippedDrift: 0,
    phantomsLockBusy: false,
    phantomsMorePending: false,
  };

  // ── Empty-fence guard (Codex R2-#7; #2484) ─────────────────────
  // Pre-check: if any genuinely-backfillable legacy fact rows exist,
  // refuse to run the destructive reconciliation pass — the v0_32_2
  // orchestrator must fence them first.
  //
  // A row is a real backfill candidate only when `row_num IS NULL`
  // (never fenced) AND its `entity_slug` resolves to a LIVE page in
  // this source (the migration's Phase B only fences rows whose
  // entity_slug maps to a writable page). #2484: the original
  // predicate was just `row_num IS NULL AND entity_slug IS NOT NULL`,
  // which ALSO matched structurally-unfenceable hot-memory rows the
  // inline writer keeps producing post-migration: the legacy DB-only
  // fallback (backstop.ts) writes `entity_slug` (a resolved slug, e.g.
  // a slugify-floor or stub-guard-blocked unprefixed slug like
  // `people-jane-doe`) with `row_num` NULL whenever the slug has no
  // fenceable page. Those rows can never satisfy the migration's exit
  // condition (no page to fence onto, and `apply-migrations` is a
  // ledger-complete no-op for them), so they jammed the phase forever
  // — ~16/day, mislabeled "v0.31 pending backfill." We now require a
  // live backing page, which both genuine pre-v0.32.2 rows (their
  // entity page exists) satisfy and inline-writer unfenceable rows do
  // not.
  const legacy = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM facts f
      WHERE f.row_num IS NULL
        AND f.entity_slug IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pages p
           WHERE p.source_id = f.source_id
             AND p.slug = f.entity_slug
             AND p.deleted_at IS NULL
        )`,
  );
  const legacyCount = parseInt(legacy[0]?.n ?? '0', 10);
  result.legacyRowsPending = legacyCount;
  if (legacyCount > 0) {
    result.guardTriggered = true;
    result.warnings.push(
      `extract_facts: ${legacyCount} legacy v0.31 fact rows (entity page present, not yet ` +
      `fenced) pending fence backfill. Run \`gbrain apply-migrations --yes\` to complete ` +
      `v0_32_2 before this phase can safely reconcile fence → DB.`,
    );
    return result;
  }

  // ── v0.35.5: phantom-redirect pre-pass ──────────────────────────
  //
  // Runs BEFORE the main reconcile loop so canonical pages are consistent
  // (compiled_truth + DB facts + content_hash) by the time the loop visits
  // them. Skipped when brainDir is undefined — the redirect handler needs
  // disk access to write canonical fences and unlink phantom `.md` files.
  // Idempotency-by-construction: phantom predicate filters out `deleted_at
  // IS NOT NULL` so a half-redirected page (soft-deleted, .md still on
  // disk) won't be re-redirected.
  let phantomResult: PhantomPassResult = emptyPhantomPassResult();
  if (opts.brainDir) {
    try {
      phantomResult = await runPhantomRedirectPass(
        engine,
        opts.brainDir,
        sourceId,
        opts.dryRun ?? false,
        opts.signal,
      );
    } catch (e) {
      // The pass owns its own per-phantom try/catch; reaching this catch
      // means the lock acquisition or the over-arching SQL query failed.
      // Surface as a warning, leave counters zero — main reconcile continues.
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`phantom_redirect_pass_failed: ${msg.slice(0, 200)}`);
    }
  }
  result.phantomsScanned = phantomResult.scanned;
  result.phantomsRedirected = phantomResult.redirected;
  result.phantomsAmbiguous = phantomResult.ambiguous;
  result.phantomsSkippedDrift = phantomResult.skipped_drift;
  result.phantomsLockBusy = phantomResult.lock_busy;
  result.phantomsMorePending = phantomResult.more_pending;

  // ── Resolve target slug set ───────────────────────────────────
  // v0.36.x #1096: presence — not length — distinguishes the modes.
  // `slugs: []` from an incremental sync no-op was previously treated
  // identically to `slugs: undefined` (full-walk intent) because
  // `opts.slugs && opts.slugs.length > 0` is falsy for both. On a
  // multi-thousand-page brain the unintended full walk exceeds the
  // autopilot-cycle timeout (~600s) and dead-letters the job.
  let slugs: string[];
  if (opts.slugs !== undefined) {
    // Caller explicitly passed a list (possibly empty). Empty array is a
    // real incremental no-op; don't escalate to full-brain walk.
    slugs = opts.slugs;
  } else {
    // Full walk: every page in the brain. Bounded by engine.getAllSlugs
    // which is already the precedent for full-extract paths.
    const allSlugs = await engine.getAllSlugs();
    slugs = Array.from(allSlugs);
  }
  // v0.35.5: union the canonicals touched by the phantom-redirect pass
  // so their DB facts get reconciled from the just-merged disk fence.
  // Without this, an incremental-mode cycle with phantom-but-not-canonical
  // in opts.slugs would leave canonical's DB facts stale until next full
  // walk (codex A1 — the round-14 risk specialized to scenario B).
  if (phantomResult.touched_canonicals.length > 0) {
    const slugSet = new Set(slugs);
    for (const c of phantomResult.touched_canonicals) slugSet.add(c);
    slugs = Array.from(slugSet);
  }

  // ── Reconcile each page ───────────────────────────────────────
  for (const slug of slugs) {
    // #1972: bail at the top of the per-page loop on abort. Each page is an
    // independent delete-then-insert commit, so breaking leaves a consistent
    // partial state; the receipt/rollup below still runs with partial counts.
    if (isAborted(opts.signal)) break;
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

    // v0.35.4 (D-ENG-1) — thread page.effective_date as the fallback
    // valid_from. Without this, fence rows without explicit `validFrom:`
    // land with `valid_from = now()` (import timestamp) and every
    // trajectory query against the page returns import dates instead of
    // claim dates.
    const pageEffectiveDate = page.effective_date ? new Date(page.effective_date) : null;
    const extracted = dedupeFactsByContentKey(
      extractFactsFromFenceText(parsed.facts, slug, sourceId, { pageEffectiveDate }),
    );

    if (opts.dryRun) continue;

    // #1781 — reconcile instead of unconditional wipe-and-reinsert. Compare
    // the fence's canonical (claim, source) row set against the page's
    // fence-owned DB rows: no-op when already in sync, insert only missing
    // keys when possible, wipe/reinsert only when stale rows need cleanup.
    const existing = await listExistingFactsForPage(engine, slug, sourceId);
    const existingKeys = new Set(existing.map(f => factContentKey(f.fact, f.source)));
    const desiredByKey = new Map(extracted.map(f => [factContentKey(f.fact, f.source), f]));

    if (extracted.length === 0) {
      if (existing.length > 0) {
        // The delete targets source_markdown_slug = slug only, so
        // NULL-source_markdown_slug legacy rows survive (the
        // partial-UNIQUE-index keyspace). #1928: `cli:`-origin facts
        // (conversation facts from extract-conversation-facts) are NOT
        // fence-owned — the page carries no `## Facts` fence to recreate
        // them — so they MUST survive this reconcile.
        const deleted = await engine.deleteFactsForPage(slug, sourceId, {
          excludeSourcePrefixes: ['cli:'],
        });
        result.factsDeleted += deleted.deleted;
      }
      continue;
    }

    const hasStaleExisting = existing.some(f => !desiredByKey.has(factContentKey(f.fact, f.source)));
    const hasDuplicateExisting = existing.length !== existingKeys.size;
    const hasRowNumDrift = existing.some(f => {
      const desired = desiredByKey.get(factContentKey(f.fact, f.source));
      return desired !== undefined && Number(f.row_num) !== desired.row_num;
    });

    if (
      existing.length === extracted.length &&
      !hasStaleExisting &&
      !hasDuplicateExisting &&
      !hasRowNumDrift
    ) {
      continue;
    }

    let toInsert = extracted.filter(f => !existingKeys.has(factContentKey(f.fact, f.source)));
    if (hasStaleExisting || hasDuplicateExisting || hasRowNumDrift) {
      // Fall back to the legacy page-level reconcile when old DB rows must
      // be removed. Same delete scoping as above: legacy
      // NULL-source_markdown_slug rows and `cli:`-origin conversation
      // facts (#1928) survive.
      const deleted = await engine.deleteFactsForPage(slug, sourceId, {
        excludeSourcePrefixes: ['cli:'],
      });
      result.factsDeleted += deleted.deleted;
      toInsert = extracted;
    }

    // v0.35.4 (D-CDX-3) — batch-embed before insert. Without this,
    // cycle-inserted facts land with `embedding = NULL`, which breaks
    // consolidate's cosine clustering AND the drift_score formula in
    // find_trajectory. Falls open: if the embedding gateway is
    // unavailable (no API key configured), facts still insert with
    // NULL embeddings — drift_score gracefully returns null and
    // clustering falls back to recency.
    if (isAvailable('embedding') && toInsert.length > 0) {
      try {
        const texts = toInsert.map(e => e.fact);
        // #1972: forward the abort signal so a cancelled cycle's in-flight
        // batch embed (a network call) is itself abortable, not just the loop.
        const embeddings = await embed(texts, { abortSignal: opts.signal });
        // Defensive: embed should return one vector per input; if the
        // gateway returns a partial array (provider partial-batch retry
        // returning fewer than requested), only fill what we have.
        for (let i = 0; i < toInsert.length && i < embeddings.length; i++) {
          toInsert[i].embedding = embeddings[i];
        }
      } catch (err) {
        // Embedding failure is non-fatal — facts still get inserted, just
        // without embeddings. Cycle phase status stays 'ok'.
        result.warnings.push(
          `${slug}: extract_facts batch embed failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (toInsert.length === 0) continue;

    const inserted = await engine.insertFacts(toInsert, { source_id: sourceId }); // gbrain-allow-direct-insert: extract_facts cycle phase reconciles fence → DB
    result.factsInserted += inserted.inserted;
  }

  // v0.42 Wave B3: receipt + rollup. extract_facts is deterministic
  // (fence reconcile, no LLM cost); receipt only when facts were
  // actually inserted; rollup always fires.
  if (!opts.dryRun && result.factsInserted > 0) {
    const runId = `efacts-${Date.now().toString(36)}-${sourceId.slice(0, 4)}`;
    try {
      await writeReceipt(engine, {
        kind: 'facts.fence',
        source_id: sourceId,
        run_id: runId,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: result.factsInserted,
        cost_usd: 0,
        summary:
          `Reconciled ${result.factsInserted} facts (and deleted ${result.factsDeleted}) ` +
          `across ${result.pagesScanned} scanned pages.`,
      });
    } catch (err) {
      console.error(`[extract_facts] receipt write failed: ${(err as Error).message}`);
    }
  }
  if (!opts.dryRun) {
    await upsertExtractRollup(engine, {
      kind: 'facts.fence',
      source_id: sourceId,
      cost_delta: 0,
      round_completed_delta: result.guardTriggered ? 0 : 1,
      halt_delta: result.guardTriggered ? 1 : 0,
    });
  }

  return result;
}
