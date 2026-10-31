/**
 * #6865: files of a managed Git source that are committed, eligible for sync,
 * and neither indexed nor held. An older gbrain refused some files before
 * refusals became holds (a stray frontmatter `slug:` line, unreadable YAML);
 * incremental discovery never visits an unchanged file with no page and no
 * hold, so those files stay absent from search and nothing reports them.
 *
 * `findUnindexedFiles` streams the tree of the source's last synced commit
 * (`git ls-tree -r`, the committed set discovery walks), filters it through
 * discovery's own eligibility (`loadSyncEligibility`) and compares in
 * source-path space: a file counts as indexed when a live page records its
 * origin, held when it has a sync hold, and `scheduled` when a re-screen is
 * already requested for it. A file whose path slug belongs to a live page with
 * another or no origin is not indexed either; it is counted as `slug_taken`,
 * and one whose page was deleted while the file stayed committed as
 * `deleted_page`. Neither is ever scheduled: a re-screen cannot import them
 * (a collision, or a page sync keeps deleted), so a person renames, deletes or
 * restores, and doctor names them read-only.
 * Lookups run in batches on the existing indexes, never over every page at
 * once. A file sync skips on purpose as folder scaffolding (`index.md`,
 * `README.md` and the other `isSyncMetafile` names) that would otherwise be eligible
 * and whose frontmatter has a `type:` or `title:` is counted separately as
 * `metafile_skipped`: read-only, never scheduled, because sync skips it again.
 * That happens only under `sync.metafile_pages off` (GBRA-150): under the default
 * `typed` such a nested file is eligible, so it is found and scheduled like any file.
 * Each found file is screened read-only (the import screen's codes, or
 * `clean`) up to a cap. A time or count budget stops the scan with
 * `complete: false` and a cursor (the last Git path examined, in tree order),
 * so the next pass resumes there and every path is eventually covered; an
 * incomplete scan is never reported clean.
 *
 * `refreshUnindexedFiles` runs one bounded pass, schedules the found paths
 * for a re-screen on the next sync (`requestGitHoldRetry`, at most
 * `UNINDEXED_SCHEDULE_CAP` per pass; a scheduling write, never a content
 * write) and stores the result per source in `op_checkpoints` (op
 * `unindexed-files`), where doctor `unindexed_files` reads it through
 * `judgeUnindexedFiles`. An incomplete stored result is continued and
 * accumulated by the next pass while its incarnation and eligibility
 * fingerprint are unchanged, also when the source's commit moved meanwhile
 * (#7149: a busy source commits between every two maintenance runs, and a scan
 * that started over each time never finished): the continuation first
 * re-examines the paths before its cursor that changed between the two
 * commits, then resumes after the cursor. When those changes cannot be listed
 * (the old commit is gone) or number more than `UNINDEXED_REVISIT_CAP`, the
 * pass starts over. Each source's time budget grows with its size
 * (`unindexedScanBudgetMs`). Blobs are read
 * and screened in slices bounded by bytes, with the deadline checked between
 * slices (a file left unread counts as `unscreened`).
 */
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts } from '../../commands/sync.ts';
import { spawn } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { isSyncMetafile, matchesAnyGlob, metafileIsPage, resolveSlugForPath } from '../sync.ts';
import { screenImportContent } from '../import-screen.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { loadSyncEligibility, resolveManagedSyncContext, syncExcludePatterns, syncGit, type ManagedSyncContext } from './sync-discovery.ts';
import { heldGitPaths, readGitHoldRetryPaths, requestGitHoldRetry } from './sync-holds.ts';
import { readBlobContents, type TreeBlob } from './sync-blobs.ts';
import { isWindowsColonTarget } from './native-file-target.ts';
import { createHash } from 'node:crypto';

export const UNINDEXED_FILES_OP = 'unindexed-files';
/** Paths one pass schedules for a re-screen, and the most scheduled paths a stored result names. */
export const UNINDEXED_SCHEDULE_CAP = 5_000;
/** Found files one pass screens; the rest count as `unscreened`. */
export const UNINDEXED_SCREEN_LIMIT = 2_000;
export const UNINDEXED_SAMPLE_LIMIT = 20;
/** The time one live pass (the maintenance phase, `sources retry-held --unindexed`) spends per `UNINDEXED_BUDGET_PAGES` live pages of its source. */
export const UNINDEXED_SCAN_BUDGET_MS = 60_000;
export const UNINDEXED_BUDGET_PAGES = 100_000;
/** The most one pass of one source spends, and the most the maintenance phase spends over all sources. */
export const UNINDEXED_SCAN_MAX_BUDGET_MS = 300_000;
/** Changed paths before a stored cursor a continuation re-examines; with more, the pass starts over. */
export const UNINDEXED_REVISIT_CAP = 5_000;
/** A stored result older than this is stale. */
export const UNINDEXED_STALE_MS = 7 * 24 * 3_600_000;
const BATCH = 1_000;
const SYMLINK_MODE = '120000';
/** Blob bytes one screening slice holds in memory at most (a single larger blob is read alone); each slice is released before the next. */
const SCREEN_SLICE_BYTES = 32 * 1024 ** 2;

export interface UnindexedFile { path: string; source_path: string; code: string; slug_taken: boolean; deleted_page: boolean }
export interface UnindexedSample { path: string; code: string; slug_taken?: true; deleted_page?: true }

export interface UnindexedScan {
  source_id: string;
  incarnation: string;
  /** The commit whose tree was scanned (the source's last synced commit); null when the source never synced. */
  target: string | null;
  /** Fingerprint of what decides eligibility (scope, slug mode, sync excludes); a continuation needs the same one. */
  eligibility: string;
  complete: boolean;
  /** The last Git path examined when the budget stopped the scan; null when complete. */
  cursor: string | null;
  /** Eligible files examined. */
  scanned: number;
  /** Files with no page, no hold and no scheduled re-screen. */
  unindexed: number;
  /** Of `unindexed`: the path slug belongs to a live page with another or no recorded origin; never scheduled (a re-screen cannot import it). */
  slug_taken: number;
  /** Of `unindexed`: the file's page was deleted while the file stayed committed; never scheduled (sync keeps the page deleted). */
  deleted_page: number;
  /** Files with no page and no hold whose re-screen is already scheduled. */
  scheduled: number;
  by_code: Record<string, number>;
  samples: UnindexedSample[];
  /** Folder scaffolding names sync skips on purpose (`isSyncMetafile`) that are otherwise eligible and carry a frontmatter `type:` or `title:`; never scheduled. */
  metafile_skipped: number;
  metafile_samples: string[];
  /** The first unindexed files (at most `keep`), root-relative. */
  files: UnindexedFile[];
  /** The first already scheduled paths seen (at most `keep`), root-relative. */
  scheduled_paths: string[];
}

export interface UnindexedScanOpts {
  context?: ManagedSyncContext;
  /** Resume after this Git path (a previous incomplete scan's cursor). */
  cursor?: string | null;
  /** Git paths at or before `cursor` examined again first (paths that changed since the scan passed them). */
  revisit?: ReadonlySet<string>;
  /** Absolute epoch ms; checked after each batch, so every pass examines at least one batch. */
  deadlineAt?: number;
  /** Stop after examining this many eligible files. */
  maxScanned?: number;
  screenLimit?: number;
  keep?: number;
  /** Tree entries per lookup batch (default 1,000). */
  batch?: number;
  now?: () => number;
}

/** The stored result of the latest pass(es) for one source (`op_checkpoints` op `unindexed-files`, fingerprint the source id). */
export interface UnindexedRecord extends Omit<UnindexedScan, 'files' | 'scheduled_paths'> {
  version: 1;
  started_at: string;
  computed_at: string;
  /** Root-relative paths whose re-screen the stored passes scheduled or found scheduled, at most `UNINDEXED_SCHEDULE_CAP`. */
  pending: string[];
  /** Some scheduled paths did not fit in `pending`, so the result cannot confirm them. */
  pending_truncated: boolean;
  /** Of `unindexed`: how many the stored passes scheduled; the rest wait for a pass with room. */
  scheduled_now: number;
  /** Prepended to a root-relative path to get its page origin (`<scope>/` for a subdirectory source in git-root mode). */
  source_prefix: string;
}

interface TreeEntry { path: string; oid: string; size: number; mode: string }

/** Reads `entries` in slices of at most `SCREEN_SLICE_BYTES` and visits each with its text (undefined when too large to read); stops before a slice once `stop()` is true. */
function visitBlobSlices<T extends TreeBlob>(gitRoot: string, entries: T[], visit: (entry: T, content: string | undefined) => void, stop: () => boolean): void {
  for (let i = 0; i < entries.length && !stop();) {
    const slice: T[] = [];
    for (let bytes = 0; i < entries.length && (!slice.length || bytes + entries[i]!.size <= SCREEN_SLICE_BYTES); i++) { bytes += entries[i]!.size; slice.push(entries[i]!); }
    const contents = readBlobContents(gitRoot, slice);
    for (const entry of slice) visit(entry, contents.get(entry.oid));
  }
}

/** The blobs of `target` under `scope` in tree order, after `after`, in batches; the child stops when the consumer does. */
async function* treeBatches(gitRoot: string, target: string, scope: string, after: string | null, size: number, revisit?: ReadonlySet<string>): AsyncGenerator<TreeEntry[]> {
  const child = spawn('git', ['-c', 'core.quotepath=false', '--literal-pathspecs', '-C', gitRoot, 'ls-tree', '-r', '-l', '-z', target, ...(scope ? ['--', scope] : [])],
    { env: gitChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 2000); });
  const exit = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const floor = after === null ? null : Buffer.from(after, 'utf8');
  let pending: Buffer = Buffer.alloc(0), batch: TreeEntry[] = [];
  try {
    for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (let nul = pending.indexOf(0); nul >= 0; nul = pending.indexOf(0)) {
        const row = pending.subarray(0, nul).toString('utf8');
        pending = pending.subarray(nul + 1);
        const tab = row.indexOf('\t');
        const [mode, kind, oid, bytes] = row.slice(0, tab).split(/\s+/);
        const path = row.slice(tab + 1);
        if (kind !== 'blob' || floor && Buffer.compare(Buffer.from(path, 'utf8'), floor) <= 0 && !revisit?.has(path)) continue;
        batch.push({ path, oid: oid!, size: Number(bytes), mode: mode! });
        if (batch.length >= size) { yield batch; batch = []; }
      }
    }
    if (batch.length) yield batch;
    const code = await exit;
    if (code !== 0) throw new Error(`git ls-tree failed in ${gitRoot} (exit ${code}): ${stderr.trim().slice(0, 300)}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

const eligibilityKey = (scope: string, slugMode: string, exclude: string[]) => createHash('sha256').update(JSON.stringify([scope, slugMode, exclude])).digest('hex').slice(0, 16);

/** Files of one managed Git source with no live page, no hold and no scheduled re-screen; bounded by `opts`. */
export async function findUnindexedFiles(engine: BrainEngine, sourceId: string, opts: UnindexedScanOpts = {}): Promise<UnindexedScan> {
  const context = opts.context ?? await resolveManagedSyncContext(engine, { sourceId, noPull: true } as SyncOpts);
  const { gitRoot, incarnation } = context;
  const now = opts.now ?? Date.now;
  const keep = opts.keep ?? UNINDEXED_SCHEDULE_CAP;
  const screenLimit = opts.screenLimit ?? UNINDEXED_SCREEN_LIMIT;
  const { scope, slugMode, eligible, sourcePath, metafileHeads } = await loadSyncEligibility(engine, context);
  const exclude = await syncExcludePatterns(engine);
  const scan: UnindexedScan = { source_id: sourceId, incarnation, target: context.source.last_commit, eligibility: eligibilityKey(scope, slugMode, exclude), complete: true, cursor: null, scanned: 0, unindexed: 0,
    slug_taken: 0, deleted_page: 0, scheduled: 0, by_code: {}, samples: [], metafile_skipped: 0, metafile_samples: [], files: [], scheduled_paths: [] };
  if (!scan.target) return scan;
  const scaffolding = (path: string) => isSyncMetafile(path) && !matchesAnyGlob(scope ? path.slice(scope.length + 1) : path, exclude)
    && !isReservedSkillBundlePath(sourcePath(path)) && eligible(`${path.slice(0, path.lastIndexOf('/') + 1)}gbrain-metafile-probe${path.slice(path.lastIndexOf('.'))}`);
  const retry = new Set(await readGitHoldRetryPaths(engine, sourceId, incarnation));
  const pastDeadline = () => opts.deadlineAt !== undefined && now() >= opts.deadlineAt;
  let screened = 0;
  const floor = opts.cursor ? Buffer.from(opts.cursor, 'utf8') : null;
  for await (const batch of treeBatches(gitRoot, scan.target, scope, opts.cursor ?? null, opts.batch ?? BATCH, opts.revisit)) {
    metafileHeads.prime(batch);
    const rows = batch.filter(entry => eligible(entry.path) && !isWindowsColonTarget(entry.path)).map(entry => {
      const root = scope ? entry.path.slice(scope.length + 1) : entry.path;
      return { ...entry, root, origin: sourcePath(entry.path), legacy: slugMode === 'source-root' && scope ? entry.path : null };
    });
    scan.scanned += rows.length;
    const metafiles = batch.filter(entry => !eligible(entry.path) && scaffolding(entry.path));
    if (metafiles.length) {
      const indexed = new Set((await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path = ANY($2::text[])',
        [sourceId, metafiles.map(entry => sourcePath(entry.path))])).map(page => page.source_path));
      const unread = metafiles.filter(entry => !indexed.has(sourcePath(entry.path))).slice(0, Math.max(0, screenLimit - screened));
      screened += unread.length;
      visitBlobSlices(gitRoot, unread, (entry, content) => {
        if (!metafileIsPage(scope ? entry.path.slice(scope.length + 1) : entry.path, content, 'typed')) return;
        scan.metafile_skipped++;
        if (scan.metafile_samples.length < UNINDEXED_SAMPLE_LIMIT) scan.metafile_samples.push(scope ? entry.path.slice(scope.length + 1) : entry.path);
      }, () => false);
    }
    if (rows.length) {
      const origins = rows.flatMap(row => row.legacy ? [row.origin, row.legacy] : [row.origin]);
      const pages = await engine.executeRaw<{ source_path: string; slug: string }>(
        'SELECT source_path, slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path = ANY($2::text[])', [sourceId, origins]);
      const byOrigin = new Map(pages.map(page => [page.source_path, page.slug]));
      const held = await heldGitPaths(engine, sourceId, incarnation, rows.map(row => row.root));
      const missing = rows.filter(row => !byOrigin.has(row.origin) && !(row.legacy && byOrigin.get(row.legacy) === resolveSlugForPath(row.root)) && !held.has(row.root));
      const fresh = missing.filter(row => {
        if (!retry.has(row.root)) return true;
        scan.scheduled++;
        if (scan.scheduled_paths.length < keep) scan.scheduled_paths.push(row.root);
        return false;
      });
      const slugs = fresh.map(row => resolveSlugForPath(row.origin)).filter(Boolean);
      const taken = new Set(slugs.length ? (await engine.executeRaw<{ slug: string }>(
        'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug = ANY($2::text[])', [sourceId, slugs])).map(page => page.slug) : []);
      const deleted = new Set(fresh.length ? (await engine.executeRaw<{ source_path: string }>(
        'SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NOT NULL AND source_path = ANY($2::text[])', [sourceId, fresh.map(row => row.origin)])).map(page => page.source_path) : []);
      // #7149: a committed symlink's blob is its target path, not page content; it is named as one instead of screened.
      const codes = new Map<string, string>(fresh.filter(row => row.mode === SYMLINK_MODE).map(row => [row.root, 'symlink']));
      const toScreen = fresh.filter(row => row.mode !== SYMLINK_MODE).slice(0, Math.max(0, screenLimit - screened));
      screened += toScreen.length;
      visitBlobSlices(gitRoot, toScreen, (row, content) => {
        if (content === undefined) { codes.set(row.root, 'file_too_large'); return; }
        const result = screenImportContent({ content, path: row.origin, byteLength: row.size, expectedSlug: resolveSlugForPath(row.origin) || null, holdNoncanonicalPrivate: true });
        codes.set(row.root, result.status === 'refused' ? result.refusal.code : 'clean');
      }, pastDeadline);
      for (const row of fresh) {
        const code = codes.get(row.root) ?? 'unscreened', slugTaken = taken.has(resolveSlugForPath(row.origin)), deletedPage = deleted.has(row.origin);
        scan.unindexed++;
        if (slugTaken) scan.slug_taken++;
        if (deletedPage) scan.deleted_page++;
        scan.by_code[code] = (scan.by_code[code] ?? 0) + 1;
        if (scan.samples.length < UNINDEXED_SAMPLE_LIMIT) scan.samples.push({ path: row.root, code, ...(slugTaken ? { slug_taken: true as const } : {}), ...(deletedPage ? { deleted_page: true as const } : {}) });
        if (scan.files.length < keep) scan.files.push({ path: row.root, source_path: row.origin, code, slug_taken: slugTaken, deleted_page: deletedPage });
      }
    }
    if (pastDeadline() || (opts.maxScanned !== undefined && scan.scanned >= opts.maxScanned)) {
      scan.complete = false;
      const last = batch[batch.length - 1]!.path;
      scan.cursor = floor && Buffer.compare(Buffer.from(last, 'utf8'), floor) <= 0 ? opts.cursor! : last;
      break;
    }
  }
  return scan;
}

/** One pass's time budget for a source: `UNINDEXED_SCAN_BUDGET_MS` per started `UNINDEXED_BUDGET_PAGES` live pages, at most `UNINDEXED_SCAN_MAX_BUDGET_MS`. */
export async function unindexedScanBudgetMs(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [sourceId]);
  return unindexedBudgetForPages(Number(row?.n ?? 0));
}

export function unindexedBudgetForPages(pages: number): number {
  return Math.min(UNINDEXED_SCAN_MAX_BUDGET_MS, UNINDEXED_SCAN_BUDGET_MS * Math.max(1, Math.ceil(pages / UNINDEXED_BUDGET_PAGES)));
}

/** Git paths at or before `cursor` that differ between `from` and `to`; null when Git cannot list them or they number more than `UNINDEXED_REVISIT_CAP`. */
function changedBefore(gitRoot: string, from: string, to: string, scope: string, cursor: string): Set<string> | null {
  let listed: string;
  try { listed = syncGit(gitRoot, ['--literal-pathspecs', 'diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to, ...(scope ? ['--', scope] : [])]); } catch { return null; }
  const floor = Buffer.from(cursor, 'utf8');
  const paths = new Set(listed.split('\0').filter(path => path && Buffer.compare(Buffer.from(path, 'utf8'), floor) <= 0));
  return paths.size > UNINDEXED_REVISIT_CAP ? null : paths;
}

/** The stored results of these sources (sources with none are absent). */
export async function readUnindexedFiles(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds: string[]): Promise<Map<string, UnindexedRecord>> {
  if (!sourceIds.length) return new Map();
  const rows = await engine.executeRaw<{ record: UnindexedRecord }>('SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])',
    [UNINDEXED_FILES_OP, sourceIds]);
  return new Map(rows.map(row => [row.record.source_id, row.record]));
}

const addCounts = (a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a };
  for (const [code, n] of Object.entries(b)) out[code] = (out[code] ?? 0) + n;
  return out;
};

export interface UnindexedRefresh { scan: UnindexedScan; record: UnindexedRecord; scheduled: string[] }

/**
 * One bounded pass for one source: continues an incomplete stored result of the same incarnation (accumulating its counts),
 * schedules the found paths for a re-screen unless `schedule` is false, and stores the merged result.
 */
export async function refreshUnindexedFiles(engine: BrainEngine, sourceId: string, opts: Omit<UnindexedScanOpts, 'cursor'> & { schedule?: boolean } = {}): Promise<UnindexedRefresh> {
  const context = opts.context ?? await resolveManagedSyncContext(engine, { sourceId, noPull: true } as SyncOpts);
  const now = opts.now ?? Date.now;
  const stored = (await readUnindexedFiles(engine, [sourceId])).get(sourceId);
  const eligibility = await loadSyncEligibility(engine, context);
  const key = eligibilityKey(eligibility.scope, eligibility.slugMode, await syncExcludePatterns(engine));
  const resumable = stored && !stored.complete && stored.incarnation === context.incarnation && stored.cursor && stored.target && context.source.last_commit
    && stored.eligibility === key ? stored : null;
  const revisit = resumable && resumable.target !== context.source.last_commit
    ? changedBefore(context.gitRoot, resumable.target!, context.source.last_commit!, eligibility.scope, resumable.cursor!) : new Set<string>();
  const previous = revisit ? resumable : null;
  const scan = await findUnindexedFiles(engine, sourceId, { ...opts, context, cursor: previous?.cursor ?? null, ...(previous && revisit?.size ? { revisit } : {}) });
  const scheduled = opts.schedule === false ? [] : scan.files.filter(file => !file.slug_taken && !file.deleted_page).map(file => file.path);
  if (scheduled.length) await requestGitHoldRetry(engine, sourceId, context.incarnation, scheduled);
  // Paths the continuation re-examined drop their earlier verdict: one still missing is found again, one deleted or imported is not.
  const revisited = new Set([...(previous && revisit ? revisit : [])].map(path => eligibility.scope ? path.slice(eligibility.scope.length + 1) : path));
  const pending = [...new Set([...(previous?.pending ?? []).filter(path => !revisited.has(path)), ...scan.scheduled_paths, ...scheduled])];
  const { scope, slugMode } = eligibility;
  const at = new Date(now()).toISOString();
  const record: UnindexedRecord = {
    version: 1, source_id: sourceId, incarnation: context.incarnation, target: scan.target, eligibility: scan.eligibility, complete: scan.complete, cursor: scan.cursor,
    started_at: previous?.started_at ?? at, computed_at: at,
    scanned: (previous?.scanned ?? 0) + scan.scanned, unindexed: (previous?.unindexed ?? 0) + scan.unindexed, slug_taken: (previous?.slug_taken ?? 0) + scan.slug_taken,
    deleted_page: (previous?.deleted_page ?? 0) + scan.deleted_page,
    scheduled: (previous?.scheduled ?? 0) + scan.scheduled, by_code: addCounts(previous?.by_code ?? {}, scan.by_code),
    samples: [...(previous?.samples ?? []), ...scan.samples].slice(0, UNINDEXED_SAMPLE_LIMIT),
    metafile_skipped: (previous?.metafile_skipped ?? 0) + scan.metafile_skipped,
    metafile_samples: [...(previous?.metafile_samples ?? []), ...scan.metafile_samples].slice(0, UNINDEXED_SAMPLE_LIMIT),
    pending: pending.slice(0, UNINDEXED_SCHEDULE_CAP),
    pending_truncated: (previous?.pending_truncated ?? false) || pending.length > UNINDEXED_SCHEDULE_CAP || scan.scheduled_paths.length < scan.scheduled,
    scheduled_now: (previous?.scheduled_now ?? 0) + scheduled.length,
    source_prefix: slugMode === 'git-root' && scope ? `${scope}/` : '',
  };
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array($3::text::jsonb))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [UNINDEXED_FILES_OP, sourceId, JSON.stringify(record)]);
  return { scan, record, scheduled };
}

/** A stored result as doctor judges it now. */
export interface UnindexedState {
  source_id: string;
  record: UnindexedRecord | null;
  /** `missing`: no result for the current incarnation; `partial`: nothing found so far but the scan is incomplete. */
  state: 'ok' | 'unindexed' | 'scheduled' | 'partial' | 'stale' | 'missing';
  /** Found files no pass scheduled that a re-screen could import (not `slug_taken`, not `deleted_page`). */
  unscheduled: number;
  /** Found files a re-screen cannot import (`slug_taken` + `deleted_page`): a person renames, deletes or restores; never scheduled. */
  blocked: number;
  /** Scheduled paths the next sync has not re-screened yet and that still have no page and no hold. */
  waiting: number;
  /** Scheduled paths a sync re-screened that still have no page and no hold. */
  still_unindexed: number;
  age_ms: number | null;
}

/**
 * Judges each source's stored result without scanning: one page read plus one hold read over the scheduled paths says
 * whether each was imported or held, and of the rest its retry row says which still wait for a sync. A scheduled path
 * with a page or a hold is settled even while the retry row still names it (#7149: a sync pass that stops before its
 * stamp leaves the row behind after importing the path).
 */
export async function judgeUnindexedFiles(engine: Pick<BrainEngine, 'executeRaw'>, sources: Array<{ id: string; incarnation: string }>, now = Date.now()): Promise<UnindexedState[]> {
  const records = await readUnindexedFiles(engine, sources.map(source => source.id));
  const out: UnindexedState[] = [];
  for (const source of sources) {
    const record = records.get(source.id) ?? null;
    const base = { source_id: source.id, record, unscheduled: 0, blocked: 0, waiting: 0, still_unindexed: 0, age_ms: record ? Math.max(0, now - Date.parse(record.computed_at)) : null };
    if (!record || record.incarnation !== source.incarnation) { out.push({ ...base, state: 'missing' }); continue; }
    if (base.age_ms! > UNINDEXED_STALE_MS) { out.push({ ...base, state: 'stale' }); continue; }
    const blocked = (record.slug_taken ?? 0) + (record.deleted_page ?? 0);
    const unscheduled = Math.max(0, record.unindexed - blocked - record.scheduled_now);
    const retry = new Set(await readGitHoldRetryPaths(engine, source.id, source.incarnation));
    let open = record.pending;
    if (open.length) {
      const indexed = new Set((await engine.executeRaw<{ source_path: string }>(
        'SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path = ANY($2::text[])',
        [source.id, open.map(path => `${record.source_prefix}${path}`)])).map(page => page.source_path));
      const held = await heldGitPaths(engine, source.id, source.incarnation, open);
      open = open.filter(path => !indexed.has(`${record.source_prefix}${path}`) && !held.has(path));
    }
    const waiting = open.filter(path => retry.has(path)).length;
    const stillUnindexed = open.length - waiting;
    const state = unscheduled || stillUnindexed ? 'unindexed' : waiting ? 'scheduled' : record.complete && !record.pending_truncated ? 'ok' : 'partial';
    out.push({ ...base, state, unscheduled, blocked, waiting, still_unindexed: stillUnindexed });
  }
  return out;
}
