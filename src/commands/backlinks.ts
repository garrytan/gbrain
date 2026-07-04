/**
 * mbrain check-backlinks — Check and fix missing back-links across brain pages.
 *
 * Deterministic: zero LLM calls. Scans pages for entity mentions,
 * checks if back-links exist, and optionally creates them.
 *
 * Usage:
 *   mbrain check-backlinks check [--dir <brain-dir>]     # report missing back-links
 *   mbrain check-backlinks fix [--dir <brain-dir>]        # create missing back-links
 *   mbrain check-backlinks fix --dry-run                  # preview fixes
 */

import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative, posix } from 'path';
import { parseMarkdown, serializeMarkdown } from '../core/markdown.ts';

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

interface SupersededByTargetGap {
  sourcePage: string;
  targetSlug: string;
}

const ENTITY_ROOTS = new Set(['people', 'companies', 'projects', 'systems', 'concepts']);

type EntityRef = { name: string; slug: string; dir: string };

function parseEntityPath(path: string, pagePath: string, rootQualified: boolean = false): { dir: string; slug: string } | null {
  const markdownPath = normalizeMarkdownDestination(path);
  const cleanPath = stripFragmentAndQuery(markdownPath);

  if (rootQualified || cleanPath.startsWith('/')) {
    return parseEntityParts(splitPath(cleanPath.replace(/^\/+/, '')));
  }

  if (isRelativeMarkdownPath(cleanPath)) {
    const pageDir = posix.dirname(pagePath.replaceAll('\\', '/'));
    const resolvedPath = posix.normalize(posix.join(pageDir === '.' ? '' : pageDir, cleanPath));
    return parseEntityParts(splitPath(resolvedPath));
  }

  return null;
}

function parseEntityParts(parts: string[]): { dir: string; slug: string } | null {
  if (parts.some(part => part === '..' || part === '.')) return null;
  const dir = parts[0]?.toLowerCase();
  if (dir === 'docs') return null;
  if (!dir || !ENTITY_ROOTS.has(dir) || !parts[1]) return null;

  const slugParts = parts.slice(1).map(part => part.toLowerCase());
  slugParts[slugParts.length - 1] = stripMarkdownExtension(slugParts[slugParts.length - 1]);

  return {
    dir,
    slug: slugParts.join('/'),
  };
}

function isRelativeMarkdownPath(path: string): boolean {
  return !path.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

function normalizeMarkdownDestination(destination: string): string {
  const trimmed = destination.trim();
  if (trimmed.startsWith('<')) {
    const closeIndex = trimmed.indexOf('>');
    return closeIndex >= 0 ? trimmed.slice(1, closeIndex) : trimmed;
  }

  const titledPath = trimmed.match(/^(\S+?\.mdx?(?:[#?]\S*)?)(?:\s+["'(].*)$/i);
  return titledPath ? titledPath[1] : trimmed;
}

function stripFragmentAndQuery(path: string): string {
  return path.split('#')[0].split('?')[0];
}

function splitPath(path: string): string[] {
  return path.replaceAll('\\', '/').split('/').filter(Boolean);
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.mdx?$/i, '');
}

function normalizeBrainPath(path: string): string | null {
  const normalized = posix.normalize(stripMarkdownExtension(path.replaceAll('\\', '/').replace(/^\.\//, ''))).toLowerCase();
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) return null;
  return normalized;
}

function resolveMarkdownPath(destination: string, contextPagePath?: string): string[] {
  const cleanPath = stripFragmentAndQuery(normalizeMarkdownDestination(destination));
  const candidates = new Set<string>();

  if (cleanPath.startsWith('/')) {
    const direct = normalizeBrainPath(cleanPath.replace(/^\/+/, ''));
    if (direct) candidates.add(direct);
    return [...candidates];
  }

  if (!isRelativeMarkdownPath(cleanPath)) return [];

  if (contextPagePath) {
    const contextDir = posix.dirname(contextPagePath.replaceAll('\\', '/'));
    const resolvedPath = posix.normalize(posix.join(contextDir === '.' ? '' : contextDir, cleanPath));
    const resolved = normalizeBrainPath(resolvedPath);
    if (resolved) candidates.add(resolved);
  } else {
    const direct = normalizeBrainPath(cleanPath);
    if (direct) candidates.add(direct);
  }

  return [...candidates];
}

/** Extract entity references from markdown content (relative links to durable entity roots) */
export function extractEntityRefs(content: string, pagePath: string): { name: string; slug: string; dir: string }[] {
  const refs: EntityRef[] = [];
  const seen = new Set<string>();

  function addRef(name: string, path: string, rootQualified: boolean = false) {
    const entity = parseEntityPath(path, pagePath, rootQualified);
    if (!entity) return;
    const key = `${entity.dir}/${entity.slug}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ name, slug: entity.slug, dir: entity.dir });
  }

  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    if (match.index > 0 && content[match.index - 1] === '!') continue;
    addRef(match[1], match[2]);
  }

  const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
  while ((match = wikilinkPattern.exec(content)) !== null) {
    const [rawTarget, rawAlias] = match[1].split('|', 2);
    const target = rawTarget?.trim() ?? '';
    const alias = rawAlias?.trim();
    addRef(alias || target.split('#')[0].split('/').pop()?.trim() || target, target, true);
  }

  return refs;
}

/** Extract title from page (first H1 or frontmatter title) */
export function extractPageTitle(content: string): string {
  const fmMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
  if (fmMatch) return fmMatch[1];
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return 'Untitled';
}

/** Check if a page already contains a back-link to a given source page */
export function hasBacklink(targetContent: string, sourcePage: string, targetPage?: string): boolean {
  const sourcePath = normalizeBrainPath(sourcePage);
  if (!sourcePath) return false;

  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(targetContent)) !== null) {
    if (match.index > 0 && targetContent[match.index - 1] === '!') continue;
    if (resolveMarkdownPath(match[2], targetPage).includes(sourcePath)) return true;
  }

  const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
  while ((match = wikilinkPattern.exec(targetContent)) !== null) {
    const target = match[1].split('|', 1)[0]?.trim() ?? '';
    const normalized = normalizeBrainPath(stripFragmentAndQuery(target));
    if (normalized === sourcePath) return true;
  }

  return false;
}

/** Build a timeline back-link entry */
export function buildBacklinkEntry(sourceTitle: string, sourcePath: string, date: string): string {
  return `- **${date}** | Referenced in [${sourceTitle}](${sourcePath})`;
}

/** Scan a brain directory for back-link gaps */
export function findBacklinkGaps(brainDir: string): BacklinkGap[] {
  const gaps: BacklinkGap[] = [];

  // Collect all markdown files
  const allPages = collectMarkdownPages(brainDir);

  // Build a lookup of existing pages by directory/slug
  const pagesBySlug = pagesBySlugMap(allPages);

  // For each page, check entity references
  for (const page of allPages) {
    const refs = extractEntityRefs(page.content, page.relPath);

    for (const ref of refs) {
      const targetSlug = `${ref.dir}/${ref.slug}`;
      const target = pagesBySlug.get(targetSlug);
      if (!target) continue; // target page doesn't exist

      // Check if the target already has a back-link to this source page
      if (!hasBacklink(target.content, page.relPath, targetSlug + '.md')) {
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

export function findSupersededByTargetGaps(brainDir: string): SupersededByTargetGap[] {
  const allPages = collectMarkdownPages(brainDir);
  const pagesBySlug = pagesBySlugMap(allPages);
  const gaps: SupersededByTargetGap[] = [];

  for (const page of allPages) {
    const parsed = parseMarkdown(page.content, page.relPath);
    const supersededBy = typeof parsed.frontmatter.superseded_by === 'string'
      ? normalizeBrainPath(parsed.frontmatter.superseded_by)
      : null;
    if (!supersededBy) continue;
    if (!pagesBySlug.has(supersededBy)) {
      gaps.push({
        sourcePage: page.relPath,
        targetSlug: supersededBy,
      });
    }
  }

  return gaps;
}

function collectMarkdownPages(brainDir: string): { path: string; relPath: string; content: string }[] {
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
  return allPages;
}

function pagesBySlugMap(
  pages: Array<{ path: string; relPath: string; content: string }>,
): Map<string, { path: string; content: string }> {
  const pagesBySlug = new Map<string, { path: string; content: string }>();
  for (const page of pages) {
    const slug = normalizeBrainPath(page.relPath);
    if (slug) pagesBySlug.set(slug, { path: page.path, content: page.content });
  }
  return pagesBySlug;
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
    const entries: string[] = [];

    for (const gap of targetGaps) {
      // Compute relative path from target to source
      const targetDir = targetPage.split('/').slice(0, -1);
      const depth = targetDir.length;
      const relPrefix = '../'.repeat(depth);
      const relPath = relPrefix + gap.sourcePage;

      const entry = buildBacklinkEntry(gap.sourceTitle, relPath, today);
      entries.push(entry);
      fixed++;
    }

    if (!dryRun) {
      writeFileSync(targetPath, appendTimelineEntries(content, targetPage, entries));
    }
  }

  return fixed;
}

function appendTimelineEntries(content: string, targetPage: string, entries: string[]): string {
  const parsed = parseMarkdown(content, targetPage);
  const { compiledTruth, timeline } = splitLegacyTimelineHeading(parsed.compiled_truth, parsed.timeline);
  const nextTimeline = [timeline, ...entries].filter(Boolean).join('\n');
  return serializeMarkdown(
    parsed.frontmatter,
    compiledTruth,
    nextTimeline,
    { type: parsed.type, title: parsed.title, tags: parsed.tags },
  );
}

function splitLegacyTimelineHeading(compiledTruth: string, timeline: string): { compiledTruth: string; timeline: string } {
  if (timeline.trim().length > 0) {
    return { compiledTruth, timeline };
  }

  const lines = compiledTruth.split('\n');
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
    }
    if (!inFence && /^## Timeline\s*$/.test(lines[index]!)) {
      return {
        compiledTruth: lines.slice(0, index).join('\n').trimEnd(),
        timeline: lines.slice(index + 1).join('\n').trim(),
      };
    }
  }
  return { compiledTruth, timeline };
}

export async function runBacklinks(args: string[]) {
  const subcommand = args[0];
  const dirIdx = args.indexOf('--dir');
  const brainDir = dirIdx >= 0 ? args[dirIdx + 1] : '.';
  const dryRun = args.includes('--dry-run');

  if (!subcommand || !['check', 'fix'].includes(subcommand)) {
    console.error('Usage: mbrain check-backlinks <check|fix> [--dir <brain-dir>] [--dry-run]');
    console.error('  check    Report missing back-links');
    console.error('  fix      Create missing back-links (appends to Timeline)');
    console.error('  --dir    Brain directory (default: current directory)');
    console.error('  --dry-run  Preview fixes without writing');
    process.exit(1);
  }

  if (!existsSync(brainDir)) {
    console.error(`Directory not found: ${brainDir}`);
    process.exit(1);
  }

  const gaps = findBacklinkGaps(brainDir);
  const supersededByGaps = findSupersededByTargetGaps(brainDir);

  if (gaps.length === 0 && supersededByGaps.length === 0) {
    console.log('No missing back-links found.');
    return;
  }

  if (subcommand === 'check') {
    console.log(`Found ${gaps.length} missing back-link(s) and ${supersededByGaps.length} dangling superseded_by target(s):\n`);
    for (const gap of gaps) {
      console.log(`  ${gap.targetPage} <- ${gap.sourcePage}`);
      console.log(`    "${gap.entityName}" mentioned in "${gap.sourceTitle}"`);
    }
    for (const gap of supersededByGaps) {
      console.log(`  ${gap.sourcePage} superseded_by -> ${gap.targetSlug} (missing)`);
    }
    console.log(`\nRun 'mbrain check-backlinks fix --dir ${brainDir}' to create them.`);
  } else {
    const label = dryRun ? '(dry run) ' : '';
    const fixed = fixBacklinkGaps(brainDir, gaps, dryRun);
    console.log(`${label}Fixed ${fixed} missing back-link(s) across ${new Set(gaps.map(g => g.targetPage)).size} page(s).`);
    if (supersededByGaps.length > 0) {
      console.log(`${supersededByGaps.length} dangling superseded_by target(s) require manual slug fixes.`);
    }
    if (dryRun) {
      console.log('\nRe-run without --dry-run to apply.');
    }
  }
}
