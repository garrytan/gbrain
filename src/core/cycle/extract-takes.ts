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
import { parseTakesFence, type ParsedTake } from '../takes-fence.ts';
import { walkMarkdownFiles } from '../../commands/extract.ts';

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
}

/**
 * Resolve a slug to its DB page_id. Returns null when no row exists for
 * that slug (e.g. file on disk that hasn't been imported yet).
 */
async function getPageIdForSlug(engine: BrainEngine, slug: string): Promise<number | null> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  return rows[0]?.id ?? null;
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
  opts: { repoPath: string; slugs?: string[]; dryRun?: boolean; rebuild?: boolean },
): Promise<ExtractTakesResult> {
  const result: ExtractTakesResult = {
    pagesScanned: 0, pagesWithTakes: 0, takesUpserted: 0, warnings: [],
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
      for (const w of warnings) result.warnings.push(`${slug}: ${w}`);
    }
    if (takes.length === 0) continue;

    const pageId = await getPageIdForSlug(engine, slug);
    if (pageId === null) {
      result.warnings.push(`TAKES_PAGE_NOT_IN_DB: slug=${slug} has takes fence but no page row; run 'gbrain sync' first`);
      continue;
    }

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
 * Snapshot-stable (uses getAllSlugs). Doesn't read disk — works on
 * Postgres-only deployments without a local checkout.
 */
export async function extractTakesFromDb(
  engine: BrainEngine,
  opts: { slugs?: string[]; dryRun?: boolean; rebuild?: boolean } = {},
): Promise<ExtractTakesResult> {
  const result: ExtractTakesResult = {
    pagesScanned: 0, pagesWithTakes: 0, takesUpserted: 0, warnings: [],
  };
  const dryRun = opts.dryRun ?? false;
  const slugs = opts.slugs && opts.slugs.length > 0
    ? opts.slugs
    : Array.from(await engine.getAllSlugs());
  const buffer: TakeBatchInput[] = [];

  for (const slug of slugs) {
    result.pagesScanned++;
    const page = await engine.getPage(slug);
    if (!page) continue;
    const body = `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`;
    const { takes, warnings } = parseTakesFence(body);
    if (warnings.length) {
      for (const w of warnings) result.warnings.push(`${slug}: ${w}`);
    }
    if (takes.length === 0) continue;

    if (opts.rebuild && !dryRun) {
      await engine.executeRaw(`DELETE FROM takes WHERE page_id = $1`, [page.id]);
    }

    result.pagesWithTakes++;
    for (const t of takes) {
      buffer.push(parsedTakeToBatchInput(page.id, t));
      if (buffer.length >= BATCH_SIZE) await flushBatch(engine, buffer, result, dryRun);
    }
  }
  await flushBatch(engine, buffer, result, dryRun);
  return result;
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
