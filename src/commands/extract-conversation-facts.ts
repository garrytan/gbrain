/**
 * gbrain extract-conversation-facts — batch fact extraction for
 * conversation pages (and adjacent long-form types).
 *
 * Background
 * ----------
 * Long-running conversation pages (imported chat logs, transcripts,
 * etc.) can be very large — tens of thousands of messages spanning
 * years. The default embedding pipeline chunks them into ~300-word
 * blocks and prepends a tiny page-title hint. Enough for short pages,
 * but it falls apart on long-running conversations:
 *
 *   - A user searches for "mountain cabin lock code" but the chunk
 *     that contains the literal code reads only "Locker 93 code 9494"
 *     — no mention of "cabin", "mountain", or any topical anchor.
 *   - Retrieval misses, because the chunk-level embedding can't see
 *     the surrounding 50K messages of context that establish the topic.
 *
 * The facts table doesn't have this problem. Each row is a discrete
 * claim with its own embedding and entity linkage, and `gbrain search`
 * blends facts into the result set. The extraction pipeline that
 * builds facts (src/core/facts/extract.ts) is already wired into
 * real-time MCP turns and the post-sync backstop — but had never been
 * run as a bulk backfill over imported chat history.
 *
 * This command closes that gap.
 *
 * Architecture decisions (locked by CEO + 3-round spec review + 2-round
 * Codex outside voice + 2-pass eng review):
 *
 *   - Strict per-source core. `runExtractConversationFactsCore` ALWAYS
 *     takes one sourceId. Multi-source iteration lives in the CLI
 *     wrapper (and in the cycle phase wrapper, separately).
 *   - Two-phase memory-bounded enumeration. Use paginated
 *     `listPages({type, sourceId, limit: PAGE_LIST_BATCH})` so worst
 *     case is BATCH × 25MB per batch (currently 10 × 25MB = 250MB
 *     bounded). Per-page body cap drops oversize before parsing.
 *   - Body read prefers frontmatter.raw_transcript when present, then
 *     falls back to compiled_truth + timeline. Meeting pages often
 *     store the real turn-by-turn transcript in a sidecar file while
 *     compiled_truth is just the human summary.
 *   - Page-global row_num accumulator. facts table unique index is
 *     (source_id, source_markdown_slug, row_num); per-segment row_num
 *     would collide on segment 2. Per-page counter increments across
 *     segments.
 *   - Terminal audit row on completion. After all segments commit, one
 *     extra fact row with source='cli:extract-conversation-facts:terminal'
 *     marks the page complete. Doctor's backlog query checks for the
 *     terminal row, NOT any fact — partial extraction → no terminal →
 *     next run resumes.
 *   - Optional budgetTracker via opts. If a tracker is in opts, use it
 *     as-is (NO `withBudgetTracker` wrap, which would REPLACE the active
 *     tracker per gateway.ts AsyncLocalStorage semantics, defeating an
 *     outer brain-wide cap). If absent, auto-create from `maxCostUsd`
 *     and wrap. Callers explicitly own lifecycle.
 *   - Op-checkpoint string-encoded resume state. Entries are
 *     "<sourceId>|<slug>|<endIso>" strings (op_checkpoints stores
 *     string[] only and is GC'd at 7 days; durable audit is the facts
 *     table itself via the terminal row).
 *   - Fingerprint on sourceId only. Widening cycle.types config does
 *     NOT invalidate completed-page state.
 *
 * Honor brain-wide kill-switch:
 *   `facts.extraction_enabled=false` config blocks. Pass
 *   `--override-disabled` to force-run.
 */

import type { BrainEngine, NewFact } from '../core/engine.ts';
import type { Page } from '../core/types.ts';
import {
  extractFactsFromTurn,
  isFactsExtractionEnabled,
} from '../core/facts/extract.ts';
import { isAvailable, withBudgetTracker } from '../core/ai/gateway.ts';
import { BudgetTracker, BudgetExhausted } from '../core/budget/budget-tracker.ts';
import { listSources } from '../core/sources-ops.ts';
import {
  loadOpCheckpoint,
  recordCompleted,
  type OpCheckpointKey,
} from '../core/op-checkpoint.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions, maybeBackground } from '../core/cli-options.ts';
import { loadConfig } from '../core/config.ts';
import { createHash } from 'crypto';
// v0.41.15.0 (T5): worker-pool primitive + per-source-clamp wrapper +
// per-page advisory lock + delete-orphans-first replay safety. See plan
// `~/.claude/plans/system-instruction-you-are-working-fancy-creek.md`
// decisions D2, D6, D9, D11, D12, D13, D15.
import { runSlidingPool } from '../core/worker-pool.ts';
import { parseWorkers, resolveWorkersWithClamp } from '../core/sync-concurrency.ts';
import { withRefreshingLock, LockUnavailableError } from '../core/db-lock.ts';
import { assertFactsEmbeddingDimMatchesConfig } from '../core/embedding-dim-check.ts';
import { writeReceipt, shortRunId } from '../core/extract/receipt-writer.ts';
import { upsertExtractRollup } from '../core/extract/rollup-writer.ts';

// ---------------------------------------------------------------------------
// Tunables (exported for tests).
// ---------------------------------------------------------------------------

/** Maximum gap between adjacent messages before we cut a new segment. */
export const DEFAULT_SEGMENT_GAP_MINUTES = 30;

/**
 * Hard cap on messages per segment, regardless of timing.
 * Tuned down from PR's 50 → 30 (Eng-v2 T5): combined with the 6500-char
 * SEGMENT_TEXT_CHAR_LIMIT, this keeps headroom under extract.ts's
 * MAX_TURN_TEXT_CHARS = 8000 so tail facts in dense Slack/email
 * segments don't vanish silently.
 */
export const DEFAULT_SEGMENT_MAX_MESSAGES = 30;

/** Minimum messages required for a segment to be worth extracting. */
export const MIN_SEGMENT_MESSAGES = 2;

/** Delay between extractor calls so we don't burst the chat provider. */
export const DEFAULT_INTER_CALL_SLEEP_MS = 200;

/**
 * Cap on character length of the rendered segment passed to the extractor.
 * Tuned down from PR's 7500 → 6500 (Eng-v2 T5) to leave headroom for the
 * topical/temporal header (~500 chars typical, up to ~1500 with a long
 * participant list) under extract.ts's MAX_TURN_TEXT_CHARS = 8000.
 */
export const SEGMENT_TEXT_CHAR_LIMIT = 6500;

/**
 * Hard cap on per-page body bytes (compiled_truth + timeline). Pages
 * exceeding the cap are skipped to bound worker memory (Eng A2). A
 * streaming/per-segment-fetch path for 50MB+ iMessage histories is a
 * v0.42+ follow-up.
 */
export const MAX_PAGE_BODY_BYTES = 25 * 1024 * 1024;

/** Default cost cap when no tracker is passed explicitly. */
export const DEFAULT_MAX_COST_USD = 5.0;

/**
 * Allowlist of page types this command operates on. Mirrors
 * cycle.conversation_facts_backfill.types config default. CLI's
 * `--types` flag is an explicit per-run override; cycle config is
 * the single source of truth.
 */
export const ALLOWED_TYPES = ['conversation', 'meeting', 'slack', 'email'] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

/**
 * Pagination batch size for listPages enumeration. Per-batch memory
 * worst case = BATCH × MAX_PAGE_BODY_BYTES = 250MB at default 10
 * (Eng-v2 C8 — bounded vs PR's unbounded listPages limit:500 = 12.5GB).
 */
export const PAGE_LIST_BATCH = 10;

/** Op name for the checkpoint primitive. */
export const CHECKPOINT_OP = 'extract-conversation-facts';

/**
 * Source string written on per-segment facts. Doctor queries the
 * TERMINAL variant below; this variant marks individual fact provenance.
 */
export const PER_SEGMENT_SOURCE_PREFIX = 'cli:extract-conversation-facts';

/**
 * Source string written on the page-level terminal audit row (Eng-v2 C7).
 * Doctor's backlog query matches THIS source + source_session, not
 * the per-segment source. Partial extraction = no terminal row = page
 * stays in backlog.
 */
export const TERMINAL_AUDIT_SOURCE = 'cli:extract-conversation-facts:terminal';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  speaker: string;
  /** ISO 8601 timestamp parsed from the rendered message line. */
  timestamp: string;
  text: string;
}

export interface ConversationSegment {
  messages: ConversationMessage[];
  startIso: string;
  endIso: string;
  participants: string[];
}

/**
 * Core function opts. Strict — `sourceId` is always required (Eng-v2 A1).
 * Multi-source iteration is the caller's job.
 */
export interface ExtractConversationFactsCoreOpts {
  /** REQUIRED. Strict per-source contract. */
  sourceId: string;
  /**
   * Page types to walk. Reads cycle config when omitted.
   * Allowlist enforced via ALLOWED_TYPES.
   */
  types?: AllowedType[];
  /** Process a single page; otherwise iterate all matching pages in the source. */
  slug?: string;
  /** Show would-do counts without writing facts or advancing checkpoint. */
  dryRun?: boolean;
  /** Cap pages processed in this invocation. */
  limit?: number;
  /** ISO watermark; messages older than this are filtered out. */
  sinceIso?: string;
  /** Clear this page's resume entry before processing. */
  force?: boolean;
  /** Delay between extractor calls. */
  sleepMs?: number;
  /** Max segments to process per page (0 = unlimited). */
  segmentLimit?: number;
  /**
   * Cost cap (USD). Used when budgetTracker is NOT passed; core
   * creates a fresh tracker. Default DEFAULT_MAX_COST_USD.
   */
  maxCostUsd?: number;
  /**
   * Externally-managed BudgetTracker (Eng-v2 C5). If present, core
   * uses it as-is — no `withBudgetTracker` wrap. Cycle phase passes
   * a brain-wide tracker; CLI/Minion pass nothing.
   */
  budgetTracker?: BudgetTracker;
  /** Bypass `facts.extraction_enabled=false`. Power-user escape. */
  overrideDisabled?: boolean;
  /**
   * v0.41.15.0 (D9 wrapper): in-process worker count for the per-page
   * fan-out. Default 1 (back-compat). Recommended 5-20 for LLM-bound
   * work; PGLite engines silently clamp to 1 with a stderr warn. Cross-
   * process safety is structurally guaranteed by D2's per-page advisory
   * lock + D11's delete-orphans-first replay.
   *
   * Worst-case overshoot on `--max-cost-usd`: D3 documented overshoot is
   * `N × avg_per_call_cost` over the configured cap because per-worker
   * `reserve()` calls aren't serialized. At workers=20 × ~$0.02/page,
   * expect up to ~$0.40 over the cap. Tighten the cap or pin workers=1
   * if you need exact-ceiling compliance.
   */
  workers?: number;
}

export interface ExtractConversationFactsResult {
  pages_considered: number;
  pages_processed: number;
  pages_skipped: number;
  pages_skipped_too_large: number;
  pages_skipped_disappeared: number;
  /**
   * v0.41.15.0 (D6): pages we attempted to claim but skipped because
   * another worker / parallel process held the advisory lock. The pages
   * stay in the backlog; the next enumeration cycle picks them up once
   * the holder writes its terminal row. Operator surfaces this via the
   * exit summary; exit code 3 when non-zero AND no hard failures.
   */
  pages_lock_skipped: number;
  /**
   * v0.41.15.0 (D11): facts deleted by the per-page delete-orphans-first
   * replay safety pass. Non-zero means a prior run crashed mid-extract;
   * the current worker cleaned up and re-extracted from scratch. Always
   * safe; surfaced for operator observability.
   */
  orphan_facts_cleaned: number;
  segments_processed: number;
  facts_extracted: number;
  facts_inserted: number;
  budget_exhausted?: boolean;
  spent_usd?: number;
}

// ---------------------------------------------------------------------------
// Message parsing — v0.41.13.0 delegates to the new
// `src/core/conversation-parser/parse.ts` orchestrator (12+ built-in
// formats + opt-IN LLM polish/fallback). PR #1461's Telegram bracket-time
// shape is the `telegram-bracket` built-in pattern. PR #1461's existing
// `MESSAGE_LINE_RX` is the `imessage-slack` built-in pattern.
//
// This wrapper preserves the historical `parseConversationMessages(body,
// opts)` shape for back-compat with the test suite + any direct callers.
// `processPage` below threads a full Page through `parseConversation` so
// frontmatter date / timezone / effective_date precedence per D8 takes
// effect.
// ---------------------------------------------------------------------------

import {
  parseConversation,
  type ParseConversationOpts as OrchestratorParseOpts,
} from '../core/conversation-parser/parse.ts';
import { readConversationBodyForParsing } from '../core/conversation-parser/body.ts';

/**
 * v0.41.13.0 — back-compat shape for direct callers + the existing
 * test suite. Delegates to the new orchestrator.
 *
 * Per D8: callers with a full Page should pass `opts.page` instead of
 * `opts.fallbackDate` so the orchestrator's date-derivation chain
 * (frontmatter.date > effective_date > '1970-01-01') applies. The
 * `fallbackDate` field is preserved for PR #1461's test cases that
 * pass it explicitly.
 */
export function parseConversationMessages(
  body: string,
  opts: { fallbackDate?: string } = {},
): ConversationMessage[] {
  const result = parseConversation(body, {
    fallbackDate: opts.fallbackDate,
  } as OrchestratorParseOpts);
  return result.messages;
}

// ---------------------------------------------------------------------------
// Segment splitting.
// ---------------------------------------------------------------------------

export interface SplitSegmentsOpts {
  gapMinutes?: number;
  maxMessages?: number;
  /** Drop messages with timestamp <= this ISO before splitting. */
  sinceIso?: string;
}

export function splitIntoSegments(
  messages: ConversationMessage[],
  opts: SplitSegmentsOpts = {},
): ConversationSegment[] {
  const gapMs = (opts.gapMinutes ?? DEFAULT_SEGMENT_GAP_MINUTES) * 60_000;
  const maxMessages = opts.maxMessages ?? DEFAULT_SEGMENT_MAX_MESSAGES;
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : NaN;

  const filtered = Number.isFinite(sinceMs)
    ? messages.filter((m) => Date.parse(m.timestamp) > sinceMs)
    : messages.slice();

  const out: ConversationSegment[] = [];
  let cur: ConversationMessage[] = [];
  let lastTs: number | null = null;

  const flush = () => {
    if (cur.length < MIN_SEGMENT_MESSAGES) {
      cur = [];
      return;
    }
    const seen = new Set<string>();
    const participants: string[] = [];
    for (const m of cur) {
      if (!seen.has(m.speaker)) {
        seen.add(m.speaker);
        participants.push(m.speaker);
      }
    }
    out.push({
      messages: cur,
      startIso: cur[0].timestamp,
      endIso: cur[cur.length - 1].timestamp,
      participants,
    });
    cur = [];
  };

  for (const m of filtered) {
    const ts = Date.parse(m.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (lastTs !== null && ts - lastTs > gapMs) flush();
    cur.push(m);
    lastTs = ts;
    if (cur.length >= maxMessages) {
      flush();
      lastTs = null;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Segment rendering with topical/temporal header.
// ---------------------------------------------------------------------------

export function renderSegmentForExtraction(
  pageTitle: string,
  segment: ConversationSegment,
): string {
  const header = [
    `Page: ${pageTitle}`,
    `Conversation between ${segment.participants.join(' and ')} from ${segment.startIso} to ${segment.endIso}`,
    '---',
  ].join('\n');
  const body = segment.messages
    .map((m) => `${m.speaker} (${m.timestamp}): ${m.text}`)
    .join('\n');
  const full = `${header}\n${body}`;
  if (full.length <= SEGMENT_TEXT_CHAR_LIMIT) return full;
  // Truncate from the end of the body, keeping the header intact so the
  // extractor still sees the topical anchor.
  const slack = SEGMENT_TEXT_CHAR_LIMIT - header.length - 16;
  return `${header}\n${body.slice(0, Math.max(0, slack))}\n…(truncated)`;
}

// ---------------------------------------------------------------------------
// Fingerprint — sourceId-only (Eng-v2 A3). Widening types config does NOT
// invalidate prior completion state.
// ---------------------------------------------------------------------------

export function extractConversationFactsFingerprint(opts: { sourceId: string }): string {
  const canonical = JSON.stringify({ sourceId: opts.sourceId });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

function checkpointKey(sourceId: string): OpCheckpointKey {
  return { op: CHECKPOINT_OP, fingerprint: extractConversationFactsFingerprint({ sourceId }) };
}

// ---------------------------------------------------------------------------
// Op-checkpoint helpers — string-encoded "<sourceId>|<slug>|<endIso>" entries.
// ---------------------------------------------------------------------------

interface DecodedEntry {
  sourceId: string;
  slug: string;
  endIso: string;
}

export function encodeCheckpointEntry(sourceId: string, slug: string, endIso: string): string {
  // Slugs are validated to [a-z0-9_/-] + CJK; sourceId is [a-z0-9_-].
  // Neither contains the pipe character, so the delimiter is safe.
  return `${sourceId}|${slug}|${endIso}`;
}

export function decodeCheckpointEntry(entry: string): DecodedEntry | null {
  // Split on first two pipes only — endIso has no pipes either.
  const i1 = entry.indexOf('|');
  if (i1 < 0) return null;
  const i2 = entry.indexOf('|', i1 + 1);
  if (i2 < 0) return null;
  return {
    sourceId: entry.slice(0, i1),
    slug: entry.slice(i1 + 1, i2),
    endIso: entry.slice(i2 + 1),
  };
}

/** Returns the newest endIso for a given (sourceId, slug), or null if absent. */
function findCompletedEndIso(
  entries: string[],
  sourceId: string,
  slug: string,
): string | null {
  let best: string | null = null;
  for (const e of entries) {
    const d = decodeCheckpointEntry(e);
    if (!d) continue;
    if (d.sourceId !== sourceId) continue;
    if (d.slug !== slug) continue;
    if (best === null || d.endIso > best) best = d.endIso;
  }
  return best;
}

/** Returns entries with all (sourceId, slug)-matching rows stripped. */
function filterOutSlug(entries: string[], sourceId: string, slug: string): string[] {
  return entries.filter((e) => {
    const d = decodeCheckpointEntry(e);
    if (!d) return true;
    return !(d.sourceId === sourceId && d.slug === slug);
  });
}

// ---------------------------------------------------------------------------
// Body cap (Eng A2).
// ---------------------------------------------------------------------------

function pageBodyBytes(page: Page): number {
  const compiled = page.compiled_truth ?? '';
  const timeline = page.timeline ?? '';
  return Buffer.byteLength(compiled, 'utf8') + Buffer.byteLength(timeline, 'utf8');
}

// ---------------------------------------------------------------------------
// Types config resolver (Eng-v2 A2 — unified single source of truth).
// ---------------------------------------------------------------------------

const TYPES_CONFIG_KEY = 'cycle.conversation_facts_backfill.types';

async function resolveTypesFromConfig(
  engine: BrainEngine,
  explicit?: AllowedType[],
): Promise<AllowedType[]> {
  if (explicit && explicit.length > 0) return explicit;
  const raw = await engine.getConfig(TYPES_CONFIG_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed
          .filter((t): t is string => typeof t === 'string')
          .filter((t): t is AllowedType => (ALLOWED_TYPES as readonly string[]).includes(t));
        if (filtered.length > 0) return filtered;
      }
    } catch {
      // fall through to default
    }
  }
  // Default: full allowlist when no config and no explicit override.
  // Mirrors cycle.conversation_facts_backfill.types default.
  return [...ALLOWED_TYPES];
}

// ---------------------------------------------------------------------------
// v0.41.15.0 helpers (D2 lock + D6 rate-limited log + D11 delete-orphans).
// ---------------------------------------------------------------------------

/**
 * Lock id for the per-page advisory lock (D2). Includes the source so
 * two pages with the same slug in different sources don't false-share.
 */
export function extractConversationFactsLockId(sourceId: string, slug: string): string {
  return `extract-conversation-facts:${sourceId}:${slug}`;
}

/**
 * Per-page lock TTL (D12). 2 minutes — `withRefreshingLock` refreshes
 * at 1/6 the TTL (`Math.max(15000, 120_000/6) = 20s`) so a long page
 * (50 segments × Haiku ~3s) gets ~6 refreshes per minute. If the holder
 * process dies, the lock auto-expires within 2 minutes regardless.
 */
export const PER_PAGE_LOCK_TTL_MINUTES = 2;

/**
 * D6: in-memory rate-limit cache for lock-busy log lines. Keyed on
 * (source_id, minute-bucket) so we log at most once per source per
 * minute even under heavy contention. Pure process-local state.
 */
const _lockBusyLogCache = new Map<string, number>();

/** Test seam: clear the rate-limit cache so re-runs emit again. */
export function _resetLockBusyLogCacheForTest(): void {
  _lockBusyLogCache.clear();
}

function logLockBusyRateLimited(sourceId: string, slug: string): void {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `${sourceId}:${minuteBucket}`;
  if (_lockBusyLogCache.has(key)) return;
  _lockBusyLogCache.set(key, minuteBucket);
  // Best-effort cleanup: when the map grows past 100 entries, drop ones
  // older than 10 minutes. Avoids unbounded growth on multi-hour runs.
  if (_lockBusyLogCache.size > 100) {
    const cutoff = minuteBucket - 10;
    for (const [k, v] of _lockBusyLogCache) {
      if (v < cutoff) _lockBusyLogCache.delete(k);
    }
  }
  process.stderr.write(
    `[extract-conversation-facts] lock-busy for ${sourceId}:${slug} (and possibly more); skipping — another worker holds it. Page will be retried on next enumeration.\n`,
  );
}

/**
 * D11: delete-orphans-first replay safety. Removes any facts row written
 * by a prior crashed / killed / partial run for this (sourceId, slug)
 * pair, scoped to fact rows with this command's source-prefix so we
 * never touch facts written by other paths (extract.ts, facts/absorb,
 * markdown fences, etc.).
 *
 * The terminal audit row (source=TERMINAL_AUDIT_SOURCE) is ALSO deleted
 * here — if a prior run wrote it after partial inserts (the
 * pre-v0.41.15.0 bug class codex caught), we want a clean slate. A
 * fresh run will re-write the terminal row only after every segment's
 * insertFacts succeeds.
 *
 * Returns the number of rows deleted (surfaced in the result counter
 * for operator observability; non-zero means a prior run crashed).
 */
async function deleteOrphanFactsForPage(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
): Promise<number> {
  try {
    // The two write-source variants this command may have left behind:
    //   - PER_SEGMENT_SOURCE_PREFIX  ('cli:extract-conversation-facts')
    //   - TERMINAL_AUDIT_SOURCE      ('cli:extract-conversation-facts:terminal')
    // Using a LIKE prefix match covers both with one statement.
    const rows = await engine.executeRaw<{ count: string }>(
      `WITH del AS (
         DELETE FROM facts
         WHERE source_id = $1
           AND source_markdown_slug = $2
           AND source LIKE 'cli:extract-conversation-facts%'
         RETURNING 1
       )
       SELECT COUNT(*)::text AS count FROM del`,
      [sourceId, slug],
    );
    const n = parseInt(rows[0]?.count ?? '0', 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // Best-effort: a missing source_markdown_slug column on pre-v0.32
    // brains (or other rare DDL drift) falls through to "no orphans
    // cleaned." The subsequent insertFacts call will surface any real
    // schema issues with a clearer error.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Core extraction loop (single source).
// ---------------------------------------------------------------------------

interface ExtractCoreState {
  result: ExtractConversationFactsResult;
  engine: BrainEngine;
  sourceId: string;
  dryRun: boolean;
  sleepMs: number;
  segmentLimit: number;
  types: AllowedType[];
  signal: AbortSignal | undefined;
  /**
   * v0.41.15.0 (D11): shared per-(sourceId, slug) checkpoint map mutated
   * in place from processPage callers. Map.set is atomic in JS's single-
   * threaded event loop so parallel workers (D9) don't clobber each
   * other. Serialized to op-checkpoint string[] via recordCompleted at
   * batch boundaries + final flush.
   */
  cpMap: Map<string, string>;
}

function cpMapKey(sourceId: string, slug: string): string {
  return `${sourceId}|${slug}`;
}

function cpMapToEntries(map: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, endIso] of map) {
    const i = key.indexOf('|');
    if (i < 0) continue;
    const sourceId = key.slice(0, i);
    const slug = key.slice(i + 1);
    out.push(encodeCheckpointEntry(sourceId, slug, endIso));
  }
  return out;
}

function cpEntriesToMap(entries: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const d = decodeCheckpointEntry(e);
    if (!d) continue;
    // Newest-endIso wins on duplicates (defensive against pre-fix
    // entries that may have stacked).
    const key = cpMapKey(d.sourceId, d.slug);
    const prior = map.get(key);
    if (prior === undefined || d.endIso > prior) map.set(key, d.endIso);
  }
  return map;
}

async function processPage(
  state: ExtractCoreState,
  page: Page,
  sinceIso: string | undefined,
): Promise<{ newEndIso: string | null }> {
  state.result.pages_considered++;

  // Body cap check first — pre-parse, pre-segment, pre-extraction.
  const bytes = pageBodyBytes(page);
  if (bytes > MAX_PAGE_BODY_BYTES) {
    state.result.pages_skipped_too_large++;
    process.stderr.write(
      `[extract-conversation-facts] SKIP ${page.slug}: ${(bytes / 1024 / 1024).toFixed(1)}MB exceeds 25MB cap\n`,
    );
    return { newEndIso: null };
  }

  const body = await readConversationBodyForParsing(state.engine, page);
  // v0.41.13.0: thread the full Page through the orchestrator so D8
  // date-derivation chain (frontmatter.date > effective_date >
  // '1970-01-01') AND timezone_policy warnings apply. The historical
  // `parseConversationMessages(body)` shape only saw the body, which
  // meant Telegram-bracket pages with frontmatter dates landed at
  // 1970-01-01. Now they pick up the correct date.
  const parseResult = parseConversation(body, { page });
  const messages = parseResult.messages;
  if (parseResult.timezone_warning) {
    process.stderr.write(parseResult.timezone_warning + '\n');
  }
  const segments = splitIntoSegments(messages, { sinceIso });
  if (segments.length === 0) {
    state.result.pages_skipped++;
    return { newEndIso: null };
  }

  // D11: delete-orphans-first replay safety. Wipes any facts written by
  // a prior crashed / killed / partial run for this (sourceId, slug)
  // pair before we re-extract. The lock we hold (D2 + D12 refreshing
  // lock above the caller) guarantees no other worker is writing to
  // this page right now, so the DELETE+INSERT pair is safe.
  if (!state.dryRun) {
    const cleaned = await deleteOrphanFactsForPage(state.engine, state.sourceId, page.slug);
    if (cleaned > 0) {
      state.result.orphan_facts_cleaned += cleaned;
      process.stderr.write(
        `[extract-conversation-facts] cleaned ${cleaned} orphan fact(s) for ${page.slug} from prior partial run\n`,
      );
    }
  }

  // Page-global row_num: after delete-orphans-first the table has no
  // rows for this (sourceId, slug), so we always start from 0. Peek
  // is kept as a defensive fallback for dry-run + non-deleting paths.
  let rowNum = state.dryRun
    ? await peekRowNumStart(state.engine, state.sourceId, page.slug)
    : 0;
  let newestEnd: string | null = null;
  let segmentsThisPage = 0;
  let pageInsertedTotal = 0;

  for (const seg of segments) {
    if (state.segmentLimit > 0 && segmentsThisPage >= state.segmentLimit) break;
    if (state.signal?.aborted) throw new Error('aborted');

    const text = renderSegmentForExtraction(page.title || page.slug, seg);
    const sessionId = `${PER_SEGMENT_SOURCE_PREFIX}:${page.slug}`;

    let extracted: Awaited<ReturnType<typeof extractFactsFromTurn>> = [];
    try {
      extracted = await extractFactsFromTurn({
        turnText: text,
        sessionId,
        source: PER_SEGMENT_SOURCE_PREFIX,
        engine: state.engine,
        abortSignal: state.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (err instanceof BudgetExhausted) throw err;
      // Per-segment LLM failures are best-effort; loop continues.
      process.stderr.write(
        `[extract-conversation-facts] segment ${seg.startIso}..${seg.endIso} extractor failed: ${(err as Error).message}\n`,
      );
      extracted = [];
    }

    state.result.segments_processed++;
    segmentsThisPage++;
    state.result.facts_extracted += extracted.length;

    if (!state.dryRun && extracted.length > 0) {
      // Eng-v2 C1 / E11: page-global row_num. Each fact in this batch gets
      // a unique row_num within (source_id, source_markdown_slug); the
      // accumulator increments across the segment loop.
      const rows = extracted.map((fact, i) => ({
        ...fact,
        row_num: rowNum + i,
        source_markdown_slug: page.slug,
        source: PER_SEGMENT_SOURCE_PREFIX,
        source_session: sessionId,
        context:
          fact.context ?? `from ${page.slug} segment ${seg.startIso}..${seg.endIso}`,
      }));
      try {
        const ins = await state.engine.insertFacts(rows, { source_id: state.sourceId }); // gbrain-allow-direct-insert: canonical bulk extraction path for conversation pages — fences-as-system-of-record doesn't apply because conversations don't carry `## Facts` fences (the chat-log shape is the source-of-truth)
        pageInsertedTotal += ins.inserted;
        state.result.facts_inserted += ins.inserted;
      } catch (err) {
        if (isAbortError(err)) throw err;
        // Batch failure is best-effort — segment is the transactional
        // boundary, so a duplicate-key or constraint error rolls back
        // this segment only. Loop continues.
        process.stderr.write(
          `[extract-conversation-facts] segment ${seg.startIso}..${seg.endIso} insertFacts failed: ${(err as Error).message}\n`,
        );
      }
      rowNum += extracted.length;
    } else {
      // dry-run: count for reporting, no DB write.
      rowNum += extracted.length;
    }

    newestEnd = seg.endIso;
    if (state.sleepMs > 0) await sleep(state.sleepMs);
  }

  // Eng-v2 C7 / E16: write terminal audit row after all segments commit
  // successfully. Only run when not dry-run AND we got through every
  // segment (no break on segmentLimit; that's an explicit partial run).
  const fullyProcessed =
    state.segmentLimit === 0 || segmentsThisPage < state.segmentLimit;
  if (!state.dryRun && fullyProcessed && newestEnd !== null) {
    try {
      await writeTerminalAuditRow(state.engine, state.sourceId, page.slug, rowNum);
      rowNum++;
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Terminal-row write failure: page is NOT marked complete; next
      // run resumes. Loud stderr so users see partial-success state.
      process.stderr.write(
        `[extract-conversation-facts] ${page.slug} terminal audit write failed: ${(err as Error).message}\n`,
      );
      // Suppress the resume-state update so doctor still flags this page.
      newestEnd = null;
    }
  }

  if (!state.dryRun && newestEnd !== null) {
    // v0.41.15.0 (codex #5/#6): per-page atomic checkpoint write. Mutate
    // the shared Map in place — JS single-threaded event loop makes
    // Map.set atomic across parallel workers; we don't need a load-mutate-
    // flush race. Map serializes back to op-checkpoint string[] at batch
    // boundaries via the caller's periodic recordCompleted call.
    state.cpMap.set(cpMapKey(state.sourceId, page.slug), newestEnd);
  }

  process.stderr.write(
    `[extract-conversation-facts] ${page.slug}: ${pageInsertedTotal} facts inserted across ${segmentsThisPage} segments\n`,
  );

  state.result.pages_processed++;
  return { newEndIso: newestEnd };
}

async function writeTerminalAuditRow(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  rowNum: number,
): Promise<void> {
  const fact: NewFact & { row_num: number; source_markdown_slug: string } = {
    fact: 'EXTRACTION_COMPLETE',
    kind: 'fact',
    entity_slug: null,
    source: TERMINAL_AUDIT_SOURCE,
    source_session: `${TERMINAL_AUDIT_SOURCE}:${slug}`,
    confidence: 1.0,
    notability: 'low',
    row_num: rowNum,
    source_markdown_slug: slug,
  };
  await engine.insertFacts([fact], { source_id: sourceId }); // gbrain-allow-direct-insert: page-level TERMINAL audit row (Codex C7 / E16) marks extraction completion in the durable facts table — there's no fence equivalent because this is internal audit state, not user-facing knowledge
}

/**
 * Core entry point — one source per call. Caller (CLI / Minion / cycle
 * phase) handles multi-source iteration externally.
 *
 * Budget tracker semantics:
 *   - If `opts.budgetTracker` is set: use it as-is (no wrap). Caller
 *     owns lifecycle; nested wrap would REPLACE the active tracker.
 *   - If absent: create a fresh tracker scoped to `opts.maxCostUsd`
 *     and run the body inside `withBudgetTracker`.
 */
export async function runExtractConversationFactsCore(
  engine: BrainEngine,
  opts: ExtractConversationFactsCoreOpts,
  signal?: AbortSignal,
): Promise<ExtractConversationFactsResult> {
  const sourceId = opts.sourceId;
  if (!sourceId) {
    throw new Error('runExtractConversationFactsCore: opts.sourceId is required');
  }

  const result: ExtractConversationFactsResult = {
    pages_considered: 0,
    pages_processed: 0,
    pages_skipped: 0,
    pages_skipped_too_large: 0,
    pages_skipped_disappeared: 0,
    pages_lock_skipped: 0,
    orphan_facts_cleaned: 0,
    segments_processed: 0,
    facts_extracted: 0,
    facts_inserted: 0,
  };

  // F2: honor brain-wide kill-switch unless overridden.
  if (!opts.overrideDisabled) {
    const enabled = await isFactsExtractionEnabled(engine);
    if (!enabled) {
      throw new Error(
        'facts.extraction_enabled=false; pass --override-disabled to force-run',
      );
    }
  }

  // v0.41.15.0 (D15): preflight facts.embedding dim check. Throws a
  // paste-ready ALTER hint BEFORE the first insert if the configured
  // embedding_dimensions differs from the facts column width. Doctor
  // also warns, but doctor-only doesn't close the bug class: new users
  // who skip doctor crash on first insert with the opaque pgvector
  // error. Preflight catches them up-front. Result cached per process.
  if (!opts.dryRun) {
    await assertFactsEmbeddingDimMatchesConfig(engine);
  }

  const types = await resolveTypesFromConfig(engine, opts.types);
  const dryRun = !!opts.dryRun;
  const sleepMs = opts.sleepMs ?? DEFAULT_INTER_CALL_SLEEP_MS;
  const segmentLimit = opts.segmentLimit ?? 0;

  // v0.41.15.0 (D9): resolve effective worker count via the PGLite-clamp
  // wrapper. Embedded engines silently become serial; the explicit
  // override + auto-concurrency rules from sync-concurrency.ts apply on
  // Postgres. Page count for the auto-path is unknown ahead of
  // enumeration, so pass 0 — the wrapper falls back to override-or-1.
  const workersResolved = resolveWorkersWithClamp(
    engine,
    opts.workers,
    'extract-conversation-facts',
    0,
  );
  const workers = workersResolved.workers;

  const state: ExtractCoreState = {
    result,
    engine,
    sourceId,
    dryRun,
    sleepMs,
    segmentLimit,
    types,
    signal,
    cpMap: new Map(),
  };

  // Run body. Either inside the externally-provided tracker scope (no
  // wrap; opts.budgetTracker is in scope upstream OR caller passes it
  // explicitly via withBudgetTracker), or inside a fresh local wrap.
  const body = async () => {
    const cpKey = checkpointKey(sourceId);
    const initialEntries = await loadOpCheckpoint(engine, cpKey);
    // v0.41.15.0 (codex #5/#6): hold checkpoint state as a Map so
    // parallel workers (D9) can mutate it atomically per-page. Serialize
    // back to op-checkpoint string[] at batch boundaries + final flush.
    state.cpMap = cpEntriesToMap(initialEntries);

    /**
     * Wrap processPage in the per-page advisory lock (D2 + D12). The
     * pool's onItem closes over this so D6's skip-and-continue semantics
     * land at the right level: a lock-busy page increments the counter,
     * logs once per (source, minute), and the worker claims the next
     * page rather than blocking. A hard error from processPage propagates
     * up; the pool's onError='continue' captures it into failures[].
     */
    const processPageWithLock = async (page: Page): Promise<void> => {
      const lockId = extractConversationFactsLockId(sourceId, page.slug);

      let sinceIso: string | undefined;
      // Per-page resume: --force clears prior entries; normal path uses
      // the latest endIso for this (sourceId, slug) from the shared map.
      if (opts.force) {
        state.cpMap.delete(cpMapKey(sourceId, page.slug));
      }
      const checkpointed = state.cpMap.get(cpMapKey(sourceId, page.slug)) ?? null;
      sinceIso = pickLaterIso(checkpointed, opts.sinceIso);

      try {
        await withRefreshingLock(
          engine,
          lockId,
          () => processPage(state, page, sinceIso),
          { ttlMinutes: PER_PAGE_LOCK_TTL_MINUTES },
        ).then(() => undefined);
      } catch (err) {
        if (err instanceof LockUnavailableError) {
          // D6: skip-and-continue. Page stays in backlog; next
          // enumeration picks it up after the holder's terminal row
          // lands. Rate-limited log so contention doesn't spam stderr.
          state.result.pages_lock_skipped++;
          logLockBusyRateLimited(sourceId, page.slug);
          return;
        }
        throw err;
      }
    };

    if (opts.slug) {
      const page = await engine.getPage(opts.slug, { sourceId });
      if (!page) {
        result.pages_skipped_disappeared++;
        return;
      }
      if (!types.includes(page.type as AllowedType)) {
        result.pages_skipped++;
        return;
      }

      await processPageWithLock(page);
    } else {
      // Multi-page enumeration: paginate per-type at small batch size to
      // bound memory (Eng-v2 C8 — 10 × 25MB = 250MB worst case).
      // v0.41.15.0 (D9): inner per-page loop replaced with runSlidingPool
      // so parallel workers can claim pages from the batch. The pool
      // honors AbortSignal at each claim boundary and threads
      // BudgetExhausted abort (D13) automatically.
      let processedPagesCount = 0;
      pageLoop: for (const type of types) {
        let offset = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (signal?.aborted) throw new Error('aborted');
          if (opts.limit && processedPagesCount >= opts.limit) break pageLoop;

          const batch = await engine.listPages({
            type,
            sourceId,
            limit: PAGE_LIST_BATCH,
            offset,
          });
          if (batch.length === 0) break;

          // Respect --limit at batch granularity: clip the batch so we
          // never overshoot the cap by `workers - 1` extra pages.
          let claimable = batch;
          if (opts.limit) {
            const remaining = opts.limit - processedPagesCount;
            if (remaining < batch.length) claimable = batch.slice(0, remaining);
          }

          await runSlidingPool({
            items: claimable,
            workers,
            signal,
            onItem: (page) => processPageWithLock(page),
            failureLabel: (page) => page.slug,
          });

          processedPagesCount += claimable.length;
          offset += batch.length;
          if (batch.length < PAGE_LIST_BATCH) break;

          // Persist checkpoint between batches so a crash mid-walk
          // doesn't lose all progress.
          if (!dryRun) {
            await recordCompleted(engine, checkpointKey(sourceId), cpMapToEntries(state.cpMap));
          }
        }
      }
    }

    // Final checkpoint flush.
    if (!dryRun) {
      await recordCompleted(engine, checkpointKey(sourceId), cpMapToEntries(state.cpMap));
    }
  };

  try {
    if (opts.budgetTracker) {
      // Caller-managed scope — use as-is, no wrap (nested wrap REPLACES
      // tracker per gateway.ts AsyncLocalStorage semantics).
      await body();
    } else {
      const tracker = new BudgetTracker({
        maxCostUsd: opts.maxCostUsd ?? DEFAULT_MAX_COST_USD,
        label: `extract-conversation-facts:${sourceId}`,
      });
      try {
        await withBudgetTracker(tracker, body);
      } finally {
        result.spent_usd = tracker.totalSpent;
      }
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      result.budget_exhausted = true;
      if (opts.budgetTracker) {
        result.spent_usd = opts.budgetTracker.totalSpent;
      }
      // Fall through to receipt+rollup write so the partial run is
      // still observable in extract_health doctor + extracts/ pages.
      await writeRunReceiptAndRollup(engine, sourceId, result, /* halted */ true);
      // Return partial result — caller (CLI / Minion) decides how to
      // surface. NOT a thrown failure.
      return result;
    }
    throw err;
  }

  // v0.42 — Wave B1: extract-conversation-facts writes a receipt page
  // (queryable + citable per D-EXTRACT-17/19) AND UPSERTs the per-day
  // rollup row (best-effort cache per F-OUT-19). Both are best-effort —
  // failures stderr-warn but never fail the parent operation.
  await writeRunReceiptAndRollup(engine, sourceId, result, /* halted */ false);

  return result;
}

/**
 * v0.42 — Wave B1: best-effort receipt + rollup writes at the end of an
 * extract-conversation-facts run. Skips the receipt page when the run
 * extracted ZERO facts (no-op runs don't need brain memory) but always
 * UPSERTs the rollup row so doctor sees the cycle ran.
 *
 * `halted` true means the run hit a budget cap mid-flight; receipt
 * carries that state in its frontmatter (round='full' regardless; the
 * halt is recorded as a halt_delta=1 in the rollup table).
 */
async function writeRunReceiptAndRollup(
  engine: BrainEngine,
  sourceId: string,
  result: ExtractConversationFactsResult,
  halted: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  // run_id: stable-ish identifier for this run. Includes day so multiple
  // runs of the same source on different days don't collide on the
  // receipt slug. shortRunId() truncates to 8 chars.
  const runId = `ecf-${Date.now().toString(36)}-${sourceId.slice(0, 4)}`;

  // Receipt write: only when the run actually inserted facts.
  if (result.facts_inserted > 0) {
    try {
      await writeReceipt(engine, {
        kind: 'facts.conversation',
        source_id: sourceId,
        run_id: runId,
        round: 'full',
        extracted_at: now,
        total_rows: result.facts_inserted,
        cost_usd: result.spent_usd ?? 0,
        summary: `Extracted ${result.facts_inserted} facts from ${result.pages_processed}/${result.pages_considered} eligible pages.`,
      });
    } catch (err) {
      // Best-effort: receipt write failure shouldn't kill the run.
      // The audit trail lives in the facts table (terminal rows) +
      // optionally the new audit JSONL once wired.
      const msg = (err as Error).message || String(err);
      console.error(`[extract-conversation-facts] receipt write failed: ${msg}`);
    }
  }

  // Rollup UPSERT: ALWAYS fire so doctor's extract_health sees the
  // cycle ran (even no-op runs are signal — they prove the extractor
  // was alive). Best-effort per F-OUT-19.
  await upsertExtractRollup(engine, {
    kind: 'facts.conversation',
    source_id: sourceId,
    cost_delta: result.spent_usd ?? 0,
    round_completed_delta: halted ? 0 : 1,
    halt_delta: halted ? 1 : 0,
  });
}

/**
 * Look up the max row_num already in facts for this (source_id, slug),
 * so the page-global accumulator continues from the right place on resume.
 */
async function peekRowNumStart(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ max_row: number | null }>(
      `SELECT COALESCE(MAX(row_num), -1) AS max_row
         FROM facts
        WHERE source_id = $1 AND source_markdown_slug = $2`,
      [sourceId, slug],
    );
    const maxRow = rows[0]?.max_row ?? -1;
    return Number(maxRow) + 1;
  } catch {
    // Pre-migration brains may not have source_markdown_slug populated.
    // Fall back to 0; insertFacts will fail with a clearer error if
    // there's a real collision.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CLI parsing + handler.
// ---------------------------------------------------------------------------

interface ParsedArgs {
  sourceId?: string;
  types?: AllowedType[];
  slug?: string;
  dryRun?: boolean;
  limit?: number;
  sinceIso?: string;
  force?: boolean;
  sleepMs?: number;
  segmentLimit?: number;
  maxCostUsd?: number;
  overrideDisabled?: boolean;
  /** v0.41.15.0 (D9): in-process parallel workers per source. */
  workers?: number;
  yes?: boolean;
  help?: boolean;
  error?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--force') { out.force = true; continue; }
    if (a === '--yes' || a === '-y') { out.yes = true; continue; }
    if (a === '--override-disabled') { out.overrideDisabled = true; continue; }
    if (a === '--slug') { out.slug = args[++i]; continue; }
    if (a === '--source-id') { out.sourceId = args[++i]; continue; }
    if (a === '--since') { out.sinceIso = args[++i]; continue; }
    if (a === '--types') {
      const v = args[++i] ?? '';
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = parts.filter((p) => !(ALLOWED_TYPES as readonly string[]).includes(p));
      if (bad.length > 0) {
        out.error = `Unknown type(s) in --types: ${bad.join(', ')}. Allowed: ${ALLOWED_TYPES.join(', ')}`;
        return out;
      }
      out.types = parts as AllowedType[];
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) out.limit = n;
      continue;
    }
    if (a === '--sleep') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n >= 0) out.sleepMs = n;
      continue;
    }
    if (a === '--segment-limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n >= 0) out.segmentLimit = n;
      continue;
    }
    if (a === '--max-cost-usd') {
      const n = parseFloat(args[++i] ?? '');
      if (Number.isFinite(n) && n > 0) out.maxCostUsd = n;
      continue;
    }
    if (a === '--workers' || a === '--concurrency') {
      try {
        out.workers = parseWorkers(args[++i]);
      } catch (e) {
        out.error = (e as Error).message;
        return out;
      }
      continue;
    }
    if (a.startsWith('--')) {
      out.error = `Unknown flag: ${a}`;
      return out;
    }
  }
  if (out.sinceIso) {
    const ms = Date.parse(out.sinceIso);
    if (!Number.isFinite(ms)) {
      out.error = `Invalid --since: ${out.sinceIso}`;
    }
  }
  return out;
}

const HELP = `Usage: gbrain extract-conversation-facts [options]

Batch-extract facts from conversation pages (and adjacent long-form
types: meeting, slack, email) into the facts table. Each page is parsed
into time-windowed segments and passed through the shared fact extractor
with a topical/temporal context header so the resulting facts retain
anchor terms ("Conversation between A and B on DATE …") that the
chunk-level embedding loses on long conversations.

Options:
  --source-id <id>       Source to operate on (default: 'default').
  --types <list>         Comma-separated subset of: ${ALLOWED_TYPES.join(', ')}.
                         Default: reads cycle.conversation_facts_backfill.types config
                         (falls back to the full allowlist).
  --slug <slug>          Process a single page (overrides multi-page enumeration).
  --dry-run              Show segmentation + counts; no DB writes, no checkpoint advance.
  --limit <N>            Cap pages processed (default: all).
  --since <iso>          Only consider messages newer than this ISO timestamp.
  --force                Re-process the target page (clears its resume entry).
  --sleep <ms>           Delay between extractor calls (default ${DEFAULT_INTER_CALL_SLEEP_MS}).
  --segment-limit <N>    Max segments per page (0 = unlimited).
  --max-cost-usd <FLOAT> Cost cap for this run (default ${DEFAULT_MAX_COST_USD}).
                         NOTE: under --workers N, the cap can be exceeded by up to
                         N × per-page-cost because per-worker reserve() calls aren't
                         serialized. At workers=20 × ~$0.02/page that's ~$0.40 over.
                         Pin --workers 1 if you need exact-ceiling compliance.
  --workers N            Parallel page workers within a single source. Default 1.
                         Recommended 5-20 for LLM-bound work on Postgres. PGLite
                         silently clamps to 1 (single-writer engine). Cross-process
                         safety is guaranteed by the per-page advisory lock + replay
                         safety (delete-orphans-first on each page claim).
  --override-disabled    Bypass facts.extraction_enabled=false brain-wide kill-switch.
  --background           Submit as a Minion job; print job_id; exit (use 'gbrain jobs follow').
  --yes                  Auto-confirm cost preview in non-TTY contexts.
  --help, -h             Show this help.

Multi-source: when --source-id is omitted, the command iterates ALL
sources from gbrain sources list. Per-source budget cap defaults to
--max-cost-usd; the brain-wide cap when running via the autopilot cycle
phase is cycle.conversation_facts_backfill.max_total_cost_usd.

Resumability: per-page completion is durable via a terminal audit row
in the facts table (source='${TERMINAL_AUDIT_SOURCE}'). gbrain doctor's
conversation_facts_backlog check counts pages without this row.
`;

function buildJobParams(args: string[]): Record<string, unknown> {
  const parsed = parseArgs(args);
  return {
    sourceId: parsed.sourceId,
    types: parsed.types,
    slug: parsed.slug,
    dryRun: parsed.dryRun,
    limit: parsed.limit,
    sinceIso: parsed.sinceIso,
    force: parsed.force,
    sleepMs: parsed.sleepMs,
    segmentLimit: parsed.segmentLimit,
    maxCostUsd: parsed.maxCostUsd,
    overrideDisabled: parsed.overrideDisabled,
    // v0.41.15.0 (D9): thread workers through the Minion job envelope
    // so `gbrain extract-conversation-facts --background --workers 20`
    // round-trips. The handler in src/commands/jobs.ts reads
    // job.data.workers and passes to runExtractConversationFactsCore.
    workers: parsed.workers,
  };
}

export async function runExtractConversationFacts(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  // --help short-circuit.
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  // --background path.
  const backgrounded = await maybeBackground({
    engine,
    args,
    jobName: 'extract-conversation-facts',
    paramBuilder: buildJobParams,
  });
  if (backgrounded) return;

  const parsed = parseArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    console.error(HELP);
    process.exit(1);
  }

  // Chat gateway is required for non-dry-run.
  if (!parsed.dryRun && !isAvailable('chat')) {
    console.error('Chat gateway unavailable. Configure an Anthropic or compatible chat model, or pass --dry-run to preview segmentation.');
    process.exit(1);
  }

  // Aggregate result across all sources.
  const aggregate: ExtractConversationFactsResult = {
    pages_considered: 0,
    pages_processed: 0,
    pages_skipped: 0,
    pages_skipped_too_large: 0,
    pages_skipped_disappeared: 0,
    pages_lock_skipped: 0,
    orphan_facts_cleaned: 0,
    segments_processed: 0,
    facts_extracted: 0,
    facts_inserted: 0,
  };
  let totalSpent = 0;
  let anyBudgetExhausted = false;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // Multi-source enumeration when --source-id NOT set.
  const sourceIds: string[] = parsed.sourceId
    ? [parsed.sourceId]
    : (await listSources(engine)).map((s) => s.id);

  progress.start('extract.conversation_facts', sourceIds.length);

  try {
    for (const sourceId of sourceIds) {
      const perSource = await runExtractConversationFactsCore(engine, {
        sourceId,
        types: parsed.types,
        slug: parsed.slug,
        dryRun: parsed.dryRun,
        limit: parsed.limit,
        sinceIso: parsed.sinceIso,
        force: parsed.force,
        sleepMs: parsed.sleepMs,
        segmentLimit: parsed.segmentLimit,
        maxCostUsd: parsed.maxCostUsd,
        overrideDisabled: parsed.overrideDisabled,
        workers: parsed.workers,
      });

      aggregate.pages_considered += perSource.pages_considered;
      aggregate.pages_processed += perSource.pages_processed;
      aggregate.pages_skipped += perSource.pages_skipped;
      aggregate.pages_skipped_too_large += perSource.pages_skipped_too_large;
      aggregate.pages_skipped_disappeared += perSource.pages_skipped_disappeared;
      aggregate.pages_lock_skipped += perSource.pages_lock_skipped;
      aggregate.orphan_facts_cleaned += perSource.orphan_facts_cleaned;
      aggregate.segments_processed += perSource.segments_processed;
      aggregate.facts_extracted += perSource.facts_extracted;
      aggregate.facts_inserted += perSource.facts_inserted;
      if (perSource.budget_exhausted) anyBudgetExhausted = true;
      if (perSource.spent_usd) totalSpent += perSource.spent_usd;

      progress.tick(1, `${sourceId}: ${perSource.facts_inserted} facts inserted`);
    }
  } finally {
    progress.finish();
  }

  const verb = parsed.dryRun ? '(dry run) would extract' : 'extracted';
  console.log(
    `\nDone: ${verb} ${aggregate.facts_extracted} facts ` +
    `(${aggregate.facts_inserted} inserted) across ${aggregate.segments_processed} segments ` +
    `from ${aggregate.pages_processed}/${aggregate.pages_considered} pages ` +
    `in ${sourceIds.length} source(s). ` +
    `Spent ~$${totalSpent.toFixed(4)}.`,
  );
  if (aggregate.pages_skipped > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped} page(s) with no new segments since last checkpoint.`);
  }
  if (aggregate.pages_skipped_too_large > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped_too_large} page(s) exceeding ${MAX_PAGE_BODY_BYTES / 1024 / 1024}MB body cap.`);
  }
  if (aggregate.pages_skipped_disappeared > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped_disappeared} page(s) that disappeared between enumeration and fetch.`);
  }
  if (aggregate.pages_lock_skipped > 0) {
    console.log(`  Skipped ${aggregate.pages_lock_skipped} page(s) held by another worker / process (will retry next run).`);
  }
  if (aggregate.orphan_facts_cleaned > 0) {
    console.log(`  Cleaned ${aggregate.orphan_facts_cleaned} orphan fact(s) from prior partial runs (D11 replay safety).`);
  }
  if (anyBudgetExhausted) {
    console.log(`  Budget cap reached. Re-run with a higher --max-cost-usd to continue.`);
  }

  // v0.41.15.0 (codex #3): exit 3 when pages were skipped due to
  // lock-busy AND no hard failures fired. "Incomplete run, please
  // re-run" — distinct from exit 1 (hard failure) and 0 (clean).
  // anyBudgetExhausted doesn't trigger exit 3; the budget message
  // above already tells the user what to do, and exit 0 is the right
  // signal for "ran to the cap intentionally."
  if (aggregate.pages_lock_skipped > 0 && !anyBudgetExhausted) {
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function pickLaterIso(
  a: string | null | undefined,
  b: string | null | undefined,
): string | undefined {
  const av = a ? Date.parse(a) : NaN;
  const bv = b ? Date.parse(b) : NaN;
  if (Number.isFinite(av) && Number.isFinite(bv)) return av >= bv ? a! : b!;
  if (Number.isFinite(av)) return a!;
  if (Number.isFinite(bv)) return b!;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /aborted|cancell?ed/i.test(err.message);
}
