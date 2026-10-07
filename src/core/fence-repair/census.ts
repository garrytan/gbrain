/**
 * #6188 fence census: the source-scoped candidate finder for malformed facts
 * and takes fences, and the per-source counts `gbrain doctor`
 * (`fence_integrity`) reports. Discovery only; nothing here repairs.
 *
 * Three origins, deduplicated by page slug into one candidate:
 * - `hold`: an `invalid_fence` Git sync hold (the sync held the file).
 * - `page`: a stored page whose fences fail the coordinated fence step,
 *   found by an incremental scan (pages updated since the watermark) plus a
 *   one-time resumable keyset backfill over `pages.id`. The next pass starts
 *   at the previous pass's start minus every writer transaction still open
 *   then (`pg_stat_activity`) and a grace period, so a transaction that wrote
 *   `updated_at` before a pass and committed after it is still read.
 * - `file`: a working-tree file of a checkout-backed source, found by a
 *   resumable walk (a full first walk, then only files changed since the
 *   last walked commit, untracked files newer than it, mtime for non-Git
 *   sources, and every stored file candidate again). A deadline stops a walk
 *   between files; the next run resumes after the last judged path.
 *
 * Every finding is bound to the bytes it judged (sha256, page id and
 * `updated_at`, file mtime) and carries the planned tier, reason codes and a
 * location; never a cell value. A census is complete only when the backfill
 * is done, the incremental pass caught up and the walk finished; anything
 * less is `partial`, and a partial census never reads as healthy.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { parseMarkdown } from '../markdown.ts';
import { screenFenceCtx } from '../import-screen.ts';
import { collectGitVisibleFiles } from '../git-visible-files.ts';
import { isFrontmatterScannablePath, walkDir } from '../brain-writer.ts';
import { sha256 } from '../persistence/digest.ts';
import { readGitSourceHolds, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { FENCE_RULES_VERSION } from './normalize.ts';
import { FENCE_VERSION } from './refusal.ts';
import { FENCE_REASONS } from './reasons.ts';
import { fenceStep, pageHasFenceText } from './tier1.ts';
import {
  clearCandidateParts, readCandidateRecords, readScanRecord, upsertCandidatePart, writeScanRecord,
  type CandidateFinding, type CandidateLocation, type CandidateRecord, type FileFinding, type PageFinding, type ScanRecord,
} from './census-store.ts';
import type { FenceCtx, FencePage, FenceReason, FenceTier } from './types.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export const FENCE_TIERS: readonly FenceTier[] = ['deterministic', 'resolver', 'llm', 'manual'];
/** The fence rules a stored finding was judged with; a change restarts the scans. */
export const CENSUS_RULES = `${FENCE_VERSION}.${FENCE_RULES_VERSION}`;
/** Rows per DB scan batch. */
export const CENSUS_PAGE_BATCH = 500;
/** How far before the previous pass's start the next pass begins, besides the open writer transactions the database reports. */
export const LATE_COMMIT_GRACE_MS = 120_000;
/** Files judged between two cursor saves. */
const FILE_SAVE_EVERY = 200;
/** mtime slack for the non-Git watermark (coarse filesystem clocks). */
const MTIME_SKEW_MS = 2_000;

/** The tier that clears one reason: manual-only reasons and reasons whose tier depends on the page count as manual. */
export function reasonTier(reason: string): FenceTier {
  const spec = FENCE_REASONS[reason as FenceReason];
  if (!spec || spec.manualOnly) return 'manual';
  return spec.tier ?? 'manual';
}

const maxTier = (tiers: readonly FenceTier[]): FenceTier => tiers.reduce((worst, tier) => FENCE_TIERS.indexOf(tier) > FENCE_TIERS.indexOf(worst) ? tier : worst, 'deterministic');

/**
 * Judges one page's sections with the coordinated fence step (normalization
 * on): null when clean, `deterministic` when Tier 1 fixes it losslessly,
 * otherwise the highest tier its residual reasons need.
 */
export function judgeFences(page: FencePage, ctx: FenceCtx): Pick<CandidateFinding, 'tier' | 'reasons' | 'location'> | null {
  const step = fenceStep(page, ctx, { normalize: true });
  if (step.status === 'clean') return null;
  if (step.status === 'normalized') {
    const first = step.fixes[0]!;
    const same = step.fixes.filter(fix => fix.fence === first.fence && fix.section === first.section);
    return { tier: 'deterministic', reasons: [...new Set(step.fixes.map(fix => fix.class))],
      location: { fence: first.fence, section: first.section, rows: [...new Set(same.flatMap(fix => fix.row === null ? [] : [fix.row]))].slice(0, 20),
        columns: [...new Set(same.flatMap(fix => fix.column === null ? [] : [fix.column]))].slice(0, 20), line: first.line } };
  }
  const at = step.location;
  return { tier: maxTier(step.issues.map(issue => reasonTier(issue.reason))), reasons: [...new Set(step.issues.map(issue => issue.reason))],
    location: { fence: at.fence, section: at.section, rows: [...at.rows], columns: [...at.columns], line: at.line } };
}

interface CensusSource { id: string; incarnation: string; local_path: string | null }

async function censusSources(engine: Exec, sourceIds?: readonly string[]): Promise<CensusSource[]> {
  return engine.executeRaw<CensusSource>(`SELECT id, incarnation::text AS incarnation, local_path FROM sources
    WHERE archived IS NOT TRUE AND incarnation IS NOT NULL AND ($1::text[] IS NULL OR id=ANY($1::text[])) ORDER BY id`, [sourceIds ? [...sourceIds] : null]);
}

const hasCheckout = (source: CensusSource) => !!source.local_path && existsSync(source.local_path) && statSync(source.local_path).isDirectory();

/** Where the next incremental pass starts: this moment, or the start of the oldest writer transaction still open, minus the grace. */
async function passHorizon(engine: Exec, graceMs: number): Promise<string> {
  const grace = Math.max(0, Math.floor(graceMs));
  try {
    const [row] = await engine.executeRaw<{ at: string }>(`SELECT (LEAST(now(), COALESCE((SELECT min(xact_start) FROM pg_stat_activity
        WHERE datname=current_database() AND backend_xid IS NOT NULL AND pid<>pg_backend_pid()), now())) - ($1::int * interval '1 millisecond'))::text AS at`, [grace]);
    return row!.at;
  } catch {
    const [row] = await engine.executeRaw<{ at: string }>(`SELECT (now() - ($1::int * interval '1 millisecond'))::text AS at`, [grace]);
    return row!.at;
  }
}

interface PageRow {
  id: number; slug: string; type: string; frontmatter: Record<string, unknown> | null; source_path: string | null; content_hash: string | null;
  updated_at: string; live: boolean; compiled_truth: string | null; timeline: string | null;
}

const FENCED = (column: string) => `(strpos(${column},'gbrain:facts:')>0 OR strpos(${column},'gbrain:takes:')>0)`;
/** Page columns for judging; bodies only for live markdown pages that mention a fence marker. */
const PAGE_COLUMNS = `id, slug, type, frontmatter, source_path, content_hash, updated_at::text AS updated_at,
  (deleted_at IS NULL AND page_kind='markdown') AS live,
  CASE WHEN deleted_at IS NULL AND page_kind='markdown' AND (${FENCED('compiled_truth')} OR ${FENCED('timeline')}) THEN compiled_truth END AS compiled_truth,
  CASE WHEN deleted_at IS NULL AND page_kind='markdown' AND (${FENCED('compiled_truth')} OR ${FENCED('timeline')}) THEN timeline END AS timeline`;

/** Judges a batch of stored pages and stores what changed. */
async function judgePages(engine: Exec, source: CensusSource, rows: readonly PageRow[], at: string): Promise<void> {
  const clean: string[] = [];
  for (const row of rows) {
    const page = row.live && row.compiled_truth !== null ? { compiled_truth: row.compiled_truth, timeline: row.timeline ?? '' } : null;
    const verdict = page && pageHasFenceText(page) ? judgeFences(page, screenFenceCtx({ type: row.type as never, frontmatter: row.frontmatter ?? {} })) : null;
    if (!verdict) { clean.push(row.slug); continue; }
    const finding: PageFinding = { ...verdict, sha256: sha256(`${page!.compiled_truth}\u0000${page!.timeline}`), checked_at: at,
      page_id: Number(row.id), updated_at: row.updated_at, content_hash: row.content_hash, source_path: row.source_path };
    await upsertCandidatePart(engine, { sourceId: source.id, incarnation: source.incarnation, key: row.slug }, 'page', finding);
  }
  await clearCandidateParts(engine, { sourceId: source.id, incarnation: source.incarnation }, 'page', clean);
}

/**
 * One source's scan record while a census advances it. Nothing is stored for
 * a source with no stored record whose scan has read no page or file yet (an
 * empty brain stays empty, which engine graduation's target check relies on).
 */
interface ScanProgress { record: ScanRecord; kept: boolean; scanned: number; save(): Promise<void> }

/** Advances the backfill, then the incremental pass, until both are done or the deadline passes. Saves after every batch. */
async function scanPages(engine: Exec, source: CensusSource, progress: ScanProgress, opts: Required<Pick<CensusOptions, 'batchSize' | 'lateCommitGraceMs'>> & { deadline: number; now: () => Date }): Promise<boolean> {
  const pages = progress.record.pages;
  while (!pages.backfill.done) {
    if (opts.now().getTime() >= opts.deadline) return false;
    const rows = await engine.executeRaw<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE source_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
      [source.id, pages.backfill.after_id, opts.batchSize]);
    await judgePages(engine, source, rows, opts.now().toISOString());
    if (rows.length) pages.backfill.after_id = Number(rows[rows.length - 1]!.id);
    if (rows.length < opts.batchSize) Object.assign(pages.backfill, { done: true, completed_at: opts.now().toISOString() });
    progress.scanned += rows.length;
    await progress.save();
  }
  for (;;) {
    if (opts.now().getTime() >= opts.deadline) return false;
    pages.pass ??= { lower: pages.watermark ?? await passHorizon(engine, opts.lateCommitGraceMs), next: await passHorizon(engine, opts.lateCommitGraceMs), after: null };
    const pass = pages.pass;
    const rows = await engine.executeRaw<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE source_id=$1 AND updated_at>=$2::timestamptz
      AND ($3::timestamptz IS NULL OR (updated_at, id) > ($3::timestamptz, $4::int)) ORDER BY updated_at, id LIMIT $5`,
    [source.id, pass.lower, pass.after?.at ?? null, pass.after?.id ?? 0, opts.batchSize]);
    await judgePages(engine, source, rows, opts.now().toISOString());
    if (rows.length) pass.after = { at: rows[rows.length - 1]!.updated_at, id: Number(rows[rows.length - 1]!.id) };
    const caughtUp = rows.length < opts.batchSize;
    if (caughtUp) { pages.watermark = pass.next; pages.pass = null; }
    progress.scanned += rows.length;
    await progress.save();
    if (caughtUp) return true;
  }
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const gitHead = (root: string) => git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null;
const nulList = (out: string) => out.split('\0').filter(Boolean).map(path => path.replace(/\\/g, '/'));

/** Every file the walk judges, source-root relative and sorted (Git-visible files in a checkout, else a pruned walk). */
function eligibleFiles(root: string): string[] {
  const git = collectGitVisibleFiles(root, isFrontmatterScannablePath);
  const absolute: string[] = git ?? [];
  if (!git) walkDir(root, path => { absolute.push(path); });
  return [...new Set(absolute.map(path => relative(root, path).replace(/\\/g, '/')).filter(isFrontmatterScannablePath))].sort();
}

const mtimeMs = (path: string): number | null => { try { return lstatSync(path).mtimeMs; } catch { return null; } };

/**
 * Files a `changed` pass judges: what changed since the last walked commit
 * (committed, staged or edited), untracked files newer than the last walk
 * (mtime for non-Git sources), and every stored file candidate. Null when
 * the walked commit is gone, so the caller walks everything again.
 */
function changedFiles(root: string, walked: NonNullable<ScanRecord['files']>['walked'] & object, stored: readonly string[]): string[] | null {
  const since = Date.parse(walked.at) - MTIME_SKEW_MS;
  const fresh = (rel: string) => (mtimeMs(join(root, rel)) ?? Infinity) >= since;
  let paths: string[];
  if (walked.commit) {
    const diff = git(root, ['diff', '--name-only', '--relative', '--no-renames', '-z', walked.commit]);
    if (diff === null) return null;
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '';
    paths = [...nulList(diff), ...nulList(untracked).filter(fresh)];
  } else {
    paths = eligibleFiles(root).filter(fresh);
  }
  return [...new Set([...paths, ...stored])].filter(isFrontmatterScannablePath).sort();
}

/** Judges one working-tree file: its page slug and finding, or null when it is clean or unreadable (gone). */
function judgeFile(root: string, rel: string, at: string): { key: string | null; finding: FileFinding | null } {
  const path = join(root, rel);
  let content: string;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
    if (!stat.isFile()) return { key: null, finding: null };
    content = readFileSync(path, 'utf8');
  } catch {
    return { key: null, finding: null };
  }
  if (!content.includes('gbrain:facts:') && !content.includes('gbrain:takes:')) return { key: null, finding: null };
  const parsed = parseMarkdown(content, rel);
  const verdict = judgeFences(parsed, screenFenceCtx(parsed));
  return { key: parsed.slug, finding: verdict ? { ...verdict, sha256: sha256(content), checked_at: at, path: rel, mtime_ms: Math.floor(stat.mtimeMs) } : null };
}

/** Advances the working-tree walk until it finishes or the deadline passes. */
async function scanFiles(engine: Exec, source: CensusSource, progress: ScanProgress, stored: Map<string, string>, opts: { deadline: number; now: () => Date }): Promise<boolean> {
  const root = resolve(source.local_path!);
  const files = progress.record.files ??= { pass: null, walked: null };
  const changed = files.walked && files.pass?.mode !== 'full' ? changedFiles(root, files.walked, [...stored.keys()]) : null;
  files.pass ??= { mode: changed ? 'changed' : 'full', after: null, started_at: opts.now().toISOString(), commit: gitHead(root) };
  const pass = files.pass;
  if (pass.mode === 'changed' && !changed) pass.mode = 'full';
  const list = pass.mode === 'changed' ? changed! : eligibleFiles(root);
  const ids = { sourceId: source.id, incarnation: source.incarnation };
  let since = 0;
  for (const rel of list) {
    if (pass.after !== null && rel <= pass.after) continue;
    if (opts.now().getTime() >= opts.deadline) { await progress.save(); return false; }
    const { key, finding } = judgeFile(root, rel, opts.now().toISOString());
    const previous = stored.get(rel);
    if (previous !== undefined && previous !== key) await clearCandidateParts(engine, ids, 'file', [previous]);
    if (key !== null && finding) { await upsertCandidatePart(engine, { ...ids, key }, 'file', finding); stored.set(rel, key); }
    else { if (key !== null) await clearCandidateParts(engine, ids, 'file', [key]); stored.delete(rel); }
    pass.after = rel;
    progress.scanned++;
    if (++since >= FILE_SAVE_EVERY) { since = 0; await progress.save(); }
  }
  files.walked = { commit: pass.commit, at: pass.started_at };
  files.pass = null;
  await progress.save();
  return true;
}

export interface CensusOptions {
  sourceIds?: readonly string[];
  /** Epoch ms (on the `now` clock) after which no new batch or file starts. */
  deadline: number;
  /** The clock for deadlines and timestamps (default: the wall clock). */
  now?: () => Date;
  batchSize?: number;
  lateCommitGraceMs?: number;
}

export interface CensusRun { source_id: string; complete: boolean; fresh_at: string | null; backfill_done: boolean; pages_caught_up: boolean; files: 'none' | 'done' | 'partial' }

function freshRecord(source: CensusSource, at: string): ScanRecord {
  return { version: 1, source_id: source.id, incarnation: source.incarnation, rules: CENSUS_RULES,
    pages: { watermark: null, pass: null, backfill: { after_id: 0, done: false, started_at: at } }, files: null,
    census: { complete: false, fresh_at: null, checked_at: at } };
}

/**
 * Advances every scoped source's census until it is complete or the deadline
 * passes, persisting each cursor as it goes. Safe to run from several
 * processes: a finding is rewritten from current bytes either way.
 */
export async function runFenceCensus(engine: Exec, opts: CensusOptions): Promise<CensusRun[]> {
  const now = opts.now ?? (() => new Date());
  const tuning = { batchSize: opts.batchSize ?? CENSUS_PAGE_BATCH, lateCommitGraceMs: opts.lateCommitGraceMs ?? LATE_COMMIT_GRACE_MS, now };
  const runs: CensusRun[] = [];
  const records = await readCandidateRecords(engine, opts.sourceIds);
  const sources = await censusSources(engine, opts.sourceIds);
  for (const [index, source] of sources.entries()) {
    // Each source gets an even share of what is left, so one large source cannot starve the others.
    const started = now().getTime();
    const deadline = Math.min(opts.deadline, started + Math.max(0, opts.deadline - started) / (sources.length - index));
    const checkout = hasCheckout(source);
    const stored = await readScanRecord(engine, source.id, source.incarnation);
    const kept = !!stored && stored.rules === CENSUS_RULES;
    const progress: ScanProgress = { record: kept ? stored! : freshRecord(source, now().toISOString()), kept, scanned: 0,
      async save() { if (this.kept || this.scanned > 0) await writeScanRecord(engine, this.record); } };
    const record = progress.record;
    // The first pass starts where the backfill starts, so a page updated during the backfill is read again.
    record.pages.watermark ??= await passHorizon(engine, tuning.lateCommitGraceMs);
    // With a checkout, the stored pages get half of the share first; the walk gets the rest.
    const caughtUp = await scanPages(engine, source, progress, { ...tuning, deadline: checkout ? started + (deadline - started) / 2 : deadline });
    const storedFiles = new Map(records.filter(r => r.source_id === source.id && r.incarnation === source.incarnation && r.file).map(r => [r.file!.path, r.key]));
    const walked = checkout ? await scanFiles(engine, source, progress, storedFiles, { deadline, now }) : false;
    const pagesDone = caughtUp || await scanPages(engine, source, progress, { ...tuning, deadline });
    const complete = record.pages.backfill.done && pagesDone && (!checkout || walked);
    record.census = { complete, fresh_at: complete ? now().toISOString() : record.census.fresh_at, checked_at: now().toISOString() };
    await progress.save();
    runs.push({ source_id: source.id, complete, fresh_at: record.census.fresh_at, backfill_done: record.pages.backfill.done, pages_caught_up: pagesDone,
      files: !checkout ? 'none' : walked ? 'done' : 'partial' });
  }
  return runs;
}

export type CandidateOrigin = 'hold' | 'page' | 'file';

/** One deduplicated candidate: every origin that names the page, the bucket that counts it, its planned tier and what binds it. */
export interface FenceCandidate {
  source_id: string;
  /** The page slug (or `path:<file>` for a held file with no slug). */
  key: string;
  path: string | null;
  page_id: number | null;
  origins: CandidateOrigin[];
  /** Counted once: a hold first, then a malformed stored page, then an unsynced file. */
  bucket: CandidateOrigin;
  tier: FenceTier;
  reasons: string[];
  location: CandidateLocation | null;
  bound: { page_sha256?: string; updated_at?: string; content_hash?: string | null; file_sha256?: string; file_mtime_ms?: number; upstream_version?: string | null };
  held_since?: string;
}

function holdTier(hold: GitHoldRecord, file: FileFinding | undefined): FenceTier {
  if (file) return file.tier;
  return reasonTier(hold.meta.fence?.reason ?? hold.meta.reason ?? 'unparseable');
}

/** Every candidate of the scoped sources, deduplicated across holds, stored pages and files. */
export async function listFenceCandidates(engine: Exec, sourceIds?: readonly string[]): Promise<FenceCandidate[]> {
  const records = await readCandidateRecords(engine, sourceIds);
  const pageIds = records.flatMap(r => r.page ? [r.page.page_id] : []);
  const live = new Set((pageIds.length ? await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE id=ANY($1::int[]) AND deleted_at IS NULL', [pageIds]) : [])
    .map(row => Number(row.id)));
  const out = new Map<string, FenceCandidate>();
  const byPath = new Map<string, FenceCandidate>();
  const key = (sourceId: string, k: string) => `${sourceId}\u0000${k}`;
  for (const record of records) {
    const page = record.page && live.has(record.page.page_id) ? record.page : undefined;
    const file = record.file;
    if (!page && !file) continue;
    const primary = (page ?? file)!;
    const candidate: FenceCandidate = { source_id: record.source_id, key: record.key, path: file?.path ?? page?.source_path ?? null, page_id: page?.page_id ?? null,
      origins: [...(page ? ['page' as const] : []), ...(file ? ['file' as const] : [])], bucket: page ? 'page' : 'file', tier: primary.tier,
      reasons: [...new Set([...(page?.reasons ?? []), ...(file?.reasons ?? [])])], location: primary.location,
      bound: { ...(page ? { page_sha256: page.sha256, updated_at: page.updated_at, content_hash: page.content_hash } : {}),
        ...(file ? { file_sha256: file.sha256, file_mtime_ms: file.mtime_ms } : {}) } };
    out.set(key(record.source_id, record.key), candidate);
    if (file) byPath.set(key(record.source_id, file.path), candidate);
  }
  const fileOf = (record: CandidateRecord | undefined) => record?.file;
  const recordsByKey = new Map(records.map(r => [key(r.source_id, r.key), r]));
  for (const source of await readGitSourceHolds(engine, sourceIds ? { sourceIds: [...sourceIds] } : {})) {
    for (const hold of source.holds) {
      if (hold.code !== 'invalid_fence') continue;
      const existing = (hold.slug ? out.get(key(hold.source_id, hold.slug)) : undefined) ?? byPath.get(key(hold.source_id, hold.path));
      const file = existing ? fileOf(recordsByKey.get(key(existing.source_id, existing.key))) : undefined;
      const tier = holdTier(hold, file?.path === hold.path ? file : undefined);
      const reason = hold.meta.fence?.reason ?? hold.meta.reason;
      if (existing) {
        Object.assign(existing, { origins: ['hold', ...existing.origins], bucket: 'hold', tier, path: hold.path, held_since: hold.held_at,
          reasons: [...new Set([...(reason ? [reason] : []), ...existing.reasons])], location: existing.location ?? holdLocation(hold),
          bound: { ...existing.bound, upstream_version: hold.upstream_version } });
        continue;
      }
      const candidate: FenceCandidate = { source_id: hold.source_id, key: hold.slug ?? `path:${hold.path}`, path: hold.path, page_id: hold.page_id, origins: ['hold'],
        bucket: 'hold', tier, reasons: reason ? [reason] : [], location: holdLocation(hold), bound: { upstream_version: hold.upstream_version }, held_since: hold.held_at };
      out.set(key(hold.source_id, candidate.key), candidate);
    }
  }
  return [...out.values()].sort((a, b) => a.source_id.localeCompare(b.source_id) || a.key.localeCompare(b.key));
}

function holdLocation(hold: GitHoldRecord): CandidateLocation | null {
  const at = hold.meta.fence;
  return at ? { fence: at.fence, section: at.section, rows: [...at.rows], columns: [...at.columns], line: at.line } : null;
}

export type TierCounts = Record<FenceTier, number> & { total: number };
const zero = (): TierCounts => ({ deterministic: 0, resolver: 0, llm: 0, manual: 0, total: 0 });

export interface SourceCensus {
  source_id: string;
  total: number;
  holds: TierCounts;
  pages: TierCounts;
  files: TierCounts;
  by_tier: TierCounts;
  oldest_hold_at: string | null;
  /** Up to five candidates, location only. */
  sample: Array<Pick<FenceCandidate, 'key' | 'path' | 'bucket' | 'tier' | 'reasons'>>;
  scan: { complete: boolean; fresh_at: string | null; checked_at: string | null; backfill_done: boolean; walking: boolean };
}

/**
 * Per-source counts by bucket and planned tier, with the scan state (sources
 * with nothing found are included). `runs`, from the census that just ran,
 * overrides the stored state, so a source whose scan stored nothing still
 * reads complete.
 */
export async function summarizeFenceCensus(engine: Exec, sourceIds?: readonly string[], runs: readonly CensusRun[] = []): Promise<SourceCensus[]> {
  const sources = await censusSources(engine, sourceIds);
  const candidates = await listFenceCandidates(engine, sources.map(source => source.id));
  const out: SourceCensus[] = [];
  for (const source of sources) {
    const record = await readScanRecord(engine, source.id, source.incarnation);
    const current = record?.rules === CENSUS_RULES ? record : null;
    const run = runs.find(r => r.source_id === source.id);
    const mine = candidates.filter(c => c.source_id === source.id);
    const census: SourceCensus = { source_id: source.id, total: mine.length, holds: zero(), pages: zero(), files: zero(), by_tier: zero(), oldest_hold_at: null,
      sample: mine.slice(0, 5).map(c => ({ key: c.key, path: c.path, bucket: c.bucket, tier: c.tier, reasons: c.reasons })),
      scan: { complete: run?.complete ?? current?.census.complete ?? false, fresh_at: run?.fresh_at ?? current?.census.fresh_at ?? null,
        checked_at: current?.census.checked_at ?? run?.fresh_at ?? null, backfill_done: run?.backfill_done ?? current?.pages.backfill.done ?? false,
        walking: !!current?.files?.pass } };
    for (const candidate of mine) {
      const bucket = candidate.bucket === 'hold' ? census.holds : candidate.bucket === 'page' ? census.pages : census.files;
      bucket[candidate.tier]++; bucket.total++;
      census.by_tier[candidate.tier]++; census.by_tier.total++;
      if (candidate.held_since && (!census.oldest_hold_at || candidate.held_since < census.oldest_hold_at)) census.oldest_hold_at = candidate.held_since;
    }
    out.push(census);
  }
  return out;
}
