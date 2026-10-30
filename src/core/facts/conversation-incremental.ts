/**
 * Incremental conversation facts for a segmented page (wave-b spec 8.1, 8.2 "Conversation facts", 8.3; PR 4 lane 4b).
 *
 * Windows run over message boundaries across occurrences (conversation-stream.ts), so a window can span a segment cut;
 * each window belongs to the occurrence its first message starts in. Each window's facts carry its key in
 * facts.source_window (owner occurrence, ordinal, rendered-text sha). Per occurrence, a page_segment_derivations row
 * (kind conversation_facts) records the segment sha, a context hash (every page-level input the windows depend on:
 * title, gap setting, date context, extraction model, effective fact visibility), the windows whose facts it holds
 * (ordinal, sha, facts), its predecessor, whether its first message opens a gap group, the page's grammar, and the
 * failed attempts of windows not extracted yet.
 *
 * Deletion invariant. A run deletes a conversation fact in exactly two ways:
 *   (a) replacement: the fact's exact window key was extracted again in this run (or, for a move, the same rendered
 *       window's standing facts were re-anchored onto it), and its old facts give way in the transaction that adds the
 *       new ones;
 *   (b) collection at a fully settled run: every current window holds its facts (extracted or reused), none is failed,
 *       no cap or --segment-limit stopped the run, no --since filter applied and the page did not change underneath;
 *       only then does every fact whose window key is not a current window's (and every unanchored fact of an older
 *       full-pass run) go.
 * Every other run (interrupted, capped, limited, failed, --since, or with a failed window anywhere on the page) only
 * adds and replaces. A row claims exactly the window keys whose facts it holds: a window moved to another occurrence is
 * dropped from its old row in the transaction that re-anchors its facts. Purge and forget run separately and win.
 *
 * A run:
 *   - finds the first occurrence that is new, rewritten, moved or context-changed and streams the windows from the
 *     nearest earlier occurrence that opens a gap group (the windows before it cannot change), one segment at a time
 *     and in runs, newest run first, so a stop reads only the runs it reached; a page nothing changed on reads nothing;
 *   - parses under the page's grammar: the one detectPagePattern picks over the whole page (the whole-page pass's
 *     choice; one unpaid read, counted in conversationDetectionWork), pinned on the rows while the occurrences that
 *     recorded it under the same context are mostly unchanged by bytes (never rows written under an operator choice), or
 *     the one the operator chose for this page
 *     version (--grammar; none settles the page as non-extractable); with none detected while some built-in format still
 *     parses a message, the page is held (a detection_ambiguous receipt with each format's count for the page version;
 *     no call, nothing published or collected; a plain run on the same version reuses it without reading the page)
 *     until it changes or the operator chooses; a page no format parses a message in is not a
 *     conversation: it settles as non-extractable and its conversation facts are collected; a pinned grammar under which nothing parses is detected
 *     again; a detected grammar under which nothing parses leaves a no_messages receipt and changes nothing;
 *   - reuses every window an earlier run extracted with the same rendered text under the same context (re-anchored
 *     when it moved), so an append extracts only its new windows and the one it grew;
 *   - extracts the rest newest first, each call metered against the page's facts cap (meterPaidCall), and publishes
 *     every CONVERSATION_FACTS_CHECKPOINT_WINDOWS windows, when it stops and when a window throws or the run aborts;
 *   - counts a window whose extraction fails for a reason of its own (malformed or truncated output, a refusal or
 *     content filter, a provider refusal of the window's own input; never a transport, provider, auth, rate-limit, 5xx,
 *     timeout or abort failure) against it across runs; the run stops there, and once a window has failed
 *     WINDOW_FAILURE_LIMIT runs it is marked failed (a failed_windows receipt doctor lists) and the run moves on; the
 *     page is then stamped done but never collected until a --force run (retryFailed) extracts it.
 * A title or gap change re-extracts every window (documented cost); a no-op rewrite extracts nothing. Unmanaged brains
 * only: a managed brain keeps the receipted whole-page publication.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { deriveDateContext } from '../conversation-parser/parse.ts';
import { loadPricingOverrides, type PricingOverrides } from '../budget/budget-tracker.ts';
import { providerItemRefusal } from '../ai/errors.ts';
import { writeDerivedFacts } from '../persistence/derived-facts.ts';
import { estimateFactsExtractionUsd, meterPaidCall, unpricedModelReceipt } from '../page-embedding-budget.ts';
import { readExtractionReceipt, setExtractionReceipt, type InputTruncated } from '../extraction-watermark.ts';
import { planSegmentDerivations, segmentDerivationContextHash, sourceWindowFor, sourceWindowKey, type SegmentDerivationInput,
  type SegmentDerivationRow, type SourceWindow } from '../page-body/derivations.ts';
import { conversationDetectionWork, readConversationOccurrences, readOccurrenceText } from '../page-body/segment-conversation.ts';
import { emptySaveTimeResolutionCounts, mergeSaveTimeResolutionCounts } from '../entities/resolve-on-save.ts';
import { conversationEntityHints } from './conversation-entity-hints.ts';
import { countConversationFactsOutside, countWindowFacts, publishConversationFacts, type ConversationFactRow } from './conversation-publication.ts';
import { BUILTIN_PATTERNS } from '../conversation-parser/builtins.ts';
import { recordFailedPage } from './conversation-run-status.ts';
import { detectPagePattern, startsConversationRun, streamConversationWindows } from './conversation-stream.ts';
import type { ConversationSegment } from './conversation-types.ts';
import { renderSegmentForExtraction } from './conversation-windows.ts';
import { extractConversationWindow, nonExtractableAuditFact, regularPageVersionToken, terminalAuditFact, type ConversationWindowRun } from './conversation-window-extract.ts';
import { getFactsExtractionMaxTokens, resolveFactsExtractionModel, type ExtractInput } from './extract.ts';
import { tightenToPage, type FactVisibility } from './visibility.ts';

const KIND = 'conversation_facts';
/** Bump when the windowing or the row output changes shape: every occurrence is extracted again once. */
export const CONVERSATION_FACTS_DERIVATION_VERSION = 3;
/** Windows extracted between two publications of a page's facts and rows. */
export const CONVERSATION_FACTS_CHECKPOINT_WINDOWS = 8;
/**
 * Runs in which one window's extraction may throw before it is marked failed and skipped. extract.ts already retries a
 * truncated or malformed answer inside one run, so a window that still throws in three separate runs fails for a reason
 * of its own; three bounds what a doomed window costs at three reservations.
 */
export const WINDOW_FAILURE_LIMIT = 3;

/** The run counters this pass moves (a subset of ExtractConversationFactsResult). */
export interface SegmentedConversationCounters {
  pages_considered: number; pages_processed: number; pages_skipped: number; pages_skipped_insufficient_turns: number;
  pages_marked_non_extractable: number; pages_failed: number; segments_processed: number; facts_extracted: number;
  facts_inserted: number; orphan_facts_cleaned: number; fallback_slugify_count: number; resolution_errors: number;
  failed_pages: Array<{ slug: string; error: string }>;
  /** Pages held because no format is detected over them yet some format parses a message (a detection_ambiguous receipt). */
  pages_detection_ambiguous?: number;
  /** --grammar --dry-run: what a run under the chosen format would extract and collect, per page. */
  grammar_previews?: GrammarPreview[];
}

/** What a run under the operator's format (null: none) would do on one page: its messages and windows, the windows it would extract, and the facts its settled collection would remove. */
export interface GrammarPreview { source_id: string; slug: string; grammar: string | null; messages: number; windows: number; windows_to_extract: number; facts_to_collect: number }

export interface SegmentedConversationRun extends ConversationWindowRun {
  result: SegmentedConversationCounters;
  dryRun: boolean;
  sleepMs: number;
  /** At most this many windows per page per run (0: no limit). */
  segmentLimit: number;
}

/** A window an occurrence row holds the facts of: ordinal, rendered-text sha, facts its key holds, and why it failed when it did. */
interface WindowRecord { ordinal: number; sha: string; facts: number; failed?: WindowFailure }
/** Failed extraction attempts of one window (by rendered-text sha) and the last error. */
interface WindowFailure { attempts: number; error: string }
interface RowOutput { windows: WindowRecord[]; starts_group?: boolean; prev?: number | null; pattern?: string | null; chosen?: boolean; retries?: Array<{ sha: string } & WindowFailure> }
/** One window of the stream: `reused` (an earlier run's facts stand), `todo`, `extracted` by this run, or `failed` past the limit. */
interface StreamWindow { owner: number; seg: ConversationSegment; text: string | null; window: SourceWindow;
  state: 'reused' | 'todo' | 'extracted' | 'failed'; facts: number; failed?: WindowFailure }
type Stop = 'segment_limit' | 'cap_reached' | 'purge_sweep_pending' | 'interrupted' | null;

/** The bounded output a conversation_facts row stores (window anchors and counts; never text). */
function rowOutput(row: SegmentDerivationInput | undefined): RowOutput {
  const output = row?.output as Partial<RowOutput> | null | undefined;
  return { windows: Array.isArray(output?.windows) ? output.windows : [], starts_group: output?.starts_group, prev: output?.prev,
    pattern: output?.pattern ?? null, chosen: output?.chosen === true, retries: Array.isArray(output?.retries) ? output.retries : [] };
}

const keyOf = (occurrenceId: number, w: WindowRecord) => sourceWindowKey({ occurrence_id: occurrenceId, window_ordinal: w.ordinal, window_text_sha: w.sha });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Every page-level input the windows depend on: the context hash. */
async function conversationContext(engine: BrainEngine, page: Page, gapMinutes: number | null, visibility: FactVisibility) {
  const dates = deriveDateContext({ page });
  const model = (await resolveFactsExtractionModel(engine)).model;
  return { model, inputs: { title: page.title || page.slug, gap_minutes: gapMinutes, date: dates.fallbackDate, timezone: dates.timezone ?? null, model, visibility } };
}

/** extract.ts failure reasons caused by the window itself (its output or its content), which repeat until it changes. */
const WINDOW_SPECIFIC_REASONS: ReadonlySet<string> = new Set(['malformed_output', 'truncated_output', 'refusal', 'content_filter']);

/**
 * Whether a window's extraction error counts against the window: a failure of the window's own (WINDOW_SPECIFIC_REASONS,
 * or a provider refusal of its own input such as a context-length error). A transport, provider, auth, rate-limit,
 * 5xx, timeout or abort failure, a cap, or an error with no extraction reason never counts.
 */
function windowFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return false;
  const reason = (error as { extractionReason?: unknown } | null)?.extractionReason;
  if (typeof reason !== 'string') return false;
  if (WINDOW_SPECIFIC_REASONS.has(reason)) return true;
  return reason === 'provider_error' && providerItemRefusal((error as { cause?: unknown }).cause) !== null;
}

/** The messages each built-in format parses over the whole page, for the formats that parse any (unpaid reads). */
async function messagesByGrammar(occurrences: Parameters<typeof streamConversationWindows>[0], opts: { page: Page; gapMinutes: number | null },
  readText: (index: number) => Promise<string>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { id } of BUILTIN_PATTERNS) {
    const parsed = await streamConversationWindows(occurrences, 0, occurrences.length, { ...opts, pattern: id }, readText, { window() {}, occurrence() {} });
    if (parsed.messages > 0) counts[id] = parsed.messages;
  }
  return counts;
}

/**
 * Whether the run must stream from the page's head instead of reusing the rows before its start: a row there recorded
 * another grammar than the run's (`pattern`; with it undefined, the rows disagree among themselves), or was written under
 * an operator choice that no longer applies. Windows with the same rendered text are reused either way.
 */
function grammarRestart(rows: Array<SegmentDerivationRow | undefined>, pattern: string | null | undefined, choice: string | null | undefined): boolean {
  const outputs = rows.filter((row): row is SegmentDerivationRow => !!row).map(rowOutput);
  if (choice === undefined && outputs.some(o => o.chosen)) return true;
  const grammars = new Set(outputs.map(o => o.pattern ?? null));
  return pattern === undefined ? grammars.size > 1 : [...grammars].some(g => g !== pattern);
}

/**
 * One segmented page's conversation facts, incrementally (module doc). `gapMinutes` is the page's own
 * conversation_segment_gap_minutes (null: the default). Returns the end of the newest window it extracted.
 */
export async function processSegmentedConversationPage(run: SegmentedConversationRun, page: Page,
  opts: { gapMinutes: number | null; sinceIso?: string; retryFailed?: boolean; redetect?: boolean; grammar?: string | null }): Promise<{ newestEnd: string | null }> {
  const { engine, sourceId, result } = run;
  if (!opts.redetect) result.pages_considered++;
  const versionToken = regularPageVersionToken(page);
  const factVisibility = tightenToPage(run.factVisibility, page);
  const { model, inputs } = await conversationContext(engine, page, opts.gapMinutes, factVisibility);
  const contextHash = segmentDerivationContextHash(KIND, { entryState: null, page: inputs });
  const { body, occurrences } = await readConversationOccurrences(engine, page.id);
  const live = occurrences.map(o => ({ occurrenceId: o.row.occurrenceId, sha256: o.row.sha256, contextHash }));
  const liveIds = live.map(segment => segment.occurrenceId);
  const prior = await engine.readSegmentDerivations(page.id, { kind: KIND });
  const plan = planSegmentDerivations(KIND, CONVERSATION_FACTS_DERIVATION_VERSION, live, prior);
  const priorRow = new Map(prior.map(row => [row.occurrenceId, row]));
  const current = new Set(plan.current.map(row => row.occurrenceId));
  const sameContext = (row: SegmentDerivationRow) => row.version === CONVERSATION_FACTS_DERIVATION_VERSION && hex(row.contextHash) === hex(contextHash);
  const prevOf = (i: number) => (i === 0 ? null : liveIds[i - 1]!);
  const intact = (i: number) => {
    const output = rowOutput(priorRow.get(liveIds[i]!));
    return current.has(liveIds[i]!) && (output.prev ?? null) === prevOf(i) && !(opts.retryFailed && output.windows.some(w => w.failed));
  };
  // The first occurrence whose windows may have changed (one past the last when only trailing occurrences left), and
  // the nearest earlier occurrence that opens a gap group: the stream starts there.
  let first = liveIds.findIndex((_, i) => !intact(i));
  if (first < 0) first = plan.retired.length ? liveIds.length : -1;
  let from = first < 0 ? liveIds.length : 0;
  for (let i = Math.min(first, liveIds.length) - 1; i > 0; i--) {
    if (intact(i) && rowOutput(priorRow.get(liveIds[i]!)).starts_group === true) { from = i; break; }
  }
  const position = new Map(liveIds.map((id, i) => [id, i]));
  // The grammar: pinned while the occurrences whose rows recorded it under this context are, by bytes, mostly unchanged
  // (an append or an edit keeps it; a re-import does not), else detected over the whole page.
  const liveOccurrence = new Map(occurrences.map(o => [o.row.occurrenceId, o.row]));
  const recorded = prior.filter(row => sameContext(row) && liveOccurrence.has(row.occurrenceId) && rowOutput(row).pattern);
  const kept = recorded.filter(row => hex(liveOccurrence.get(row.occurrenceId)!.sha256) === hex(row.segmentSha256));
  const bytesOf = (rows: SegmentDerivationRow[]) => rows.reduce((n, row) => n + liveOccurrence.get(row.occurrenceId)!.byteLen, 0);
  // The operator's format for the page (gbrain extract-conversation-facts --grammar): this run's, else the one chosen for
  // this page version. It covers the whole page, so the stream starts at its head; none (null) settles it as non-extractable.
  const stored = opts.grammar === undefined ? await readExtractionReceipt(engine, page.id, KIND) : null;
  const choice = opts.grammar !== undefined ? opts.grammar
    : stored?.kind === 'grammar_chosen' && stored.version_token === versionToken ? stored.grammar ?? null : undefined;
  const choiceReceipt: InputTruncated | null = choice === undefined ? null : { kind: 'grammar_chosen', pipeline: KIND, processed_chars: 0, grammar: choice, version_token: versionToken };
  if (opts.grammar !== undefined && !run.dryRun) await setExtractionReceipt(engine, page.id, KIND, choiceReceipt);
  if (choice !== undefined || grammarRestart(liveIds.slice(0, from).map(id => priorRow.get(id)), undefined, choice)) from = 0;
  let pattern = choice !== undefined ? choice
    : !opts.redetect && kept.length && 2 * bytesOf(kept) > bytesOf(recorded) && !recorded.some(row => rowOutput(row).chosen) ? rowOutput(kept[0]).pattern ?? null : null;
  const pinned = choice === undefined && pattern !== null;
  const detectedBytes = conversationDetectionWork.bytes;
  const hold = async (grammars: Record<string, number>, checked: boolean) => {
    if (checked && !run.dryRun) await setExtractionReceipt(engine, page.id, KIND, { kind: 'detection_ambiguous', pipeline: KIND, processed_chars: 0, grammars, version_token: versionToken });
    result.pages_detection_ambiguous = (result.pages_detection_ambiguous ?? 0) + 1;
    process.stderr.write(`[extract-conversation-facts] ${page.slug}: held${checked ? '' : ' (unchanged since it was held, nothing read)'}: no format is detected over the page, yet ${Object.entries(grammars).map(([id, n]) => `${id} parses ${n}`).join(', ')} message(s); its facts were kept and nothing was extracted; gbrain extract-conversation-facts --source-id ${sourceId} --slug ${page.slug} --grammar <format|none> --dry-run previews a choice\n`);
    return { newestEnd: null };
  };
  // A page held at this version stays held without reading it (a --force run checks it again).
  const heldAt = choice === undefined && !opts.retryFailed && !opts.sinceIso && stored?.kind === 'detection_ambiguous' && stored.version_token === versionToken ? stored.grammars : undefined;
  if (heldAt && !pattern && from < liveIds.length) return hold(heldAt, false);
  if (choice === undefined && !pattern && from < liveIds.length) pattern = await detectPagePattern(occurrences, i => readOccurrenceText(engine, body, occurrences[i]!.row, { detection: true }));
  if (choice === undefined && !pattern && from < liveIds.length) {
    if (opts.sinceIso) { result.pages_skipped++; return { newestEnd: null }; }
    // No format is detected over the whole page. One that still parses a message may be the page's (text around a
    // transcript can tip the density test) or a quoted part of it: the page is held (no call, nothing published or
    // collected, a detection_ambiguous receipt with each format's count for this version) until it changes or the operator
    // chooses. A page no format parses a message in is not a transcript: it settles as non-extractable below, collected.
    const grammars = await messagesByGrammar(occurrences, { page, gapMinutes: opts.gapMinutes }, i => readOccurrenceText(engine, body, occurrences[i]!.row, { detection: true }));
    if (Object.keys(grammars).length) return hold(grammars, true);
    from = 0;
  }
  if (pattern && grammarRestart(liveIds.slice(0, from).map(id => priorRow.get(id)), pattern, choice)) from = 0;
  // Earlier windows of the occurrences the stream covers (and of retired ones), reusable by rendered text under the same context.
  const reusable = new Map<string, Array<{ occurrenceId: number; record: WindowRecord }>>();
  const failures = new Map<string, WindowFailure>();
  for (const row of prior) {
    if ((position.get(row.occurrenceId) ?? Infinity) < from || !sameContext(row)) continue;
    const output = rowOutput(row);
    for (const record of output.windows) {
      if (!(record.failed && opts.retryFailed)) reusable.set(record.sha, [...(reusable.get(record.sha) ?? []), { occurrenceId: row.occurrenceId, record }]);
    }
    if (!opts.retryFailed) for (const { sha, attempts, error } of output.retries ?? []) failures.set(sha, { attempts, error });
  }
  const windows: StreamWindow[] = [];
  const pendingMoves: Array<{ from: string; to: SourceWindow }> = [];
  /** Window keys moved off each occurrence's row since the last publication. */
  const movedOff = new Map<number, Set<string>>();
  const rowsNow = new Map<number, SegmentDerivationInput>(prior.map(row => [row.occurrenceId, row]));
  const startsGroup = new Map<number, boolean>();
  const ordinals = new Map<number, number>();
  const pageTitle = page.title || page.slug;
  const streamOpts = { page, gapMinutes: opts.gapMinutes, sinceIso: opts.sinceIso, pattern };
  let parsedMessages = 0;
  const texts = new Map<number, string>();
  const readText = async (i: number) => {
    const cached = texts.get(i);
    if (cached !== undefined) return cached;
    const text = await readOccurrenceText(engine, body, occurrences[i]!.row);
    texts.set(i, text);
    return text;
  };
  /** Stream the newest run not streamed yet: from the nearest occurrence before `end` whose first message opens a gap group (module doc). */
  const streamRun = async (end: number): Promise<{ start: number; windows: StreamWindow[] }> => {
    let start = end - 1;
    while (start > from && !startsConversationRun(occurrences, start, await readText(start), await readText(start - 1), streamOpts)) start--;
    const runWindows: StreamWindow[] = [];
    const streamed = await streamConversationWindows(occurrences, start, end, streamOpts, readText, {
      window(index, seg) {
        const owner = liveIds[index]!;
        const ordinal = ordinals.get(owner) ?? 0;
        ordinals.set(owner, ordinal + 1);
        const text = renderSegmentForExtraction(pageTitle, seg);
        const window = sourceWindowFor(owner, ordinal, text);
        // The same window's own record first, else any record of the same text (the window moved).
        const candidates = reusable.get(window.window_text_sha) ?? [];
        const own = candidates.findIndex(c => c.occurrenceId === owner && c.record.ordinal === ordinal);
        const hit = candidates.splice(own < 0 ? 0 : own, 1)[0];
        if (!hit) { runWindows.push({ owner, seg, text, window, state: 'todo', facts: 0 }); return; }
        const was = keyOf(hit.occurrenceId, hit.record);
        if (was !== sourceWindowKey(window)) {
          pendingMoves.push({ from: was, to: window });
          movedOff.set(hit.occurrenceId, new Set([...(movedOff.get(hit.occurrenceId) ?? []), was]));
        }
        runWindows.push({ owner, seg, text: null, window, state: hit.record.failed ? 'failed' : 'reused', facts: hit.record.facts, failed: hit.record.failed });
      },
      occurrence(index, starts) { startsGroup.set(liveIds[index]!, starts); },
    });
    parsedMessages += streamed.messages;
    for (const i of [...texts.keys()]) if (i > start) texts.delete(i);
    windows.unshift(...runWindows);
    return { start, windows: runWindows };
  };
  if (run.dryRun) {
    let todo = 0;
    for (let end = liveIds.length; pattern && end > from;) { const next = await streamRun(end); todo += next.windows.filter(w => w.state === 'todo').length; end = next.start; }
    result.segments_processed += run.segmentLimit > 0 ? Math.min(todo, run.segmentLimit) : todo;
    result.pages_processed++;
    if (opts.grammar !== undefined) {
      // The operator's preview: what a run under the chosen format extracts and what its settled collection removes.
      const keys = windows.map(w => sourceWindowKey(w.window));
      (result.grammar_previews ??= []).push({ source_id: sourceId, slug: page.slug, grammar: opts.grammar, messages: parsedMessages, windows: windows.length, windows_to_extract: todo,
        facts_to_collect: await countConversationFactsOutside(engine, sourceId, page.slug, keys) });
    }
    return { newestEnd: null };
  }

  const resolution = emptySaveTimeResolutionCounts();
  let streamedFrom = pattern ? liveIds.length : from;
  let stop: Stop = null;
  let unpricedModel: string | null = null;
  let newestEnd: string | null = null;
  let extracted = 0;
  let batch: { rows: ConversationFactRow[]; windows: SourceWindow[]; keys: string[] } = { rows: [], windows: [], keys: [] };
  /**
   * Publish the facts extracted since the last publication and the rows of the streamed occurrences; `final` settles a
   * finished page, but only if the page is still the version the run read, checked under the publication's row lock on
   * the page (a write that commits after the check waits for the publication; one that committed before is seen).
   */
  const publish = async (final: boolean) => {
    const owned = new Map<number, StreamWindow[]>();
    for (const w of windows) owned.set(w.owner, [...(owned.get(w.owner) ?? []), w]);
    // Rows of the occurrences this run streamed; an occurrence it never reached keeps its row.
    const derived: SegmentDerivationInput[] = liveIds.slice(streamedFrom).map((occurrenceId, k) => {
      const mine = owned.get(occurrenceId) ?? [];
      const records: WindowRecord[] = mine.filter(w => w.state !== 'todo').map(w => ({ ordinal: w.window.window_ordinal, sha: w.window.window_text_sha,
        facts: w.facts, ...(w.failed && w.state === 'failed' ? { failed: w.failed } : {}) }));
      const retries = mine.flatMap(w => { const failure = w.state === 'todo' ? failures.get(w.window.window_text_sha) : undefined; return failure ? [{ sha: w.window.window_text_sha, ...failure }] : []; });
      const failed = records.filter(r => r.failed).map(r => ({ ordinal: r.ordinal, attempts: r.failed!.attempts, error: r.failed!.error }));
      const finished = records.length === mine.length;
      return { pageId: page.id, kind: KIND, occurrenceId, version: CONVERSATION_FACTS_DERIVATION_VERSION, segmentSha256: live[streamedFrom + k]!.sha256,
        contextHash, state: finished && !opts.sinceIso ? 'done' : 'partial',
        output: { windows: records, starts_group: startsGroup.get(occurrenceId) ?? false, prev: prevOf(streamedFrom + k), pattern, ...(choice !== undefined ? { chosen: true } : {}), ...(retries.length ? { retries } : {}) },
        receipt: !finished ? unpricedModelReceipt(KIND, unpricedModel, stop ?? 'in_progress', { windows_read: records.length, windows_total: mine.length })
          : failed.length ? { kind: 'failed_windows', pipeline: KIND, windows: failed } : unpricedModelReceipt(KIND, unpricedModel, null, null) };
    });
    // A row whose window moved to another occurrence stops claiming it in the transaction that re-anchors its facts.
    const rewritten = new Set(derived.map(row => row.occurrenceId));
    const released: SegmentDerivationInput[] = [...movedOff].flatMap(([occurrenceId, keys]) => {
      const row = rowsNow.get(occurrenceId);
      if (!row || rewritten.has(occurrenceId)) return [];
      const output = rowOutput(row);
      return [{ ...row, output: { ...(row.output as object), windows: output.windows.filter(w => !keys.has(keyOf(occurrenceId, w))) } }];
    });
    const settledWindows = [...liveIds.slice(0, from).flatMap(id => rowOutput(priorRow.get(id)).windows.map(w => ({ key: keyOf(id, w), failed: !!w.failed }))),
      ...windows.map(w => ({ key: sourceWindowKey(w.window), failed: w.state === 'failed' }))];
    const moves = [...pendingMoves];
    const out = await writeDerivedFacts(engine, sourceId, page.slug, async db => {
      let unchanged = true;
      if (final) {
        await db.executeRaw('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [page.id]);
        const now = await db.getPage(page.slug, { sourceId });
        unchanged = !!now && now.id === page.id && regularPageVersionToken(now) === versionToken;
      }
      const settled = final && unchanged && stop === null && !opts.sinceIso && streamedFrom <= from;
      const liveKeys = settled ? settledWindows.map(w => w.key) : null;
      const collect = settled && !settledWindows.some(w => w.failed);
      const outcome = !liveKeys ? null : liveKeys.length ? terminalAuditFact(page.slug, 0, versionToken)
        : nonExtractableAuditFact(page.slug, 0, versionToken, pattern ? 'fewer than two eligible messages' : 'no conversation messages found');
      const published = await publishConversationFacts(db, sourceId, page.slug, outcome ? [...batch.rows, outcome] : batch.rows,
        { scope: 'window', segments: { windows: batch.windows, moves, replace: batch.keys, live: collect ? liveKeys : null } });
      if (derived.length || released.length) await db.upsertSegmentDerivations([...derived, ...released]);
      if (settled) await db.retireSegmentDerivations(page.id, liveIds, { kind: KIND });
      return { ...published, unchanged, settled, liveKeys, outcome };
    });
    const { unchanged, settled, liveKeys, outcome } = out;
    pendingMoves.splice(0, moves.length);
    movedOff.clear();
    for (const row of [...derived, ...released]) rowsNow.set(row.occurrenceId, row);
    batch = { rows: [], windows: [], keys: [] };
    result.facts_inserted += out.facts_inserted;
    result.orphan_facts_cleaned += out.deleted;
    return { unchanged, settled, liveKeys, outcome };
  };

  const maxTokens = await getFactsExtractionMaxTokens(engine);
  let paid: { pricingOverrides: PricingOverrides | undefined; entityHints: ExtractInput['entityHints'] } | null = null;
  try {
    // Newest runs first, and newest windows first inside each, so a cap or a limit spends on the newest messages.
    for (let end = liveIds.length; pattern && end > from && !stop;) {
      const next = await streamRun(end);
      streamedFrom = end = next.start;
      for (const w of next.windows.filter(x => x.state === 'todo').reverse()) {
        if (run.segmentLimit > 0 && extracted >= run.segmentLimit) { stop = 'segment_limit'; break; }
        if (run.signal?.aborted) throw new Error('aborted');
        paid ??= { pricingOverrides: await loadPricingOverrides(engine), entityHints: await conversationEntityHints(engine, sourceId, page.slug, factVisibility) };
        const { pricingOverrides, entityHints } = paid;
        const text = w.text!;
        const sha = w.window.window_text_sha;
        let metered: Awaited<ReturnType<typeof meterPaidCall<Awaited<ReturnType<typeof extractConversationWindow>>>>>;
        try {
          metered = await meterPaidCall(engine, page, `facts:${model}`, estimateFactsExtractionUsd(model, text.length, maxTokens, pricingOverrides),
            () => extractConversationWindow(run, page, w.seg, text, 0, entityHints), { pricingOverrides });
        } catch (error) {
          if (!windowFailure(error, run.signal)) throw error;
          const failure = { attempts: (failures.get(sha)?.attempts ?? 0) + 1, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
          failures.set(sha, failure);
          if (failure.attempts < WINDOW_FAILURE_LIMIT) throw error;
          failures.delete(sha);
          // A failed window keeps whatever facts its key still holds (an earlier context's), and its row claims them.
          Object.assign(w, { state: 'failed', failed: failure, facts: await countWindowFacts(engine, sourceId, page.slug, sourceWindowKey(w.window)), text: null });
          process.stderr.write(`[extract-conversation-facts] ${page.slug}: window ${w.window.window_ordinal} of occurrence ${w.owner} failed ${failure.attempts} runs (${failure.error}); skipped, gbrain doctor lists it, --force retries it\n`);
          continue;
        }
        unpricedModel = metered.unpricedModel ?? unpricedModel;
        if ('refused' in metered) { stop = metered.refused.reason === 'purge_sweep_pending' ? 'purge_sweep_pending' : 'cap_reached'; break; }
        const out = metered.value;
        w.state = 'extracted';
        w.facts = out.extracted;
        w.text = null;
        extracted++;
        result.segments_processed++;
        result.facts_extracted += out.extracted;
        mergeSaveTimeResolutionCounts(resolution, out.resolution);
        for (const row of out.rows) { batch.rows.push(row); batch.windows.push(w.window); }
        batch.keys.push(sourceWindowKey(w.window));
        if (!newestEnd || w.seg.endIso > newestEnd) newestEnd = w.seg.endIso;
        if (batch.keys.length >= CONVERSATION_FACTS_CHECKPOINT_WINDOWS) await publish(false);
        if (run.sleepMs > 0) await new Promise(resolve => setTimeout(resolve, run.sleepMs));
      }
    }
  } catch (error) {
    stop = 'interrupted';
    await publish(false).catch(publishError => {
      process.stderr.write(`[extract-conversation-facts] ${page.slug}: could not publish the finished windows: ${publishError instanceof Error ? publishError.message : String(publishError)}\n`);
    });
    throw error;
  } finally {
    result.fallback_slugify_count += resolution.fallback_slugify_count;
    result.resolution_errors += resolution.resolution_errors;
  }

  if (pattern && from < liveIds.length && parsedMessages === 0) {
    // A pinned grammar reads nothing here: detect the page's grammar again and start over under it.
    if (pinned) return processSegmentedConversationPage(run, page, { ...opts, redetect: true });
    if (choice !== undefined) {
      // The chosen format reads nothing here: the choice is dropped, nothing is published, and the page is held again.
      await setExtractionReceipt(engine, page.id, KIND, null);
      result.pages_failed++;
      recordFailedPage(result, page.slug, `the chosen format ${pattern} parses no message on the page; facts kept, choose another or none`);
      return { newestEnd: null };
    }
    // The grammar detected over the whole page reads no message from the page: a parser fault. Nothing is published.
    await setExtractionReceipt(engine, page.id, KIND, { kind: 'no_messages', pipeline: KIND, processed_chars: 0 });
    process.stderr.write(`[extract-conversation-facts] ${page.slug}: the page reads as ${pattern} but no message parsed under it; its facts were kept, nothing settled\n`);
    result.pages_failed++;
    recordFailedPage(result, page.slug, `the page reads as ${pattern} but no message parsed under it; facts kept`);
    return { newestEnd: null };
  }
  const { unchanged, settled, liveKeys, outcome } = await publish(true);
  await setExtractionReceipt(engine, page.id, KIND, choiceReceipt);
  if (!unchanged) {
    process.stderr.write(`[extract-conversation-facts] ${page.slug} changed during extraction; its finished windows were kept, the rest wait for the next run\n`);
    result.pages_failed++;
    recordFailedPage(result, page.slug, 'the page changed during extraction; left unfinished for replay');
    return { newestEnd: null };
  }
  if (outcome && !liveKeys!.length) { result.pages_skipped++; result.pages_skipped_insufficient_turns++; result.pages_marked_non_extractable++; }
  else result.pages_processed++;
  const detected = conversationDetectionWork.bytes - detectedBytes;
  process.stderr.write(`[extract-conversation-facts] ${page.slug}: ${extracted} new window(s) of ${windows.length} streamed from occurrence ${streamedFrom + 1} of ${liveIds.length}`
    + `${detected ? `; grammar ${pattern ?? 'none'} detected over ${detected} bytes` : ''}${stop ? `; stopped: ${stop}` : settled ? '; settled' : ''}\n`);
  return { newestEnd };
}
