/**
 * v0.41.13.0 T19 retrofit note: extract has TWO sources (fs walk + db
 * walk) and TWO data kinds (links + timeline). Each combination has its
 * own buffer-then-flush pattern at BATCH_SIZE. The
 * `src/core/progressive-batch/` primitive's stage model is a poor fit
 * here because (a) extraction is pure deterministic regex (no LLM cost
 * to gate), (b) the cost-cap value-add lives at the embed step that
 * follows extract, not at extract itself, and (c) wrapping 4 separate
 * batch sites in the primitive would balloon the diff without
 * observable operator value. Filed in TODOS.md as v0.41.14.0+ if the
 * primitive's audit JSONL value justifies the ceremony. No code change
 * in v0.41.13.0; cost-free extract continues as-is.
 *
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
  extractFrontmatterLinks, isGlobalBasenameEnabled, LINK_EXTRACTOR_VERSION_TS,
  WIKILINK_BASENAME_LINK_TYPE,
  buildBasenameIndex, queryBasenameIndex, stripCodeBlocks,
  type UnresolvedFrontmatterRef, type LinkCandidate,
} from '../core/link-extraction.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { pathToSlug, pruneDir, isSyncable } from '../core/sync.ts';
// v0.41.18.0: withRetry + isRetryableConnError + WithRetryOpts moved to
// src/core/retry.ts as the canonical primitive. Engine methods
// (addLinksBatch/addTimelineEntriesBatch/upsertChunks) now self-retry via
// engine-level wrap; call sites here will be unwrapped in T4. Re-exported
// from this module for now to preserve any out-of-tree callers' import paths;
// the next major version may drop the re-export.
import { withRetry, isRetryableConnError } from '../core/retry.ts';
export { withRetry };
export type { WithRetryOpts } from '../core/retry.ts';
import { buildGazetteer, findMentionedEntities } from '../core/by-mention.ts';
import {
  loadOpCheckpoint, recordCompleted, clearOpCheckpoint, mentionsFingerprint,
} from '../core/op-checkpoint.ts';
import { createHash } from 'crypto';
// v0.41.15.0 (T7, D9): --workers N for the fs-walk inner loops via the
// shared sliding-pool helper + PGLite-clamp wrapper.
import { runSlidingPool } from '../core/worker-pool.ts';
import { parseWorkers, resolveWorkersWithClamp } from '../core/sync-concurrency.ts';

// Batch size for addLinksBatch / addTimelineEntriesBatch.
// Postgres bind-parameter limit is 65535. Links use 4 cols/row → 16K hard ceiling;
// timeline uses 5 cols/row → 13K hard ceiling. 100 is conservative on round-trip
// count but safe at any future schema width and keeps per-batch error blast radius
// small (a malformed row aborts at most 100, not thousands).
const BATCH_SIZE = 100;

// v0.42.7 (#1696): keyset batch size for `extract --stale`. SMALL by design —
// listStalePagesForExtraction returns page CONTENT (compiled_truth + timeline),
// which is unbounded (25MB transcript pages exist). The LIMIT is the only memory
// bound: the per-batch byte cap CDX-5 described can't run post-fetch (the fetch
// itself is the OOM point), so a small default count is the real safety net —
// 25 caps the worst case at ~625MB even if every page is a 25MB transcript.
// Normal pages are KBs; raise via GBRAIN_EXTRACT_STALE_BATCH for throughput.
const STALE_BATCH_SIZE = Math.max(1, Number(process.env.GBRAIN_EXTRACT_STALE_BATCH) || 25);
// v0.42.7: wall-clock budget for one `extract --stale` invocation (default
// 30 min). `--catch-up` removes the cap (loops until 0 stale). Mirrors
// embedAllStale's time-budget shape.
const STALE_TIME_BUDGET_MS = Math.max(1000, Number(process.env.GBRAIN_EXTRACT_TIME_BUDGET_MS) || 30 * 60 * 1000);

/**
 * v0.42.7 (#1696): best-effort extraction stamp for the source-correct write
 * sites (inline sync, `extract --source db`). Wraps `markPagesExtractedBatch`
 * and NEVER throws — a stamp failure here just means the page stays "stale" and
 * gets swept by `extract --stale` later. Do NOT use this in the `--stale` sweep
 * itself: there the stamp is the resume mechanism and a failure must surface
 * (CDX-4 — see extractStaleFromDB).
 */
export async function stampExtracted(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string }>,
  at: string = new Date().toISOString(),
): Promise<void> {
  if (refs.length === 0) return;
  try {
    await engine.markPagesExtractedBatch(refs, at);
  } catch { /* best-effort: page stays stale, extract --stale re-sweeps it */ }
}

/**
 * v0.42.7 (#1696): pure cross-source resolution for one extracted link
 * candidate. Validates both endpoints exist (else the batch JOIN drops the row),
 * then picks from_source_id / to_source_id: prefer the origin page's source,
 * fall back to 'default', else skip (never push a wrong-source edge). Returns
 * null when the candidate should be skipped. Shared by extractLinksFromDB and
 * extractStaleFromDB so the F10 multi-source resolution can't drift.
 */
export function resolveCandidateSources(
  c: LinkCandidate,
  pageSlug: string,
  pageSourceId: string,
  allSlugs: Set<string>,
  slugToSources: Map<string, string[]>,
): { fromSlug: string; fromSourceId: string; toSourceId: string } | null {
  const fromSlug = c.fromSlug ?? pageSlug;
  if (!allSlugs.has(c.targetSlug)) return null;
  if (!allSlugs.has(fromSlug)) return null;
  const fromSources = slugToSources.get(fromSlug) ?? [];
  const fromSourceId = fromSources.includes(pageSourceId) ? pageSourceId
    : (fromSources.includes('default') ? 'default' : fromSources[0]);
  const targetSources = slugToSources.get(c.targetSlug) ?? [];
  let toSourceId: string;
  if (targetSources.includes(fromSourceId)) {
    toSourceId = fromSourceId;
  } else if (targetSources.includes('default')) {
    toSourceId = 'default';
  } else {
    return null;
  }
  return { fromSlug, fromSourceId, toSourceId };
}

// isRetryableConnError reference retained for any inline classification at
// call sites. Engine-level retry uses the same predicate via core/retry.ts.
void isRetryableConnError;

export function logBatchRetry(
  label: string,
  snapshotLen: number,
  err: unknown,
  jsonMode: boolean,
): void {
  if (jsonMode) return;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    `[${label}] connection blip, retrying ${snapshotLen} rows in 500ms (${msg})`,
  );
}

// --- Types ---

export interface ExtractedLink {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
  // Issue #972: provenance for FS-source edges. Set to 'wikilink-resolved'
  // on basename-matched bare wikilinks so the FS path tags them the same way
  // the DB / put_page paths do. Undefined for ordinary markdown edges (the
  // engine defaults those to 'markdown').
  link_source?: string;
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
  // Descent-time pruning + emit-time isSyncable filter (closes #923, #202).
  // Pre-fix, this walker had only an ad-hoc dot-prefix exclusion and didn't
  // call isSyncable at all — so it descended into `node_modules/`, emitted
  // markdown files from there, AND ignored the canonical exclusion list
  // (`.raw/`, `ops/`, README.md, etc.). Now: pruneDir skips entire vendor
  // subtrees before recursion (saving IO), and isSyncable filters the emit
  // set against the canonical markdown-strategy rules.
  const files: { path: string; relPath: string }[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        const st = lstatSync(full);
        if (st.isDirectory()) {
          // v0.37.7.0 #1169: pass parentDir so pruneDir can detect git
          // submodule pointers (`.git` as a file inside the candidate).
          if (!pruneDir(entry, d)) continue;
          walk(full);
        } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
          const rel = relative(dir, full);
          if (!isSyncable(rel, { strategy: 'markdown' })) continue;
          files.push({ path: full, relPath: rel });
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
 * Issue #972: return every slug whose basename matches `name` (the
 * final path segment, with case-insensitive + slugified fallback keys).
 * Pure-function variant of the resolver's `resolveBasenameMatches` that
 * reads a pre-loaded Set directly — no engine call. Used by the
 * FS-source path's `resolveSlugAll`.
 *
 * Matches are deterministically sorted (shortest-slug first, then
 * lexical) so repeated runs over the same brain produce stable edges.
 * Returns `[]` on empty input or no matches.
 */
export function resolveBasenameMatchesFromSlugs(
  name: string, allSlugs: Set<string>,
): string[] {
  // Issue #972 (codex [P2] DRY): delegate to the shared matcher so the FS
  // path keys + sorts identically to the resolver and doctor. (Per-call
  // index build is O(N), the same cost as the prior inline scan.)
  return queryBasenameIndex(buildBasenameIndex(allSlugs), name);
}

/**
 * Issue #972: multi-match variant of `resolveSlug`. Always tries the
 * existing ancestor walk first (preserving the v0.10.1 behavior); on
 * miss, falls back to basename lookup against `allSlugs` when
 * `opts.globalBasename === true`. Returns an array so the caller emits
 * one graph edge per matching page.
 *
 * Return shape:
 *   - Ancestor walk hits → `[ancestor_match]` (length 1)
 *   - Ancestor walk misses + globalBasename off → `[]`
 *   - Ancestor walk misses + globalBasename on + basename hits → all matches
 *   - Ancestor walk misses + globalBasename on + no basename hits → `[]`
 */
export function resolveSlugAll(
  fileDir: string, relTarget: string, allSlugs: Set<string>,
  opts: { globalBasename?: boolean } = {},
): string[] {
  const direct = resolveSlug(fileDir, relTarget, allSlugs);
  if (direct !== null) return [direct];
  if (!opts.globalBasename) return [];
  // Strip .md suffix + dirname so `[[struktura]]` (relTarget=`struktura.md`)
  // and `[[notes/struktura]]` (relTarget=`notes/struktura.md`) both query
  // for the basename `struktura`.
  const targetNoExt = relTarget.endsWith('.md') ? relTarget.slice(0, -3) : relTarget;
  const basename = targetNoExt.includes('/')
    ? targetNoExt.slice(targetNoExt.lastIndexOf('/') + 1)
    : targetNoExt;
  return resolveBasenameMatchesFromSlugs(basename, allSlugs);
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
  opts?: { includeFrontmatter?: boolean; globalBasename?: boolean },
): Promise<ExtractedLink[]> {
  const links: ExtractedLink[] = [];
  const slug = pathToSlug(relPath);
  const fileDir = dirname(relPath);
  const fm = parseFrontmatterFromContent(content, relPath);
  // Issue #972: globalBasename routes bare `[[name]]` wikilinks through
  // basename lookup against allSlugs when the ancestor walk fails. Off
  // by default for back-compat with the v0.10.1 ancestor-only behavior.
  const globalBasename = opts?.globalBasename ?? false;

  // Issue #972 (codex [P2]): strip code fences before scanning so a
  // `[[name]]` inside a code block doesn't create an FS edge. Mirrors the
  // DB path, which goes through extractEntityRefs (which strips internally).
  const scanContent = stripCodeBlocks(content);

  for (const { name, relTarget } of extractMarkdownLinks(scanContent)) {
    const resolvedSlugs = resolveSlugAll(fileDir, relTarget, allSlugs, { globalBasename });
    if (resolvedSlugs.length === 0) continue;
    // Single hit on the ancestor path → emit one edge with the inferred
    // verb type. Multiple hits (only possible when globalBasename is on
    // AND ancestor walk missed) → emit one edge per match, all tagged
    // `wikilink_basename` so users can audit via `gbrain graph-query
    // <slug> --type wikilink_basename`.
    const isBasename = resolvedSlugs.length > 1
      || (globalBasename && resolvedSlugs.length === 1
          && resolveSlug(fileDir, relTarget, allSlugs) === null);
    for (const target of resolvedSlugs) {
      // Issue #972 (codex [P2]): drop a basename self-loop ([[own-tail]] on
      // its own page resolving back to itself).
      if (isBasename && target === slug) continue;
      links.push({
        from_slug: slug,
        to_slug: target,
        link_type: isBasename
          ? WIKILINK_BASENAME_LINK_TYPE
          : inferTypeByDir(fileDir, dirname(target), fm),
        context: isBasename
          ? `wikilink (basename match): [${name}]`
          : `markdown link: [${name}]`,
        // Issue #972: tag basename edges so the FS path matches DB/put_page
        // provenance and migration v112's widened CHECK is exercised here too.
        link_source: isBasename ? 'wikilink-resolved' : undefined,
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
  /**
   * v0.41.15.0 (D9): in-process parallel file workers for the fs-walk
   * loops. Default 1. PGLite engines clamp to 1 (single-writer; though
   * extract is mostly CPU-bound, the DB batch flush still hits the
   * write lock). Recommended 4-8 for very large brains where file IO +
   * regex parsing dominate wallclock.
   *
   * Honored by: extractLinksFromDir, extractTimelineFromDir, extractForSlugs.
   * NOT honored by: extractLinksFromDB, extractTimelineFromDB,
   * extractMentionsFromDb (DB-source paths) — those use the engine's
   * own pagination and stay serial in v0.41.15.0.
   */
  workers?: number;
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

  // v0.41.15.0 (D9): resolve workers via the PGLite-clamp wrapper.
  // Page count unknown at this point — pass 0 so the auto-path falls
  // back to override-or-1 instead of running the >100-files heuristic.
  const workersResolved = resolveWorkersWithClamp(
    engine,
    opts.workers,
    'extract',
    0,
  );
  const workers = workersResolved.workers;

  // Incremental path: if specific slugs provided, only extract from those files.
  // This is the cycle path — sync tells us what changed, we only re-extract those.
  if (opts.slugs !== undefined) {
    if (opts.slugs.length === 0) {
      // Nothing changed — skip entirely.
      return result;
    }
    const r = await extractForSlugs(engine, opts.dir, opts.slugs, opts.mode, dryRun, jsonMode, workers);
    result.links_created = r.links_created;
    result.timeline_entries_created = r.timeline_created;
    result.pages_processed = r.pages;
    return result;
  }

  // Full walk path: CLI `gbrain extract` or first-run.
  if (opts.mode === 'links' || opts.mode === 'all') {
    const r = await extractLinksFromDir(engine, opts.dir, dryRun, jsonMode, workers);
    result.links_created = r.created;
    result.pages_processed = r.pages;
  }
  if (opts.mode === 'timeline' || opts.mode === 'all') {
    const r = await extractTimelineFromDir(engine, opts.dir, dryRun, jsonMode, workers);
    result.timeline_entries_created = r.created;
    result.pages_processed = Math.max(result.pages_processed, r.pages);
  }

  return result;
}

export async function runExtract(engine: BrainEngine, args: string[]) {
  const subcommand = args[0];

  // v0.42 Wave C+D dispatch — new operator surfaces. These intercept
  // BEFORE the existing links/timeline/all subcommand validation so they
  // can use their own arg parsing.
  //
  //   gbrain extract status [--source-id ID] [--kind X] [--run-id Y] [--json]
  //   gbrain extract benchmark --pack X --kind Y [--json]
  //   gbrain extract --explain <kind>
  if (subcommand === 'status') {
    const { runExtractStatus } = await import('./extract-status.ts');
    return runExtractStatus(engine, args.slice(1));
  }
  if (subcommand === 'benchmark') {
    const { runExtractBenchmark } = await import('./extract-benchmark.ts');
    return runExtractBenchmark(engine, args.slice(1));
  }
  if (args.includes('--explain')) {
    const { runExtractExplain } = await import('./extract-explain.ts');
    return runExtractExplain(engine, args);
  }

  // v0.42.7 (#1696): `gbrain extract --stale` — incremental link+timeline sweep
  // over pages whose links_extracted_at watermark is stale. Intercepts BEFORE
  // the links|timeline|all subcommand validation so `gbrain extract --stale`
  // works with no subcommand (and `gbrain extract all --stale` too). DB-source
  // only — reads page content from the DB so it runs on checkout-less brains.
  if (args.includes('--stale')) {
    const sIdx = args.indexOf('--source');
    const src = (sIdx >= 0 && sIdx + 1 < args.length) ? args[sIdx + 1] : 'db';
    if (src === 'fs') {
      console.error(
        `extract --stale is DB-source only (reads page content from the database\n` +
        `so it works on checkout-less brains). Drop '--source fs' or pass '--source db'.`,
      );
      process.exit(1);
    }
    const sidIdx = args.indexOf('--source-id');
    const staleSourceId = (sidIdx >= 0 && sidIdx + 1 < args.length) ? args[sidIdx + 1] : undefined;
    await extractStaleFromDB(engine, {
      dryRun: args.includes('--dry-run'),
      jsonMode: args.includes('--json'),
      includeFrontmatter: args.includes('--include-frontmatter'),
      sourceIdFilter: staleSourceId,
      catchUp: args.includes('--catch-up'),
    });
    return;
  }

  const dirIdx = args.indexOf('--dir');
  const explicitDir = dirIdx >= 0 && dirIdx + 1 < args.length;
  // When --dir is not passed, resolve from the configured brain source
  // BEFORE falling back to '.' (the prior default). The bare `.` default was
  // a footgun: a user who runs `gbrain extract links` from anywhere outside
  // their brain dir (e.g., a project checkout with a node_modules tree) had
  // the recursive walker grab tens of thousands of unrelated .md files,
  // attempt to extract links between them, then write 0 rows because the
  // synthetic from_slugs don't match any pages row. The output ("created 0
  // links from 28989 pages") looks like a no-op, but it walked 28K junk files
  // first. Resolving from sources(local_path) makes the no-arg invocation
  // match what `gbrain sync` already does, and keeps cwd-cwd usage available
  // via explicit `--dir .`.
  let brainDir = explicitDir ? args[dirIdx + 1] : '.';
  const sourceIdx = args.indexOf('--source');
  const source = (sourceIdx >= 0 && sourceIdx + 1 < args.length) ? args[sourceIdx + 1] : 'fs';
  // v0.37.7.0 #1204: --source-id <id> scopes extraction to one brain
  // source. Separate flag from --source (fs|db) which is the
  // data-source axis. When unset, walks all sources together as today.
  const sourceIdIdx = args.indexOf('--source-id');
  const sourceIdFilter = (sourceIdIdx >= 0 && sourceIdIdx + 1 < args.length) ? args[sourceIdIdx + 1] : undefined;
  const typeIdx = args.indexOf('--type');
  const typeFilter = (typeIdx >= 0 && typeIdx + 1 < args.length) ? (args[typeIdx + 1] as string) : undefined;
  const sinceIdx = args.indexOf('--since');
  const since = (sinceIdx >= 0 && sinceIdx + 1 < args.length) ? args[sinceIdx + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');
  // --include-frontmatter: v0.13 flag. Default OFF for back-compat. The
  // v0_13_0 migration orchestrator runs this once under the hood; users
  // opt in for subsequent runs.
  const includeFrontmatter = args.includes('--include-frontmatter');
  // v0.41.18.0 Part B: --by-mention auto-link body-text entity mentions
  // via the gazetteer pass. Mode dispatch — when set, run ONLY the
  // mention pass (skip default link extract). DB-source only per D7;
  // FS-source is rejected with a paste-ready fix-hint below.
  const byMention = args.includes('--by-mention');
  // v0.41.18.0 (A10, T7): --ner is a NER-extraction mode dispatch. Same
  // DB-source-only posture as --by-mention. Can combine with --by-mention
  // in a single command for a shared-gazetteer walk (saves one pass).
  const ner = args.includes('--ner');
  // v0.41.18.0 (A11, T8): --from-meetings extracts timeline entries from
  // meeting pages onto each discussed entity. Timeline subcommand only.
  const fromMeetings = args.includes('--from-meetings');
  // v0.41.17.0 (T7, D9): --workers N parsed via the shared validator.
  // Honored on the fs-walk inner loops only; DB-source paths stay
  // serial in v0.41.17.0 (see ExtractOpts.workers doc).
  let workers: number | undefined;
  const workersIdx = args.indexOf('--workers');
  const concurrencyIdx = args.indexOf('--concurrency');
  const workersValIdx = workersIdx >= 0 ? workersIdx + 1 : (concurrencyIdx >= 0 ? concurrencyIdx + 1 : -1);
  if (workersValIdx > 0 && workersValIdx < args.length) {
    try {
      workers = parseWorkers(args[workersValIdx]);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }

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
    console.error(`Usage: gbrain extract <subcommand> [flags]

Extraction (existing):
  gbrain extract links    [--source fs|db] [--source-id <id>] [--dir <brain-dir>] [--dry-run] [--json] [--type T] [--since DATE] [--workers N]
  gbrain extract timeline [--source fs|db] [--source-id <id>] [--dir <brain-dir>] [--dry-run] [--json] [--type T] [--since DATE] [--workers N]
  gbrain extract all      [--source fs|db] [--source-id <id>] [--dir <brain-dir>] [--dry-run] [--json] [--type T] [--since DATE] [--workers N]
  gbrain extract <links|timeline> --by-mention --source db
  gbrain extract <links|timeline|all> --ner --source db
  gbrain extract <timeline|all> --from-meetings

Incremental sweep (v0.42.7):
  gbrain extract --stale [--source-id <id>] [--catch-up] [--dry-run] [--json]
      Re-extract links + timeline ONLY for pages whose extraction is stale
      (never extracted, edited since, or extractor bumped). DB-source; safe to
      cron. --catch-up loops past the 30-min wall-clock budget until 0 remain.

Inspection (v0.42):
  gbrain extract --explain <kind> [--json]
      Print resolution chain for one pack-declared extractable kind.
  gbrain extract benchmark --pack <name> --kind <type> [--json]
      Run a pack's fixture corpus through the extractor (v0.42 reports
      fixture shape; LLM dispatch comes in v0.43+).

Status (v0.42):
  gbrain extract status [--source-id ID] [--kind X] [--verbose] [--json]
      Per-kind 7-day rollup: cost, halt rate, eval pass/fail counts.`);
    process.exit(1);
  }

  if (source !== 'fs' && source !== 'db') {
    console.error(`Invalid --source: ${source}. Must be 'fs' or 'db'.`);
    process.exit(1);
  }

  // v0.41.18.0 D7: --by-mention requires DB-source. Gazetteer construction
  // needs the engine; mixing FS-walk with DB-gazetteer is incoherent
  // (you'd scan files on disk for mentions of entities that may not exist
  // in any synced page). Fail loud with a paste-ready fix-hint.
  if (byMention && source === 'fs') {
    console.error(
      `--by-mention requires --source db (currently --source fs). The mention scanner ` +
      `needs the engine to build the entity gazetteer. Re-run as:\n\n` +
      `  gbrain extract ${subcommand} --by-mention --source db` +
      (sourceIdFilter ? ` --source-id ${sourceIdFilter}` : '') +
      (since ? ` --since ${since}` : '') +
      (dryRun ? ' --dry-run' : '') + '\n',
    );
    process.exit(2);
  }
  if (byMention && subcommand === 'timeline') {
    console.error(
      `--by-mention is a links-pass only; it does not apply to timeline extraction. ` +
      `Re-run as 'gbrain extract links --by-mention' or 'gbrain extract all --by-mention'.`,
    );
    process.exit(2);
  }
  // v0.41.18.0 (T7): same gates for --ner.
  if (ner && source === 'fs') {
    console.error(
      `--ner requires --source db (currently --source fs). NER extraction needs the engine ` +
      `to build the entity gazetteer + read schema-pack link_types. Re-run as:\n\n` +
      `  gbrain extract ${subcommand} --ner --source db` +
      (sourceIdFilter ? ` --source-id ${sourceIdFilter}` : '') +
      (since ? ` --since ${since}` : '') +
      (dryRun ? ' --dry-run' : '') + '\n',
    );
    process.exit(2);
  }
  if (ner && subcommand === 'timeline') {
    console.error(
      `--ner is a links-pass only; it does not apply to timeline extraction.`,
    );
    process.exit(2);
  }
  // v0.41.18.0 (T8): --from-meetings is timeline-only + DB-source-only.
  if (fromMeetings && source === 'fs') {
    console.error(
      `--from-meetings requires --source db (currently --source fs). Re-run as:\n\n` +
      `  gbrain extract timeline --from-meetings --source db` +
      (sourceIdFilter ? ` --source-id ${sourceIdFilter}` : '') +
      (dryRun ? ' --dry-run' : '') + '\n',
    );
    process.exit(2);
  }
  if (fromMeetings && subcommand !== 'timeline' && subcommand !== 'all') {
    console.error(
      `--from-meetings is a timeline-pass only. Re-run as 'gbrain extract timeline --from-meetings' or 'gbrain extract all --from-meetings'.`,
    );
    process.exit(2);
  }

  // FS source needs a brain dir. When --dir wasn't passed, resolve from
  // sources(local_path) — same path `gbrain sync` uses — instead of
  // silently walking cwd. See the brainDir comment above for the footgun.
  if (source === 'fs' && !explicitDir) {
    const { getDefaultSourcePath } = await import('../core/source-resolver.ts');
    const configured = await getDefaultSourcePath(engine);
    if (configured) {
      brainDir = configured;
    } else {
      console.error(
        `No brain directory configured. Pass --dir <path> explicitly, or use --source db ` +
        `to extract from already-synced pages. To register a brain dir as the default, ` +
        `run: gbrain sources add default --path <brain-dir>`,
      );
      process.exit(1);
    }
  }

  // DB source ignores --dir.
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
      // v0.41.18.0: --by-mention is a mode dispatch. When set, run ONLY
      // the mention pass and skip the default link/frontmatter extract.
      // The two passes write different link_source values ('mentions' vs
      // 'markdown'/'frontmatter') so they don't conflict, but mixing them
      // in a single CLI invocation is surprising — keep the surfaces
      // separate.
      if (fromMeetings) {
        // v0.41.18.0 (T8): timeline-from-meetings runs SOLO (doesn't combine
        // with --by-mention/--ner because those are links passes).
        const { extractTimelineFromMeetings } = await import('../core/extract-timeline-from-meetings.ts');
        const r = await extractTimelineFromMeetings(engine, { dryRun, sourceIdFilter });
        result.timeline_entries_created = r.entries_created;
        result.pages_processed = r.meetings_scanned;
        if (!jsonMode) {
          console.log(`Timeline from meetings: ${r.entries_created} entries on ${r.entities_touched} entity pages from ${r.meetings_scanned} meetings`);
        }
      } else if (byMention || ner) {
        // v0.41.18.0 (T7): combined --by-mention + --ner walk shares one
        // gazetteer; saves an entire pass on big brains. When only one
        // flag is set, the other extractor skips silently.
        const { buildGazetteer: buildGz } = await import('../core/by-mention.ts');
        const sharedGazetteer = (byMention || ner) ? await buildGz(engine) : undefined;
        if (byMention) {
          const r = await extractMentionsFromDb(engine, dryRun, jsonMode, typeFilter, since, { sourceIdFilter });
          result.links_created += r.created;
          result.pages_processed += r.pages;
        }
        if (ner) {
          const { extractNerLinks } = await import('../core/extract-ner.ts');
          const r = await extractNerLinks(engine, {
            dryRun,
            sourceIdFilter,
            typeFilter,
            since,
            gazetteer: sharedGazetteer,
          });
          if (r.pack_unavailable && !jsonMode) {
            console.log('Note: no active schema pack with link_types[].inference.regex — NER pass produced 0 links.');
          }
          result.links_created += r.created;
          // pages already counted by by-mention if both ran; else count here.
          if (!byMention) result.pages_processed += r.pages;
        }
      } else {
        if (subcommand === 'links' || subcommand === 'all') {
          // C3 (D6): only stamp the combined links+timeline watermark when BOTH
          // ran ('all'); a links-only run must not mark timeline fresh.
          const r = await extractLinksFromDB(engine, dryRun, jsonMode, typeFilter, since, { includeFrontmatter, sourceIdFilter, stampWatermark: subcommand === 'all' });
          result.links_created = r.created;
          result.pages_processed = r.pages;
        }
        if (subcommand === 'timeline' || subcommand === 'all') {
          const r = await extractTimelineFromDB(engine, dryRun, jsonMode, typeFilter, since, { sourceIdFilter });
          result.timeline_entries_created = r.created;
          result.pages_processed = Math.max(result.pages_processed, r.pages);
        }
      }
    } else {
      result = await runExtractCore(engine, {
        mode: subcommand as 'links' | 'timeline' | 'all',
        dir: brainDir,
        dryRun,
        jsonMode,
        workers,
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
  // v0.41.15.0 (T7): in-process worker count. Default 1 — back-compat
  // for every caller that doesn't pass it explicitly. The sliding pool
  // accumulates per-worker local batches and flushes each via the
  // shared flush primitive; JS single-threaded event loop makes the
  // shared counter increments atomic.
  workers: number = 1,
): Promise<{ links_created: number; timeline_created: number; pages: number }> {
  // Build the full slug set for link resolution (fast: just readdir, no file reads)
  const allFiles = walkMarkdownFiles(brainDir);
  const allSlugs = new Set(allFiles.map(f => pathToSlug(f.relPath)));

  const doLinks = mode === 'links' || mode === 'all';
  const doTimeline = mode === 'timeline' || mode === 'all';

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.incremental', slugs.length);

  let linksCreated = 0;
  let timelineCreated = 0;
  let pagesProcessed = 0;

  // Issue #972: read the basename flag once per extract run.
  const globalBasename = await isGlobalBasenameEnabled(engine);

  const linkBatch: LinkBatchInput[] = [];
  const timelineBatch: TimelineBatchInput[] = [];

  async function flushLinks() {
    if (linkBatch.length === 0) return;
    // Snapshot BEFORE clear so a producer pushing during the 500ms retry
    // delay can't lose items on the second attempt. Error messages read
    // snapshot.length (batch.length is 0 by the time the catch fires).
    const snapshot = linkBatch.slice();
    linkBatch.length = 0;
    try {
      // v0.41.18.0: engine self-retries on Supavisor blip. auditSite routes
      // the audit JSONL emission. Per-snapshot try/catch preserves the
      // log-and-continue contract for exhausted retries.
      linksCreated += await engine.addLinksBatch(snapshot, { auditSite: 'extract.links_inc' }); // gbrain-allow-direct-insert: gbrain extract command — canonical link reconciliation from markdown body
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!jsonMode) console.error(`  link batch error (${snapshot.length} rows lost): ${msg}`);
    }
  }

  async function flushTimeline() {
    if (timelineBatch.length === 0) return;
    const snapshot = timelineBatch.slice();
    timelineBatch.length = 0;
    try {
      timelineCreated += await engine.addTimelineEntriesBatch(snapshot, { auditSite: 'extract.timeline_inc' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!jsonMode) console.error(`  timeline batch error (${snapshot.length} rows lost): ${msg}`);
    }
  }

  // v0.41.15.0 (T7): sliding-pool fan-out. The shared linkBatch /
  // timelineBatch arrays + flush functions still serve correctly because
  // every push + length check + length=0 reset is synchronous JS — no
  // await between the check and the reset means workers never see a
  // half-cleared batch. flushLinks/flushTimeline snapshot before await,
  // so the second worker's pushes during the await land cleanly in the
  // (now-empty) batch for the next flush.
  await runSlidingPool({
    items: slugs,
    workers,
    failureLabel: (slug) => slug,
    onItem: async (slug) => {
      const relPath = slug + '.md';
      const fullPath = join(brainDir, relPath);
      try {
        if (!existsSync(fullPath)) return; // deleted file — sync already handled removal
        const content = readFileSync(fullPath, 'utf-8');

        if (doLinks) {
          const links = await extractLinksFromFile(content, relPath, allSlugs, { globalBasename });
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
    },
  });

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
  // v0.41.15.0 (T7): in-process worker count. Default 1.
  workers: number = 1,
): Promise<{ created: number; pages: number }> {
  const files = walkMarkdownFiles(brainDir);
  const allSlugs = new Set(files.map(f => pathToSlug(f.relPath)));

  // Issue #972: read once before the walk so the per-file calls don't
  // re-query the DB. globalBasename = true emits one edge per basename
  // match for bare wikilinks like `[[struktura]]`.
  const globalBasename = await isGlobalBasenameEnabled(engine);

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
    const snapshot = batch.slice();
    batch.length = 0;
    try {
      created += await engine.addLinksBatch(snapshot, { auditSite: 'extract.links_fs' }); // gbrain-allow-direct-insert: gbrain extract command — canonical link reconciliation from markdown body
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: snapshot.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${snapshot.length} link rows lost): ${msg}`);
      }
    }
  }

  await runSlidingPool({
    items: files,
    workers,
    failureLabel: (f) => f.relPath,
    onItem: async (file) => {
      try {
        const content = readFileSync(file.path, 'utf-8');
        const links = await extractLinksFromFile(content, file.relPath, allSlugs, { globalBasename });
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
    },
  });
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
  // v0.41.15.0 (T7): in-process worker count. Default 1.
  workers: number = 1,
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
    const snapshot = batch.slice();
    batch.length = 0;
    try {
      created += await engine.addTimelineEntriesBatch(snapshot, { auditSite: 'extract.timeline_fs' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: snapshot.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${snapshot.length} timeline rows lost): ${msg}`);
      }
    }
  }

  await runSlidingPool({
    items: files,
    workers,
    failureLabel: (f) => f.relPath,
    onItem: async (file) => {
      try {
        const content = readFileSync(file.path, 'utf-8');
        const slug = pathToSlug(file.relPath);
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
    },
  });
  await flush();
  progress.finish();

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Timeline: ${label} ${created} entries from ${files.length} pages`);
  }
  return { created, pages: files.length };
}

// --- Sync integration hooks ---

export async function extractLinksForSlugs(
  engine: BrainEngine,
  repoPath: string,
  slugs: string[],
  opts?: { sourceId?: string },
): Promise<number> {
  const allFiles = walkMarkdownFiles(repoPath);
  const allSlugs = new Set(allFiles.map(f => pathToSlug(f.relPath)));
  // v0.18.0+ multi-source: post-sync extract reconciles same-source edges.
  // Markdown→markdown links within one repo always live in the caller's
  // sourceId. Cross-source extraction (rare) would need a per-repo source
  // manifest; not in this PR's scope.
  const linkOpts = opts?.sourceId
    ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId, originSourceId: opts.sourceId }
    : undefined;
  // Issue #972: same flag as the standalone extract path.
  const globalBasename = await isGlobalBasenameEnabled(engine);
  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const link of await extractLinksFromFile(content, slug + '.md', allSlugs, { globalBasename })) {
        try { await engine.addLink(link.from_slug, link.to_slug, link.context, link.link_type, link.link_source, undefined, undefined, linkOpts); created++; } catch { /* skip */ } // gbrain-allow-direct-insert: gbrain extract single-row fallback when batch path declines a row
      }
    } catch { /* skip */ }
  }
  return created;
}

export async function extractTimelineForSlugs(
  engine: BrainEngine,
  repoPath: string,
  slugs: string[],
  opts?: { sourceId?: string },
): Promise<number> {
  // v0.18.0+ multi-source: source-qualify so timeline rows don't fan out
  // across every source containing the slug (the addTimelineEntry's
  // INSERT...SELECT-from-pages fan-out was Data R1's HIGH 2).
  const entryOpts = opts?.sourceId ? { sourceId: opts.sourceId } : undefined;
  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const entry of extractTimelineFromContent(content, slug)) {
        try { await engine.addTimelineEntry(entry.slug, { date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail }, entryOpts); created++; } catch { /* skip */ } // gbrain-allow-direct-insert: gbrain extract single-row fallback for timeline entries
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
  opts?: { includeFrontmatter?: boolean; sourceIdFilter?: string; stampWatermark?: boolean },
): Promise<{ created: number; pages: number; unresolved: UnresolvedFrontmatterRef[] }> {
  const includeFrontmatter = opts?.includeFrontmatter ?? false;
  const sourceIdFilter = opts?.sourceIdFilter;
  // C3 (D6): the links_extracted_at watermark covers links AND timeline, so a
  // links-ONLY run must NOT stamp it (that would hide timeline staleness for
  // `gbrain extract links --source db`). Only stamp when the caller ran BOTH
  // (subcommand 'all'). Caller passes stampWatermark accordingly.
  const stampWatermark = opts?.stampWatermark ?? false;
  // Batch resolver: pg_trgm + exact only, NO search fallback. Dodges the
  // N-thousand API call trap on 46K-page brains. Resolver has a per-run
  // cache so duplicate names (same person appearing on many pages) resolve
  // once, not once per mention. Used for BOTH the frontmatter pass (gated
  // by `includeFrontmatter` via `opts.skipFrontmatter` on extractPageLinks)
  // AND the issue-#972 global-basename pass (gated by `globalBasename`).
  // Replaces the pre-issue-#972 `nullResolver` ternary — that synthetic
  // resolver lacked `resolveBasenameMatches`, so we always pass the real
  // one and let extractPageLinks's opts gate which pass actually runs.
  // Issue #972 (codex [P1]): scope basename resolution to the source being
  // extracted so bare wikilinks don't resolve across unrelated sources.
  const resolver = makeResolver(engine, { mode: 'batch', sourceId: sourceIdFilter });
  const unresolved: UnresolvedFrontmatterRef[] = [];
  // Issue #972: opt-in global-basename wikilink resolution. Read once
  // per extract run; threaded into each extractPageLinks call.
  const globalBasename = await isGlobalBasenameEnabled(engine);
  // v0.32.8: listAllPageRefs enumerates (slug, source_id) so we can thread
  // sourceId to getPage AND build a cross-source resolution map for link
  // disambiguation. Pre-fix used getAllSlugs() which collapsed
  // same-slug-different-source pages into one entry.
  //
  // v0.37.7.0 #1204: when --source-id <id> is passed, filter the walk
  // to just that source so federated brain users can scope extraction
  // explicitly. The resolution map still sees all sources so
  // cross-source wikilinks (qualified like `[[other-src:slug]]`) can
  // resolve — the filter is on WHICH pages we extract FROM, not what
  // we can resolve TO.
  const allRefs = sourceIdFilter
    ? (await engine.listAllPageRefs()).filter(r => r.source_id === sourceIdFilter)
    : await engine.listAllPageRefs();
  const fullRefsForResolver = sourceIdFilter
    ? await engine.listAllPageRefs()
    : allRefs;
  // For backward-compat checks (`allSlugs.has(...)` calls below), we still
  // need a flat slug set. ALSO a per-slug → [sources] map for F10 resolution.
  //
  // v0.37.7.0: the resolver maps are built from `fullRefsForResolver`
  // (not `allRefs`) so cross-source wikilinks resolve correctly even
  // when --source-id scopes the extract walk. Without this, a scoped
  // extract would fail to resolve qualified links to pages outside the
  // scoped source.
  const allSlugs = new Set<string>();
  const slugToSources = new Map<string, string[]>();
  for (const ref of fullRefsForResolver) {
    allSlugs.add(ref.slug);
    const list = slugToSources.get(ref.slug) ?? [];
    list.push(ref.source_id);
    slugToSources.set(ref.slug, list);
  }
  let processed = 0, created = 0;
  // v0.42.7 (#1696): pages whose links we extracted this run — stamped after
  // the loop so a manual `gbrain extract links|all --source db` clears the
  // links_extraction_lag doctor signal. Non-dry-run only.
  const processedRefs: Array<{ slug: string; source_id: string }> = [];

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.links_db', allRefs.length);

  // Dedup in dry-run only — DB enforces uniqueness via ON CONFLICT in batch writes.
  const dryRunSeen = dryRun ? new Set<string>() : null;

  const batch: LinkBatchInput[] = [];
  async function flush() {
    if (batch.length === 0) return;
    const snapshot = batch.slice();
    batch.length = 0;
    try {
      created += await engine.addLinksBatch(snapshot, { auditSite: 'extract.links_db' }); // gbrain-allow-direct-insert: gbrain extract command — canonical link reconciliation from markdown body
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: snapshot.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${snapshot.length} link rows lost): ${msg}`);
      }
    }
  }

  for (const { slug, source_id } of allRefs) {
    const page = await engine.getPage(slug, { sourceId: source_id });
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
    // Issue #972: globalBasename routes bare `[[name]]` wikilinks through
    // basename lookup; off by default for back-compat.
    const extracted = await extractPageLinks(
      slug, fullContent, page.frontmatter, page.type, resolver,
      { skipFrontmatter: !includeFrontmatter, globalBasename },
    );
    unresolved.push(...extracted.unresolved);

    for (const c of extracted.candidates) {
      // v0.32.8 F10 cross-source link resolution, extracted to the shared pure
      // helper in v0.42.7 (#1696) so extract --stale reuses the exact same
      // endpoint-validation + from/to source-id picking (null = skip: missing
      // endpoint OR target only in a non-origin/non-default source).
      const resolved = resolveCandidateSources(c, slug, source_id, allSlugs, slugToSources);
      if (!resolved) continue;
      const { fromSlug, fromSourceId, toSourceId } = resolved;

      if (dryRunSeen) {
        const key = `${fromSourceId}::${fromSlug}::${toSourceId}::${c.targetSlug}::${c.linkType}::${c.linkSource ?? 'markdown'}`;
        if (dryRunSeen.has(key)) continue;
        dryRunSeen.add(key);
        if (jsonMode) {
          process.stdout.write(JSON.stringify({
            action: 'add_link', from: fromSlug, from_source_id: fromSourceId,
            to: c.targetSlug, to_source_id: toSourceId,
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
          // v0.32.8 F4: thread source ids so the batch JOIN doesn't fan out
          // across sources. Default source_id='default' for back-compat with
          // pre-v0.32.8 callers (the engine still accepts undefined).
          from_source_id: fromSourceId,
          to_source_id: toSourceId,
          origin_source_id: source_id,
        });
        if (batch.length >= BATCH_SIZE) await flush();
      }
    }
    processed++;
    if (!dryRun) processedRefs.push({ slug, source_id });
    progress.tick(1);
  }
  await flush();
  // v0.42.7 (#1696): stamp the extraction watermark for every page we
  // processed (incl. zero-link pages — they WERE extracted). Chunked so the
  // unnest UPDATE stays bounded on big brains. Best-effort (stampExtracted
  // swallows): a stamp miss just leaves the page for extract --stale.
  // C3 (D6): ONLY when both links + timeline ran (stampWatermark) — a
  // links-only run leaves the combined watermark untouched.
  if (!dryRun && stampWatermark) {
    for (let i = 0; i < processedRefs.length; i += BATCH_SIZE) {
      await stampExtracted(engine, processedRefs.slice(i, i + BATCH_SIZE));
    }
  }
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
  opts?: { sourceIdFilter?: string },
): Promise<{ created: number; pages: number }> {
  // v0.32.8: listAllPageRefs enumerates (slug, source_id) pairs so we can
  // thread sourceId to getPage and addTimelineEntriesBatch. Pre-fix used
  // getAllSlugs() which collapsed same-slug-different-source pages.
  //
  // v0.37.7.0 #1204: when sourceIdFilter is set, scope the walk to one
  // source so federated brain users can extract per-source.
  const sourceIdFilter = opts?.sourceIdFilter;
  const allRefs = sourceIdFilter
    ? (await engine.listAllPageRefs()).filter(r => r.source_id === sourceIdFilter)
    : await engine.listAllPageRefs();
  let processed = 0, created = 0;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.timeline_db', allRefs.length);

  // Dedup in dry-run only — DB enforces uniqueness via ON CONFLICT in batch writes.
  const dryRunSeen = dryRun ? new Set<string>() : null;

  const batch: TimelineBatchInput[] = [];
  async function flush() {
    if (batch.length === 0) return;
    const snapshot = batch.slice();
    batch.length = 0;
    try {
      created += await engine.addTimelineEntriesBatch(snapshot, { auditSite: 'extract.timeline_db' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: snapshot.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${snapshot.length} timeline rows lost): ${msg}`);
      }
    }
  }

  for (const { slug, source_id } of allRefs) {
    const page = await engine.getPage(slug, { sourceId: source_id });
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
        const key = `${source_id}::${slug}::${entry.date}::${entry.summary}`;
        if (dryRunSeen.has(key)) continue;
        dryRunSeen.add(key);
        if (jsonMode) {
          process.stdout.write(JSON.stringify({
            action: 'add_timeline', slug, source_id, date: entry.date,
            summary: entry.summary, ...(entry.detail ? { detail: entry.detail } : {}),
          }) + '\n');
        } else {
          console.log(`  ${slug}: ${entry.date} — ${entry.summary}`);
        }
        created++;
      } else {
        // v0.32.8 F4: thread source_id so the JOIN matches the right page
        // when two sources share the same slug.
        batch.push({ slug, date: entry.date, summary: entry.summary, detail: entry.detail || '', source_id });
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

/**
 * v0.42.7 (#1696) — `gbrain extract --stale`: incremental link + timeline
 * extraction over pages whose `links_extracted_at` watermark is stale (NULL,
 * older than LINK_EXTRACTOR_VERSION_TS, or older than the page's updated_at).
 * DB-source (works on checkout-less Postgres/Supabase brains). Mirrors
 * embedAllStale's count → keyset-list → flush → stamp shape.
 *
 * Crash-safety + CDX-4: per keyset batch we extract ALL links+timeline, flush
 * them (NON-swallowing — a flush throw propagates and aborts the sweep), THEN
 * stamp the batch's pages. A page is never stamped fresh with lost edges; a
 * crash mid-sweep leaves the unflushed/unstamped pages stale and they
 * re-extract next run (addLinksBatch ON CONFLICT DO NOTHING + timeline dedup
 * make re-extraction idempotent). EVERY processed page is stamped, including
 * zero-link pages — they WERE processed.
 */
async function extractStaleFromDB(
  engine: BrainEngine,
  opts: {
    dryRun: boolean;
    jsonMode: boolean;
    includeFrontmatter: boolean;
    sourceIdFilter?: string;
    catchUp: boolean;
  },
): Promise<{ linksCreated: number; timelineCreated: number; pagesProcessed: number; staleRemaining: number }> {
  const { dryRun, jsonMode, includeFrontmatter, sourceIdFilter, catchUp } = opts;
  const versionTs = LINK_EXTRACTOR_VERSION_TS;

  // Pre-flight count — cheap indexed COUNT. dry-run reports and returns.
  const totalStale = await engine.countStalePagesForExtraction({ sourceId: sourceIdFilter, versionTs });
  if (dryRun) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ action: 'extract_stale_dry_run', stale_pages: totalStale }) + '\n');
    } else {
      console.log(`(dry run) ${totalStale} page(s) need link/timeline extraction. Run without --dry-run to extract.`);
    }
    return { linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: totalStale };
  }
  if (totalStale === 0) {
    if (!jsonMode) console.log('No stale pages — extraction is up to date.');
    return { linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: 0 };
  }

  // Resolver + cross-source resolution map built ONCE before the loop (the
  // extractLinksFromDB:1069 precedent — avoids O(pages) rebuild per batch).
  // Batch mode = pg_trgm + exact only, NO per-name search fallback. The
  // resolution map sees ALL sources so qualified cross-source wikilinks resolve
  // even when --source-id scopes the stale SCAN.
  const resolver = makeResolver(engine, { mode: 'batch' });
  const nullResolver = { resolve: async () => null as string | null };
  const activeResolver = includeFrontmatter ? resolver : nullResolver;
  const allRefs = await engine.listAllPageRefs();
  const allSlugs = new Set<string>();
  const slugToSources = new Map<string, string[]>();
  for (const ref of allRefs) {
    allSlugs.add(ref.slug);
    const list = slugToSources.get(ref.slug) ?? [];
    list.push(ref.source_id);
    slugToSources.set(ref.slug, list);
  }

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.stale', totalStale);

  const startMs = Date.now();
  let afterPageId = 0;
  let linksCreated = 0, timelineCreated = 0, pagesProcessed = 0;
  let budgetHit = false;

  for (;;) {
    const rows = await engine.listStalePagesForExtraction({
      batchSize: STALE_BATCH_SIZE, afterPageId, sourceId: sourceIdFilter, versionTs,
    });
    if (rows.length === 0) break;

    const linkRows: LinkBatchInput[] = [];
    const timelineRows: TimelineBatchInput[] = [];
    const processedRefs: Array<{ slug: string; source_id: string; extractedAt: string }> = [];

    for (const page of rows) {
      const fullContent = page.compiled_truth + '\n' + page.timeline;
      const extracted = await extractPageLinks(
        page.slug, fullContent, page.frontmatter, page.type, activeResolver,
      );
      for (const c of extracted.candidates) {
        const r = resolveCandidateSources(c, page.slug, page.source_id, allSlugs, slugToSources);
        if (!r) continue;
        linkRows.push({
          from_slug: r.fromSlug, to_slug: c.targetSlug, link_type: c.linkType,
          context: c.context, link_source: c.linkSource, origin_slug: c.originSlug,
          origin_field: c.originField, from_source_id: r.fromSourceId,
          to_source_id: r.toSourceId, origin_source_id: page.source_id,
        });
      }
      for (const entry of parseTimelineEntries(fullContent)) {
        timelineRows.push({ slug: page.slug, date: entry.date, summary: entry.summary, detail: entry.detail || '', source_id: page.source_id });
      }
      // EVERY processed page is stamped (incl. zero-link pages). D4 race fix:
      // stamp with the row's READ updated_at, NOT now() — a concurrent edit
      // landing between this SELECT and the stamp advances updated_at past the
      // stamped value, so the page stays stale and re-extracts next run instead
      // of being marked fresh-with-stale-content.
      //
      // #1768: stamp the FULL-µs `updated_at_iso` (projected via to_char), NOT
      // `page.updated_at.toISOString()` — the JS Date is ms-truncated, so the
      // µs-precision DB updated_at stayed strictly greater and the page never
      // cleared on Postgres. Stamping the exact value makes them equal.
      processedRefs.push({ slug: page.slug, source_id: page.source_id, extractedAt: page.updated_at_iso });
    }

    // Flush NON-swallowing (CDX-4): a throw here propagates out of the sweep so
    // the batch's pages stay unstamped and re-extract next run. addLinksBatch is
    // ON CONFLICT DO NOTHING + timeline dedups, so partial-chunk writes are
    // idempotent on re-extraction.
    for (let i = 0; i < linkRows.length; i += BATCH_SIZE) {
      linksCreated += await engine.addLinksBatch(linkRows.slice(i, i + BATCH_SIZE), { auditSite: 'extract.stale' }); // gbrain-allow-direct-insert: gbrain extract --stale — canonical link reconciliation from markdown body
    }
    for (let i = 0; i < timelineRows.length; i += BATCH_SIZE) {
      timelineCreated += await engine.addTimelineEntriesBatch(timelineRows.slice(i, i + BATCH_SIZE), { auditSite: 'extract.stale' });
    }
    // Stamp LAST, directly (not the swallowing stampExtracted) so a stamp
    // failure surfaces instead of looping forever.
    await engine.markPagesExtractedBatch(processedRefs, new Date().toISOString());

    pagesProcessed += rows.length;
    progress.tick(rows.length);
    afterPageId = rows[rows.length - 1]!.id;

    if (!catchUp && Date.now() - startMs > STALE_TIME_BUDGET_MS) { budgetHit = true; break; }
  }

  progress.finish();
  const staleRemaining = await engine.countStalePagesForExtraction({ sourceId: sourceIdFilter, versionTs });

  if (!jsonMode) {
    console.log(`Extract --stale: ${linksCreated} link(s) + ${timelineCreated} timeline entr(ies) from ${pagesProcessed} page(s).`);
    if (budgetHit && staleRemaining > 0) {
      console.log(`Time budget reached — ${staleRemaining} page(s) still stale. Re-run 'gbrain extract --stale' (or pass --catch-up) to continue.`);
    }
  } else {
    process.stdout.write(JSON.stringify({
      action: 'extract_stale_done', links_created: linksCreated, timeline_created: timelineCreated,
      pages_processed: pagesProcessed, stale_remaining: staleRemaining, budget_hit: budgetHit,
    }) + '\n');
  }
  return { linksCreated, timelineCreated, pagesProcessed, staleRemaining };
}

/**
 * v0.41.18.0 Part B (migration #1 of #1409) — auto-link body-text entity
 * mentions to known entity pages.
 *
 * Walks every page (respecting --source-id / --type / --since filters),
 * scans `compiled_truth || '\n\n' || COALESCE(timeline, '')` per D3
 * against the gazetteer built via `buildGazetteer`, and writes one link
 * per (from_page, to_page) pair with `link_source='mentions'`. The
 * mention link_source is filtered OUT of backlink-count per D12 so
 * search ranking semantics are preserved.
 *
 * Source isolation: mentions cross-source pages are deliberately
 * suppressed by `findMentionedEntities`'s cross-source guard. Page in
 * source A mentions entity in source B → no link created. v1
 * conservative posture; relaxable in a future wave.
 */
async function extractMentionsFromDb(
  engine: BrainEngine,
  dryRun: boolean,
  jsonMode: boolean,
  typeFilter: PageType | undefined,
  since: string | undefined,
  opts?: { sourceIdFilter?: string },
): Promise<{ created: number; pages: number }> {
  const sourceIdFilter = opts?.sourceIdFilter;

  // Build gazetteer once per run. Skip everything if there are no
  // linkable entities — vacuous truth, no mentions to find.
  const gazetteer = await buildGazetteer(engine);
  if (gazetteer.size === 0) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ event: 'no_gazetteer', message: 'no linkable entity pages found; nothing to scan' }) + '\n');
    } else {
      console.log('No linkable entity pages found in this brain (need pages with type IN person/company/organization/entity).');
    }
    return { created: 0, pages: 0 };
  }

  // v0.41.19.0 (T5): gazetteer hash is part of the checkpoint
  // fingerprint so adding new entity pages mid-pause invalidates the
  // checkpoint cleanly. Without it, resumed pages would skip new
  // entities silently (codex flag).
  const gazetteerHash = createHash('sha256')
    .update([...gazetteer.keys()].sort().join('|'))
    .digest('hex')
    .slice(0, 8);

  const allRefs = sourceIdFilter
    ? (await engine.listAllPageRefs()).filter(r => r.source_id === sourceIdFilter)
    : await engine.listAllPageRefs();

  // v0.41.19.0 (T5): load checkpoint and skip already-completed
  // (source_id, slug) pairs. Dry-run does NOT load OR persist the
  // checkpoint — dry-run is an inspection mode and shouldn't pollute
  // resume state for the next non-dry-run.
  const ckptKey = {
    op: 'extract-by-mention',
    fingerprint: mentionsFingerprint({
      source: sourceIdFilter,
      type: typeFilter,
      since,
      gazetteerHash,
    }),
  };
  const completed = dryRun
    ? new Set<string>()
    : new Set(await loadOpCheckpoint(engine, ckptKey));
  const remaining = completed.size > 0
    ? allRefs.filter(r => !completed.has(`${r.source_id}::${r.slug}`))
    : allRefs;

  if (completed.size > 0 && !jsonMode) {
    console.log(`[by-mention] resuming: ${completed.size}/${allRefs.length} pages already scanned, ${remaining.length} remaining`);
  }

  let processed = 0;
  let created = 0;
  const batch: LinkBatchInput[] = [];

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.by_mention.scan', remaining.length);

  async function flushBatch() {
    if (batch.length === 0) return;
    try {
      created += await engine.addLinksBatch(batch, { auditSite: 'extract.by_mention' }); // gbrain-allow-direct-insert: gbrain extract --by-mention — canonical auto-link write from body-text mention scan
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

  // v0.41.19.0 (T5 — codex fix #1): flush links FIRST, commit pending
  // page keys to checkpoint SECOND, persist THIRD. A crash between
  // batch.push() and flushBatch() leaves pendingForFlush uncommitted —
  // resume re-scans those pages instead of silently losing their links.
  //
  // Persist cadence: every 1000 items OR every 30s, whichever first
  // (~322 persists on a 322K-page brain, ~24s total overhead). Crash
  // window is at most 1000 pages (<0.3% loss on the driver brain).
  const PERSIST_EVERY_N = 1000;
  const PERSIST_EVERY_MS = 30_000;
  const pendingForFlush: string[] = [];
  let sinceLastPersistMs = Date.now();
  let unpersistedCount = 0;

  async function flushAndCheckpoint(force = false): Promise<void> {
    await flushBatch();
    for (const key of pendingForFlush) completed.add(key);
    pendingForFlush.length = 0;
    if (dryRun) return;
    const now = Date.now();
    if (force || unpersistedCount >= PERSIST_EVERY_N || (now - sinceLastPersistMs) >= PERSIST_EVERY_MS) {
      await recordCompleted(engine, ckptKey, [...completed]);
      unpersistedCount = 0;
      sinceLastPersistMs = now;
    }
  }

  const sinceMs = since ? new Date(since).getTime() : null;

  for (const { slug, source_id } of remaining) {
    const page = await engine.getPage(slug, { sourceId: source_id });
    // v0.41.19.0 (T5 — codex fix #4): even when we skip a page (filter
    // miss, missing row, empty body, no mentions), MARK IT COMPLETED so
    // resume doesn't re-fetch it. The decision NOT to create links is
    // itself a completed decision.
    const key = `${source_id}::${slug}`;
    if (!page || (typeFilter && page.type !== typeFilter)) {
      pendingForFlush.push(key);
      unpersistedCount++;
      continue;
    }
    if (sinceMs !== null) {
      const updatedMs = new Date(page.updated_at).getTime();
      if (Number.isFinite(updatedMs) && updatedMs <= sinceMs) {
        pendingForFlush.push(key);
        unpersistedCount++;
        continue;
      }
    }
    processed++;
    progress.tick();

    // D3: scan both columns joined with a paragraph separator so an
    // end-of-compiled token doesn't accidentally merge with a
    // start-of-timeline token into a false phrase match.
    const body = page.compiled_truth + '\n\n' + (page.timeline ?? '');
    if (!body.trim()) {
      pendingForFlush.push(key);
      unpersistedCount++;
      continue;
    }

    const mentions = findMentionedEntities(body, gazetteer, {
      fromSlug: slug,
      fromSourceId: source_id,
    });

    if (mentions.length === 0) {
      pendingForFlush.push(key);
      unpersistedCount++;
      continue;
    }

    for (const m of mentions) {
      if (dryRun) {
        if (jsonMode) {
          process.stdout.write(JSON.stringify({
            action: 'add_link', from: slug, from_source_id: source_id,
            to: m.slug, to_source_id: m.source_id,
            type: 'mentions', context: m.name, link_source: 'mentions',
          }) + '\n');
        } else {
          console.log(`  ${slug} → ${m.slug} (mentions: "${m.name}")`);
        }
        created++;
      } else {
        batch.push({
          from_slug: slug,
          to_slug: m.slug,
          link_type: 'mentions',
          link_source: 'mentions',
          context: m.name,
          from_source_id: source_id,
          to_source_id: m.source_id,
        });
        if (batch.length >= BATCH_SIZE) {
          // The page that produced these batch entries stays UN-committed
          // until flushBatch succeeds. The push below happens AFTER the
          // flushAndCheckpoint call so a crash inside flushBatch leaves
          // the page un-checkpointed and resume re-scans it.
          await flushAndCheckpoint();
        }
      }
    }
    // Page completed (whether dry-run or non-dry-run). Stage for the
    // next flushAndCheckpoint().
    pendingForFlush.push(key);
    unpersistedCount++;
    // Time-based cadence floor.
    if (!dryRun && (Date.now() - sinceLastPersistMs) >= PERSIST_EVERY_MS) {
      await flushAndCheckpoint();
    }
  }

  if (!dryRun) {
    await flushAndCheckpoint(true); // final flush + force-persist
  }
  progress.finish();

  if (!dryRun) await clearOpCheckpoint(engine, ckptKey); // clean exit

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Mentions: ${label} ${created} links from ${processed} pages against gazetteer of ${gazetteer.size} first-token buckets`);
  }
  return { created, pages: processed };
}
