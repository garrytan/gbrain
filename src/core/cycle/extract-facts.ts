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
 *   4. Collapses duplicate ACTIVE rows with the same (claim, source).
 *   5. Reconciles the page-scoped DB index by fence row number: matched
 *      (row_num, claim) rows are updated in place (ids stay stable), rows
 *      that left the fence are expired and detached (never deleted), and
 *      only new row numbers insert. No-op when already in sync (#1781).
 *
 * Warning-bearing parses are non-authoritative and preserve that page's
 * existing index. A page with no fence expires and detaches its fence-owned
 * rows; `cli:` conversation facts and soft-expired legacy rows are not
 * fence-owned and are left alone. Active fence-owned rows of soft-deleted
 * pages are expired at the start of each run.
 *
 * Unfenced rows (#5299): each run first fences the source's active
 * `row_num IS NULL` rows onto their live entity pages through the shared
 * core pass (`facts/unfenced-facts.ts`, also the v0.32.2 migration's Phase
 * B) and reconciles those pages in the same run. The inline writer's
 * DB-only fallback keeps producing such rows, so no manual migration retry
 * is needed.
 *
 * Empty-fence guard (Codex R2-#7; #2484; #2646): rows the fence step could
 * not fence this run (a page whose file is not on this host, a malformed
 * fence, a held page lock) still block the destructive reconciliation pass
 * — in THIS run's source only (`source_id = sourceId`, the source-isolation
 * invariant). A row counts when `row_num IS NULL`, its `entity_slug`
 * resolves to a live page in this source, it is not soft-expired
 * (`expired_at IS NULL`; `forget_fact` drains rows that way) and the source
 * has a `local_path`. Status returns `warn` naming each failed page. Rows
 * with no backing page or checkout (slugify-floor / stub-guard-blocked
 * slugs from the inline writer) are structurally unfenceable and never gate.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { managedDerivedFactsPreflight, withDerivedFactsWrite } from '../persistence/derived-facts.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import {
  resolveSupersededByRow,
  supersessionChainOf,
  type SupersedeTarget,
  type SupersessionChain,
} from '../facts/supersede-resolve.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { fenceUnfencedFacts, planUnfencedFacts } from '../facts/unfenced-facts.ts';
import { classifyRunStop, upsertExtractRollup } from '../extract/rollup-writer.ts';
import { parseFactsFence, FACTS_FENCE_BEGIN } from '../facts-fence.ts';
import {
  duplicateActiveFenceRows,
  extractFactsFromFenceText,
  type FenceExtractedFact,
} from '../facts/extract-from-fence.ts';
import {
  runPhantomRedirectPass,
  emptyPhantomPassResult,
  type PhantomPassResult,
} from './phantom-redirect.ts';
import { embed, getEmbeddingDimensions, getEmbeddingModel, isAvailable } from '../ai/gateway.ts';
import { isAborted } from '../abort-check.ts';
import { parseMarkdown } from '../markdown.ts';
import { isWriteThroughDisabled, resolvePageWriteTarget } from '../write-through.ts';
import { acquirePageLock } from '../page-lock.ts';
import {
  lockReconcileRevision,
  selectFactsReconcileDrain,
  settleFactsReconcile,
  FACTS_DRAIN_BUDGET_MS,
  type FactsReconcileDrainOpts,
  type FactsReconcileOutcome,
} from '../facts/reconcile-watermark.ts';

interface ExistingPageFact {
  id: number | string;
  fact: string;
  source: string | null;
  row_num: number | string | null;
  superseded_by: number | string | null;
  expired_at: Date | string | null;
  kind: string;
  visibility: string;
  notability: string;
  context: string | null;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
  confidence: number | string;
  claim_metric: string | null;
  claim_value: number | string | null;
  claim_unit: string | null;
  claim_period: string | null;
  has_embedding: boolean;
}

function timeOf(value: Date | string | null | undefined): number | null {
  return value == null ? null : new Date(value).getTime();
}

function numbersDiffer(stored: number | string | null, desired: number | null | undefined): boolean {
  if (stored == null || desired == null) return (stored == null) !== (desired == null);
  const a = Number(stored);
  return Math.abs(a - desired) > 1e-6 * Math.max(1, Math.abs(desired));
}

/**
 * Whether a DB row matched to its fence row by (row_num, claim) needs an
 * in-place update. Expiry compares NULL-ness only: the mapper stamps a struck
 * row's `expired_at` (and a forgotten row's `valid_until`) with today, so a
 * value compare would churn the page every day. `valid_until` is compared
 * exactly for active rows, where it only ever comes from the fence cell.
 * Confidence and claim values are REAL / DOUBLE columns, compared with a
 * tolerance so float rounding never churns.
 */
function factCellsDiffer(stored: ExistingPageFact, desired: FenceExtractedFact): boolean {
  const desiredActive = desired.expired_at == null;
  return stored.kind !== (desired.kind ?? 'fact')
    || stored.visibility !== (desired.visibility ?? 'private')
    || stored.notability !== (desired.notability ?? 'medium')
    || (stored.context ?? null) !== (desired.context ?? null)
    || stored.source !== desired.source
    || numbersDiffer(stored.confidence, desired.confidence ?? 1.0)
    || (stored.claim_metric ?? null) !== (desired.claim_metric ?? null)
    || numbersDiffer(stored.claim_value, desired.claim_value)
    || (stored.claim_unit ?? null) !== (desired.claim_unit ?? null)
    || (stored.claim_period ?? null) !== (desired.claim_period ?? null)
    || (desired.valid_from != null && timeOf(stored.valid_from) !== desired.valid_from.getTime())
    || (stored.expired_at == null) !== desiredActive
    || (desiredActive && timeOf(stored.valid_until) !== timeOf(desired.valid_until));
}

/** Resolve one fence row's `superseded by #N` against the page's row -> id map. */
function resolveSupersession(
  desired: FenceExtractedFact,
  byRow: ReadonlyMap<number, SupersedeTarget>,
  chain: SupersessionChain,
  slug: string,
): { superseded_by: number | null; warning: string | null } {
  if (desired.superseded_by_row === undefined) return { superseded_by: null, warning: null };
  return resolveSupersededByRow(desired.row_num, desired.superseded_by_row, byRow.get(desired.superseded_by_row), slug, chain);
}

/**
 * Bring every fence row's `superseded_by` in line with its resolved
 * `superseded by #N` reference, inside the reconcile transaction. Warns only
 * for rows inserted by this run or whose link changes, so a permanently
 * unresolvable reference does not repeat its warning every cycle. Returns the
 * row numbers whose link changed.
 */
async function syncSupersession(
  tx: BrainEngine,
  sourceId: string,
  slug: string,
  desired: FenceExtractedFact[],
  chain: SupersessionChain,
  inserted: ReadonlySet<number>,
): Promise<{ warnings: string[]; changed: number[] }> {
  const current = await tx.executeRaw<{ id: number | string; row_num: number | string; expired_at: Date | string | null; superseded_by: number | string | null }>(
    `SELECT id, row_num, expired_at, superseded_by FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`,
    [sourceId, slug],
  );
  const rows = new Map(current.map(r => [Number(r.row_num), r]));
  const byRow = new Map([...rows].map(([row, r]) => [row, { id: Number(r.id), struck: r.expired_at != null }]));
  const warnings: string[] = [];
  const changed: number[] = [];
  for (const f of desired) {
    const row = rows.get(f.row_num);
    if (!row) continue;
    const { superseded_by, warning } = resolveSupersession(f, byRow, chain, slug);
    const differs = superseded_by !== (row.superseded_by == null ? null : Number(row.superseded_by));
    if (warning && (differs || inserted.has(f.row_num))) warnings.push(warning);
    if (!differs) continue;
    changed.push(f.row_num);
    await tx.executeRaw('UPDATE facts SET superseded_by = $1 WHERE id = $2 AND source_id = $3', [superseded_by, row.id, sourceId]);
  }
  return { warnings, changed };
}

/**
 * Destructive reconciliation may only trust the pages-table body when it
 * still matches the canonical Markdown file. The fact writer deliberately
 * commits Markdown first and then stamps the facts index, while page sync is
 * asynchronous. In that gap a sweep can observe the old pages.compiled_truth
 * plus the new fact row and otherwise delete the new row as "stale".
 *
 * `unavailable` preserves the existing DB-only/thin-client behaviour. A local
 * canonical file that exists but cannot be read is fail-closed: destructive
 * cleanup waits for a healthy sync/read instead of guessing that the cache is
 * authoritative.
 */
async function canonicalCacheState(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  cachedCompiledTruth: string,
  cachedTimeline: string,
): Promise<'fresh' | 'stale' | 'unavailable'> {
  // sync.write_through=off: the fence writers already treat the file as
  // non-canonical (fence-write.ts legacy fallback), so a stale mirror file must
  // not block reconcile here either.
  if (await isWriteThroughDisabled(engine)) return 'unavailable';
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok || !existsSync(target.filePath)) return 'unavailable';
  try {
    const canonical = parseMarkdown(readFileSync(target.filePath, 'utf-8'), target.filePath);
    return canonical.compiled_truth === cachedCompiledTruth.trim()
      && canonical.timeline === cachedTimeline.trim()
      ? 'fresh'
      : 'stale';
  } catch {
    return 'stale';
  }
}

async function refuseDestructiveReconcileOnStaleCache(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  cachedCompiledTruth: string,
  cachedTimeline: string,
  warnings: string[],
): Promise<boolean> {
  const state = await canonicalCacheState(
    engine,
    slug,
    sourceId,
    cachedCompiledTruth,
    cachedTimeline,
  );
  if (state !== 'stale') return false;
  warnings.push(
    `${slug}: FACTS_PAGE_CACHE_STALE: canonical Markdown differs from the pages cache; ` +
    'refusing destructive fact reconciliation until gbrain sync refreshes the page index.',
  );
  return true;
}

/**
 * Run one page's destructive reconcile under its page lock (5s, matching the
 * fence writers in fence-write.ts / forget.ts). A lock still held past the
 * deadline degrades to a FACTS_PAGE_LOCK_TIMEOUT warning for THAT page and a
 * null result, so one wedged page cannot abort the remaining slugs of the
 * phase run. Errors thrown by `fn` itself still propagate.
 */
async function underPageLock<T>(
  slug: string,
  fn: () => Promise<T>,
  opts: ExtractFactsOpts,
  warnings: string[],
): Promise<T | null> {
  const handle = await acquirePageLock(slug, { timeoutMs: 5_000, lockRoot: opts.pageLockRoot });
  if (!handle) {
    warnings.push(
      `${slug}: FACTS_PAGE_LOCK_TIMEOUT: page lock held by another writer; ` +
      'skipping destructive fact reconciliation for this page until the next run.',
    );
    return null;
  }
  try {
    return await fn();
  } finally {
    await handle.release();
  }
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
 * An ordinary expired legacy row does not suppress a fresh canonical fence
 * row. Explicit forget is different: its durable withdrawal record is
 * enforced by the facts trigger and import overlay, even after index rebuild.
 */
async function listExistingFactsForPage(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<ExistingPageFact[]> {
  return engine.executeRaw<ExistingPageFact>(
    `SELECT id, fact, source, row_num, superseded_by, expired_at, kind, visibility, notability, context,
            valid_from, valid_until, confidence, claim_metric, claim_value, claim_unit, claim_period,
            embedding IS NOT NULL AS has_embedding
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
  /** Override the shared page-lock directory for deterministic tests. */
  pageLockRoot?: string;
  /**
   * #5151: with an explicit slug list on an unmanaged brain, also reconcile
   * a bounded batch of pages whose facts watermark is behind the page
   * (src/core/facts/reconcile-watermark.ts). The dream cycle sets it.
   */
  drain?: FactsReconcileDrainOpts;
}

export interface ExtractFactsResult {
  pagesScanned: number;
  pagesWithFacts: number;
  factsInserted: number;
  /** Fence-owned rows whose cells were updated in place (ids kept). */
  factsUpdated: number;
  /** Fence-owned rows expired and detached because their row left the fence. */
  factsDeleted: number;
  /** Unfenced rows (`row_num IS NULL`, live entity page) still pending after this run's fence step. */
  legacyRowsPending: number;
  /** Unfenced rows this run appended to their page's fence and stamped with a row number (#5299). */
  unfencedRowsFenced: number;
  /** Active fence-owned rows expired because their page was soft-deleted. */
  factsExpiredForDeletedPages: number;
  guardTriggered: boolean;
  /** Pages whose reconcile threw and rolled back; later pages still ran. */
  pagesFailed: number;
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
  // Managed brains reconcile the same way, but each database write commits
  // inside the coordinator's source capability under the page key.
  const managed = await managedDerivedFactsPreflight(engine, sourceId);
  const transact = <T>(slugs: string[], fn: (tx: BrainEngine) => Promise<T>): Promise<T> =>
    managed ? withDerivedFactsWrite(engine, sourceId, slugs, fn) : maintenanceTransaction(engine, fn);
  const result: ExtractFactsResult = {
    pagesScanned: 0,
    pagesWithFacts: 0,
    factsInserted: 0,
    factsUpdated: 0,
    factsDeleted: 0,
    legacyRowsPending: 0,
    unfencedRowsFenced: 0,
    factsExpiredForDeletedPages: 0,
    pagesFailed: 0,
    guardTriggered: false,
    warnings: [],
    phantomsScanned: 0,
    phantomsRedirected: 0,
    phantomsAmbiguous: 0,
    phantomsSkippedDrift: 0,
    phantomsLockBusy: false,
    phantomsMorePending: false,
  };

  // ── Fence unfenced rows (#5299) ─────────────────────────────────
  // The inline writer's DB-only fallback keeps producing `row_num IS NULL`
  // rows on live entity pages (a write from a host without the checkout,
  // `sync.write_through=off`). Each run fences them itself through the
  // shared core pass (the v0.32.2 migration's Phase B): the coordinator on a
  // managed brain, the page file + maintenance transaction otherwise. The
  // fenced pages join this run's reconcile below.
  let fencedSlugs: string[] = [];
  if (!opts.dryRun) {
    try {
      const fence = await fenceUnfencedFacts(engine, await planUnfencedFacts(engine, { sourceId }), { pageLockRoot: opts.pageLockRoot });
      result.unfencedRowsFenced = fence.fenced;
      fencedSlugs = fence.fenced_slugs;
      for (const page of [...fence.failed_pages, ...fence.missing_files]) result.warnings.push(`FACTS_FENCE_FAILED: ${page}`);
    } catch (e) {
      result.warnings.push(`FACTS_FENCE_FAILED: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
    }
  }

  // ── Empty-fence guard (Codex R2-#7; #2484; #2646) ──────────────
  // Rows the fence step could not fence this run still block the destructive
  // reconciliation pass. A row counts only when `row_num IS NULL`, its
  // `entity_slug` resolves to a LIVE page in THIS run's source (#3526 source
  // isolation), it is not soft-expired (#2646: `forget_fact` drains rows by
  // soft-expiring them), the source has a `local_path` (#2763), and it is
  // not an ontology observation (`dimension IS NULL`, #6264: those are never
  // fenced, so they must not gate either). Rows without a page or checkout
  // (#2484: the inline writer's slugify-floor / stub-guard-blocked slugs)
  // are structurally unfenceable and never gate.
  const legacy = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM facts f
      WHERE f.source_id = $1
        AND f.row_num IS NULL
        AND f.dimension IS NULL
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
    result.warnings.push(
      `extract_facts: ${legacyCount} unfenced fact row(s) in source "${sourceId}" (entity page present, row_num NULL) ` +
      (opts.dryRun
        ? 'would be fenced by this phase; a dry run writes nothing, so reconciliation is skipped.'
        : 'could not be fenced this run, so reconciliation is skipped. The FACTS_FENCE_FAILED warnings name each page and why; ' +
          'a page whose canonical file does not exist on this host is fenced by the cycle on the host that holds the file. ' +
          'Individual rows can instead be drained via `forget_fact`.'),
    );
    // #3683: book the halt BEFORE the early return. The end-of-run rollup
    // write below is unreachable from this path, so a guard-triggered run
    // must record its halt here for doctor extract_health's halt_rate.
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

  // ── Facts of soft-deleted pages ────────────────────────────────
  // Deleting a page removes the fence that is the facts' system of record,
  // and a full walk never visits a deleted slug, so its derived rows would
  // stay active in recall indefinitely. Expire (never delete or detach) the
  // fence-owned rows of every soft-deleted page in this source: restoring the
  // page brings its fence back, and the next reconcile of that slug
  // re-activates the rows that are still in it (the withdrawal trigger keeps
  // forgotten claims expired). Rows of a page that simply has no DB row yet
  // (a fence write ahead of sync) are untouched.
  if (!opts.dryRun) {
    const expireDeleted = (db: BrainEngine) => db.executeRaw<{ id: number }>(
      `UPDATE facts f SET expired_at = now()
        WHERE f.source_id = $1 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
          AND EXISTS (SELECT 1 FROM pages p
                       WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug
                         AND p.deleted_at IS NOT NULL)
        RETURNING f.id`,
      [sourceId],
    );
    // Managed: one page at a time under its key, so a concurrent restore is
    // either seen as restored or waited for, never expired underneath it.
    const expired = managed ? await expireDeletedPagesManaged(engine, sourceId, transact) : await maintenanceTransaction(engine, expireDeleted);
    result.factsExpiredForDeletedPages = expired.length;
  }

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
  if (phantomResult.touched_canonicals.length > 0 || fencedSlugs.length > 0) {
    slugs = Array.from(new Set([...slugs, ...phantomResult.touched_canonicals, ...fencedSlugs]));
  }
  const watermark = !managed && !opts.dryRun;
  const explicit = new Set(slugs);
  if (watermark && opts.drain && opts.slugs !== undefined) {
    slugs = Array.from(new Set([...slugs, ...await selectFactsReconcileDrain(engine, sourceId, opts.drain)]));
  }
  const drainDeadline = Date.now() + (opts.drain?.budgetMs ?? FACTS_DRAIN_BUDGET_MS);

  // ── Reconcile each page ───────────────────────────────────────
  // Each page reconciles independently: 'stop' ends the walk (cancellation),
  // every other outcome moves on. A thrown error is isolated to its page
  // below. For the watermark, 'unchanged' is a complete no-op still to be
  // stamped and 'complete' was stamped inside the write transaction.
  type PageOutcome = FactsReconcileOutcome | 'unchanged' | 'skipped' | 'stop';
  let revision: string | null | undefined;
  const reconcilePage = async (slug: string): Promise<PageOutcome> => {
    const page = await engine.getPage(slug, { sourceId });
    if (!page) {
      // Slug listed but not in DB — skip silently. The next cycle
      // will pick it up if it exists.
      return 'skipped';
    }
    revision = page.knowledge_revision ?? null;

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
      return 'invalid';
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
      return 'invalid';
    }

    if (parsed.facts.length > 0) result.pagesWithFacts += 1;

    // v0.35.4 (D-ENG-1) — thread page.effective_date as the fallback
    // valid_from. Without this, fence rows without explicit `validFrom:`
    // land with `valid_from = now()` (import timestamp) and every
    // trajectory query against the page returns import dates instead of
    // claim dates.
    const pageEffectiveDate = page.effective_date ? new Date(page.effective_date) : null;
    // #1781: duplicate ACTIVE rows (same claim and source) index once.
    const duplicates = duplicateActiveFenceRows(parsed.facts);
    const extracted = extractFactsFromFenceText(parsed.facts, slug, sourceId, { pageEffectiveDate })
      .filter(f => !duplicates.has(f.row_num));

    if (opts.dryRun) return 'skipped';

    // Reconcile by row number, the fence's own unique identity (the parser
    // refuses duplicate row numbers). A DB row whose (row_num, claim) is still
    // in the fence keeps its id and has its other cells updated in place, so
    // ids handed out by recall keep working for forget and consolidation,
    // source_session, created_at and embeddings survive an edit. A row whose
    // number disappeared or whose claim was rewritten is expired and detached
    // (row_num NULL), never deleted: the same rule the managed projection
    // applies. Keying on row number also keeps a claim that reverts to an
    // earlier value (NYC -> SF -> NYC) active instead of folding it onto the
    // struck history row with the same text.
    const existing = await listExistingFactsForPage(engine, slug, sourceId);
    const desiredByRow = new Map(extracted.map(f => [f.row_num, f]));
    const matched = new Map<number, ExistingPageFact>();
    const stale: ExistingPageFact[] = [];
    for (const fact of existing) {
      const desired = fact.row_num == null ? undefined : desiredByRow.get(Number(fact.row_num));
      if (desired && desired.fact === fact.fact) matched.set(desired.row_num, fact);
      else stale.push(fact);
    }
    const updates = extracted.filter(f => {
      const fact = matched.get(f.row_num);
      return fact !== undefined && factCellsDiffer(fact, f);
    });
    const toInsert = extracted.filter(f => !matched.has(f.row_num));
    const chain = supersessionChainOf(extracted, slug);

    if (stale.length === 0 && updates.length === 0 && toInsert.length === 0) {
      const byRow = new Map([...matched].map(([row, fact]) => [row, { id: Number(fact.id), struck: fact.expired_at != null }]));
      const inSync = extracted.every(f => {
        const stored = matched.get(f.row_num)!.superseded_by;
        return resolveSupersession(f, byRow, chain, slug).superseded_by === (stored == null ? null : Number(stored));
      });
      if (inSync) return 'unchanged';
    }

    // v0.35.4 (D-CDX-3) — batch-embed new rows before insert so
    // consolidate's cosine clustering and find_trajectory's drift_score see
    // them. Rows updated in place keep their vectors: the claim text is
    // unchanged. Falls open without an embedding provider, with a warning.
    if (toInsert.length > 0) {
      if (isAvailable('embedding')) {
        try {
          const texts = toInsert.map(e => e.fact);
          const embeddingModel = getEmbeddingModel();
          const dimensions = getEmbeddingDimensions();
          // #1972: forward the abort signal so a cancelled cycle's in-flight
          // batch embed (a network call) is itself abortable, not just the loop.
          const embeddings = await embed(texts, { abortSignal: opts.signal, embeddingModel, dimensions, inputType: 'document' });
          if (embeddings.length !== toInsert.length || embeddings.some(vector =>
            vector?.length !== dimensions || !vector.every(Number.isFinite))) {
            throw new Error('embedding provider returned an incomplete or invalid fact batch');
          }
          for (let i = 0; i < toInsert.length; i++) {
            toInsert[i].embedding = embeddings[i];
            toInsert[i].embedding_model = embeddingModel;
          }
        } catch (err) {
          // #3044: non-fatal, but never silent — the cycle folds warnings
          // into a 'warn' phase status.
          result.warnings.push(
            `${slug}: extract_facts batch embed failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        // #2821: same fail-open contract, never silently.
        result.warnings.push(
          `${slug}: embedding gateway unavailable — ${toInsert.length} fact(s) need embeddings (NULL embeddings won't cluster in consolidate until re-embedded)`,
        );
      }
    }

    if (isAborted(opts.signal)) {
      result.warnings.push(`${slug}: fact reconciliation deferred after cancellation; existing rows preserved`);
      return 'stop';
    }

    // A vector-bearing row is never replaced by a row that could not be
    // embedded. Until embedding succeeds, rows keep their positions: stale
    // rows whose claim is still active in the fence stay as they are, others
    // are expired in place, and new rows wait. In-place updates (privacy,
    // notability, strikes) still apply.
    const deferInserts = toInsert.some(f => !f.embedding) && stale.some(f => f.has_embedding);
    const activeClaims = new Set(extracted.filter(f => f.expired_at == null).map(f => `${f.fact}\u0000${f.source}`));
    const detach = deferInserts ? [] : stale;
    const expireInPlace = deferInserts
      ? stale.filter(f => f.expired_at == null && !activeClaims.has(`${f.fact}\u0000${f.source}`))
      : [];
    const inserts = deferInserts ? [] : toInsert;
    if (deferInserts) {
      result.warnings.push(`${slug}: destructive fact reconciliation deferred; existing vectors preserved until embedding succeeds`);
    }

    const apply = async () => {
      try {
        return await transact([slug], async tx => {
          opts.signal?.throwIfAborted();
          if (watermark && !await lockReconcileRevision(tx, sourceId, slug, page.knowledge_revision ?? null)) return null;
          const current = await tx.getPage(slug, { sourceId });
          if (!current || current.compiled_truth !== page.compiled_truth || current.timeline !== page.timeline) return null;
          for (const fact of expireInPlace) {
            await tx.executeRaw('UPDATE facts SET expired_at = COALESCE(expired_at, now()) WHERE id = $1 AND source_id = $2', [fact.id, sourceId]);
          }
          for (const fact of detach) {
            await tx.executeRaw(
              `UPDATE facts SET expired_at = COALESCE(expired_at, now()), row_num = NULL
                WHERE id = $1 AND source_id = $2`,
              [fact.id, sourceId],
            );
          }
          for (const f of updates) {
            await tx.executeRaw(
              `UPDATE facts SET kind = $3, visibility = $4, notability = $5, context = $6,
                  valid_from = COALESCE($7::timestamptz, valid_from),
                  valid_until = CASE WHEN $8::boolean THEN $9::timestamptz ELSE valid_until END,
                  expired_at = CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE COALESCE(expired_at, $10::timestamptz) END,
                  source = $11, confidence = $12,
                  claim_metric = $13, claim_value = $14, claim_unit = $15, claim_period = $16
                WHERE id = $1 AND source_id = $2`,
              [matched.get(f.row_num)!.id, sourceId, f.kind ?? 'fact', f.visibility ?? 'private', f.notability ?? 'medium',
                f.context ?? null, f.valid_from?.toISOString() ?? null, f.expired_at == null,
                f.valid_until?.toISOString() ?? null, f.expired_at?.toISOString() ?? null, f.source, f.confidence ?? 1.0,
                f.claim_metric ?? null, f.claim_value ?? null, f.claim_unit ?? null, f.claim_period ?? null],
            );
          }
          const inserted = inserts.length === 0
            ? { inserted: 0 }
            : await tx.insertFacts( // gbrain-allow-direct-insert: extract_facts cycle phase reconciles fence → DB
              inserts.map(f => ({ ...f, superseded_by_row: undefined })),
              { source_id: sourceId },
            );
          const insertedRows = new Set(inserts.map(f => f.row_num));
          const linked = await syncSupersession(tx, sourceId, slug, extracted, chain, insertedRows);
          opts.signal?.throwIfAborted();
          const updated = new Set([...updates.map(f => f.row_num), ...linked.changed.filter(row => !insertedRows.has(row))]);
          if (watermark && !deferInserts) await settleFactsReconcile(tx, sourceId, slug, 'complete', page.knowledge_revision ?? null);
          return { inserted: inserted.inserted, updated: updated.size, warnings: linked.warnings };
        });
      } catch (error) {
        if (!isAborted(opts.signal)) throw error;
        result.warnings.push(`${slug}: fact reconciliation cancelled; transaction rolled back`);
        return null;
      }
    };
    const outcome = detach.length === 0 && expireInPlace.length === 0 && updates.length === 0
      ? await apply()
      : await underPageLock(slug, async () => {
        if (await refuseDestructiveReconcileOnStaleCache(
          engine, slug, sourceId, page.compiled_truth ?? '', page.timeline ?? '', result.warnings,
        )) return null;
        if (isAborted(opts.signal)) return null;
        return apply();
      }, opts, result.warnings);
    if (!outcome) return isAborted(opts.signal) ? 'cancelled' : 'deferred';
    result.factsInserted += outcome.inserted;
    result.factsUpdated += outcome.updated;
    result.factsDeleted += detach.length + expireInPlace.length;
    // resolveSupersededByRow prefixes each message with the slug + row.
    for (const w of outcome.warnings) result.warnings.push(w);
    return deferInserts ? 'deferred' : 'complete';
  };

  for (const slug of slugs) {
    // #1972: bail at the top of the per-page loop on abort. Each page is an
    // independent delete-then-insert commit, so breaking leaves a consistent
    // partial state; the receipt/rollup below still runs with partial counts.
    if (isAborted(opts.signal)) break;
    // Drained pages follow the explicit ones, so the drain budget ends the walk.
    if (!explicit.has(slug) && Date.now() > drainDeadline) break;
    result.pagesScanned += 1;
    revision = undefined;
    let outcome: PageOutcome;
    try {
      outcome = await reconcilePage(slug);
    } catch (error) {
      if (isAborted(opts.signal)) throw error;
      // One page the database rejects (CHECK/FK violation, malformed input the
      // parser tolerated) must not abort reconciliation for every later page.
      // Its transaction rolled back, so the existing index is preserved.
      result.pagesFailed += 1;
      result.warnings.push(`${slug}: FACTS_RECONCILE_FAILED: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      outcome = 'deferred';
    }
    if (watermark && outcome !== 'complete' && outcome !== 'skipped') {
      const settled = outcome === 'unchanged' ? 'complete' : outcome === 'stop' ? 'cancelled' : outcome;
      await settleFactsReconcile(engine, sourceId, slug, settled, revision).catch((error: unknown) => {
        result.warnings.push(`${slug}: facts reconcile watermark not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (outcome === 'stop') break;
  }

  // v0.42 Wave B3: receipt + rollup. extract_facts is deterministic
  // (fence reconcile, no LLM cost); receipt only when facts were
  // actually inserted; rollup always fires.
  // Receipt pages are unmanaged-only, like extract_atoms'; the rollup below still books the run.
  if (!opts.dryRun && !managed && result.factsInserted > 0) {
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
      ...classifyRunStop({ error: result.pagesFailed > 0 }),
    });
  }

  return result;
}

async function expireDeletedPagesManaged(engine: BrainEngine, sourceId: string,
  transact: <T>(slugs: string[], fn: (tx: BrainEngine) => Promise<T>) => Promise<T>): Promise<Array<{ id: number }>> {
  const pages = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT f.source_markdown_slug AS slug FROM facts f
      WHERE f.source_id = $1 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.deleted_at IS NOT NULL)`,
    [sourceId],
  );
  const expired: Array<{ id: number }> = [];
  for (const { slug } of pages) {
    expired.push(...await transact([slug], tx => tx.executeRaw<{ id: number }>(
      `UPDATE facts f SET expired_at = now()
        WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
          AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NOT NULL)
        RETURNING f.id`,
      [sourceId, slug],
    )));
  }
  return expired;
}
