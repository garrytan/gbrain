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
 *    run.
 */

import { readdirSync, lstatSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { BrainEngine } from './engine.ts';
import { pathToSlug } from './sync.ts';

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
}

const DEFAULT_FILE_LIMIT = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const SAMPLE_LIMIT = 5;

/**
 * Walk a directory tree for `.md` + `.mdx` files. Skips dotfiles (`.git`),
 * `_*.md` files (the existing extract.ts convention), and silently swallows
 * read errors on individual entries. Returns relative paths from `root`.
 *
 * Bounded by `limit` (max files) and `deadlineMs` (epoch ms). Returns early
 * with `truncated=true` if either bound is hit. The root-not-readable case
 * surfaces as `truncated=false, files=[]` (caller treats as "no candidates").
 */
function walkMarkdownAndMdxFiles(
  root: string,
  limit: number,
  deadlineMs: number,
): { files: { relPath: string }[]; truncated: boolean } {
  const files: { relPath: string }[] = [];
  let truncated = false;
  function walk(d: string): void {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      // Unreadable directory; skip without crashing the whole walk.
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.startsWith('.')) continue;
      const full = join(d, entry);
      let isDir = false;
      try {
        isDir = lstatSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
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
    walk(root);
  } catch {
    // local_path is unreadable; return zero files, NOT truncated. Caller
    // surfaces this as "ok with note" rather than an error.
  }
  return { files, truncated };
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
  const limit = opts.limit ?? DEFAULT_FILE_LIMIT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;

  let totalCount = 0;
  let walkTruncated = false;
  const sample: MisroutedSample[] = [];

  for (const src of sources) {
    if (src.id === 'default') continue;
    if (!src.local_path) continue;
    if (Date.now() >= deadlineMs) {
      walkTruncated = true;
      break;
    }
    const { files, truncated } = walkMarkdownAndMdxFiles(src.local_path, limit, deadlineMs);
    if (truncated) walkTruncated = true;
    if (files.length === 0) continue;

    // Convert FS paths to canonical slugs (lowercased, extension stripped).
    const slugs = Array.from(new Set(files.map(f => pathToSlug(f.relPath))));
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

  return { walk_truncated: walkTruncated, count: totalCount, sample };
}
