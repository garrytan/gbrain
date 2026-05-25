/**
 * gbrain extract-conversation-facts — batch fact extraction for
 * conversation pages.
 *
 * Background
 * ----------
 * Conversation-type pages (imported chat logs, transcripts, etc.) can be
 * very large — tens of thousands of messages spanning years. The default
 * embedding pipeline chunks them into ~300-word blocks and prepends a tiny
 * page-title hint. That's enough for semantic search across short pages,
 * but it falls apart on long-running conversations:
 *
 *   - A user searches for "mountain cabin lock code" but the chunk that
 *     contains the literal code reads only "Locker 93 code 9494" — no
 *     mention of "cabin", "mountain", or any related topical anchor.
 *   - Retrieval misses, because the chunk-level embedding can't see the
 *     surrounding 50K messages of context that establish the topic.
 *
 * The facts table doesn't have this problem. Each row is a discrete claim
 * with its own embedding and entity linkage, and `gbrain search` already
 * blends facts into the result set. The extraction pipeline that builds
 * facts (`src/core/facts/extract.ts`) is already wired into real-time MCP
 * turns and the post-sync backstop — but it has never been run as a bulk
 * backfill over imported conversation history.
 *
 * This command closes that gap. For every conversation page (or a single
 * page when --slug is passed) it:
 *
 *   1. Parses the message body into time-windowed segments. Splits happen
 *      on time gaps greater than 30 minutes between adjacent messages, or
 *      whenever a segment hits ~50 messages — whichever comes first.
 *   2. Prepends each segment with a topical/temporal context header
 *      ("Conversation between {participants} on {date range}") so the
 *      extractor sees the same anchor the operator would when reading.
 *   3. Calls the EXISTING `extractFactsFromTurn()` from
 *      src/core/facts/extract.ts — no duplicate prompt — and inserts the
 *      results via `engine.insertFact()` with source =
 *      'cli:extract-conversation-facts'.
 *   4. Tracks per-page checkpoints in the brain config so re-runs are
 *      idempotent and pick up only new messages since the last run.
 *
 * Notability filter
 * -----------------
 * The shared extractor returns three notability tiers (high/medium/low).
 * Real-time paths drop "low" for signal-to-noise reasons. This command is
 * a bulk backfill over data we already chose to import, so all three
 * tiers are inserted. Low-notability facts still get their own embedding
 * and entity link — they just don't drive notifications.
 *
 * Rate limiting
 * -------------
 * Segments are processed sequentially with a small sleep between
 * extractor calls so we don't melt the chat provider on a 60K-message
 * page. The default delay is conservative; --concurrency stays at 1 by
 * design (the abort signal contract in extract.ts assumes serial use).
 *
 * Checkpoints
 * -----------
 * Per-page checkpoint key:
 *   facts.conversation_extraction_checkpoint.<slug>
 * Value is the ISO timestamp of the newest message processed. --force
 * clears the checkpoint before processing.
 */

import type { BrainEngine, NewFact } from '../core/engine.ts';
import { extractFactsFromTurn } from '../core/facts/extract.ts';
import { isAvailable } from '../core/ai/gateway.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

// ---------------------------------------------------------------------------
// Tunables. Exported for tests.
// ---------------------------------------------------------------------------

/** Maximum gap between adjacent messages before we cut a new segment. */
export const DEFAULT_SEGMENT_GAP_MINUTES = 30;

/** Hard cap on messages per segment before we cut, regardless of timing. */
export const DEFAULT_SEGMENT_MAX_MESSAGES = 50;

/** Minimum messages required for a segment to be worth extracting. */
export const MIN_SEGMENT_MESSAGES = 2;

/** Delay between extractor calls so we don't burst the chat provider. */
export const DEFAULT_INTER_CALL_SLEEP_MS = 200;

/** Cap on character length of the rendered segment passed to the extractor. */
export const SEGMENT_TEXT_CHAR_LIMIT = 7500;

const CHECKPOINT_PREFIX = 'facts.conversation_extraction_checkpoint.';

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
  /** Earliest message timestamp in the segment (ISO). */
  startIso: string;
  /** Latest message timestamp in the segment (ISO). */
  endIso: string;
  /** Distinct speakers in the segment, in first-seen order. */
  participants: string[];
}

export interface ExtractConversationFactsOpts {
  /** Process a single conversation slug; otherwise process all. */
  slug?: string;
  /** Report the work that would be done without inserting anything. */
  dryRun?: boolean;
  /** Maximum number of pages to process. */
  limit?: number;
  /**
   * Only consider messages with timestamp > sinceIso. Overrides the
   * stored checkpoint for the current run when more restrictive.
   */
  sinceIso?: string;
  /** Re-process even if a checkpoint already exists for the page. */
  force?: boolean;
  /** Delay (ms) between extractor calls. Default DEFAULT_INTER_CALL_SLEEP_MS. */
  sleepMs?: number;
  /** Source id to attribute the resulting facts to. Default 'default'. */
  sourceId?: string;
  /** Maximum segments to process per page (0 = unlimited). */
  segmentLimit?: number;
}

export interface ExtractConversationFactsResult {
  pages_considered: number;
  pages_processed: number;
  pages_skipped: number;
  segments_processed: number;
  facts_extracted: number;
  facts_inserted: number;
}

// ---------------------------------------------------------------------------
// Message parsing.
// ---------------------------------------------------------------------------

// Lines like: **Alice Example** (2024-03-15 6:07 PM): hello
const MESSAGE_LINE_RX =
  /^\*\*(.+?)\*\*\s*\((\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\)\s*:\s*(.*)$/;

/**
 * Parse a conversation page body into a flat list of messages. Lines that
 * don't match the pinned `**Name** (YYYY-MM-DD H:MM AM/PM): text` shape are
 * treated as continuations of the previous message (one extra line of body
 * text), which mirrors how the imessage importer renders multi-line texts.
 *
 * Exported for tests.
 */
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
      // Continuation of the last message body.
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

/**
 * Split a flat list of messages into time-bounded segments.
 *
 * Cuts happen when:
 *   1. The gap between adjacent message timestamps exceeds `gapMinutes`, or
 *   2. The current segment already holds `maxMessages` messages.
 *
 * Segments shorter than MIN_SEGMENT_MESSAGES are dropped — a single
 * isolated message rarely carries a complete claim worth extracting and
 * keeping them inflates extractor calls without lifting recall.
 *
 * Exported for tests.
 */
export function splitIntoSegments(
  messages: ConversationMessage[],
  opts: SplitSegmentsOpts = {},
): ConversationSegment[] {
  const gapMs = (opts.gapMinutes ?? DEFAULT_SEGMENT_GAP_MINUTES) * 60_000;
  const maxMessages = opts.maxMessages ?? DEFAULT_SEGMENT_MAX_MESSAGES;
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : NaN;

  const filtered = Number.isFinite(sinceMs)
    ? messages.filter(m => Date.parse(m.timestamp) > sinceMs)
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
// Segment rendering.
// ---------------------------------------------------------------------------

/**
 * Render a segment as the text payload passed to the extractor. Prepends
 * a topical/temporal context header so the model sees the same anchor a
 * human reader would.
 *
 * Exported for tests.
 */
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
    .map(m => `${m.speaker} (${m.timestamp}): ${m.text}`)
    .join('\n');
  const full = `${header}\n${body}`;
  if (full.length <= SEGMENT_TEXT_CHAR_LIMIT) return full;
  // Truncate from the end of the body, keeping the header intact so the
  // extractor still sees the topical anchor.
  const slack = SEGMENT_TEXT_CHAR_LIMIT - header.length - 16;
  return `${header}\n${body.slice(0, Math.max(0, slack))}\n…(truncated)`;
}

// ---------------------------------------------------------------------------
// Checkpoint helpers.
// ---------------------------------------------------------------------------

function checkpointKey(slug: string): string {
  return `${CHECKPOINT_PREFIX}${slug}`;
}

async function readCheckpoint(engine: BrainEngine, slug: string): Promise<string | null> {
  return engine.getConfig(checkpointKey(slug));
}

async function writeCheckpoint(engine: BrainEngine, slug: string, iso: string): Promise<void> {
  await engine.setConfig(checkpointKey(slug), iso);
}

async function clearCheckpoint(engine: BrainEngine, slug: string): Promise<void> {
  try {
    await engine.unsetConfig(checkpointKey(slug));
  } catch {
    /* engines without unset honor next setConfig overwrite */
  }
}

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

const HELP = `Usage: gbrain extract-conversation-facts [options]

Batch-extract facts from conversation pages into the facts table. Each
page is parsed into time-windowed segments and passed through the shared
fact extractor with a topical/temporal context header so the resulting
facts retain anchor terms ("Conversation between A and B on DATE …")
that the chunk-level embedding loses on long conversations.

Options:
  --slug <slug>          Process a single conversation page (path under brain).
  --dry-run              Show what would be extracted; insert nothing.
  --limit <N>            Max pages to process (default: all).
  --since <date>         Only process messages newer than this ISO date.
  --force                Re-process even when a checkpoint already exists.
  --sleep <ms>           Delay between extractor calls (default ${DEFAULT_INTER_CALL_SLEEP_MS}).
  --source-id <id>       Source id to attribute facts to (default: default).
  --segment-limit <N>    Max segments per page (0 = unlimited).
  --help, -h             Show this help.

The page list is the union of every page row with type='conversation'.
Per-page checkpoints are stored under \`${CHECKPOINT_PREFIX}<slug>\`.
`;

interface ParsedArgs extends ExtractConversationFactsOpts {
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
    if (a === '--slug') { out.slug = args[++i]; continue; }
    if (a === '--since') { out.sinceIso = args[++i]; continue; }
    if (a === '--source-id') { out.sourceId = args[++i]; continue; }
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

// ---------------------------------------------------------------------------
// Library entry point — usable from CLI and from tests.
// ---------------------------------------------------------------------------

export async function runExtractConversationFactsCore(
  engine: BrainEngine,
  opts: ExtractConversationFactsOpts = {},
): Promise<ExtractConversationFactsResult> {
  const sourceId = opts.sourceId ?? 'default';
  const sleepMs = opts.sleepMs ?? DEFAULT_INTER_CALL_SLEEP_MS;
  const segmentLimit = opts.segmentLimit ?? 0;
  const dryRun = !!opts.dryRun;

  const result: ExtractConversationFactsResult = {
    pages_considered: 0,
    pages_processed: 0,
    pages_skipped: 0,
    segments_processed: 0,
    facts_extracted: 0,
    facts_inserted: 0,
  };

  // Build candidate page list.
  let refs: Array<{ slug: string; source_id: string }>;
  if (opts.slug) {
    refs = [{ slug: opts.slug, source_id: sourceId }];
  } else {
    const allRefs = await engine.listAllPageRefs();
    refs = allRefs.filter(r => r.source_id === sourceId);
  }

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.conversation_facts', refs.length);

  let processedPages = 0;
  for (const ref of refs) {
    if (opts.limit && processedPages >= opts.limit) break;

    const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
    if (!page) { progress.tick(1); continue; }
    if (page.type !== 'conversation') { progress.tick(1); continue; }

    result.pages_considered++;

    if (opts.force) await clearCheckpoint(engine, ref.slug);
    const checkpoint = await readCheckpoint(engine, ref.slug);
    const sinceIso = pickLaterIso(checkpoint, opts.sinceIso);

    const body = page.compiled_truth ?? '';
    const messages = parseConversationMessages(body);
    const segments = splitIntoSegments(messages, { sinceIso });
    if (segments.length === 0) {
      result.pages_skipped++;
      progress.tick(1);
      continue;
    }

    let pageFactsExtracted = 0;
    let pageFactsInserted = 0;
    let newestSeen: string | null = null;
    let segmentsThisPage = 0;

    for (const seg of segments) {
      if (segmentLimit > 0 && segmentsThisPage >= segmentLimit) break;
      const text = renderSegmentForExtraction(page.title || ref.slug, seg);
      let extracted: Awaited<ReturnType<typeof extractFactsFromTurn>> = [];
      try {
        extracted = await extractFactsFromTurn({
          turnText: text,
          sessionId: `cli:extract-conversation-facts:${ref.slug}`,
          source: 'cli:extract-conversation-facts',
          engine,
          // Bulk backfill: keep extractor's default cap; sleep guards burst.
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        // Treat per-segment failures as best-effort.
        extracted = [];
      }

      result.segments_processed++;
      segmentsThisPage++;
      pageFactsExtracted += extracted.length;
      result.facts_extracted += extracted.length;

      if (!dryRun) {
        for (const fact of extracted) {
          try {
            // Bulk backfill keeps all notability tiers; real-time paths
            // drop "low" upstream.
            const newFact: NewFact = {
              fact: fact.fact,
              kind: fact.kind,
              entity_slug: fact.entity_slug ?? null,
              source: fact.source,
              source_session: fact.source_session ?? null,
              confidence: fact.confidence,
              notability: fact.notability,
              embedding: fact.embedding ?? null,
              claim_metric: fact.claim_metric ?? null,
              claim_value: fact.claim_value ?? null,
              claim_unit: fact.claim_unit ?? null,
              claim_period: fact.claim_period ?? null,
              context: `from ${ref.slug} segment ${seg.startIso}..${seg.endIso}`,
            };
            const ins = await engine.insertFact(newFact, { source_id: sourceId });
            if (ins.status === 'inserted' || ins.status === 'superseded') {
              pageFactsInserted++;
              result.facts_inserted++;
            }
          } catch (err) {
            if (isAbortError(err)) throw err;
            // Single-row failures (constraint, dedup race) are
            // best-effort. The rest of the segment continues.
          }
        }
      }

      newestSeen = seg.endIso;
      if (sleepMs > 0) await sleep(sleepMs);
    }

    if (!dryRun && newestSeen) {
      await writeCheckpoint(engine, ref.slug, newestSeen);
    }

    result.pages_processed++;
    processedPages++;
    progress.tick(1, `${ref.slug}: ${pageFactsInserted}/${pageFactsExtracted} facts`);
  }

  progress.finish();
  return result;
}

// ---------------------------------------------------------------------------
// CLI handler — what the dispatcher registers.
// ---------------------------------------------------------------------------

export async function runExtractConversationFacts(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(HELP);
    return;
  }
  if (parsed.error) {
    console.error(parsed.error);
    console.error(HELP);
    process.exit(1);
  }

  if (!isAvailable('chat') && !parsed.dryRun) {
    console.error('Chat gateway unavailable. Run with --dry-run to preview segment splits.');
    process.exit(1);
  }

  let result: ExtractConversationFactsResult;
  try {
    result = await runExtractConversationFactsCore(engine, parsed);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const verb = parsed.dryRun ? '(dry run) would extract' : 'extracted';
  console.log(
    `\nDone: ${verb} ${result.facts_extracted} facts ` +
    `(${result.facts_inserted} inserted) across ${result.segments_processed} segments ` +
    `from ${result.pages_processed}/${result.pages_considered} conversation pages.`,
  );
  if (result.pages_skipped > 0) {
    console.log(`  Skipped ${result.pages_skipped} page(s) with no new segments since last checkpoint.`);
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function pickLaterIso(a: string | null | undefined, b: string | null | undefined): string | undefined {
  const av = a ? Date.parse(a) : NaN;
  const bv = b ? Date.parse(b) : NaN;
  if (Number.isFinite(av) && Number.isFinite(bv)) return av >= bv ? a! : b!;
  if (Number.isFinite(av)) return a!;
  if (Number.isFinite(bv)) return b!;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /aborted|cancell?ed/i.test(err.message);
}
