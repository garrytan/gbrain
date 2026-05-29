/**
 * Transcript discovery for the v0.23 dream-cycle synthesize phase.
 *
 * Walks a corpus directory for `.txt` files, applies date-range filters,
 * size filters (min_chars), and word-boundary regex exclude patterns.
 * Returns a list of file paths + content + content_hash so the caller
 * can key the verdict cache and dispatch one subagent per transcript.
 *
 * No DB; pure filesystem + crypto. Tested with hermetic temp directories.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { pruneDir } from '../sync.ts';

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
 * Auto-wrap bare-word patterns in `\b<word>\b`. Power users can pass full
 * regex (e.g. `^therapy:`) which we honor verbatim. Heuristic: any input
 * that's purely alphanumeric+hyphen+underscore is treated as a bare word.
 */
export function compileExcludePatterns(patterns: string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  const out: RegExp[] = [];
  for (const p of patterns) {
    if (!p) continue;
    try {
      const src = WORD_BOUNDARY_HEURISTIC.test(p) ? `\\b${p}\\b` : p;
      out.push(new RegExp(src, 'i'));
    } catch (e) {
      // Bad regex from user config — skip with stderr warning, don't crash.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] invalid exclude_pattern '${p}': ${msg}\n`);
    }
  }
  return out;
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

function matchesAnyExclude(text: string, patterns: RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(text)) return true;
  }
  return false;
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
 *  - carry the `dream_generated: true` self-consumption marker (unless `bypassGuard`)
 *  - match any compiled exclude pattern (case-insensitive word-boundary by default)
 *
 * Returns sorted by filePath so re-runs are deterministic.
 */
export function discoverTranscripts(opts: DiscoverOpts): DiscoveredTranscript[] {
  const minChars = opts.minChars ?? 2000;
  const bypass = opts.bypassGuard === true;
  const excludeRes = compileExcludePatterns(opts.excludePatterns);
  const dirs = [opts.corpusDir, opts.meetingTranscriptsDir].filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );

  const results: DiscoveredTranscript[] = [];
  for (const dir of dirs) {
    for (const filePath of listTextFiles(dir)) {
      const ext = filePath.endsWith('.md') ? '.md' : '.txt';
      const baseName = basename(filePath, ext);
      const dateMatch = DATE_RE.exec(baseName);
      const inferredDate = dateMatch ? dateMatch[1] : null;
      if (!isInDateRange(inferredDate, opts)) continue;

      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      if (content.length < minChars) continue;
      if (isDreamOutput(content, bypass)) {
        process.stderr.write(`[dream] skipped ${baseName}: dream_generated marker (self-consumption guard)\n`);
        continue;
      }
      if (matchesAnyExclude(content, excludeRes)) continue;

      results.push({
        filePath,
        contentHash: hashContent(content),
        content,
        basename: baseName,
        inferredDate,
      });
    }
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
  const excludeRes = compileExcludePatterns(opts.excludePatterns);
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
  if (matchesAnyExclude(content, excludeRes)) return null;
  const ext = filePath.endsWith('.md') ? '.md' : '.txt';
      const baseName = basename(filePath, ext);
  const dateMatch = DATE_RE.exec(baseName);
  return {
    filePath,
    contentHash: hashContent(content),
    content,
    basename: baseName,
    inferredDate: dateMatch ? dateMatch[1] : null,
  };
}
