/**
 * #5988: the managed sync content screen. A frozen import entry the shared
 * sync screen (`screenSyncImport`) would refuse is held instead of admitted:
 * the caller writes the hold and advances the cursor in one transaction. A
 * pinned Git blob over the sync read bound is held by its size before its
 * content is loaded. `sync_parser_regression` stops the run only when the
 * page's import provenance proves the exact bytes imported validated before.
 * Dry runs screen every pending import read-only with batched Git reads.
 * #6188: the screen runs with `fences: 'coordinated'` (see `screenSyncImport`):
 * a fence Tier 1 rewrites losslessly is admitted (publication commits the
 * normalized file; a dry run lists it in `would_normalize`), and a residual
 * fence is held as `invalid_fence`.
 */
import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { loadImportSanityConfig, screenNormalized, type ImportSanityConfig } from '../import-screen.ts';
import { fencesNormalizeEnabled } from '../fence-repair/config.ts';
import type { FenceFix } from '../fence-repair/types.ts';
import { parseMarkdown, RECOVERY_VERSION } from '../markdown.ts';
import { fenceMessage, type FenceMessageLocation } from '../fence-repair/reasons.ts';
import { completeFenceLocation, FENCE_VERSION, type ReceiptFenceLocation } from '../fence-repair/refusal.ts';
import { fenceFileLine } from '../fence-repair/hold-fix.ts';
import { slugConflictHoldMessage } from '../import-file.ts';
import { isImageFilePath, resolveSlugForPath } from '../sync.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { VERSION } from '../../version.ts';
import { sha256 } from './digest.ts';
import { readPagePurgeTombstones } from './page-purge.ts';
import { readSyncContent, readSyncFile, syncGitPath, type SyncDiscovery, type SyncEntry } from './sync-discovery.ts';
import { PINNED_WINDOW, readBlobContents, readPinnedBlob, readPinnedContent, readTreeBlobs, SYNC_READ_BOUND, type TreeBlob } from './sync-blobs.ts';
import { screenSyncImport, type SyncImportScreenInput } from './sync-prepare.ts';
import type { SyncProcessingOptions } from './sync-authority.ts';
import { gitHoldItem, readSyncHoldPolicy, readSyncImportProvenance, type GitHoldItem, type GitHoldRecord, type PreparationStallMeta, type SyncHoldPolicy } from './sync-holds.ts';
import type { WriteRequest } from './model.ts';

type Snapshot = Awaited<ReturnType<BrainEngine['readPageSnapshot']>>;
export type HeldEntry = Pick<GitHoldRecord, 'path' | 'source_path' | 'slug' | 'page_id' | 'code' | 'message' | 'upstream_version' | 'meta'>;

/**
 * Per-run screen state; null when `sync.holds=fail` restores fail-closed
 * blocking. `normalize` reads `fences.normalize` once, the first time a file
 * has a fence Tier 1 would rewrite (#6188).
 */
export interface SyncScreenRun { policy: SyncHoldPolicy; sanity: ImportSanityConfig; activePack: SyncImportScreenInput['activePack']; normalize: () => Promise<boolean> }

export async function loadSyncScreenRun(engine: BrainEngine, sourceId: string, processingOptions: SyncProcessingOptions | undefined, remote: boolean): Promise<SyncScreenRun | null> {
  const policy = await readSyncHoldPolicy(engine);
  if (policy.mode === 'fail') return null;
  const activePack = processingOptions?.noSchemaPack ? undefined : (await loadActivePackForEngine(engine, { remote, sourceId }).catch(() => null))?.manifest;
  let normalize: Promise<boolean> | undefined;
  return { policy, sanity: await loadImportSanityConfig(engine), activePack, normalize: () => normalize ??= fencesNormalizeEnabled(engine) };
}

/** True for `readSyncFile`'s refusal of a working-tree file over the sync read bound. */
export function isSyncReadBound(error: unknown): boolean {
  return error instanceof OperationError && error.code === 'request_too_large' && error.message === 'Sync file exceeds the bounded import size.';
}

type PinnedCursor = Pick<SyncDiscovery, 'root' | 'gitRoot' | 'target' | 'entries'> & { index: number };

/** Git paths of the committed imports from the cursor's entry on: the window one pinned read lists. */
function upcomingGitPaths(cursor: PinnedCursor): () => string[] {
  return () => {
    const gitRoot = realpathSync.native(cursor.gitRoot), root = realpathSync.native(cursor.root);
    return cursor.entries.slice(cursor.index, cursor.index + PINNED_WINDOW).filter(entry => entry.action === 'import' && !entry.working)
      .map(entry => relative(gitRoot, resolve(root, entry.path)).split(sep).join('/'));
  };
}

/** The pinned blob of one entry, or null when the commit lacks it; read with the entries after it (`readPinnedBlob`). */
export function pinnedBlob(cursor: PinnedCursor, path: string): TreeBlob | null {
  return readPinnedBlob(cursor.gitRoot, cursor.target, syncGitPath(cursor, path), upcomingGitPaths(cursor));
}

/** The frozen import content of one entry (`readSyncContent`); a committed entry's pinned blob is read with the entries after it. */
export function pinnedContent(cursor: SyncDiscovery & { index: number }, entry: SyncEntry): string {
  const content = entry.working ? null : readPinnedContent(cursor.gitRoot, cursor.target, syncGitPath(cursor, entry.path), upcomingGitPaths(cursor));
  return content ?? readSyncContent(cursor, entry);
}

function heldEntry(entry: Pick<SyncEntry, 'path' | 'sourcePath' | 'working' | 'renameFrom' | 'renameHeld'>, slug: string, pageId: number | null,
  refusal: { code: GitHoldRecord['code']; reason?: GitHoldRecord['meta']['reason']; key?: string; line?: number; message: string; fence?: FenceMessageLocation },
  content: string | null, blob: Pick<TreeBlob, 'oid'> | null | undefined): HeldEntry {
  const line = refusal.line ?? (refusal.fence && content !== null ? fenceFileLine(content, parseMarkdown(content, entry.path), refusal.fence) ?? undefined : undefined);
  return { path: entry.path, source_path: entry.sourcePath, slug, page_id: pageId, code: refusal.code, message: refusal.message,
    upstream_version: content === null ? null : sha256(content),
    meta: { ...(refusal.reason ? { reason: refusal.reason } : {}), ...(refusal.key ? { key: refusal.key } : {}), ...(line !== undefined ? { line } : {}),
      recovery_version: RECOVERY_VERSION, ...(refusal.fence ? { fence: refusal.fence, fence_version: FENCE_VERSION } : {}),
      ...(blob ? { blob_oid: blob.oid } : {}), ...(entry.working ? { working: true } : {}),
      ...(entry.renameFrom ?? entry.renameHeld ? { rename_from: entry.renameFrom ?? entry.renameHeld } : {}) } };
}

/**
 * #6188: the hold a failed fence refusal earns when the screen admitted the
 * same bytes (the refusal depended on stored rows: a stored-row collision, a
 * withdrawn claim, rows quoted in code). Reason `prepare_time`; the receipt's
 * own reason stays in `meta.fence`. Location-only, rebuilt from the receipt.
 */
export function prepareTimeFenceHold(entry: Pick<SyncEntry, 'path' | 'sourcePath' | 'working' | 'renameFrom' | 'renameHeld'>, slug: string, pageId: number | null,
  receipt: ReceiptFenceLocation, content: string, blobOid: string | null | undefined): HeldEntry {
  // An older gbrain's receipt named no section: take it from the refused bytes themselves.
  const fence = completeFenceLocation(receipt, parseMarkdown(content, `${slug}.md`));
  return heldEntry(entry, slug, pageId, { code: 'invalid_fence', reason: 'prepare_time', fence, message: fenceMessage(fence) }, content, blobOid ? { oid: blobOid } : null);
}

/** #6278: the receipt fields a `preparation_stalled` hold keeps (the owner's step vocabulary only, never content). */
export function preparationStallMeta(receipt: Pick<WriteRequest, 'request_id' | 'error_detail'>, syncArgv: string[]): PreparationStallMeta {
  const detail = receipt.error_detail && typeof receipt.error_detail === 'object' ? receipt.error_detail as Record<string, unknown> : {};
  const waiting = detail.waiting_on;
  return { request_id: receipt.request_id, step: typeof detail.step === 'string' ? detail.step.slice(0, 64) : null,
    waiting_on: typeof waiting === 'string' && ['git', 'fs', 'db', 'pool', 'unknown'].includes(waiting) ? waiting as PreparationStallMeta['waiting_on'] : null,
    attempts: typeof detail.attempts === 'number' && Number.isFinite(detail.attempts) ? detail.attempts : null, gbrain_version: VERSION, sync_argv: syncArgv };
}

/**
 * #6278: the hold a `managed_sync_import` or `managed_sync_delete` member earns
 * when its owner finished it `failed` with `preparation_stalled` (the
 * preparation never settled within its attempts). The file is not the
 * problem, so the hold carries the receipt's step and wait cause and routes
 * to writer status, then `sources retry-held` and the same sync. A delete
 * hold has no content (`upstream_version` null) and is marked `deleted`, so
 * discovery leaves it alone until a retry or a gbrain change.
 */
export function preparationStalledHold(entry: Pick<SyncEntry, 'path' | 'sourcePath' | 'working' | 'renameFrom' | 'renameHeld' | 'action'>, slug: string, pageId: number | null,
  receipt: Pick<WriteRequest, 'request_id' | 'error_detail'>, content: string | null, blobOid: string | null | undefined, syncArgv: string[]): HeldEntry {
  const stall = preparationStallMeta(receipt, syncArgv);
  const where = stall.step ? ` at step ${stall.step}` : '';
  const held = heldEntry(entry, slug, pageId, { code: 'preparation_stalled',
    message: `${entry.path}: its ${entry.action === 'delete' ? 'deletion' : 'import'} could not finish preparing${where} (request ${receipt.request_id}), so it is held and the rest of the source synced. `
      + `Inspect the writer with gbrain sources writer status, then gbrain sources retry-held and the same sync.` }, content, blobOid ? { oid: blobOid } : null);
  return { ...held, meta: { ...held.meta, stall, ...(entry.action === 'delete' ? { deleted: true as const } : {}) } };
}

/**
 * #5493: managed sync has no image importer, so an image import is held as
 * incomplete coverage instead of refusing the run. The hold names the pinned
 * blob (or the working-tree bytes), so discovery re-screens it when the file
 * changes, leaves the source, or `sources retry-held` asks.
 */
export function managedImageHold(entry: SyncEntry, content: string | null, blob: TreeBlob | null | undefined): HeldEntry {
  return heldEntry(entry, entry.slug!, entry.pageId ?? null, { code: 'managed_image_sync_unsupported',
    message: `${entry.path} is an image, which managed sync does not import yet; the rest of the source synced.` }, content, blob);
}

const purgeTombstonesByRun = new WeakMap<SyncScreenRun, Promise<Map<string, string>>>();
/** #5575: one tombstone read per sync run; a run screens one source. */
function runPurgeTombstones(engine: BrainEngine, run: SyncScreenRun, sourceId: string): Promise<Map<string, string>> {
  let read = purgeTombstonesByRun.get(run);
  if (!read) { read = readPagePurgeTombstones(engine, sourceId); purgeTombstonesByRun.set(run, read); }
  return read;
}

export interface FrozenImportScreen {
  cursor: Pick<SyncDiscovery, 'sourceId' | 'incarnation' | 'root'>;
  entry: SyncEntry; slug: string; pageId: number | null; snapshot: Snapshot;
  /** null only for an over-size file, whose content is never read. */
  content: string | null; rawHash: string | null; lineEndingOnly: boolean;
  blob?: TreeBlob | null; oversize?: { size: number | null };
  /** The `--retry-failed` command that resumes after a parser-regression fix. */
  retryCommand: string;
  /** #6188 dry run: told the fixes when Tier 1 admits the file by rewriting a fence. */
  onNormalized?: (fixes: FenceFix[]) => void;
}

/**
 * The hold a frozen import earns, or null to admit it. Throws
 * `sync_parser_regression` (policy `stop`) when gbrain would hold bytes the
 * page's provenance says a validating gbrain imported.
 */
export async function screenFrozenImport(engine: BrainEngine, input: FrozenImportScreen, run: SyncScreenRun): Promise<HeldEntry | null> {
  const { entry, slug, pageId, snapshot, content, blob } = input;
  if (input.oversize || content === null) {
    const size = input.oversize?.size ?? blob?.size ?? null;
    return heldEntry(entry, slug, pageId, { code: 'file_too_large',
      message: `File too large (${size ?? 'over 10485760'} bytes; the sync read bound is ${SYNC_READ_BOUND} bytes). Split the content into smaller files or leave it out of the source.` }, null, blob);
  }
  if (entry.renameHeld) {
    return heldEntry(entry, slug, pageId, { code: 'rename_held', reason: 'rename_source_changed', message: `${entry.path} is a rename of page ${entry.renameHeld.slug}, which changed after the rename was recorded, so the page was not moved.` }, content, blob);
  }
  const moved = entry.renameFrom && entry.renameFrom.slug !== slug ? entry.renameFrom : undefined;
  const base = moved ? await engine.readPageSnapshot(moved.slug, { sourceId: input.cursor.sourceId, includeDeleted: true }) : snapshot;
  const screenInput: SyncImportScreenInput = { content, rawHash: input.rawHash, lineEndingOnly: input.lineEndingOnly, slug, sourcePath: entry.sourcePath, path: entry.path,
    root: input.cursor.root, snapshot, base, renamed: !!moved, activePack: run.activePack, sanity: run.sanity,
    purgedPages: await runPurgeTombstones(engine, run, input.cursor.sourceId) };
  let { screen } = screenSyncImport(screenInput);
  // #6188: a fence Tier 1 rewrites is admitted (publication writes the normalized file back); with fences.normalize=false it is held.
  if (screenNormalized(screen) && !await run.normalize()) ({ screen } = screenSyncImport({ ...screenInput, normalize: false }));
  if (screen.status === 'importable' && screen.fences?.fixes.length) input.onNormalized?.(screen.fences.fixes);
  if (screen.status !== 'refused') return null;
  const refusal = screen.refusal;
  if (refusal.code === 'invalid_frontmatter' && snapshot && snapshot.page.deleted_at == null) {
    const provenance = await readSyncImportProvenance(engine, input.cursor.sourceId, input.cursor.incarnation, snapshot.page.id);
    if (provenance?.validated === true && provenance.raw_sha256 === sha256(content) && provenance.origin === entry.sourcePath) {
      const why = `gbrain ${VERSION} refuses ${entry.path} (${refusal.reason ?? 'yaml_parse'}${refusal.line !== undefined ? `, line ${refusal.line}` : ''}), but gbrain ${provenance.gbrain_version} imported these exact bytes and validated them.`;
      if (run.policy.parserRegression === 'hold') return heldEntry(entry, slug, pageId, { code: 'parser_regression', message: `${why} Held under sync.parser_regression=hold.` }, content, blob);
      throw opError('sync_parser_regression', `Sync stopped: ${why}`,
        `This is a gbrain bug. Report it with the gbrain version (${VERSION}), the file (${entry.path}) and the code (${refusal.code}${refusal.reason ? `/${refusal.reason}` : ''}). `
          + `Upgrade, or pin the last good version (${provenance.gbrain_version}), then run: ${input.retryCommand}. To hold such files and let the rest sync meanwhile, the user can set sync.parser_regression=hold.`,
        { fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Collects the gbrain version and brain health to attach to the bug report; the sync checkpoint did not advance past this file.' } });
    }
  }
  // The stored hold names the path-derived slug only, never the declared frontmatter value.
  return heldEntry(entry, slug, pageId, refusal.code === 'frontmatter_slug_conflict'
    ? { ...refusal, message: slugConflictHoldMessage(entry.path, resolveSlugForPath(entry.sourcePath)) } : refusal, content, blob);
}

/**
 * Dry run: screens every pending import entry read-only (batched Git reads)
 * and lists the holds a real run would record. Entries the screen cannot
 * judge are reported in `screen_skipped`, never as holds.
 */
export async function dryRunScreen(engine: BrainEngine, discovery: SyncDiscovery & { index?: number }, run: SyncScreenRun | null, retryCommand: string): Promise<{
  dry_run: true; would_hold?: GitHoldItem[]; would_hold_count?: number; would_normalize?: Array<{ path: string; classes: string[] }>; would_normalize_count?: number;
  screen_skipped?: Array<{ path: string; code: string }> }> {
  if (!run || discovery.companyPlan) return { dry_run: true };
  const entries = discovery.entries.slice(discovery.index ?? 0).filter(entry => entry.action === 'import' && entry.slug);
  const committed = entries.filter(entry => !entry.working);
  const blobs = readTreeBlobs(discovery.gitRoot, discovery.target, committed.map(entry => syncGitPath(discovery, entry.path)));
  const contents = readBlobContents(discovery.gitRoot, [...blobs.values()]);
  const held: GitHoldItem[] = [];
  const normalized: Array<{ path: string; classes: string[] }> = [];
  const skipped: Array<{ path: string; code: string }> = [];
  const observed = new Date().toISOString();
  for (const entry of entries) {
    try {
      const blob = entry.working ? null : blobs.get(syncGitPath(discovery, entry.path)) ?? null;
      if (isImageFilePath(entry.path)) {
        const hold = managedImageHold(entry, blob ? null : readSyncFile(discovery.root, entry.path)?.toString('utf8') ?? null, blob);
        held.push(gitHoldItem({ version: 1, source_id: discovery.sourceId, incarnation: discovery.incarnation, ...hold,
          observed_at: observed, held_at: observed, updated_at: observed, run_id: null, mode: 'managed' }));
        continue;
      }
      let bytes: Buffer | null = null, oversize: { size: number | null } | undefined;
      try { bytes = readSyncFile(discovery.root, entry.path); } catch (error) { if (!isSyncReadBound(error)) throw error; oversize = { size: null }; }
      if (blob && blob.size > SYNC_READ_BOUND) oversize = { size: blob.size };
      const content = oversize ? null : entry.working ? bytes?.toString('utf8') ?? null : blob ? contents.get(blob.oid) ?? null : null;
      if (!oversize && content === null) { skipped.push({ path: entry.path, code: 'source_changed' }); continue; }
      const snapshot = await engine.readPageSnapshot(entry.slug!, { sourceId: discovery.sourceId, includeDeleted: true });
      const lineEndingOnly = bytes !== null && content !== null && bytes.equals(Buffer.from(bytes.toString('utf8'))) && bytes.toString('utf8').replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n');
      const hold = await screenFrozenImport(engine, { cursor: discovery, entry, slug: entry.slug!, pageId: entry.pageId ?? null, snapshot, content,
        rawHash: bytes === null ? null : sha256(bytes), lineEndingOnly, blob, oversize, retryCommand,
        onNormalized: fixes => normalized.push({ path: entry.path, classes: [...new Set(fixes.map(fix => fix.class))] }) }, run);
      if (hold) held.push(gitHoldItem({ version: 1, source_id: discovery.sourceId, incarnation: discovery.incarnation, ...hold,
        observed_at: observed, held_at: observed, updated_at: observed, run_id: null, mode: 'managed' }));
    } catch (error) {
      skipped.push({ path: entry.path, code: error instanceof OperationError ? error.code : 'storage_error' });
    }
  }
  return { dry_run: true, ...(held.length ? { would_hold: held.slice(0, run.policy.cap), would_hold_count: held.length } : {}),
    ...(normalized.length ? { would_normalize: normalized.slice(0, run.policy.cap), would_normalize_count: normalized.length } : {}),
    ...(skipped.length ? { screen_skipped: skipped } : {}) };
}
