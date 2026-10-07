/**
 * Multi-source drift detection (v0.31.8 — D8 + D17 + OV12 + OV13).
 *
 * Pre-v0.30.3 putPage misrouted multi-source writes from intended source X
 * to (default, slug). The fixwave fixed forward-going writes but explicitly
 * deferred backfilling the misrouted rows. This module surfaces evidence of
 * misroute to operators via `gbrain doctor`.
 *
 * Heuristic (codex OV12 — softened from "is misrouted" to "appears misrouted"):
 * a non-default source X is configured with `local_path`, AND the filesystem
 * at `local_path` contains a markdown file whose slug exists at (default,
 * slug) in the DB but is missing from (X, slug). Two possible causes:
 *   1. Pre-v0.30.3 putPage misroute (the case this check was designed for).
 *   2. Source X never completed initial sync, and the default page is
 *      unrelated content that happens to share the slug.
 * The doctor warning surfaces evidence; the operator decides which cause
 * applies and runs `gbrain sync --source X --full` or `gbrain delete <slug>`
 * accordingly.
 *
 * Implementation notes:
 *  - FS walk handles `.md` AND `.mdx` (codex OV13: matches `src/core/sync.ts`
 *    which treats both as markdown).
 *  - Batched single-query DB lookup (D17): collect all candidate slugs from
 *    the FS walk into one array, then run ONE SELECT against pages with a
 *    VALUES clause. NOT a per-file loop (which would be 20K round trips on
 *    a 10K-file source).
 *  - Time + size bounds: cap the walk at 10K files OR 5s. Bail with a "check
 *    skipped, walk too large" status instead of letting doctor hang.
 *  - Wrapper try/catch around the walk per OV13: ENOENT/EACCES on local_path
 *    yields zero files, NOT a thrown crash that takes down the whole doctor
 *    run; the source is reported in `unreadable_sources` (#5432) so doctor
 *    says "not verified" instead of "no drift".
 *  - Slugs are rebuilt the way sync minted them, which depends on the
 *    source's slug-root pin (#4342, src/core/sync-anchor.ts). Unpinned and
 *    `'source-root'` sources slug the `local_path`-relative path. A
 *    `'git-root'` source slugs the path relative to its git work tree, so
 *    every walked path gets `local_path`'s own location in the work tree in
 *    front of it; that location is empty when `local_path` is the toplevel,
 *    which is what managed sync pins for a source at its repo root (#5862).
 *    When git cannot place `local_path` in a work tree the source is not
 *    compared at all (a wrong slug shape false-positives, with delete advice
 *    naming an unrelated page) and is reported in `git_root_skipped`.
 */

import { readdirSync, lstatSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { BrainEngine } from './engine.ts';
import { pathToSlug } from './sync.ts';
import { readSlugRootMode } from './sync-anchor.ts';
import { git } from './sync-git.ts';

export interface SourceWithPath {
  id: string;
  local_path: string;
}

export interface MisroutedSample {
  slug: string;
  intended_source: string;
  local_path: string;
}

export interface MisroutedResult {
  /** True when the FS walk hit the limit/timeout and the result is partial. */
  walk_truncated: boolean;
  /** Per-source breakdown: slugs that appear at (default, slug) but NOT at (X, slug). */
  count: number;
  sample: MisroutedSample[];
  /**
   * Readable sources pinned to slug_root_mode 'git-root' that git cannot
   * place inside a work tree (not a checkout, git missing or refusing the
   * directory). The prefix their slugs carry is unknown, so they were not
   * compared rather than compared against the wrong slug shape.
   */
  git_root_skipped: string[];
  /**
   * #5432: sources whose walk could not read their root (`root_unreadable`)
   * or some directory below it (`subdirs_unreadable`). Their result is not
   * verified: an unreadable root is not an empty source.
   */
  unreadable_sources: Array<{ source_id: string; reason: 'root_unreadable' | 'subdirs_unreadable'; dirs: number }>;
  /** Walk bounds actually used (opts, else GBRAIN_DRIFT_LIMIT / GBRAIN_DRIFT_TIMEOUT_MS, else defaults). */
  limit: number;
  timeout_ms: number;
}

const DEFAULT_FILE_LIMIT = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function positiveIntEnv(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
const SAMPLE_LIMIT = 5;

/**
 * Walk a directory tree for `.md` + `.mdx` files. Skips dotfiles (`.git`),
 * `_*.md` files (the existing extract.ts convention), and silently swallows
 * read errors on individual entries. Returns relative paths from `root`.
 *
 * Bounded by `limit` (max files) and `deadlineMs` (epoch ms). Returns early
 * with `truncated=true` if either bound is hit. An unreadable root sets
 * `rootUnreadable`; each unreadable directory below it counts in
 * `unreadableDirs`, so callers can tell "nothing to check" from "could not read".
 */
function walkMarkdownAndMdxFiles(
  root: string,
  limit: number,
  deadlineMs: number,
): { files: { relPath: string }[]; truncated: boolean; rootUnreadable: boolean; unreadableDirs: number } {
  const files: { relPath: string }[] = [];
  let truncated = false;
  let unreadableDirs = 0;
  function walk(d: string): void {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      // Unreadable directory; skip without crashing the whole walk.
      unreadableDirs++;
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.startsWith('.')) continue;
      // Skip heavy non-content dirs so the walk doesn't exhaust the time
      // budget on dependency/build trees (node_modules can be 50k+ files
      // with zero .md). These are never gbrain page sources.
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build' ||
          entry === '.next' || entry === 'vendor' || entry === 'target') continue;
      const full = join(d, entry);
      let isDir = false;
      try {
        isDir = lstatSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        // Time check on directory descent too, so a deep dependency-free
        // tree still respects the deadline even before any .md is found.
        if (Date.now() >= deadlineMs) { truncated = true; return; }
        walk(full);
        continue;
      }
      const isMd = entry.endsWith('.md') || entry.endsWith('.mdx');
      if (!isMd) continue;
      if (entry.startsWith('_')) continue; // matches extract.ts convention
      files.push({ relPath: relative(root, full) });
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      // Time check is cheap; do it on every push so a slow filesystem can't
      // run unbounded.
      if (Date.now() >= deadlineMs) {
        truncated = true;
        return;
      }
    }
  }
  // Wrap the top-level walk in try/catch so a missing/unreadable root
  // doesn't bubble up to doctor (codex OV13 — pre-fix the readdirSync at
  // the root would throw and crash the whole doctor run).
  try {
    statSync(root); // probe readable; throws ENOENT/EACCES if not
    readdirSync(root);
  } catch {
    return { files, truncated: false, rootUnreadable: true, unreadableDirs: 0 };
  }
  walk(root);
  return { files, truncated, rootUnreadable: false, unreadableDirs };
}

/**
 * For a list of slugs, query DB for existence at (default, slug) AND at
 * (sourceId, slug) in ONE batched query. Returns a Map<slug, Set<source_id>>.
 *
 * Engine-agnostic: uses executeRaw with a VALUES clause. PGLite + Postgres
 * both support the shape.
 */
async function batchProbeExistence(
  engine: BrainEngine,
  slugs: string[],
  sourceId: string,
): Promise<Map<string, Set<string>>> {
  if (slugs.length === 0) return new Map();
  // Build a positional VALUES clause: ($1::text), ($2), ($3), ...
  const valuePlaceholders = slugs.map((_, i) => `($${i + 1}::text)`).join(', ');
  const sourceParamIdx = slugs.length + 1;
  const sql = `
    WITH candidates(slug) AS (VALUES ${valuePlaceholders})
    SELECT c.slug, p.source_id
    FROM candidates c
    LEFT JOIN pages p
      ON p.slug = c.slug AND p.deleted_at IS NULL
         AND p.source_id IN ('default', $${sourceParamIdx}::text)
    ORDER BY c.slug, p.source_id
  `;
  const rows = await engine.executeRaw<{ slug: string; source_id: string | null }>(
    sql,
    [...slugs, sourceId],
  );
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.slug)) map.set(r.slug, new Set());
    if (r.source_id != null) map.get(r.slug)!.add(r.source_id);
  }
  return map;
}

/**
 * The path prefix sync put in front of a walked file's `local_path`-relative
 * path before slugging it: '' unless the source is pinned to 'git-root', and
 * then `local_path`'s location in its git work tree as git reports it
 * (`rev-parse --show-prefix`: '' at the toplevel, 'sub/dir/' below it, with
 * symlinks resolved, the scope managed sync derives). null when git cannot
 * place `local_path` in a work tree.
 */
async function syncedPathPrefix(engine: BrainEngine, src: SourceWithPath): Promise<string | null> {
  if (await readSlugRootMode(engine, src.id) !== 'git-root') return '';
  try {
    return git(src.local_path, ['rev-parse', '--show-prefix'], [], 30_000, { silenceStderr: true });
  } catch {
    return null;
  }
}

/**
 * Find pages that appear misrouted from intended source X to source 'default'.
 * For each non-default source with a configured local_path, walk the
 * filesystem and cross-check against the DB.
 *
 * @returns aggregated MisroutedResult across all checked sources. The sample
 *          array is bounded at 5 entries so the doctor message stays scannable.
 */
export async function findMisroutedPages(
  engine: BrainEngine,
  sources: SourceWithPath[],
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<MisroutedResult> {
  const limit = opts.limit ?? positiveIntEnv('GBRAIN_DRIFT_LIMIT') ?? DEFAULT_FILE_LIMIT;
  const timeoutMs = opts.timeoutMs ?? positiveIntEnv('GBRAIN_DRIFT_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;

  let totalCount = 0;
  let walkTruncated = false;
  const sample: MisroutedSample[] = [];
  const gitRootSkipped: string[] = [];
  const unreadable: MisroutedResult['unreadable_sources'] = [];

  for (const src of sources) {
    if (src.id === 'default') continue;
    if (!src.local_path) continue;
    if (Date.now() >= deadlineMs) {
      walkTruncated = true;
      break;
    }
    const { files, truncated, rootUnreadable, unreadableDirs } = walkMarkdownAndMdxFiles(src.local_path, limit, deadlineMs);
    if (truncated) walkTruncated = true;
    if (rootUnreadable) unreadable.push({ source_id: src.id, reason: 'root_unreadable', dirs: 1 });
    else if (unreadableDirs > 0) unreadable.push({ source_id: src.id, reason: 'subdirs_unreadable', dirs: unreadableDirs });
    if (files.length === 0) continue;

    // Asked only once the walk found files, so a missing local_path stays
    // root_unreadable instead of reading as a git-root skip.
    const prefix = await syncedPathPrefix(engine, src);
    if (prefix === null) {
      gitRootSkipped.push(src.id);
      continue;
    }

    // Convert FS paths to canonical slugs (lowercased, extension stripped).
    const slugs = Array.from(new Set(files.map(f => pathToSlug(prefix + f.relPath))));
    const existenceMap = await batchProbeExistence(engine, slugs, src.id);

    for (const slug of slugs) {
      const present = existenceMap.get(slug);
      if (!present) continue; // missing both — uningested, not misroute
      const hasDefault = present.has('default');
      const hasSource = present.has(src.id);
      // The misroute heuristic: present at default, missing from intended source.
      if (hasDefault && !hasSource) {
        totalCount++;
        if (sample.length < SAMPLE_LIMIT) {
          sample.push({ slug, intended_source: src.id, local_path: src.local_path });
        }
      }
    }
  }

  return {
    walk_truncated: walkTruncated, count: totalCount, sample, git_root_skipped: gitRootSkipped,
    unreadable_sources: unreadable, limit, timeout_ms: timeoutMs,
  };
}
