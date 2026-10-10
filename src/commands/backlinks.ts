/**
 * gbrain check-backlinks — Check and fix missing back-links across brain pages.
 *
 * Deterministic: zero LLM calls. Scans pages for entity mentions,
 * checks if back-links exist, and optionally creates them.
 *
 * Usage:
 *   gbrain check-backlinks check [dir] [--dir <brain-dir>] # report missing back-links
 *   gbrain check-backlinks fix [dir] [--dir <brain-dir>]   # create missing back-links
 *   gbrain check-backlinks fix --dry-run                  # preview fixes
 */

import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { extractEntityRefs as canonicalExtractEntityRefs } from '../core/link-extraction.ts';
import { createProgress, startHeartbeat } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { parseMarkdown, frontmatterBodyOffset, findTimelineSplitIndex } from '../core/markdown.ts';
import { atomicWriteFileSync } from '../core/atomic-write.ts';
import { withPageLock } from '../core/page-lock.ts';

export interface BacklinkGap {
  /** The page that mentions the entity */
  sourcePage: string;
  /** The entity page that's missing the back-link */
  targetPage: string;
  /** The entity name mentioned */
  entityName: string;
  /** The source page title */
  sourceTitle: string;
}

/**
 * Extract entity references from markdown content for the filesystem-based
 * back-link walker. Filters to people/companies only (this command historically
 * targets just those two dirs). Slug is returned WITHOUT the dir prefix to
 * preserve the legacy shape used by findBacklinkGaps and fixBacklinkGaps below.
 *
 * The canonical extractor (link-extraction.ts) returns dir-prefixed slugs
 * (e.g. "people/alice"); this wrapper strips the prefix back off so existing
 * filesystem-walker code that does `${dir}/${slug}` keeps working.
 */
export function extractEntityRefs(content: string, _pagePath: string): { name: string; slug: string; dir: string }[] {
  return projectPeopleCompaniesRefs(canonicalExtractEntityRefs(content));
}

/**
 * The legacy people/companies projection shared by the exported wrapper above
 * and findBacklinkGaps (#1776: the gap walker extracts canonical refs ONCE per
 * page and derives both this projection and the backlink-credit slug set from
 * that single pass).
 */
function projectPeopleCompaniesRefs(
  refs: { name: string; slug: string; dir: string }[],
): { name: string; slug: string; dir: string }[] {
  return refs
    .filter(r => r.dir === 'people' || r.dir === 'companies')
    .map(r => ({
      name: r.name,
      slug: r.slug.startsWith(`${r.dir}/`) ? r.slug.slice(r.dir.length + 1) : r.slug,
      dir: r.dir,
    }));
}

/** Extract title from page (first H1 or frontmatter title) */
export function extractPageTitle(content: string): string {
  const fmMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
  if (fmMatch) return fmMatch[1];
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return 'Untitled';
}

/** Check if a page already contains a back-link to a given source file */
export function hasBacklink(targetContent: string, sourceFilename: string): boolean {
  return targetContent.includes(sourceFilename);
}

/** Build an undated back-link entry without inventing event chronology. */
export function buildBacklinkEntry(sourceTitle: string, sourcePath: string): string {
  // #1776: dir-shaped sources get an extension-less link (the brain-slug
  // convention the canonical extractor parses, so a freshly-written row is
  // credited by the next check pass instead of re-flagged). Root-level
  // sources keep the `.md` form: the extractor only parses `dir/name`
  // paths, so the legacy filename-substring check is the only thing that
  // can credit those rows — stripping `.md` there would make fix→check
  // non-idempotent (duplicate rows on every run).
  const bare = sourcePath.replace(/^(?:\.\.\/)+/, '');
  const linkPath = bare.includes('/') ? sourcePath.replace(/\.md$/, '') : sourcePath;
  return `- Referenced in [${sourceTitle}](${linkPath})`;
}

/**
 * Pages the walker visits: every `.md` under `brainDir`, skipping dot
 * entries and `_`-prefixed files, in readdir order (the order the gap list
 * follows). Symlinks are not followed as directories (lstat).
 */
function* walkMarkdownFiles(brainDir: string, dir = brainDir): Generator<{ full: string; relPath: string }> {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (lstatSync(full).isDirectory()) yield* walkMarkdownFiles(brainDir, full);
    else if (entry.endsWith('.md') && !entry.startsWith('_')) yield { full, relPath: relative(brainDir, full) };
  }
}

/** Files between event-loop yields in the async walker (#6438). */
export const BACKLINKS_YIELD_EVERY = 64;

/**
 * A fresh copy of a string sliced out of a page body. JSC substrings share
 * their parent's buffer, so a title or display name kept from `content`
 * would pin the whole page in memory (the retention #6438 is about); the
 * UTF-8 round trip allocates a new backing store.
 */
function detach(s: string): string {
  return Buffer.from(s, 'utf8').toString('utf8');
}

interface GapCandidate {
  relPath: string;
  sourceSlug: string;
  sourceFilename: string;
  title: string;
  /** Unique targets in first-mention order (#967 dedupe), with the display name of the first mention. */
  refs: Array<{ targetSlug: string; name: string }>;
}

/**
 * The streaming gap scan (#6438). Pass 1 reads each page once and keeps only
 * its slug, title and candidate `people/`/`companies/` targets (never the
 * body); pass 2 reads each referenced existing target once, records which
 * referencing sources it already credits (legacy `<basename>.md` substring
 * or a canonical outgoing ref, #1776) and drops the body; pass 3 emits the
 * gaps in the same order the single-pass walker produced them. The working
 * set is the file currently read plus candidate/index metadata, so a brain's
 * size in bytes no longer bounds the scan. The passes are generators so the
 * sync and async entry points share one implementation; the async one
 * yields to the event loop every BACKLINKS_YIELD_EVERY files, which lets the
 * progress heartbeat and the minion RSS watchdog run mid-scan.
 */
class BacklinkGapScan {
  private readonly existingSlugs = new Set<string>();
  private readonly candidates: GapCandidate[] = [];
  /** target slug -> candidate indexes that mention it */
  private readonly referrers = new Map<string, number[]>();
  /** target slug -> candidate indexes the target already credits */
  private readonly credited = new Map<string, Set<number>>();

  constructor(private readonly brainDir: string) {}

  *pass1(): Generator<void> {
    for (const { full, relPath } of walkMarkdownFiles(this.brainDir)) {
      let content: string;
      try {
        content = readFileSync(full, 'utf-8');
      } catch { continue; /* skip unreadable */ }
      this.existingSlugs.add(relPath.replace('.md', ''));
      const refs = projectPeopleCompaniesRefs(canonicalExtractEntityRefs(content));
      if (refs.length > 0) {
        const seen = new Set<string>();
        const unique: GapCandidate['refs'] = [];
        for (const ref of refs) {
          const targetSlug = detach(`${ref.dir}/${ref.slug}`);
          if (seen.has(targetSlug)) continue;
          seen.add(targetSlug);
          unique.push({ targetSlug, name: detach(ref.name) });
        }
        const index = this.candidates.length;
        this.candidates.push({
          relPath,
          sourceSlug: relPath.replace(/\.md$/, ''),
          sourceFilename: basename(relPath),
          title: detach(extractPageTitle(content)),
          refs: unique,
        });
        for (const { targetSlug } of unique) {
          const list = this.referrers.get(targetSlug);
          if (list) list.push(index);
          else this.referrers.set(targetSlug, [index]);
        }
      }
      yield;
    }
  }

  *pass2(): Generator<void> {
    for (const [targetSlug, indexes] of this.referrers) {
      if (!this.existingSlugs.has(targetSlug)) continue;
      let content: string;
      try {
        content = readFileSync(join(this.brainDir, `${targetSlug}.md`), 'utf-8');
      } catch { continue; /* vanished since pass 1: not a target */ }
      const outgoing = new Set(canonicalExtractEntityRefs(content).map(r => r.slug));
      const credits = new Set<number>();
      for (const i of indexes) {
        const c = this.candidates[i]!;
        if (hasBacklink(content, c.sourceFilename) || outgoing.has(c.sourceSlug)) credits.add(i);
      }
      this.credited.set(targetSlug, credits);
      yield;
    }
  }

  gaps(): BacklinkGap[] {
    const gaps: BacklinkGap[] = [];
    this.candidates.forEach((c, i) => {
      for (const ref of c.refs) {
        const credits = this.credited.get(ref.targetSlug);
        if (!credits) continue; // target page doesn't exist
        if (credits.has(i)) continue;
        gaps.push({ sourcePage: c.relPath, targetPage: ref.targetSlug + '.md', entityName: ref.name, sourceTitle: c.title });
      }
    });
    return gaps;
  }
}

/** Scan a brain directory for back-link gaps (synchronous; see findBacklinkGapsAsync for the yielding form). */
export function findBacklinkGaps(brainDir: string): BacklinkGap[] {
  const scan = new BacklinkGapScan(brainDir);
  for (const _ of scan.pass1()) { /* drain */ }
  for (const _ of scan.pass2()) { /* drain */ }
  return scan.gaps();
}

/**
 * The same scan, yielding to the event loop every BACKLINKS_YIELD_EVERY files
 * so timers (the progress heartbeat, the worker RSS watchdog) run mid-scan.
 */
export async function findBacklinkGapsAsync(brainDir: string): Promise<BacklinkGap[]> {
  const scan = new BacklinkGapScan(brainDir);
  const yieldNow = () => new Promise<void>(resolve => setImmediate(resolve));
  for (const pass of [scan.pass1(), scan.pass2()]) {
    let n = 0;
    for (const _ of pass) {
      if (++n % BACKLINKS_YIELD_EVERY === 0) await yieldNow();
    }
    await yieldNow();
  }
  return scan.gaps();
}

/** Per-run outcome of the fixer: entries inserted + per-file skip reasons. */
export interface BacklinkFixOutcome {
  fixed: number;
  skipped: Array<{ page: string; reason: string }>;
}

/**
 * Validation codes that make a file UNSAFE to edit: the fence/YAML itself is
 * broken (or the offset math would be unreliable), so any body insertion could
 * worsen the damage. Deliberately NOT in this set: MISSING_OPEN (a legacy page
 * with no frontmatter at all has no fence to corrupt — the whole file is body
 * and stays fixable) and the content-quality lint codes (NESTED_QUOTES,
 * NON_STRING_FIELD, EMPTY_FRONTMATTER, SLUG_MISMATCH) whose presence doesn't
 * affect where the body starts.
 */
const EDIT_BLOCKING_CODES = new Set(['YAML_PARSE', 'MISSING_CLOSE', 'NULL_BYTES']);

function firstEditBlockingError(content: string, filePath: string): string | null {
  const parsed = parseMarkdown(content, filePath, { validate: true });
  const blocking = (parsed.errors ?? []).find(e => EDIT_BLOCKING_CODES.has(e.code));
  return blocking ? `${blocking.code}: ${blocking.message}` : null;
}

/**
 * Insert an undated back-link into a dedicated `## Referenced by` section,
 * never touching bytes before `bodyStart` and never inserting into the
 * timeline region. Existing timeline sentinels take precedence over bare
 * `## Timeline` / `## History` headings.
 */
export function insertBacklinkEntry(content: string, bodyStart: number, entry: string): string {
  const bodySlice = content.slice(bodyStart);
  const lines = bodySlice.split('\n');
  const splitIndex = findTimelineSplitIndex(lines);
  let timelineStart = content.length;
  if (splitIndex >= 0) {
    timelineStart = bodyStart;
    for (let i = 0; i < splitIndex; i++) timelineStart += lines[i].length + 1;
  } else {
    const bareTimeline = /^## (?:Timeline|History)[ \t]*\r?$/im.exec(bodySlice);
    if (bareTimeline) timelineStart = bodyStart + bareTimeline.index;
  }

  const beforeTimeline = content.slice(bodyStart, timelineStart);
  const headingMatch = /^## Referenced by[ \t]*\r?$/im.exec(beforeTimeline);
  const eol = bodySlice.includes('\r\n') ? '\r\n' : '\n';

  if (headingMatch) {
    const headingAbs = bodyStart + headingMatch.index;
    const headingLineEnd = content.indexOf('\n', headingAbs);
    const sectionStart = headingLineEnd === -1 ? content.length : headingLineEnd + 1;
    const nextHeading = /^##\s+\S/m.exec(content.slice(sectionStart, timelineStart));
    const sectionEnd = nextHeading ? sectionStart + nextHeading.index : timelineStart;
    const suffix = content.slice(sectionEnd);
    const updatedSection = content.slice(0, sectionEnd).trimEnd() + eol + entry + eol;
    return suffix ? updatedSection + eol + suffix : updatedSection;
  }

  const prefix = content.slice(0, timelineStart).trimEnd();
  const suffix = content.slice(timelineStart);
  const section = `${prefix}${prefix ? eol + eol : ''}## Referenced by${eol}${eol}${entry}${eol}`;
  return suffix ? section + eol + suffix : section;
}

/**
 * @deprecated Compat alias whose name predates the undated 'Referenced by'
 * behavior (entries are no longer dated timeline lines). Kept for downstream
 * imports; new code uses insertBacklinkEntry.
 */
export const insertTimelineEntry = insertBacklinkEntry;

/**
 * Fix back-link gaps by inserting undated entries into target pages.
 *
 * Safety pipeline per target file (each failure isolates to that file and is
 * reported in `skipped` — one bad page can't kill the batch or corrupt itself):
 *   lock (withPageLock) → read → pre-validate (skip if the fence/YAML is
 *   already broken) → insert after the frontmatter-safe body offset →
 *   post-validate the candidate → atomic write (tmp+fsync+rename) that
 *   re-validates the on-disk bytes before the rename.
 */
export async function fixBacklinkGaps(
  brainDir: string,
  gaps: BacklinkGap[],
  dryRun: boolean = false,
  opts?: { lockRoot?: string },
): Promise<BacklinkFixOutcome> {
  const outcome: BacklinkFixOutcome = { fixed: 0, skipped: [] };

  // Group gaps by target page to batch writes
  const byTarget = new Map<string, BacklinkGap[]>();
  for (const gap of gaps) {
    const existing = byTarget.get(gap.targetPage) || [];
    existing.push(gap);
    byTarget.set(gap.targetPage, existing);
  }

  for (const [targetPage, targetGaps] of byTarget) {
    const targetPath = join(brainDir, targetPage);
    if (!existsSync(targetPath)) continue;

    const lockKey = targetPage.replace(/\.md$/, '');
    try {
      await withPageLock(lockKey, async () => {
        let content = readFileSync(targetPath, 'utf-8');

        const preError = firstEditBlockingError(content, targetPath);
        if (preError) {
          outcome.skipped.push({
            page: targetPage,
            reason: `pre-existing invalid frontmatter (${preError}) — file left untouched`,
          });
          return;
        }

        const bodyStart = frontmatterBodyOffset(content);
        let inserted = 0;
        for (const gap of targetGaps) {
          // Compute relative path from target to source
          const targetDir = targetPage.split('/').slice(0, -1);
          const depth = targetDir.length;
          const relPrefix = '../'.repeat(depth);
          const relPath = relPrefix + gap.sourcePage;

          const entry = buildBacklinkEntry(gap.sourceTitle, relPath);
          content = insertBacklinkEntry(content, bodyStart, entry);
          inserted++;
        }

        const postError = firstEditBlockingError(content, targetPath);
        if (postError) {
          outcome.skipped.push({
            page: targetPage,
            reason: `edit would invalidate page (${postError}) — aborted, file left untouched`,
          });
          return;
        }

        if (!dryRun) {
          atomicWriteFileSync(targetPath, content, {
            verify: (onDisk) => {
              const diskError = firstEditBlockingError(onDisk, targetPath);
              if (diskError) throw new Error(`on-disk validation failed (${diskError})`);
            },
          });
        }
        outcome.fixed += inserted;
      }, { timeoutMs: 10_000, lockRoot: opts?.lockRoot });
    } catch (e) {
      outcome.skipped.push({
        page: targetPage,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return outcome;
}

export interface BacklinksOpts {
  action: 'check' | 'fix';
  dir: string;
  dryRun?: boolean;
}

export interface BacklinksResult {
  action: 'check' | 'fix';
  gaps_found: number;
  fixed: number;
  pages_affected: number;
  dryRun: boolean;
  /** Pages the fixer refused to touch (invalid frontmatter, lock/write errors). */
  skipped_invalid?: number;
  skipped_pages?: Array<{ page: string; reason: string }>;
  /** The gaps the scan found, so the CLI prints them without a second walk (#6438). */
  gaps?: BacklinkGap[];
}

export interface ParsedBacklinksArgs {
  subcommand: string | undefined;
  brainDir: string;
  dryRun: boolean;
}

export function parseBacklinksArgs(args: string[]): ParsedBacklinksArgs {
  const subcommand = args[0];
  const dryRun = args.includes('--dry-run');
  const dirIdx = args.indexOf('--dir');
  const flagDir = dirIdx >= 0 && args[dirIdx + 1] && !args[dirIdx + 1].startsWith('--')
    ? args[dirIdx + 1]
    : undefined;

  let positionalDir: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dir') {
      i++;
      continue;
    }
    if (arg === '--dry-run') continue;
    if (arg.startsWith('--')) continue;
    positionalDir = arg;
    break;
  }

  return {
    subcommand,
    brainDir: flagDir ?? positionalDir ?? '.',
    dryRun,
  };
}

/**
 * Library-level backlinks check/fix. Throws on validation errors; returns a
 * structured result so Minions handlers + autopilot-cycle can surface counts.
 * Safe to call from the worker — no process.exit.
 */
export async function runBacklinksCore(opts: BacklinksOpts): Promise<BacklinksResult> {
  if (!['check', 'fix'].includes(opts.action)) {
    throw new Error(`Invalid backlinks action "${opts.action}". Allowed: check, fix.`);
  }
  if (!existsSync(opts.dir)) {
    throw new Error(`Directory not found: ${opts.dir}`);
  }
  // #5341: the fixer writes markdown files directly, which a managed
  // canonical worktree refuses page by page. Refuse once, before the scan,
  // and for --dry-run too, so a preview never claims fixes that cannot apply.
  if (opts.action === 'fix') {
    const { isManagedFilesystemPath } = await import('../core/persistence/filesystem-guard.ts');
    if (isManagedFilesystemPath(opts.dir)) {
      throw new Error(
        `check-backlinks fix is not supported on a managed canonical worktree (${opts.dir}): it writes markdown files directly, ` +
        'and managed brains accept file changes only through the persistence coordinator. ' +
        '`gbrain check-backlinks check` still reports the gaps; the graph extractor already stores these links as edges.',
      );
    }
  }

  // The scan streams the brain dir (#6438) and yields every few files so
  // this heartbeat and the worker's RSS watchdog fire while it runs.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('backlinks.scan');
  const stopHb = startHeartbeat(progress, 'walking pages for missing back-links…');
  let gaps: BacklinkGap[];
  try {
    gaps = await findBacklinkGapsAsync(opts.dir);
  } finally {
    stopHb();
    progress.finish();
  }
  const pagesAffected = new Set(gaps.map(g => g.targetPage)).size;

  if (opts.action === 'fix' && gaps.length > 0) {
    // Locks + per-file validation make the fix loop slower than the naive
    // writer it replaced — run it under its own phase with a heartbeat so
    // agents see forward progress (the scan phase above already finished).
    progress.start('backlinks.fix');
    const fixHb = startHeartbeat(progress, 'applying back-link fixes…');
    let fixOutcome: BacklinkFixOutcome;
    try {
      fixOutcome = await fixBacklinkGaps(opts.dir, gaps, !!opts.dryRun);
    } finally {
      fixHb();
      progress.finish();
    }
    return {
      action: 'fix',
      gaps_found: gaps.length,
      fixed: fixOutcome.fixed,
      pages_affected: pagesAffected,
      dryRun: !!opts.dryRun,
      skipped_invalid: fixOutcome.skipped.length,
      skipped_pages: fixOutcome.skipped,
      gaps,
    };
  }
  return { action: opts.action, gaps_found: gaps.length, fixed: 0, pages_affected: pagesAffected, dryRun: !!opts.dryRun, gaps };
}

export async function runBacklinks(args: string[]) {
  const { subcommand, brainDir, dryRun } = parseBacklinksArgs(args);

  if (!subcommand || !['check', 'fix'].includes(subcommand)) {
    console.error('Usage: gbrain check-backlinks <check|fix> [dir] [--dir <brain-dir>] [--dry-run]');
    console.error('  check    Report missing back-links');
    console.error('  fix      Create missing back-links (appends to Timeline)');
    console.error('  dir      Brain directory (default: current directory)');
    console.error('  --dir    Brain directory override');
    console.error('  --dry-run  Preview fixes without writing');
    process.exit(1);
  }

  let result: BacklinksResult;
  try {
    result = await runBacklinksCore({
      action: subcommand as 'check' | 'fix',
      dir: brainDir,
      dryRun,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  if (result.gaps_found === 0) {
    console.log('No missing back-links found.');
    return;
  }
  if (result.action === 'check') {
    const gaps = result.gaps ?? [];
    console.log(`Found ${gaps.length} missing back-link(s):\n`);
    for (const gap of gaps) {
      console.log(`  ${gap.targetPage} <- ${gap.sourcePage}`);
      console.log(`    "${gap.entityName}" mentioned in "${gap.sourceTitle}"`);
    }
    console.log(`\nRun 'gbrain check-backlinks fix --dir ${brainDir}' to create them.`);
  } else {
    const label = result.dryRun ? '(dry run) ' : '';
    console.log(`${label}Fixed ${result.fixed} missing back-link(s) across ${result.pages_affected} page(s).`);
    if (result.skipped_pages && result.skipped_pages.length > 0) {
      console.log(`\nSkipped ${result.skipped_pages.length} page(s):`);
      for (const s of result.skipped_pages) {
        console.log(`  ${s.page}: ${s.reason}`);
      }
    }
    if (result.dryRun) {
      console.log('\nRe-run without --dry-run to apply.');
    }
  }
}
