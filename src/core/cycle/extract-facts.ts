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
 * After the phase, the DB index for every cleanly parsed affected page
 * matches the fence's canonical (claim, source) row set (modulo embeddings
 * + runtime-derived fields). Warning-bearing parses are non-authoritative
 * and preserve that page's existing index. Pages with no fence wipe DB rows
 * for that page coordinate only; legacy NULL-source_markdown_slug rows
 * survive because deleteFactsForPage targets source_markdown_slug = slug only.
 *
 * Empty-fence guard (Codex R2-#7; #2484; #2646): the phase refuses to do
 * its destructive reconciliation pass when genuinely-backfillable legacy
 * rows still exist — in THIS run's source only (`source_id = sourceId`;
 * a pending row in source A must not jam extraction for source B — the
 * source-isolation invariant) — `row_num IS NULL` (never fenced) AND
 * `entity_slug` resolves to a live page in this source (so the v0_32_2
 * migration's Phase B could fence them) AND the row is not soft-expired
 * (`expired_at IS NULL`). Status returns `warn` with a hint to re-run
 * the v0.32.2 fence backfill (`apply-migrations --force-retry 0.32.2`
 * then `--yes` — a bare `--yes` is a no-op once the ledger says
 * complete). Without the guard, an interrupted upgrade where v0_32_2
 * hasn't run could leave the cycle silently misreporting "0 facts on
 * people/alice" while legacy rows linger.
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
 *
 * Soft-expired rows don't count either (#2646): they're what
 * `forget_fact` produces, so excluding them lets operators drain the
 * backlog through the sanctioned removal path instead of raw SQL.
 */

import type { BrainEngine } from '../engine.ts';
import { resolveSupersededByRow, type SupersedeTarget } from '../facts/supersede-resolve.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { parseFactsFence, FACTS_FENCE_BEGIN } from '../facts-fence.ts';
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
  // v0.46 (#3014) — the row's own fact id. Read so the supersession-drift
  // check can compare the DB's stored `superseded_by` (a fact id) against
  // the fence reference re-resolved to the target row's current id.
  id: number | string;
  fact: string;
  source: string | null;
  row_num: number | string | null;
  // v0.46 (#3014) — supersession columns, read so a struck row whose
  // fence says "superseded" but whose DB columns are still NULL counts as
  // drifted and re-heals through the wipe+reinsert fallback.
  superseded_by: number | string | null;
  expired_at: Date | string | null;
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
 *
 * Also excludes soft-expired legacy rows (#2646: `row_num IS NULL AND
 * expired_at IS NOT NULL`) — rows that `forget_fact` expired via its
 * legacy DB-only path. They are not fence-owned (fence rows always
 * carry a row_num), so they must neither count as "stale" (forcing a
 * wipe every cycle) nor mask a fence row from insertion. Mirrors the
 * preserveExpiredLegacy filter deleteFactsForPage applies on the wipe.
 *
 * Deliberate consequence: if the fence still carries the same
 * (claim, source) as an expired legacy row, the reconcile inserts it
 * as a fresh ACTIVE fence-owned row. That is the fence-is-canonical
 * contract working as documented — legacy DB-only forgets "DO NOT
 * survive rebuild" (see forget.ts header); suppressing the insert
 * would instead create silent fence↔DB divergence, the exact failure
 * mode the empty-fence guard exists to prevent. To durably forget
 * such a claim, forget the fence-owned row (forget_fact now takes the
 * fence path, which strikes the row through in markdown). The expired
 * legacy row survives alongside as the record of the earlier forget.
 */
async function listExistingFactsForPage(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<ExistingPageFact[]> {
  return engine.executeRaw<ExistingPageFact>(
    `SELECT id, fact, source, row_num, superseded_by, expired_at
       FROM facts
      WHERE source_id = $1
        AND source_markdown_slug = $2
        AND COALESCE(source, '') NOT LIKE 'cli:%'
        AND NOT (row_num IS NULL AND expired_at IS NOT NULL)
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
 * #3625 (adversarial review, 2 rounds): whether `timeline` contains a
 * GENUINE Facts fence marker, as opposed to the marker text merely being
 * mentioned inside a fenced code example or quoted prose. A naive
 * `.includes(FACTS_FENCE_BEGIN)` false-positives on both — e.g. a page
 * whose real fence WAS removed, but whose timeline documents the fence
 * syntax in a ```markdown code block or a `> ...` blockquote, would wrongly
 * be treated as "misplaced" and block a genuine deletion, leaving stale
 * facts indexed indefinitely.
 *
 * Round 1 tried reusing fence-scan.ts's scanFencedBlocks() + string removal
 * of its extracted fence bodies. Round-2 adversarial review broke that:
 * scanFencedBlocks normalizes line endings (splits on `\r\n|\r|\n`, joins
 * fence bodies with plain `\n`) and strips opener indentation before
 * returning fence text — so `stripped.split(fenceText).join('')` on the
 * ORIGINAL (un-normalized) string silently fails to match a CRLF or
 * indented code block, leaving the marker inside it undetected and still
 * false-positive. Reconstructed-text removal can't safely undo a lossy
 * normalization.
 *
 * Fix: a self-contained single-pass line scanner (mirroring fence-scan.ts's
 * own CommonMark-subset opener/closer grammar, applied directly against
 * `timeline.split(/\r\n|\r|\n/)` — ONE split, no re-normalization, no
 * text-based removal) that skips lines between a real ``` /~~~ opener and
 * its closer, then checks whether any remaining line, trimmed, exactly
 * equals the marker. A real fence marker is always written as its own line
 * (see FENCE_BODY-shaped output from fence-write.ts / upsertFactRow), so
 * exact-line-match — on lines outside any code fence — rules out both
 * hazards without needing a full markdown AST (mirrors
 * findTimelineSplitIndex's own `trimmed === sentinel` pattern for the same
 * class of problem on the timeline sentinel itself). An unclosed opener
 * runs to EOF (matches fence-scan.ts's documented behavior) — a marker
 * appearing after it is inside an ambiguous, unclosed block and is not
 * trusted as genuine.
 */
function timelineHasGenuineFactsFenceMarker(timeline: string): boolean {
  if (!timeline.includes(FACTS_FENCE_BEGIN)) return false;
  const lines = timeline.split(/\r\n|\r|\n/);
  const OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = OPEN_RE.exec(line);
    if (open) {
      const marker = open[1]!;
      const fenceChar = marker[0]!;
      const info = open[2]!.trim();
      // Mirrors fence-scan.ts: a backtick opener whose info string contains
      // a backtick is inline code, not a fence opener.
      if (!(fenceChar === '`' && info.includes('`'))) {
        let j = i + 1;
        for (; j < lines.length; j++) {
          const close = CLOSE_RE.exec(lines[j]!);
          if (close && close[1]![0] === fenceChar && close[1]!.length >= marker.length) {
            j++;
            break;
          }
        }
        i = j; // unclosed fence: j reaches lines.length, ending the scan
        continue;
      }
    }
    if (line.trim() === FACTS_FENCE_BEGIN) return true;
    i++;
  }
  return false;
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

  // ── Empty-fence guard (Codex R2-#7; #2484; #2646) ──────────────
  // Pre-check: if any genuinely-backfillable legacy fact rows exist,
  // refuse to run the destructive reconciliation pass — the v0_32_2
  // orchestrator must fence them first.
  //
  // A row is a real backfill candidate only when `row_num IS NULL`
  // (never fenced) AND its `entity_slug` resolves to a LIVE page in
  // this source (the migration's Phase B only fences rows whose
  // entity_slug maps to a writable page) AND it is not soft-expired.
  // #2484: the original predicate was just `row_num IS NULL AND
  // entity_slug IS NOT NULL`, which ALSO matched
  // structurally-unfenceable hot-memory rows the inline writer keeps
  // producing post-migration: the legacy DB-only fallback
  // (backstop.ts) writes `entity_slug` (a resolved slug, e.g. a
  // slugify-floor or stub-guard-blocked unprefixed slug like
  // `people-jane-doe`) with `row_num` NULL whenever the slug has no
  // fenceable page. Those rows can never satisfy the migration's exit
  // condition (no page to fence onto, and `apply-migrations` is a
  // ledger-complete no-op for them), so they jammed the phase forever
  // — ~16/day, mislabeled "v0.31 pending backfill." We now require a
  // live backing page, which both genuine pre-v0.32.2 rows (their
  // entity page exists) satisfy and inline-writer unfenceable rows do
  // not. #2646: soft-expired rows (`expired_at IS NOT NULL`) are also
  // excluded — `forget_fact`, the officially sanctioned removal path,
  // soft-expires legacy rows rather than deleting them, so counting
  // expired rows would leave the guard permanently stuck with no
  // supported way to drain the backlog.
  //
  // Source isolation (#3526): the count is scoped to THIS run's
  // sourceId. The pre-fix query counted brain-wide, so a single pending
  // legacy row in any mounted source jammed extract_facts for every
  // source — a cross-source leak of one source's migration state into
  // another's cycle (CLAUDE.md source-isolation invariant).
  //
  // #2763: the count also requires the source to have a `local_path` —
  // mirroring the v0_32_2 Phase B fenceability rule (its backfill SKIPS
  // rows whose source has no local_path, `skipped_no_local_path`, yet
  // still returns complete). On a thin-client / DB-only source the
  // backstop writer keeps producing row_num-NULL rows whose entity_slug
  // maps to a LIVE page; without the local_path check those rows
  // tripped the guard forever with drain advice (`apply-migrations
  // --force-retry 0.32.2`) that is a structural no-op for them.
  const legacy = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM facts f
      WHERE f.source_id = $1
        AND f.row_num IS NULL
        AND f.entity_slug IS NOT NULL
        AND f.expired_at IS NULL
        AND EXISTS (
          SELECT 1 FROM pages p
           WHERE p.source_id = f.source_id
             AND p.slug = f.entity_slug
             AND p.deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM sources s
           WHERE s.id = f.source_id
             AND s.local_path IS NOT NULL
        )`,
    [sourceId],
  );
  const legacyCount = parseInt(legacy[0]?.n ?? '0', 10);
  result.legacyRowsPending = legacyCount;
  if (legacyCount > 0) {
    result.guardTriggered = true;
    // Drain advice must actually work: a bare `apply-migrations --yes`
    // is a no-op once the v0.32.2 ledger entry says complete (the
    // runner classifies it as already-applied), so the sanctioned
    // re-run path is the explicit retry marker first. Phase B is
    // idempotent — it only touches `row_num IS NULL` rows and de-dupes
    // against the existing fence — so the re-run is safe. Individual
    // rows can instead be drained through `forget_fact` (soft-expired
    // rows stop counting).
    result.warnings.push(
      `extract_facts: ${legacyCount} legacy v0.31 fact rows in source "${sourceId}" ` +
      `(entity page present, not yet fenced) pending fence backfill. Re-run the v0.32.2 ` +
      `fence backfill: \`gbrain apply-migrations --force-retry 0.32.2\` then ` +
      `\`gbrain apply-migrations --yes\`. Or drain individual rows via \`forget_fact\`.`,
    );
    // #3683: book the halt BEFORE the early return. The end-of-run rollup
    // write below is unreachable from this path, so pre-fix a guard-triggered
    // run recorded NOTHING in extract_rollup_7d — halt_count was structurally
    // 0 and doctor extract_health's `halt_rate > 10%` warning could never
    // fire for facts.fence no matter how long the phase stayed jammed.
    // upsertExtractRollup is best-effort internally (never throws).
    if (!opts.dryRun) {
      await upsertExtractRollup(engine, {
        kind: 'facts.fence',
        source_id: sourceId,
        cost_delta: 0,
        round_completed_delta: 0,
        halt_delta: 1,
      });
    }
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
      // The parser deliberately skips malformed rows and returns any rows it
      // could still recover. That partial result is not authoritative: using
      // it for reconciliation would interpret skipped rows as deletions.
      // Preserve this page's existing index and continue with other pages.
      continue;
    }

    // #3625: splitBody() puts everything below the timeline sentinel into
    // page.timeline, not compiled_truth — a `## Facts` fence written there
    // (agent-composed bodies commonly append it at the bottom) is invisible
    // to the parseFactsFence(body) call above. Without this check,
    // parsed.facts.length === 0 reads as "the user deleted the fence" and
    // the block below prunes every previously-indexed row for the page —
    // when the fence is actually just misplaced, not absent. Distinguish
    // the two by checking whether a fence marker ALSO landed in
    // page.timeline: if so, the page is non-authoritative — malformed
    // placement (loud warning, preserve the existing index), never treated
    // as absence (destructive delete). Checked unconditionally on
    // parsed.facts.length (not just when it's 0): a page can have a valid
    // fence above the sentinel AND a stray/duplicate one below it (e.g. a
    // partial hand-edit), in which case parsed.facts.length > 0 but
    // reconciling from compiled_truth alone would still misread the
    // below-sentinel rows as deleted. Uses timelineHasGenuineFactsFenceMarker
    // rather than a raw .includes() (adversarial review finding: the naive
    // substring check false-positives on the marker text merely being
    // mentioned in a doc code-block or quoted prose, wrongly blocking a
    // genuine deletion and leaving stale facts indexed indefinitely).
    if (timelineHasGenuineFactsFenceMarker(page.timeline ?? '')) {
      result.warnings.push(
        `${slug}: FACTS_FENCE_BELOW_SENTINEL: a ## Facts fence was found below ` +
        `the <!-- timeline --> sentinel, where extract_facts cannot see it. ` +
        `Move the fence above the sentinel and re-save — leaving it in place ` +
        `preserves the existing indexed facts but they will not update.`,
      );
      continue;
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
        // them — so they MUST survive this reconcile. #2646: soft-expired
        // legacy rows (forget_fact's record of the forget) likewise
        // survive via preserveExpiredLegacy.
        const deleted = await engine.deleteFactsForPage(slug, sourceId, {
          excludeSourcePrefixes: ['cli:'],
          preserveExpiredLegacy: true,
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
    // v0.46 (#3014) — a struck row whose fence says "superseded" (or
    // otherwise inactive) but whose DB columns are still NULL has an
    // identical content key + row_num, so the checks above miss it. Treat
    // a mismatch between the fence-desired supersession/expiry state and
    // the DB columns as drift so the wipe+reinsert fallback re-heals the
    // row (transports superseded_by + expired_at that a pre-fix cycle
    // dropped).
    //
    // The supersession term keys off the RESOLVED reference, not merely
    // "the fence carries a reference": we re-resolve the fence's
    // `superseded by #N` against the current DB rows with the SAME resolver
    // insertFacts uses, then compare the resolved target id to the id the
    // DB stored. A permanently-unresolvable reference (self / dangling /
    // chain) resolves to NULL every cycle and matches the DB's NULL, so it
    // never churns; a pre-fix NULL, or a CHANGED reference (even between two
    // resolvable targets), still differs and re-heals. Resolution stays
    // page-local — `superseded by #N` only ever points within this page —
    // so a row_num → id lookup over `existing` is a faithful mirror of the
    // insert-time SELECT.
    const existingByRowNum = new Map<number, ExistingPageFact>();
    for (const f of existing) {
      const rn = f.row_num == null ? NaN : Number(f.row_num);
      if (Number.isFinite(rn)) existingByRowNum.set(rn, f);
    }
    const hasSupersessionDrift = existing.some(f => {
      const desired = desiredByKey.get(factContentKey(f.fact, f.source));
      if (desired === undefined) return false;

      // Expiry dimension: a struck row must carry expired_at; a pre-fix row
      // (both columns NULL) drifts here and re-heals. Compare NULL-ness, NOT
      // the timestamp value: the mapper stamps `expired_at = valid_until ??
      // today`, so a value comparison would see the stored timestamp differ
      // from a freshly-recomputed `today` every day and churn the page each
      // cycle. NULL-ness is the stable "is this row struck?" signal.
      const desiredExpired = desired.expired_at != null;
      const dbExpired = f.expired_at != null;
      if (desiredExpired !== dbExpired) return true;

      // Supersession dimension: resolve the fence reference against the
      // current DB rows and compare the resolved target id to what the DB
      // stored.
      const desiredRow = desired.superseded_by_row;
      let resolvedTargetId: number | null = null;
      if (desiredRow !== undefined) {
        const targetExisting = existingByRowNum.get(desiredRow);
        const target: SupersedeTarget | undefined = targetExisting
          ? { id: Number(targetExisting.id), struck: targetExisting.expired_at != null }
          : undefined;
        resolvedTargetId = resolveSupersededByRow(Number(f.row_num), desiredRow, target, slug).superseded_by;
      }
      const dbTargetId = f.superseded_by == null ? null : Number(f.superseded_by);
      return resolvedTargetId !== dbTargetId;
    });

    if (
      existing.length === extracted.length &&
      !hasStaleExisting &&
      !hasDuplicateExisting &&
      !hasRowNumDrift &&
      !hasSupersessionDrift
    ) {
      continue;
    }

    let toInsert = extracted.filter(f => !existingKeys.has(factContentKey(f.fact, f.source)));
    // v0.46 (#3014) — when old DB rows must be removed, defer the wipe into
    // insertFacts' own transaction (deleteForPageFirst) rather than calling
    // deleteFactsForPage here. A standalone delete self-commits, so a
    // failing insert afterward left the page permanently emptied; running
    // the delete as the first statement of the insert transaction makes the
    // reconcile atomic — a failed insert rolls the delete back. Same delete
    // scoping as before: legacy NULL-source_markdown_slug rows, `cli:`-origin
    // conversation facts (#1928), and soft-expired legacy rows (#2646)
    // survive.
    let deleteForPageFirst: { slug: string; excludeSourcePrefixes: string[]; preserveExpiredLegacy: boolean } | undefined;
    if (hasStaleExisting || hasDuplicateExisting || hasRowNumDrift || hasSupersessionDrift) {
      deleteForPageFirst = { slug, excludeSourcePrefixes: ['cli:'], preserveExpiredLegacy: true };
      toInsert = extracted;
    }

    // v0.35.4 (D-CDX-3) — batch-embed before insert. Without this,
    // cycle-inserted facts land with `embedding = NULL`, which breaks
    // consolidate's cosine clustering AND the drift_score formula in
    // find_trajectory. Falls open: if the embedding gateway is
    // unavailable (no API key configured), facts still insert with
    // NULL embeddings — drift_score gracefully returns null and
    // clustering falls back to recency.
    if (toInsert.length > 0) {
      if (isAvailable('embedding')) {
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
          // without embeddings. The warning is NOT swallowed (#3044): the cycle
          // wrapper folds result.warnings into a 'warn' phase status with a
          // warning count, so a billing/auth/rate-limit embed failure surfaces
          // in the cycle report instead of hiding behind a green 'ok'.
          result.warnings.push(
            `${slug}: extract_facts batch embed failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        // #2821: same fail-open contract, but never silently. Pre-fix only
        // the embed() FAILURE path warned — an UNAVAILABLE gateway inserted
        // NULL-embedding rows with a clean green 'ok', hiding the degraded
        // consolidate/drift_score behavior until someone diffed the DB.
        result.warnings.push(
          `${slug}: embedding gateway unavailable — ${toInsert.length} fact(s) inserted with NULL embedding (won't cluster in consolidate until re-embedded)`,
        );
      }
    }

    if (toInsert.length === 0) continue;

    const inserted = await engine.insertFacts( // gbrain-allow-direct-insert: extract_facts cycle phase reconciles fence → DB
      toInsert,
      { source_id: sourceId },
      deleteForPageFirst ? { deleteForPageFirst } : undefined,
    );
    result.factsInserted += inserted.inserted;
    // v0.46 (#3014) — the wipe (when needed) ran inside insertFacts' txn;
    // count it here from the atomic result rather than a separate delete.
    result.factsDeleted += inserted.deleted;
    // v0.46 (#3014) — surface unresolvable `superseded by #N` references
    // (self / dangling / struck target) as cycle warnings; the row still
    // inserts with superseded_by NULL + expired_at set (never a guessed FK).
    // resolveSupersededByRow already prefixes each message with the slug +
    // row, so push verbatim — no `${slug}: ` re-prefix.
    for (const w of inserted.warnings) result.warnings.push(w);
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
    // #3683: guard-triggered runs return early above (and book their halt
    // there), so this path is always a completed round — the old
    // `result.guardTriggered ? … : …` ternaries were dead in their true arm.
    await upsertExtractRollup(engine, {
      kind: 'facts.fence',
      source_id: sourceId,
      cost_delta: 0,
      round_completed_delta: 1,
      halt_delta: 0,
    });
  }

  return result;
}
