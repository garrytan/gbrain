/**
 * #5988: the managed sync content screen. A frozen import entry the shared
 * sync screen (`screenSyncImport`) would refuse is held instead of admitted:
 * the caller writes the hold and advances the cursor in one transaction. A
 * pinned Git blob over the sync read bound is held by its size before its
 * content is loaded. `sync_parser_regression` stops the run only when the
 * page's import provenance proves the exact bytes imported validated before.
 * Dry runs screen every pending import read-only with batched Git reads.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { loadImportSanityConfig, type ImportSanityConfig } from '../import-screen.ts';
import { RECOVERY_VERSION } from '../markdown.ts';
import { slugConflictHoldMessage } from '../import-file.ts';
import { isImageFilePath, resolveSlugForPath } from '../sync.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { VERSION } from '../../version.ts';
import { sha256 } from './digest.ts';
import { readSyncFile, syncGitPath, type SyncDiscovery, type SyncEntry } from './sync-discovery.ts';
import { readBlobContents, readTreeBlobs, SYNC_READ_BOUND, type TreeBlob } from './sync-blobs.ts';
import { screenSyncImport, type SyncImportScreenInput } from './sync-prepare.ts';
import type { SyncProcessingOptions } from './sync-authority.ts';
import { gitHoldItem, readSyncHoldPolicy, readSyncImportProvenance, type GitHoldItem, type GitHoldRecord, type SyncHoldPolicy } from './sync-holds.ts';

type Snapshot = Awaited<ReturnType<BrainEngine['readPageSnapshot']>>;
export type HeldEntry = Pick<GitHoldRecord, 'path' | 'source_path' | 'slug' | 'page_id' | 'code' | 'message' | 'upstream_version' | 'meta'>;

/** Per-run screen state; null when `sync.holds=fail` restores fail-closed blocking. */
export interface SyncScreenRun { policy: SyncHoldPolicy; sanity: ImportSanityConfig; activePack: SyncImportScreenInput['activePack'] }

export async function loadSyncScreenRun(engine: BrainEngine, sourceId: string, processingOptions: SyncProcessingOptions | undefined, remote: boolean): Promise<SyncScreenRun | null> {
  const policy = await readSyncHoldPolicy(engine);
  if (policy.mode === 'fail') return null;
  const activePack = processingOptions?.noSchemaPack ? undefined : (await loadActivePackForEngine(engine, { remote, sourceId }).catch(() => null))?.manifest;
  return { policy, sanity: await loadImportSanityConfig(engine), activePack };
}

/** True for `readSyncFile`'s refusal of a working-tree file over the sync read bound. */
export function isSyncReadBound(error: unknown): boolean {
  return error instanceof OperationError && error.code === 'request_too_large' && error.message === 'Sync file exceeds the bounded import size.';
}

/** The pinned blob of one entry (one `ls-tree`), or null when the commit lacks it. */
export function pinnedBlob(discovery: Pick<SyncDiscovery, 'root' | 'gitRoot' | 'target'>, path: string): TreeBlob | null {
  const gitPath = syncGitPath(discovery, path);
  return readTreeBlobs(discovery.gitRoot, discovery.target, [gitPath]).get(gitPath) ?? null;
}

function heldEntry(entry: SyncEntry, slug: string, pageId: number | null, refusal: { code: GitHoldRecord['code']; reason?: GitHoldRecord['meta']['reason']; key?: string; line?: number; message: string },
  content: string | null, blob: TreeBlob | null | undefined): HeldEntry {
  return { path: entry.path, source_path: entry.sourcePath, slug, page_id: pageId, code: refusal.code, message: refusal.message,
    upstream_version: content === null ? null : sha256(content),
    meta: { ...(refusal.reason ? { reason: refusal.reason } : {}), ...(refusal.key ? { key: refusal.key } : {}), ...(refusal.line !== undefined ? { line: refusal.line } : {}),
      recovery_version: RECOVERY_VERSION, ...(blob ? { blob_oid: blob.oid } : {}), ...(entry.working ? { working: true } : {}),
      ...(entry.renameFrom ?? entry.renameHeld ? { rename_from: entry.renameFrom ?? entry.renameHeld } : {}) } };
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

export interface FrozenImportScreen {
  cursor: Pick<SyncDiscovery, 'sourceId' | 'incarnation' | 'root'>;
  entry: SyncEntry; slug: string; pageId: number | null; snapshot: Snapshot;
  /** null only for an over-size file, whose content is never read. */
  content: string | null; rawHash: string | null; lineEndingOnly: boolean;
  blob?: TreeBlob | null; oversize?: { size: number | null };
  /** The `--retry-failed` command that resumes after a parser-regression fix. */
  retryCommand: string;
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
  const { screen } = screenSyncImport({ content, rawHash: input.rawHash, lineEndingOnly: input.lineEndingOnly, slug, sourcePath: entry.sourcePath, path: entry.path,
    root: input.cursor.root, snapshot, base, renamed: !!moved, activePack: run.activePack, sanity: run.sanity });
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
  dry_run: true; would_hold?: GitHoldItem[]; would_hold_count?: number; screen_skipped?: Array<{ path: string; code: string }> }> {
  if (!run || discovery.companyPlan) return { dry_run: true };
  const entries = discovery.entries.slice(discovery.index ?? 0).filter(entry => entry.action === 'import' && entry.slug);
  const committed = entries.filter(entry => !entry.working);
  const blobs = readTreeBlobs(discovery.gitRoot, discovery.target, committed.map(entry => syncGitPath(discovery, entry.path)));
  const contents = readBlobContents(discovery.gitRoot, [...blobs.values()]);
  const held: GitHoldItem[] = [];
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
        rawHash: bytes === null ? null : sha256(bytes), lineEndingOnly, blob, oversize, retryCommand }, run);
      if (hold) held.push(gitHoldItem({ version: 1, source_id: discovery.sourceId, incarnation: discovery.incarnation, ...hold,
        observed_at: observed, held_at: observed, updated_at: observed, run_id: null, mode: 'managed' }));
    } catch (error) {
      skipped.push({ path: entry.path, code: error instanceof OperationError ? error.code : 'storage_error' });
    }
  }
  return { dry_run: true, ...(held.length ? { would_hold: held.slice(0, run.policy.cap), would_hold_count: held.length } : {}),
    ...(skipped.length ? { screen_skipped: skipped } : {}) };
}
