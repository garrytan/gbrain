/**
 * Transcript discovery for the v0.23 dream-cycle synthesize phase.
 *
 * Walks a corpus directory for `.txt` files, applies date-range filters,
 * size filters (min_chars), and word-boundary regex exclude patterns.
 * Returns a list of file paths + content + content_hash so the caller
 * can key the verdict cache and dispatch one subagent per transcript.
 *
 * The corpus walk is pure filesystem + crypto (hermetic temp-dir tests);
 * the conversation-page section at the end reads `type: conversation`
 * pages from the database (#4419).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pruneDir } from '../sync.ts';
import { realpathOrResolve, resolvedPrefixContained } from '../path-confine.ts';
import { corpusFileSessionId } from '../context/corpus-segments.ts';
import { withoutOffPeriodTurns } from '../context/capture-consent.ts';
import { readSeatSidecar } from '../context/seat.ts';
import { claudeCliSelfSessionIds } from '../ai/providers/claude-cli-scratch.ts';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';

export interface DiscoveredTranscript {
  /** Absolute path to the transcript file. */
  filePath: string;
  /** sha256(content), full hex; callers slice as needed. */
  contentHash: string;
  /** Raw transcript text. */
  content: string;
  /** Filename basename without extension; used as a topic-slug seed. */
  basename: string;
  /** Inferred date if the basename matches `YYYY-MM-DD...` (or null). */
  inferredDate: string | null;
  /** #4618: the capturing seat from the session's `.seat.json` sidecar, when one exists. */
  seat?: string;
}

export interface DiscoverOpts {
  /** Source directory. Required. */
  corpusDir: string;
  /** Optional second source. */
  meetingTranscriptsDir?: string;
  /** Skip transcripts smaller than this many characters. Default 2000. */
  minChars?: number;
  /** Word-boundary regex strings. The discoverer auto-wraps bare words. */
  excludePatterns?: string[];
  /** Restrict to a single date (YYYY-MM-DD basename match). */
  date?: string;
  /** Inclusive range start (YYYY-MM-DD). */
  from?: string;
  /** Inclusive range end (YYYY-MM-DD). */
  to?: string;
  /**
   * Disable the self-consumption guard. Caller must opt in explicitly via
   * `--unsafe-bypass-dream-guard`; never auto-applied for `--input` because
   * that would let any caller silently re-trigger the loop bug.
   */
  bypassGuard?: boolean;
  /**
   * #5471: absolute directories the dream phases write their outputs into
   * (reflections, originals, patterns, cycle summaries under the brain
   * checkout). A file whose resolved path sits inside one is skipped whatever
   * its frontmatter says, so an output left unmarked by a failed postprocess
   * is never re-synthesized. Matched on resolved paths, never on content.
   */
  excludeDirs?: string[];
  /**
   * #5413: session ids of gbrain's own claude-cli subprocess sessions
   * (`claudeCliSelfSessionIds`). A `.txt` corpus file of one of these
   * sessions (`corpusFileSessionId`) is a self-capture and is skipped.
   */
  selfCaptureSessionIds?: ReadonlySet<string>;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const WORD_BOUNDARY_HEURISTIC = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Self-consumption guard: identity-marker check against `dream_generated: true`
 * stamped by the synthesize phase's render paths.
 *
 * v0.23.1 used a body slug-prefix string match. Codex review of the v0.23.2
 * plan caught two flaws: (1) `serializeMarkdown` does NOT embed the page slug
 * into body content, so the prefix heuristic could miss real dream output, and
 * (2) real conversation transcripts that legitimately cite a brain page would
 * be silently dropped. v0.23.2 swaps content inference for explicit identity
 * stamped at render time.
 *
 * Regex anchored at frontmatter open (`---\n`), tolerates optional BOM and CRLF,
 * scans the first 2000 chars for `dream_generated: true` (any whitespace, case-
 * insensitive value, word boundary on `true`).
 */
const DREAM_MARKER_REGEX_SRC =
  '^\\uFEFF?-{3}\\r?\\n[\\s\\S]{0,2000}?dream_generated\\s*:\\s*true\\b';
export const DREAM_OUTPUT_MARKER_RE = new RegExp(DREAM_MARKER_REGEX_SRC, 'i');

/**
 * v0.37.0 (D9 / D4): brainstorm + LSD frontmatter markers. `mode: lsd`
 * pages are noise-by-design and must NEVER be re-ingested by the synthesize
 * phase (they're inverted-judge experiments, not user-validated knowledge).
 * `mode: brainstorm` pages stamp the saved-page provenance; they're not
 * auto-skipped at this layer because the corpus walker doesn't currently
 * read wiki/ideas/ — full loop closure (synthesize mines `mode: brainstorm`
 * pages for patterns) is filed as a v0.37.1 follow-up.
 */
const LSD_MODE_MARKER_REGEX_SRC =
  '^\\uFEFF?-{3}\\r?\\n[\\s\\S]{0,2000}?mode\\s*:\\s*(?:"|\\\'|)lsd(?:"|\\\'|)\\s*(?:\\r?\\n|$)';
export const LSD_OUTPUT_MARKER_RE = new RegExp(LSD_MODE_MARKER_REGEX_SRC, 'i');

const BRAINSTORM_MODE_MARKER_REGEX_SRC =
  '^\\uFEFF?-{3}\\r?\\n[\\s\\S]{0,2000}?mode\\s*:\\s*(?:"|\\\'|)brainstorm(?:"|\\\'|)\\s*(?:\\r?\\n|$)';
export const BRAINSTORM_OUTPUT_MARKER_RE = new RegExp(BRAINSTORM_MODE_MARKER_REGEX_SRC, 'i');

/** True iff this content carries the LSD frontmatter marker (D4 noise-by-design skip). */
export function isLsdOutput(content: string): boolean {
  return LSD_OUTPUT_MARKER_RE.test(content);
}

/** True iff this content carries the brainstorm frontmatter marker (saved by `gbrain brainstorm --save`). */
export function isBrainstormOutput(content: string): boolean {
  return BRAINSTORM_OUTPUT_MARKER_RE.test(content);
}

/**
 * Self-consumption guard: identity-marker check against the synthesize phase's
 * dream output, EXTENDED in v0.37.0 to also skip `mode: lsd` pages per D4.
 * The synthesize corpus walker now sees three categories:
 *   - dream output (its own writes): always skipped
 *   - LSD output: skipped (noise-by-design)
 *   - everything else (transcripts, manual notes, brainstorm output): processed
 *
 * `bypass` is the explicit `--unsafe-bypass-dream-guard` escape hatch; it bypasses
 * the dream-output check but NOT the LSD skip — there's no operator scenario
 * where re-ingesting LSD output is desired (LSD is ephemeral by definition).
 */
export function isDreamOutput(content: string, bypass = false): boolean {
  // LSD output ALWAYS skipped — bypass flag is for self-consumption only,
  // not for re-ingesting LSD experiments into the pattern extractor.
  if (isLsdOutput(content)) return true;
  if (bypass) return false;
  return DREAM_OUTPUT_MARKER_RE.test(content);
}

/**
 * Sensitivity categories dream excludes from transcript ingestion by default.
 * The single source for this vocabulary: `dream.synthesize.exclude_patterns`
 * overrides it at runtime, and test/frontmatter-inference.test.ts asserts no
 * shipped DIRECTORY_RULE binds a path to one of these.
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = ['medical', 'therapy'];

/** One compiled exclude pattern plus the configured string it came from. */
interface CompiledExclude {
  re: RegExp;
  /** The pattern as the operator wrote it (`medical`, `^therapy:`), used for reporting. */
  label: string;
}

/**
 * Auto-wrap bare-word patterns in `\b<word>\b`. Power users can pass full
 * regex (e.g. `^therapy:`) which we honor verbatim. Heuristic: any input
 * that's purely alphanumeric+hyphen+underscore is treated as a bare word.
 */
function compileLabeledExcludePatterns(patterns: string[] | undefined): CompiledExclude[] {
  if (!patterns || patterns.length === 0) return [];
  const out: CompiledExclude[] = [];
  for (const p of patterns) {
    if (!p) continue;
    try {
      const src = WORD_BOUNDARY_HEURISTIC.test(p) ? `\\b${p}\\b` : p;
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- patterns come from the operator's own local config (dream.synthesize.exclude_patterns), never from remote or page content; a malformed pattern is caught below and skipped
      out.push({ re: new RegExp(src, 'i'), label: p });
    } catch (e) {
      // Bad regex from user config — skip with stderr warning, don't crash.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] invalid exclude_pattern '${p}': ${msg}\n`);
    }
  }
  return out;
}

/** Compiled regexes only; see `compileLabeledExcludePatterns` for the labeled form. */
export function compileExcludePatterns(patterns: string[] | undefined): RegExp[] {
  return compileLabeledExcludePatterns(patterns).map(c => c.re);
}

/**
 * Per-run tally of exclude_patterns hits, reported as ONE stderr line at the
 * end of discovery so an operator can see WHY a transcript was not
 * synthesised (before this, an excluded transcript vanished without a
 * trace and the run just said "no transcripts to process"). The line names
 * the count and the pattern labels that fired, never a path, basename, or
 * any transcript content: the patterns exist precisely because the matching
 * files are sensitive.
 */
class ExcludeTally {
  private excluded = 0;
  private readonly byLabel = new Map<string, number>();

  record(labels: string[]): void {
    this.excluded += 1;
    for (const label of labels) this.byLabel.set(label, (this.byLabel.get(label) ?? 0) + 1);
  }

  report(): void {
    if (this.excluded === 0) return;
    const detail = [...this.byLabel.entries()].map(([label, n]) => `${label}: ${n}`).join(', ');
    process.stderr.write(
      `[dream] excluded ${this.excluded} transcript(s) matching exclude_patterns (${detail}); ` +
      `set dream.synthesize.exclude_patterns to change\n`,
    );
  }
}

function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isInDateRange(date: string | null, opts: DiscoverOpts): boolean {
  if (!opts.date && !opts.from && !opts.to) return true;
  if (!date) return false; // file has no inferable date but a filter is active
  if (opts.date && date !== opts.date) return false;
  if (opts.from && date < opts.from) return false;
  if (opts.to && date > opts.to) return false;
  return true;
}

/** Labels of every compiled pattern that matches `text` (empty when none). */
function matchingExcludeLabels(text: string, patterns: CompiledExclude[]): string[] {
  const hits: string[] = [];
  for (const { re, label } of patterns) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

function listTextFiles(dir: string): string[] {
  // Recursive walk with descent-time pruning (closes codex C12/C13 spec gap).
  // Accepts BOTH .txt and .md per transcript-discovery's domain rules — does
  // NOT use isSyncable({strategy:'markdown'}) because that predicate rejects
  // .txt and applies markdown-only README/ops exclusions transcripts don't share.
  //
  // pruneDir at descent time skips node_modules / .git / .obsidian / .raw /
  // .cache / ops / etc. before recursion — saves the IO cost of walking
  // vendor subtrees.
  const out: string[] = [];
  function walk(d: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          // v0.37.7.0 #1169: pass parentDir so submodule pointers are
          // skipped at descent time.
          if (!pruneDir(name, d)) continue;
          walk(full);
        } else if (st.isFile() && (name.endsWith('.txt') || name.endsWith('.md'))) {
          out.push(full);
        }
      } catch {
        // skip unreadable entries
      }
    }
  }
  walk(dir);
  return out.sort();
}

/**
 * Discover transcripts from the configured corpus dirs, applying filters.
 *
 * Skips files that:
 *  - aren't `.txt`
 *  - have date-prefixed basenames outside the requested window
 *  - have content shorter than `minChars`
 *  - are gbrain claude-cli self-captures (`selfCaptureSessionIds`) or sit under a
 *    dream output directory (`excludeDirs`); each class is counted in one stderr line
 *  - carry the `dream_generated: true` self-consumption marker (unless `bypassGuard`)
 *  - match any compiled exclude pattern (case-insensitive word-boundary by default);
 *    these are summarised in ONE stderr line at the end (count + pattern labels,
 *    never the files)
 *
 * Returns sorted by filePath so re-runs are deterministic.
 */
export function discoverTranscripts(opts: DiscoverOpts): DiscoveredTranscript[] {
  const minChars = opts.minChars ?? 2000;
  const bypass = opts.bypassGuard === true;
  const excludes = compileLabeledExcludePatterns(opts.excludePatterns);
  const tally = new ExcludeTally();
  const dirs = [opts.corpusDir, opts.meetingTranscriptsDir].filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );
  const outputDirs = (opts.excludeDirs ?? []).map(realpathOrResolve);
  let outputSkips = 0;
  let selfCaptureSkips = 0;

  const results: DiscoveredTranscript[] = [];
  for (const dir of dirs) {
    for (const filePath of listTextFiles(dir)) {
      const ext = filePath.endsWith('.md') ? '.md' : '.txt';
      const baseName = basename(filePath, ext);
      const dateMatch = DATE_RE.exec(baseName);
      const inferredDate = dateMatch ? dateMatch[1] : null;
      if (!isInDateRange(inferredDate, opts)) continue;
      if (ext === '.txt' && opts.selfCaptureSessionIds?.has(corpusFileSessionId(basename(filePath)))) {
        selfCaptureSkips += 1;
        continue;
      }
      if (outputDirs.length > 0) {
        const resolved = realpathOrResolve(filePath);
        if (outputDirs.some(d => resolvedPrefixContained(resolved, d, sep))) {
          outputSkips += 1;
          continue;
        }
      }

      let content: string | null;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      // #6091: turns captured under memory.auto_writeback off never feed synthesis.
      if (ext === '.txt') content = withoutOffPeriodTurns(filePath, content);
      if (content === null || content.length < minChars) continue;
      if (isDreamOutput(content, bypass)) {
        process.stderr.write(`[dream] skipped ${baseName}: dream_generated marker (self-consumption guard)\n`);
        continue;
      }
      const excludeHits = matchingExcludeLabels(content, excludes);
      if (excludeHits.length > 0) {
        tally.record(excludeHits);
        continue;
      }

      const seat = transcriptSeat(filePath);
      results.push({
        filePath,
        contentHash: hashContent(content),
        content,
        basename: baseName,
        inferredDate,
        ...(seat ? { seat } : {}),
      });
    }
  }

  tally.report();
  if (selfCaptureSkips > 0) {
    process.stderr.write(`[dream] skipped ${selfCaptureSkips} corpus file(s) captured from gbrain's own claude-cli sessions\n`);
  }
  if (outputSkips > 0) {
    process.stderr.write(`[dream] skipped ${outputSkips} file(s) under dream output directories (self-consumption guard)\n`);
  }
  return results.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * Read a single ad-hoc transcript file (`gbrain dream --input <file>`).
 * Bypasses the corpus-dir scan and date filters but still applies
 * minChars + exclude_patterns when provided. The self-consumption guard
 * also still fires unless `bypassGuard` is set explicitly.
 */
export function readSingleTranscript(
  filePath: string,
  opts: { minChars?: number; excludePatterns?: string[]; bypassGuard?: boolean } = {},
): DiscoveredTranscript | null {
  const minChars = opts.minChars ?? 2000;
  const bypass = opts.bypassGuard === true;
  const excludes = compileLabeledExcludePatterns(opts.excludePatterns);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not read transcript at ${filePath}: ${msg}`);
  }
  if (content.length < minChars) return null;
  if (isDreamOutput(content, bypass)) {
    const ext = filePath.endsWith('.md') ? '.md' : '.txt';
      const baseName = basename(filePath, ext);
    process.stderr.write(`[dream] readSingleTranscript skipped ${baseName}: dream_generated marker (self-consumption guard)\n`);
    return null;
  }
  const excludeHits = matchingExcludeLabels(content, excludes);
  if (excludeHits.length > 0) {
    const tally = new ExcludeTally();
    tally.record(excludeHits);
    tally.report();
    return null;
  }
  const ext = filePath.endsWith('.md') ? '.md' : '.txt';
      const baseName = basename(filePath, ext);
  const dateMatch = DATE_RE.exec(baseName);
  const seat = transcriptSeat(filePath);
  return {
    filePath,
    contentHash: hashContent(content),
    content,
    basename: baseName,
    inferredDate: dateMatch ? dateMatch[1] : null,
    ...(seat ? { seat } : {}),
  };
}

/**
 * #4618: credit each ref to the seat of the transcript it was synthesized
 * from (the seat sidecar discovery read). The synthesis idempotency key never
 * includes the seat, so a sidecar added later triggers no re-synthesis.
 */
export function withTranscriptSeats<T extends { raw_source?: string }>(refs: T[], transcripts: DiscoveredTranscript[]): Array<T & { seat?: string }> {
  const seats = new Map(transcripts.flatMap(t => (t.seat ? [[t.filePath, t.seat] as const] : [])));
  return refs.map(ref => {
    const seat = ref.raw_source ? seats.get(ref.raw_source) : undefined;
    return seat ? { ...ref, seat } : ref;
  });
}

/**
 * #4618: the seat recorded for a transcript's session. A `.txt` corpus file
 * (session-end file, checkpoint segment or writeback turn) shares its
 * session's `<sessionId>.seat.json`; any other file uses its own basename.
 */
function transcriptSeat(filePath: string): string | undefined {
  const name = basename(filePath);
  const key = name.endsWith('.txt') ? corpusFileSessionId(name) : name.replace(/\.md$/, '');
  return readSeatSidecar(dirname(filePath), key)?.seat;
}

// ── #4419: imported type: conversation pages (database discovery) ───────
/*
 * Dream's synthesize phase discovers imported `type: conversation`
 * pages from the database, beside the filesystem corpus walk.
 *
 * `gbrain transcripts ingest` (and the chat connectors) already parse,
 * role-filter, redact and render each session as a conversation page; this
 * section hands those page bodies to synthesis as transcripts so a native
 * import needs no parallel `.txt` exporter. Discovery is scoped to the
 * cycle's source, filters dates on the page's `date` frontmatter, applies
 * the same min_chars / exclude_patterns / self-consumption rules as the
 * corpus walk, and keys each page as `gbrain-page://<source>/<slug>` with a
 * sha256 of its body, so the verdict cache and synthesis idempotency keys
 * stay stable until the page changes.
 */

export const CONVERSATION_PAGE_URI_PREFIX = 'gbrain-page://';

export interface ConversationPageDiscoverOpts {
  sourceId: string;
  minChars?: number;
  excludePatterns?: string[];
  date?: string;
  from?: string;
  to?: string;
  bypassGuard?: boolean;
  /** #5413: gbrain's own claude-cli session ids; their imported pages are self-captures. */
  selfCaptureSessionIds?: ReadonlySet<string>;
}

interface ConversationRow {
  slug: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown> | string | null;
}

function frontmatterOf(row: ConversationRow): Record<string, unknown> {
  if (!row.frontmatter) return {};
  if (typeof row.frontmatter === 'string') {
    try { return JSON.parse(row.frontmatter) as Record<string, unknown>; } catch { return {}; }
  }
  return row.frontmatter;
}

function pageDate(fm: Record<string, unknown>, slug: string): string | null {
  const raw = fm.date instanceof Date ? fm.date.toISOString() : typeof fm.date === 'string' ? fm.date : '';
  return DATE_RE.exec(raw)?.[1] ?? DATE_RE.exec(slug.split('/').pop() ?? '')?.[1] ?? null;
}

/** Live conversation pages in one source (used for the not-consumed warning). */
export async function countConversationPages(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string | number }>(
    `SELECT count(*)::text AS n FROM pages WHERE source_id = $1 AND type = 'conversation' AND deleted_at IS NULL`,
    [sourceId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function discoverConversationPages(
  engine: BrainEngine,
  opts: ConversationPageDiscoverOpts,
): Promise<DiscoveredTranscript[]> {
  const minChars = opts.minChars ?? 2000;
  const rows = await engine.executeRaw<ConversationRow>(
    `SELECT slug, compiled_truth, frontmatter FROM pages
      WHERE source_id = $1 AND type = 'conversation' AND deleted_at IS NULL
        AND length(compiled_truth) >= $2::int
      ORDER BY slug`,
    [opts.sourceId, minChars],
  );
  const excludes = compileExcludePatterns(opts.excludePatterns);
  let excluded = 0;
  let guarded = 0;
  const out: DiscoveredTranscript[] = [];
  for (const row of rows) {
    const fm = frontmatterOf(row);
    const date = pageDate(fm, row.slug);
    if (opts.date || opts.from || opts.to) {
      if (!date) continue;
      if (opts.date && date !== opts.date) continue;
      if (opts.from && date < opts.from) continue;
      if (opts.to && date > opts.to) continue;
    }
    if (fm.mode === 'lsd' || (fm.dream_generated === true && !opts.bypassGuard)) { guarded++; continue; }
    const imported = fm.transcript_import as { session_id?: unknown } | undefined;
    if (typeof imported?.session_id === 'string' && opts.selfCaptureSessionIds?.has(imported.session_id)) { guarded++; continue; }
    if (excludes.some((re) => re.test(row.compiled_truth))) { excluded++; continue; }
    out.push({
      filePath: `${CONVERSATION_PAGE_URI_PREFIX}${opts.sourceId}/${row.slug}`,
      contentHash: hashContent(row.compiled_truth),
      content: row.compiled_truth,
      basename: row.slug.split('/').pop() ?? row.slug,
      inferredDate: date,
    });
  }
  if (excluded > 0) {
    process.stderr.write(`[dream] excluded ${excluded} conversation page(s) matching exclude_patterns; set dream.synthesize.exclude_patterns to change\n`);
  }
  if (guarded > 0) {
    process.stderr.write(`[dream] skipped ${guarded} conversation page(s): dream output or gbrain's own sessions (self-consumption guard)\n`);
  }
  return out;
}

/** dream.synthesize.conversation_pages: on by default with a corpus dir, `true` opts in without one, `false` off. */
async function conversationPagesSetting(engine: Pick<BrainEngine, 'getConfig'>): Promise<string | undefined> {
  return (await engine.getConfig('dream.synthesize.conversation_pages'))?.trim().toLowerCase() || undefined;
}

export async function conversationPagesOptedIn(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return (await conversationPagesSetting(engine)) === 'true';
}

/**
 * The synthesize phase's transcript list: the corpus walk (or `--input`)
 * first, then the source's conversation pages when the setting is on; a page
 * whose body hash a corpus file already carries is not processed twice.
 */
export async function withConversationPages(
  engine: BrainEngine,
  opts: { inputFile?: string; sourceId?: string; date?: string; from?: string; to?: string; bypassDreamGuard?: boolean },
  config: { corpusDir: string | null; minChars: number; excludePatterns: string[] },
  corpus: DiscoveredTranscript[],
): Promise<DiscoveredTranscript[]> {
  if (opts.inputFile) return corpus;
  const setting = await conversationPagesSetting(engine);
  if (setting === 'false' || (setting !== 'true' && !config.corpusDir)) return corpus;
  const pages = await discoverConversationPages(engine, {
    sourceId: opts.sourceId ?? 'default', minChars: config.minChars, excludePatterns: config.excludePatterns,
    date: opts.date, from: opts.from, to: opts.to, bypassGuard: opts.bypassDreamGuard,
    selfCaptureSessionIds: claudeCliSelfSessionIds(),
  });
  const seen = new Set(corpus.map((t) => t.contentHash));
  return [...corpus, ...pages.filter((p) => !seen.has(p.contentHash))];
}

/**
 * #4419: synthesis is not configured (no corpus dir, conversation_pages
 * unset) but the source holds imported conversation pages. Returns a warn
 * naming the opt-in instead of a clean zero-work skip; null when there is
 * nothing to say (no pages, or the operator set conversation_pages=false).
 */
export async function conversationPagesNotConsumed(engine: BrainEngine, sourceId: string): Promise<PhaseResult | null> {
  if (await conversationPagesSetting(engine)) return null;
  const n = await countConversationPages(engine, sourceId);
  if (n === 0) return null;
  const fix = 'gbrain config set dream.synthesize.conversation_pages true';
  return {
    phase: 'synthesize',
    status: 'warn',
    duration_ms: 0,
    summary: `${n} imported conversation page(s) in source ${sourceId} are not fed to Dream: synthesis is not configured. ` +
      `Fix: ${fix} (or set dream.synthesize.session_corpus_dir); silence with dream.synthesize.conversation_pages false.`,
    details: {
      reason: 'not_configured', code: 'conversation_pages_not_consumed', conversation_pages: n, source_id: sourceId,
      fix, docs: 'docs/guides/chat-connectors.md#feed-imported-conversations-to-dream',
    },
  };
}
