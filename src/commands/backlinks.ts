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

/** Scan a brain directory for back-link gaps */
export function findBacklinkGaps(brainDir: string): BacklinkGap[] {
  const gaps: BacklinkGap[] = [];

  // Collect all markdown files
  const allPages: { path: string; relPath: string; content: string }[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (lstatSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
        const relPath = relative(brainDir, full);
        try {
          allPages.push({ path: full, relPath, content: readFileSync(full, 'utf-8') });
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(brainDir);

  // Build a lookup of existing pages by directory/slug. #1776: extract each
  // page's canonical refs ONCE here — they feed both the gap candidates
  // (people/companies projection) and the backlink-credit slug set, so
  // extension-less convention links ([Alice](../people/alice),
  // [[people/alice]]) count as backlinks even though the legacy
  // `<basename>.md` substring check can't see them.
  const pagesBySlug = new Map<string, { path: string; content: string }>();
  const refsByRelPath = new Map<string, { name: string; slug: string; dir: string }[]>();
  const outgoingSlugsBySlug = new Map<string, Set<string>>();
  for (const page of allPages) {
    const slug = page.relPath.replace('.md', '');
    pagesBySlug.set(slug, { path: page.path, content: page.content });
    const canonical = canonicalExtractEntityRefs(page.content);
    refsByRelPath.set(page.relPath, canonical);
    outgoingSlugsBySlug.set(slug, new Set(canonical.map(r => r.slug)));
  }

  // For each page, check entity references
  for (const page of allPages) {
    const refs = projectPeopleCompaniesRefs(refsByRelPath.get(page.relPath) ?? []);
    const sourceFilename = basename(page.relPath);
    const sourceSlug = page.relPath.replace(/\.md$/, '');
    // LOCAL PATCH (paolo, 2026-05-12): dedupe (source, target) pairs within
    // a single source page. extractEntityRefs returns one EntityRef per
    // occurrence, so a source page that mentions the same target N times
    // produced N identical gaps → N duplicate "Referenced in" lines on the
    // target. The per-ref `hasBacklink(target.content, ...)` check reads a
    // stale snapshot (target.content is frozen at this scope), so every
    // iteration sees the same "no backlink yet" state and pushes another
    // gap. Tracking seen target slugs per source caps gaps at one per pair.
    const seen = new Set<string>();

    for (const ref of refs) {
      const targetSlug = `${ref.dir}/${ref.slug}`;
      if (seen.has(targetSlug)) continue;
      seen.add(targetSlug);
      const target = pagesBySlug.get(targetSlug);
      if (!target) continue; // target page doesn't exist

      // Check if the target already has a back-link to this source page.
      // Credited two ways (#1776): the legacy `<basename>.md` substring
      // (old fixer rows, explicit .md links) OR the target's canonical
      // outgoing refs containing the source slug (extension-less
      // convention links and wikilinks the substring check misses).
      if (hasBacklink(target.content, sourceFilename)) continue;
      if (outgoingSlugsBySlug.get(targetSlug)?.has(sourceSlug)) continue;
      gaps.push({
        sourcePage: page.relPath,
        targetPage: targetSlug + '.md',
        entityName: ref.name,
        sourceTitle: extractPageTitle(page.content),
      });
    }
  }

  return gaps;
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

  // findBacklinkGaps is a sync double-walk of the brain dir. On 50K-page
  // brains that can take seconds — heartbeat so agents see we're working.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('backlinks.scan');
  const stopHb = startHeartbeat(progress, 'walking pages for missing back-links…');
  let gaps: BacklinkGap[];
  try {
    gaps = findBacklinkGaps(opts.dir);
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
    };
  }
  return { action: opts.action, gaps_found: gaps.length, fixed: 0, pages_affected: pagesAffected, dryRun: !!opts.dryRun };
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
    // Re-walk for user-facing output (core returns counts, CLI shows detail).
    const gaps = findBacklinkGaps(brainDir);
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
