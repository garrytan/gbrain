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
 *   - Body read covers compiled_truth + timeline. parseMarkdown splits
 *     conversation imports across both columns; reading only
 *     compiled_truth silently drops half on iMessage/Slack imports.
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
  clearOpCheckpoint,
  type OpCheckpointKey,
} from '../core/op-checkpoint.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions, maybeBackground } from '../core/cli-options.ts';
import { loadConfig } from '../core/config.ts';
import { createHash } from 'crypto';

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
}

export interface ExtractConversationFactsResult {
  pages_considered: number;
  pages_processed: number;
  pages_skipped: number;
  pages_skipped_too_large: number;
  pages_skipped_disappeared: number;
  segments_processed: number;
  facts_extracted: number;
  facts_inserted: number;
  budget_exhausted?: boolean;
  spent_usd?: number;
}

// ---------------------------------------------------------------------------
// Message parsing — lines like:
//   **Name** (YYYY-MM-DD H:MM AM/PM): text
// Unmatched lines become continuations of the prior message (multi-line
// imessage bodies).
// ---------------------------------------------------------------------------

const MESSAGE_LINE_RX =
  /^\*\*(.+?)\*\*\s*\((\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\)\s*:\s*(.*)$/;

export function parseConversationMessages(body: string): ConversationMessage[] {
  if (!body) return [];
  const out: ConversationMessage[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = MESSAGE_LINE_RX.exec(line);
    if (m) {
      const [, speaker, date, hStr, mStr, ampmRaw, text] = m;
      let hour = Number(hStr);
      const minute = Number(mStr);
      const ampm = (ampmRaw || '').toUpperCase();
      if (ampm === 'PM' && hour < 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      const iso = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
      out.push({
        speaker: speaker.trim(),
        timestamp: iso,
        text: (text || '').trim(),
      });
    } else if (out.length > 0) {
      const last = out[out.length - 1];
      last.text = last.text ? `${last.text}\n${line}` : line;
    }
  }
  return out;
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

function readPageBody(page: Page): string {
  // F1: read BOTH compiled_truth AND timeline; iMessage importers
  // place chronological message stream in timeline.
  const compiled = page.compiled_truth ?? '';
  const timeline = page.timeline ?? '';
  if (!compiled) return timeline;
  if (!timeline) return compiled;
  return `${compiled}\n\n${timeline}`;
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
}

async function processPage(
  state: ExtractCoreState,
  page: Page,
  sinceIso: string | undefined,
  cpEntries: string[],
  rowNumStart: number,
): Promise<{ newEndIso: string | null; rowNumAfter: number; cpEntriesAfter: string[] }> {
  state.result.pages_considered++;

  // Body cap check first — pre-parse, pre-segment, pre-extraction.
  const bytes = pageBodyBytes(page);
  if (bytes > MAX_PAGE_BODY_BYTES) {
    state.result.pages_skipped_too_large++;
    process.stderr.write(
      `[extract-conversation-facts] SKIP ${page.slug}: ${(bytes / 1024 / 1024).toFixed(1)}MB exceeds 25MB cap\n`,
    );
    return { newEndIso: null, rowNumAfter: rowNumStart, cpEntriesAfter: cpEntries };
  }

  const body = readPageBody(page);
  const messages = parseConversationMessages(body);
  const segments = splitIntoSegments(messages, { sinceIso });
  if (segments.length === 0) {
    state.result.pages_skipped++;
    return { newEndIso: null, rowNumAfter: rowNumStart, cpEntriesAfter: cpEntries };
  }

  let rowNum = rowNumStart;
  let entries = cpEntries;
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
    // Update op-checkpoint: filter out prior entries for this slug,
    // append the newest end. --force clears prior; normal case advances.
    entries = filterOutSlug(entries, state.sourceId, page.slug);
    entries.push(encodeCheckpointEntry(state.sourceId, page.slug, newestEnd));
  }

  process.stderr.write(
    `[extract-conversation-facts] ${page.slug}: ${pageInsertedTotal}/${state.result.facts_extracted - (state.result.facts_extracted - pageInsertedTotal)} facts inserted across ${segmentsThisPage} segments\n`,
  );

  state.result.pages_processed++;
  return { newEndIso: newestEnd, rowNumAfter: rowNum, cpEntriesAfter: entries };
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

  const types = await resolveTypesFromConfig(engine, opts.types);
  const dryRun = !!opts.dryRun;
  const sleepMs = opts.sleepMs ?? DEFAULT_INTER_CALL_SLEEP_MS;
  const segmentLimit = opts.segmentLimit ?? 0;

  const state: ExtractCoreState = {
    result,
    engine,
    sourceId,
    dryRun,
    sleepMs,
    segmentLimit,
    types,
    signal,
  };

  // Run body. Either inside the externally-provided tracker scope (no
  // wrap; opts.budgetTracker is in scope upstream OR caller passes it
  // explicitly via withBudgetTracker), or inside a fresh local wrap.
  const body = async () => {
    const cpKey = checkpointKey(sourceId);
    let cpEntries = await loadOpCheckpoint(engine, cpKey);

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

      if (opts.force) {
        cpEntries = filterOutSlug(cpEntries, sourceId, opts.slug);
      }
      const checkpointed = findCompletedEndIso(cpEntries, sourceId, opts.slug);
      const sinceIso = pickLaterIso(checkpointed, opts.sinceIso);

      const rowNumStart = await peekRowNumStart(engine, sourceId, opts.slug);
      const { cpEntriesAfter } = await processPage(state, page, sinceIso, cpEntries, rowNumStart);
      cpEntries = cpEntriesAfter;
    } else {
      // Multi-page enumeration: paginate per-type at small batch size to
      // bound memory (Eng-v2 C8 — 10 × 25MB = 250MB worst case).
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

          for (const page of batch) {
            if (opts.limit && processedPagesCount >= opts.limit) break pageLoop;

            const slug = page.slug;
            const checkpointed = findCompletedEndIso(cpEntries, sourceId, slug);

            // Terminal audit row check — if this page has the terminal
            // marker AND not --force, skip immediately (cheap probe via
            // the checkpointed value covers the recent-run case; the
            // expensive query is doctor's job, not per-page).
            const sinceIso = pickLaterIso(checkpointed, opts.sinceIso);
            const rowNumStart = await peekRowNumStart(engine, sourceId, slug);
            const { cpEntriesAfter } = await processPage(
              state,
              page,
              sinceIso,
              cpEntries,
              rowNumStart,
            );
            cpEntries = cpEntriesAfter;
            processedPagesCount++;
          }

          offset += batch.length;
          if (batch.length < PAGE_LIST_BATCH) break;

          // Persist checkpoint between batches so a crash mid-walk
          // doesn't lose all progress.
          if (!dryRun) {
            await recordCompleted(engine, checkpointKey(sourceId), cpEntries);
          }
        }
      }
    }

    // Final checkpoint flush.
    if (!dryRun) {
      await recordCompleted(engine, checkpointKey(sourceId), cpEntries);
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
      // Return partial result — caller (CLI / Minion) decides how to
      // surface. NOT a thrown failure.
      return result;
    }
    throw err;
  }

  return result;
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
      });

      aggregate.pages_considered += perSource.pages_considered;
      aggregate.pages_processed += perSource.pages_processed;
      aggregate.pages_skipped += perSource.pages_skipped;
      aggregate.pages_skipped_too_large += perSource.pages_skipped_too_large;
      aggregate.pages_skipped_disappeared += perSource.pages_skipped_disappeared;
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
  if (anyBudgetExhausted) {
    console.log(`  Budget cap reached. Re-run with a higher --max-cost-usd to continue.`);
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
