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
 * derived index. `gbrain takes rebuild <slug>` (rebuild) first deletes every
 * indexed row whose (row_num, claim) is not in the page's fence, so a row the
 * index and the fence disagree on is re-inserted fresh, while a row whose
 * claim is unchanged keeps its resolution and vector (#5167). Without
 * rebuild, ON CONFLICT (page_id, row_num) DO UPDATE keeps the table in sync
 * incrementally.
 * On a managed brain the db path publishes each page that needs a change as a
 * receipted database-only maintenance request (the `takes` guard refuses any
 * other writer).
 *
 * Sync-failure surfacing: malformed table rows produce
 * `TAKES_TABLE_MALFORMED` and `TAKES_ROW_NUM_COLLISION` warnings. v0.28
 * threads them through as ExtractTakesResult.warnings; the v0_28_0
 * orchestrator persists to ~/.gbrain/sync-failures.jsonl via the existing
 * v0.22.12 classifier path (extension follow-up — not blocking v0.28).
 */

import { isQuarantined, QUARANTINE_KEY } from '../quarantine.ts';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine, TakeBatchInput } from '../engine.ts';
import { parseTakesFence, TAKES_FENCE_BEGIN, type ParsedTake } from '../takes-fence.ts';
import { walkMarkdownFiles } from '../../commands/extract.ts';
import { takesPreparation } from '../takes-write.ts';
import { buildTakeRows } from '../batch-rows.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import { isTerminal, type WriteRequest } from '../persistence/model.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { digest } from '../persistence/digest.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { opError, OperationError } from '../ops/contract.ts';

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
  /** When true, first deletes each affected page's indexed rows whose (row_num, claim) left its fence. */
  rebuild?: boolean;
  /** db path: only pages of this source (default: every source holding the slug). */
  sourceId?: string;
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

/** Rebuild: drop indexed rows the fence no longer carries with the same claim; rows that still match keep resolution and vector. */
async function deleteDivergedTakes(engine: BrainEngine, pageId: number, takes: ParsedTake[]): Promise<void> {
  await engine.executeRaw(`DELETE FROM takes WHERE page_id = $1 AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS f(row_num int, claim text) WHERE f.row_num = takes.row_num AND f.claim = takes.claim)`,
  [pageId, JSON.stringify(takes.map(t => ({ row_num: t.rowNum, claim: t.claim })))]);
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
    const inserted = await maintenanceTransaction(engine, tx => tx.addTakesBatch(buffer));
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
    // #6259: the stored page decides (the gate stamps quarantine on it); a quarantined page projects no takes.
    if ((await engine.executeRaw('SELECT 1 FROM pages WHERE id=$1 AND frontmatter ? $2', [pageId, QUARANTINE_KEY])).length) continue;
    await pruneRemovedTakes(engine, pageId, body, takes, warnings, dryRun);
    if (takes.length === 0) continue;

    if (opts.rebuild && !dryRun) await deleteDivergedTakes(engine, pageId, takes);

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
  opts: { slugs?: string[]; dryRun?: boolean; rebuild?: boolean; sourceId?: string } = {},
): Promise<ExtractTakesResult> {
  const result: ExtractTakesResult = {
    pagesScanned: 0, pagesWithTakes: 0, takesUpserted: 0, warnings: [], failedFiles: [],
  };
  const dryRun = opts.dryRun ?? false;
  const rebuild = opts.rebuild ?? false;
  // Every (slug, source_id) pair across all sources; bare slugs re-extract
  // the page in every source that holds that slug.
  const slugFilter = opts.slugs && opts.slugs.length > 0 ? new Set(opts.slugs) : null;
  const refs = (await engine.listAllPageRefs()).filter(ref => (!slugFilter || slugFilter.has(ref.slug)) && (!opts.sourceId || ref.source_id === opts.sourceId));
  const buffer: TakeBatchInput[] = [];
  const coordinated = !dryRun && await managedPersistenceEnabled(engine);
  const authorities = new Map<string, Promise<MaintenanceAuthority>>();
  const authorityFor = (sourceId: string) => {
    if (!authorities.has(sourceId)) authorities.set(sourceId, maintenancePreflight(engine, sourceId).then(a => a!));
    return authorities.get(sourceId)!;
  };

  for (const { slug, source_id } of refs) {
    result.pagesScanned++;
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    // #6259: a quarantined page projects no takes (its existing rows are left as they are).
    if (isQuarantined(page.frontmatter as Record<string, unknown> | null)) continue;
    if (coordinated) {
      // A page with no takes marker at all yields no prune, no upsert and no
      // warning; near-miss and unbalanced markers still reach the parser.
      if (`${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`.includes('gbrain:takes:')) {
        await reextractCoordinated(engine, authorityFor, slug, source_id, rebuild, result);
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
  if (rebuild && !dryRun) await deleteDivergedTakes(db, page.id, takes);
  result.pagesWithTakes++;
  return takes;
}

export const TAKES_REEXTRACT_INTENT = 'managed_maintenance_takes_reextract';

/** The page's takes reconcile as it stands: what a write would prune, rebuild and upsert. */
async function plannedTakes(db: BrainEngine, page: { id: number; compiled_truth: string | null; timeline: string | null }, rebuild: boolean) {
  const body = `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`;
  const { takes, warnings } = parseTakesFence(body);
  const { rows } = buildTakeRows(takes.map(t => takesPreparation.toCanonicalBatchInput(page.id, t)));
  const stored = await db.executeRaw<{ row_num: number; claim: string; kind: string; holder: string; weight: number | string; since_date: string | null;
    until_date: string | null; source: string | null; superseded_by: number | null; active: boolean }>(
    'SELECT row_num, claim, kind, holder, weight, since_date, until_date, source, superseded_by, active FROM takes WHERE page_id = $1', [page.id]);
  const byRow = new Map(stored.map(r => [Number(r.row_num), r]));
  const prunes = warnings.length === 0 && body.includes(TAKES_FENCE_BEGIN) && stored.some(r => !takes.some(t => t.rowNum === Number(r.row_num)));
  const diverged = rebuild && stored.some(r => !takes.some(t => t.rowNum === Number(r.row_num) && t.claim === r.claim));
  const upserts = rows.some(row => {
    const s = byRow.get(row.row_num);
    return !s || s.claim !== row.claim || s.kind !== row.kind || s.holder !== row.holder
      || Math.abs(Number(s.weight) - row.weight) > 1e-4 || (s.since_date ?? null) !== row.since_date || (s.until_date ?? null) !== row.until_date
      || (s.source ?? null) !== row.source || (s.superseded_by == null ? null : Number(s.superseded_by)) !== row.superseded_by || s.active !== row.active;
  });
  return { changed: prunes || diverged || upserts, takes };
}

/**
 * Managed brains guard `takes` (#5728): each page that needs a change
 * publishes a database-only `managed_maintenance_takes_reextract` request
 * bound to its revision, and its preparer reconciles the page against the
 * text read under the page lock. Rows carry the `superseded_by` the
 * canonical publication projects (the shared
 * `takesPreparation.toCanonicalBatchInput`), so a page it already projected
 * keeps the same values and admits nothing. Resolution columns stay
 * untouched, as on the unmanaged path: some resolutions live only in the
 * database.
 */
async function reextractCoordinated(
  engine: BrainEngine,
  authorityFor: (sourceId: string) => Promise<MaintenanceAuthority>,
  slug: string,
  sourceId: string,
  rebuild: boolean,
  result: ExtractTakesResult,
): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  const [page] = await engine.executeRaw<{ id: number; compiled_truth: string | null; timeline: string | null }>(
    'SELECT id, compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
  if (!snapshot || !page || Number(page.id) !== snapshot.page.id) return;
  const plan = await plannedTakes(engine, page, rebuild);
  if (!plan.changed) {
    const { warnings } = parseTakesFence(`${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`);
    recordTakesWarnings(slug, warnings, result);
    if (plan.takes.length) result.pagesWithTakes++;
    return;
  }
  const authority = await authorityFor(sourceId);
  for (let attempt = 0; ; attempt++) {
    const h = digest(['extract-takes-db-v1', authority.writer.sourceIncarnation, sourceId, slug, snapshot.revision, rebuild, attempt]);
    const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior && isTerminal(prior) && prior.state !== 'committed') continue;
    try {
      const receipt = await submitDatabaseMaintenanceIntent(engine, authority, slug,
        { kind: TAKES_REEXTRACT_INTENT, expected_revision: snapshot.revision, rebuild }, requestId);
      result.takesUpserted += Number(receipt.takes_upserted ?? 0);
      if (receipt.with_takes === true) result.pagesWithTakes++;
      recordTakesWarnings(slug, Array.isArray(receipt.warnings) ? receipt.warnings.map(String) : [], result);
      return;
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed', 'write_pending'].includes(error.code)) {
        result.warnings.push(`${slug}: TAKES_REEXTRACT_DEFERRED: the page changed or its request is still pending (${error.code}); rerun to extract it`);
        return;
      }
      throw error;
    }
  }
}

function recordTakesWarnings(slug: string, warnings: string[], result: ExtractTakesResult): void {
  for (const w of warnings) {
    result.warnings.push(`${slug}: ${w}`);
    if (w.startsWith('TAKES_HOLDER_INVALID')) result.failedFiles.push({ path: slug, error: w });
  }
}

/** Preparer for `managed_maintenance_takes_reextract`: reconciles one page's takes under its key. */
export async function prepareTakesReextract(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== Number(row.page_id)) {
    throw opError('page_identity_changed', 'The page was deleted or replaced before its takes were extracted.',
      `Page ${row.slug} in source ${row.source_id} changed before request ${row.request_id} ran, so its takes index was left as it was. Run gbrain extract takes --source db again; it reads the current page.`);
  }
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const rebuild = (row.intent as { rebuild?: unknown } | null)?.rebuild === true;
  return { observedRevision: snapshot.revision, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => {
      const [page] = await tx.executeRaw<{ id: number; compiled_truth: string | null; timeline: string | null }>(
        'SELECT id, compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [row.source_id, row.slug]);
      const local: ExtractTakesResult = { pagesScanned: 0, pagesWithTakes: 0, takesUpserted: 0, warnings: [], failedFiles: [] };
      const takes = page ? await reconcilePageTakes(tx, page, row.slug, rebuild, false, local) : [];
      const upserted = takes.length ? await tx.addTakesBatch(takes.map(t => takesPreparation.toCanonicalBatchInput(page!.id, t))) : 0;
      return { status: 'completed', takes_upserted: upserted, with_takes: local.pagesWithTakes > 0,
        warnings: local.warnings.map(w => w.slice(row.slug.length + 2)) };
    } };
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
    sourceId: opts.sourceId,
  });
}

/** Re-export so callers don't have to import from the relative path. */
export { join, relative };
