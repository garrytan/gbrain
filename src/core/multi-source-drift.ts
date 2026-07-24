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

/**
 * Cheap, single-slug mirror check (#2786) — distinct from `findMisroutedPages`
 * above, which is a bulk FS-walk heuristic meant for the periodic `gbrain
 * doctor` sweep. This one is meant to run inline on a hot write path (Life
 * Chronicle derivation, one page at a time) so it does DB-only work: no
 * filesystem access, no walk, just an indexed-by-value lookup.
 *
 * "Mirror" here means an EXACT content copy: the same slug exists (and is
 * not soft-deleted) under a different source, its `content_hash` matches
 * byte-for-byte, AND its `effective_date` also matches (`IS NOT DISTINCT
 * FROM`, so NULL-vs-NULL still counts as a match) — UNLESS either side's
 * `effective_date_source` is `'fallback'` (no real date could be inferred,
 * so the column holds an import-time timestamp with no content meaning; two
 * fallback-dated copies imported at different times are still the same
 * mirror, not a date mismatch — codex review round 6). The date check
 * matters because `content_hash` (title/type/compiled_truth/timeline/
 * frontmatter, see `utils.ts`) does NOT cover `effective_date` — two pages
 * with identical body text but a DIFFERENT, genuinely-inferred meeting date
 * would otherwise hash identically and wrongly be treated as the same
 * mirror, silently skipping the correctly-dated derivation at the DB-only
 * source (codex review round 4).
 *
 * The candidate mirror must also be a DURABLE, canonical home — `default`
 * or an active (non-archived), file-backed source (`local_path IS NOT
 * NULL`) — not just "any other source with the same content". Without this,
 * two non-canonical DB-only sources holding the same identical page would
 * each see the OTHER as "the mirror" and both refuse to derive, so NEITHER
 * gets an event (codex review P2). Restricting the candidate side to a
 * durable home means: if the only other copy is itself a throwaway/archived
 * DB-only source, there's nothing safe to defer to, so derivation proceeds
 * normally at the scoped source.
 *
 * Same-slug-DIFFERENT-content across sources is the supported multi-tenant
 * case (see `multi-source-drift.test.ts` "healthy same-slug-across-sources"
 * / OV4) and must NOT be flagged as a mirror. Only a literal, same-date
 * duplicate at a durable home counts.
 *
 * Returns the `source_id`s of any such duplicate. Empty `contentHash` (a
 * page whose hash was never computed) short-circuits to `[]` rather than
 * matching everything.
 */
export async function findMirrorSources(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  contentHash: string | undefined,
  effectiveDate: Date | string | null,
  effectiveDateSource: string | null,
): Promise<string[]> {
  if (!contentHash) return [];
  // codex review round 6 (P1): a page whose date could never be inferred
  // from real content (no frontmatter date/event_date/published/filename)
  // gets `effective_date` STAMPED FROM ITS OWN IMPORT-TIME `updated_at`
  // (`effective_date_source = 'fallback'`, see backfill-effective-date.ts /
  // import-file.ts). Two byte-identical copies imported at different wall-
  // clock times would then carry two DIFFERENT fallback timestamps despite
  // being the exact same mirror — enforcing exact-date-equality in that case
  // reintroduces the original #2786 bug (extraction proceeds under the
  // disposable mirror source) instead of fixing the P2 false-positive it was
  // meant to close. Only enforce the date check when NEITHER side's date is
  // a fallback (i.e., both are real, content-derived dates); if either side
  // has no real date, fall back to content_hash-only matching (the
  // pre-date-check #2786 semantics).
  //
  // NULL effective_date_source (codex review round 7 P1) is treated the SAME
  // as 'fallback', not as "has a real date": a legacy row that predates the
  // v0.29.1 effective_date/effective_date_source backfill has NULL for both
  // columns even though it may be byte-identical to a durable copy that DOES
  // have a real, populated date. Without this, every arm of the OR below
  // evaluates false for that pairing (NULL is never NOT DISTINCT FROM a
  // real date, and neither side's source is literally the string
  // 'fallback'), so the guard silently returns [] and extraction proceeds
  // under the disposable source — recreating the exact data-loss bug this
  // guard exists to prevent.
  const rows = await engine.executeRaw<{ source_id: string }>(
    `SELECT p.source_id FROM pages p
       JOIN sources s ON s.id = p.source_id
      WHERE p.slug = $1
        AND p.source_id <> $2
        AND p.deleted_at IS NULL
        AND p.content_hash = $3
        AND (
          $5::text IS NULL OR $5::text = 'fallback'
          OR p.effective_date_source IS NULL OR p.effective_date_source = 'fallback'
          OR p.effective_date IS NOT DISTINCT FROM $4
        )
        AND (p.source_id = 'default' OR (s.local_path IS NOT NULL AND s.archived = false))`,
    [slug, sourceId, contentHash, effectiveDate, effectiveDateSource],
  );
  return rows.map((r) => r.source_id);
}
