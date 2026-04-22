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

  // Build a lookup of existing pages by directory/slug
  const pagesBySlug = new Map<string, { path: string; content: string }>();
  for (const page of allPages) {
    const slug = page.relPath.replace('.md', '');
    pagesBySlug.set(slug, { path: page.path, content: page.content });
  }

  // For each page, check entity references
  for (const page of allPages) {
    const refs = extractEntityRefs(page.content, page.relPath);
    const sourceFilename = basename(page.relPath);

    for (const ref of refs) {
      const targetSlug = `${ref.dir}/${ref.slug}`;
      const target = pagesBySlug.get(targetSlug);
      if (!target) continue; // target page doesn't exist

      // Check if the target already has a back-link to this source page
      if (!hasBacklink(target.content, sourceFilename)) {
        gaps.push({
          sourcePage: page.relPath,
          targetPage: targetSlug + '.md',
          entityName: ref.name,
          sourceTitle: extractPageTitle(page.content),
        });
      }
    }
  }

  return gaps;
}

/** Fix back-link gaps by appending timeline entries to target pages */
export function fixBacklinkGaps(brainDir: string, gaps: BacklinkGap[], dryRun: boolean = false): number {
  const today = new Date().toISOString().slice(0, 10);
  let fixed = 0;

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

    let content = readFileSync(targetPath, 'utf-8');

    for (const gap of targetGaps) {
      // Compute relative path from target to source
      const targetDir = targetPage.split('/').slice(0, -1);
      const sourceDir = gap.sourcePage.split('/');
      const depth = targetDir.length;
      const relPrefix = '../'.repeat(depth);
      const relPath = relPrefix + gap.sourcePage;

      const entry = buildBacklinkEntry(gap.sourceTitle, relPath, today);

      // Insert into Timeline section
      if (content.includes('## Timeline')) {
        const parts = content.split('## Timeline');
        const afterTimeline = parts[1];
        const nextSection = afterTimeline.match(/\n## /);
        if (nextSection) {
          const insertIdx = parts[0].length + '## Timeline'.length + nextSection.index!;
          content = content.slice(0, insertIdx) + '\n' + entry + content.slice(insertIdx);
        } else {
          content = content.trimEnd() + '\n' + entry + '\n';
        }
      } else {
        // Add Timeline section
        content = content.trimEnd() + '\n\n## Timeline\n\n' + entry + '\n';
      }
      fixed++;
    }

    if (!dryRun) {
      writeFileSync(targetPath, content);
    }
  }

  return fixed;
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
