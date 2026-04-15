/**
 * gbrain extract — Extract links and timeline entries from brain markdown files.
 *
 * Subcommands:
 *   gbrain extract links [--dir <brain>] [--dry-run] [--json]
 *   gbrain extract timeline [--dir <brain>] [--dry-run] [--json]
 *   gbrain extract all [--dir <brain>] [--dry-run] [--json]
 */

import { readFileSync, readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { parseMarkdown } from '../core/markdown.ts';

// --- Types ---

export interface ExtractedLink {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
}

export interface ExtractedTimelineEntry {
  slug: string;
  date: string;
  source: string;
  summary: string;
  detail?: string;
}

export function normalizeTimelineDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}

export function timelineEntryKey(slug: string, date: string | Date, summary: string): string {
  return `${slug}::${normalizeTimelineDate(date)}::${summary}`;
}

interface ExtractResult {
  links_created: number;
  timeline_entries_created: number;
  pages_processed: number;
}

// --- Shared walker ---

export function walkMarkdownFiles(dir: string): { path: string; relPath: string }[] {
  const files: { path: string; relPath: string }[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;
      const full = join(d, entry);
      try {
        if (lstatSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
          files.push({ path: full, relPath: relative(dir, full) });
        }
      } catch { /* skip unreadable */ }
    }
  }
  walk(dir);
  return files;
}

// --- Link extraction ---

/** Extract markdown links to .md files (relative paths only) */
export function extractMarkdownLinks(content: string): { name: string; relTarget: string }[] {
  const results: { name: string; relTarget: string }[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const target = match[2];
    if (target.includes('://')) continue; // skip external URLs
    results.push({ name: match[1], relTarget: target });
  }
  return results;
}

/** Infer link type from directory structure */
function inferLinkType(fromDir: string, toDir: string, frontmatter?: Record<string, unknown>): string {
  const from = fromDir.split('/')[0];
  const to = toDir.split('/')[0];
  if (from === 'people' && to === 'companies') {
    if (Array.isArray(frontmatter?.founded)) return 'founded';
    return 'works_at';
  }
  if (from === 'people' && to === 'deals') return 'involved_in';
  if (from === 'deals' && to === 'companies') return 'deal_for';
  if (from === 'meetings' && to === 'people') return 'attendee';
  return 'mention';
}

/** Extract links from frontmatter fields */
function extractFrontmatterLinks(slug: string, fm: Record<string, unknown>): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const fieldMap: Record<string, { dir: string; type: string }> = {
    company: { dir: 'companies', type: 'works_at' },
    companies: { dir: 'companies', type: 'works_at' },
    investors: { dir: 'companies', type: 'invested_in' },
    attendees: { dir: 'people', type: 'attendee' },
    founded: { dir: 'companies', type: 'founded' },
  };
  for (const [field, config] of Object.entries(fieldMap)) {
    const value = fm[field];
    if (!value) continue;
    const slugs = Array.isArray(value) ? value : [value];
    for (const s of slugs) {
      if (typeof s !== 'string') continue;
      const toSlug = `${config.dir}/${s.toLowerCase().replace(/\s+/g, '-')}`;
      links.push({ from_slug: slug, to_slug: toSlug, link_type: config.type, context: `frontmatter.${field}` });
    }
  }
  return links;
}

/** Parse frontmatter using the project's gray-matter-based parser */
function parseFrontmatterFromContent(content: string, relPath: string): Record<string, unknown> {
  try {
    const parsed = parseMarkdown(content, relPath);
    return parsed.frontmatter;
  } catch {
    return {};
  }
}

/** Full link extraction from a single markdown file */
export function extractLinksFromFile(
  content: string, relPath: string, allSlugs: Set<string>,
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const slug = relPath.replace('.md', '');
  const fileDir = dirname(relPath);
  const fm = parseFrontmatterFromContent(content, relPath);

  for (const { name, relTarget } of extractMarkdownLinks(content)) {
    const resolved = join(fileDir, relTarget).replace('.md', '');
    if (allSlugs.has(resolved)) {
      links.push({
        from_slug: slug, to_slug: resolved,
        link_type: inferLinkType(fileDir, dirname(resolved), fm),
        context: `markdown link: [${name}]`,
      });
    }
  }

  links.push(...extractFrontmatterLinks(slug, fm));
  return links;
}

// --- Timeline extraction ---

/** Extract timeline entries from markdown content */
export function extractTimelineFromContent(content: string, slug: string): ExtractedTimelineEntry[] {
  const entries: ExtractedTimelineEntry[] = [];

  // Format 1: Bullet — - **YYYY-MM-DD** | Source — Summary
  const bulletPattern = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*(.+?)\s*[—–-]\s*(.+)$/gm;
  let match;
  while ((match = bulletPattern.exec(content)) !== null) {
    entries.push({ slug, date: match[1], source: match[2].trim(), summary: match[3].trim() });
  }

  // Format 2: Header — ### YYYY-MM-DD — Title
  const headerPattern = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/gm;
  while ((match = headerPattern.exec(content)) !== null) {
    const afterIdx = match.index + match[0].length;
    const nextHeader = content.indexOf('\n### ', afterIdx);
    const nextSection = content.indexOf('\n## ', afterIdx);
    const endIdx = Math.min(
      nextHeader >= 0 ? nextHeader : content.length,
      nextSection >= 0 ? nextSection : content.length,
    );
    const detail = content.slice(afterIdx, endIdx).trim();
    entries.push({ slug, date: match[1], source: 'markdown', summary: match[2].trim(), detail: detail || undefined });
  }

  return entries;
}

// --- Main command ---

export async function runExtract(engine: BrainEngine, args: string[]) {
  const subcommand = args[0];
  const dirIdx = args.indexOf('--dir');
  const brainDir = (dirIdx >= 0 && dirIdx + 1 < args.length) ? args[dirIdx + 1] : '.';
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  if (!subcommand || !['links', 'timeline', 'all'].includes(subcommand)) {
    console.error('Usage: gbrain extract <links|timeline|all> [--dir <brain-dir>] [--dry-run] [--json]');
    process.exit(1);
  }

  if (!existsSync(brainDir)) {
    console.error(`Directory not found: ${brainDir}`);
    process.exit(1);
  }

  const result: ExtractResult = { links_created: 0, timeline_entries_created: 0, pages_processed: 0 };

  if (subcommand === 'links' || subcommand === 'all') {
    const r = await extractLinksFromDir(engine, brainDir, dryRun, jsonMode);
    result.links_created = r.created;
    result.pages_processed = r.pages;
  }
  if (subcommand === 'timeline' || subcommand === 'all') {
    const r = await extractTimelineFromDir(engine, brainDir, dryRun, jsonMode);
    result.timeline_entries_created = r.created;
    result.pages_processed = Math.max(result.pages_processed, r.pages);
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!dryRun) {
    console.log(`\nDone: ${result.links_created} links, ${result.timeline_entries_created} timeline entries from ${result.pages_processed} pages`);
  }
}

async function extractLinksFromDir(
  engine: BrainEngine, brainDir: string, dryRun: boolean, jsonMode: boolean,
): Promise<{ created: number; pages: number }> {
  const files = walkMarkdownFiles(brainDir);
  const allSlugs = new Set(files.map(f => f.relPath.replace('.md', '')));

  // Load existing links for O(1) dedup
  const existing = new Set<string>();
  try {
    const pages = await engine.listPages({ limit: 100000 });
    for (const page of pages) {
      for (const link of await engine.getLinks(page.slug)) {
        existing.add(`${link.from_slug}::${link.to_slug}`);
      }
    }
  } catch { /* fresh brain */ }

  let created = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const links = extractLinksFromFile(content, files[i].relPath, allSlugs);
      for (const link of links) {
        const key = `${link.from_slug}::${link.to_slug}`;
        if (existing.has(key)) continue;
        existing.add(key);
        if (dryRun) {
          if (!jsonMode) console.log(`  ${link.from_slug} → ${link.to_slug} (${link.link_type})`);
          created++;
        } else {
          try {
            await engine.addLink(link.from_slug, link.to_slug, link.context, link.link_type);
            created++;
          } catch { /* UNIQUE or page not found */ }
        }
      }
    } catch { /* skip unreadable */ }
    if (jsonMode && !dryRun && (i % 100 === 0 || i === files.length - 1)) {
      process.stderr.write(JSON.stringify({ event: 'progress', phase: 'extracting_links', done: i + 1, total: files.length }) + '\n');
    }
  }

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Links: ${label} ${created} from ${files.length} pages`);
  }
  return { created, pages: files.length };
}

async function extractTimelineFromDir(
  engine: BrainEngine, brainDir: string, dryRun: boolean, jsonMode: boolean,
): Promise<{ created: number; pages: number }> {
  const files = walkMarkdownFiles(brainDir);

  // Load existing timeline entries for O(1) dedup
  const existing = new Set<string>();
  try {
    const pages = await engine.listPages({ limit: 100000 });
    for (const page of pages) {
      for (const entry of await engine.getTimeline(page.slug)) {
        existing.add(timelineEntryKey(page.slug, entry.date, entry.summary));
      }
    }
  } catch { /* fresh brain */ }

  let created = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const slug = files[i].relPath.replace('.md', '');
      for (const entry of extractTimelineFromContent(content, slug)) {
        const key = timelineEntryKey(entry.slug, entry.date, entry.summary);
        if (existing.has(key)) continue;
        existing.add(key);
        if (dryRun) {
          if (!jsonMode) console.log(`  ${entry.slug}: ${entry.date} — ${entry.summary}`);
          created++;
        } else {
          try {
            await engine.addTimelineEntry(entry.slug, { date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail });
            created++;
          } catch { /* page not in DB or constraint */ }
        }
      }
    } catch { /* skip unreadable */ }
    if (jsonMode && !dryRun && (i % 100 === 0 || i === files.length - 1)) {
      process.stderr.write(JSON.stringify({ event: 'progress', phase: 'extracting_timeline', done: i + 1, total: files.length }) + '\n');
    }
  }

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Timeline: ${label} ${created} entries from ${files.length} pages`);
  }
  return { created, pages: files.length };
}

// --- Sync integration hooks ---

export async function extractLinksForSlugs(engine: BrainEngine, repoPath: string, slugs: string[]): Promise<number> {
  const allFiles = walkMarkdownFiles(repoPath);
  const allSlugs = new Set(allFiles.map(f => f.relPath.replace('.md', '')));
  const existing = new Set<string>();
  for (const slug of slugs) {
    try {
      for (const link of await engine.getLinks(slug)) {
        existing.add(`${link.from_slug}::${link.to_slug}`);
      }
    } catch { /* skip */ }
  }

  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const link of extractLinksFromFile(content, slug + '.md', allSlugs)) {
        const key = `${link.from_slug}::${link.to_slug}`;
        if (existing.has(key)) continue;
        try {
          await engine.addLink(link.from_slug, link.to_slug, link.context, link.link_type);
          existing.add(key);
          created++;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return created;
}

export async function extractTimelineForSlugs(engine: BrainEngine, repoPath: string, slugs: string[]): Promise<number> {
  const existing = new Set<string>();
  for (const slug of slugs) {
    try {
      for (const entry of await engine.getTimeline(slug)) {
        existing.add(timelineEntryKey(slug, entry.date, entry.summary));
      }
    } catch { /* skip */ }
  }

  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const entry of extractTimelineFromContent(content, slug)) {
        const key = timelineEntryKey(entry.slug, entry.date, entry.summary);
        if (existing.has(key)) continue;
        try {
          await engine.addTimelineEntry(entry.slug, { date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail });
          existing.add(key);
          created++;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return created;
}
