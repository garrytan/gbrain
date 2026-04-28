/**
 * gbrain check-backlinks — Check and fix missing back-links across brain pages.
 *
 * Deterministic: zero LLM calls. Scans pages for entity mentions,
 * checks if back-links exist, and optionally creates them.
 *
 * Usage:
 *   gbrain check-backlinks check [--dir <brain-dir>]     # report missing back-links
 *   gbrain check-backlinks fix [--dir <brain-dir>]        # create missing back-links
 *   gbrain check-backlinks fix --dry-run                  # preview fixes
 */

import { readFileSync, writeFileSync, readdirSync, statSync, lstatSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { extractEntityRefs as canonicalExtractEntityRefs } from '../core/link-extraction.ts';
import { createProgress, startHeartbeat } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

interface BacklinkGap {
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
  const refs = canonicalExtractEntityRefs(content);
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

/** Build a timeline back-link entry */
export function buildBacklinkEntry(sourceTitle: string, sourcePath: string, date: string): string {
  return `- **${date}** | Referenced in [${sourceTitle}](${sourcePath})`;
}

/**
 * Canonical shape of a Referenced-in line written by the fix path:
 *   `- **YYYY-MM-DD** | Referenced in [Title](relative-path)`
 * The fix path strips every line that matches and rewrites from the brain's
 * current source state. Lines that don't match (manual Timeline entries,
 * Layer B `[Source: Calendar]` lines, ad-hoc bullets) are preserved.
 *
 * Captures: 1=date, 2=display title, 3=href.
 */
const REFERENCED_IN_LINE_RE = /^- \*\*(\d{4}-\d{2}-\d{2})\*\* \| Referenced in \[([^\]]+)\]\(([^)]+)\)\s*$/;

interface BrainPage {
  path: string;
  relPath: string;
  content: string;
}

function walkBrainPages(brainDir: string): BrainPage[] {
  const pages: BrainPage[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (lstatSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
        const relPath = relative(brainDir, full);
        try {
          pages.push({ path: full, relPath, content: readFileSync(full, 'utf-8') });
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(brainDir);
  return pages;
}

/**
 * Build the brain's incoming-source map: target slug → set of source rel-paths
 * that mention the target (one entry per distinct source, regardless of how
 * many wikilinks the source has). Drives the rewrite path's canonical set.
 */
function buildIncomingMap(pages: BrainPage[], pagesBySlug: Map<string, BrainPage>): Map<string, Set<string>> {
  const incoming = new Map<string, Set<string>>();
  for (const source of pages) {
    const refs = extractEntityRefs(source.content, source.relPath);
    const seenTargets = new Set<string>();
    for (const ref of refs) {
      const targetSlug = `${ref.dir}/${ref.slug}`;
      // Per-source-target dedup: many wikilinks → one canonical Referenced-in line.
      if (seenTargets.has(targetSlug)) continue;
      seenTargets.add(targetSlug);
      if (!pagesBySlug.has(targetSlug)) continue;
      // No self-reference: a page mentioning its own slug shouldn't backlink to itself.
      if (source.relPath === targetSlug + '.md') continue;
      let set = incoming.get(targetSlug);
      if (!set) { set = new Set(); incoming.set(targetSlug, set); }
      set.add(source.relPath);
    }
  }
  return incoming;
}

/** Parse existing Referenced-in lines on a target page → href → {date, title}. */
function parseExistingBacklinks(content: string): Map<string, { date: string; title: string }> {
  const out = new Map<string, { date: string; title: string }>();
  for (const line of content.split('\n')) {
    const m = line.match(REFERENCED_IN_LINE_RE);
    if (!m) continue;
    out.set(m[3], { date: m[1], title: m[2] });
  }
  return out;
}

function stripBacklinkLines(content: string): string {
  return content
    .split('\n')
    .filter(line => !REFERENCED_IN_LINE_RE.test(line))
    .join('\n');
}

function insertBacklinksIntoTimeline(content: string, lines: string[]): string {
  if (lines.length === 0) return content;
  const block = lines.join('\n');
  const headerIdx = content.indexOf('## Timeline');
  if (headerIdx >= 0) {
    const afterHeader = headerIdx + '## Timeline'.length;
    const restOfFile = content.slice(afterHeader);
    const nextSectionRel = restOfFile.search(/\n##\s/);
    const insertAt = nextSectionRel === -1 ? content.length : afterHeader + nextSectionRel;
    const before = content.slice(0, insertAt);
    const after = content.slice(insertAt);
    const sep = before.endsWith('\n') ? '' : '\n';
    return before + sep + block + '\n' + after;
  }
  // No Timeline section — create one at end of file.
  const sep = content.endsWith('\n') ? '' : '\n';
  return content + sep + '\n## Timeline\n\n' + block + '\n';
}

/**
 * Scan a brain directory for missing back-links. Each (target, source) pair
 * produces at most one gap regardless of how many wikilink mentions the
 * source contains. Pairs already represented by any line containing the
 * source filename in the target are not reported.
 */
export function findBacklinkGaps(brainDir: string): BacklinkGap[] {
  const pages = walkBrainPages(brainDir);
  const pagesBySlug = new Map<string, BrainPage>();
  for (const page of pages) {
    pagesBySlug.set(page.relPath.replace('.md', ''), page);
  }

  const gaps: BacklinkGap[] = [];
  const seenPair = new Set<string>();

  for (const page of pages) {
    const refs = extractEntityRefs(page.content, page.relPath);
    const sourceFilename = basename(page.relPath);
    const seenTargetsForThisSource = new Set<string>();

    for (const ref of refs) {
      const targetSlug = `${ref.dir}/${ref.slug}`;
      if (seenTargetsForThisSource.has(targetSlug)) continue;
      seenTargetsForThisSource.add(targetSlug);

      const target = pagesBySlug.get(targetSlug);
      if (!target) continue;
      if (hasBacklink(target.content, sourceFilename)) continue;

      const pairKey = `${targetSlug}.md\0${page.relPath}`;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);

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

/**
 * Rewrite-not-append fix path. For every page in the brain, recomputes the
 * canonical Referenced-in line set from current source state, strips any
 * existing Referenced-in lines, and reinserts the canonical sorted set
 * inside the Timeline section. Idempotent: re-running with no source-state
 * change produces byte-identical output.
 *
 * Self-heals against three previously-silent failure modes:
 *   1. Multi-mention sources writing N copies of the same line per cycle.
 *   2. Source page renamed / moved → stale Referenced-in lines lingering.
 *   3. Source page deleted → stale Referenced-in lines lingering.
 *
 * Returns the count of NEW canonical lines created across all touched
 * pages (i.e. entries not previously present). Stale-line cleanup is not
 * counted here — see the strip-only pass for affected pages with no
 * incoming sources.
 *
 * The `_gaps` argument is accepted for API compatibility but ignored;
 * the rewrite path computes the canonical set itself from a fresh walk.
 */
export function fixBacklinkGaps(brainDir: string, _gaps: BacklinkGap[], dryRun: boolean = false): number {
  const today = new Date().toISOString().slice(0, 10);
  const pages = walkBrainPages(brainDir);
  const pagesBySlug = new Map<string, BrainPage>();
  for (const page of pages) {
    pagesBySlug.set(page.relPath.replace('.md', ''), page);
  }

  const incoming = buildIncomingMap(pages, pagesBySlug);
  let written = 0;

  // Pass 1: targets with at least one incoming source. Strip-and-rewrite.
  for (const [targetSlug, sourceRelPaths] of incoming) {
    const target = pagesBySlug.get(targetSlug);
    if (!target) continue;

    const targetDirDepth = targetSlug.split('/').length - 1;
    const relPrefix = '../'.repeat(targetDirDepth);
    const existing = parseExistingBacklinks(target.content);

    const canonical: { href: string; date: string; title: string }[] = [];
    for (const sourceRelPath of sourceRelPaths) {
      const source = pagesBySlug.get(sourceRelPath.replace('.md', ''));
      if (!source) continue;
      const href = relPrefix + sourceRelPath;
      // Preserve the date of the existing line if any — cycles must be idempotent.
      const date = existing.get(href)?.date ?? today;
      const title = extractPageTitle(source.content);
      canonical.push({ href, date, title });
    }

    canonical.sort((a, b) => {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return a.href < b.href ? -1 : a.href > b.href ? 1 : 0;
    });

    const newLines = canonical.filter(c => !existing.has(c.href)).length;
    const lines = canonical.map(c => buildBacklinkEntry(c.title, c.href, c.date));
    let next = stripBacklinkLines(target.content);
    next = insertBacklinksIntoTimeline(next, lines);

    if (next !== target.content) {
      if (!dryRun) writeFileSync(target.path, next);
      written += newLines;
    }
  }

  // Pass 2: targets with stale Referenced-in lines but no longer any
  // incoming sources. Strip them.
  for (const target of pages) {
    const slug = target.relPath.replace('.md', '');
    if (incoming.has(slug)) continue;
    const stripped = stripBacklinkLines(target.content);
    if (stripped !== target.content && !dryRun) {
      writeFileSync(target.path, stripped);
    }
  }

  return written;
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
    const fixed = fixBacklinkGaps(opts.dir, gaps, !!opts.dryRun);
    return { action: 'fix', gaps_found: gaps.length, fixed, pages_affected: pagesAffected, dryRun: !!opts.dryRun };
  }
  return { action: opts.action, gaps_found: gaps.length, fixed: 0, pages_affected: pagesAffected, dryRun: !!opts.dryRun };
}

export async function runBacklinks(args: string[]) {
  const subcommand = args[0];
  const dirIdx = args.indexOf('--dir');
  const brainDir = dirIdx >= 0 ? args[dirIdx + 1] : '.';
  const dryRun = args.includes('--dry-run');

  if (!subcommand || !['check', 'fix'].includes(subcommand)) {
    console.error('Usage: gbrain check-backlinks <check|fix> [--dir <brain-dir>] [--dry-run]');
    console.error('  check    Report missing back-links');
    console.error('  fix      Create missing back-links (appends to Timeline)');
    console.error('  --dir    Brain directory (default: current directory)');
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
    if (result.dryRun) {
      console.log('\nRe-run without --dry-run to apply.');
    }
  }
}
