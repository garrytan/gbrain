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
import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from '../core/engine.ts';
import type { PageType } from '../core/types.ts';
import { parseMarkdown } from '../core/markdown.ts';
import {
  extractPageLinks, parseTimelineEntries, inferLinkType, makeResolver,
  extractFrontmatterLinks,
  type UnresolvedFrontmatterRef,
} from '../core/link-extraction.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

// Batch size for addLinksBatch / addTimelineEntriesBatch.
// Postgres bind-parameter limit is 65535. Links use 4 cols/row → 16K hard ceiling;
// timeline uses 5 cols/row → 13K hard ceiling. 100 is conservative on round-trip
// count but safe at any future schema width and keeps per-batch error blast radius
// small (a malformed row aborts at most 100, not thousands).
const BATCH_SIZE = 100;

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

/**
 * Extract markdown links to .md files (relative paths only).
 *
 * Handles two syntaxes:
 *   1. Standard markdown:  [text](relative/path.md)
 *   2. Wikilinks:          [[relative/path]] or [[relative/path|Display Text]]
 *
 * Both are resolved relative to the file that contains them. External URLs
 * (containing ://) are always skipped. For wikilinks, the .md suffix is added
 * if absent and section anchors (#heading) are stripped.
 */
export function extractMarkdownLinks(content: string): { name: string; relTarget: string }[] {
  const results: { name: string; relTarget: string }[] = [];

  const mdPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = mdPattern.exec(content)) !== null) {
    const target = match[2];
    if (target.includes('://')) continue;
    results.push({ name: match[1], relTarget: target });
  }

  const wikiPattern = /\[\[([^|\]]+?)(?:\|[^\]]*?)?\]\]/g;
  while ((match = wikiPattern.exec(content)) !== null) {
    const rawPath = match[1].trim();
    if (rawPath.includes('://')) continue;
    const hashIdx = rawPath.indexOf('#');
    const pagePath = hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath;
    if (!pagePath) continue;
    const relTarget = pagePath.endsWith('.md') ? pagePath : pagePath + '.md';
    const pipeIdx = match[0].indexOf('|');
    const displayName = pipeIdx >= 0 ? match[0].slice(pipeIdx + 1, -2).trim() : rawPath;
    results.push({ name: displayName, relTarget });
  }

  return results;
}

/**
 * Resolve a wikilink target to a canonical slug, given the directory of the
 * containing page and the set of all known slugs in the brain.
 *
 * Wiki KBs often use inconsistent relative depths. Authors omit one or more
 * leading `../` because they think in "wiki-root-relative" terms. Resolution
 * order (first match wins):
 *   1. Standard `join(fileDir, relTarget)` — exact relative path as written
 *   2. Ancestor search — strip leading path components from fileDir, retry
 *
 * Returns null when no matching slug is found (dangling link).
 */
export function resolveSlug(fileDir: string, relTarget: string, allSlugs: Set<string>): string | null {
  const targetNoExt = relTarget.endsWith('.md') ? relTarget.slice(0, -3) : relTarget;

  const s1 = join(fileDir, targetNoExt);
  if (allSlugs.has(s1)) return s1;

  const parts = fileDir.split('/').filter(Boolean);
  for (let strip = 1; strip <= parts.length; strip++) {
    const ancestor = parts.slice(0, parts.length - strip).join('/');
    const candidate = ancestor ? join(ancestor, targetNoExt) : targetNoExt;
    if (allSlugs.has(candidate)) return candidate;
  }

  return null;
}

/**
 * Directory-based link-type inference for the fs-source path.
 *
 * FS-source operates without a BrainEngine. We have paths, not pages. This
 * helper looks at source + target directories and returns a type aligned
 * with the canonical `inferLinkType` in link-extraction.ts (calibrated
 * verb-based inference for db-source).
 *
 * v0.13: aligned type names with link-extraction.ts (was: 'mention' →
 * 'mentions', 'attendee' → 'attended'). Diverged historically; the v0_13_0
 * migration normalizes any legacy rows on existing brains.
 */
function inferTypeByDir(fromDir: string, toDir: string, frontmatter?: Record<string, unknown>): string {
  const from = fromDir.split('/')[0];
  const to = toDir.split('/')[0];
  if (from === 'people' && to === 'companies') {
    if (Array.isArray(frontmatter?.founded)) return 'founded';
    return 'works_at';
  }
  if (from === 'people' && to === 'deals') return 'involved_in';
  if (from === 'deals' && to === 'companies') return 'deal_for';
  if (from === 'meetings' && to === 'people') return 'attended';
  return 'mentions';
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

/**
 * Full link extraction from a single markdown file (FS-source path).
 *
 * Async (v0.13): uses the canonical `extractFrontmatterLinks` via a
 * synthetic resolver backed by the pre-loaded `allSlugs` Set. No DB,
 * no fuzzy match — FS-source resolves only when the dir-hint + slugify
 * of the frontmatter value hits an actual file path. That mirrors the
 * fs path's existing "exact match against disk" behavior.
 */
export async function extractLinksFromFile(
  content: string, relPath: string, allSlugs: Set<string>,
  opts?: { includeFrontmatter?: boolean },
): Promise<ExtractedLink[]> {
  const links: ExtractedLink[] = [];
  const slug = relPath.replace('.md', '');
  const fileDir = dirname(relPath);
  const fm = parseFrontmatterFromContent(content, relPath);

  for (const { name, relTarget } of extractMarkdownLinks(content)) {
    const resolved = resolveSlug(fileDir, relTarget, allSlugs);
    if (resolved !== null) {
      links.push({
        from_slug: slug, to_slug: resolved,
        link_type: inferTypeByDir(fileDir, dirname(resolved), fm),
        context: `markdown link: [${name}]`,
      });
    }
  }

  if (opts?.includeFrontmatter) {
    // Synthetic sync-ish resolver: only does step 1 (already a slug) and
    // step 2 (dir-hint + slugify), backed by the Set of all known slugs.
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    const fsResolver = {
      async resolve(name: string, dirHint?: string | string[]): Promise<string | null> {
        if (!name) return null;
        const trimmed = name.trim();
        if (/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(trimmed) && allSlugs.has(trimmed)) {
          return trimmed;
        }
        const hints = Array.isArray(dirHint) ? dirHint : (dirHint ? [dirHint] : []);
        for (const hint of hints) {
          if (!hint) continue;
          const candidate = `${hint}/${slugify(trimmed)}`;
          if (allSlugs.has(candidate)) return candidate;
        }
        return null;
      },
    };
    // Guess the page type from its directory for field-map filtering.
    const topDir = slug.split('/')[0];
    const pageType = topDir === 'people' ? 'person'
      : topDir === 'companies' ? 'company'
      : topDir === 'deals' || topDir === 'deal' ? 'deal'
      : topDir === 'meetings' ? 'meeting'
      : 'concept';
    const fm = parseFrontmatterFromContent(content, relPath);
    const fmLinks = await extractFrontmatterLinks(slug, pageType as never, fm, fsResolver);
    for (const c of fmLinks.candidates) {
      links.push({
        from_slug: c.fromSlug ?? slug,
        to_slug: c.targetSlug,
        link_type: c.linkType,
        context: c.context,
      });
    }
  }

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
  /**
   * Incremental mode: only extract from these specific slugs.
   * When provided, skips the full directory walk and reads only the
   * files corresponding to these slugs. Massive perf win on large brains.
   * Pass undefined or omit for a full walk (CLI / first-run path).
   */
  slugs?: string[];
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

  // Incremental path: if specific slugs provided, only extract from those files.
  // This is the cycle path — sync tells us what changed, we only re-extract those.
  if (opts.slugs !== undefined) {
    if (opts.slugs.length === 0) {
      // Nothing changed — skip entirely.
      return result;
    }
    const r = await extractForSlugs(engine, opts.dir, opts.slugs, opts.mode, dryRun, jsonMode);
    result.links_created = r.links_created;
    result.timeline_entries_created = r.timeline_created;
    result.pages_processed = r.pages;
    return result;
  }

  // Full walk path: CLI `gbrain extract` or first-run.
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
  // --include-frontmatter: v0.13 flag. Default OFF for back-compat. The
  // v0_13_0 migration orchestrator runs this once under the hood; users
  // opt in for subsequent runs.
  const includeFrontmatter = args.includes('--include-frontmatter');

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
        const r = await extractLinksFromDB(engine, dryRun, jsonMode, typeFilter, since, { includeFrontmatter });
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

/**
 * Incremental extract: process only the specified slugs.
 *
 * Instead of walking 54K+ files, reads only the files that sync says changed.
 * Still needs the full slug set for link resolution (resolveSlug needs to know
 * all valid targets), but that's a single readdir, not 54K readFileSync calls.
 *
 * Combines links + timeline extraction in a single pass over each file —
 * the full-walk path reads every file TWICE (once for links, once for timeline).
 */
async function extractForSlugs(
  engine: BrainEngine,
  brainDir: string,
  slugs: string[],
  mode: 'links' | 'timeline' | 'all',
  dryRun: boolean,
  jsonMode: boolean,
): Promise<{ links_created: number; timeline_created: number; pages: number }> {
  // Build the full slug set for link resolution (fast: just readdir, no file reads)
  const allFiles = walkMarkdownFiles(brainDir);
  const allSlugs = new Set(allFiles.map(f => f.relPath.replace('.md', '')));

  const doLinks = mode === 'links' || mode === 'all';
  const doTimeline = mode === 'timeline' || mode === 'all';

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.incremental', slugs.length);

  let linksCreated = 0;
  let timelineCreated = 0;
  let pagesProcessed = 0;

  const linkBatch: LinkBatchInput[] = [];
  const timelineBatch: TimelineBatchInput[] = [];

  async function flushLinks() {
    if (linkBatch.length === 0) return;
    try {
      linksCreated += await engine.addLinksBatch(linkBatch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!jsonMode) console.error(`  link batch error (${linkBatch.length} rows lost): ${msg}`);
    } finally {
      linkBatch.length = 0;
    }
  }

  async function flushTimeline() {
    if (timelineBatch.length === 0) return;
    try {
      timelineCreated += await engine.addTimelineEntriesBatch(timelineBatch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!jsonMode) console.error(`  timeline batch error (${timelineBatch.length} rows lost): ${msg}`);
    } finally {
      timelineBatch.length = 0;
    }
  }

  for (const slug of slugs) {
    const relPath = slug + '.md';
    const fullPath = join(brainDir, relPath);

    try {
      if (!existsSync(fullPath)) continue; // deleted file — sync already handled removal
      const content = readFileSync(fullPath, 'utf-8');

      // Links
      if (doLinks) {
        const links = await extractLinksFromFile(content, relPath, allSlugs);
        for (const link of links) {
          if (dryRun) {
            if (!jsonMode) console.log(`  ${link.from_slug} → ${link.to_slug} (${link.link_type})`);
            linksCreated++;
          } else {
            linkBatch.push(link);
            if (linkBatch.length >= BATCH_SIZE) await flushLinks();
          }
        }
      }

      // Timeline
      if (doTimeline) {
        const entries = extractTimelineFromContent(content, slug);
        for (const entry of entries) {
          if (dryRun) {
            if (!jsonMode) console.log(`  ${entry.slug}: ${entry.date} — ${entry.summary}`);
            timelineCreated++;
          } else {
            timelineBatch.push({ slug: entry.slug, date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail });
            if (timelineBatch.length >= BATCH_SIZE) await flushTimeline();
          }
        }
      }

      pagesProcessed++;
    } catch { /* skip unreadable */ }
    progress.tick(1);
  }

  await flushLinks();
  await flushTimeline();
  progress.finish();

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Incremental extract: ${label} ${linksCreated} link(s), ${timelineCreated} timeline entries from ${pagesProcessed}/${slugs.length} page(s)`);
  }

  return { links_created: linksCreated, timeline_created: timelineCreated, pages: pagesProcessed };
}

async function extractLinksFromDir(
  engine: BrainEngine, brainDir: string, dryRun: boolean, jsonMode: boolean,
): Promise<{ created: number; pages: number }> {
  const files = walkMarkdownFiles(brainDir);
  const allSlugs = new Set(files.map(f => f.relPath.replace('.md', '')));

  // Progress stream on stderr (separate from the action-events --json writes
  // to stdout, which tests grep for). Rate-gated; respects global --quiet /
  // --progress-json flags.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.links_fs', files.length);

  // Dedup in dry-run only — DB enforces uniqueness via ON CONFLICT in batch writes.
  // Without this, the same link extracted from N files would print N times in --dry-run.
  const dryRunSeen = dryRun ? new Set<string>() : null;

  let created = 0;
  const batch: LinkBatchInput[] = [];
  async function flush() {
    if (batch.length === 0) return;
    try {
      created += await engine.addLinksBatch(batch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: batch.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${batch.length} link rows lost): ${msg}`);
      }
    } finally {
      batch.length = 0;
    }
  }

  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const links = await extractLinksFromFile(content, files[i].relPath, allSlugs);
      for (const link of links) {
        if (dryRunSeen) {
          const key = `${link.from_slug}::${link.to_slug}::${link.link_type}`;
          if (dryRunSeen.has(key)) continue;
          dryRunSeen.add(key);
          if (!jsonMode) console.log(`  ${link.from_slug} → ${link.to_slug} (${link.link_type})`);
          created++;
        } else {
          batch.push(link);
          if (batch.length >= BATCH_SIZE) await flush();
        }
      }
    } catch { /* skip unreadable */ }
    progress.tick(1);
  }
  await flush();
  progress.finish();

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

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.timeline_fs', files.length);

  // Dedup in dry-run only — DB enforces uniqueness via ON CONFLICT in batch writes.
  const dryRunSeen = dryRun ? new Set<string>() : null;

  let created = 0;
  const batch: TimelineBatchInput[] = [];
  async function flush() {
    if (batch.length === 0) return;
    try {
      created += await engine.addTimelineEntriesBatch(batch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: batch.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${batch.length} timeline rows lost): ${msg}`);
      }
    } finally {
      batch.length = 0;
    }
  }

  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const slug = files[i].relPath.replace('.md', '');
      for (const entry of extractTimelineFromContent(content, slug)) {
        if (dryRunSeen) {
          const key = `${entry.slug}::${entry.date}::${entry.summary}`;
          if (dryRunSeen.has(key)) continue;
          dryRunSeen.add(key);
          if (!jsonMode) console.log(`  ${entry.slug}: ${entry.date} — ${entry.summary}`);
          created++;
        } else {
          batch.push({ slug: entry.slug, date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail });
          if (batch.length >= BATCH_SIZE) await flush();
        }
      }
    } catch { /* skip unreadable */ }
    progress.tick(1);
  }
  await flush();
  progress.finish();

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
      for (const link of await extractLinksFromFile(content, slug + '.md', allSlugs)) {
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
  opts?: { includeFrontmatter?: boolean },
): Promise<{ created: number; pages: number; unresolved: UnresolvedFrontmatterRef[] }> {
  const includeFrontmatter = opts?.includeFrontmatter ?? false;
  // Batch resolver: pg_trgm + exact only, NO search fallback. Dodges the
  // N-thousand API call trap on 46K-page brains. Resolver has a per-run
  // cache so duplicate names (same person appearing on many pages) resolve
  // once, not once per mention.
  const resolver = makeResolver(engine, { mode: 'batch' });
  const unresolved: UnresolvedFrontmatterRef[] = [];
  const nullResolver = {
    resolve: async () => null as string | null,
  };
  const allSlugs = await engine.getAllSlugs();
  const slugList = Array.from(allSlugs);
  let processed = 0, created = 0;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.links_db', slugList.length);

  // Dedup in dry-run only — DB enforces uniqueness via ON CONFLICT in batch writes.
  const dryRunSeen = dryRun ? new Set<string>() : null;

  const batch: LinkBatchInput[] = [];
  async function flush() {
    if (batch.length === 0) return;
    try {
      created += await engine.addLinksBatch(batch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: batch.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${batch.length} link rows lost): ${msg}`);
      }
    } finally {
      batch.length = 0;
    }
  }

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
    // --include-frontmatter default OFF in v0.13 (codex tension 5, back-compat).
    // Migration orchestrator explicitly enables it for the one-time backfill;
    // user-invoked `gbrain extract links` stays outgoing-only.
    const activeResolver = includeFrontmatter ? resolver : nullResolver;
    const extracted = await extractPageLinks(
      slug, fullContent, page.frontmatter, page.type, activeResolver,
    );
    unresolved.push(...extracted.unresolved);

    for (const c of extracted.candidates) {
      // Validate BOTH endpoints exist. Incoming frontmatter edges have
      // fromSlug !== the page being processed; we need that page to exist
      // too or the JOIN drops the row anyway.
      const fromSlug = c.fromSlug ?? slug;
      if (!allSlugs.has(c.targetSlug)) continue;
      if (!allSlugs.has(fromSlug)) continue;
      if (dryRunSeen) {
        const key = `${fromSlug}::${c.targetSlug}::${c.linkType}::${c.linkSource ?? 'markdown'}`;
        if (dryRunSeen.has(key)) continue;
        dryRunSeen.add(key);
        if (jsonMode) {
          process.stdout.write(JSON.stringify({
            action: 'add_link', from: fromSlug, to: c.targetSlug,
            type: c.linkType, context: c.context, link_source: c.linkSource,
          }) + '\n');
        } else {
          console.log(`  ${fromSlug} → ${c.targetSlug} (${c.linkType})${c.linkSource === 'frontmatter' ? ' [fm]' : ''}`);
        }
        created++;
      } else {
        batch.push({
          from_slug: fromSlug,
          to_slug: c.targetSlug,
          link_type: c.linkType,
          context: c.context,
          link_source: c.linkSource,
          origin_slug: c.originSlug,
          origin_field: c.originField,
        });
        if (batch.length >= BATCH_SIZE) await flush();
      }
    }
    processed++;
    progress.tick(1);
  }
  await flush();
  progress.finish();

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Links: ${label} ${created} from ${processed} pages (db source)`);
    if (includeFrontmatter && unresolved.length > 0) {
      // Top-20 preview of unresolvable frontmatter names so the user can
      // see where the graph has holes (codex tension 6.4).
      console.log(`Unresolved frontmatter refs: ${unresolved.length} total`);
      const bucket = new Map<string, number>();
      for (const u of unresolved) {
        const key = `${u.field}:${u.name}`;
        bucket.set(key, (bucket.get(key) || 0) + 1);
      }
      const top = Array.from(bucket.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
      for (const [key, count] of top) {
        console.log(`  ${count}× ${key}`);
      }
    }
  }
  return { created, pages: processed, unresolved };
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

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.timeline_db', slugList.length);

  // Dedup in dry-run only — DB enforces uniqueness via ON CONFLICT in batch writes.
  const dryRunSeen = dryRun ? new Set<string>() : null;

  const batch: TimelineBatchInput[] = [];
  async function flush() {
    if (batch.length === 0) return;
    try {
      created += await engine.addTimelineEntriesBatch(batch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: batch.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${batch.length} timeline rows lost): ${msg}`);
      }
    } finally {
      batch.length = 0;
    }
  }

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
      if (dryRunSeen) {
        const key = `${slug}::${entry.date}::${entry.summary}`;
        if (dryRunSeen.has(key)) continue;
        dryRunSeen.add(key);
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
        batch.push({ slug, date: entry.date, summary: entry.summary, detail: entry.detail || '' });
        if (batch.length >= BATCH_SIZE) await flush();
      }
    }
    processed++;
    progress.tick(1);
  }
  await flush();
  progress.finish();

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Timeline: ${label} ${created} entries from ${processed} pages (db source)`);
  }
  return { created, pages: processed };
}
