/**
 * brain-writer — frontmatter validation/audit/auto-fix orchestrator.
 *
 * Thin layer on top of `parseMarkdown(..., {validate:true})` (the canonical
 * source of frontmatter validation rules) and `isSyncable()` (the canonical
 * brain-page filter). Three consumers call into this module: the
 * `gbrain frontmatter` CLI, the `frontmatter_integrity` doctor subcheck, and
 * the v0.22.4 migration audit phase. Single source of truth — no parallel
 * validation stack.
 *
 * Path-guard contract: writeBrainPage refuses to write outside the source
 * path. Pre-write backups are the safety contract (works for both git and
 * non-git brain repos; the existing src/core/dry-fix.ts:getWorkingTreeStatus
 * rejects non-git repos as unsafe, which is the wrong shape for brain
 * rewrites). Backups live under ~/.gbrain/backups/frontmatter/... instead of
 * beside source files so bulk repair never litters the user's workspace.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, copyFileSync, writeFileSync, mkdirSync, lstatSync } from 'fs';
import { join, relative, resolve, dirname, basename, isAbsolute } from 'path';
import type { BrainEngine } from './engine.ts';
import type { ProgressReporter } from './progress.ts';
import { gbrainPath } from './config.ts';
import { collectGitVisibleFiles } from './git-visible-files.ts';
import {
  parseMarkdown,
  type ParseValidationCode,
  type ParseValidationError,
} from './markdown.ts';
import { isSyncable, pruneDir, slugifyPath } from './sync.ts';

export type { ParseValidationCode };

export interface AuditFix {
  code: ParseValidationCode;
  description: string;
}

export interface PerSourceReport {
  source_id: string;
  source_path: string;
  total: number;
  errors_by_code: Partial<Record<ParseValidationCode, number>>;
  sample: { path: string; codes: ParseValidationCode[] }[];
  ignoredMissingOpen: number;
  /** Did this source finish the walk, get interrupted, or never start?
   * 'scanned' = full walk completed.
   * 'partial' = deadline/abort fired mid-walk; counts reflect prefix only.
   * 'skipped' = source was never visited (outer loop broke before reaching it). */
  status: 'scanned' | 'partial' | 'skipped';
  /** Count of .md files actually parsed (numerator for "scanned ~N of M" doctor message).
   * Distinct from `total` (which counts ERRORS) and `ignoredMissingOpen`. */
  files_scanned: number;
  /** DB-side denominator for the partial-state message. Coarse — DB pages and
   * on-disk syncable files are overlapping but not identical sets. NULL when the
   * COUNT query failed or wasn't issued. */
  db_page_count?: number | null;
}

export interface AuditReport {
  ok: boolean;
  total: number;
  errors_by_code: Partial<Record<ParseValidationCode, number>>;
  per_source: PerSourceReport[];
  scanned_at: string;
  ignored_missing_open?: number;
  /** True when any source got `status: 'partial'` or `'skipped'`. Doctor uses
   * this to render the warn message and to ensure `ok` is false even when the
   * scanned prefix happened to be clean (codex C2 fix). */
  partial: boolean;
  /** Source id where deadline/abort fired mid-walk, or null when no partial. */
  aborted_at_source: string | null;
}

const SAMPLE_PER_SOURCE = 20;

// ---------------------------------------------------------------------------
// Frontmatter backups
// ---------------------------------------------------------------------------

export function makeFrontmatterBackupRunId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export interface FrontmatterBackupOpts {
  sourcePath?: string;
  backupRoot?: string;
  runId?: string;
}

function sourceKey(sourcePath: string): string {
  return createHash('sha256').update(resolve(sourcePath)).digest('hex').slice(0, 12);
}

export function defaultFrontmatterBackupRoot(runId = makeFrontmatterBackupRunId()): string {
  return gbrainPath('backups', 'frontmatter', runId);
}

export function createFrontmatterBackup(filePath: string, opts: FrontmatterBackupOpts = {}): string {
  const resolvedFile = resolve(filePath);
  const resolvedSource = resolve(opts.sourcePath ?? dirname(resolvedFile));
  const rel = relative(resolvedSource, resolvedFile);
  const safeRel = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : basename(resolvedFile);
  const root = opts.backupRoot ?? defaultFrontmatterBackupRoot(opts.runId);
  const backupPath = join(root, sourceKey(resolvedSource), safeRel + '.bak');
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(resolvedFile, backupPath);
  return backupPath;
}

// ---------------------------------------------------------------------------
// autoFixFrontmatter
// ---------------------------------------------------------------------------

/**
 * Mechanical auto-repair for the fixable subset of validation codes:
 *   - NULL_BYTES        — strip \x00 characters
 *   - NESTED_QUOTES     — rewrite `"... "inner" ..."` to single-quoted outer
 *   - MISSING_CLOSE     — insert `---` before the first heading found inside
 *                          the YAML zone
 *   - SLUG_MISMATCH     — remove `slug:` line (gbrain derives slug from path)
 *
 * Idempotent: running twice is a no-op on already-clean input. Any error class
 * not in the list above is left untouched (e.g. EMPTY_FRONTMATTER, YAML_PARSE,
 * MISSING_OPEN — those need human review).
 */
export function autoFixFrontmatter(
  content: string,
  opts?: { filePath?: string },
): { content: string; fixes: AuditFix[] } {
  const fixes: AuditFix[] = [];
  let working = content;

  // 1. NULL_BYTES — strip them. Cheap, byte-level. Run first so subsequent
  //    line-based passes don't trip on stray nulls.
  if (working.indexOf('\x00') >= 0) {
    working = working.replace(/\x00/g, '');
    fixes.push({ code: 'NULL_BYTES', description: 'Stripped null bytes' });
  }

  // 2. MISSING_CLOSE — if there's an opener but no closer at all, insert
  //    `---` immediately before the first heading-shaped line (best-effort
  //    guess at where the frontmatter was meant to end).
  //
  //    Find the closer FIRST, scanning the full zone — do not stop at the
  //    first `#`-prefixed line. A `#` line between the opening and closing
  //    `---` is a YAML comment (comments are valid anywhere in a YAML
  //    document), not a markdown heading; only the genuine absence of a
  //    closing `---` counts as MISSING_CLOSE. Mirrors the fix applied to
  //    the parseMarkdown validator in #2153 — this is the sibling
  //    reimplementation in the auto-fixer and had the same bug (it broke
  //    out of the scan on the first heading-shaped line, so a `#` comment
  //    appearing before a real closing fence was misdetected as
  //    MISSING_CLOSE and the fix inserted a spurious `---` that split
  //    valid frontmatter in two, pushing the real keys into the body).
  {
    const lines = working.split('\n');
    let firstNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().length > 0) { firstNonEmpty = i; break; }
    }
    if (firstNonEmpty >= 0 && lines[firstNonEmpty].trim() === '---') {
      let closeIdx = -1;
      for (let i = firstNonEmpty + 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') { closeIdx = i; break; }
      }
      if (closeIdx === -1) {
        let headingIdx = -1;
        for (let i = firstNonEmpty + 1; i < lines.length; i++) {
          if (/^#{1,6}\s/.test(lines[i].trim())) { headingIdx = i; break; }
        }
        if (headingIdx >= 0) {
          const fixed = [
            ...lines.slice(0, headingIdx),
            '---',
            '',
            ...lines.slice(headingIdx),
          ];
          working = fixed.join('\n');
          fixes.push({
            code: 'MISSING_CLOSE',
            description: `Inserted closing --- before heading at line ${headingIdx + 1}`,
          });
        }
      }
    }
  }

  // Both step 3a and step 3 produce NESTED_QUOTES fix records on different
  // patterns. When both fire on the same file, push ONE merged record rather
  // than two — keeps the audit count honest about distinct files affected.
  let nestedQuotesFixed = false;

  // 3a. Canonical-style normalization for `tags:` / `aliases:` flow arrays.
  //     Post-v0.37.5.0 validator (PR #1229), `tags: ["yc", "w2025"]` is already
  //     valid YAML and no longer flagged. This pass rewrites it to the
  //     canonical single-quoted form (`tags: ['yc', 'w2025']`) so disk-side
  //     `frontmatter validate --fix` produces output consistent with the
  //     v0.37.9.0 serializer. Allow-list keys deliberately scoped to
  //     `tags` / `aliases` — extending to arbitrary keys would rewrite typed
  //     arrays (e.g. `scores: ["1", "2"]` would lose numeric intent).
  {
    const lines = working.split('\n');
    let firstNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().length > 0) { firstNonEmpty = i; break; }
    }
    if (firstNonEmpty >= 0 && lines[firstNonEmpty].trim() === '---') {
      let closeIdx = lines.length;
      for (let i = firstNonEmpty + 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') { closeIdx = i; break; }
      }
      let fixedAny = false;
      for (let i = firstNonEmpty + 1; i < closeIdx; i++) {
        // Allow-list: only `tags` and `aliases` (the keys this wave targets).
        const arrMatch = lines[i].match(/^(\s*(?:tags|aliases)\s*:\s*)\[(.*)\]\s*$/);
        if (!arrMatch || !arrMatch[2].includes('"')) continue;
        const [, prefix, inner] = arrMatch;
        // Quote-aware comma split — items may contain commas inside quotes.
        const items: string[] = [];
        let current = '';
        let inQuote = false;
        for (let j = 0; j < inner.length; j++) {
          const ch = inner[j];
          if (ch === '"' && (j === 0 || inner[j - 1] !== '\\')) {
            inQuote = !inQuote;
          } else if (ch === ',' && !inQuote) {
            items.push(current.trim());
            current = '';
          } else {
            current += ch;
          }
        }
        if (current.trim()) items.push(current.trim());

        // Re-quote: single quotes by default, double-quote fallback when the
        // item contains an apostrophe (YAML's single-quoted form would need
        // `''` escaping which the validator accepts but reads poorly).
        const reQuoted = items.map(v => {
          const clean = v.replace(/^"|"$/g, '').trim();
          if (!clean) return "''";
          return clean.includes("'") ? `"${clean}"` : `'${clean}'`;
        });
        lines[i] = `${prefix}[${reQuoted.join(', ')}]`;
        fixedAny = true;
      }
      if (fixedAny) {
        working = lines.join('\n');
        fixes.push({
          code: 'NESTED_QUOTES',
          description: 'Normalized JSON-style double-quoted tag/alias arrays to single-quoted YAML',
        });
        nestedQuotesFixed = true;
      }
    }
  }

  // 3. NESTED_QUOTES — rewrite `key: "...inner..."` lines that have 3+ unescaped
  //    double-quotes by switching the outer wrapper to single quotes and
  //    leaving inner quotes alone.
  {
    const lines = working.split('\n');
    let firstNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().length > 0) { firstNonEmpty = i; break; }
    }
    if (firstNonEmpty >= 0 && lines[firstNonEmpty].trim() === '---') {
      let closeIdx = lines.length;
      for (let i = firstNonEmpty + 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') { closeIdx = i; break; }
      }
      let fixedAny = false;
      for (let i = firstNonEmpty + 1; i < closeIdx; i++) {
        const m = lines[i].match(/^(\s*[A-Za-z_][\w-]*\s*:\s*)"(.*)"\s*(.*)$/);
        if (!m) continue;
        const [, prefix, inner, trailing] = m;
        let count = 0;
        for (let j = 0; j < inner.length; j++) {
          if (inner[j] === '"' && (j === 0 || inner[j - 1] !== '\\')) count++;
        }
        // Total " on the line includes the two outer quotes the regex
        // captured, plus whatever's in inner. We need 3+ to trigger.
        if (count >= 1) {
          // Inner already has unescaped " — outer wrap is causing the YAML
          // parse failure. Rewrite to 'single-quoted'. YAML escapes `'` inside
          // a single-quoted string by doubling it.
          const escapedInner = inner.replace(/'/g, "''");
          lines[i] = `${prefix}'${escapedInner}'${trailing ? ' ' + trailing : ''}`.replace(/\s+$/, '');
          fixedAny = true;
        }
      }
      if (fixedAny) {
        working = lines.join('\n');
        if (!nestedQuotesFixed) {
          fixes.push({
            code: 'NESTED_QUOTES',
            description: 'Rewrote nested double-quoted YAML values to single-quoted',
          });
          nestedQuotesFixed = true;
        }
      }
    }
  }

  // 4. SLUG_MISMATCH — remove `slug:` line if filePath is provided and the
  //    declared slug doesn't match the path-derived one. Per PR #392 spec,
  //    gbrain derives slug from path; the field shouldn't be in frontmatter.
  if (opts?.filePath) {
    const expectedSlug = slugifyPath(opts.filePath);
    // Use the (possibly partially-fixed) working content to detect whether
    // the slug field is present and mismatched.
    const re = /^slug:\s*(.+?)\s*$/m;
    const m = working.match(re);
    if (m && m[1].replace(/^["']|["']$/g, '') !== expectedSlug) {
      working = working.replace(re, '').replace(/\n{3,}/g, '\n\n');
      fixes.push({
        code: 'SLUG_MISMATCH',
        description: `Removed mismatched slug field (was "${m[1]}", expected "${expectedSlug}")`,
      });
    }
  }

  return { content: working, fixes };
}

// ---------------------------------------------------------------------------
// writeBrainPage — path-guarded write with centralized backup
// ---------------------------------------------------------------------------

export class BrainWriterError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'BrainWriterError';
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Path-guarded brain page writer. Always writes a backup under
 * ~/.gbrain/backups/frontmatter/... before any in-place mutation (the contract
 * that replaces git-tree-clean for non-git brain repos). Throws
 * BrainWriterError if filePath is not under sourcePath.
 */
export function writeBrainPage(
  filePath: string,
  content: string,
  opts: { sourcePath: string; autoFix?: boolean; backupRoot?: string; backupRunId?: string },
): { fixes: AuditFix[]; backupPath?: string } {
  const resolvedSource = resolve(opts.sourcePath);
  const resolvedTarget = resolve(filePath);
  if (resolvedTarget !== resolvedSource && !resolvedTarget.startsWith(resolvedSource + '/')) {
    throw new BrainWriterError(
      'PATH_OUTSIDE_SOURCE',
      `writeBrainPage: ${filePath} is not under ${opts.sourcePath}`,
      'Pass --source <id> matching the source the file lives in.',
    );
  }

  let toWrite = content;
  let fixes: AuditFix[] = [];
  if (opts.autoFix) {
    const result = autoFixFrontmatter(content, { filePath });
    toWrite = result.content;
    fixes = result.fixes;
  }

  let backupPath: string | undefined;
  if (existsSync(filePath)) {
    backupPath = createFrontmatterBackup(filePath, {
      sourcePath: opts.sourcePath,
      backupRoot: opts.backupRoot,
      runId: opts.backupRunId,
    });
  } else {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  writeFileSync(filePath, toWrite, 'utf8');
  return { fixes, backupPath };
}

// ---------------------------------------------------------------------------
// scanBrainSources
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  local_path: string | null;
}

export interface ScanOpts {
  /** Limit scan to one source. When omitted, all registered sources with a
   *  local_path are scanned. */
  sourceId?: string;
  /** Missing frontmatter is optional metadata coverage for broad document
   * sources. Set true for curated page repos that require every file to carry
   * YAML frontmatter. */
  strictMissingOpen?: boolean;
  onProgress?: ProgressReporter;
  /** Outer-loop abort: checked at source boundaries in scanBrainSources.
   * Does NOT interrupt the synchronous file-walk inside a single source —
   * use `deadline` for that. */
  signal?: AbortSignal;
  /** Hard wall-clock bound for the synchronous walk. When set, scanOneSource
   * checks `Date.now() > deadline` before parsing each file and returns
   * partial state when exceeded.
   *
   * This is the load-bearing mid-walk interruption mechanism. AbortSignal.timeout
   * cannot interrupt sync readdirSync/lstatSync/readFileSync (event loop blocked),
   * so a deadline epoch-ms check is the only way to actually bound wall-clock
   * inside the visit loop. Worst-case overshoot: one file's parse time. */
  deadline?: number;
  /** Async per-source DB hook: doctor uses this to fetch a coarse denominator
   * (`SELECT COUNT(*) FROM pages WHERE source_id = $1 AND deleted_at IS NULL`)
   * for the "scanned ~N of M" partial message. Returns null on query failure;
   * scanBrainSources stamps the result on PerSourceReport.db_page_count.
   * Optional — when omitted, db_page_count stays undefined. */
  dbPageCountForSource?: (sourceId: string) => Promise<number | null>;
  /** Test seam — fired by walkDir once per directory it descends into
   * (post-pruneDir). Production callers don't pass this; the regression
   * suite uses it to assert descent-time pruning directly. */
  visitDir?: (dirPath: string) => void;
}

/** Timeout-arm winner for the COUNT-vs-deadline race in scanBrainSources.
 *  A unique object so it can never collide with a legitimate COUNT result
 *  (number | null). Module-private. */
const DEADLINE_SENTINEL: unique symbol = Symbol('gbrain.scan.deadline');

export async function scanBrainSources(
  engine: BrainEngine,
  opts: ScanOpts = {},
): Promise<AuditReport> {
  const sources = await listSources(engine, opts.sourceId);
  const totals: Partial<Record<ParseValidationCode, number>> = {};
  const perSource: PerSourceReport[] = [];
  let grandTotal = 0;
  let ignoredMissingOpen = 0;
  let abortedAtSource: string | null = null;

  // Helper: mark sources from index i onward as 'skipped'. Used at every
  // between-source abort point (top of loop AND after the COUNT await).
  const markRemainingSkipped = (startIdx: number) => {
    for (let j = startIdx; j < sources.length; j++) {
      const skipped = sources[j];
      if (!skipped.local_path) continue;
      perSource.push({
        source_id: skipped.id,
        source_path: skipped.local_path,
        total: 0,
        errors_by_code: {},
        sample: [],
        ignoredMissingOpen: 0,
        status: 'skipped',
        files_scanned: 0,
      });
    }
  };

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    // Between-source abort check: AbortSignal works here (no sync I/O blocking
    // the event loop at this boundary). For mid-walk interruption use deadline.
    // `>=` not `>`: when Date.now() lands exactly on the deadline boundary,
    // the budget IS exhausted — proceeding to scanOneSource would let the
    // next source eat its own budget on top of what's already been spent.
    // (Strict `>` was a real flake source on CI: GitHub Actions runners
    // landing on the boundary exactly during a Promise.race timeout.)
    if (opts.signal?.aborted || (opts.deadline && Date.now() >= opts.deadline)) {
      // Codex adversarial review #3: when deadline fires BETWEEN sources,
      // also stamp aborted_at_source with the source we were about to start.
      // Pre-fix, the doctor message said "PARTIAL SCAN" with no source name.
      if (abortedAtSource === null && src.local_path) {
        abortedAtSource = src.id;
      }
      markRemainingSkipped(i);
      break;
    }
    if (!src.local_path) continue;
    if (!existsSync(src.local_path)) {
      // Source registered but path is missing on disk; surface as a zero-row
      // entry with a synthetic SCAN_PATH_MISSING note via warn-and-skip.
      perSource.push({
        source_id: src.id,
        source_path: src.local_path,
        total: 0,
        errors_by_code: {},
        sample: [],
        ignoredMissingOpen: 0,
        status: 'scanned',
        files_scanned: 0,
      });
      continue;
    }

    // Best-effort denominator fetch — degrades gracefully on query failure.
    // Codex adversarial #4: also race against the deadline. A wedged Postgres
    // pool can make this await hang past the budget. Without the race, we'd
    // wait indefinitely AND defeat the wall-clock guarantee.
    let dbPageCount: number | null = null;
    // Set when the deadline race's timeout arm wins: the verdict that the
    // budget is spent, independent of any later Date.now() reading. Timer
    // callbacks on loaded runners can fire measurably EARLY relative to the
    // wall clock (a +1ms pad was drifted past in practice — see the flake
    // lineage in test/brain-writer-partial-scan.test.ts and issue #2946), so
    // the hung-COUNT path must not re-derive "did the deadline fire?" from
    // the clock the timer just raced against.
    let deadlineHit = false;
    if (opts.dbPageCountForSource) {
      try {
        if (opts.deadline) {
          const remainingMs = opts.deadline - Date.now();
          if (remainingMs <= 0) {
            dbPageCount = null;
            deadlineHit = true;
          } else {
            // Race COUNT against the deadline so a hung query can't eat the
            // budget. The timeout arm resolves a private sentinel — NOT null —
            // so a deadline win is distinguishable from a COUNT that resolved
            // null (failed/absent count keeps its existing semantics).
            const raced = await Promise.race([
              opts.dbPageCountForSource(src.id),
              new Promise<typeof DEADLINE_SENTINEL>(resolve =>
                setTimeout(() => resolve(DEADLINE_SENTINEL), remainingMs)),
            ]);
            if (raced === DEADLINE_SENTINEL) {
              dbPageCount = null;
              deadlineHit = true;
            } else {
              dbPageCount = raced;
            }
          }
        } else {
          dbPageCount = await opts.dbPageCountForSource(src.id);
        }
      } catch {
        // A throwing COUNT is a failed count, not a deadline verdict.
        dbPageCount = null;
      }
    }

    // Codex adversarial #2: re-check deadline AFTER the COUNT await. If the
    // await ate the budget, we must NOT call scanOneSource — it would return
    // status='partial' with files_scanned=0, which is misleading ("partial
    // scan" when actually nothing was scanned). Mark this source + remainder
    // as 'skipped' so the doctor message is honest.
    // `deadlineHit` is the authoritative verdict for the hung-COUNT path (the
    // sentinel above); the wall-clock re-check (`>=`, matching the
    // between-source check at line ~445) still covers a COUNT that RESOLVED
    // slowly enough to eat the budget without the timer winning.
    if (opts.signal?.aborted || deadlineHit || (opts.deadline && Date.now() >= opts.deadline)) {
      if (abortedAtSource === null) {
        abortedAtSource = src.id;
      }
      markRemainingSkipped(i);
      break;
    }

    const report = scanOneSource(src.id, src.local_path, opts);
    report.db_page_count = dbPageCount;
    perSource.push(report);
    grandTotal += report.total;
    ignoredMissingOpen += report.ignoredMissingOpen;
    for (const [code, n] of Object.entries(report.errors_by_code)) {
      const k = code as ParseValidationCode;
      totals[k] = (totals[k] ?? 0) + (n as number);
    }
    if (report.status === 'partial' && abortedAtSource === null) {
      abortedAtSource = src.id;
    }
  }

  const hasPartialOrSkipped = perSource.some(r => r.status === 'partial' || r.status === 'skipped');

  return {
    // Partial scans can never be 'ok' even when the scanned prefix is clean
    // (codex outside-voice C2 — a clean prefix doesn't speak for the
    // unscanned suffix).
    ok: grandTotal === 0 && !hasPartialOrSkipped,
    total: grandTotal,
    errors_by_code: totals,
    per_source: perSource,
    scanned_at: new Date().toISOString(),
    ignored_missing_open: ignoredMissingOpen || undefined,
    partial: hasPartialOrSkipped,
    aborted_at_source: abortedAtSource,
  };
}

function scanOneSource(
  sourceId: string,
  sourcePath: string,
  opts: ScanOpts,
): PerSourceReport {
  const errorsByCode: Partial<Record<ParseValidationCode, number>> = {};
  const sample: PerSourceReport['sample'] = [];
  const rootResolved = resolve(sourcePath);
  let scanned = 0;
  let total = 0;
  let ignoredMissingOpen = 0;
  let interrupted = false;

  const visitFile = (absPath: string): boolean | void => {
    // Per-file deadline + abort gate. Deadline is the load-bearing
    // wall-clock bound (sync I/O blocks the event loop so timer-based
    // AbortSignal.timeout can't fire mid-walk — codex C1).
    if (opts.deadline && Date.now() > opts.deadline) {
      interrupted = true;
      return false;
    }
    if (opts.signal?.aborted) {
      interrupted = true;
      return false;
    }
    // visitDir is consulted from walkDir directly (passed below). The
    // per-file visit closure doesn't need it.
    const relPath = relative(rootResolved, absPath);
    if (!isSyncable(relPath, { strategy: 'markdown' })) return true;
    scanned++;
    let content: string;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      return true; // skip unreadable
    }
    const expectedSlug = slugifyPath(relPath);
    const parsed = parseMarkdown(content, relPath, { validate: true, expectedSlug });
    const errs = (parsed.errors ?? []).filter((e) => {
      if (e.code !== 'MISSING_OPEN') return true;
      if (opts.strictMissingOpen) return true;
      ignoredMissingOpen++;
      return false;
    });
    if (errs.length > 0) {
      total += errs.length;
      const codes: ParseValidationCode[] = [];
      for (const e of errs) {
        errorsByCode[e.code] = (errorsByCode[e.code] ?? 0) + 1;
        codes.push(e.code);
      }
      if (sample.length < SAMPLE_PER_SOURCE) {
        sample.push({ path: relPath, codes });
      }
    }
    if (opts.onProgress && scanned % 50 === 0) {
      opts.onProgress.tick(50);
    }
    return true;
  };

  const gitFiles = collectGitVisibleFiles(rootResolved, (rel) => isSyncable(rel, { strategy: 'markdown' }));
  if (gitFiles) {
    if (opts.visitDir) opts.visitDir(rootResolved);
    for (const absPath of gitFiles) {
      if (visitFile(absPath) === false) break;
    }
  } else {
    walkDir(rootResolved, visitFile, opts.visitDir);
  }

  if (opts.onProgress) {
    opts.onProgress.heartbeat(`scanned ${scanned} pages in ${sourceId}`);
  }

  return {
    source_id: sourceId,
    source_path: sourcePath,
    total,
    errors_by_code: errorsByCode,
    sample,
    ignoredMissingOpen,
    status: interrupted ? 'partial' : 'scanned',
    files_scanned: scanned,
  };
}

/**
 * Recursive directory walker with symlink-loop protection (via lstat) and
 * descent-time pruning of vendor / hidden / generated subtrees.
 *
 * Walks `root`, calling `visit(absPath)` for each regular file. Returning
 * `false` from `visit` stops the walk (used by scanOneSource for deadline
 * + abort).
 *
 * `pruneDir(name, parentDir)` is the canonical pruning gate (single source
 * of truth at src/core/sync.ts:258 — sync, extract, and transcript-discovery
 * all share it). Skipped subtrees: `node_modules`, `.git`, `.obsidian`,
 * `*.raw`, `ops`, all dot-prefix dirs, and git submodule dirs (`.git` as
 * FILE not DIRECTORY, the gitfile pattern from v0.37.7.0 #1169).
 *
 * Pre-v0.38.2.0 this walker descended into every subtree and let
 * `isSyncable` filter at the leaf — paying the IO cost of stat'ing hundreds
 * of thousands of vendor entries that were never going to be parsed. That
 * was the root cause of the `gbrain doctor` hang on 216K-page brains
 * reported in PR #1287.
 *
 * Optional `visitDir(dir)` is fired once per directory the walker decides
 * to DESCEND INTO (post-pruneDir, post-visited-set check). Production
 * callers don't pass it; tests use it to assert descent-time pruning
 * directly. Output-based tests pass under the original bug because
 * `isSyncable` filters at the leaf — `visitDir` is the load-bearing
 * observability hook for the regression suite.
 */
/** @internal — exported for the regression test suite (visitDir-based
 * descent-time pruning assertions). Production callers should go through
 * scanBrainSources / scanOneSource. */
export function walkDir(
  root: string,
  visit: (absPath: string) => boolean | void,
  visitDir?: (dirPath: string) => void,
): void {
  const stack: string[] = [root];
  const visited = new Set<string>();
  if (visitDir) visitDir(root);
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // matches sync's no-symlink policy
      if (st.isDirectory()) {
        // Descent-time prune — the actual fix for the 216K-page hang.
        if (!pruneDir(name, dir)) continue;
        const real = resolve(full);
        if (visited.has(real)) continue;
        visited.add(real);
        if (visitDir) visitDir(full);
        stack.push(full);
      } else if (st.isFile()) {
        const result = visit(full);
        if (result === false) return;
      }
    }
  }
}

async function listSources(engine: BrainEngine, sourceId?: string): Promise<SourceRow[]> {
  if (sourceId) {
    const rows = await engine.executeRaw<SourceRow>(
      `SELECT id, local_path FROM sources WHERE id = $1`,
      [sourceId],
    );
    return rows;
  }
  return engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL ORDER BY id`,
  );
}
