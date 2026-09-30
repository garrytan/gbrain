/**
 * v0.28: extract-takes phase. Parses fenced takes blocks out of markdown
 * pages and upserts them into the `takes` table.
 *
 * Two paths (mirror src/commands/extract.ts dual-path pattern):
 *   - fs:  walk *.md files under repoPath; parse each fence; batch upsert
 *   - db:  iterate engine.getAllSlugs(); fetch each page's compiled_truth +
 *          timeline; parse fence; batch upsert
 *
 * Source-of-truth contract: markdown is canonical. The takes table is a
 * derived index. `gbrain extract takes --rebuild` deletes all takes for
 * the affected pages first, then re-inserts. Without --rebuild, ON CONFLICT
 * (page_id, row_num) DO UPDATE keeps the table in sync incrementally.
 * On a managed brain the db path publishes each page's rows through the
 * persistence coordinator (the `takes` guard refuses any other writer).
 *
 * Sync-failure surfacing: malformed table rows produce
 * `TAKES_TABLE_MALFORMED` and `TAKES_ROW_NUM_COLLISION` warnings. v0.28
 * threads them through as ExtractTakesResult.warnings; the v0_28_0
 * orchestrator persists to ~/.gbrain/sync-failures.jsonl via the existing
 * v0.22.12 classifier path (extension follow-up — not blocking v0.28).
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine, TakeBatchInput } from '../engine.ts';
import { parseTakesFence, TAKES_FENCE_BEGIN, type ParsedTake } from '../takes-fence.ts';
import { walkMarkdownFiles } from '../../commands/extract.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';

export interface ExtractTakesOpts {
  /** Brain repo root. Required for source='fs'. */
  repoPath?: string;
  /** Source: 'fs' walks markdown files; 'db' iterates engine pages. Default 'fs'. */
  source?: 'fs' | 'db';
  /**
   * Optional incremental list of slugs to re-extract (used by sync→extract
   * pipe). Empty/undefined = full walk.
   */
  slugs?: string[];
  /** Dry-run: parse + count, don't write. */
  dryRun?: boolean;
  /** When true, deletes existing takes for affected pages first. */
  rebuild?: boolean;
}

export interface ExtractTakesResult {
  pagesScanned: number;
  pagesWithTakes: number;
  takesUpserted: number;
  warnings: string[];
  /**
   * v0.32 EXP-4 producer seam (codex review #4). Subset of warnings shaped
   * for `recordSyncFailures()`: each entry is a `(path, error)` pair the
   * caller can hand to sync.ts so doctor's `sync_failures` check shows the
   * breakdown by code (`TAKES_HOLDER_INVALID=N`).
   *
   * Currently captures only `TAKES_HOLDER_INVALID` warnings — the other
   * fence-parse warnings (TAKES_TABLE_MALFORMED etc.) are non-fatal data
   * quality signals that already surface via `result.warnings` for
   * progress-line visibility but don't need persistent JSONL records yet.
   * Extend this list when a new warning class earns sync-failure persistence.
   *
   * `path` is the file path on FS-source extraction and the slug on
   * DB-source extraction (slug is the closest stable identifier when
   * there's no on-disk file to point at).
   */
  failedFiles: Array<{ path: string; error: string }>;
}

/**
 * Resolve a slug to its DB page_id. Returns null when no row exists for
 * that slug (e.g. file on disk that hasn't been imported yet).
 */
async function getPageIdForSlug(engine: BrainEngine, slug: string, sourceId: string): Promise<number | null> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [slug, sourceId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Remove takes whose rows left the page's fence. Only a fence that parsed
 * cleanly is authoritative (a skipped malformed row is not a deletion), and a
 * page without a fence keeps whatever the index holds.
 */
async function pruneRemovedTakes(
  engine: BrainEngine,
  pageId: number,
  body: string,
  takes: ParsedTake[],
  warnings: string[],
  dryRun: boolean,
): Promise<void> {
  if (dryRun || warnings.length > 0 || !body.includes(TAKES_FENCE_BEGIN)) return;
  await engine.executeRaw(
    'DELETE FROM takes WHERE page_id = $1 AND NOT (row_num = ANY($2::integer[]))',
    [pageId, takes.map(t => t.rowNum)],
  );
}

function parsedTakeToBatchInput(pageId: number, t: ParsedTake): TakeBatchInput {
  return {
    page_id: pageId,
    row_num: t.rowNum,
    claim: t.claim,
    kind: t.kind,
    holder: t.holder,
    weight: t.weight,
    since_date: t.sinceDate,
    until_date: t.untilDate,
    source: t.source,
    active: t.active,
    superseded_by: null,
  };
}

const BATCH_SIZE = 100;

async function flushBatch(
  engine: BrainEngine,
  buffer: TakeBatchInput[],
  result: ExtractTakesResult,
  dryRun: boolean,
): Promise<void> {
  if (buffer.length === 0) return;
  if (dryRun) {
    result.takesUpserted += buffer.length;
  } else {
    const inserted = await engine.addTakesBatch(buffer);
    result.takesUpserted += inserted;
  }
  buffer.length = 0;
}

/**
 * Walk the repo's markdown files and extract takes from any fenced blocks.
 * Pages without a fence are no-ops.
 */
export async function extractTakesFromFs(
  engine: BrainEngine,
  opts: { repoPath: string; slugs?: string[]; dryRun?: boolean; rebuild?: boolean; sourceId?: string },
): Promise<ExtractTakesResult> {
  const sourceId = opts.sourceId ?? 'default';
  const result: ExtractTakesResult = {
    pagesScanned: 0, pagesWithTakes: 0, takesUpserted: 0, warnings: [], failedFiles: [],
  };
  const dryRun = opts.dryRun ?? false;
  const slugFilter = opts.slugs && opts.slugs.length > 0 ? new Set(opts.slugs) : null;

  const files = walkMarkdownFiles(opts.repoPath);
  const buffer: TakeBatchInput[] = [];

  for (const { path, relPath } of files) {
    const slug = relPath.replace(/\.md$/, '').split(sep).join('/');
    if (slugFilter && !slugFilter.has(slug)) continue;
    result.pagesScanned++;

    let body: string;
    try {
      body = readFileSync(path, 'utf-8');
    } catch (e) {
      result.warnings.push(`TAKES_FILE_READ_FAILED: ${relPath}: ${(e as Error).message}`);
      continue;
    }

    const { takes, warnings } = parseTakesFence(body);
    if (warnings.length) {
      for (const w of warnings) {
        result.warnings.push(`${slug}: ${w}`);
        if (w.startsWith('TAKES_HOLDER_INVALID')) {
          result.failedFiles.push({ path: relPath, error: w });
        }
      }
    }
    if (takes.length === 0 && !body.includes(TAKES_FENCE_BEGIN)) continue;

    const pageId = await getPageIdForSlug(engine, slug, sourceId);
    if (pageId === null) {
      if (takes.length > 0) result.warnings.push(`TAKES_PAGE_NOT_IN_DB: slug=${slug} has takes fence but no page row; run 'gbrain sync' first`);
      continue;
    }
    await pruneRemovedTakes(engine, pageId, body, takes, warnings, dryRun);
    if (takes.length === 0) continue;

    if (opts.rebuild && !dryRun) {
      await engine.executeRaw(`DELETE FROM takes WHERE page_id = $1`, [pageId]);
    }

    result.pagesWithTakes++;
    for (const t of takes) {
      buffer.push(parsedTakeToBatchInput(pageId, t));
      if (buffer.length >= BATCH_SIZE) await flushBatch(engine, buffer, result, dryRun);
    }
  }
  await flushBatch(engine, buffer, result, dryRun);
  return result;
}

/**
 * Iterate engine pages and re-extract takes from each `compiled_truth` body.
 * Snapshot-stable (uses listAllPageRefs). Doesn't read disk — works on
 * Postgres-only deployments without a local checkout.
 *
 * v0.32.8: replaces the prior `getAllSlugs() → getPage(slug)` pattern. The
 * old version dropped `source_id` between the enumeration and the lookup,
 * so a non-default-source page either matched the wrong (default-source)
 * row or returned null when it didn't exist in default. Now we enumerate
 * (slug, source_id) pairs and pass `sourceId` to getPage explicitly.
 */
export async function extractTakesFromDb(
  engine: BrainEngine,
  opts: { slugs?: string[]; dryRun?: boolean; rebuild?: boolean } = {},
): Promise<ExtractTakesResult> {
  const result: ExtractTakesResult = {
    pagesScanned: 0, pagesWithTakes: 0, takesUpserted: 0, warnings: [], failedFiles: [],
  };
  const dryRun = opts.dryRun ?? false;
  const rebuild = opts.rebuild ?? false;
  // Every (slug, source_id) pair across all sources; bare slugs re-extract
  // the page in every source that holds that slug.
  const slugFilter = opts.slugs && opts.slugs.length > 0 ? new Set(opts.slugs) : null;
  const refs = (await engine.listAllPageRefs()).filter(ref => !slugFilter || slugFilter.has(ref.slug));
  const buffer: TakeBatchInput[] = [];
  const coordinated = !dryRun && await managedPersistenceEnabled(engine);

  for (const { slug, source_id } of refs) {
    result.pagesScanned++;
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    if (coordinated) {
      // A page with no takes marker at all yields no prune, no upsert and no
      // warning; near-miss and unbalanced markers still reach the parser.
      if (`${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`.includes('gbrain:takes:')) {
        await reextractCoordinated(engine, slug, source_id, rebuild, result);
      }
      continue;
    }
    const takes = await reconcilePageTakes(engine, page, slug, rebuild, dryRun, result);
    for (const t of takes) {
      buffer.push(parsedTakeToBatchInput(page.id, t));
      if (buffer.length >= BATCH_SIZE) await flushBatch(engine, buffer, result, dryRun);
    }
  }
  await flushBatch(engine, buffer, result, dryRun);
  return result;
}

/**
 * Parse one page's body and record its warnings, then prune rows that left a
 * cleanly parsed fence (and, under rebuild, clear the page). Returns the takes
 * the caller upserts.
 */
async function reconcilePageTakes(
  db: BrainEngine,
  page: { id: number; compiled_truth: string | null; timeline: string | null },
  slug: string,
  rebuild: boolean,
  dryRun: boolean,
  result: ExtractTakesResult,
): Promise<ParsedTake[]> {
  const body = `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`;
  const { takes, warnings } = parseTakesFence(body);
  for (const w of warnings) {
    result.warnings.push(`${slug}: ${w}`);
    if (w.startsWith('TAKES_HOLDER_INVALID')) {
      // DB-source path: no on-disk file path, use slug as the failedFiles
      // identifier. recordSyncFailures' dedup-by-(path, commit, error)
      // works the same against slug-shaped paths.
      result.failedFiles.push({ path: slug, error: w });
    }
  }
  await pruneRemovedTakes(db, page.id, body, takes, warnings, dryRun);
  if (takes.length === 0) return [];
  if (rebuild && !dryRun) {
    await db.executeRaw(`DELETE FROM takes WHERE page_id = $1`, [page.id]);
  }
  result.pagesWithTakes++;
  return takes;
}

/**
 * Managed brains guard `takes` (#5728): each page publishes as a coordinated
 * write under its page lock, against the text read inside that transaction.
 * Rows carry the `superseded_by` the canonical publication projects (keep in
 * lockstep with src/core/persistence/canonical-projections.ts), so a page it
 * already projected keeps the same values. Resolution columns stay untouched,
 * as on the unmanaged path: some resolutions live only in the database.
 */
async function reextractCoordinated(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  rebuild: boolean,
  result: ExtractTakesResult,
): Promise<void> {
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const [page] = await tx.executeRaw<{ id: number; compiled_truth: string | null; timeline: string | null }>(
      'SELECT id, compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL',
      [sourceId, slug]);
    if (!page) return;
    const takes = await reconcilePageTakes(tx, page, slug, rebuild, false, result);
    if (takes.length === 0) return;
    result.takesUpserted += await tx.addTakesBatch(takes.map(t => ({
      ...parsedTakeToBatchInput(page.id, t),
      superseded_by: t.active ? null : Number(t.source?.match(/superseded by #(\d+)/)?.[1]) || null,
    })));
  }));
}

/** Single-entry dispatch for `gbrain extract takes` and the v0_28_0 orchestrator. */
export async function extractTakes(
  engine: BrainEngine,
  opts: ExtractTakesOpts,
): Promise<ExtractTakesResult> {
  const source = opts.source ?? (opts.repoPath ? 'fs' : 'db');
  if (source === 'fs') {
    if (!opts.repoPath) throw new Error('extractTakes: source=fs requires repoPath');
    return extractTakesFromFs(engine, {
      repoPath: opts.repoPath,
      slugs: opts.slugs,
      dryRun: opts.dryRun,
      rebuild: opts.rebuild,
    });
  }
  return extractTakesFromDb(engine, {
    slugs: opts.slugs,
    dryRun: opts.dryRun,
    rebuild: opts.rebuild,
  });
}

/** Re-export so callers don't have to import from the relative path. */
export { join, relative };
