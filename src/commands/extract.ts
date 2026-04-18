/**
 * gbrain extract — Extract links and timeline entries from brain content.
 *
 * Two data sources:
 *   --source fs  (default): walk markdown files on disk
 *   --source db           : iterate pages from the engine (works for brains
 *                           with no local checkout, e.g. live MCP servers)
 *
 * Subcommands:
 *   gbrain extract links    [--source fs|db] [--dir <brain>] [--dry-run] [--json] [--type T] [--since DATE]
 *   gbrain extract timeline [--source fs|db] [--dir <brain>] [--dry-run] [--json] [--type T] [--since DATE]
 *   gbrain extract all      [--source fs|db] [--dir <brain>] [--dry-run] [--json] [--type T] [--since DATE]
 *
 * The DB-source path uses the v0.10.3 graph extractor (typed link inference,
 * within-page dedup, snapshot iteration so concurrent writes don't corrupt
 * pagination). FS-source preserves the original v0.10.1 walker behavior.
 */

import { readFileSync, readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import type { PageType } from '../core/types.ts';
import { parseMarkdown } from '../core/markdown.ts';
import { extractPageLinks, parseTimelineEntries, inferLinkType } from '../core/link-extraction.ts';

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

export interface ExtractOpts {
  /** What to extract: 'links' (wiki-style refs), 'timeline' (date entries), or 'all'. */
  mode: 'links' | 'timeline' | 'all';
  /** Brain directory to walk. */
  dir: string;
  /** Report what would change without writing. */
  dryRun?: boolean;
  /** Emit JSON (progress to stderr, result to stdout) instead of human text. */
  jsonMode?: boolean;
}

/**
 * Library-level extract. Throws on error; prints nothing unless jsonMode or
 * explicit output is warranted. Safe to call from Minions handlers because it
 * never calls process.exit — a bad mode or missing dir throws through, which
 * the handler wrapper turns into a failed job (NOT a killed worker).
 */
export async function runExtractCore(engine: BrainEngine, opts: ExtractOpts): Promise<ExtractResult> {
  if (!['links', 'timeline', 'all'].includes(opts.mode)) {
    throw new Error(`Invalid extract mode "${opts.mode}". Allowed: links, timeline, all.`);
  }
  if (!existsSync(opts.dir)) {
    throw new Error(`Directory not found: ${opts.dir}`);
  }

  const dryRun = !!opts.dryRun;
  const jsonMode = !!opts.jsonMode;
  const result: ExtractResult = { links_created: 0, timeline_entries_created: 0, pages_processed: 0 };

  if (opts.mode === 'links' || opts.mode === 'all') {
    const r = await extractLinksFromDir(engine, opts.dir, dryRun, jsonMode);
    result.links_created = r.created;
    result.pages_processed = r.pages;
  }
  if (opts.mode === 'timeline' || opts.mode === 'all') {
    const r = await extractTimelineFromDir(engine, opts.dir, dryRun, jsonMode);
    result.timeline_entries_created = r.created;
    result.pages_processed = Math.max(result.pages_processed, r.pages);
  }

  return result;
}

export async function runExtract(engine: BrainEngine, args: string[]) {
  const subcommand = args[0];
  const dirIdx = args.indexOf('--dir');
  const brainDir = (dirIdx >= 0 && dirIdx + 1 < args.length) ? args[dirIdx + 1] : '.';
  const sourceIdx = args.indexOf('--source');
  const source = (sourceIdx >= 0 && sourceIdx + 1 < args.length) ? args[sourceIdx + 1] : 'fs';
  const typeIdx = args.indexOf('--type');
  const typeFilter = (typeIdx >= 0 && typeIdx + 1 < args.length) ? (args[typeIdx + 1] as PageType) : undefined;
  const sinceIdx = args.indexOf('--since');
  const since = (sinceIdx >= 0 && sinceIdx + 1 < args.length) ? args[sinceIdx + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  // Validate --since upfront. Without this, an invalid date like
  // `--since yesterday` produces NaN which silently passes the filter check
  // (Number.isFinite(NaN) === false), so the user thinks they ran an
  // incremental extract but actually reprocessed the whole brain.
  if (since !== undefined) {
    const sinceMs = new Date(since).getTime();
    if (!Number.isFinite(sinceMs)) {
      console.error(`Invalid --since date: "${since}". Must be a parseable date (e.g., "2026-01-15" or full ISO timestamp).`);
      process.exit(1);
    }
  }

  if (!subcommand || !['links', 'timeline', 'all'].includes(subcommand)) {
    console.error('Usage: gbrain extract <links|timeline|all> [--source fs|db] [--dir <brain-dir>] [--dry-run] [--json] [--type T] [--since DATE]');
    process.exit(1);
  }

  if (source !== 'fs' && source !== 'db') {
    console.error(`Invalid --source: ${source}. Must be 'fs' or 'db'.`);
    process.exit(1);
  }

  // FS source needs a brain dir; DB source ignores --dir.
  if (source === 'fs' && !existsSync(brainDir)) {
    console.error(`Directory not found: ${brainDir}`);
    process.exit(1);
  }

  let result: ExtractResult;
  try {
    if (source === 'db') {
      // DB source: walk pages from the engine. The unified runExtractCore
      // is fs-only; we keep the dual codepath here so Minions handlers
      // can opt in via mode + source.
      result = { links_created: 0, timeline_entries_created: 0, pages_processed: 0 };
      if (subcommand === 'links' || subcommand === 'all') {
        const r = await extractLinksFromDB(engine, dryRun, jsonMode, typeFilter, since);
        result.links_created = r.created;
        result.pages_processed = r.pages;
      }
      if (subcommand === 'timeline' || subcommand === 'all') {
        const r = await extractTimelineFromDB(engine, dryRun, jsonMode, typeFilter, since);
        result.timeline_entries_created = r.created;
        result.pages_processed = Math.max(result.pages_processed, r.pages);
      }
    } else {
      result = await runExtractCore(engine, {
        mode: subcommand as 'links' | 'timeline' | 'all',
        dir: brainDir,
        dryRun,
        jsonMode,
      });
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
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
        existing.add(`${page.slug}::${entry.date}::${entry.summary}`);
      }
    }
  } catch { /* fresh brain */ }

  let created = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const slug = files[i].relPath.replace('.md', '');
      for (const entry of extractTimelineFromContent(content, slug)) {
        const key = `${entry.slug}::${entry.date}::${entry.summary}`;
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
  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const link of extractLinksFromFile(content, slug + '.md', allSlugs)) {
        try { await engine.addLink(link.from_slug, link.to_slug, link.context, link.link_type); created++; } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return created;
}

export async function extractTimelineForSlugs(engine: BrainEngine, repoPath: string, slugs: string[]): Promise<number> {
  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const entry of extractTimelineFromContent(content, slug)) {
        try { await engine.addTimelineEntry(entry.slug, { date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail }); created++; } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return created;
}

// ─── DB-source extractors (v0.10.3 graph layer) ────────────────────────────
//
// Iterate pages from engine.getAllSlugs() and engine.getPage() instead of
// walking files on disk. Mutation-immune (snapshot) and works for brains with
// no local checkout (e.g. live MCP servers). Uses the typed link inference and
// timeline parser from src/core/link-extraction.ts.

async function extractLinksFromDB(
  engine: BrainEngine,
  dryRun: boolean,
  jsonMode: boolean,
  typeFilter: PageType | undefined,
  since: string | undefined,
): Promise<{ created: number; pages: number }> {
  const allSlugs = await engine.getAllSlugs();
  const slugList = Array.from(allSlugs);
  let processed = 0, created = 0;

  for (let i = 0; i < slugList.length; i++) {
    const slug = slugList[i];
    const page = await engine.getPage(slug);
    if (!page) continue;
    if (typeFilter && page.type !== typeFilter) continue;
    if (since) {
      const updatedMs = new Date(page.updated_at).getTime();
      const sinceMs = new Date(since).getTime();
      if (Number.isFinite(sinceMs) && updatedMs <= sinceMs) continue;
    }

    const fullContent = page.compiled_truth + '\n' + page.timeline;
    const candidates = extractPageLinks(fullContent, page.frontmatter, page.type);

    for (const c of candidates) {
      if (!allSlugs.has(c.targetSlug)) continue;
      if (dryRun) {
        if (jsonMode) {
          process.stdout.write(JSON.stringify({
            action: 'add_link', from: slug, to: c.targetSlug,
            type: c.linkType, context: c.context,
          }) + '\n');
        } else {
          console.log(`  ${slug} → ${c.targetSlug} (${c.linkType})`);
        }
        created++;
      } else {
        try {
          await engine.addLink(slug, c.targetSlug, c.context, c.linkType);
          created++;
        } catch { /* FK violation or other */ }
      }
    }
    processed++;
    if (jsonMode && !dryRun && (processed % 500 === 0 || i === slugList.length - 1)) {
      process.stderr.write(JSON.stringify({ event: 'progress', phase: 'extracting_links_db', done: processed, total: slugList.length }) + '\n');
    }
  }

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Links: ${label} ${created} from ${processed} pages (db source)`);
  }
  return { created, pages: processed };
}

async function extractTimelineFromDB(
  engine: BrainEngine,
  dryRun: boolean,
  jsonMode: boolean,
  typeFilter: PageType | undefined,
  since: string | undefined,
): Promise<{ created: number; pages: number }> {
  const allSlugs = await engine.getAllSlugs();
  const slugList = Array.from(allSlugs);
  let processed = 0, created = 0;

  for (let i = 0; i < slugList.length; i++) {
    const slug = slugList[i];
    const page = await engine.getPage(slug);
    if (!page) continue;
    if (typeFilter && page.type !== typeFilter) continue;
    if (since) {
      const updatedMs = new Date(page.updated_at).getTime();
      const sinceMs = new Date(since).getTime();
      if (Number.isFinite(sinceMs) && updatedMs <= sinceMs) continue;
    }

    const fullContent = page.compiled_truth + '\n' + page.timeline;
    const entries = parseTimelineEntries(fullContent);

    for (const entry of entries) {
      if (dryRun) {
        if (jsonMode) {
          process.stdout.write(JSON.stringify({
            action: 'add_timeline', slug, date: entry.date,
            summary: entry.summary, ...(entry.detail ? { detail: entry.detail } : {}),
          }) + '\n');
        } else {
          console.log(`  ${slug}: ${entry.date} — ${entry.summary}`);
        }
        created++;
      } else {
        try {
          await engine.addTimelineEntry(
            slug,
            { date: entry.date, summary: entry.summary, detail: entry.detail || '' },
            { skipExistenceCheck: true },
          );
          created++;
        } catch { /* dedup constraint or other */ }
      }
    }
    processed++;
    if (jsonMode && !dryRun && (processed % 500 === 0 || i === slugList.length - 1)) {
      process.stderr.write(JSON.stringify({ event: 'progress', phase: 'extracting_timeline_db', done: processed, total: slugList.length }) + '\n');
    }
  }

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Timeline: ${label} ${created} entries from ${processed} pages (db source)`);
  }
  return { created, pages: processed };
}
